import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

interface Entry { file: string; temporary: string; backup: string; existed: boolean; }
interface Journal { version: 1; committed: boolean; entries: Entry[]; }
const LOCK = '.grhm-write-lock';
const JOURNAL = '.grhm-write-journal.json';

function syncDirectory(root: string): void {
  const fd = fs.openSync(root, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function durableWrite(file: string, data: string, mode = 0o600): void {
  const fd = fs.openSync(file, 'wx', mode);
  try { fs.writeFileSync(fd, data); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function target(root: string, name: string): string {
  const resolved = path.resolve(root, name);
  const relative = path.relative(root, resolved);
  if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new Error('Invalid write journal path');
  const realRoot = fs.realpathSync(root);
  const realParent = fs.realpathSync(path.dirname(resolved));
  const parentRelative = path.relative(realRoot, realParent);
  if (parentRelative === '..' || parentRelative.startsWith('..' + path.sep) || path.isAbsolute(parentRelative)) throw new Error('Write journal escapes project');
  if (fs.existsSync(resolved) && fs.lstatSync(resolved).isSymbolicLink()) throw new Error('Write transaction refuses symbolic links');
  return resolved;
}
function saveJournal(root: string, journal: Journal): void {
  const temporary = path.join(root, JOURNAL + '.tmp');
  fs.rmSync(temporary, { force: true });
  durableWrite(temporary, JSON.stringify(journal));
  fs.renameSync(temporary, path.join(root, JOURNAL));
  syncDirectory(root);
}
/** Must run under the writer lock. An unfinished transaction rolls back. */
export function recoverWrites(root: string): void {
  const file = path.join(root, JOURNAL);
  if (!fs.existsSync(file)) return;
  const journal = JSON.parse(fs.readFileSync(file, 'utf8')) as Journal;
  if (journal.version !== 1 || typeof journal.committed !== 'boolean' || !Array.isArray(journal.entries)) throw new Error('Invalid write journal');
  for (const entry of journal.entries) {
    if (!entry.temporary.startsWith(entry.file + '.grhm-tmp-') || !entry.backup.startsWith(entry.file + '.grhm-bak-')) throw new Error('Invalid write journal entry');
    for (const name of [entry.file, entry.temporary, entry.backup]) target(root, name);
  }
  for (const entry of [...journal.entries].reverse()) {
    const original = target(root, entry.file);
    const backup = target(root, entry.backup);
    if (!journal.committed) {
      if (fs.existsSync(backup)) fs.renameSync(backup, original);
      else if (!entry.existed) fs.rmSync(original, { force: true });
    }
    fs.rmSync(target(root, entry.temporary), { force: true });
    fs.rmSync(backup, { force: true });
    syncDirectory(path.dirname(original));
  }
  fs.unlinkSync(file);
  syncDirectory(root);
}

/** Serialize cooperating processes and recover interrupted multi-file writes. */
export function withWriteLock<T>(root: string, run: () => T): T {
  const lock = path.join(root, LOCK);
  const reaper = lock + '-recovery';
  if (fs.existsSync(lock)) {
    // Only one process may inspect/reap a dead owner. A malformed or incomplete
    // owner is left for explicit operator inspection instead of stealing a lock.
    let fd: number;
    try { fd = fs.openSync(reaper, 'wx'); } catch { throw new Error('Project write recovery is in progress'); }
    try {
      if (fs.existsSync(lock)) {
        const owner = JSON.parse(fs.readFileSync(lock, 'utf8')) as { pid: number };
        if (!Number.isInteger(owner.pid) || owner.pid <= 0) throw new Error('Invalid project writer lock');
        let alive = true;
        try { process.kill(owner.pid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') alive = false; }
        if (alive) throw new Error('Another process is writing this project');
        fs.unlinkSync(lock);
      }
    } finally { fs.closeSync(fd); fs.unlinkSync(reaper); }
  }
  durableWrite(lock, JSON.stringify({ pid: process.pid, nonce: crypto.randomUUID() }));
  try { recoverWrites(root); return run(); }
  finally { fs.unlinkSync(lock); syncDirectory(root); }
}

/** Call under withWriteLock after validation and a compare-and-swap check. */
export function writeFiles(root: string, changes: Map<string, string>): void {
  const nonce = crypto.randomUUID();
  const journal: Journal = { version: 1, committed: false, entries: [...changes.keys()].map((file) => ({
    file, temporary: file + '.grhm-tmp-' + nonce, backup: file + '.grhm-bak-' + nonce, existed: fs.existsSync(target(root, file)),
  })) };
  // Persist the recovery plan before touching any application file.
  saveJournal(root, journal);
  try {
    for (const entry of journal.entries) {
      const original = target(root, entry.file);
      const mode = entry.existed ? fs.statSync(original).mode : 0o644;
      durableWrite(target(root, entry.temporary), changes.get(entry.file)!, mode);
    }
    for (const entry of journal.entries) {
      const original = target(root, entry.file);
      if (entry.existed) fs.renameSync(original, target(root, entry.backup));
      fs.renameSync(target(root, entry.temporary), original);
      syncDirectory(path.dirname(original));
    }
    journal.committed = true;
    saveJournal(root, journal);
  } catch (error) { recoverWrites(root); throw error; }
  recoverWrites(root);
}
