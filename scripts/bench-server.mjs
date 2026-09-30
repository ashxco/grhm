import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { compile } from '../dist/codegen/index.js';

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'grhm-load-'));
const concurrency = Number(process.env.GRHM_LOAD_CONCURRENCY ?? 32);
const requests = Number(process.env.GRHM_LOAD_REQUESTS ?? 10000);
if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 128 || !Number.isSafeInteger(requests) || requests < concurrency || requests > 100_000) throw new Error('Invalid load configuration');
const source = `(app load (db (table records (id auto) (label string :indexed true)))
  (api (get "/api/records" (select records :limit 50 :order id))
    (post "/api/records" (input (label string :max-len 100)) (insert records :label body.label)))
  (page "/" home (txt "Load test")))`;
let server;
let output = '';
try {
  const compiled = compile(source);
  assert.equal(compiled.diagnostics.filter((d) => d.severity === 'error').length, 0);
  for (const [file, content] of compiled.files) {
    await fs.mkdir(path.dirname(path.join(directory, file)), { recursive: true });
    await fs.writeFile(path.join(directory, file), content);
  }
  server = spawn(process.execPath, ['--experimental-strip-types', path.join(directory, 'server.ts')], {
    cwd: directory, env: { ...process.env, HOST: '127.0.0.1', PORT: '0', GRHM_DB: path.join(directory, 'load.db'), GRHM_QUIET: '1', GRHM_RATE_LIMIT: '0', GRHM_METRICS_TOKEN: 'load-test-metrics' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (chunk) => { output = (output + chunk).slice(-16_384); });
  server.stderr.on('data', (chunk) => { output = (output + chunk).slice(-16_384); });
  let port;
  for (let i = 0; i < 500; i++) {
    port = output.match(/"kind":"server-started","port":(\d+)/)?.[1];
    if (port) break;
    if (server.exitCode !== null) throw new Error(output);
    await delay(10);
  }
  assert.ok(port, output);
  const base = 'http://127.0.0.1:' + port;
  const latencies = [];
  let next = 0;
  const started = performance.now();
  await Promise.all(Array.from({ length: concurrency }, async () => {
    for (;;) {
      const index = next++;
      if (index >= requests) return;
      const write = index % 5 === 0;
      const before = performance.now();
      const response = await fetch(base + '/api/records', { method: write ? 'POST' : 'GET',
        headers: write ? { 'x-grhm': '1', 'content-type': 'application/json' } : {},
        body: write ? JSON.stringify({ label: 'record-' + index }) : undefined, signal: AbortSignal.timeout(10_000) });
      assert.equal(response.status, 200, await response.clone().text());
      const data = await response.json();
      if (!write) assert.ok(Array.isArray(data) && data.length <= 50);
      latencies.push(performance.now() - before);
    }
  }));
  const seconds = (performance.now() - started) / 1000;
  latencies.sort((a, b) => a - b);
  const percentile = (n) => latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * n))];
  const metrics = await (await fetch(base + '/__grhm/metrics', { headers: { authorization: 'Bearer load-test-metrics' } })).json();
  const report = { schema: 1, node: process.versions.node, platform: process.platform, concurrency, requests, seconds, requestsPerSecond: requests / seconds,
    latencyMs: { p50: percentile(.5), p95: percentile(.95), p99: percentile(.99) }, rssBytes: metrics.memory.rss, eventLoopMs: metrics.eventLoopMilliseconds };
  console.log(JSON.stringify(report, null, 2));
  assert.ok(report.latencyMs.p99 < Number(process.env.GRHM_LOAD_P99_MS ?? 2000), 'P99 exceeds load-test budget');
  assert.ok(report.rssBytes < 512 * 1024 * 1024, 'RSS exceeds 512 MiB');
  assert.ok(report.eventLoopMs.p99 < 500, 'Event-loop delay exceeds budget');
} finally {
  if (server && server.exitCode === null) {
    const exited = once(server, 'exit');
    server.kill('SIGTERM');
    const deadline = setTimeout(() => server.kill('SIGKILL'), 12_000);
    try { assert.deepEqual(await exited, [0, null]); } finally { clearTimeout(deadline); }
  }
  await fs.rm(directory, { recursive: true, force: true });
}
