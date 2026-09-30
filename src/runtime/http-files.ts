/** Streaming, cache-aware serving for generated servers and static-only apps. */
import crypto from 'node:crypto';
import fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.txt': 'text/plain; charset=utf-8', '.pdf': 'application/pdf', '.wasm': 'application/wasm',
};
export function securityHeaders(res: ServerResponse): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  if (process.env.GRHM_CSP) res.setHeader('Content-Security-Policy', process.env.GRHM_CSP);
  if (process.env.GRHM_SECURE === '1') res.setHeader('Strict-Transport-Security', 'max-age=31536000');
}
function within(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}

/** Resolve and open before sending headers; stream bounded chunks with backpressure. */
export async function serveFile(req: IncomingMessage, res: ServerResponse, root: string, relative: string,
  options: { type?: string; private?: boolean; attachment?: boolean; immutable?: boolean } = {}): Promise<boolean> {
  let handle: Awaited<ReturnType<typeof fsp.open>> | undefined;
  try {
    const realRoot = await fsp.realpath(root);
    const target = path.resolve(realRoot, relative);
    if (!within(realRoot, target)) return false;
    const real = await fsp.realpath(target);
    if (!within(realRoot, real)) return false;
    handle = await fsp.open(real, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const stat = await handle.stat();
    if (!stat.isFile()) return false;
    const type = options.type ?? MIME[path.extname(real)] ?? 'application/octet-stream';
    const etag = 'W/"' + crypto.createHash('sha256').update(stat.size + ':' + stat.mtimeMs).digest('hex').slice(0, 24) + '"';
    res.setHeader('Content-Type', type);
    res.setHeader('Cache-Control', options.private ? 'no-store' : options.immutable ? 'public, max-age=31536000, immutable' : 'no-cache');
    if (options.attachment) res.setHeader('Content-Disposition', 'attachment');
    if (!options.private) {
      res.setHeader('ETag', etag);
      res.setHeader('Last-Modified', stat.mtime.toUTCString());
      if (req.headers['if-none-match']?.split(',').map((s) => s.trim()).includes(etag)) {
        res.writeHead(304); res.end(); return true;
      }
    }
    res.setHeader('Content-Length', stat.size);
    res.writeHead(200);
    if (req.method === 'HEAD') res.end();
    else await pipeline(handle.createReadStream({ autoClose: false }), res);
    return true;
  } catch (error) {
    if (res.headersSent) { res.destroy(); return true; }
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'ELOOP') return false;
    throw error;
  } finally { await handle?.close(); }
}

export async function serveStatic(req: IncomingMessage, res: ServerResponse, root = path.resolve('dist')): Promise<boolean> {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  const raw = (req.url ?? '/').split('?')[0] ?? '/';
  let pathname: string;
  try { pathname = decodeURIComponent(raw); } catch { return false; }
  if (!pathname.startsWith('/') || pathname.includes('\0') || pathname.includes('\\') || pathname.split('/').some((segment) => segment.startsWith('.'))) return false;
  const relative = pathname === '/' ? 'index.html' : pathname.slice(1);
  if (await serveFile(req, res, root, relative, { immutable: /^assets\/.*-[\w-]{8,}\.[\w]+$/.test(relative) })) return true;
  if (path.extname(pathname) !== '' || !req.headers.accept?.includes('text/html')) return false;
  return serveFile(req, res, root, 'index.html');
}
