import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { ensureSchema, resetDatabase, type TableSpec } from '../src/runtime/storage.js';

const roots: string[] = [];
const databases: DatabaseSync[] = [];
function setup() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'grhm-migrations-'));
  const db = new DatabaseSync(':memory:');
  roots.push(directory); databases.push(db);
  return { db, directory };
}
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
const parents: TableSpec = { name: 'parents', columns: [{ name: 'id', ddl: '"id" INTEGER PRIMARY KEY AUTOINCREMENT', boolean: false }], indexes: [], uniqueIndexes: [] };
const children: TableSpec = { name: 'children', columns: [...parents.columns, { name: 'parent', ddl: '"parent" REAL NOT NULL DEFAULT 0 REFERENCES "parents"("id")', boolean: false }], indexes: [], uniqueIndexes: [] };

describe('transactional database lifecycle', () => {
  it('enforces foreign keys and resets related tables atomically in any declaration order', () => {
    const { db, directory } = setup();
    const seeds = [{ table: 'children', rows: [{ parent: 1 }] }, { table: 'parents', rows: [{}] }];
    ensureSchema(db, [parents, children], seeds, undefined, { directory });
    expect(db.prepare('PRAGMA foreign_keys').get()?.foreign_keys).toBe(1);
    expect(() => db.exec('INSERT INTO children(parent) VALUES(999)')).toThrow('FOREIGN KEY');
    resetDatabase(db, [parents, children], seeds, false);
    expect(db.prepare('SELECT * FROM children').all()).toEqual([{ id: 1, parent: 1 }]);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(() => db.exec('DELETE FROM parents')).toThrow('FOREIGN KEY');
  });

  it('does not resurrect deleted seed data on restart or replay changed seed definitions', () => {
    const { db, directory } = setup();
    ensureSchema(db, [parents], [{ table: 'parents', rows: [{}] }], undefined, { directory });
    db.exec('DELETE FROM parents');
    ensureSchema(db, [parents], [{ table: 'parents', rows: [{}, {}] }], undefined, { directory });
    expect(db.prepare('SELECT * FROM parents').all()).toEqual([]);
  });

  it('rolls back an entire failed upgrade and accepts a versioned backfill migration', () => {
    const { db, directory } = setup();
    const oldChildren = { ...children, columns: [...parents.columns] };
    ensureSchema(db, [parents, oldChildren], [], undefined, { directory });
    db.exec('INSERT INTO parents DEFAULT VALUES; INSERT INTO children DEFAULT VALUES');
    const addedTable = { ...parents, name: 'added' };
    expect(() => ensureSchema(db, [addedTable, parents, children], [], undefined, { directory })).toThrow('explicit backfill');
    expect(db.prepare("SELECT 1 FROM sqlite_schema WHERE name='added'").get()).toBeUndefined();
    expect(db.prepare('SELECT * FROM children').all()).toEqual([{ id: 1 }]);
    fs.writeFileSync(path.join(directory, '1_children_owner.sql'), `CREATE TABLE children_new (id INTEGER PRIMARY KEY AUTOINCREMENT, parent REAL NOT NULL DEFAULT 0 REFERENCES parents(id));
      INSERT INTO children_new(id, parent) SELECT id, 1 FROM children;
      DROP TABLE children; ALTER TABLE children_new RENAME TO children;`);
    const result = ensureSchema(db, [parents, children], [], undefined, { directory });
    expect(result.applied).toEqual(['1_children_owner.sql']);
    expect(db.prepare('SELECT * FROM children').all()).toEqual([{ id: 1, parent: 1 }]);
    expect(ensureSchema(db, [parents, children], [], undefined, { directory }).applied).toEqual([]);
    fs.appendFileSync(path.join(directory, '1_children_owner.sql'), '\n-- changed');
    expect(() => ensureSchema(db, [parents, children], [], undefined, { directory })).toThrow('missing or has changed');
  });

  it('rejects schema drift and invalid migrated references without committing partial work', () => {
    const { db, directory } = setup();
    ensureSchema(db, [parents, children], [], undefined, { directory });
    fs.writeFileSync(path.join(directory, '1_orphan.sql'), 'INSERT INTO children(parent) VALUES(999);');
    expect(() => ensureSchema(db, [parents, children], [], undefined, { directory })).toThrow('integrity');
    expect(db.prepare('SELECT * FROM children').all()).toEqual([]);
    fs.unlinkSync(path.join(directory, '1_orphan.sql'));
    const drift = { ...children, columns: [...parents.columns, { name: 'parent', ddl: 'parent TEXT', boolean: false }] };
    expect(() => ensureSchema(db, [parents, drift], [], undefined, { directory })).toThrow('Schema drift');
    expect(db.prepare('PRAGMA foreign_keys').get()?.foreign_keys).toBe(1);
  });

  it('previews changes without committing and disallows transaction escapes', () => {
    const { db, directory } = setup();
    expect(ensureSchema(db, [parents], [], undefined, { directory, dryRun: true }).added).toEqual(['parents']);
    expect(db.prepare("SELECT 1 FROM sqlite_schema WHERE name='parents'").get()).toBeUndefined();
    fs.writeFileSync(path.join(directory, '1_escape.sql'), '-- comment\nCOMMIT;');
    expect(() => ensureSchema(db, [parents], [], undefined, { directory })).toThrow('cannot control transactions');
  });
});
