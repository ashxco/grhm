/** Owned uploads with transactional quota reservations and streaming downloads. */
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { serveFile } from './http-files.js';

export interface UploadPolicy { maxKb: number; public: boolean; quotaMb: number; userQuotaMb: number; }
interface UploadRow { name: string; owner: number | null; bytes: number; public: number; ready: number; }
const TYPES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
const validName = (name: string): boolean => /^[a-z0-9-]+(?:\.(?:png|jpe?g|gif|webp))?$/.test(name) && name.length <= 80;

export function createUploadStore(db: DatabaseSync, directory: string, policy: UploadPolicy) {
  db.exec('CREATE TABLE IF NOT EXISTS _grhm_uploads(name TEXT PRIMARY KEY, owner INTEGER, bytes INTEGER NOT NULL, public INTEGER NOT NULL, ready INTEGER NOT NULL, created_at INTEGER NOT NULL)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_grhm_upload_owner ON _grhm_uploads(owner)');
  let initialization: Promise<void> | undefined;
  const initialize = (): Promise<void> => initialization ??= (async () => {
    await fs.mkdir(directory, { recursive: true });
    const entries = await fs.readdir(directory, { withFileTypes: true });
    // Recover writes interrupted before acknowledgement. Untracked legacy files
    // count toward the quota; auth apps never silently publish their contents.
    const pending = db.prepare('SELECT name FROM _grhm_uploads WHERE ready = 0').all() as { name: string }[];
    for (const row of pending) {
      if (validName(row.name)) await fs.rm(path.join(directory, row.name), { force: true });
      db.prepare('DELETE FROM _grhm_uploads WHERE name = ?').run(row.name);
    }
    for (const entry of entries) {
      if (entry.isFile() && entry.name.startsWith('.pending-')) { await fs.rm(path.join(directory, entry.name), { force: true }); continue; }
      if (!entry.isFile() || !validName(entry.name) || pending.some((row) => row.name === entry.name)) continue;
      const stat = await fs.stat(path.join(directory, entry.name));
      db.prepare('INSERT OR IGNORE INTO _grhm_uploads(name, owner, bytes, public, ready, created_at) VALUES (?, NULL, ?, ?, 1, ?)')
        .run(entry.name, stat.size, Number(policy.public), Date.now());
    }
  })().catch((error: unknown) => { initialization = undefined; throw error; });

  return {
    async ready(): Promise<void> {
      await initialize();
      if (!(await fs.stat(directory)).isDirectory()) throw new Error('Upload storage is not a directory');
      await fs.access(directory, 2);
      if ((await fs.statfs(directory)).bavail === 0) throw new Error('Upload storage is full');
    },
    async upload(raw: Buffer, filename: string, owner?: number): Promise<{ status: number; payload: unknown }> {
      if (!policy.public && owner === undefined) return { status: 401, payload: { error: 'authentication required' } };
      if (raw.length === 0 || raw.length > policy.maxKb * 1024) return { status: raw.length ? 413 : 400, payload: { error: 'invalid upload size' } };
      await initialize();
      await fs.mkdir(directory, { recursive: true });
      const extension = path.extname(filename).toLowerCase();
      const name = (policy.public ? crypto.createHash('sha256').update(raw).digest('hex') : crypto.randomUUID()) + (TYPES[extension] ? extension : '');
      const existing = db.prepare('SELECT ready FROM _grhm_uploads WHERE name = ?').get(name) as { ready: number } | undefined;
      if (existing) return existing.ready ? { status: 200, payload: { url: '/uploads/' + name } } : { status: 409, payload: { error: 'upload in progress; retry later' } };
      db.exec('BEGIN IMMEDIATE');
      try {
        const total = db.prepare('SELECT COALESCE(SUM(bytes), 0) AS bytes, COUNT(*) AS count FROM _grhm_uploads').get() as { bytes: number; count: number };
        const owned = owner === undefined ? undefined : db.prepare('SELECT COALESCE(SUM(bytes), 0) AS bytes, COUNT(*) AS count FROM _grhm_uploads WHERE owner = ?').get(owner) as { bytes: number; count: number };
        if (total.bytes + raw.length > policy.quotaMb * 1024 * 1024 || total.count >= 10_000 ||
          (owned !== undefined && (owned.bytes + raw.length > policy.userQuotaMb * 1024 * 1024 || owned.count >= 1000))) {
          db.exec('ROLLBACK');
          return { status: 413, payload: { error: 'upload storage quota exceeded' } };
        }
        db.prepare('INSERT INTO _grhm_uploads(name, owner, bytes, public, ready, created_at) VALUES (?, ?, ?, ?, 0, ?)')
          .run(name, owner ?? null, raw.length, Number(policy.public), Date.now());
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
      const temporary = path.join(directory, '.pending-' + crypto.randomUUID());
      const target = path.join(directory, name);
      try {
        const file = await fs.open(temporary, 'wx', 0o600);
        try { await file.writeFile(raw); await file.sync(); } finally { await file.close(); }
        await fs.rename(temporary, target);
        const folder = await fs.open(directory, 'r');
        try { await folder.sync(); } finally { await folder.close(); }
        db.prepare('UPDATE _grhm_uploads SET ready = 1 WHERE name = ?').run(name);
        return { status: 200, payload: { url: '/uploads/' + name } };
      } catch (error) {
        await Promise.allSettled([fs.rm(temporary, { force: true }), fs.rm(target, { force: true })]);
        db.prepare('DELETE FROM _grhm_uploads WHERE name = ?').run(name);
        throw error;
      }
    },
    async serve(req: IncomingMessage, res: ServerResponse, name: string, owner?: number): Promise<boolean> {
      if (!validName(name)) return false;
      await initialize();
      const row = db.prepare('SELECT * FROM _grhm_uploads WHERE name = ? AND ready = 1').get(name) as unknown as UploadRow | undefined;
      if (!row || (!row.public && (owner === undefined || row.owner !== owner))) return false;
      const type = TYPES[path.extname(name)] ?? 'application/octet-stream';
      res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
      return serveFile(req, res, directory, name, { type, private: !row.public, attachment: type === 'application/octet-stream' });
    },
    async remove(name: string, owner: number): Promise<boolean> {
      if (!validName(name)) return false;
      await initialize();
      const row = db.prepare('SELECT * FROM _grhm_uploads WHERE name = ? AND owner = ?').get(name, owner);
      if (!row) return false;
      await fs.rm(path.join(directory, name), { force: true });
      db.prepare('DELETE FROM _grhm_uploads WHERE name = ? AND owner = ?').run(name, owner);
      return true;
    },
  };
}
