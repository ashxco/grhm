import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, describe, expect, it } from 'vitest';

import { compile } from '../src/codegen/index.js';
import { MAX_SOURCE_BYTES } from '../src/limits.js';
import { loadProject, compileProject } from '../src/project.js';

const directories: string[] = [];
const children: ChildProcess[] = [];
const headers = { 'x-grhm': '1', 'content-type': 'application/json' };

function emit(source: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'grhm-production-'));
  directories.push(root);
  const result = compile(source, { outDirDepth: 1 });
  expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  for (const [file, text] of result.files) {
    const target = path.join(root, 'gen', file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text);
  }
  return root;
}

async function start(root: string, env: Record<string, string> = {}) {
  const child = spawn(process.execPath, ['--experimental-strip-types', path.join(root, 'gen/server.ts')], {
    cwd: root, env: { ...process.env, GRHM_DB: ':memory:', GRHM_QUIET: '1', HOST: '127.0.0.1', PORT: '0', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  let output = '';
  let errors = '';
  child.stdout!.on('data', (chunk: Buffer) => { output += chunk.toString(); });
  child.stderr!.on('data', (chunk: Buffer) => { errors += chunk.toString(); });
  for (let i = 0; i < 200; i++) {
    const port = output.match(/"kind":"server-started","port":(\d+)/)?.[1];
    if (port !== undefined) return { child, base: `http://127.0.0.1:${port}`, errors: () => errors, output: () => output };
    if (child.exitCode !== null) throw new Error(errors);
    await delay(10);
  }
  throw new Error(`startup timed out: ${errors}`);
}

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    const deadline = setTimeout(() => child.kill('SIGKILL'), 12_000);
    try { await exited; } finally { clearTimeout(deadline); }
  }
  for (const dir of directories.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('production compiler boundaries', () => {
  it('preserves source correlation and emits checked types beyond UI nodes', () => {
    const result = compile(`(app a
      (fn f ((x number)) :id "fn-node" (+ x 1))
      (db (table items (id auto) (label string)))
      (job task :id "job-node" :every 60 (insert items :label "tick"))
      (api (get "/api/items" :id "api-node" (select items :limit 20)))
      (data (resource items "/api/items" :default ()))
      (page "/" home (each item items.data (txt item.label))))`);
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    const map = JSON.parse(result.files.get('sourcemap.json')!) as { nodes: Record<string, { generated: { file: string; line: number }[] }> };
    for (const [id, file] of [['fn-node', 'lib.ts'], ['api-node', 'server.ts'], ['job-node', 'server.ts']]) {
      expect(map.nodes[id!]?.generated.some((location) => location.file === file && location.line > 0)).toBe(true);
    }
    const page = result.files.get('pages/home.tsx')!;
    expect(page).not.toContain('useResource<any>');
    expect(page).not.toContain('item: any');
    expect(page).toContain('"label": string');
  });

  it('keeps hostile source IDs inside a single correlation comment', () => {
    const id = '*/\u2028throw new Error("escaped")';
    const result = compile(`(app a (fn f ((x number)) :id ${JSON.stringify(id)} (+ x 1)) (page "/" home (txt (f 1))))`);
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(result.files.get('lib.ts')).not.toContain('\u2028');
    const map = JSON.parse(result.files.get('sourcemap.json')!) as { nodes: Record<string, { generated: unknown[] }> };
    expect(map.nodes[id]?.generated.length).toBeGreaterThan(0);
  });

  it('diagnoses long include chains, exponential expansion, and oversized source', () => {
    const chain = loadProject('f0.grhm', (file) => {
      const n = Number(file.slice(1, -5));
      return n < 3000 ? `(include "f${n + 1}.grhm")` : '(page "/" home (txt "ok"))';
    });
    expect(chain.diagnostics.some((d) => d.code === 'E603')).toBe(true);
    expect(compileProject(chain).files.size).toBe(0);
    const exponential = loadProject('f0.grhm', (file) => {
      const n = Number(file.slice(1, -5));
      return n < 19 ? `(include "f${n + 1}.grhm") (include "f${n + 1}.grhm")` : '(txt "ok")';
    });
    expect(exponential.diagnostics.some((d) => d.code === 'E603')).toBe(true);
    const large = compile(' '.repeat(MAX_SOURCE_BYTES + 1));
    expect(large.diagnostics.some((d) => d.code === 'E004')).toBe(true);
    expect(large.files.size).toBe(0);
  });

  it.each([200, 399, 600, 999, 400.5])('rejects invalid fail status %s', (status) => {
    const result = compile(`(app a (api (get "/api/error" (fail ${status} "error"))) (page "/" home (txt "ok")))`);
    expect(result.diagnostics.some((d) => d.code === 'E805')).toBe(true);
  });
});

describe('production runtime boundaries', () => {
  it('scopes coalesced events to affected routes, including the current-user builtin', async () => {
    const root = emit(`(app a (auth users :id "auth-node")
      (db (table left (id auto)) (table right (id auto)))
      (api (get "/api/{slug}" :id "generic-read" (select right))
        (get "/api/left" :id "left-read" (select left))
        (get "/api/right" :id "right-read" (select right))
        (post "/api/left" (insert left))
        (put "/api/profile" :auth true (input (email string :format email)) (update users :id user.id :email body.email)))
      (page "/" home (txt "ok")))`);
    const runtime = fs.readFileSync(path.join(root, 'gen/runtime.ts'), 'utf8');
    expect(runtime.indexOf('"pattern":"/api/left"')).toBeLessThan(runtime.indexOf('"pattern":"/api/{slug}"'));
    const { base } = await start(root);
    const signup = await fetch(base + '/api/auth/signup', { method: 'POST', headers, body: JSON.stringify({ email: 'before@example.test', password: 'long-password' }) });
    const cookie = signup.headers.get('set-cookie')!.split(';')[0]!;
    const events = await fetch(base + '/api/_events', { headers: { cookie }, signal: AbortSignal.timeout(5000) });
    const reader = events.body!.getReader();
    try {
      await Promise.all([
        fetch(base + '/api/left', { method: 'POST', headers }),
        fetch(base + '/api/profile', { method: 'PUT', headers: { ...headers, cookie }, body: JSON.stringify({ email: 'after@example.test' }) }),
      ]);
      let output = '';
      const routes = new Set<string>();
      while (!routes.has('left-read') || !routes.has('auth-node')) {
        const chunk = await reader.read();
        if (chunk.done) break;
        output += new TextDecoder().decode(chunk.value);
        for (const event of output.split('\n').filter((line) => line.startsWith('data: '))) {
          try { for (const id of (JSON.parse(event.slice(6)) as { routes: string[] }).routes) routes.add(id); } catch { /* incomplete chunk */ }
        }
      }
      expect([...routes].sort()).toEqual(['auth-node', 'left-read']);
      expect(output).not.toContain('"table"');
    } finally { await reader.cancel(); }
  });

  it('runs jobs once for an external scheduler and can disable local scheduling', async () => {
    const root = emit(`(app a (db (table ticks (id auto))) (job tick :every 0.01 (insert ticks))
      (api (get "/api/ticks" (count (select ticks)))) (page "/" home (txt "ok")))`);
    const database = path.join(root, 'jobs.db');
    const run = (name: string) => spawnSync(process.execPath, ['--experimental-strip-types', path.join(root, 'gen/server.ts')], {
      cwd: root, env: { ...process.env, GRHM_DB: database, GRHM_RUN_JOB: name }, encoding: 'utf8', timeout: 10_000,
    });
    for (let i = 0; i < 2; i++) {
      const result = run('tick');
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain('job-completed');
      expect(result.stdout).not.toContain('server-started');
    }
    expect(run('missing').status).toBe(1);
    const { base } = await start(root, { GRHM_DB: database, GRHM_JOBS: 'off' });
    await delay(60);
    expect(await (await fetch(base + '/api/ticks')).json()).toBe(2);
  });

  it('accepts only identities verified by an external adapter and disables local login', async () => {
    const root = emit(`(app a (auth users :provider "./identity.ts")
      (db (table users (id auto) (email string)) (seed users (row :email "external@example.test")))
      (api (get "/api/private" :auth true user.email)) (page "/" home (txt "ok")))`);
    fs.writeFileSync(path.join(root, 'identity.ts'), `export async function authenticate(request: { headers: Record<string, string | string[] | undefined> }) {
      await new Promise(resolve => setTimeout(resolve, 2));
      if (request.headers.authorization === 'Bearer verified-test-token') return { userId: 1 };
      return undefined;
    }`);
    const { base } = await start(root);
    expect((await fetch(base + '/api/private')).status).toBe(401);
    const verified = await fetch(base + '/api/private', { headers: { authorization: 'Bearer verified-test-token' } });
    expect(verified.status).toBe(200);
    expect(await verified.json()).toBe('external@example.test');
    expect((await fetch(base + '/api/auth/login', { method: 'POST', headers, body: JSON.stringify({ email: 'external@example.test', password: 'password' }) })).status).toBe(501);
  });

  it('bounds queries, validates constraints, correlates failures, and protects metrics', async () => {
    const root = emit(`(app a (db (table items (id auto)) (seed items (row) (row) (row)))
      (api (get "/api/items" (select items)) (get "/api/page" (select items :limit 2))
        (post "/api/bounded" (input (n number :integer true :min 1 :max 10) (name string :min-len 2 :max-len 8)) body))
      (page "/" home (txt "ok")))`);
    const { base } = await start(root, { GRHM_MAX_ROWS: '2', GRHM_METRICS_TOKEN: 'test-metrics-secret' });
    const tooMany = await fetch(base + '/api/items');
    expect(tooMany.status).toBe(413);
    expect(tooMany.headers.get('x-request-id')).toMatch(/^[a-f0-9-]{36}$/);
    expect(await (await fetch(base + '/api/page')).json()).toHaveLength(2);
    expect((await fetch(base + '/api/bounded', { method: 'POST', headers, body: JSON.stringify({ n: 1.5, name: 'valid' }) })).status).toBe(400);
    expect((await fetch(base + '/api/bounded', { method: 'POST', headers, body: JSON.stringify({ n: 2, name: 'valid' }) })).status).toBe(200);
    expect((await fetch(base + '/__grhm/metrics')).status).toBe(404);
    const metrics = await (await fetch(base + '/__grhm/metrics', { headers: { authorization: 'Bearer test-metrics-secret' } })).json() as { requests: Record<string, { count: number }> };
    expect(metrics.requests['/api/items']?.count).toBe(1);
  });

  it('protects uploads and events, isolates owners, and reserves quotas under concurrent uploads', async () => {
    const root = emit('(app a (auth users) (uploads :max-kb 1024 :quota-mb 1 :user-quota-mb 1) (page "/" home (txt "ok")))');
    const { base } = await start(root);
    const signup = async (email: string): Promise<string> => {
      const res = await fetch(base + '/api/auth/signup', { method: 'POST', headers, body: JSON.stringify({ email, password: 'test-password-1234' }) });
      expect(res.status).toBe(200);
      return res.headers.get('set-cookie')!.split(';')[0]!;
    };
    expect((await fetch(base + '/api/_events')).status).toBe(401);
    expect((await fetch(base + '/api/uploads', { method: 'POST', headers, body: 'private' })).status).toBe(401);
    const alice = await signup('alice@example.invalid');
    const bob = await signup('bob@example.invalid');
    const requests = await Promise.all([1, 2].map((n) => fetch(base + '/api/uploads', {
      method: 'POST', headers: { ...headers, cookie: alice, 'x-filename': 'document.txt' }, body: Buffer.alloc(600 * 1024, n),
    })));
    expect(requests.map((res) => res.status).sort()).toEqual([200, 413]);
    const { url } = await requests.find((res) => res.status === 200)!.json() as { url: string };
    expect((await fetch(base + url)).status).toBe(404);
    expect((await fetch(base + url, { headers: { cookie: bob } })).status).toBe(404);
    const owned = await fetch(base + url, { headers: { cookie: alice } });
    expect(owned.status).toBe(200);
    expect(owned.headers.get('cache-control')).toBe('no-store');
    expect((await owned.arrayBuffer()).byteLength).toBe(600 * 1024);
    const ready = await fetch(base + '/readyz');
    expect(await ready.json()).toEqual({ ok: true });
  });

  it('rejects non-object and nonfinite input, and prevents private response caching', async () => {
    const root = emit(`(app a (auth users) (api
      (post "/api/n" (input (n number :optional true)) (obj :n body.n))
      (get "/api/private" :auth true (obj :email user.email))) (page "/" home (txt "ok")))`);
    const { base } = await start(root);
    for (const body of ['[]', '123', 'null', '{"n":1e309}']) {
      const res = await fetch(`${base}/api/n`, { method: 'POST', headers, body });
      expect(res.status).toBe(400);
    }
    const signup = await fetch(`${base}/api/auth/signup`, { method: 'POST', headers,
      body: JSON.stringify({ email: 'test@example.invalid', password: 'test-password-1234' }) });
    expect(signup.status).toBe(200);
    expect(signup.headers.get('cache-control')).toBe('no-store');
    const cookie = signup.headers.get('set-cookie')!.split(';')[0]!;
    const res = await fetch(`${base}/api/private`, { headers: { cookie } });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const login = await fetch(base + '/api/auth/login', { method: 'POST', headers, body: JSON.stringify({ email: 'test@example.invalid', password: 'test-password-1234' }) });
    const secondCookie = login.headers.get('set-cookie')!.split(';')[0]!;
    expect((await fetch(base + '/api/auth/logout-all', { method: 'POST', headers: { ...headers, cookie } })).status).toBe(200);
    for (const value of [cookie, secondCookie]) expect((await fetch(base + '/api/private', { headers: { cookie: value } })).status).toBe(401);
  });

  it('never fires a monthly job immediately', async () => {
    const root = emit(`(app a (db (table ticks (id auto)))
      (job monthly :every 2592000 (insert ticks))
      (api (get "/api/ticks" (count (select ticks)))) (page "/" home (txt "ok")))`);
    const server = await start(root);
    await delay(100);
    expect(await (await fetch(`${server.base}/api/ticks`)).json()).toBe(0);
    expect(server.errors()).not.toContain('TimeoutOverflowWarning');
  });

  it('waits for an active asynchronous job before reporting successful shutdown', async () => {
    const root = emit(`(app a (use "./work.ts" (import work)) (db (table ticks (id auto)))
      (job worker :every 0.01 (work)) (page "/" home (txt "ok")))`);
    fs.writeFileSync(path.join(root, 'work.ts'), `import fs from 'node:fs';
      export async function work() { console.log('JOB_STARTED'); await new Promise(r => setTimeout(r, 150)); fs.writeFileSync('completed', 'yes'); }`);
    const server = await start(root);
    for (let i = 0; i < 100 && !server.output().includes('JOB_STARTED'); i++) await delay(10);
    expect(server.output()).toContain('JOB_STARTED');
    const exited = once(server.child, 'exit');
    server.child.kill('SIGTERM');
    expect(await exited).toEqual([0, null]);
    expect(fs.readFileSync(path.join(root, 'completed'), 'utf8')).toBe('yes');
  });
});

describe('production test-hook boundary', () => {
  const hooksApp = `(app hooks
    (db (table items (id auto) (label string)))
    (api (get "/api/items" (select items)) (post "/api/items" (insert items :label body.label)))
    (data (resource items "/api/items" :default ()))
    (page "/" home (each item items.data (txt item.label))))`;

  async function waitFor(read: () => string, text: string): Promise<void> {
    for (let i = 0; i < 100 && !read().includes(text); i++) await delay(10);
  }

  it('ignores GRHM_TEST_HOOKS under NODE_ENV=production and says so once', async () => {
    const root = emit(hooksApp);
    const production = await start(root, { GRHM_TEST_HOOKS: '1', NODE_ENV: 'production', GRHM_RATE_LIMIT: '3' });
    await waitFor(production.errors, 'config-warning');
    const warnings = production.errors().split('\n').filter((line) => line.includes('config-warning'));
    expect(warnings).toHaveLength(1);
    expect(JSON.parse(warnings[0]!)).toMatchObject({ schema: 1, kind: 'config-warning', setting: 'GRHM_TEST_HOOKS' });
    // The reset route does not exist, and the rate limiter is live.
    const reset = await fetch(`${production.base}/__grhm/reset`, { method: 'POST', headers });
    expect(reset.status).toBe(404);
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) statuses.push((await fetch(`${production.base}/api/items`)).status);
    expect(statuses).toContain(429);
    expect(statuses[0]).toBe(200);
  });

  it('keeps the reset route and the rate-limit bypass for test runs outside production', async () => {
    const root = emit(hooksApp);
    const testing = await start(root, { GRHM_TEST_HOOKS: '1', GRHM_RATE_LIMIT: '3' });
    const reset = await fetch(`${testing.base}/__grhm/reset`, { method: 'POST', headers });
    expect(reset.status).toBe(200);
    for (let i = 0; i < 6; i++) expect((await fetch(`${testing.base}/api/items`)).status).toBe(200);
    expect(testing.errors()).not.toContain('config-warning');
    // Without the setting, production and test environments behave alike: no hooks, no warning.
    const plain = await start(root, { NODE_ENV: 'production' });
    expect((await fetch(`${plain.base}/__grhm/reset`, { method: 'POST', headers })).status).toBe(404);
    expect(plain.errors()).not.toContain('config-warning');
  });
});
