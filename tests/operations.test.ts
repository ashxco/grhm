import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { withWriteLock, writeFiles } from '../src/fs-transaction.js';
import { copyDatabase, verifySnapshot } from '../src/runtime/db-admin.js';
import { Limiter } from '../src/runtime/controls.js';
import { validateInput } from '../src/runtime/contracts.js';

const roots: string[] = [];
function root(): string { const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'grhm-operations-')); roots.push(directory); return directory; }
afterEach(() => { vi.restoreAllMocks(); for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });

describe('recoverable project writes', () => {
  it('rolls back both files when a later rename fails', () => {
    const directory = root();
    for (const file of ['a', 'b']) fs.writeFileSync(path.join(directory, file), 'before-' + file);
    const rename = fs.renameSync;
    let injected = false;
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (!injected && String(from).includes('b.grhm-tmp-')) { injected = true; throw new Error('injected failure'); }
      rename(from, to);
    });
    expect(() => withWriteLock(directory, () => writeFiles(directory, new Map([['a', 'after'], ['b', 'after']])))).toThrow('injected failure');
    expect(fs.readFileSync(path.join(directory, 'a'), 'utf8')).toBe('before-a');
    expect(fs.readFileSync(path.join(directory, 'b'), 'utf8')).toBe('before-b');
    expect(fs.readdirSync(directory).sort()).toEqual(['a', 'b']);
  });
  it('recovers an interrupted swap before the next writer runs, and excludes another writer', () => {
    const directory = root();
    fs.writeFileSync(path.join(directory, 'a.grhm-bak-crash'), 'before');
    fs.writeFileSync(path.join(directory, 'a'), 'partial');
    fs.writeFileSync(path.join(directory, '.grhm-write-journal.json'), JSON.stringify({ version: 1, committed: false, entries: [{ file: 'a', backup: 'a.grhm-bak-crash', temporary: 'a.grhm-tmp-crash', existed: true }] }));
    withWriteLock(directory, () => {
      expect(fs.readFileSync(path.join(directory, 'a'), 'utf8')).toBe('before');
      expect(() => withWriteLock(directory, () => undefined)).toThrow('Another process');
    });
    expect(fs.readdirSync(directory)).toEqual(['a']);
  });
});

describe('verified disaster recovery', () => {
  it('backs up a live WAL database and restores its committed rows to a new destination', () => {
    const directory = root();
    const source = path.join(directory, 'live.db');
    const snapshot = path.join(directory, 'snapshot.db');
    const restored = path.join(directory, 'restored.db');
    const db = new DatabaseSync(source);
    try {
      db.exec("PRAGMA journal_mode=WAL; CREATE TABLE records(id INTEGER PRIMARY KEY, body TEXT); INSERT INTO records VALUES(1, 'committed')");
      const receipt = copyDatabase('backup', source, snapshot);
      expect(receipt.sha256).toMatch(/^[0-9a-f]{64}$/);
      db.exec("INSERT INTO records VALUES(2, 'later')");
      expect(copyDatabase('restore', snapshot, restored).sha256).toBe(receipt.sha256);
      const recovery = new DatabaseSync(restored);
      try { expect(recovery.prepare('SELECT * FROM records').all()).toEqual([{ id: 1, body: 'committed' }]); }
      finally { recovery.close(); }
      expect(() => copyDatabase('restore', snapshot, source)).toThrow('new database path');
      fs.writeFileSync(path.join(directory, 'corrupt.db'), 'not sqlite');
      expect(() => verifySnapshot(path.join(directory, 'corrupt.db'))).toThrow();
    } finally { db.close(); }
  });
});

it('bounds limiter cardinality and expires windows', () => {
  const limiter = new Limiter(2, 100, 2);
  expect(limiter.allow('a', 1)).toBe(true);
  expect(limiter.allow('a', 2)).toBe(true);
  expect(limiter.allow('a', 3)).toBe(false);
  expect(limiter.allow('b', 4)).toBe(true);
  expect(limiter.allow('c', 5)).toBe(false);
  expect(limiter.allow('c', 102)).toBe(true);
});

it('validates bounded contracts without coercion', () => {
  const fields = [{ name: 'n', type: 'number' as const, optional: false, integer: true, min: 1, max: 10 }, { name: 'email', type: 'string' as const, optional: false, format: 'email' as const, maxLength: 30 }];
  for (const n of [0, 11, 1.5, Infinity, '2']) expect(validateInput(fields, { n, email: 'a@b.test' }).errors.length).toBeGreaterThan(0);
  expect(validateInput(fields, { n: 2, email: 'a@b.test' }).errors).toEqual([]);
  expect(validateInput(fields, { n: 2, email: 'invalid' }).errors.length).toBeGreaterThan(0);
});
