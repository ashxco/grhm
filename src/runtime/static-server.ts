import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { securityHeaders, serveStatic } from './http-files.js';

export function startStaticServer(): http.Server {
  const port = Number(process.env.PORT ?? 8787);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('PORT must be an integer from 0 to 65535');
  const server = http.createServer((req, res) => {
    securityHeaders(res);
    const requestId = crypto.randomUUID();
    res.setHeader('X-Request-Id', requestId);
    const started = performance.now();
    res.on('finish', () => {
      if (process.env.GRHM_QUIET !== '1') console.log(JSON.stringify({ schema: 1, kind: 'request', requestId, method: req.method, path: req.url?.split('?')[0], status: res.statusCode, ms: performance.now() - started }));
    });
    const fail = (status: number, message: string): void => {
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ error: message }));
    };
    req.on('error', () => res.destroy());
    if (req.method === 'GET' && ['/healthz', '/readyz'].includes(req.url ?? '')) {
      const ready = req.url === '/healthz' || fs.existsSync(path.resolve('dist/index.html'));
      res.writeHead(ready ? 200 : 503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ ok: ready })); return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.setHeader('Allow', 'GET, HEAD'); fail(405, 'method not allowed'); return; }
    if (/^\/(api|uploads)(\/|$)/.test(req.url ?? '')) { fail(404, 'not found'); return; }
    void serveStatic(req, res).then((served) => { if (!served) fail(404, 'not found'); }).catch((error: unknown) => {
      console.error(JSON.stringify({ schema: 1, kind: 'request-error', requestId, message: error instanceof Error ? error.message : String(error) }));
      if (!res.headersSent) fail(500, 'internal error'); else res.destroy();
    });
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  server.listen(port, process.env.HOST ?? '127.0.0.1', () => {
    const address = server.address();
    console.log(JSON.stringify({ schema: 1, kind: 'server-started', port: typeof address === 'object' && address !== null ? address.port : port }));
  });
  let stopping = false;
  const shutdown = (): void => {
    if (stopping) return;
    stopping = true;
    const deadline = setTimeout(() => { server.closeAllConnections(); process.exit(1); }, 10_000);
    server.close(() => { clearTimeout(deadline); process.exit(0); });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  return server;
}
const entry = process.argv[1];
if (entry !== undefined && fs.existsSync(entry) && fs.realpathSync(new URL(import.meta.url)) === fs.realpathSync(entry)) startStaticServer();
