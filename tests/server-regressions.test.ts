import { ChildProcess, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { compile } from '../src/codegen/index.js';

const sqliteAvailable = (() => {
  try {
    createRequire(import.meta.url)('node:sqlite');
    return true;
  } catch {
    return false;
  }
})();

interface PredicateRow {
  label: string | null;
  amount: number | null;
  flag: boolean | null;
  needle: string | null;
}

const predicateRows: PredicateRow[] = [
  { label: null, amount: null, flag: null, needle: null },
  { label: '', amount: 0, flag: false, needle: '' },
  { label: 'Hello_100%\\world', amount: 7, flag: true, needle: '_' },
  { label: 'hello-world', amount: -2, flag: false, needle: '%' },
  { label: 'Καλημέρα 😀 你好', amount: 1.5, flag: true, needle: '😀' },
  { label: 'null true false 7 1.5', amount: 7, flag: false, needle: null },
  { label: 'HELLO', amount: null, flag: null, needle: 'Hello' },
  { label: 'é e\u0301', amount: 1e-7, flag: true, needle: 'e\u0301' },
];

const predicateCases: { name: string; where: string; matches: (row: PredicateRow) => boolean }[] = [
  { name: 'null-eq', where: '(= label null)', matches: (r) => r.label === null },
  { name: 'null-ne', where: '(!= label null)', matches: (r) => r.label !== null },
  { name: 'number-eq', where: '(= amount 7)', matches: (r) => r.amount === 7 },
  { name: 'number-ne', where: '(!= amount 7)', matches: (r) => r.amount !== 7 },
  { name: 'zero-eq', where: '(= amount 0)', matches: (r) => r.amount === 0 },
  { name: 'text-eq', where: '(= label "hello-world")', matches: (r) => r.label === 'hello-world' },
  { name: 'true-eq', where: '(= flag true)', matches: (r) => r.flag === true },
  { name: 'false-eq', where: '(= flag false)', matches: (r) => r.flag === false },
  { name: 'bool-null', where: '(= flag null)', matches: (r) => r.flag === null },
  { name: 'constant-nulls', where: '(= null null)', matches: () => true },
  { name: 'column-text', where: '(= label needle)', matches: (r) => r.label === r.needle },
  { name: 'not-null-eq', where: '(not (= label null))', matches: (r) => r.label !== null },
  { name: 'nested-logic', where: '(and (or (= flag null) (= amount 7)) (not (= label "")))', matches: (r) => (r.flag === null || r.amount === 7) && r.label !== '' },
  { name: 'column-contains', where: '(contains label needle)', matches: (r) => r.label?.includes(String(r.needle)) ?? false },
  { name: 'number-contains', where: '(contains label amount)', matches: (r) => r.label?.includes(String(r.amount)) ?? false },
  { name: 'bool-contains', where: '(contains label flag)', matches: (r) => r.label?.includes(String(r.flag)) ?? false },
  { name: 'predicate-contains', where: '(contains label (= flag true))', matches: (r) => r.label?.includes(String(r.flag === true)) ?? false },
  { name: 'not-contains', where: '(not (contains label "Hello"))', matches: (r) => !(r.label?.includes('Hello') ?? false) },
  { name: 'nested-contains', where: '(or (contains label "%") (and (= label null) (!= flag false)))', matches: (r) => (r.label?.includes('%') ?? false) || (r.label === null && r.flag !== false) },
  // Relational comparisons keep SQL's null/unknown semantics: neither this
  // predicate nor its negation includes rows whose amount is null.
  { name: 'nullable-order', where: '(not (> amount 0))', matches: (r) => r.amount !== null && !(r.amount > 0) },
];

describe.skipIf(!sqliteAvailable)('generated server regressions (live)', () => {
  let dir: string;
  let child: ChildProcess | undefined;
  let base: string;
  let serverErrors = '';
  const mutate = { 'Content-Type': 'application/json', 'x-grhm': '1' };

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grhm-server-regressions-'));
    const result = compile(`(app regressions
      (use "node:fs/promises" (import read-file readFile))
      (use "node:path" (import fs basename))
      (fn db-select (x) x)
      (fn start-server (x) x)
      (db (table predicate-rows (id auto) (label string :optional true) (amount number :optional true) (flag boolean :optional true) (needle string :optional true))
        (table items
        (id auto)
        (flag boolean :optional true)
        (label string :optional true :default "untitled")
        (quantity number :optional true :default 7)
        (active boolean :optional true :default true)))
      (api
        (get "/api/names" (obj :one (db-select 1) :two (start-server 2)))
        (get "/api/import-name" (fs "/a/b.txt"))
        (get "/api/items" (select items :order id))
        (post "/api/items" (insert items))
        (post "/api/items/flag" (insert items :flag body.flag))
        (post "/api/items/nulls" (insert items :label body.label :quantity body.quantity :active body.active))
        (post "/api/predicate-rows" (insert predicate-rows :label body.label :amount body.amount :flag body.flag :needle body.needle))
        ${predicateCases.map((test) => `(get "/api/predicate/${test.name}" (select predicate-rows :where ${test.where} :order id))`).join('\n')}
        (post "/api/filter/text" (select predicate-rows :where (= label body.value) :order id))
        (post "/api/filter/number" (select predicate-rows :where (= amount body.value) :order id))
        (post "/api/filter/boolean" (select predicate-rows :where (= flag body.value) :order id))
        (post "/api/filter/contains" (select predicate-rows :where (contains label body.value) :order id))
        (get "/api/filter/id/{id}" (select predicate-rows :where (= id id) :order id))
        (get "/api/filter/contains/{label}" (select predicate-rows :where (contains label label) :order id))
        (get "/api/unexpected-error" (read-file "/not-a-real-private-config.json"))
        (post "/api/sql-error" (select items :limit body.limit))
        (get "/api/expected-error" (fail 409 "chosen message")))
      (uploads)
      (page "/" home (txt "ok")))`);
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    for (const [name, contents] of result.files) {
      const target = path.join(dir, name);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, contents);
    }
    fs.mkdirSync(path.join(dir, 'dist'));
    fs.writeFileSync(path.join(dir, 'dist', 'index.html'), '<!doctype html><title>Application shell</title>');
    const features = process.features as { typescript?: unknown };
    const nodeArgs = features.typescript !== undefined && features.typescript !== false ? [] : ['--experimental-strip-types'];
    child = spawn(process.execPath, [...nodeArgs, path.join(dir, 'server.ts')], {
      cwd: dir,
      env: { ...process.env, GRHM_DB: ':memory:', GRHM_UPLOADS: path.join(dir, 'uploads'), HOST: '127.0.0.1', PORT: '0', GRHM_QUIET: '1' },
    });
    const server = child;
    base = await new Promise<string>((resolve, reject) => {
      let output = '';
      let errors = '';
      const timeout = setTimeout(() => reject(new Error(`server startup timed out: ${errors}`)), 15_000);
      server.stderr?.on('data', (chunk: Buffer) => { errors += chunk.toString(); serverErrors += chunk.toString(); });
      server.once('error', (error) => { clearTimeout(timeout); reject(error); });
      server.once('exit', (code) => { clearTimeout(timeout); reject(new Error(`server exited with ${code}: ${errors}`)); });
      server.stdout?.on('data', (chunk: Buffer) => {
        output += chunk.toString();
        const lines = output.split('\n');
        output = lines.pop() ?? '';
        for (const line of lines) {
          const event = JSON.parse(line) as { kind?: string; port?: number };
          if (event.kind === 'server-started') {
            clearTimeout(timeout);
            resolve(`http://127.0.0.1:${event.port}`);
          }
        }
      });
    });
    for (const row of predicateRows) {
      const response = await fetch(`${base}/api/predicate-rows`, { method: 'POST', headers: mutate, body: JSON.stringify(row) });
      expect(response.status).toBe(200);
    }
  });

  it.each([
    ['GRHM_RATE_LIMIT', 'not-a-number'], ['GRHM_RATE_LIMIT', '-1'],
    ['GRHM_RATE_LIMIT', '0.5'], ['GRHM_SESSION_DAYS', 'Infinity'], ['GRHM_SESSION_DAYS', '0'],
  ])('rejects invalid server configuration %s=%s', (setting, value) => {
    const features = process.features as { typescript?: unknown };
    const nodeArgs = features.typescript !== undefined && features.typescript !== false ? [] : ['--experimental-strip-types'];
    const run = spawnSync(process.execPath, [...nodeArgs, path.join(dir, 'server.ts')], {
      cwd: dir, encoding: 'utf8', timeout: 5000,
      env: { ...process.env, GRHM_DB: ':memory:', PORT: '0', [setting]: value },
    });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain('Invalid server configuration: ' + setting);
  });

  afterAll(async () => {
    if (child !== undefined && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>((resolve) => child?.once('exit', () => resolve()));
      child.kill();
      await exited;
    }
    if (dir !== undefined) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('preserves null, false, and true in optional boolean columns', async () => {
    for (const flag of [null, false, true]) {
      const response = await fetch(`${base}/api/items/flag`, { method: 'POST', headers: mutate, body: JSON.stringify({ flag }) });
      expect(response.status).toBe(200);
      const inserted = await response.json() as { id: number; flag: unknown };
      expect(inserted.flag).toBe(flag);
      const selected = await (await fetch(`${base}/api/items`)).json() as { id: number; flag: unknown }[];
      expect(selected.find((row) => row.id === inserted.id)?.flag).toBe(flag);
    }
  });

  it('isolates user function and interop names from server internals', async () => {
    expect(await (await fetch(`${base}/api/names`)).json()).toEqual({ one: 1, two: 2 });
    expect(await (await fetch(`${base}/api/import-name`)).json()).toBe('b.txt');
  });

  it('returns API/asset errors separately from HTML navigation fallback', async () => {
    for (const route of ['/api/missing', '/api', '/missing.js', '/uploads/missing.png']) {
      const response = await fetch(base + route, { headers: { Accept: 'text/html' } });
      expect(response.status, route).toBe(404);
      expect(await response.json()).toEqual({ error: 'not found' });
    }
    const method = await fetch(`${base}/api/names`, { method: 'POST', headers: mutate });
    expect(method.status).toBe(405);
    expect(method.headers.get('allow')).toBe('GET');
    const navigation = await fetch(`${base}/client-route`, { headers: { Accept: 'text/html' } });
    expect(navigation.status).toBe(200);
    expect(await navigation.text()).toContain('Application shell');
    expect((await fetch(`${base}/client-route`, { headers: { Accept: 'application/json' } })).status).toBe(404);
  });

  it('applies explicit defaults on nullable columns while preserving explicit nulls', async () => {
    const response = await fetch(`${base}/api/items`, { method: 'POST', headers: mutate });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ flag: null, label: 'untitled', quantity: 7, active: true });

    const nulls = await fetch(`${base}/api/items/nulls`, {
      method: 'POST', headers: mutate, body: JSON.stringify({ label: null, quantity: null, active: null }),
    });
    expect(nulls.status).toBe(200);
    expect(await nulls.json()).toMatchObject({ label: null, quantity: null, active: null });
  });

  it('returns an upload storage error without terminating the server', async () => {
    const uploads = path.join(dir, 'uploads');
    const previous = uploads + '-previous';
    if (fs.existsSync(uploads)) fs.renameSync(uploads, previous);
    fs.writeFileSync(uploads, 'a file blocks the upload directory');
    try {
      const response = await fetch(`${base}/api/uploads`, {
        method: 'POST', headers: { 'x-grhm': '1', 'x-filename': 'photo.png' }, body: 'image bytes',
      });
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: 'internal error' });
      expect((await fetch(`${base}/healthz`)).status).toBe(200);
      expect((await fetch(`${base}/readyz`)).status).toBe(503);
    } finally {
      fs.rmSync(uploads, { force: true });
      if (fs.existsSync(previous)) fs.renameSync(previous, uploads);
    }
    const recovered = await fetch(`${base}/api/uploads`, {
      method: 'POST', headers: { 'x-grhm': '1', 'x-filename': 'photo.png' }, body: 'image bytes',
    });
    expect(recovered.status).toBe(200);
    const uploaded = await recovered.json() as { url: string };
    expect(await (await fetch(base + uploaded.url)).text()).toBe('image bytes');
  });

  it.each(predicateCases)('evaluates SQL predicate $name with defined null semantics', async ({ name, matches }) => {
    const response = await fetch(`${base}/api/predicate/${name}`);
    expect(response.status).toBe(200);
    const actual = await response.json() as (PredicateRow & { id: number })[];
    expect(actual.map(({ id, ...row }) => row)).toEqual(predicateRows.filter(matches));
  });

  it('uses schema affinity for route IDs and null-safe equality for typed request values', async () => {
    for (const [kind, field, values] of [
      ['text', 'label', [null, '', 'hello-world', "' OR 1=1 --"]],
      ['number', 'amount', [null, 0, 7, -2, 1.5]],
      ['boolean', 'flag', [null, false, true]],
    ] as const) {
      for (const value of values) {
        const response = await fetch(`${base}/api/filter/${kind}`, { method: 'POST', headers: mutate, body: JSON.stringify({ value }) });
        expect(response.status).toBe(200);
        const actual = await response.json() as (PredicateRow & { id: number })[];
        expect(actual.map(({ id, ...row }) => row)).toEqual(predicateRows.filter((r) => r[field] === value));
      }
    }
    const byId = await (await fetch(`${base}/api/filter/id/3`)).json() as (PredicateRow & { id: number })[];
    expect(byId).toEqual([{ id: 3, ...predicateRows[2] }]);
  });

  it.each(['%', '_', '\\', 'Hello', 'hello', 'HELLO', '😀', '你好', 'é', 'e\u0301', "%' OR 1=1 --", '', null, true, false, 7, 1.5])(
    'matches contains needle %j literally and case-sensitively through HTTP', async (value) => {
      const response = await fetch(`${base}/api/filter/contains`, { method: 'POST', headers: mutate, body: JSON.stringify({ value }) });
      expect(response.status).toBe(200);
      const actual = await response.json() as (PredicateRow & { id: number })[];
      const expected = predicateRows.filter((r) => r.label?.includes(String(value)) ?? false);
      expect(actual.map(({ id, ...row }) => row)).toEqual(expected);
      if (typeof value === 'string' && value !== '') {
        const route = await fetch(`${base}/api/filter/contains/${encodeURIComponent(value)}`);
        expect(route.status).toBe(200);
        const fromRoute = await route.json() as (PredicateRow & { id: number })[];
        expect(fromRoute.map(({ id, ...row }) => row)).toEqual(expected);
      }
    },
  );

  it('keeps unexpected sync/async error details in structured logs and preserves intended API failures', async () => {
    const asyncError = await fetch(`${base}/api/unexpected-error`);
    expect(asyncError.status).toBe(500);
    expect(await asyncError.json()).toEqual({ error: 'internal error' });
    const sqlError = await fetch(`${base}/api/sql-error`, { method: 'POST', headers: mutate, body: JSON.stringify({ limit: 'invalid' }) });
    expect(sqlError.status).toBe(400);
    expect(await sqlError.json()).toEqual({ error: 'select limit must be between 0 and 1000' });
    await expect.poll(() => serverErrors).toContain('/not-a-real-private-config.json');
    const logs = serverErrors.split('\n').filter((line) => line.startsWith('{')).map((line) => JSON.parse(line) as { schema: number; kind: string; path: string; message: string });
    expect(logs).toEqual(expect.arrayContaining([
      expect.objectContaining({ schema: 1, kind: 'request-error', path: '/api/unexpected-error', message: expect.stringContaining('/not-a-real-private-config.json') }),
    ]));
    const expectedError = await fetch(`${base}/api/expected-error`);
    expect(expectedError.status).toBe(409);
    expect(await expectedError.json()).toEqual({ error: 'chosen message' });
  });
});
