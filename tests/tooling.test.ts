import { ChildProcess, ChildProcessWithoutNullStreams, execFileSync, execSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { SExpr, opName, walkLists } from '../src/ast.js';
import { compile } from '../src/codegen/index.js';
import { CODE_DOCS } from '../src/diagnostics.js';
import { parse } from '../src/parser.js';
import { MAX_PROTOCOL_BYTES } from '../src/limits.js';
import { findReferences, resolveSymbolAt } from '../src/references.js';
import { displayCode, explainCode, loadRepairs, nearestCodes } from '../src/repairs.js';
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

  it('explains one diagnostic code with its corpus repairs', () => {
    const project = GrhmProject.fromCwd(projectDir);
    const all = handleRequest(project, 'codes', {}) as { codes: Record<string, string> };
    expect(all.codes['E111']).toBe(CODE_DOCS['E111']);

    const one = handleRequest(project, 'codes', { code: 'e111' }) as { ok: boolean; code: string; doc: string; repairs: { code: string; fix?: string }[] };
    expect(one).toMatchObject({ ok: true, code: 'E111', doc: CODE_DOCS['E111'] });
    expect(one.repairs.length).toBeGreaterThan(0);
    expect(one.repairs.every((r) => r.code === 'E111')).toBe(true);
    expect(one.repairs.some((r) => r.fix === 'safe')).toBe(true);
    expect(handleRequest(project, 'codes', { code: 'E1111' })).toEqual({ ok: false, code: 'E1111', suggestions: ['E111'] });
  });

  it('locates the corpus beside the compiler and tolerates a layout without it', () => {
    expect(loadRepairs().length).toBeGreaterThanOrEqual(50);
    expect(loadRepairs(path.join(os.tmpdir(), 'grhm-no-such-corpus', 'repairs.json'))).toEqual([]);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grhm-repairs-'));
    try {
      const noNote = path.join(dir, 'no-note.json');
      fs.writeFileSync(noNote, JSON.stringify({ repairs: [{ name: 'x', code: 'E101', broken: '(app a)', fixed: '(app a)' }] }));
      expect(() => loadRepairs(noNote)).toThrow('repairs[0].note must be a string');
      const badLevel = path.join(dir, 'bad-level.json');
      fs.writeFileSync(badLevel, JSON.stringify({ repairs: [{ name: 'x', code: 'E101', note: '', broken: '(app a)', fixed: '(app a)', fix: 'placeholder' }] }));
      expect(() => loadRepairs(badLevel)).toThrow('repairs[0].fix must be "safe" or "review"');
      const noList = path.join(dir, 'no-list.json');
      fs.writeFileSync(noList, JSON.stringify({ repairs: {} }));
      expect(() => loadRepairs(noList)).toThrow('expected { "repairs": [...] }');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    expect(explainCode(' e111 ')).toMatchObject({ code: 'E111', doc: CODE_DOCS['E111'] });
    expect(explainCode('E9999')).toBeUndefined();
    expect(nearestCodes('W80')).toEqual(['W801']);
    expect(nearestCodes('nope')).toEqual([]);
    // An over-long input is no near miss: no edit distances are computed and the echo is cut short.
    const long = 'E' + '1'.repeat(40);
    expect(nearestCodes(long)).toEqual([]);
    expect(displayCode(long)).toBe('E111111111111111…');
    expect(displayCode('E1111')).toBe('E1111');
    expect(handleRequest(GrhmProject.fromCwd(projectDir), 'codes', { code: long })).toEqual({ ok: false, code: 'E111111111111111…', suggestions: [] });
  });

  it('answers fix requests in preview and write modes', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grhm-server-fix-'));
    try {
      const entry = path.join(dir, 'app.grhm');
      const broken = '(app a (page "/" home (txt "Hi" :colr "#111")))';
      const repaired = '(app a (page "/" home (txt "Hi" :color "#111")))';
      fs.writeFileSync(entry, broken);
      const project = new GrhmProject({ root: dir, entry: 'app.grhm', outDir: 'gen' });
      type FixReply = { ok: boolean; clean: boolean; revision: string; applied: { code: string }[]; newSources?: Record<string, string> };

      const preview = handleRequest(project, 'fix', { preview: true }) as FixReply;
      expect(preview).toMatchObject({ ok: true, clean: true });
      expect(preview.applied.map((a) => a.code)).toEqual(['E102']);
      expect(preview.newSources).toEqual({ 'app.grhm': repaired });
      expect(fs.readFileSync(entry, 'utf8')).toBe(broken);

      expect(() => handleRequest(project, 'fix', { level: 'bogus' })).toThrow('"level"');
      expect(() => handleRequest(project, 'fix', { fix: 'f123' })).toThrow('"fix"');
      // A malformed dry run is an error, never a write: every optional field must have exactly its documented type.
      expect(() => handleRequest(project, 'fix', { preview: 'yes' })).toThrow('"preview" must be a boolean');
      expect(() => handleRequest(project, 'fix', { preview: 1 })).toThrow('"preview"');
      expect(() => handleRequest(project, 'fix', { preview: true, maxPasses: 'x' })).toThrow('"maxPasses" must be a positive integer');
      expect(() => handleRequest(project, 'fix', { preview: true, maxPasses: 0 })).toThrow('"maxPasses"');
      expect(() => handleRequest(project, 'fix', { preview: true, maxPasses: 1.5 })).toThrow('"maxPasses"');
      expect(() => handleRequest(project, 'fix', { preview: true, maxPasses: null })).toThrow('"maxPasses"');
      expect(() => handleRequest(project, 'fix', { preview: true, revision: 1 })).toThrow('"revision" must be a string');
      expect(() => handleRequest(project, 'fix', { preview: true, format: 'false' })).toThrow('"format" must be a boolean');
      expect(() => handleRequest(project, 'patch', { patch: '(patch)', preview: 'yes' })).toThrow('"preview" must be a boolean');
      expect(fs.readFileSync(entry, 'utf8')).toBe(broken);
      const stale = handleRequest(project, 'fix', { revision: 'deadbeef' }) as { ok: boolean; conflict: boolean };
      expect(stale).toMatchObject({ ok: false, conflict: true });
      expect(fs.readFileSync(entry, 'utf8')).toBe(broken);

      const written = handleRequest(project, 'fix', { level: 'safe' }) as FixReply;
      expect(written).toMatchObject({ ok: true, clean: true, newSources: { 'app.grhm': repaired } });
      expect(fs.readFileSync(entry, 'utf8')).toBe(repaired);
      expect(handleRequest(project, 'check', {})).toMatchObject({ ok: true, revision: written.revision });
      expect(fs.readdirSync(dir).filter((f) => f.startsWith('.grhm-write'))).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('answers fix requests with explicit ids, a code filter, a pass budget, and formatting off', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grhm-server-fix-request-'));
    try {
      const entry = path.join(dir, 'app.grhm');
      fs.writeFileSync(entry, '(app a (page "/" home (cardd (txt "Hi" :colr "#111"))))');
      const project = new GrhmProject({ root: dir, entry: 'app.grhm', outDir: 'gen' });
      type FixReply = { ok: boolean; clean: boolean; passes: number; stopped: string; applied: { id: string; code: string; pass: number }[]; newSources?: Record<string, string> };
      const checked = handleRequest(project, 'check', {}) as { diagnostics: { code: string; fixes?: { id: string }[] }[] };
      const outer = checked.diagnostics.find((d) => d.code === 'E101')?.fixes?.[0]?.id;
      expect(outer).toMatch(/^f[0-9a-f]{8}$/);
      // The code filter alone cannot reach the E102 the unknown op masks; an explicit id is exempt from the filter and unmasks it.
      expect(handleRequest(project, 'fix', { preview: true, codes: ['E102'] })).toMatchObject({ ok: true, clean: false, passes: 0, stopped: 'fixed-point', applied: [] });
      const requested = handleRequest(project, 'fix', { preview: true, codes: ['E102'], fix: [outer] }) as FixReply;
      expect(requested.applied.map((a) => [a.id === outer, a.code, a.pass])).toEqual([[true, 'E101', 1], [false, 'E102', 2]]);
      expect(requested.clean).toBe(true);
      expect(handleRequest(project, 'fix', { preview: true, maxPasses: 1 })).toMatchObject({ ok: true, clean: false, passes: 1, stopped: 'max-passes' });
      // Formatting off keeps a canonical file minimally edited; the default re-canonicalizes it.
      const canonical = '(app a\n  (db\n    (table t (id auto)))\n\n  (state photo "")\n\n  (page "/" home (file-input :label "Photo" :to photo)))\n';
      fs.writeFileSync(entry, canonical);
      expect((handleRequest(project, 'fix', { preview: true }) as FixReply).newSources?.['app.grhm']).toBe(canonical.replace('(app a\n', '(app a\n  (uploads)\n\n'));
      expect((handleRequest(project, 'fix', { preview: true, format: false }) as FixReply).newSources?.['app.grhm']).toBe(canonical.replace('(app a\n', '(app a (uploads)\n'));
      expect(fs.readFileSync(entry, 'utf8')).toBe(canonical);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
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

  it('fixes and patches a project whose interop module was already missing, reporting the E602 alongside', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grhm-fix-interop-'));
    try {
      const entry = path.join(dir, 'app.grhm');
      fs.writeFileSync(entry, '(app a (use "./lib/missing.ts" (import helper)) (page "/" home (txt "x" :colr "#000")))');
      const project = new GrhmProject({ root: dir, entry: 'app.grhm', outDir: 'gen' });
      const fixed = project.applyFixes();
      expect(fixed).toMatchObject({ ok: true, clean: false, conflict: false, changedFiles: ['app.grhm'] });
      expect(fixed.applied.map((a) => a.code)).toEqual(['E102']);
      expect(fixed.diagnostics.map((d) => d.code)).toEqual(['E602']);
      expect(fixed.uncovered).toEqual([]);
      expect(fs.readFileSync(entry, 'utf8')).toContain(':color "#000"');

      let txtId = '';
      walkLists(project.load().mergedNodes, (node) => {
        if (opName(node) === 'txt') txtId = node.id;
      });
      const patched = project.applyPatch(`(patch :target ${txtId} (set color "#111"))`);
      expect(patched.ok).toBe(true);
      expect(patched.diagnostics.map((d) => d.code)).toContain('E602');
      expect(fs.readFileSync(entry, 'utf8')).toContain(':color "#111"');

      // A second missing module is introduced by the patch, so that one is still rejected.
      let useId = '';
      walkLists(project.load().mergedNodes, (node) => {
        if (opName(node) === 'use') useId = node.id;
      });
      const before = fs.readFileSync(entry, 'utf8');
      const introduced = project.applyPatch(`(patch :target ${useId} (replace (use "./lib/other.ts" (import helper))))`);
      expect(introduced.ok).toBe(false);
      expect(introduced.diagnostics.map((d) => d.code)).toEqual(['E503', 'E602']);
      expect(fs.readFileSync(entry, 'utf8')).toBe(before);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses to write through a symlinked source file as a structured rejection', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grhm-fix-symlink-'));
    try {
      const broken = '(app a (page "/" home (txt "x" :colr "#000")))';
      fs.mkdirSync(path.join(dir, 'real'));
      fs.writeFileSync(path.join(dir, 'real', 'app.grhm'), broken);
      fs.symlinkSync(path.join('real', 'app.grhm'), path.join(dir, 'app.grhm'));
      fs.writeFileSync(path.join(dir, 'grhm.json'), JSON.stringify({ entry: 'app.grhm', outDir: 'gen' }));
      const project = GrhmProject.fromCwd(dir);
      expect(project.applyFixes({}, false)).toMatchObject({ ok: true, clean: true });

      const written = project.applyFixes();
      expect(written).toMatchObject({ ok: false, clean: false, conflict: false, applied: [] });
      expect(written.diagnostics.map((d) => [d.code, d.received])).toEqual([['E503', 'app.grhm']]);
      expect(written.diagnostics[0]?.message).toBe('Fix rejected: "app.grhm" is a symbolic link; edit its target file instead');

      // Patch and format reach the same refusal (on a program they would otherwise change).
      const valid = '(app a (page "/" home (txt "x" :color "#000")))';
      fs.writeFileSync(path.join(dir, 'real', 'app.grhm'), valid);
      let txtId = '';
      walkLists(project.load().mergedNodes, (node) => {
        if (opName(node) === 'txt') txtId = node.id;
      });
      const patched = project.applyPatch(`(patch :target ${txtId} (set color "#111"))`);
      expect(patched).toMatchObject({ ok: false, conflict: false });
      expect(patched.diagnostics.map((d) => d.code)).toEqual(['E503']);
      expect(project.formatAll()).toMatchObject({ changed: [] });
      expect(project.formatAll().diagnostics.map((d) => d.code)).toEqual(['E503']);
      expect(fs.readFileSync(path.join(dir, 'real', 'app.grhm'), 'utf8')).toBe(valid);

      fs.writeFileSync(path.join(dir, 'real', 'app.grhm'), broken);
      const cli = spawnSync('node', [CLI, 'fix'], { cwd: dir, encoding: 'utf8' });
      expect(cli.status).toBe(1);
      expect(cli.stderr).toContain('symbolic link');
      expect(cli.stdout).toContain('fix rejected');
      expect(fs.readFileSync(path.join(dir, 'real', 'app.grhm'), 'utf8')).toBe(broken);
      expect(fs.lstatSync(path.join(dir, 'app.grhm')).isSymbolicLink()).toBe(true);
      expect(fs.readdirSync(dir).filter((f) => f.startsWith('.grhm-write'))).toEqual([]);
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

  it('stages cross-file fixes before replacing any source file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grhm-fix-atomic-'));
    const locked = path.join(dir, 'locked');
    fs.mkdirSync(locked);
    const app = '(app a (include "locked/part.grhm") (page "/" home (chip)))';
    const part = '(component chip (txt "x" :colr "#fff"))';
    fs.writeFileSync(path.join(dir, 'app.grhm'), app);
    fs.writeFileSync(path.join(locked, 'part.grhm'), part);
    const project = new GrhmProject({ root: dir, entry: 'app.grhm', outDir: 'gen' });
    try {
      const preview = project.applyFixes({}, false);
      expect(preview).toMatchObject({ ok: true, clean: true, changedFiles: ['locked/part.grhm'] });
      expect(preview.newSources?.get('locked/part.grhm')).toBe('(component chip (txt "x" :color "#fff"))');

      fs.chmodSync(locked, 0o555);
      expect(() => project.applyFixes()).toThrow();
      expect(fs.readFileSync(path.join(dir, 'app.grhm'), 'utf8')).toBe(app);
      expect(fs.readFileSync(path.join(locked, 'part.grhm'), 'utf8')).toBe(part);
      expect(fs.readdirSync(dir).filter((f) => f.startsWith('.grhm-write'))).toEqual([]);
    } finally {
      fs.chmodSync(locked, 0o755);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects a fix when a project file changed on disk during validation', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grhm-fix-cas-'));
    const realRead = fs.readFileSync;
    try {
      const entry = path.join(dir, 'app.grhm');
      const broken = '(app a (page "/" home (txt "x" :colr "#000")))';
      fs.writeFileSync(entry, broken);
      const project = new GrhmProject({ root: dir, entry: 'app.grhm', outDir: 'gen' });
      // A concurrent writer as the commit's compare-and-swap observes it: the disk no longer holds the snapshot the fixes were validated against.
      vi.spyOn(fs, 'readFileSync').mockImplementation((file, options) =>
        typeof file === 'string' && path.basename(file) === 'app.grhm' && (new Error().stack ?? '').includes('commitSources')
          ? '(app a (page "/" home (txt "changed")))'
          : realRead(file, options));
      const result = project.applyFixes();
      vi.restoreAllMocks();
      expect(result).toMatchObject({ ok: false, clean: false, conflict: true, passes: 0, applied: [] });
      expect(result.diagnostics.map((d) => [d.code, d.message])).toEqual([['E504', 'Project changed during fix validation; retry against its current revision']]);
      expect(fs.readFileSync(entry, 'utf8')).toBe(broken);
      expect(fs.readdirSync(dir).filter((f) => f.startsWith('.grhm-write'))).toEqual([]);
    } finally {
      vi.restoreAllMocks();
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

  it('explains a diagnostic code from the CLI and suggests the nearest known code', () => {
    type Explained = { schema: number; ok: boolean; code: string; doc: string; repairs: { name: string; code: string; note: string; broken: string; fixed: string; fix?: string }[] };
    const explained = spawnSync('node', [CLI, 'codes', 'E111', '--json'], { cwd: projectDir, encoding: 'utf8' });
    expect(explained.status).toBe(0);
    const result = JSON.parse(explained.stdout) as Explained;
    expect(result).toMatchObject({ schema: 1, ok: true, code: 'E111', doc: CODE_DOCS['E111'] });
    expect(result.repairs.length).toBeGreaterThan(0);
    for (const repair of result.repairs) {
      expect(repair).toMatchObject({ code: 'E111', name: expect.any(String), note: expect.any(String), broken: expect.any(String), fixed: expect.any(String) });
    }
    expect(result.repairs.some((r) => r.fix === 'safe')).toBe(true);

    const human = spawnSync('node', [CLI, 'codes', 'e111'], { cwd: projectDir, encoding: 'utf8' });
    expect(human.status).toBe(0);
    expect(human.stdout.startsWith(`E111  ${CODE_DOCS['E111']}\n`)).toBe(true);
    const first = result.repairs[0];
    expect(human.stdout).toContain(`\n  ${first?.name}\n  ${first?.note}\n  broken: ${first?.broken}\n  fixed: ${first?.fixed}\n`);
    expect(human.stdout).toContain('\n  fix: safe\n');

    const unknown = spawnSync('node', [CLI, 'codes', 'E1111'], { cwd: projectDir, encoding: 'utf8' });
    expect(unknown.status).toBe(1);
    expect(unknown.stdout).toBe('');
    expect(unknown.stderr).toBe('unknown code E1111; did you mean E111?\n');
    const unknownJson = spawnSync('node', [CLI, 'codes', 'E1111', '--json'], { cwd: projectDir, encoding: 'utf8' });
    expect(unknownJson.status).toBe(1);
    expect(JSON.parse(unknownJson.stdout)).toEqual({ schema: 1, ok: false, code: 'E1111', suggestions: ['E111'] });
    const nothingNear = spawnSync('node', [CLI, 'codes', 'bogus'], { cwd: projectDir, encoding: 'utf8' });
    expect(nothingNear.status).toBe(1);
    expect(nothingNear.stderr).toBe('unknown code bogus\n');
    const long = spawnSync('node', [CLI, 'codes', 'E' + '1'.repeat(40)], { cwd: projectDir, encoding: 'utf8' });
    expect(long.status).toBe(1);
    expect(long.stderr).toBe('unknown code E111111111111111…\n');

    // Too many arguments is a usage error, like every other command's.
    const usage = spawnSync('node', [CLI, 'codes', 'E111', 'E112'], { cwd: projectDir, encoding: 'utf8' });
    expect(usage.status).toBe(2);
    expect(usage.stdout).toBe('');
    expect(usage.stderr).toBe('usage: grhm codes [CODE] [--json]\n');
    const usageJson = spawnSync('node', [CLI, 'codes', 'E111', 'E112', '--json'], { cwd: projectDir, encoding: 'utf8' });
    expect(usageJson.status).toBe(2);
    expect(usageJson.stdout).toBe('');
  });

  it('advertises safe fixes from check and applies them with grhm fix', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grhm-fix-cli-'));
    try {
      const entry = path.join(dir, 'app.grhm');
      const broken = '(app a (page "/" home (cardd (txt "Hi" :colr "#111"))))';
      const repaired = '(app a (page "/" home (card (txt "Hi" :color "#111"))))';
      fs.writeFileSync(entry, broken);
      fs.writeFileSync(path.join(dir, 'grhm.json'), JSON.stringify({ entry: 'app.grhm', outDir: 'gen' }));

      const check = spawnSync('node', [CLI, 'check'], { cwd: dir, encoding: 'utf8' });
      expect(check.status).toBe(1);
      expect(check.stdout).toContain('1 safe fix(es) available: grhm fix');

      const usage = spawnSync('node', [CLI, 'fix', '--level', 'bogus'], { cwd: dir, encoding: 'utf8' });
      expect(usage.status).toBe(2);
      expect(usage.stderr).toContain('usage: grhm fix');

      const dry = spawnSync('node', [CLI, 'fix', '--dry-run', '--json'], { cwd: dir, encoding: 'utf8' });
      expect(dry.status, dry.stdout + dry.stderr).toBe(0);
      const previewed = JSON.parse(dry.stdout) as { applied: { code: string }[]; newSource?: unknown; newSources?: unknown };
      expect(previewed).toMatchObject({ schema: 1, ok: true, clean: true, passes: 2, stopped: 'fixed-point', changedFiles: ['app.grhm'] });
      expect(previewed.applied.map((a) => a.code)).toEqual(['E101', 'E102']);
      // Nothing was written, so the dry run carries the text it would have written.
      expect(previewed.newSource).toBe(repaired);
      expect(previewed.newSources).toEqual({ 'app.grhm': repaired });
      expect(fs.readFileSync(entry, 'utf8')).toBe(broken);

      const conflict = spawnSync('node', [CLI, 'fix', '--revision', 'deadbeef'], { cwd: dir, encoding: 'utf8' });
      expect(conflict.status).toBe(1);
      expect(conflict.stdout).toContain('conflict; current revision');
      expect(fs.readFileSync(entry, 'utf8')).toBe(broken);

      const run = spawnSync('node', [CLI, 'fix', '--json'], { cwd: dir, encoding: 'utf8' });
      expect(run.status, run.stdout + run.stderr).toBe(0);
      const written = JSON.parse(run.stdout) as { applied: { code: string }[]; newSource?: unknown; newSources?: unknown };
      expect(written).toMatchObject({ ok: true, clean: true, passes: 2, changedFiles: ['app.grhm'] });
      expect(written.applied.map((a) => a.code)).toEqual(['E101', 'E102']);
      // After a real write the files on disk are the source of truth.
      expect(written.newSource).toBeUndefined();
      expect(written.newSources).toBeUndefined();
      expect(fs.readFileSync(entry, 'utf8')).toBe(repaired);
      expect(fs.readdirSync(dir).filter((f) => f.startsWith('.grhm-write'))).toEqual([]);

      fs.writeFileSync(entry, broken);
      const human = spawnSync('node', [CLI, 'fix'], { cwd: dir, encoding: 'utf8' });
      expect(human.status, human.stdout + human.stderr).toBe(0);
      expect(human.stdout).toContain('fixed app.grhm:1:23 E101 Rename "cardd" to "card"');
      expect(human.stdout).toContain('fixed app.grhm:1:39 E102 Replace ":colr" with ":color"');
      expect(human.stdout).toContain('applied 2 fix(es) in 2 pass(es); 0 error(s) remain');
      expect(fs.readFileSync(entry, 'utf8')).toBe(repaired);

      const again = spawnSync('node', [CLI, 'fix', '--json'], { cwd: dir, encoding: 'utf8' });
      expect(again.status).toBe(0);
      expect(JSON.parse(again.stdout)).toMatchObject({ ok: true, clean: true, passes: 0, applied: [] });

      // The footer counts fixes as `grhm fix` applies them: one repair offered by two diagnostics is one fix.
      fs.writeFileSync(entry, '(app a (db (table t (id auto))) (state p "") (state q "") (page "/" home (file-input :label "P" :to p) (file-input :label "Q" :to q)))');
      const shared = spawnSync('node', [CLI, 'check'], { cwd: dir, encoding: 'utf8' });
      expect(shared.status).toBe(1);
      expect(shared.stdout).toContain('1 safe fix(es) available: grhm fix');
      const sharedFix = JSON.parse(spawnSync('node', [CLI, 'fix', '--dry-run', '--json'], { cwd: dir, encoding: 'utf8' }).stdout) as { applied: { title: string }[] };
      expect(sharedFix.applied.map((a) => a.title)).toEqual(['Add (uploads) to app']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('selects fixes by id and code from the CLI, honours --no-format, and rejects malformed flags', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grhm-fix-flags-'));
    try {
      const entry = path.join(dir, 'app.grhm');
      const cascade = '(app a (page "/" home (cardd (txt "Hi" :colr "#111"))))';
      fs.writeFileSync(entry, cascade);
      fs.writeFileSync(path.join(dir, 'grhm.json'), JSON.stringify({ entry: 'app.grhm', outDir: 'gen' }));
      const fix = (...args: string[]): { status: number | null; stdout: string; stderr: string } => spawnSync('node', [CLI, 'fix', ...args], { cwd: dir, encoding: 'utf8' });
      type Report = { applied: { id: string; code: string }[] };
      const checked = JSON.parse(spawnSync('node', [CLI, 'check', '--json'], { cwd: dir, encoding: 'utf8' }).stdout) as { diagnostics: { code: string; fixes?: { id: string }[] }[] };
      const outer = checked.diagnostics.find((d) => d.code === 'E101')?.fixes?.[0]?.id ?? '';
      expect(outer).toMatch(/^f[0-9a-f]{8}$/);

      // --code alone cannot reach the E102 the unknown op masks; an explicit --fix id is exempt from the filter and unmasks it.
      const byCode = fix('--dry-run', '--json', '--code', 'E102');
      expect(byCode.status).toBe(1);
      expect(JSON.parse(byCode.stdout)).toMatchObject({ ok: true, clean: false, passes: 0, applied: [] });
      const byId = fix('--dry-run', '--json', '--code', 'E102', '--fix', outer);
      expect(byId.status, byId.stdout + byId.stderr).toBe(0);
      expect((JSON.parse(byId.stdout) as Report).applied.map((a) => [a.id === outer, a.code])).toEqual([[true, 'E101'], [false, 'E102']]);
      const stale = fix('--fix', 'f00000000');
      expect(stale.status).toBe(1);
      expect(stale.stdout).toContain('conflict; current revision');

      // A flag without its value, a value that is another flag, and an unknown flag are usage errors that write nothing.
      for (const args of [['--fix'], ['--fix', '--dry-run'], ['--code'], ['--level'], ['--revision'], ['--bogus']]) {
        const usage = fix(...args);
        expect(usage.status, args.join(' ')).toBe(2);
        expect(usage.stdout, args.join(' ')).toBe('');
        expect(usage.stderr.startsWith('usage: grhm fix'), args.join(' ')).toBe(true);
      }
      expect(fs.readFileSync(entry, 'utf8')).toBe(cascade);

      // --no-format keeps a canonical file minimally edited; the default re-canonicalizes it.
      const canonical = '(app a\n  (db\n    (table t (id auto)))\n\n  (state photo "")\n\n  (page "/" home (file-input :label "Photo" :to photo)))\n';
      fs.writeFileSync(entry, canonical);
      expect(fix('--no-format').status).toBe(0);
      expect(fs.readFileSync(entry, 'utf8')).toBe(canonical.replace('(app a\n', '(app a (uploads)\n'));
      fs.writeFileSync(entry, canonical);
      expect(fix().status).toBe(0);
      expect(fs.readFileSync(entry, 'utf8')).toBe(canonical.replace('(app a\n', '(app a\n  (uploads)\n\n'));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
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

  /** Spawns `grhm lsp` in a project directory and exposes framed sends plus a poll over the decoded replies. */
  function startLsp(cwd = projectDir): {
    child: ChildProcessWithoutNullStreams;
    send: (message: Record<string, unknown>) => void;
    waitFor: (predicate: (m: Record<string, unknown>) => boolean, timeoutMs?: number, after?: number) => Promise<Record<string, unknown>>;
    received: () => number;
  } {
    const child = spawn('node', [CLI, 'lsp'], { cwd });
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
    return { child, send: (message) => child.stdin.write(frame(message)), waitFor, received: () => messages(raw).length };
  }

  it('initializes, publishes diagnostics, and answers hover', async () => {
    const { child, send, waitFor, received } = startLsp();

    try {
      const nullBody = 'null';
      child.stdin.write(`Content-Length: ${Buffer.byteLength(nullBody, 'utf8')}\r\n\r\n${nullBody}`);
      send({ id: 1, method: 'initialize', params: {} });
      const init = await waitFor((m) => m['id'] === 1);
      const caps = (init['result'] as { capabilities: Record<string, unknown> }).capabilities;
      expect(caps['hoverProvider']).toBe(true);

      const uri = 'file://' + path.join(projectDir, 'app.grhm');
      const badSource = '(app hello (page "/" home (txt unknown-ref)))';
      send({ method: 'textDocument/didOpen', params: { textDocument: { uri, languageId: 'grhm', version: 1, text: badSource } } });
      const diags = await waitFor((m) => m['method'] === 'textDocument/publishDiagnostics');
      const list = (diags['params'] as { diagnostics: { code: string }[] }).diagnostics;
      expect(list.some((d) => d.code === 'E201')).toBe(true);

      // Hover over "txt" (offset of "txt" in the source, line 0).
      const character = badSource.indexOf('txt') + 1;
      send({ id: 2, method: 'textDocument/hover', params: { textDocument: { uri }, position: { line: 0, character } } });
      const hover = await waitFor((m) => m['id'] === 2);
      const value = ((hover['result'] as { contents: { value: string } }).contents).value;
      expect(value).toContain('text');

      // References and rename over a state declaration.
      const goodSource = '(app hello (state n 0) (page "/" home (txt n) (btn "Up" (click (set n (+ n 1))))))';
      send({ method: 'textDocument/didChange', params: { textDocument: { uri, version: 2 }, contentChanges: [{ text: goodSource }] } });
      await waitFor(
        (m) =>
          m['method'] === 'textDocument/publishDiagnostics' &&
          ((m['params'] as { diagnostics: unknown[] }).diagnostics).length === 0,
      );
      const statePos = { line: 0, character: goodSource.indexOf('state n') + 6 };
      send({ id: 3, method: 'textDocument/references', params: { textDocument: { uri }, position: statePos, context: { includeDeclaration: true } } });
      const refs = await waitFor((m) => m['id'] === 3);
      const locations = refs['result'] as { uri: string; range: { start: { character: number } } }[];
      expect(locations.length).toBe(4); // decl, txt, set target, + operand

      send({ id: 4, method: 'textDocument/rename', params: { textDocument: { uri }, position: statePos, newName: 'clicks' } });
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
      let after = received();
      send({ method: 'textDocument/didOpen', params: { textDocument: { uri: sharedUri, languageId: 'grhm', version: 1, text: sharedSource } } });
      await waitFor(
        (m) => m['method'] === 'textDocument/publishDiagnostics' && (m['params'] as { uri: string }).uri === sharedUri,
        10_000,
        after,
      );

      const withState = '(app hello (state n 0) (include "shared.grhm") (page "/" home (chip)))';
      after = received();
      send({ method: 'textDocument/didChange', params: { textDocument: { uri, version: 3 }, contentChanges: [{ text: withState }] } });
      await waitFor(
        (m) =>
          m['method'] === 'textDocument/publishDiagnostics' &&
          (m['params'] as { uri: string; diagnostics: unknown[] }).uri === sharedUri &&
          (m['params'] as { diagnostics: unknown[] }).diagnostics.length === 0,
        10_000,
        after,
      );

      const withoutState = '(app hello (include "shared.grhm") (page "/" home (chip)))';
      after = received();
      send({ method: 'textDocument/didChange', params: { textDocument: { uri, version: 4 }, contentChanges: [{ text: withoutState }] } });
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
      after = received();
      send({ method: 'textDocument/didChange', params: { textDocument: { uri, version: 5 }, contentChanges: [{ text: specialSource }] } });
      await waitFor(
        (m) => m['method'] === 'textDocument/publishDiagnostics' && (m['params'] as { uri: string; diagnostics: unknown[] }).uri === uri && (m['params'] as { diagnostics: unknown[] }).diagnostics.length === 0,
        10_000,
        after,
      );
      send({ id: 5, method: 'textDocument/definition', params: { textDocument: { uri }, position: { line: 0, character: specialSource.lastIndexOf('special-chip') + 2 } } });
      const definition = await waitFor((m) => m['id'] === 5);
      const definitionUri = (definition['result'] as { uri: string }).uri;
      expect(definitionUri).toContain('part%23one.grhm');
      expect(fs.realpathSync(fileURLToPath(definitionUri))).toBe(fs.realpathSync(specialPath));
    } finally {
      child.kill();
    }
  }, 30_000);

  it('offers diagnostic fixes as quick fixes with exact ranges', async () => {
    const { child, send, waitFor } = startLsp();
    type Action = { title: string; kind: string; isPreferred: boolean; edit: { changes: Record<string, { range: { start: { line: number; character: number }; end: { line: number; character: number } }; newText: string }[]> } };
    try {
      send({ id: 1, method: 'initialize', params: {} });
      await waitFor((m) => m['id'] === 1);
      const uri = 'file://' + path.join(projectDir, 'app.grhm');
      const source = '(app hello (state count 0) (page "/" home (cardd (txt "x")) (txt cont.length) (link (txt "b"))))';
      send({ method: 'textDocument/didOpen', params: { textDocument: { uri, languageId: 'grhm', version: 1, text: source } } });
      await waitFor((m) => m['method'] === 'textDocument/publishDiagnostics');
      const whole = { start: { line: 0, character: 0 }, end: { line: 0, character: source.length } };
      send({ id: 2, method: 'textDocument/codeAction', params: { textDocument: { uri }, range: whole, context: { diagnostics: [] } } });
      const actions = (await waitFor((m) => m['id'] === 2))['result'] as Action[];
      const action = (title: string): Action => {
        const found = actions.find((a) => a.title === title);
        if (found === undefined) throw new Error(`missing action ${title} in ${JSON.stringify(actions.map((a) => a.title))}`);
        return found;
      };
      const only = (a: Action): { range: Action['edit']['changes'][string][number]['range']; newText: string } => {
        const edits = a.edit.changes[uri] ?? [];
        expect(Object.keys(a.edit.changes)).toEqual([uri]);
        expect(edits).toHaveLength(1);
        const edit = edits[0];
        if (edit === undefined) throw new Error('no edit');
        return edit;
      };
      expect(actions.every((a) => a.kind === 'quickfix')).toBe(true);

      // E101: only the head identifier of (cardd ...) is renamed.
      const rename = action('Rename "cardd" to "card"');
      expect(rename.isPreferred).toBe(true);
      const cardd = source.indexOf('cardd');
      expect(only(rename)).toEqual({ range: { start: { line: 0, character: cardd }, end: { line: 0, character: cardd + 5 } }, newText: 'card' });

      // E201: only the head segment of the dotted identifier is replaced.
      const replace = action('Replace "cont" with "count"');
      expect(replace.isPreferred).toBe(true);
      const cont = source.indexOf('cont.length');
      expect(only(replace)).toEqual({ range: { start: { line: 0, character: cont }, end: { line: 0, character: cont + 4 } }, newText: 'count' });

      // E106: a placeholder is offered but never preferred.
      const to = action('Add :to "" (fill in)');
      expect(to.isPreferred).toBe(false);
      expect(only(to).newText).toBe(' :to ""');

      // The client's `only` filter is honoured.
      send({ id: 3, method: 'textDocument/codeAction', params: { textDocument: { uri }, range: whole, context: { diagnostics: [], only: ['refactor'] } } });
      expect((await waitFor((m) => m['id'] === 3))['result']).toEqual([]);
      send({ id: 4, method: 'textDocument/codeAction', params: { textDocument: { uri }, range: whole, context: { diagnostics: [], only: ['quickfix'] } } });
      expect(((await waitFor((m) => m['id'] === 4))['result'] as Action[]).length).toBe(actions.length);
    } finally {
      child.kill();
    }
  }, 30_000);

  it('resolves quick-fix edits that land in another project file', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grhm-lsp-crossfile-'));
    const app = '(app a (include "shared.grhm") (db (table t (id auto))) (state photo "") (page "/" home (chip)))';
    const shared = '(component chip (file-input :label "Photo" :to photo) (txt "x" :colr "#fff"))';
    fs.writeFileSync(path.join(dir, 'grhm.json'), JSON.stringify({ entry: 'app.grhm', outDir: 'gen' }));
    fs.writeFileSync(path.join(dir, 'app.grhm'), app);
    fs.writeFileSync(path.join(dir, 'shared.grhm'), shared);
    const { child, send, waitFor } = startLsp(dir);
    type Action = { title: string; isPreferred: boolean; edit: { changes: Record<string, { range: { start: { line: number; character: number }; end: { line: number; character: number } }; newText: string }[]> } };
    try {
      send({ id: 1, method: 'initialize', params: {} });
      await waitFor((m) => m['id'] === 1);
      const appUri = pathToFileURL(path.join(dir, 'app.grhm')).href;
      const sharedUri = pathToFileURL(path.join(dir, 'shared.grhm')).href;
      send({ method: 'textDocument/didOpen', params: { textDocument: { uri: appUri, languageId: 'grhm', version: 1, text: app } } });
      send({ method: 'textDocument/didOpen', params: { textDocument: { uri: sharedUri, languageId: 'grhm', version: 1, text: shared } } });
      const published = await waitFor((m) => m['method'] === 'textDocument/publishDiagnostics' && (m['params'] as { uri: string }).uri === sharedUri);
      expect((published['params'] as { diagnostics: { code: string }[] }).diagnostics.map((d) => d.code).sort()).toEqual(['E102', 'E818']);
      send({ id: 2, method: 'textDocument/codeAction', params: { textDocument: { uri: sharedUri }, range: { start: { line: 0, character: 0 }, end: { line: 0, character: shared.length } }, context: { diagnostics: [] } } });
      const actions = (await waitFor((m) => m['id'] === 2))['result'] as Action[];
      const action = (title: string): Action => {
        const found = actions.find((a) => a.title === title);
        if (found === undefined) throw new Error(`missing action ${title} in ${JSON.stringify(actions.map((a) => a.title))}`);
        return found;
      };
      expect(actions).toHaveLength(2);
      // The E818 repair edits app.grhm, which the request did not ask about: its offsets are converted against that file's own text.
      const uploads = action('Add (uploads) to app');
      expect(uploads.isPreferred).toBe(true);
      expect(uploads.edit.changes).toEqual({ [appUri]: [{ range: { start: { line: 0, character: 6 }, end: { line: 0, character: 6 } }, newText: ' (uploads)' }] });
      const color = action('Replace ":colr" with ":color"');
      expect(Object.keys(color.edit.changes)).toEqual([sharedUri]);
      expect(color.edit.changes[sharedUri]?.[0]?.range.start.character).toBe(shared.indexOf(':colr'));
    } finally {
      child.kill();
      fs.rmSync(dir, { recursive: true, force: true });
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
