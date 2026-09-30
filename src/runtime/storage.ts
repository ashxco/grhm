/** Standalone SQLite lifecycle shared verbatim with generated applications. */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

export interface ColumnSpec { name: string; ddl: string; boolean: boolean; }
export interface TableSpec { name: string; columns: ColumnSpec[]; indexes: string[]; uniqueIndexes: string[]; }
export interface SeedSpec { table: string; rows: Record<string, unknown>[]; }
interface ColumnInfo { name: string; type: string; notnull: number; dflt_value: string | null; pk: number; }
interface ForeignKeyInfo { from: string; table: string; to: string; }
export interface MigrationResult { applied: string[]; added: string[]; }
const quote = (name: string): string => '"' + name.replaceAll('"', '""') + '"';
const hash = (text: string): string => crypto.createHash('sha256').update(text).digest('hex');

// Migration files are trusted application code, but transaction/connection
// control belongs to this runner. Ignore quoted text and comments when checking.
function checkMigrationSql(sql: string): void {
  const unquoted = sql.replace(/--[^\n]*|\/\*[\s\S]*?\*\/|'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|\[[^\]]*\]/g, ' ');
  for (const statement of unquoted.split(';')) {
    if (/^\s*(BEGIN|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE|VACUUM|ATTACH|DETACH|PRAGMA)\b/i.test(statement)) {
      throw new Error('Migration files cannot control transactions, connections, or PRAGMAs');
    }
  }
}

function explicitMigrations(db: DatabaseSync, directory: string, applied: string[]): void {
  const files = fs.existsSync(directory) ? fs.readdirSync(directory).filter((name) => name.endsWith('.sql')) : [];
  const migrations = files.map((name) => {
    const match = /^(\d+)[_-][A-Za-z0-9_-]+\.sql$/.exec(name);
    if (match === null) throw new Error('Migration filename must be <version>_<name>.sql: ' + name);
    const version = Number(match[1]);
    if (!Number.isSafeInteger(version) || version < 1) throw new Error('Invalid migration version: ' + name);
    const file = path.join(directory, name);
    if (!fs.lstatSync(file).isFile()) throw new Error('Migration must be a regular file: ' + name);
    if (fs.statSync(file).size > 2 * 1024 * 1024) throw new Error('Migration exceeds 2 MiB: ' + name);
    const sql = fs.readFileSync(file, 'utf8');
    checkMigrationSql(sql);
    return { name, version, sql, checksum: hash(sql) };
  }).sort((a, b) => a.version - b.version);
  const versions = new Set<number>();
  const history = db.prepare('SELECT name, checksum FROM _grhm_migrations WHERE kind = ?').all('sql') as { name: string; checksum: string }[];
  for (const prior of history) {
    if (!migrations.some((m) => m.name === prior.name && m.checksum === prior.checksum)) {
      throw new Error('Applied migration is missing or has changed: ' + prior.name);
    }
  }
  const latest = Math.max(0, ...history.map((row) => Number(row.name.split(/[_-]/)[0])));
  for (const migration of migrations) {
    if (versions.has(migration.version)) throw new Error('Duplicate migration version: ' + migration.version);
    versions.add(migration.version);
    if (history.some((row) => row.name === migration.name)) continue;
    if (migration.version <= latest) throw new Error('New migrations must follow the last applied version: ' + migration.name);
    db.exec(migration.sql);
    db.prepare('INSERT INTO _grhm_migrations(name, checksum, kind, applied_at) VALUES (?, ?, ?, ?)')
      .run(migration.name, migration.checksum, 'sql', Date.now());
    applied.push(migration.name);
  }
}

function columns(db: DatabaseSync, table: string, temporary = false): ColumnInfo[] {
  return db.prepare('PRAGMA ' + (temporary ? 'temp.' : '') + 'table_info(' + quote(table) + ')').all() as unknown as ColumnInfo[];
}
function foreignKeys(db: DatabaseSync, table: string, temporary = false): ForeignKeyInfo[] {
  return db.prepare('PRAGMA ' + (temporary ? 'temp.' : '') + 'foreign_key_list(' + quote(table) + ')').all() as unknown as ForeignKeyInfo[];
}
function sameColumn(a: ColumnInfo, b: ColumnInfo): boolean {
  return a.type.toUpperCase() === b.type.toUpperCase() && a.notnull === b.notnull && a.pk === b.pk && a.dflt_value === b.dflt_value;
}

function synchronizeTable(db: DatabaseSync, table: TableSpec, added: string[]): void {
  const tableName = quote(table.name);
  const present = db.prepare('SELECT 1 FROM sqlite_schema WHERE type = ? AND name = ?').get('table', table.name);
  if (present === undefined) {
    db.exec('CREATE TABLE ' + tableName + ' (' + table.columns.map((c) => c.ddl).join(', ') + ')');
    added.push(table.name);
  } else {
    const scratch = '_grhm_expected_' + crypto.randomBytes(8).toString('hex');
    db.exec('CREATE TEMP TABLE ' + quote(scratch) + ' (' + table.columns.map((c) => c.ddl).join(', ') + ')');
    try {
      const expected = columns(db, scratch, true);
      const existing = columns(db, table.name);
      const expectedRefs = foreignKeys(db, scratch, true);
      const actualRefs = foreignKeys(db, table.name);
      for (const column of existing) {
        const desired = expected.find((item) => item.name === column.name);
        if (desired === undefined || !sameColumn(column, desired)) {
          throw new Error('Schema drift in ' + table.name + '.' + column.name + '; supply a versioned SQL migration before deploying');
        }
        const ref = expectedRefs.find((item) => item.from === column.name);
        const actual = actualRefs.find((item) => item.from === column.name);
        if (ref?.table !== actual?.table || ref?.to !== actual?.to) {
          throw new Error('Foreign-key drift in ' + table.name + '.' + column.name + '; supply a versioned SQL migration');
        }
      }
      for (const column of table.columns) {
        if (existing.some((item) => item.name === column.name)) continue;
        const desired = expected.find((item) => item.name === column.name)!;
        if (desired.pk || (desired.notnull && expectedRefs.some((item) => item.from === column.name))) {
          const count = db.prepare('SELECT COUNT(*) AS n FROM ' + tableName).get() as { n: number };
          if (count.n > 0) throw new Error('Column ' + table.name + '.' + column.name + ' requires an explicit backfill; supply a versioned SQL migration');
        }
        db.exec('ALTER TABLE ' + tableName + ' ADD COLUMN ' + column.ddl);
        added.push(table.name + '.' + column.name);
      }
    } finally { db.exec('DROP TABLE temp.' + quote(scratch)); }
  }
  for (const [names, unique] of [[table.indexes, false], [table.uniqueIndexes, true]] as const) {
    for (const column of names) {
      const name = (unique ? 'uidx_' : 'idx_') + table.name + '_' + column;
      const indexes = db.prepare('PRAGMA index_list(' + tableName + ')').all() as { name: string; unique: number }[];
      const existing = indexes.find((index) => index.name === name);
      if (existing !== undefined) {
        const indexed = db.prepare('PRAGMA index_info(' + quote(name) + ')').all() as { name: string }[];
        if (Boolean(existing.unique) !== unique || indexed.length !== 1 || indexed[0]?.name !== column) throw new Error('Index drift: ' + name);
      } else db.exec('CREATE ' + (unique ? 'UNIQUE ' : '') + 'INDEX ' + quote(name) + ' ON ' + tableName + ' (' + quote(column) + ')');
    }
  }
}

function seedRows(db: DatabaseSync, seeds: SeedSpec[], reset = false): void {
  for (const seed of seeds) {
    const checksum = hash(JSON.stringify(seed.rows));
    const prior = db.prepare('SELECT checksum FROM _grhm_seeds WHERE table_name = ?').get(seed.table) as { checksum: string } | undefined;
    // Seed definitions bootstrap a database once. Subsequent changes belong in
    // migrations; deleting business data must not cause its resurrection.
    if (prior !== undefined && !reset) continue;
    const count = db.prepare('SELECT COUNT(*) AS n FROM ' + quote(seed.table)).get() as { n: number };
    if (count.n === 0) {
      for (const row of seed.rows) {
        const names = Object.keys(row);
        const values = names.map((name) => typeof row[name] === 'boolean' ? Number(row[name]) : row[name] as string | number | null);
        const sql = names.length === 0 ? 'INSERT INTO ' + quote(seed.table) + ' DEFAULT VALUES'
          : 'INSERT INTO ' + quote(seed.table) + ' (' + names.map(quote).join(',') + ') VALUES (' + names.map(() => '?').join(',') + ')';
        db.prepare(sql).run(...values);
      }
    }
    db.prepare('INSERT OR REPLACE INTO _grhm_seeds(table_name, checksum, applied_at) VALUES (?, ?, ?)').run(seed.table, checksum, Date.now());
  }
}

/** Apply all migrations and seeds atomically, checking integrity before commit. */
export function ensureSchema(db: DatabaseSync, schema: TableSpec[], seeds: SeedSpec[], usersTable?: string,
  options: { directory?: string; dryRun?: boolean } = {}): MigrationResult {
  const result: MigrationResult = { applied: [], added: [] };
  // Disabling checks during a migration permits table rebuilds and cyclic data
  // backfills. No change commits unless the entire final database passes checks.
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    db.exec('BEGIN IMMEDIATE');
    db.exec('CREATE TABLE IF NOT EXISTS _grhm_migrations (name TEXT PRIMARY KEY, checksum TEXT NOT NULL, kind TEXT NOT NULL, applied_at INTEGER NOT NULL)');
    db.exec('CREATE TABLE IF NOT EXISTS _grhm_schema (table_name TEXT PRIMARY KEY, definition TEXT NOT NULL)');
    db.exec('CREATE TABLE IF NOT EXISTS _grhm_seeds (table_name TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at INTEGER NOT NULL)');
    explicitMigrations(db, options.directory ?? path.resolve('migrations'), result.applied);
    const tracked = db.prepare('SELECT table_name FROM _grhm_schema').all() as { table_name: string }[];
    for (const previous of tracked) {
      if (schema.some((table) => table.name === previous.table_name)) continue;
      if (db.prepare('SELECT 1 FROM sqlite_schema WHERE type = ? AND name = ?').get('table', previous.table_name)) {
        throw new Error('Removed table requires an explicit migration: ' + previous.table_name);
      }
      db.prepare('DELETE FROM _grhm_schema WHERE table_name = ?').run(previous.table_name);
    }
    for (const table of schema) {
      const old = db.prepare('SELECT definition FROM _grhm_schema WHERE table_name = ?').get(table.name) as { definition: string } | undefined;
      if (old !== undefined) {
        const prior = JSON.parse(old.definition) as TableSpec;
        for (const [before, after, prefix] of [[prior.indexes, table.indexes, 'idx_'], [prior.uniqueIndexes, table.uniqueIndexes, 'uidx_']] as const) {
          for (const column of before) {
            const name = prefix + table.name + '_' + column;
            if (!after.includes(column) && db.prepare('SELECT 1 FROM sqlite_schema WHERE type = ? AND name = ?').get('index', name)) throw new Error('Removed index requires an explicit migration: ' + name);
          }
        }
      }
      synchronizeTable(db, table, result.added);
      db.prepare('INSERT OR REPLACE INTO _grhm_schema(table_name, definition) VALUES (?, ?)').run(table.name, JSON.stringify(table));
    }
    if (usersTable !== undefined) {
      db.exec('CREATE TABLE IF NOT EXISTS _grhm_sessions (token TEXT PRIMARY KEY, user_id INTEGER NOT NULL, created_at INTEGER NOT NULL)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_grhm_sessions_created ON _grhm_sessions(created_at)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_grhm_sessions_user ON _grhm_sessions(user_id)');
    }
    seedRows(db, seeds);
    if (db.prepare('PRAGMA foreign_key_check').all().length > 0) throw new Error('Migration failed foreign-key integrity validation');
    const signature = hash(JSON.stringify(schema));
    db.prepare('INSERT OR IGNORE INTO _grhm_migrations(name, checksum, kind, applied_at) VALUES (?, ?, ?, ?)')
      .run('schema/' + signature, signature, 'schema', Date.now());
    db.exec(options.dryRun ? 'ROLLBACK' : 'COMMIT');
    return result;
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* preserve original migration failure */ }
    throw error;
  } finally { db.exec('PRAGMA foreign_keys = ON'); }
}

/** Test reset remains atomic even for cyclic references and seeded tables. */
export function resetDatabase(db: DatabaseSync, schema: TableSpec[], seeds: SeedSpec[], auth: boolean): void {
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    db.exec('BEGIN IMMEDIATE');
    const sequence = db.prepare("SELECT 1 FROM sqlite_schema WHERE name = 'sqlite_sequence'").get() !== undefined;
    for (const table of schema) {
      db.exec('DELETE FROM ' + quote(table.name));
      if (sequence) db.prepare('DELETE FROM sqlite_sequence WHERE name = ?').run(table.name);
    }
    if (auth) db.exec('DELETE FROM _grhm_sessions');
    seedRows(db, seeds, true);
    if (db.prepare('PRAGMA foreign_key_check').all().length > 0) throw new Error('Reset failed foreign-key integrity validation');
    db.exec('COMMIT');
  } catch (error) { try { db.exec('ROLLBACK'); } catch { /* preserve original error */ } throw error; }
  finally { db.exec('PRAGMA foreign_keys = ON'); }
}

export function storageFailure(error: unknown): { status: number; message: string } | undefined {
  if (!(error instanceof Error)) return undefined;
  const code = (error as Error & { code?: string }).code;
  if (code !== 'ERR_SQLITE_ERROR') return undefined;
  if (/constraint failed/i.test(error.message)) return { status: 409, message: 'database constraint violation' };
  if (/database (?:is )?(?:locked|busy)/i.test(error.message)) return { status: 503, message: 'database temporarily unavailable' };
  return undefined;
}
