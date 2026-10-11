import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const repository = path.resolve(import.meta.dirname, '..');
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'grhm-release-'));
const app = path.join(temporary, 'app');
const container = process.argv.includes('--container');
const identity = `grhm-smoke-${process.pid}-${Date.now()}`;
let child;
let logs = '';
let standalone = false;
function run(command, args, cwd = app) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', timeout: 600_000, maxBuffer: 10_000_000 });
  assert.equal(result.status, 0, `${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}\n${result.error ?? ''}`);
  return result.stdout.trim();
}
// The scaffolded app installs from an empty npm cache, as a new user would;
// on failure npm's debug log is printed, since an arborist crash says nothing
// useful on stderr.
const npmCache = path.join(temporary, 'npm-cache');
async function npmInApp(args) {
  try {
    return run('npm', [...args, '--cache', npmCache]);
  } catch (error) {
    const logDir = path.join(npmCache, '_logs');
    const names = await fs.readdir(logDir).catch(() => []);
    const newest = names.sort().at(-1);
    if (newest !== undefined) {
      const log = await fs.readFile(path.join(logDir, newest), 'utf8');
      // The assertion's stack was captured at creation, so print rather than append.
      console.error(`--- npm debug log ${newest} (tail) ---\n${log.split('\n').slice(-120).join('\n')}`);
    }
    throw error;
  }
}
async function stop() {
  if (container) { run('docker', ['stop', '--time', '15', identity]); return; }
  if (!child || child.exitCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  const timeout = setTimeout(() => child?.kill('SIGKILL'), 15_000);
  try { assert.deepEqual(await exited, [0, null], logs); } finally { clearTimeout(timeout); child = undefined; }
}
async function start(restart = false) {
  let base;
  if (container) {
    if (restart) run('docker', ['start', identity]);
    else run('docker', ['run', '--detach', '--name', identity, '--publish', '127.0.0.1::8787', '--volume', `${identity}:/data`, identity]);
    base = `http://${run('docker', ['port', identity, '8787/tcp'])}`;
  } else {
    logs = '';
    child = spawn(process.execPath, standalone ? ['--experimental-strip-types', 'grhm-start.mjs'] : ['node_modules/@ashxsf/grhm/dist/cli.js', 'start'], {
      cwd: app, env: { ...process.env, PORT: '0', HOST: '127.0.0.1', GRHM_QUIET: '1', GRHM_DB: path.join(app, 'test.db'), GRHM_UPLOADS: path.join(app, 'uploads') },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (chunk) => { logs += chunk; });
    child.stderr.on('data', (chunk) => { logs += chunk; });
    for (let i = 0; i < 200; i++) {
      const port = logs.match(/"kind":"server-started","port":(\d+)/)?.[1];
      if (port) { base = `http://127.0.0.1:${port}`; break; }
      assert.equal(child.exitCode, null, logs);
      await delay(50);
    }
  }
  assert.ok(base, `server did not start: ${logs}`);
  for (let i = 0; i < 200; i++) {
    try { if ((await fetch(`${base}/healthz`)).ok) return base; } catch { /* wait for startup */ }
    await delay(50);
  }
  throw new Error(`server did not become healthy: ${logs}`);
}
try {
  const packed = JSON.parse(run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', temporary], repository))[0];
  assert.equal(packed.name, '@ashxsf/grhm');
  assert.equal(packed.filename, `ashxsf-grhm-${packed.version}.tgz`);
  assert.ok(packed.files.some((file) => file.path === 'dist/cli.js'));
  assert.ok(!packed.files.some((file) => file.path.startsWith('node_modules/')));
  run(process.execPath, [path.join(repository, 'dist/cli.js'), 'new', app], temporary);
  await fs.copyFile(path.join(temporary, packed.filename), path.join(app, 'grhm.tgz'));
  const manifest = JSON.parse(await fs.readFile(path.join(app, 'package.json'), 'utf8'));
  manifest.devDependencies['@ashxsf/grhm'] = 'file:./grhm.tgz';
  await fs.writeFile(path.join(app, 'package.json'), JSON.stringify(manifest));
  await fs.writeFile(path.join(app, 'app.grhm'), `(app smoke
    (db (table notes (id auto) (label string)))
    (uploads)
    (api (get "/api/notes" (select notes))
      (post "/api/notes" (input (label string)) (insert notes :label body.label)))
    (page "/" home (heading "Release smoke")))`);
  await npmInApp(['install', '--no-audit', '--no-fund']);
  run(process.execPath, ['node_modules/@ashxsf/grhm/dist/cli.js', 'reference']);
  run('npm', ['run', 'build']);
  if (container) {
    console.log('Building scaffolded Docker image…');
    run('docker', ['build', '--tag', identity, '.']);
  }
  let base = await start();
  assert.equal((await fetch(base, { headers: { accept: 'text/html' } })).status, 200);
  assert.equal((await fetch(`${base}/api/missing`)).status, 404);
  const created = await fetch(`${base}/api/notes`, { method: 'POST', headers: { 'x-grhm': '1', 'content-type': 'application/json' }, body: JSON.stringify({ label: 'persisted' }) });
  assert.ok(created.ok, await created.text());
  const uploaded = await fetch(`${base}/api/uploads`, { method: 'POST', headers: { 'x-grhm': '1', 'x-filename': 'sample.txt' }, body: 'persistent upload' });
  assert.ok(uploaded.ok);
  const { url } = await uploaded.json();
  if (container) {
    assert.equal(run('docker', ['exec', identity, 'id', '-u']), '1000');
    run('docker', ['exec', identity, 'node', '-e', "const fs=require('node:fs'); if (fs.existsSync('node_modules/vite') || fs.existsSync('node_modules/@ashxsf/grhm')) process.exit(1)"]);
  }
  await stop();
  base = await start(true);
  assert.deepEqual(await (await fetch(`${base}/api/notes`)).json(), [{ id: 1, label: 'persisted' }]);
  assert.equal(await (await fetch(`${base}${url}`)).text(), 'persistent upload');
  await stop();
  if (!container) {
    await npmInApp(['prune', '--omit=dev', '--no-audit', '--no-fund']);
    await assert.rejects(fs.access(path.join(app, 'node_modules/vite')));
    await assert.rejects(fs.access(path.join(app, 'node_modules/@ashxsf/grhm')));
    standalone = true;
    base = await start();
    assert.deepEqual(await (await fetch(base + '/api/notes')).json(), [{ id: 1, label: 'persisted' }]);
    await stop();
    await fs.unlink(path.join(app, 'src/gen/server.ts'));
    base = await start();
    assert.equal((await fetch(base, { headers: { accept: 'text/html' } })).status, 200);
    assert.equal((await fetch(base + '/api/notes')).status, 404);
    assert.equal((await fetch(base + '/readyz')).status, 200);
    await stop();
  }
  console.log(`${container ? 'Container' : 'Package'} smoke passed: packed install, scaffold, strict build, HTTP, persistent database/uploads, graceful shutdown.`);
} finally {
  if (container) {
    for (const args of [['rm', '--force', identity], ['volume', 'rm', '--force', identity], ['image', 'rm', '--force', identity]]) spawnSync('docker', args, { stdio: 'ignore' });
  } else if (child && child.exitCode === null) {
    const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
  }
  await fs.rm(temporary, { recursive: true, force: true });
}
