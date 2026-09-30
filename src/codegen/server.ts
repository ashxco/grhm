import { AppModel, ColumnDecl, TableDecl } from '../analyze.js';
import { SExpr } from '../ast.js';
import { camelCase, sourceMarker, routeSpecificity } from '../util.js';
import { typeScriptType } from '../typing.js';
import { checkedProgram } from '../checked.js';
import { Binding, GenCtx as ExprCtx, addJsImport, genExpr, isolatedBindingName, jsImportLines, newUses } from './expr.js';

/**
 * The generated API server (one self-contained file): node:http routing,
 * node:sqlite storage for (db ...) tables, session auth, input validation,
 * static file serving for the built client, and one handler per (api ...)
 * route. Depends only on Node builtins, so the ejection path stays honest.
 */

function sqlLiteral(col: ColumnDecl): string {
  const d = col.defaultValue;
  switch (col.type) {
    case 'string': {
      const value = d !== undefined && d.kind === 'string' ? d.value : '';
      return "'" + value.replace(/'/g, "''") + "'";
    }
    case 'number':
      return d !== undefined && d.kind === 'number' ? String(d.value) : '0';
    case 'boolean':
      return d !== undefined && d.kind === 'boolean' && d.value ? '1' : '0';
    case 'auto':
      return '';
    default: {
      const exhaustive: never = col.type;
      throw new Error(`unhandled column type: ${String(exhaustive)}`);
    }
  }
}

function columnSql(col: ColumnDecl): string {
  const references = col.references !== undefined ? ` REFERENCES "${col.references}"("id")` : '';
  const constraints = col.optional
    ? (col.defaultValue !== undefined ? ` DEFAULT ${sqlLiteral(col)}` : '')
    : ` NOT NULL DEFAULT ${sqlLiteral(col)}`;
  switch (col.type) {
    case 'auto':
      return `"${col.name}" INTEGER PRIMARY KEY AUTOINCREMENT`;
    case 'string':
      return `"${col.name}" TEXT${constraints}${references}`;
    case 'number':
      return `"${col.name}" REAL${constraints}${references}`;
    case 'boolean':
      return `"${col.name}" INTEGER${constraints}${references}`;
    default: {
      const exhaustive: never = col.type;
      throw new Error(`unhandled column type: ${String(exhaustive)}`);
    }
  }
}

/** Hidden auth column appended to the users table when (auth ...) is declared. */
const PASSWORD_COLUMN = `"password_hash" TEXT NOT NULL DEFAULT ''`;

const SERVER_CORE = `
function numberSetting(name: string, fallback: number, minimum: number, integer = false): number {
  const raw = process.env[name];
  const value = raw === undefined ? fallback : Number(raw);
  if (raw?.trim() === '' || !Number.isFinite(value) || value < minimum || (integer && !Number.isInteger(value))) {
    throw new Error('Invalid server configuration: ' + name);
  }
  return value;
}
type SqlValue = string | number | bigint | null;

// Preserve GRHM string coercion for column-valued contains needles. SQL stores
// booleans as integers and has different number-to-text formatting from JS.
db.function('grhm_string', { deterministic: true }, (value, booleanColumn) =>
  String(value !== null && booleanColumn === 1 ? value === 1 || value === 1n : value),
);

function encode(value: unknown): SqlValue {
  if (value === true) return 1;
  if (value === false) return 0;
  if (value === undefined || value === null) return null;
  if (typeof value === 'number' && !Number.isFinite(value)) throw new ApiError(400, 'database numbers must be finite');
  if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'string') return value;
  return JSON.stringify(value);
}

function decode(table: string, row: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (row === undefined) return undefined;
  const meta = SCHEMA.find((t) => t.name === table);
  if (meta === undefined) return row;
  const out: Record<string, unknown> = { ...row };
  for (const col of meta.columns) {
    const value = out[col.name];
    if (col.boolean && value !== null && value !== undefined) out[col.name] = value === 1 || value === 1n || value === true;
  }
  delete out['password_hash'];
  return out;
}

/** Structured HTTP failure raised by handlers via (fail status "message"). */
export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function apiFail(status: number, message: unknown): never {
  throw new ApiError(status, String(message));
}

function dbTx<T>(fn: () => T): T {
  db.exec('BEGIN');
  txDepth += 1;
  try {
    const result = fn();
    db.exec('COMMIT');
    txDepth -= 1;
    const tables = [...txPending];
    txPending.clear();
    for (const table of tables) broadcastChange(table);
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    txDepth -= 1;
    txPending.clear();
    throw err;
  }
}

function dbAll(table: string): unknown[] { return dbSelect(table, {}); }
const MAX_ROWS = numberSetting('GRHM_MAX_ROWS', 1000, 1, true);

interface SelectOpts {
  where?: string;
  args?: unknown[];
  order?: string;
  limit?: number;
  offset?: number;
}

function dbSelect(table: string, opts: SelectOpts): unknown[] {
  let sql = \`SELECT * FROM "\${table}"\`;
  const args: SqlValue[] = (opts.args ?? []).map(encode);
  if (opts.where !== undefined) sql += \` WHERE \${opts.where}\`;
  if (opts.order !== undefined) sql += \` ORDER BY \${opts.order}\`;
  if (opts.limit !== undefined && (!Number.isSafeInteger(opts.limit) || opts.limit < 0 || opts.limit > MAX_ROWS)) throw new ApiError(400, 'select limit must be between 0 and ' + MAX_ROWS);
  if (opts.offset !== undefined && (!Number.isSafeInteger(opts.offset) || opts.offset < 0)) throw new ApiError(400, 'select offset must be a nonnegative integer');
  sql += ' LIMIT ? OFFSET ?';
  args.push(opts.limit ?? MAX_ROWS + 1, opts.offset ?? 0);
  const rows = db.prepare(sql).all(...args) as Record<string, unknown>[];
  if (rows.length > MAX_ROWS) throw new ApiError(413, 'query exceeds row budget; use select :limit and :offset');
  return rows.map((row) => decode(table, row));
}

// Live change feed: GET /api/_events is a server-sent-events stream; every
// db mutation broadcasts one message so client :live resources re-fetch.
// Broadcasts inside a transaction are deferred until it commits (and dropped
// on rollback), so clients never re-fetch for changes that did not land.
const sseClients = new Set<http.ServerResponse>();
const sseOwners = new Map<http.ServerResponse, string>();
let pendingBroadcast: ReturnType<typeof setTimeout> | undefined;
const changedTables = new Set<string>();
let txDepth = 0;
const txPending = new Set<string>();

// Disconnect slow readers instead of buffering indefinitely; clients revalidate
// their live resources when EventSource reconnects.
function writeEvent(client: http.ServerResponse, event: string): void {
  if (client.destroyed || !client.write(event)) {
    sseClients.delete(client);
    client.destroy();
  }
}

function broadcastChange(table: string): void {
  if (txDepth > 0) {
    txPending.add(table);
    return;
  }
  changedTables.add(table);
  if (pendingBroadcast !== undefined) return;
  pendingBroadcast = setTimeout(() => {
    pendingBroadcast = undefined;
    const affected = routes.filter((route) => route.method === 'GET' && route.reads.some((table) => changedTables.has(table))).map((route) => route.nodeId);
    if (AUTH !== undefined && changedTables.has(AUTH.usersTable)) affected.push(AUTH.nodeId);
    changedTables.clear();
    const event = 'data: ' + JSON.stringify({ changed: true, routes: affected }) + '\\n\\n';
    for (const client of sseClients) writeEvent(client, event);
  }, 25);
  pendingBroadcast.unref();
}

function dbInsert(table: string, values: Record<string, unknown>): unknown {
  const cols = Object.keys(values);
  const sql =
    cols.length > 0
      ? \`INSERT INTO "\${table}" (\${cols.map((c) => \`"\${c}"\`).join(', ')}) VALUES (\${cols.map(() => '?').join(', ')}) RETURNING *\`
      : \`INSERT INTO "\${table}" DEFAULT VALUES RETURNING *\`;
  const row = db.prepare(sql).get(...cols.map((c) => encode(values[c]))) as Record<string, unknown> | undefined;
  broadcastChange(table);
  return decode(table, row);
}

function dbUpdate(table: string, id: unknown, values: Record<string, unknown>): unknown {
  const cols = Object.keys(values);
  if (cols.length === 0) {
    const row = db.prepare(\`SELECT * FROM "\${table}" WHERE id = ?\`).get(Number(id)) as Record<string, unknown> | undefined;
    return decode(table, row);
  }
  const sql = \`UPDATE "\${table}" SET \${cols.map((c) => \`"\${c}" = ?\`).join(', ')} WHERE id = ? RETURNING *\`;
  const row = db.prepare(sql).get(...cols.map((c) => encode(values[c])), Number(id)) as Record<string, unknown> | undefined;
  broadcastChange(table);
  return decode(table, row);
}

function dbDelete(table: string, id: unknown): { ok: boolean } {
  const info = db.prepare(\`DELETE FROM "\${table}" WHERE id = ?\`).run(Number(id));
  broadcastChange(table);
  return { ok: Number(info.changes) > 0 };
}

/** Migrations, seeds and resets share the directly tested storage module. */
function ensureSchema(): void {
  const result = migrateSchema(db, SCHEMA, SEEDS, AUTH?.usersTable, { dryRun: process.env.GRHM_MIGRATE === 'check' });
  if (result.applied.length > 0 || result.added.length > 0) console.log(JSON.stringify({ schema: 1, kind: 'migration', ...result }));
}

export function resetDb(): void {
  resetDatabase(db, SCHEMA, SEEDS, AUTH !== undefined);
}

// Auth: scrypt password hashing (async, so key derivation never blocks the
// event loop) and opaque session tokens in HttpOnly, SameSite=Lax cookies.
// Mutations additionally require the x-grhm header (a CSRF check: cross-site
// forms cannot set custom headers).
let activeHashes = 0;
const accountAttempts = new Limiter(20, 15 * 60_000);
const addressAttempts = new Limiter(60, 15 * 60_000);
const tokenHash = (token: string): string => crypto.createHash('sha256').update(token).digest('hex');
function scryptHex(password: string, salt: string): Promise<string> {
  if (activeHashes >= 4) throw new ApiError(503, 'authentication busy; retry later');
  activeHashes++;
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 64, (err, key) => { activeHashes--; if (err !== null) reject(err); else resolve(key.toString('hex')); });
  });
}

async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16).toString('hex');
  return salt + ':' + (await scryptHex(password, salt));
}

async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [salt, hash] = stored.split(':');
  if (salt === undefined || hash === undefined) return false;
  const candidate = await scryptHex(password, salt);
  return candidate.length === hash.length && crypto.timingSafeEqual(Buffer.from(candidate), Buffer.from(hash));
}

function cookieToken(cookieHeader: string | undefined): string | undefined {
  if (cookieHeader === undefined) return undefined;
  for (const part of cookieHeader.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === 'grhm_session') return rest.join('=');
  }
  return undefined;
}

// Sessions expire after GRHM_SESSION_DAYS (default 30); expired rows are
// rejected on read and pruned whenever a new session is created.
const SESSION_TTL_MS = numberSetting('GRHM_SESSION_DAYS', 30, Number.MIN_VALUE) * 86_400_000;
if (!Number.isFinite(SESSION_TTL_MS) || SESSION_TTL_MS < 1 || SESSION_TTL_MS > Number.MAX_SAFE_INTEGER) throw new Error('Invalid server configuration: GRHM_SESSION_DAYS');

function sessionUser(cookieHeader: string | undefined): Record<string, unknown> | undefined {
  if (AUTH === undefined) return undefined;
  if (IDENTITY_PROVIDER !== undefined) return requestContext.getStore()?.externalUser;
  const token = cookieToken(cookieHeader);
  if (token === undefined || token === '') return undefined;
  const session = db.prepare('SELECT user_id, created_at FROM "_grhm_sessions" WHERE token = ?').get(tokenHash(token)) as
    | { user_id: number; created_at: number }
    | undefined;
  if (session === undefined) return undefined;
  if (Date.now() - session.created_at > SESSION_TTL_MS) {
    db.prepare('DELETE FROM "_grhm_sessions" WHERE token = ?').run(tokenHash(token));
    return undefined;
  }
  const row = db.prepare(\`SELECT * FROM "\${AUTH.usersTable}" WHERE id = ?\`).get(session.user_id) as Record<string, unknown> | undefined;
  return decode(AUTH.usersTable, row);
}

function createSession(userId: unknown): string {
  db.prepare('DELETE FROM "_grhm_sessions" WHERE created_at < ?').run(Date.now() - SESSION_TTL_MS);
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO "_grhm_sessions" (token, user_id, created_at) VALUES (?, ?, ?)').run(tokenHash(token), Number(userId), Date.now());
  db.prepare('DELETE FROM _grhm_sessions WHERE user_id = ? AND token NOT IN (SELECT token FROM _grhm_sessions WHERE user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 10)').run(Number(userId), Number(userId));
  return token;
}

function sessionCookie(token: string): string {
  const secure = process.env.GRHM_SECURE === '1' ? '; Secure' : '';
  const sameSite = process.env.GRHM_SAMESITE === 'none' ? 'None' : 'Lax';
  return \`grhm_session=\${token}; HttpOnly; SameSite=\${sameSite}; Path=/\${secure}\`;
}

const CLEAR_COOKIE = 'grhm_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0';

export interface ApiResult {
  status: number;
  payload: unknown;
  setCookie?: string;
}

async function authRoute(method: string, pathname: string, body: unknown, cookieHeader: string | undefined): Promise<ApiResult | undefined> {
  if (AUTH === undefined) return undefined;
  if (method === 'GET' && pathname === '/api/auth/me') {
    return { status: 200, payload: sessionUser(cookieHeader) ?? null };
  }
  if (method !== 'POST') return undefined;
  if (IDENTITY_PROVIDER !== undefined && pathname.startsWith('/api/auth/')) return { status: 501, payload: { error: 'manage authentication through the configured identity provider' } };
  if (pathname === '/api/auth/logout') {
    const token = cookieToken(cookieHeader);
    if (token !== undefined && token !== '') db.prepare('DELETE FROM "_grhm_sessions" WHERE token = ?').run(tokenHash(token));
    return { status: 200, payload: { ok: true }, setCookie: CLEAR_COOKIE };
  }
  if (pathname === '/api/auth/logout-all') {
    const user = sessionUser(cookieHeader);
    if (user === undefined) return { status: 401, payload: { error: 'authentication required' } };
    db.prepare('DELETE FROM _grhm_sessions WHERE user_id = ?').run(Number(user['id']));
    return { status: 200, payload: { ok: true }, setCookie: CLEAR_COOKIE };
  }
  if (pathname !== '/api/auth/signup' && pathname !== '/api/auth/login') return undefined;
  const { errors, values } = validateInput(
    [
      { name: 'email', type: 'string', optional: false, maxLength: 254, format: 'email' },
      { name: 'password', type: 'string', optional: false, maxLength: 1024 },
    ],
    body,
  );
  if (errors.length > 0) return { status: 400, payload: { error: errors.join('; ') } };
  const email = String(values['email']).trim().toLowerCase();
  const password = String(values['password']);
  if (email.length > 254 || password.length > 1024) return { status: 400, payload: { error: 'credentials exceed length limits' } };
  if (!accountAttempts.allow(tokenHash(email))) return { status: 429, payload: { error: 'too many authentication attempts; retry later' } };
  if (pathname === '/api/auth/signup') {
    if (!email.includes('@')) return { status: 400, payload: { error: 'invalid email' } };
    if (password.length < 8) return { status: 400, payload: { error: 'password must be at least 8 characters' } };
    const existing = db.prepare(\`SELECT id FROM "\${AUTH.usersTable}" WHERE email = ?\`).get(email);
    if (existing !== undefined) return { status: 409, payload: { error: 'email already registered' } };
    let row: Record<string, unknown>;
    try {
      row = db
        .prepare(\`INSERT INTO "\${AUTH.usersTable}" (email, password_hash) VALUES (?, ?) RETURNING *\`)
        .get(email, await hashPassword(password)) as Record<string, unknown>;
    } catch (err) {
      if (err instanceof Error && err.message.includes('UNIQUE constraint failed')) {
        return { status: 409, payload: { error: 'email already registered' } };
      }
      throw err;
    }
    const token = createSession(row['id']);
    return { status: 200, payload: decode(AUTH.usersTable, row), setCookie: sessionCookie(token) };
  }
  const row = db.prepare(\`SELECT * FROM "\${AUTH.usersTable}" WHERE email = ?\`).get(email) as Record<string, unknown> | undefined;
  const valid = await verifyPassword(password, row === undefined ? '00000000000000000000000000000000:' + '0'.repeat(128) : String(row['password_hash'] ?? ''));
  if (row === undefined || !valid) {
    return { status: 401, payload: { error: 'invalid email or password' } };
  }
  const token = createSession(row['id']);
  return { status: 200, payload: decode(AUTH.usersTable, row), setCookie: sessionCookie(token) };
}

/** Dispatch one API request; undefined when no route matches. */
export async function handleApi(method: string, url: string, body: unknown, cookieHeader?: string): Promise<ApiResult | undefined> {
  const pathname = url.split('?')[0] ?? url;
  const builtin = await authRoute(method.toUpperCase(), pathname, body, cookieHeader);
  if (builtin !== undefined) return builtin;
  for (const route of routes) {
    if (route.method !== method.toUpperCase()) continue;
    const params = matchRoute(route.pattern, pathname);
    if (params === null) continue;
    let user: Record<string, unknown> | undefined;
    if (route.auth) {
      user = sessionUser(cookieHeader);
      if (user === undefined) return { status: 401, payload: { error: 'authentication required' } };
    }
    let payload: unknown = body ?? {};
    if (route.input !== undefined) {
      const { errors, values } = validateInput(route.input, body === undefined ? {} : body);
      if (errors.length > 0) return { status: 400, payload: { error: errors.join('; ') } };
      payload = values;
    }
    try {
      const result = await route.handler(params, payload, user);
      return { status: 200, payload: result ?? null };
    } catch (err) {
      if (err instanceof ApiError) return { status: err.status, payload: { error: err.message } };
      const storage = storageFailure(err);
      if (storage !== undefined) return { status: storage.status, payload: { error: storage.message } };
      console.error(JSON.stringify({ schema: 1, kind: 'request-error', requestId: requestContext.getStore()?.requestId, nodeId: route.nodeId, method: method.toUpperCase(), path: pathname,
        message: err instanceof Error ? err.message : String(err) }));
      return { status: 500, payload: { error: 'internal error' } };
    }
  }
  return undefined;
}

const UPLOADS_DIR = process.env.GRHM_UPLOADS ?? path.resolve('uploads');

// Long intervals are scheduled in safe timer-sized pieces. Running jobs are
// tracked independently of timers so shutdown can drain them before closing DB.
function startJobs(): () => Promise<void> {
  if (process.env.GRHM_JOBS === 'off') return async () => {};
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const active = new Set<Promise<void>>();
  let stopped = false;
  for (const job of JOBS) {
    let running = false;
    let due = performance.now() + job.everySeconds * 1000;
    const arm = (): void => {
      if (stopped) return;
      const timer = setTimeout(() => {
        timers.delete(timer);
        if (stopped) return;
        if (performance.now() < due) { arm(); return; }
        due = performance.now() + job.everySeconds * 1000;
        arm();
        if (running) return;
        running = true;
        const started = performance.now();
        const pending = Promise.resolve()
          .then(() => job.run())
          .then(() => {
            if (process.env.GRHM_QUIET !== '1') console.log(JSON.stringify({ schema: 1, kind: 'job-completed', job: job.name, ms: performance.now() - started }));
          })
          .catch((err: unknown) => {
            console.error(JSON.stringify({ schema: 1, kind: 'job-error', job: job.name, message: err instanceof Error ? err.message : String(err) }));
          })
          .finally(() => { running = false; active.delete(pending); });
        active.add(pending);
      }, Math.min(2_147_483_647, Math.max(1, Math.ceil(due - performance.now()))));
      timer.unref();
      timers.add(timer);
    };
    arm();
  }
  return async () => {
    stopped = true;
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    await Promise.all(active);
  };
}

// Simple fixed-window rate limit per client address for /api requests.
const RATE_LIMIT = numberSetting('GRHM_RATE_LIMIT', 300, 0, true);
const rateWindow = new Map<string, { count: number; reset: number }>();

function rateLimited(ip: string): boolean {
  if (RATE_LIMIT <= 0 || process.env.GRHM_TEST_HOOKS === '1') return false;
  const now = Date.now();
  const entry = rateWindow.get(ip);
  if (entry === undefined || entry.reset < now) {
    // Sweep expired windows so the map cannot grow without bound under IP churn.
    if (rateWindow.size >= 10_000) {
      for (const [key, value] of rateWindow) {
        if (value.reset < now) rateWindow.delete(key);
      }
      // If every window is still live, fail closed for a new address instead
      // of allowing attacker-controlled keys to grow the process indefinitely.
      if (rateWindow.size >= 10_000) return true;
    }
    rateWindow.set(ip, { count: 1, reset: now + 60_000 });
    return false;
  }
  entry.count += 1;
  return entry.count > RATE_LIMIT;
}

const MAX_BODY_BYTES = 1_000_000;
let activeIdentities = 0;
async function verifiedIdentity(req: http.IncomingMessage, method: string, url: string): Promise<unknown> {
  if (activeIdentities >= 32) throw new Error('Identity provider at capacity');
  activeIdentities++;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const work = Promise.resolve().then(() => IDENTITY_PROVIDER!({ headers: req.headers, method, url, signal: controller.signal })).finally(() => { activeIdentities--; });
  try {
    return await Promise.race([work, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new Error('Identity provider timed out')); }, 5000);
    })]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}
const requestContext = new AsyncLocalStorage<{ requestId: string; externalUser?: Record<string, unknown> }>();

export function startServer(port: number): http.Server {
  const cors = process.env.GRHM_CORS_ORIGIN;
  if (cors !== undefined && cors !== '' && (new URL(cors).origin !== cors || !['http:', 'https:'].includes(new URL(cors).protocol))) throw new Error('GRHM_CORS_ORIGIN must be one HTTP(S) origin');
  if (process.env.GRHM_SAMESITE === 'none' && process.env.GRHM_SECURE !== '1') throw new Error('Cross-site cookies require GRHM_SECURE=1');
  const metrics = createMetrics();
  let activeRequests = 0;
  let bufferedBytes = 0;
  const bufferBudget = numberSetting('GRHM_MAX_BUFFER_BYTES', 64 * 1024 * 1024, 1024, true);
  const server = http.createServer((req, res) => { void requestContext.run({ requestId: crypto.randomUUID() }, async () => {
    const context = requestContext.getStore()!;
    const requestId = context.requestId;
    const started = performance.now();
    res.setHeader('X-Request-Id', requestId);
    const requestPath = (req.url ?? '/').split('?')[0] ?? '/';
    const matchedRoute = routes.find((route) => route.method === req.method && matchRoute(route.pattern, requestPath) !== null);
    const routeLabel = matchedRoute?.pattern ?? (['/api/auth/login', '/api/auth/signup', '/api/auth/logout', '/api/auth/logout-all', '/api/auth/me'].includes(requestPath) ? requestPath : 'other');
    activeRequests++;
    let completed = false;
    const complete = (): void => {
      if (completed) return; completed = true; activeRequests--;
      const ms = performance.now() - started;
      metrics.record(routeLabel, res.writableFinished ? res.statusCode : 499, ms);
      if (process.env.GRHM_QUIET !== '1') console.log(JSON.stringify({ schema: 1, kind: 'request', requestId, method: req.method, route: routeLabel, nodeId: matchedRoute?.nodeId, status: res.writableFinished ? res.statusCode : 499, ms }));
    };
    res.once('finish', complete); res.once('close', complete);
    securityHeaders(res);
    const corsOrigin = process.env.GRHM_CORS_ORIGIN;
    if (corsOrigin !== undefined && corsOrigin !== '') {
      res.setHeader('Access-Control-Allow-Origin', corsOrigin);
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-grhm, x-filename');
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }
    }
    const finish = (status: number, payload: unknown, setCookie?: string): void => {
      const headers: Record<string, string | string[]> = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
      if (setCookie !== undefined) headers['Set-Cookie'] = setCookie;
      if (res.headersSent || res.destroyed) return;
      if (status === 429 || status === 503) res.setHeader('Retry-After', '60');
      res.writeHead(status, headers);
      res.end(JSON.stringify(payload));

    };
    const url = req.url ?? '/';
    const method = req.method ?? 'GET';
    const pathname = url.split('?')[0] ?? url;
    if (method === 'GET' && pathname === '/readyz') {
      try {
        if (shuttingDown) throw new Error('shutting down');
        db.prepare('SELECT 1').get();
        if (DB_PATH !== ':memory:') {
          const directory = path.dirname(path.resolve(DB_PATH));
          fs.accessSync(directory, fs.constants.W_OK);
          if (fs.statfsSync(directory).bavail === 0) throw new Error('Database storage is full');
        }
        await uploadStore?.ready();
        finish(200, { ok: true });
      } catch { finish(503, { ok: false }); }
      return;
    }
    if (method === 'GET' && pathname === '/healthz') {
      finish(200, { ok: true });
      return;
    }
    if (pathname === '/__grhm/metrics') {
      const secret = process.env.GRHM_METRICS_TOKEN;
      if (!secret || req.headers.authorization !== 'Bearer ' + secret) finish(404, { error: 'not found' });
      else finish(200, { ...metrics.snapshot(), activeRequests, sseClients: sseClients.size });
      return;
    }
    if (activeRequests - sseClients.size > 128) { finish(503, { error: 'server at capacity' }); req.resume(); return; }
    const address = clientAddress(req);
    if (pathname.startsWith('/api/auth/') && method === 'POST' && !addressAttempts.allow(address)) { finish(429, { error: 'too many authentication attempts' }); req.resume(); return; }
    const isApi =
      pathname === '/api' || pathname.startsWith('/api/') ||
      pathname.startsWith('/__grhm/') ||
      routes.some((route) => matchRoute(route.pattern, pathname) !== null);
    if (isApi && rateLimited(address)) {
      finish(429, { error: 'rate limit exceeded' });
      return;
    }
    if (isApi && method !== 'GET' && req.headers['x-grhm'] !== '1') {
      finish(403, { error: 'missing x-grhm header' });
      return;
    }
    if (IDENTITY_PROVIDER !== undefined && AUTH !== undefined && (isApi || pathname.startsWith('/uploads/'))) {
      const identity = await verifiedIdentity(req, method, url);
      if (identity !== undefined && identity !== null) {
        if (typeof identity !== 'object' || !('userId' in identity) || !Number.isSafeInteger(identity.userId) || Number(identity.userId) <= 0) throw new Error('Identity provider returned an invalid userId');
        requestContext.getStore()!.externalUser = decode(AUTH.usersTable, db.prepare('SELECT * FROM "' + AUTH.usersTable + '" WHERE id = ?').get(Number(identity.userId)) as Record<string, unknown> | undefined);
      }
    }
    if (method === 'GET' && pathname === '/api/_events') {
      if (AUTH !== undefined && sessionUser(req.headers.cookie) === undefined) { finish(401, { error: 'authentication required' }); return; }
      const owner = String(sessionUser(req.headers.cookie)?.['id'] ?? address);
      if ([...sseOwners.values()].filter((value) => value === owner).length >= 10) { finish(429, { error: 'too many event streams' }); return; }
      if (sseClients.size >= 1000) { finish(503, { error: 'event stream capacity reached' }); return; }
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.write(':ok\\n\\n');
      sseClients.add(res);
      sseOwners.set(res, owner);
      const heartbeat = setInterval(() => {
        if (IDENTITY_PROVIDER !== undefined) { res.end(); return; }
        if (AUTH !== undefined && sessionUser(req.headers.cookie) === undefined) res.end();
        else writeEvent(res, ':heartbeat\\n\\n');
      }, 15_000);
      heartbeat.unref();
      res.on('close', () => { clearInterval(heartbeat); sseClients.delete(res); sseOwners.delete(res); });
      res.on('error', () => { clearInterval(heartbeat); sseClients.delete(res); sseOwners.delete(res); });
      req.on('error', () => res.destroy());
      return;
    }
    const isUpload = UPLOADS !== undefined && method === 'POST' && pathname === '/api/uploads';
    const uploadUser = UPLOADS === undefined ? undefined : sessionUser(req.headers.cookie);
    if (isUpload && UPLOADS?.public === false && uploadUser === undefined) { finish(401, { error: 'authentication required' }); return; }
    const maxBody = isUpload && UPLOADS !== undefined ? UPLOADS.maxKb * 1024 : MAX_BODY_BYTES;
    const chunks: Buffer[] = [];
    let received = 0;
    let released = false;
    const releaseBody = (): void => { if (released) return; released = true; bufferedBytes -= received; chunks.length = 0; };
    let processing = false;
    res.once('close', () => { if (!processing) releaseBody(); });
    // A client disconnect mid-request emits 'error'; unhandled it would crash
    // the process.
    req.on('error', () => {
      sseClients.delete(res);
      res.destroy();
    });
    req.on('data', (chunk: Buffer) => {
      if (res.writableEnded || released) return;
      received += chunk.length;
      bufferedBytes += chunk.length;
      if (received > maxBody || bufferedBytes > bufferBudget) {
        finish(413, { error: 'request body too large' });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => requestContext.run(context, async () => {
      if (res.writableEnded || released) return;
      processing = true;
      const rawBody = Buffer.concat(chunks);
      chunks.length = 0;
      try {
        if (isUpload) {
          const filename = req.headers['x-filename'];
          const result = await uploadStore!.upload(rawBody, safeDecode(typeof filename === 'string' ? filename : 'file'), uploadUser === undefined ? undefined : Number(uploadUser['id']));
          finish(result.status, result.payload);
          return;
        }
        let body: unknown;
        const raw = rawBody.toString('utf8');
        if (raw !== '') {
          try {
            body = JSON.parse(raw);
          } catch {
            finish(400, { error: 'invalid JSON body' });
            return;
          }
        }
        if (process.env.GRHM_TEST_HOOKS === '1' && method === 'POST' && url === '/__grhm/reset') {
          resetDb();
          finish(200, { ok: true });
          return;
        }
        const result = await handleApi(method, url, body, req.headers.cookie);
        if (result !== undefined) {
          finish(result.status, result.payload, result.setCookie);
          return;
        }
        if (isApi) {
          const allowed = new Set(routes.filter((route) => matchRoute(route.pattern, pathname) !== null).map((route) => route.method));
          if (pathname === '/api/_events') allowed.add('GET');
          if (UPLOADS !== undefined && pathname === '/api/uploads') allowed.add('POST');
          if (AUTH !== undefined) {
            if (pathname === '/api/auth/me') allowed.add('GET');
            if (['/api/auth/signup', '/api/auth/login', '/api/auth/logout', '/api/auth/logout-all'].includes(pathname)) allowed.add('POST');
          }
          if (allowed.size > 0 && !allowed.has(method)) {
            res.setHeader('Allow', [...allowed].sort().join(', '));
            finish(405, { error: 'method not allowed' });
          } else finish(404, { error: 'not found' });
          return;
        }
        if ((method === 'GET' || method === 'HEAD') && uploadStore !== undefined && pathname.startsWith('/uploads/') && await uploadStore.serve(req, res, pathname.slice('/uploads/'.length), uploadUser === undefined ? undefined : Number(uploadUser['id']))) return;
        if (pathname.startsWith('/uploads/')) {
          finish(404, { error: 'not found' });
          return;
        }
        if ((method === 'GET' || method === 'HEAD') && await serveStatic(req, res)) return;
        finish(404, { error: 'not found' });
      } catch (err: unknown) {
        console.error(JSON.stringify({ schema: 1, kind: 'request-error', requestId, message: err instanceof Error ? err.message : String(err) }));
        if (!res.writableEnded) finish(err instanceof ApiError ? err.status : 500, { error: err instanceof ApiError ? err.message : 'internal error' });
      } finally { releaseBody(); }
    }));
  }).catch((error: unknown) => {
    console.error(JSON.stringify({ schema: 1, kind: 'identity-error', requestId: res.getHeader('X-Request-Id'), message: error instanceof Error ? error.message : String(error) }));
    if (!res.headersSent && !res.destroyed) { res.writeHead(503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify({ error: 'authentication temporarily unavailable' })); } else res.destroy();
  }); });
  server.maxConnections = 2048;
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  server.maxRequestsPerSocket = 1000;
  // Bind loopback explicitly (set HOST=0.0.0.0 to expose): an unqualified
  // listen can dual-bind IPv6 beside a foreign IPv4 listener on the same port.
  server.listen(port, process.env.HOST ?? '127.0.0.1', () => {
    const addr = server.address();
    const bound = typeof addr === 'object' && addr !== null ? addr.port : port;
    console.log(JSON.stringify({ schema: 1, kind: 'server-started', port: bound, db: DB_PATH }));
  });
  const stopJobs = startJobs();
  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    const drainedJobs = stopJobs();
    // Keep the deadline referenced even when an unfinished job has no open handles.
    const deadline = setTimeout(() => { server.closeAllConnections(); process.exit(1); }, 10_000);
    for (const client of sseClients) client.end();
    sseClients.clear();
    const drainedRequests = new Promise<void>((resolve) => server.close(() => resolve()));
    void Promise.all([drainedJobs, drainedRequests]).then(() => {
      metrics.close();
      db.close();
      clearTimeout(deadline);
      process.exit(0);
    }).catch((err: unknown) => {
      console.error(JSON.stringify({ schema: 1, kind: 'shutdown-error', message: err instanceof Error ? err.message : String(err) }));
      process.exit(1);
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  return server;
}

ensureSchema();
const uploadStore = UPLOADS === undefined ? undefined : createUploadStore(db, UPLOADS_DIR, UPLOADS);

export async function runJob(name: string): Promise<void> {
  const job = JOBS.find((item) => item.name === name);
  if (job === undefined) throw new Error('Unknown job: ' + name);
  const started = performance.now();
  await job.run();
  console.log(JSON.stringify({ schema: 1, kind: 'job-completed', job: name, ms: performance.now() - started }));
}

const executed = process.argv[1];
if (process.env.GRHM_MIGRATE !== undefined) { db.close(); }
else if (process.env.GRHM_RUN_JOB !== undefined) {
  try { await runJob(process.env.GRHM_RUN_JOB); }
  catch (error) { console.error(JSON.stringify({ schema: 1, kind: 'job-error', job: process.env.GRHM_RUN_JOB, message: error instanceof Error ? error.message : String(error) })); process.exitCode = 1; }
  finally { db.close(); }
}
else if (executed !== undefined && fs.existsSync(executed) && fs.realpathSync(new URL(import.meta.url)) === fs.realpathSync(executed)) {
  startServer(Number(process.env.PORT ?? 8787));
}
`;

/** All identifier heads and operation names referenced in an expression. */
function exprHeads(exprs: SExpr[]): Set<string> {
  const heads = new Set<string>();
  const go = (e: SExpr): void => {
    if (e.kind === 'ident') {
      const head = e.name.split('.')[0];
      if (head !== undefined) heads.add(head);
    } else if (e.kind === 'list') {
      const first = e.items[0];
      if (first !== undefined && first.kind === 'ident') heads.add(first.name);
      for (const item of e.items) go(item);
    }
  };
  for (const e of exprs) go(e);
  return heads;
}

/** ENV_VAR name for an (env some-key) declaration: SOME_KEY. */
function envVarName(name: string): string {
  return name.replace(/-/g, '_').toUpperCase();
}

function tableSpec(table: TableDecl, isUsersTable: boolean): string {
  const columns = table.columns.map(
    (c) => `{ name: ${JSON.stringify(c.name)}, ddl: ${JSON.stringify(columnSql(c))}, boolean: ${c.type === 'boolean'} }`,
  );
  if (isUsersTable) {
    columns.push(`{ name: 'password_hash', ddl: ${JSON.stringify(PASSWORD_COLUMN)}, boolean: false }`);
  }
  const indexes = table.columns.filter((c) => c.indexed && !(isUsersTable && c.name === 'email')).map((c) => JSON.stringify(c.name));
  const uniqueIndexes = isUsersTable ? [JSON.stringify('email')] : [];
  return `  { name: ${JSON.stringify(table.name)}, columns: [${columns.join(', ')}], indexes: [${indexes.join(', ')}], uniqueIndexes: [${uniqueIndexes.join(', ')}] },`;
}

function seedLiteral(e: SExpr): string {
  switch (e.kind) {
    case 'string':
      return JSON.stringify(e.value);
    case 'number':
      return String(e.value);
    case 'boolean':
      return e.value ? 'true' : 'false';
    default:
      return 'null';
  }
}

/** Generate the standalone API server module for an app with db/api forms. */
export function genServerFile(app: AppModel, outDirDepth: number): string {
  const uses = newUses();
  const heads = exprHeads([
    ...app.apis.flatMap((r) => (r.handler !== undefined ? [r.handler] : [])),
    ...app.jobs.map((j) => j.body),
  ]);
  const bindings = new Map<string, Binding>();
  for (const name of app.functions.keys()) {
    bindings.set(name, { kind: 'fn', js: isolatedBindingName('fn', name) });
  }
  for (const name of app.enums.keys()) {
    bindings.set(name, { kind: 'enum', js: '' });
  }
  if (app.envs.size > 0) bindings.set('env', { kind: 'eachvar', js: 'ENV' });
  for (const [name, imp] of app.imports) {
    if (!heads.has(name)) continue;
    const local = isolatedBindingName('import', name);
    bindings.set(name, { kind: 'js', js: local });
    addJsImport(uses, imp.module, imp.jsName, local, imp.isDefault);
  }

  const checked = checkedProgram(app);
  if (app.auth?.provider !== undefined) addJsImport(uses, app.auth.provider, 'authenticate', '__grhmAuthenticate', false);
  const routeLines: string[] = [];
  const orderedRoutes = [...app.apis].sort((a, b) => routeSpecificity(b.route) - routeSpecificity(a.route));
  for (const route of orderedRoutes) {
    if (route.builtin !== undefined || route.handler === undefined) continue;
    const inner = new Map(bindings);
    for (const p of route.params) {
      inner.set(p, { kind: 'param', js: `params[${JSON.stringify(p)}]` });
    }
    inner.set('body', { kind: 'eachvar', js: 'body' });
    if (route.auth) inner.set('user', { kind: 'eachvar', js: 'user' });
    const ctx: ExprCtx = {
      bindings: inner,
      classFor: new Map(),
      uses,
      sameFileComponents: new Set(),
      tables: app.tables,
      defaultLocale: app.defaultLocale,
    };
    const expr = genExpr(route.handler, ctx);
    const inputSpec =
      route.input !== undefined
        ? `[${route.input.map(({ node: _node, ...field }) => JSON.stringify(field)).join(', ')}]`
        : 'undefined';
    const metadata = checked.get(route.node.id!)!;
    const bodyType = typeScriptType(metadata.bindings.get('body')!, app.tables);
    const userType = route.auth ? typeScriptType(metadata.bindings.get('user')!, app.tables) : 'unknown';
    const readTables = metadata.opaque ? [...app.tables.keys()] : [...metadata.reads];
    routeLines.push(
      `  ${sourceMarker(route.node.id)}\n  { method: ${JSON.stringify(route.method.toUpperCase())}, pattern: ${JSON.stringify(route.route)}, nodeId: ${JSON.stringify(route.node.id)}, auth: ${route.auth}, reads: ${JSON.stringify(readTables)}, input: ${inputSpec}, handler: (params, rawBody, rawUser) => { const body = rawBody as ${bodyType}; const user = rawUser as ${userType}; return (${expr}); } },`,
    );
  }

  const jobLines = app.jobs.map((job) => {
    const ctx: ExprCtx = {
      bindings: new Map(bindings),
      classFor: new Map(),
      uses,
      sameFileComponents: new Set(),
      tables: app.tables,
      defaultLocale: app.defaultLocale,
    };
    return `  ${sourceMarker(job.node.id)}\n  { name: ${JSON.stringify(job.name)}, everySeconds: ${job.everySeconds}, run: () => (${genExpr(job.body, ctx)}) },`;
  });

  let out = '/* Generated by grhm. The API server: node:http + node:sqlite. Run with node (>=22.18) or node --experimental-strip-types. */\n';
  out += "import crypto from 'node:crypto';\n";
  out += "import { AsyncLocalStorage } from 'node:async_hooks';\n";
  out += "import { Limiter, clientAddress, createMetrics } from './controls.ts';\n";
  out += "import { validateInput, type InputSpec } from './contracts.ts';\n";
  out += "import fs from 'node:fs';\n";
  out += "import http from 'node:http';\n";
  out += "import path from 'node:path';\n";
  out += "import { serveStatic, securityHeaders } from './http-files.ts';\n";
  out += "import { createUploadStore } from './uploads.ts';\n";
  out += "import { DatabaseSync } from 'node:sqlite';\n";
  out += "import { ensureSchema as migrateSchema, resetDatabase, storageFailure } from './storage.ts';\n";
  // matchRoute/safeDecode are used by the server core itself, beyond whatever
  // helpers the handler expressions reference.
  const helperImports = new Set([...uses.helpers, 'matchRoute', 'safeDecode']);
  out += `import { ${[...helperImports].sort().join(', ')} } from './helpers.ts';\n`;
  if (uses.libFns.size > 0) {
    out += `import { ${[...uses.libFns].sort().map((n) => `${camelCase(n)} as ${isolatedBindingName('fn', n)}`).join(', ')} } from './lib.ts';\n`;
  }
  if (uses.i18n) {
    out += "import { tMsg } from './i18n.ts';\n";
  }
  out += jsImportLines(uses, 0, outDirDepth, true);
  out += '\nconst IDENTITY_PROVIDER: ((request: { headers: http.IncomingHttpHeaders; method: string; url: string; signal: AbortSignal }) => unknown | Promise<unknown>) | undefined = ' + (app.auth?.provider !== undefined ? '__grhmAuthenticate' : 'undefined') + ';\n';

  out += "\nconst DB_PATH = process.env.GRHM_DB ?? 'grhm.db';\n";
  out += 'const db = new DatabaseSync(DB_PATH, { enableForeignKeyConstraints: true });\n';
  out += "db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 1000');\n";

  // Declared environment configuration, validated at startup.
  if (app.envs.size > 0) {
    out += '\nfunction requireEnv(name: string, fallback: string | undefined): string {\n';
    out += '  const value = process.env[name] ?? fallback;\n';
    out += '  if (value === undefined) {\n';
    out += "    console.error(JSON.stringify({ schema: 1, kind: 'config-error', missing: name }));\n";
    out += '    process.exit(1);\n';
    out += '  }\n';
    out += '  return value;\n';
    out += '}\n\n';
    const entries = [...app.envs.values()].map(
      (e) => `  ${JSON.stringify(e.name)}: requireEnv(${JSON.stringify(envVarName(e.name))}, ${e.defaultValue !== undefined ? JSON.stringify(e.defaultValue) : 'undefined'}),`,
    );
    out += 'const ENV: Record<string, string> = {\n' + entries.join('\n') + '\n};\n';
  }

  out += '\ninterface ColumnSpec {\n  name: string;\n  ddl: string;\n  boolean: boolean;\n}\n\n';
  out += 'interface TableSpec {\n  name: string;\n  columns: ColumnSpec[];\n  indexes: string[];\n  uniqueIndexes: string[];\n}\n\n';
  const specs = [...app.tables.values()].map((t) => tableSpec(t, app.auth !== undefined && t.name === app.auth.usersTable));
  out += 'const SCHEMA: TableSpec[] = [\n' + specs.join('\n') + '\n];\n';

  const seedEntries = app.seeds.map((s) => {
    const rows = s.rows.map((r) => '{ ' + [...r.props].map(([k, v]) => `${JSON.stringify(k)}: ${seedLiteral(v)}`).join(', ') + ' }');
    return `  { table: ${JSON.stringify(s.table)}, rows: [${rows.join(', ')}] },`;
  });
  out += '\nconst SEEDS: { table: string; rows: Record<string, unknown>[] }[] = [\n' + seedEntries.join('\n') + '\n];\n';

  out +=
    '\nconst AUTH: { usersTable: string; nodeId: string } | undefined = ' +
    (app.auth !== undefined ? `{ usersTable: ${JSON.stringify(app.auth.usersTable)}, nodeId: ${JSON.stringify(app.auth.node.id)} }` : 'undefined') +
    ';\n';

  out +=
    '\nconst UPLOADS: { maxKb: number; public: boolean; quotaMb: number; userQuotaMb: number } | undefined = ' +
    (app.uploads !== undefined ? `{ maxKb: ${app.uploads.maxKb}, public: ${app.uploads.public ?? app.auth === undefined}, quotaMb: ${app.uploads.quotaMb}, userQuotaMb: ${app.uploads.userQuotaMb} }` : 'undefined') +
    ';\n';

  out += '\nconst JOBS: { name: string; everySeconds: number; run: () => unknown | Promise<unknown> }[] = [\n' + jobLines.join('\n') + '\n];\n';


  out +=
    'interface ApiRoute {\n  method: string;\n  pattern: string;\n  nodeId: string;\n  reads: string[];\n  auth: boolean;\n  input: InputSpec[] | undefined;\n  handler: (params: Record<string, string>, body: unknown, user: unknown) => unknown | Promise<unknown>;\n}\n\n';
  out += 'const routes: ApiRoute[] = [\n' + routeLines.join('\n') + '\n];\n';
  out += SERVER_CORE;
  return out;
}
