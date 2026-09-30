import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/** Verify a closed snapshot before using it for recovery. */
export function verifySnapshot(file: string): { bytes: number; sha256: string } {
  if (!fs.lstatSync(file).isFile()) throw new Error('Snapshot must be a regular file');
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const integrity = db.prepare('PRAGMA integrity_check').all();
    if (integrity.length !== 1 || integrity[0]?.['integrity_check'] !== 'ok') throw new Error('Snapshot failed SQLite integrity check');
    if (db.prepare('PRAGMA foreign_key_check').all().length > 0) throw new Error('Snapshot failed foreign-key check');
  } finally { db.close(); }
  const digest = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  const chunk = Buffer.alloc(1024 * 1024);
  try { for (;;) { const n = fs.readSync(fd, chunk); if (n === 0) break; digest.update(chunk.subarray(0, n)); } }
  finally { fs.closeSync(fd); }
  return { bytes: fs.statSync(file).size, sha256: digest.digest('hex') };
}

/** Consistent online backup; restore always creates a new, offline DB path. */
export function copyDatabase(mode: 'backup' | 'restore', source: string, destination: string): { bytes: number; sha256: string } {
  const output = path.resolve(destination);
  if (fs.existsSync(output) || fs.existsSync(output + '-wal') || fs.existsSync(output + '-shm')) throw new Error('Destination must be a new database path');
  if (!fs.lstatSync(source).isFile()) throw new Error('Source must be a regular SQLite file');
  const temporary = output + '.tmp-' + crypto.randomUUID();
  try {
    if (mode === 'backup') {
      const db = new DatabaseSync(source, { readOnly: true });
      try {
        db.exec('PRAGMA busy_timeout = 5000');
        db.prepare('VACUUM INTO ?').run(temporary);
      } finally { db.close(); }
    } else {
      if (fs.existsSync(source + '-wal') && fs.statSync(source + '-wal').size > 0) throw new Error('Restore requires a closed snapshot; use backup for a live database');
      verifySnapshot(source);
      fs.copyFileSync(source, temporary, fs.constants.COPYFILE_EXCL);
    }
    fs.chmodSync(temporary, 0o600);
    const result = verifySnapshot(temporary);
    const fd = fs.openSync(temporary, 'r');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.linkSync(temporary, output); // Atomic publication that cannot overwrite.
    const directory = fs.openSync(path.dirname(output), 'r');
    try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
    return result;
  } finally { fs.rmSync(temporary, { force: true }); }
}

const entry = process.argv[1];
if (entry !== undefined && fs.existsSync(entry) && fs.realpathSync(new URL(import.meta.url)) === fs.realpathSync(entry)) {
  try {
    const [mode, source, destination] = process.argv.slice(2);
    if (source === undefined || !['backup', 'restore', 'verify'].includes(mode ?? '') || (mode !== 'verify' && destination === undefined)) {
      throw new Error('Usage: grhm db backup|restore <source> <new-destination>, or grhm db verify <snapshot>');
    }
    const result = mode === 'verify' ? verifySnapshot(source) : copyDatabase(mode as 'backup' | 'restore', source, destination!);
    console.log(JSON.stringify({ schema: 1, ok: true, ...result }));
  } catch (error) { console.error(JSON.stringify({ schema: 1, ok: false, error: error instanceof Error ? error.message : String(error) })); process.exitCode = 1; }
}
