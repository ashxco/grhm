import { ChildProcess, execFileSync, execSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { SExpr, opName, walkLists } from '../src/ast.js';
import { compile } from '../src/codegen/index.js';
import { parse } from '../src/parser.js';
import { MAX_PROTOCOL_BYTES } from '../src/limits.js';
import { findReferences, resolveSymbolAt } from '../src/references.js';
import { DEFAULT_APP_GRHM, VITE_CONFIG } from '../src/scaffold.js';
import { handleRequest } from '../src/server.js';
import { GrhmProject } from '../src/sdk.js';
import { genPlaywrightSpec, genVitestSpec, playwrightConfig } from '../src/testgen.js';

/**
 * End-to-end tests for the tooling surfaces: the SDK/server protocol, the
 * built CLI (including `grhm dev` recompile-on-change), and the LSP.
 */

const ROOT = path.join(__dirname, '..');
const CLI = path.join(ROOT, 'dist', 'cli.js');

let projectDir: string;

beforeAll(() => {
  execFileSync('npm', ['run', 'build'], { cwd: ROOT, stdio: 'pipe' });
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'grhm-tooling-'));
  execSync(`node ${JSON.stringify(CLI)} new ${JSON.stringify(projectDir)}`, { stdio: 'pipe' });
}, 60_000);

afterAll(() => {
  if (projectDir !== undefined) fs.rmSync(projectDir, { recursive: true, force: true });
});

/** Accumulates a child's stdout from the moment of spawn, then supports waiting. */
class OutputCollector {
  private buffer = '';
  /** Offset already consumed by previous waits, so each wait sees fresh output. */
  private consumed = 0;

  constructor(child: ChildProcess) {
    child.stdout?.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString('utf8');
    });
  }

  wait(predicate: (line: string) => boolean, timeoutMs = 15_000): Promise<string> {
    return new Promise((resolve, reject) => {
      const started = Date.now();
      const poll = (): void => {
        const fresh = this.buffer.slice(this.consumed);
        for (const line of fresh.split('\n')) {
          if (predicate(line)) {
            this.consumed = this.buffer.length;
            resolve(line);
            return;
          }
        }
        if (Date.now() - started > timeoutMs) {
          reject(new Error(`timed out waiting for output; got:\n${this.buffer}`));
          return;
        }
        setTimeout(poll, 25);
      };
      poll();
    });
  }
}

describe('SDK and server protocol', () => {
  it('answers check, inspect, and patch requests', () => {
    const project = GrhmProject.fromCwd(projectDir);

    const version = handleRequest(project, 'version', {}) as { name: string; version: string; schema: number };
    expect(version.name).toBe('grhm');
    expect(version.version).toBe('0.2.0');

    const check = handleRequest(project, 'check', {}) as { ok: boolean; revision: string };
    expect(check.ok).toBe(true);
    expect(check.revision).toMatch(/^[0-9a-f]+$/);

    const ast = project.load();
    let anyNode = '';
    const visit = (e: (typeof ast.mergedNodes)[number]): void => {
      if (e.kind !== 'list') return;
      const head = e.items[0];
      if (head?.kind === 'ident' && head.name === 'heading') anyNode = e.id;
      for (const item of e.items) visit(item);
    };
    for (const n of ast.mergedNodes) visit(n);
    expect(anyNode).not.toBe('');

    const inspect = handleRequest(project, 'inspect', { node: anyNode }) as { ok: boolean; text: string };
    expect(inspect.ok).toBe(true);
    expect(inspect.text).toContain('heading');

    const patch = handleRequest(project, 'patch', {
      patch: `(patch :revision "${check.revision}" :target ${anyNode} (set color "#ff0000"))`,
      preview: true,
    }) as { ok: boolean; newSources?: Record<string, string> };
    expect(patch.ok).toBe(true);
    expect(Object.values(patch.newSources ?? {}).join()).toContain(':color "#ff0000"');

    const reference = handleRequest(project, 'reference', {}) as { text: string; tokenEstimate: number };
    expect(reference.text).toContain('GRHM language reference');
    expect(reference.tokenEstimate).toBeGreaterThan(0);
  });

  it('serves the JSON-lines protocol over stdio', async () => {
    const child = spawn('node', [CLI, 'serve'], { cwd: projectDir });
    const output = new OutputCollector(child);
    try {
      await output.wait((l) => l.includes('"ready":true'));
      child.stdin.write('null\n');
      const invalid = await output.wait((l) => l.includes('invalid request envelope'));
      expect((JSON.parse(invalid) as { id: null }).id).toBeNull();
      child.stdin.write('x'.repeat(MAX_PROTOCOL_BYTES + 1) + '\n');
      await output.wait((l) => l.includes('request exceeds protocol byte budget'));
      child.stdin.write(JSON.stringify({ id: 1, method: 'check' }) + '\n');
      const response = await output.wait((l) => l.includes('"id":1'));
      const parsed = JSON.parse(response) as { id: number; result: { ok: boolean } };
      expect(parsed.result.ok).toBe(true);
    } finally {
      child.kill();
    }
  }, 20_000);
});

describe('SDK artifact and patch safety', () => {
  it('rejects exact-parent outDirs, including normalized and symlinked parents', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grhm-containment-'));
    const root = path.join(dir, 'project');
    fs.mkdirSync(root);
    try {
      for (const outDir of ['..', 'src/../..']) {
        expect(() => new GrhmProject({ root, entry: 'app.grhm', outDir })).toThrow('inside the project root');
      }
      fs.symlinkSync(dir, path.join(root, 'parent'));
      expect(() => new GrhmProject({ root, entry: 'app.grhm', outDir: 'parent' })).toThrow('outside the project root');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  it('removes obsolete generated artifacts while preserving user files', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grhm-artifacts-'));
    try {
      const entry = path.join(dir, 'app.grhm');
      fs.writeFileSync(
        entry,
        '(app a (db (table rows (id auto))) (api (get "/api/rows" (select rows))) (page "/" old-page (txt "old")))',
      );
      const project = new GrhmProject({ root: dir, entry: 'app.grhm', outDir: 'gen' });
      project.writeArtifacts(project.compile().files);
      expect(fs.existsSync(path.join(dir, 'gen', 'server.ts'))).toBe(true);
      expect(fs.existsSync(path.join(dir, 'gen', 'pages', 'old-page.tsx'))).toBe(true);

      const userFile = path.join(dir, 'gen', 'keep.ts');
      fs.writeFileSync(userFile, 'export const keep = true;\n');
      const manifestPath = path.join(dir, 'gen', '.grhm-artifacts.json');
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as { schema: number; files: string[] };
      manifest.files.push('keep.ts'); // A corrupt manifest must not authorize deletion of user content.
      fs.writeFileSync(manifestPath, JSON.stringify(manifest));

      fs.writeFileSync(entry, '(app a (page "/" new-page (txt "frontend only")))');
      const second = project.compile();
      expect(second.files.has('server.ts')).toBe(false);
      project.writeArtifacts(second.files);

      expect(fs.existsSync(path.join(dir, 'gen', 'server.ts'))).toBe(false);
      expect(fs.existsSync(path.join(dir, 'gen', 'pages', 'old-page.tsx'))).toBe(false);
      expect(fs.existsSync(path.join(dir, 'gen', 'pages', 'new-page.tsx'))).toBe(true);
      expect(fs.readFileSync(userFile, 'utf8')).toContain('keep = true');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects a patch that introduces a missing interop module before writing', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grhm-patch-interop-'));
    try {
      fs.mkdirSync(path.join(dir, 'lib'));
      fs.writeFileSync(path.join(dir, 'lib', 'ok.ts'), 'export const helper = (): number => 1;\n');
      const entry = path.join(dir, 'app.grhm');
      const original = '(app a (use "./lib/ok.ts" (import helper)) (page "/" home (txt "x")))';
      fs.writeFileSync(entry, original);
      const project = new GrhmProject({ root: dir, entry: 'app.grhm', outDir: 'gen' });
      let useId = '';
      walkLists(project.load().mergedNodes, (node) => {
        if (opName(node) === 'use') useId = node.id;
      });
      const patched = project.applyPatch(`(patch :target ${useId} (replace (use "./lib/missing.ts" (import helper))))`);
      expect(patched.ok).toBe(false);
      expect(patched.diagnostics.map((d) => d.code)).toContain('E602');
      expect(fs.readFileSync(entry, 'utf8')).toBe(original);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('stages every cross-file patch before replacing any source file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grhm-patch-atomic-'));
    const locked = path.join(dir, 'locked');
    fs.mkdirSync(locked);
    const app = '(app a (include "locked/part.grhm") (page "/two" two (v :id "dest")))';
    const part = '(page "/" home (txt "x" :id "source"))';
    fs.writeFileSync(path.join(dir, 'app.grhm'), app);
    fs.writeFileSync(path.join(locked, 'part.grhm'), part);
    const project = new GrhmProject({ root: dir, entry: 'app.grhm', outDir: 'gen' });
    const patch = '(patch :target source (move :into dest))';
    try {
      const preview = project.applyPatch(patch, false);
      expect(preview.ok).toBe(true);
      expect(preview.newSources?.size).toBe(2);

      fs.chmodSync(locked, 0o555);
      expect(() => project.applyPatch(patch, true)).toThrow();
      expect(fs.readFileSync(path.join(dir, 'app.grhm'), 'utf8')).toBe(app);
      expect(fs.readFileSync(path.join(locked, 'part.grhm'), 'utf8')).toBe(part);
    } finally {
      fs.chmodSync(locked, 0o755);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rechecks output containment when a path is replaced by a symlink', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grhm-output-root-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'grhm-output-outside-'));
    try {
      fs.writeFileSync(path.join(dir, 'app.grhm'), '(app a (page "/" home (txt "x")))');
      const project = new GrhmProject({ root: dir, entry: 'app.grhm', outDir: 'gen' });
      fs.symlinkSync(outside, path.join(dir, 'gen'), 'dir');
      expect(() => project.writeArtifacts(project.compile().files)).toThrow(/outside the project root/);
      expect(fs.readdirSync(outside)).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe('scope-aware symbol indexing', () => {
  it('keeps table/resource namespaces separate and respects lexical shadowing', () => {
    const source = `(app a
  (state id 0)
  (data (resource rows "/api/rows" :default (arr)))
  (db (table rows (id auto)))
  (api (get "/api/rows/{id}" (select rows :where (= id id))))
  (page "/{id}" home
    (txt id)
    (each id (arr 1) :key id (txt id))
    (txt rows.data)))`;
    const roots = parse(source, 'app.grhm').nodes;
    const state = resolveSymbolAt(roots, source.indexOf('state id') + 6, 'app.grhm');
    expect(state?.kind).toBe('state');
    expect(findReferences(roots, state!)).toHaveLength(1); // Route params shadow the global state.

    const loop = resolveSymbolAt(roots, source.indexOf('each id') + 5, 'app.grhm');
    expect(loop?.kind).toBe('each');
    expect(findReferences(roots, loop!)).toHaveLength(3); // Declaration + :key + body.

    const resource = resolveSymbolAt(roots, source.indexOf('resource rows') + 9, 'app.grhm');
    expect(resource?.kind).toBe('resource');
    const resourceRefs = findReferences(roots, resource!);
    expect(resourceRefs).toHaveLength(2); // Declaration + rows.data, never table/select positions.
    expect(resourceRefs.map((span) => source.slice(span.start, span.end))).toEqual(['rows', 'rows']);
  });

  it('resolves component definitions and uses across files', () => {
    const entry = '(app a (include "component.grhm") (page "/" home (chip)))';
    const component = '(component chip (txt "Chip"))';
    const roots: SExpr[] = [...parse(entry, 'app.grhm').nodes, ...parse(component, 'component.grhm').nodes];
    const info = resolveSymbolAt(roots, entry.indexOf('(chip)') + 2, 'app.grhm');
    expect(info?.kind).toBe('component');
    expect(info?.declSpan.file).toBe('component.grhm');
    expect(findReferences(roots, info!)).toHaveLength(2);
  });

  it('resolves local initializers sequentially, then exposes every local to the body', () => {
    const source = `(app a
  (state later 0)
  (page "/" home
    (local first later)
    (local later 1)
    (txt first)
    (txt later)))`;
    const roots = parse(source, 'app.grhm').nodes;
    const globalLater = resolveSymbolAt(roots, source.indexOf('state later') + 6, 'app.grhm');
    expect(findReferences(roots, globalLater!)).toHaveLength(2); // Declaration + first initializer.

    const localLater = resolveSymbolAt(roots, source.indexOf('local later') + 6, 'app.grhm');
    expect(localLater?.kind).toBe('local');
    expect(findReferences(roots, localLater!)).toHaveLength(2); // Declaration + rendered body.
  });
});

describe('generated test configuration', () => {
  const source = `(app a
    (db (table rows (id auto)))
    (api (get "/api/rows" (select rows)))
    (state email "")
    (page "/" home (input :value email :placeholder "Email")))
  (tests (test "input" (visit "/") (fill "Email" "a@b") (expect-value "Email" "a@b")))`;

  it('uses input placeholders consistently and resets the browser database', () => {
    const app = compile(source).app!;
    const spec = genPlaywrightSpec(app) ?? '';
    expect(spec).toContain('getByPlaceholder("Email", { exact: true }).fill("a@b")');
    expect(spec).toContain("headers: { 'x-grhm': '1' }");
    expect(spec).toContain("'/__grhm/reset'");
  });

  it('honors a custom outDir for Vitest and Playwright', () => {
    const app = compile(source).app!;
    const unit = genVitestSpec(app, 'custom/gen') ?? '';
    expect(unit).toContain('path.resolve(process.cwd(), "custom/gen", \'server.ts\')');
    expect(unit).toContain("headers: { 'x-grhm': '1' }");
    expect(unit).toContain('if (!reset.ok)');

    const config = playwrightConfig(true, 'custom/gen');
    expect(config).toContain('testDir: "custom/gen/tests"');
    expect(config).toContain('node \\"custom/gen/server.ts\\"');
    expect(VITE_CONFIG).toContain("fs.readFileSync('./grhm.json'");
    expect(VITE_CONFIG).toContain("alias: { '@grhm': path.resolve(generatedDir) }");
    expect(VITE_CONFIG).toContain("server: { proxy: { '/api':");
  });
});

describe('CLI scaffold and test flags', () => {
  it('pins the current compiler and serves a frontend-only scaffold without Vite', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grhm-static-start-'));
    try {
      execSync(`node ${JSON.stringify(CLI)} new ${JSON.stringify(dir)}`, { stdio: 'pipe' });
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as { devDependencies: { grhm: string } };
      expect(pkg.devDependencies.grhm).toBe('^0.2.0');
      expect(compile(DEFAULT_APP_GRHM).files.has('server.ts')).toBe(false);
      fs.mkdirSync(path.join(dir, 'dist'));
      fs.writeFileSync(path.join(dir, 'dist', 'index.html'), '<!doctype html>');
      const run = spawn('node', [CLI, 'start'], { cwd: dir, env: { ...process.env, HOST: '127.0.0.1', PORT: '0' } });
      const output = new OutputCollector(run);
      try {
        const event = JSON.parse(await output.wait((line) => line.includes('"server-started"'))) as { port: number };
        const base = `http://127.0.0.1:${event.port}`;
        const response = await fetch(base, { headers: { accept: 'text/html' } });
        expect(await response.text()).toBe('<!doctype html>');
        expect(response.headers.get('x-content-type-options')).toBe('nosniff');
        expect(response.headers.get('cache-control')).toBe('no-cache');
        expect((await fetch(base + '/api/missing')).status).toBe(404);
        const closed = new Promise<number | null>((resolve) => run.once('exit', resolve));
        run.kill('SIGTERM');
        expect(await closed).toBe(0);
      } finally { if (run.exitCode === null) run.kill('SIGKILL'); }

    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('builds a fresh scaffold after changing to a custom outDir', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grhm-custom-outdir-'));
    try {
      execSync(`node ${JSON.stringify(CLI)} new ${JSON.stringify(dir)}`, { stdio: 'pipe' });
      fs.writeFileSync(path.join(dir, 'grhm.json'), JSON.stringify({ entry: 'app.grhm', outDir: 'src/custom-gen' }));
      fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(dir, 'node_modules'), 'dir');
      const run = spawnSync('node', [CLI, 'build', '--json'], { cwd: dir, encoding: 'utf8' });
      expect(run.status, run.stdout + run.stderr).toBe(0);
      expect(JSON.parse(run.stdout)).toMatchObject({ ok: true, bundled: true });
      expect(fs.existsSync(path.join(dir, 'dist', 'index.html'))).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it('rejects contradictory test selection flags with one JSON result', () => {
    const run = spawnSync('node', [CLI, 'test', '--json', '--unit', '--e2e'], { cwd: projectDir, encoding: 'utf8' });
    expect(run.status).toBe(2);
    const output = JSON.parse(run.stdout) as { ok: boolean; error: string };
    expect(output.ok).toBe(false);
    expect(output.error).toContain('mutually exclusive');
  });

  it('fails missing test runners and emits only the final JSON result', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grhm-test-json-'));
    try {
      fs.writeFileSync(
        path.join(dir, 'app.grhm'),
        '(app a (page "/" home (txt "hello"))) (tests (test "smoke" (visit "/") (expect-text "hello")))',
      );
      fs.writeFileSync(path.join(dir, 'grhm.json'), JSON.stringify({ entry: 'app.grhm', outDir: 'gen' }));
      const run = spawnSync('node', [CLI, 'test', '--json', '--unit'], { cwd: dir, encoding: 'utf8' });
      expect(run.status).toBe(1);
      const output = JSON.parse(run.stdout) as { schema: number; ok: boolean; results: unknown[] };
      expect(output).toMatchObject({ schema: 1, ok: false });
      expect(output.results).toEqual([expect.objectContaining({ runner: 'vitest', ok: false, ran: false })]);
      expect(run.stdout).not.toContain('compiled ');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('emits one final JSON document when Vite bundling fails', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grhm-build-json-'));
    try {
      fs.writeFileSync(path.join(dir, 'app.grhm'), '(app a (page "/" home (txt "hello")))');
      fs.writeFileSync(path.join(dir, 'grhm.json'), JSON.stringify({ entry: 'app.grhm', outDir: 'gen' }));
      const binDir = path.join(dir, 'node_modules', '.bin');
      fs.mkdirSync(binDir, { recursive: true });
      const vite = path.join(binDir, 'vite');
      fs.writeFileSync(vite, '#!/usr/bin/env node\nprocess.stderr.write("bundle failed\\n"); process.exit(7);\n');
      fs.chmodSync(vite, 0o755);
      const tsc = path.join(binDir, 'tsc');
      fs.writeFileSync(tsc, '#!/usr/bin/env node\nprocess.exit(0);\n');
      fs.chmodSync(tsc, 0o755);
      const run = spawnSync('node', [CLI, 'build', '--json'], { cwd: dir, encoding: 'utf8' });
      expect(run.status).toBe(2);
      const output = JSON.parse(run.stdout) as { ok: boolean; step: string; output: string };
      expect(output).toMatchObject({ ok: false, step: 'vite-build' });
      expect(output.output).toContain('bundle failed');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects invalid interop in a real build, including an excluded custom backend outDir', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grhm-typecheck-build-'));
    try {
      execSync(`node ${JSON.stringify(CLI)} new ${JSON.stringify(dir)}`, { stdio: 'pipe' });
      fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(dir, 'node_modules'), 'dir');
      fs.writeFileSync(path.join(dir, 'grhm.json'), JSON.stringify({ entry: 'app.grhm', outDir: 'backend-generated' }));
      fs.writeFileSync(path.join(dir, 'src', 'numeric.ts'), 'export function numeric(value: number): string { return value.toFixed(2); }');
      fs.writeFileSync(path.join(dir, 'app.grhm'), '(app a (use "./src/numeric.ts" (import numeric)) (api (get "/api/value" (numeric "bad"))) (page "/" home (txt "Build")))');
      const run = spawnSync(process.execPath, [CLI, 'build', '--json'], { cwd: dir, encoding: 'utf8' });
      expect(run.status).toBe(2);
      expect(JSON.parse(run.stdout)).toMatchObject({ ok: false, step: 'typecheck', bundled: false });
      expect(JSON.parse(run.stdout).output).toContain('not assignable to parameter of type');
      expect(fs.existsSync(path.join(dir, 'dist'))).toBe(false);
      expect(fs.readdirSync(dir).some((file) => file.startsWith('tsconfig.grhm-'))).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('honors --json for codes and version', () => {
    const codes = spawnSync('node', [CLI, 'codes', '--json'], { cwd: projectDir, encoding: 'utf8' });
    expect(codes.status).toBe(0);
    const codesResult = JSON.parse(codes.stdout) as { schema: number; ok: boolean; codes: Record<string, string> };
    expect(codesResult).toMatchObject({ schema: 1, ok: true });
    expect(codesResult.codes['E001']).toContain('Lexical');

    const version = spawnSync('node', [CLI, 'version', '--json'], { cwd: projectDir, encoding: 'utf8' });
    expect(version.status).toBe(0);
    expect(JSON.parse(version.stdout)).toEqual({ schema: 1, ok: true, name: 'grhm', version: '0.2.0' });
  });
});

describe('grhm dev', () => {
  it('recompiles when the source changes', async () => {
    const devDir = fs.mkdtempSync(path.join(os.tmpdir(), 'grhm-dev-'));
    execSync(`node ${JSON.stringify(CLI)} new ${JSON.stringify(devDir)}`, { stdio: 'pipe' });
    const child = spawn('node', [CLI, 'dev'], { cwd: devDir });
    const output = new OutputCollector(child);
    try {
      await output.wait((l) => l.includes('compiled'));
      const entry = path.join(devDir, 'app.grhm');
      fs.writeFileSync(entry, fs.readFileSync(entry, 'utf8').replace('Hello', 'Howdy'));
      await output.wait((l) => l.includes('compiled'));
      const gen = fs.readdirSync(path.join(devDir, 'src', 'gen'));
      expect(gen).toContain('App.tsx');
    } finally {
      child.kill();
      fs.rmSync(devDir, { recursive: true, force: true });
    }
  }, 30_000);
});

describe('LSP', () => {
  function frame(message: Record<string, unknown>): string {
    const body = JSON.stringify({ jsonrpc: '2.0', ...message });
    return `Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`;
  }

  /** Content-Length is a byte count, so frames must be parsed on bytes. */
  function messages(raw: Buffer): Record<string, unknown>[] {
    const out: Record<string, unknown>[] = [];
    let rest = raw;
    for (;;) {
      const headerEnd = rest.indexOf('\r\n\r\n');
      if (headerEnd === -1) break;
      const match = /Content-Length: (\d+)/i.exec(rest.slice(0, headerEnd).toString('utf8'));
      if (match === null) break;
      const length = Number(match[1]);
      if (rest.length < headerEnd + 4 + length) break;
      const body = rest.slice(headerEnd + 4, headerEnd + 4 + length).toString('utf8');
      out.push(JSON.parse(body) as Record<string, unknown>);
      rest = rest.slice(headerEnd + 4 + length);
    }
    return out;
  }

  it('initializes, publishes diagnostics, and answers hover', async () => {
    const child = spawn('node', [CLI, 'lsp'], { cwd: projectDir });
    let raw = Buffer.alloc(0);
    child.stdout.on('data', (chunk: Buffer) => {
      raw = Buffer.concat([raw, chunk]);
    });
    const waitFor = (
      predicate: (m: Record<string, unknown>) => boolean,
      timeoutMs = 10_000,
      after = 0,
    ): Promise<Record<string, unknown>> =>
      new Promise((resolve, reject) => {
        const started = Date.now();
        const poll = (): void => {
          const found = messages(raw).slice(after).find(predicate);
          if (found !== undefined) {
            resolve(found);
            return;
          }
          if (Date.now() - started > timeoutMs) {
            reject(new Error(`LSP timeout; raw:\n${raw}`));
            return;
          }
          setTimeout(poll, 25);
        };
        poll();
      });

    try {
      const nullBody = 'null';
      child.stdin.write(`Content-Length: ${Buffer.byteLength(nullBody, 'utf8')}\r\n\r\n${nullBody}`);
      child.stdin.write(frame({ id: 1, method: 'initialize', params: {} }));
      const init = await waitFor((m) => m['id'] === 1);
      const caps = (init['result'] as { capabilities: Record<string, unknown> }).capabilities;
      expect(caps['hoverProvider']).toBe(true);

      const uri = 'file://' + path.join(projectDir, 'app.grhm');
      const badSource = '(app hello (page "/" home (txt unknown-ref)))';
      child.stdin.write(frame({ method: 'textDocument/didOpen', params: { textDocument: { uri, languageId: 'grhm', version: 1, text: badSource } } }));
      const diags = await waitFor((m) => m['method'] === 'textDocument/publishDiagnostics');
      const list = (diags['params'] as { diagnostics: { code: string }[] }).diagnostics;
      expect(list.some((d) => d.code === 'E201')).toBe(true);

      // Hover over "txt" (offset of "txt" in the source, line 0).
      const character = badSource.indexOf('txt') + 1;
      child.stdin.write(frame({ id: 2, method: 'textDocument/hover', params: { textDocument: { uri }, position: { line: 0, character } } }));
      const hover = await waitFor((m) => m['id'] === 2);
      const value = ((hover['result'] as { contents: { value: string } }).contents).value;
      expect(value).toContain('text');

      // References and rename over a state declaration.
      const goodSource = '(app hello (state n 0) (page "/" home (txt n) (btn "Up" (click (set n (+ n 1))))))';
      child.stdin.write(frame({ method: 'textDocument/didChange', params: { textDocument: { uri, version: 2 }, contentChanges: [{ text: goodSource }] } }));
      await waitFor(
        (m) =>
          m['method'] === 'textDocument/publishDiagnostics' &&
          ((m['params'] as { diagnostics: unknown[] }).diagnostics).length === 0,
      );
      const statePos = { line: 0, character: goodSource.indexOf('state n') + 6 };
      child.stdin.write(frame({ id: 3, method: 'textDocument/references', params: { textDocument: { uri }, position: statePos, context: { includeDeclaration: true } } }));
      const refs = await waitFor((m) => m['id'] === 3);
      const locations = refs['result'] as { uri: string; range: { start: { character: number } } }[];
      expect(locations.length).toBe(4); // decl, txt, set target, + operand

      child.stdin.write(frame({ id: 4, method: 'textDocument/rename', params: { textDocument: { uri }, position: statePos, newName: 'clicks' } }));
      const rename = await waitFor((m) => m['id'] === 4);
      const changes = (rename['result'] as { changes: Record<string, { newText: string }[]> }).changes;
      const edits = Object.values(changes).flat();
      expect(edits.length).toBe(4);
      expect(edits.every((e) => e.newText === 'clicks')).toBe(true);

      // Changing the app can create a diagnostic in another open included
      // module; that module must be republished even though it was not edited.
      const sharedPath = path.join(projectDir, 'shared.grhm');
      const sharedUri = 'file://' + sharedPath;
      const sharedSource = '(component chip (txt n))';
      fs.writeFileSync(sharedPath, sharedSource);
      let after = messages(raw).length;
      child.stdin.write(frame({ method: 'textDocument/didOpen', params: { textDocument: { uri: sharedUri, languageId: 'grhm', version: 1, text: sharedSource } } }));
      await waitFor(
        (m) => m['method'] === 'textDocument/publishDiagnostics' && (m['params'] as { uri: string }).uri === sharedUri,
        10_000,
        after,
      );

      const withState = '(app hello (state n 0) (include "shared.grhm") (page "/" home (chip)))';
      after = messages(raw).length;
      child.stdin.write(frame({ method: 'textDocument/didChange', params: { textDocument: { uri, version: 3 }, contentChanges: [{ text: withState }] } }));
      await waitFor(
        (m) =>
          m['method'] === 'textDocument/publishDiagnostics' &&
          (m['params'] as { uri: string; diagnostics: unknown[] }).uri === sharedUri &&
          (m['params'] as { diagnostics: unknown[] }).diagnostics.length === 0,
        10_000,
        after,
      );

      const withoutState = '(app hello (include "shared.grhm") (page "/" home (chip)))';
      after = messages(raw).length;
      child.stdin.write(frame({ method: 'textDocument/didChange', params: { textDocument: { uri, version: 4 }, contentChanges: [{ text: withoutState }] } }));
      const crossFile = await waitFor(
        (m) =>
          m['method'] === 'textDocument/publishDiagnostics' &&
          (m['params'] as { uri: string }).uri === sharedUri &&
          (m['params'] as { diagnostics: { code: string }[] }).diagnostics.some((d) => d.code === 'E201'),
        10_000,
        after,
      );
      expect((crossFile['params'] as { diagnostics: { code: string }[] }).diagnostics.some((d) => d.code === 'E201')).toBe(true);

      const specialPath = path.join(projectDir, 'part#one.grhm');
      fs.writeFileSync(specialPath, '(component special-chip (txt "special"))');
      const specialSource = '(app hello (include "part#one.grhm") (page "/" home (special-chip)))';
      after = messages(raw).length;
      child.stdin.write(frame({ method: 'textDocument/didChange', params: { textDocument: { uri, version: 5 }, contentChanges: [{ text: specialSource }] } }));
      await waitFor(
        (m) => m['method'] === 'textDocument/publishDiagnostics' && (m['params'] as { uri: string; diagnostics: unknown[] }).uri === uri && (m['params'] as { diagnostics: unknown[] }).diagnostics.length === 0,
        10_000,
        after,
      );
      child.stdin.write(frame({ id: 5, method: 'textDocument/definition', params: { textDocument: { uri }, position: { line: 0, character: specialSource.lastIndexOf('special-chip') + 2 } } }));
      const definition = await waitFor((m) => m['id'] === 5);
      const definitionUri = (definition['result'] as { uri: string }).uri;
      expect(definitionUri).toContain('part%23one.grhm');
      expect(fs.realpathSync(fileURLToPath(definitionUri))).toBe(fs.realpathSync(specialPath));
    } finally {
      child.kill();
    }
  }, 30_000);
});

describe('generated API server (live)', () => {
  let dir: string;
  let child: ChildProcess | undefined;

  const sqliteAvailable = (() => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require('node:sqlite');
      return true;
    } catch {
      return false;
    }
  })();

  afterAll(() => {
    child?.kill();
    if (dir !== undefined) fs.rmSync(dir, { recursive: true, force: true });
  });

  it.skipIf(!sqliteAvailable)('serves CRUD over HTTP against real SQLite', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grhm-server-'));
    const src = `(app wishlist
      (db (table wishes (id auto) (name string) (done boolean :default false)))
      (api
        (get "/api/wishes" (select wishes))
        (get "/api/wishes/find/{id}" (select wishes :where (= id id)))
        (post "/api/wishes" (insert wishes :name (trim body.name)))
        (put "/api/wishes/{id}" (update wishes :id id :done body.done))
        (delete "/api/wishes/{id}" (delete-row wishes :id id)))
      (data (resource wishes "/api/wishes" :default (arr)))
      (page "/" home (each w wishes.data (txt w.name))))`;
    fs.writeFileSync(path.join(dir, 'app.grhm'), src);
    fs.writeFileSync(path.join(dir, 'grhm.json'), JSON.stringify({ entry: 'app.grhm', outDir: 'gen' }));
    const project = GrhmProject.fromCwd(dir);
    const compiled = project.compile();
    expect(compiled.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    project.writeArtifacts(compiled.files);

    const features = process.features as { typescript?: unknown };
    const nodeArgs = features.typescript !== undefined && features.typescript !== false ? [] : ['--experimental-strip-types'];
    child = spawn(process.execPath, [...nodeArgs, path.join(dir, 'gen', 'server.ts')], {
      cwd: dir,
      env: { ...process.env, GRHM_DB: ':memory:', PORT: '0' },
    });
    const output = new OutputCollector(child);
    const started = await output.wait((line) => line.includes('server-started'), 20_000);
    const port = (JSON.parse(started) as { port: number }).port;

    const base = `http://127.0.0.1:${port}`;
    // Mutations carry the x-grhm CSRF header, matching the generated client.
    const mutate = { 'Content-Type': 'application/json', 'x-grhm': '1' };

    const rejected = await fetch(`${base}/api/wishes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'nope' }),
    });
    expect(rejected.status).toBe(403);

    const created = await (
      await fetch(`${base}/api/wishes`, { method: 'POST', headers: mutate, body: JSON.stringify({ name: '  a pony  ' }) })
    ).json();
    expect(created).toEqual({ id: 1, name: 'a pony', done: false });

    const updated = await (
      await fetch(`${base}/api/wishes/1`, { method: 'PUT', headers: mutate, body: JSON.stringify({ done: true }) })
    ).json();
    expect(updated).toEqual({ id: 1, name: 'a pony', done: true });

    const list = (await (await fetch(`${base}/api/wishes`)).json()) as unknown[];
    expect(list).toHaveLength(1);
    const found = (await (await fetch(`${base}/api/wishes/find/1`)).json()) as unknown[];
    expect(found).toHaveLength(1);
    const unmatched = (await (await fetch(`${base}/api/wishes/find/999`)).json()) as unknown[];
    expect(unmatched).toEqual([]);

    const gone = await (await fetch(`${base}/api/wishes/1`, { method: 'DELETE', headers: mutate })).json();
    expect(gone).toEqual({ ok: true });
    expect((await (await fetch(`${base}/api/wishes`)).json()) as unknown[]).toHaveLength(0);

    const missing = await fetch(`${base}/api/nothing`);
    expect(missing.status).toBe(404);

    const health = await fetch(`${base}/healthz`);
    expect(health.status).toBe(200);
  }, 40_000);
});

describe('generated API server: auth, input contracts, seeds (live)', () => {
  let dir: string;
  let child: ChildProcess | undefined;

  const sqliteAvailable = (() => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require('node:sqlite');
      return true;
    } catch {
      return false;
    }
  })();

  afterAll(() => {
    child?.kill();
    if (dir !== undefined) fs.rmSync(dir, { recursive: true, force: true });
  });

  it.skipIf(!sqliteAvailable)('enforces sessions, validates input, and applies seeds', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grhm-auth-'));
    const src = `(app diary
      (auth users)
      (db
        (table posts (id auto) (owner string) (text string))
        (seed posts (row :owner "seed@x" :text "first!")))
      (api
        (get "/api/posts" (select posts :order id))
        (post "/api/posts" :auth true
          (input (text string))
          (insert posts :owner user.email :text body.text)))
      (data (resource posts "/api/posts" :default (arr)))
      (page "/" home (each p posts.data (txt p.text))))`;
    fs.writeFileSync(path.join(dir, 'app.grhm'), src);
    fs.writeFileSync(path.join(dir, 'grhm.json'), JSON.stringify({ entry: 'app.grhm', outDir: 'gen' }));
    const project = GrhmProject.fromCwd(dir);
    const compiled = project.compile();
    expect(compiled.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    project.writeArtifacts(compiled.files);

    const features = process.features as { typescript?: unknown };
    const nodeArgs = features.typescript !== undefined && features.typescript !== false ? [] : ['--experimental-strip-types'];
    child = spawn(process.execPath, [...nodeArgs, path.join(dir, 'gen', 'server.ts')], {
      cwd: dir,
      env: { ...process.env, GRHM_DB: ':memory:', PORT: '0' },
    });
    const output = new OutputCollector(child);
    const started = await output.wait((line) => line.includes('server-started'), 20_000);
    const port = (JSON.parse(started) as { port: number }).port;
    const base = `http://127.0.0.1:${port}`;
    const mutate = { 'Content-Type': 'application/json', 'x-grhm': '1' };

    // Seed data is applied on boot.
    const seeded = (await (await fetch(`${base}/api/posts`)).json()) as { text: string }[];
    expect(seeded.map((p) => p.text)).toEqual(['first!']);

    // Guarded route without a session -> 401.
    const anon = await fetch(`${base}/api/posts`, { method: 'POST', headers: mutate, body: JSON.stringify({ text: 'hi' }) });
    expect(anon.status).toBe(401);

    // Signup issues a session cookie.
    const signup = await fetch(`${base}/api/auth/signup`, {
      method: 'POST',
      headers: mutate,
      body: JSON.stringify({ email: 'ada@example.test', password: 'hunter22' }),
    });
    expect(signup.status).toBe(200);
    const cookie = (signup.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    expect(cookie).toContain('grhm_session=');
    const authed = { ...mutate, Cookie: cookie };

    // The unique database index, not a racy preflight SELECT, arbitrates
    // concurrent signups for the same normalized email.
    const raceBody = JSON.stringify({ email: 'race@example.test', password: 'hunter22' });
    const raced = await Promise.all([
      fetch(`${base}/api/auth/signup`, { method: 'POST', headers: mutate, body: raceBody }),
      fetch(`${base}/api/auth/signup`, { method: 'POST', headers: mutate, body: raceBody }),
    ]);
    expect(raced.map((response) => response.status).sort()).toEqual([200, 409]);

    // /api/auth/me reflects the session; the password hash is never exposed.
    const me = (await (await fetch(`${base}/api/auth/me`, { headers: { Cookie: cookie } })).json()) as Record<string, unknown>;
    expect(me['email']).toBe('ada@example.test');
    expect(me['password_hash']).toBeUndefined();

    // Input contract: missing/mistyped fields are structured 400s.
    const bad = await fetch(`${base}/api/posts`, { method: 'POST', headers: authed, body: JSON.stringify({ wrong: 1 }) });
    expect(bad.status).toBe(400);

    // Valid authed mutation lands with the session's user bound.
    const created = (await (
      await fetch(`${base}/api/posts`, { method: 'POST', headers: authed, body: JSON.stringify({ text: 'dear diary' }) })
    ).json()) as { owner: string; text: string };
    expect(created.owner).toBe('ada@example.test');
    expect(created.text).toBe('dear diary');

    // Wrong password -> 401; logout invalidates the session.
    const wrong = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: mutate,
      body: JSON.stringify({ email: 'ada@example.test', password: 'nope' }),
    });
    expect(wrong.status).toBe(401);
    await fetch(`${base}/api/auth/logout`, { method: 'POST', headers: authed });
    const after = await fetch(`${base}/api/posts`, { method: 'POST', headers: authed, body: JSON.stringify({ text: 'x' }) });
    expect(after.status).toBe(401);
  }, 40_000);
});

describe('generated API server: SSE, jobs, uploads (live)', () => {
  let dir: string;
  let child: ChildProcess | undefined;

  const sqliteAvailable = (() => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require('node:sqlite');
      return true;
    } catch {
      return false;
    }
  })();

  afterAll(() => {
    child?.kill();
    if (dir !== undefined) fs.rmSync(dir, { recursive: true, force: true });
  });

  it.skipIf(!sqliteAvailable)('broadcasts db changes, runs jobs, and stores uploads', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grhm-live-'));
    const src = `(app livedemo
      (db
        (table notes (id auto) (text string))
        (table ticks (id auto) (n number)))
      (api
        (get "/api/notes" (select notes))
        (get "/api/notes/{id}" (obj :id id))
        (post "/api/notes" (insert notes :text body.text))
        (get "/api/ticks" (select ticks)))
      (uploads :max-kb 64)
      (job tick :every 1 (insert ticks :n 1))
      (data (resource notes "/api/notes" :default (arr) :live true))
      (page "/" home (each n notes.data (txt n.text))))`;
    fs.writeFileSync(path.join(dir, 'app.grhm'), src);
    fs.writeFileSync(path.join(dir, 'grhm.json'), JSON.stringify({ entry: 'app.grhm', outDir: 'gen' }));
    const project = GrhmProject.fromCwd(dir);
    const compiled = project.compile();
    expect(compiled.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    project.writeArtifacts(compiled.files);

    const features = process.features as { typescript?: unknown };
    const nodeArgs = features.typescript !== undefined && features.typescript !== false ? [] : ['--experimental-strip-types'];
    child = spawn(process.execPath, [...nodeArgs, path.join(dir, 'gen', 'server.ts')], {
      cwd: dir,
      env: { ...process.env, GRHM_DB: ':memory:', PORT: '0' },
    });
    const output = new OutputCollector(child);
    const started = await output.wait((line) => line.includes('server-started'), 20_000);
    const port = (JSON.parse(started) as { port: number }).port;
    const base = `http://127.0.0.1:${port}`;
    const mutate = { 'Content-Type': 'application/json', 'x-grhm': '1' };

    // The SSE feed announces itself, then relays a change event for a mutation.
    const events = await fetch(`${base}/api/_events`);
    expect(events.headers.get('content-type')).toBe('text/event-stream');
    const reader = events.body!.getReader();
    const decoder = new TextDecoder();
    let feed = '';
    await fetch(`${base}/api/notes`, { method: 'POST', headers: mutate, body: JSON.stringify({ text: 'hello' }) });
    while (!feed.includes('data: {"changed":true,')) {
      const chunk = await reader.read();
      if (chunk.done) break;
      feed += decoder.decode(chunk.value);
    }
    expect(feed).toContain(':ok');
    expect(feed).toContain('data: {"changed":true,');
    await reader.cancel();

    // The :every 1 job inserts a tick within a couple of seconds.
    let ticks: unknown[] = [];
    const deadline = Date.now() + 10_000;
    while (ticks.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 300));
      ticks = (await (await fetch(`${base}/api/ticks`)).json()) as unknown[];
    }
    expect(ticks.length).toBeGreaterThan(0);

    // Uploads round-trip: content-addressed name, original extension, same bytes.
    const bytes = Buffer.from('fake png bytes');
    const uploaded = (await (
      await fetch(`${base}/api/uploads`, {
        method: 'POST',
        headers: { 'x-grhm': '1', 'x-filename': 'photo.png', 'Content-Type': 'application/octet-stream' },
        body: bytes,
      })
    ).json()) as { url: string };
    expect(uploaded.url).toMatch(/^\/uploads\/[0-9a-f]{64}\.png$/);
    const fetched = await fetch(base + uploaded.url);
    expect(fetched.headers.get('content-type')).toBe('image/png');
    expect(Buffer.from(await fetched.arrayBuffer())).toEqual(bytes);

    // Uploads without the CSRF header are rejected like any other mutation.
    const noCsrf = await fetch(`${base}/api/uploads`, { method: 'POST', body: bytes });
    expect(noCsrf.status).toBe(403);

    // Active content (html/svg/js) is stored without its extension and served
    // inert: octet-stream, attachment, sandboxing CSP — never same-origin html.
    const evil = (await (
      await fetch(`${base}/api/uploads`, {
        method: 'POST',
        headers: { 'x-grhm': '1', 'x-filename': 'evil.html', 'Content-Type': 'application/octet-stream' },
        body: Buffer.from('<script>alert(1)</script>'),
      })
    ).json()) as { url: string };
    expect(evil.url).toMatch(/^\/uploads\/[0-9a-f]{64}$/);
    const inert = await fetch(base + evil.url);
    expect(inert.headers.get('content-type')).toBe('application/octet-stream');
    expect(inert.headers.get('content-disposition')).toBe('attachment');
    expect(inert.headers.get('content-security-policy')).toContain('sandbox');

    // A malformed x-filename must not crash the server.
    const badName = await fetch(`${base}/api/uploads`, {
      method: 'POST',
      headers: { 'x-grhm': '1', 'x-filename': '%', 'Content-Type': 'application/octet-stream' },
      body: bytes,
    });
    expect(badName.status).toBe(200);

    // Malformed percent-encoding in a routed path segment must not crash: it
    // reaches the handler as raw text (200 here), and the server stays up.
    const badPath = await fetch(`${base}/api/notes/%`);
    expect(badPath.status).toBe(200);
    const alive = await fetch(`${base}/healthz`);
    expect(alive.status).toBe(200);
  }, 40_000);
});
