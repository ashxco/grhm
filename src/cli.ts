#!/usr/bin/env node
/**
 * The `grhm` CLI (PRD FR-11).
 *
 * Commands: new, check, fmt, build, dev, test, ast, inspect, patch, fix,
 * serve, lsp, reference, codes [CODE]. Every command supports --json with a
 * versioned machine-readable result.
 *
 * Exit codes: 0 success, 1 validation failure, 2 build/config failure,
 * 3 internal tool failure.
 */

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

import { CODE_DOCS, Diagnostic, formatHuman, hasErrors, preferredFix } from './diagnostics.js';
import { EvalContext, EvalError, contextFromApp, evalExpr, formatValue } from './eval.js';
import { FixRequest, candidateKey, isFixLevel } from './fix.js';
import { NameStyle } from './format.js';
import { runLsp } from './lsp.js';
import { parse } from './parser.js';
import { generateReference, referenceTokenEstimate } from './reference.js';
import { displayCode, explainCode, nearestCodes } from './repairs.js';
import { plainSources, runServer } from './server.js';
import { GrhmProject } from './sdk.js';
import { playwrightConfig } from './testgen.js';
import { VERSION } from './version.js';
import {
  DEFAULT_APP_GRHM,
  DOCKERFILE,
  DOCKERIGNORE,
  GRHM_JSON,
  MAIN_TSX,
  PROJECT_GITIGNORE,
  PROJECT_NPMRC,
  PROJECT_TSCONFIG,
  START_SCRIPT,
  VITE_CONFIG,
  VITE_ENV_DTS,
  indexHtml,
  projectPackageJson,
} from './scaffold.js';

/** Code frames come from `sources` (text not yet on disk, as in a dry run) before the files themselves. */
function printDiagnostics(project: GrhmProject, diags: Diagnostic[], sources?: Map<string, string>): void {
  for (const d of diags) {
    const file = d.span?.file ?? project.config.entry;
    const abs = path.join(project.config.root, file);
    const source = sources?.get(file) ?? (fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : undefined);
    process.stderr.write(formatHuman(d, source, file) + '\n');
  }
}

function jsonOut(payload: unknown): void {
  process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
}

/** A usage or configuration failure the user can act on: one line and exit code 2, never an E900 stack. */
class CliError extends Error {
  constructor(message: string, readonly exitCode = 2) {
    super(message);
  }
}

/** The project around the working directory, or a clear failure when there is none. */
function openProject(): GrhmProject {
  const project = GrhmProject.fromCwd(process.cwd());
  const { root, entry } = project.config;
  if (!fs.existsSync(path.join(root, 'grhm.json')) && !fs.existsSync(path.join(root, entry))) {
    throw new CliError(`no grhm.json or ${entry} found in ${root}; run this inside a GRHM project, or create one with grhm new <name>`);
  }
  return project;
}

/** The GRHM source checkout this CLI runs from (dist/ built beside src/), or undefined for an installed package. */
function checkoutRoot(): string | undefined {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const installed = path.basename(path.dirname(root)) === 'node_modules';
  return !installed && fs.existsSync(path.join(root, 'src', 'cli.ts')) ? root : undefined;
}

function findViteBin(root: string): string | undefined {
  const bin = path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'vite.cmd' : 'vite');
  return fs.existsSync(bin) ? bin : undefined;
}

/** Extra node args needed to execute generated TypeScript directly. */
function nodeTsArgs(): string[] {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if ((major ?? 0) < 22 || (major === 22 && (minor ?? 0) < 13)) {
    throw new CliError(`generated servers require Node 22.13 or newer (22.22+ or 24.15+ recommended); this is Node ${process.versions.node}`);
  }
  const features = process.features as { typescript?: unknown };
  return features.typescript !== undefined && features.typescript !== false ? [] : ['--experimental-strip-types'];
}

/** Is something accepting connections on this port? Connect-based: a bind
 * probe can false-negative next to a wildcard listener under SO_REUSEADDR. */
function portInUse(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}

/** First free port at or above `from`, so a stray process cannot shadow the API server. */
async function freePort(from: number): Promise<number> {
  for (let port = from; port < from + 50; port += 1) {
    const used = (await portInUse(port, '127.0.0.1')) || (await portInUse(port, '::1'));
    if (!used) return port;
  }
  return from;
}

// Commands -------------------------------------------------------------------

function cmdNew(args: string[]): number {
  const name = args[0];
  if (name === undefined) {
    process.stderr.write('usage: grhm new <name>\n');
    return 2;
  }
  const dir = path.resolve(name);
  if (fs.existsSync(dir) && fs.readdirSync(dir).length > 0) {
    process.stderr.write(`error: directory ${dir} already exists and is not empty\n`);
    return 2;
  }
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'app.grhm'), DEFAULT_APP_GRHM);
  fs.writeFileSync(path.join(dir, 'grhm.json'), GRHM_JSON);
  fs.writeFileSync(path.join(dir, 'package.json'), projectPackageJson(path.basename(dir), `^${VERSION}`));
  fs.writeFileSync(path.join(dir, 'index.html'), indexHtml(path.basename(dir)));
  fs.writeFileSync(path.join(dir, 'src', 'main.tsx'), MAIN_TSX);
  fs.writeFileSync(path.join(dir, 'src', 'vite-env.d.ts'), VITE_ENV_DTS);
  fs.writeFileSync(path.join(dir, 'vite.config.ts'), VITE_CONFIG);
  fs.writeFileSync(path.join(dir, 'tsconfig.json'), PROJECT_TSCONFIG);
  fs.writeFileSync(path.join(dir, '.gitignore'), PROJECT_GITIGNORE);
  fs.writeFileSync(path.join(dir, '.npmrc'), PROJECT_NPMRC);
  fs.writeFileSync(path.join(dir, 'Dockerfile'), DOCKERFILE);
  fs.writeFileSync(path.join(dir, '.dockerignore'), DOCKERIGNORE);
  fs.writeFileSync(path.join(dir, 'grhm-start.mjs'), START_SCRIPT);
  process.stdout.write(`Created ${name}. Next steps:\n  cd ${name}\n  npm install\n  npm run dev\n`);
  const checkout = checkoutRoot();
  if (checkout !== undefined) {
    // Relative when the project sits inside the checkout (the usual `node dist/cli.js new x` case), absolute otherwise.
    const inside = !path.relative(checkout, dir).startsWith('..');
    const target = inside ? path.relative(dir, checkout) : checkout;
    process.stdout.write(`The project depends on grhm ^${VERSION} from npm; to use this checkout instead, run: npm pkg set 'devDependencies.grhm=file:${target}'\n`);
  }
  return 0;
}

function cmdCheck(json: boolean): number {
  const project = openProject();
  const summary = project.check();
  if (json) {
    jsonOut({ schema: 1, ok: summary.ok, revision: summary.revision, diagnostics: summary.diagnostics });
  } else {
    printDiagnostics(project, summary.diagnostics);
    process.stdout.write(summary.ok ? `ok (revision ${summary.revision})\n` : 'check failed\n');
    // Distinct fixes, as `grhm fix` counts them: one repair offered by several diagnostics is one fix.
    const safe = new Set(summary.diagnostics.flatMap((d) => {
      const fix = preferredFix(d);
      return fix === undefined ? [] : [candidateKey(fix, project.config.entry)];
    })).size;
    if (safe > 0) process.stdout.write(`${safe} safe fix(es) available: grhm fix\n`);
  }
  return summary.ok ? 0 : 1;
}

function cmdFmt(json: boolean, rest: string[]): number {
  const checkOnly = rest.includes('--check');
  const style: NameStyle = rest.includes('--compact') ? 'compact' : rest.includes('--descriptive') ? 'descriptive' : 'preserve';
  const project = openProject();
  const { changed, diagnostics } = project.formatAll(style, checkOnly);
  if (hasErrors(diagnostics)) {
    if (json) jsonOut({ schema: 1, ok: false, diagnostics });
    else printDiagnostics(project, diagnostics);
    return 1;
  }
  if (checkOnly) {
    if (json) jsonOut({ schema: 1, ok: changed.length === 0, changed });
    else process.stdout.write(changed.length > 0 ? `needs formatting: ${changed.join(', ')}\n` : 'formatted\n');
    return changed.length > 0 ? 1 : 0;
  }
  if (json) jsonOut({ schema: 1, ok: true, changed });
  else process.stdout.write(changed.length > 0 ? `formatted ${changed.join(', ')}\n` : 'already formatted\n');
  return 0;
}

function compileAndWrite(project: GrhmProject, json: boolean): { ok: boolean; written: string[]; revision: string } {
  const started = Date.now();
  const result = project.compile();
  const ok = !hasErrors(result.diagnostics);
  const written = ok ? project.writeArtifacts(result.files) : [];
  if (json) {
    jsonOut({
      schema: 1,
      ok,
      revision: result.revision,
      diagnostics: result.diagnostics,
      artifacts: written,
      elapsedMs: Date.now() - started,
      measurements: { semanticNodes: project.countNodes() },
    });
  } else {
    printDiagnostics(project, result.diagnostics);
    if (ok) process.stdout.write(`compiled ${written.length} files to ${project.config.outDir} (revision ${result.revision})\n`);
  }
  return { ok, written, revision: result.revision };
}

function cmdBuild(json: boolean): number {
  const project = openProject();
  const started = Date.now();
  const result = project.compile();
  const written: string[] = [];
  let typechecked = false;
  const report = (ok: boolean, step?: string, output?: string): void => {
    if (json) jsonOut({ schema: 1, ok, revision: result.revision, diagnostics: result.diagnostics,
      artifacts: written, elapsedMs: Date.now() - started, bundled: ok, typechecked, step, output });
    else {
      printDiagnostics(project, result.diagnostics);
      if (output !== undefined) process.stderr.write(output + '\n');
      if (ok) process.stdout.write(`built ${written.length} generated files (revision ${result.revision})\n`);
    }
  };
  if (hasErrors(result.diagnostics)) {
    report(false, 'compile');
    return 1;
  }
  const vite = findViteBin(project.config.root);
  const tsc = path.join(project.config.root, 'node_modules', '.bin', process.platform === 'win32' ? 'tsc.cmd' : 'tsc');
  if (vite === undefined || !fs.existsSync(tsc)) {
    report(false, 'dependencies', 'Build requires local TypeScript and Vite installations; run npm install first.');
    return 2;
  }
  written.push(...project.writeArtifacts(result.files));
  // Explicit files ensure custom outDirs and generated backend modules are
  // checked even when a project's include/exclude patterns omit them. Keep
  // the project's own sources and resolution settings through extends.
  const config = path.join(project.config.root, `tsconfig.grhm-${process.pid}-${Date.now()}.json`);
  const baseConfig = fs.existsSync(path.join(project.config.root, 'tsconfig.json'))
    ? { extends: './tsconfig.json' }
    : JSON.parse(PROJECT_TSCONFIG) as Record<string, unknown>;
  try {
    fs.writeFileSync(config, JSON.stringify({
      ...baseConfig,
      compilerOptions: { ...('compilerOptions' in baseConfig ? baseConfig.compilerOptions as object : {}),
        strict: true, noEmit: true, incremental: false, composite: false },
      files: [...result.files.keys()].filter((name) => /\.tsx?$/.test(name)).map((name) =>
        path.join(project.config.root, project.config.outDir, name)),
    }), { flag: 'wx' });
    const checked = spawnSync(tsc, ['--project', config, '--pretty', 'false'], { cwd: project.config.root, encoding: 'utf8' });
    if (checked.status !== 0) {
      report(false, 'typecheck', (checked.stdout ?? '') + (checked.stderr ?? '') + (checked.error?.message ?? ''));
      return 2;
    }
  } finally {
    if (fs.existsSync(config)) fs.unlinkSync(config);
  }
  typechecked = true;
  const bundled = spawnSync(vite, ['build'], { cwd: project.config.root, encoding: 'utf8' });
  if (bundled.status !== 0) {
    report(false, 'vite-build', (bundled.stdout ?? '') + (bundled.stderr ?? '') + (bundled.error?.message ?? ''));
    return 2;
  }
  report(true);
  return 0;
}

function cmdDev(): number {
  const project = openProject();
  const first = compileAndWrite(project, false);
  if (!first.ok) {
    process.stderr.write('dev: initial compile failed; fix diagnostics and save to retry\n');
  }

  // When the app declares (db ...)/(api ...), run the generated API server
  // beside Vite (whose proxy forwards /api) and restart it on recompiles.
  const serverPath = path.join(project.config.root, project.config.outDir, 'server.ts');
  let apiServer: ReturnType<typeof spawn> | undefined;
  let apiPort = process.env.GRHM_API_PORT ?? '8787';
  const startApiServer = (): void => {
    if (apiServer !== undefined) {
      apiServer.kill();
      apiServer = undefined;
    }
    if (!fs.existsSync(serverPath)) return;
    apiServer = spawn(process.execPath, [...nodeTsArgs(), serverPath], {
      cwd: project.config.root,
      stdio: 'inherit',
      env: { ...process.env, PORT: apiPort },
    });
  };

  const recompile = (): void => {
    try {
      const result = compileAndWrite(project, false);
      if (result.ok) startApiServer();
    } catch (err) {
      process.stderr.write(`recompile failed: ${String(err)}\n`);
    }
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(recompile, 50);
  };
  const watched = new Set<string>();
  const watchSources = (): void => {
    for (const file of project.load().files) {
      const abs = path.join(project.config.root, file.file);
      if (watched.has(abs) || !fs.existsSync(abs)) continue;
      watched.add(abs);
      fs.watch(abs, schedule);
    }
  };
  watchSources();
  // New includes may appear after edits; rescan on every recompile.
  const rescan = setInterval(watchSources, 2000);
  rescan.unref();
  const vite = findViteBin(project.config.root);
  void (async () => {
    if (fs.existsSync(serverPath)) {
      if (process.env.GRHM_API_PORT === undefined) apiPort = String(await freePort(Number(apiPort)));
      startApiServer();
    }
    if (vite === undefined) {
      process.stdout.write('watching for changes (vite not installed; run npm install to serve the app)\n');
      return;
    }
    const child = spawn(vite, [], {
      cwd: project.config.root,
      stdio: 'inherit',
      env: { ...process.env, GRHM_API_PORT: apiPort },
    });
    child.on('exit', (code) => process.exit(code ?? 0));
    process.on('exit', () => apiServer?.kill());
  })();
  return -1;
}

function cmdTest(json: boolean, rest: string[]): number {
  const unitOnly = rest.includes('--unit');
  const e2eOnly = rest.includes('--e2e');
  if (unitOnly && e2eOnly) {
    const error = '--unit and --e2e are mutually exclusive';
    if (json) jsonOut({ schema: 1, ok: false, error });
    else process.stderr.write(`test: ${error}\n`);
    return 2;
  }
  const project = openProject();
  const { spec, unitSpec, diagnostics } = project.testSpec();
  if (hasErrors(diagnostics)) {
    if (json) jsonOut({ schema: 1, ok: false, diagnostics });
    else printDiagnostics(project, diagnostics);
    return 1;
  }
  if (spec === undefined || unitSpec === undefined) {
    if (json) jsonOut({ schema: 1, ok: true, tests: 0, note: 'no (tests ...) declared' });
    else process.stdout.write('no (tests ...) declared in this program\n');
    return 0;
  }
  // Emit only the final test result in --json mode; compileAndWrite has its
  // own result envelope and would make stdout cease to be one JSON document.
  const compiled = project.compile();
  if (hasErrors(compiled.diagnostics)) {
    if (json) jsonOut({ schema: 1, ok: false, diagnostics: compiled.diagnostics });
    else printDiagnostics(project, compiled.diagnostics);
    return 1;
  }
  project.writeArtifacts(compiled.files);
  const specDir = path.join(project.config.root, project.config.outDir, 'tests');
  fs.mkdirSync(specDir, { recursive: true });
  const specPath = path.join(specDir, 'app.spec.ts');
  const unitPath = path.join(specDir, 'app.unit.test.tsx');
  fs.writeFileSync(specPath, spec);
  fs.writeFileSync(unitPath, unitSpec);
  const hasServer = fs.existsSync(path.join(project.config.root, project.config.outDir, 'server.ts'));
  const configPath = path.join(project.config.root, 'playwright.config.ts');
  const generatedConfig = playwrightConfig(hasServer, project.config.outDir);
  if (!fs.existsSync(configPath) || fs.readFileSync(configPath, 'utf8').startsWith('/* Generated by grhm test. */')) {
    fs.writeFileSync(configPath, generatedConfig);
  }

  const binOf = (name: string): string | undefined => {
    const bin = path.join(project.config.root, 'node_modules', '.bin', process.platform === 'win32' ? `${name}.cmd` : name);
    return fs.existsSync(bin) ? bin : undefined;
  };
  const results: { runner: string; ok: boolean; ran: boolean; note?: string; output?: string }[] = [];

  if (!e2eOnly) {
    const vitest = binOf('vitest');
    if (vitest === undefined) {
      results.push({ runner: 'vitest', ok: false, ran: false, note: 'install to run unit tests: npm i -D vitest jsdom' });
    } else {
      const run = spawnSync(vitest, ['run', path.relative(project.config.root, unitPath)], {
        cwd: project.config.root,
        stdio: json ? 'pipe' : 'inherit',
      });
      results.push({ runner: 'vitest', ok: run.status === 0, ran: true, output: json ? String(run.stdout ?? '') + String(run.stderr ?? '') : undefined });
    }
  }
  if (!unitOnly) {
    const playwright = binOf('playwright');
    if (playwright === undefined) {
      results.push({ runner: 'playwright', ok: false, ran: false, note: 'install to run browser tests: npm i -D @playwright/test && npx playwright install chromium' });
    } else {
      const run = spawnSync(playwright, ['test'], { cwd: project.config.root, stdio: json ? 'pipe' : 'inherit' });
      results.push({ runner: 'playwright', ok: run.status === 0, ran: true, output: json ? String(run.stdout ?? '') + String(run.stderr ?? '') : undefined });
    }
  }

  const ok = results.every((r) => r.ok);
  if (json) jsonOut({ schema: 1, ok, results });
  else {
    for (const r of results) {
      if (!r.ran) process.stdout.write(`${r.runner}: skipped — ${r.note ?? ''}\n`);
    }
  }
  return ok ? 0 : 1;
}

function cmdAst(json: boolean): number {
  const project = openProject();
  const loaded = project.load();
  if (hasErrors(loaded.diagnostics)) {
    if (json) jsonOut({ schema: 1, ok: false, diagnostics: loaded.diagnostics });
    else printDiagnostics(project, loaded.diagnostics);
    return 1;
  }
  jsonOut({
    schema: 1,
    ok: true,
    revision: project.revision(),
    files: loaded.files.map((f) => f.file),
    ast: loaded.mergedNodes,
  });
  return 0;
}

function cmdInspect(args: string[], json: boolean): number {
  const nodeFlag = args.indexOf('--node');
  const nodeId = nodeFlag !== -1 ? args[nodeFlag + 1] : undefined;
  if (nodeId === undefined) {
    process.stderr.write('usage: grhm inspect --node <id>\n');
    return 2;
  }
  const project = openProject();
  const found = project.inspect(nodeId);
  if (found === undefined) {
    if (json) jsonOut({ schema: 1, ok: false, error: `no node with ID "${nodeId}"` });
    else process.stderr.write(`no node with ID "${nodeId}"\n`);
    return 1;
  }
  if (json) {
    jsonOut({ schema: 1, ok: true, node: found.node, parentId: found.parentId, parentOp: found.parentOp, file: found.file });
  } else {
    process.stdout.write(found.text);
    if (found.parentId !== undefined) {
      process.stdout.write(`; parent: ${found.parentId} (${found.parentOp ?? '?'})`);
    }
    if (found.file !== undefined) process.stdout.write(`; file: ${found.file}`);
    process.stdout.write('\n');
  }
  return 0;
}

function cmdPatch(args: string[], json: boolean): number {
  const patchFile = args.find((a) => !a.startsWith('--'));
  if (patchFile === undefined) {
    process.stderr.write('usage: grhm patch <patch-file> [--json]\n');
    return 2;
  }
  const project = openProject();
  const patchSource = fs.readFileSync(patchFile, 'utf8');
  const result = project.applyPatch(patchSource);
  if (json) {
    const { newSource: _omit, newSources: _omit2, ...rest } = result;
    jsonOut({ schema: 1, ...rest });
  } else {
    printDiagnostics(project, result.diagnostics);
    if (result.ok) {
      const files = result.changedFiles !== undefined && result.changedFiles.length > 0 ? ` (${result.changedFiles.join(', ')})` : '';
      process.stdout.write(`patched${files}; new revision ${result.revision ?? '?'}\n`);
    } else if (result.conflict) process.stdout.write(`conflict; current revision ${result.currentRevision ?? '?'}\n`);
    else process.stdout.write('patch rejected\n');
  }
  return result.ok ? 0 : 1;
}

const FIX_USAGE = 'usage: grhm fix [--level safe|review|none] [--fix <id>]... [--code <CODE>]... [--revision <rev>] [--dry-run] [--no-format] [--json]\n';

function cmdFix(args: string[], json: boolean): number {
  const request: FixRequest = {};
  const fix: string[] = [];
  const codes: string[] = [];
  let dryRun = false;
  for (let i = 0; i < args.length; i += 1) {
    const flag = args[i];
    switch (flag) {
      case '--level':
      case '--fix':
      case '--code':
      case '--revision': {
        const value = args[i + 1];
        if (value === undefined || value.startsWith('--')) {
          process.stderr.write(FIX_USAGE);
          return 2;
        }
        i += 1;
        if (flag === '--level') {
          if (!isFixLevel(value)) {
            process.stderr.write(FIX_USAGE);
            return 2;
          }
          request.level = value;
        } else if (flag === '--fix') fix.push(value);
        else if (flag === '--code') codes.push(value);
        else request.revision = value;
        break;
      }
      case '--dry-run':
        dryRun = true;
        break;
      case '--no-format':
        request.format = false;
        break;
      default:
        process.stderr.write(FIX_USAGE);
        return 2;
    }
  }
  if (fix.length > 0) request.fix = fix;
  if (codes.length > 0) request.codes = codes;
  const project = openProject();
  const result = project.applyFixes(request, !dryRun);
  if (json) {
    // A dry run reports the text it would have written; after a real one the files on disk are the source of truth.
    const { newSource: _omit, newSources: _omit2, ...rest } = result;
    jsonOut({ schema: 1, ...(dryRun ? plainSources(result) : rest) });
  } else {
    for (const a of result.applied) process.stdout.write(`fixed ${a.file}:${a.line}:${a.col} ${a.code} ${a.title}\n`);
    for (const s of result.skipped) process.stdout.write(`skipped ${s.code} ${s.id} ${s.title} (${s.reason})\n`);
    printDiagnostics(project, result.diagnostics, result.newSources);
    if (result.conflict) process.stdout.write(`conflict; current revision ${result.currentRevision ?? '?'}\n`);
    else if (!result.ok) process.stdout.write('fix rejected\n');
    else {
      const errors = result.diagnostics.filter((d) => d.severity === 'error').length;
      process.stdout.write(`${dryRun ? 'would apply' : 'applied'} ${result.applied.length} fix(es) in ${result.passes} pass(es); ${errors} error(s) remain\n`);
    }
  }
  return result.ok && result.clean ? 0 : 1;
}

/** Fns/enums/i18n from the current project, if we are inside one. */
function loadEvalContext(): EvalContext {
  try {
    const project = GrhmProject.fromCwd(process.cwd());
    return contextFromApp(project.compile().app);
  } catch {
    return contextFromApp(undefined);
  }
}

function evalSource(source: string, ctx: EvalContext): { ok: boolean; text: string } {
  const parsed = parse(source, '<eval>');
  if (hasErrors(parsed.diagnostics)) {
    return { ok: false, text: parsed.diagnostics.map((d) => formatHuman(d, source, '<eval>')).join('\n') };
  }
  if (parsed.nodes.length === 0) return { ok: true, text: '' };
  try {
    const results = parsed.nodes.map((node) => formatValue(evalExpr(node, ctx)));
    return { ok: true, text: results.join('\n') };
  } catch (err) {
    if (err instanceof EvalError || err instanceof RangeError) {
      return { ok: false, text: `eval error: ${err.message}` };
    }
    throw err;
  }
}

function cmdEval(rest: string[], json: boolean): number {
  const source = rest.filter((a) => !a.startsWith('--')).join(' ');
  if (source.trim() === '') {
    process.stderr.write('usage: grhm eval "<expr>"\n');
    return 2;
  }
  const result = evalSource(source, loadEvalContext());
  if (json) {
    // result.text is already JSON for evaluable values, except '#<fn>' for closures and bare NaN/Infinity for non-finite numbers.
    jsonOut({ schema: 1, ok: result.ok, ...(result.ok ? { result: result.text } : { error: result.text }) });
    return result.ok ? 0 : 1;
  }
  (result.ok ? process.stdout : process.stderr).write(result.text + '\n');
  return result.ok ? 0 : 1;
}

function cmdRepl(): number {
  const ctx = loadEvalContext();
  const fnNames = [...ctx.functions.keys()];
  process.stdout.write('grhm repl — pure core (expressions, fns, let/if/cond/match). Ctrl+D to exit.\n');
  if (fnNames.length > 0) process.stdout.write(`project fns: ${fnNames.join(', ')}\n`);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: 'grhm> ' });
  rl.prompt();
  rl.on('line', (line) => {
    if (line.trim() !== '') {
      const result = evalSource(line, ctx);
      process.stdout.write(result.text + '\n');
    }
    rl.prompt();
  });
  rl.on('close', () => {
    process.stdout.write('\n');
    process.exit(0);
  });
  return -1;
}

/** Production serving: run the generated API server, which also serves dist/. */
function cmdStart(): number {
  const project = openProject();
  const serverPath = path.join(project.config.root, project.config.outDir, 'server.ts');
  if (!fs.existsSync(path.join(project.config.root, 'dist', 'index.html'))) {
    process.stderr.write('start: dist/index.html not found — run `grhm build` (with vite installed) first\n');
    return 2;
  }
  const child = fs.existsSync(serverPath)
    ? spawn(process.execPath, [...nodeTsArgs(), serverPath], {
        cwd: project.config.root,
        stdio: 'inherit',
        env: process.env,
      })
    : spawn(process.execPath, [fileURLToPath(new URL('./runtime/static-server.js', import.meta.url))], {
        cwd: project.config.root, stdio: 'inherit', env: process.env,
      });
  const terminate = () => { child.kill('SIGTERM'); };
  const interrupt = () => { child.kill('SIGINT'); };
  process.on('SIGTERM', terminate);
  process.on('SIGINT', interrupt);
  child.on('error', (error) => {
    process.stderr.write(`start: ${error.message}\n`);
    process.exit(2);
  });
  child.on('exit', (code, signal) => {
    process.off('SIGTERM', terminate);
    process.off('SIGINT', interrupt);
    process.exit(code ?? (signal === 'SIGINT' ? 130 : 143));
  });
  return -1;
}

function cmdReference(json: boolean, full = false): number {
  const text = generateReference({ full });
  if (json) {
    jsonOut({ schema: 1, ok: true, text, tokenEstimate: referenceTokenEstimate(text) });
  } else {
    process.stdout.write(text);
    process.stderr.write(`~${referenceTokenEstimate(text)} tokens\n`);
  }
  return 0;
}

/** `grhm codes` lists every code; `grhm codes <CODE>` explains one with its corpus repair transcripts. */
function cmdCodes(rest: string[], json: boolean): number {
  if (rest.length > 1) {
    process.stderr.write('usage: grhm codes [CODE] [--json]\n');
    return 2;
  }
  const code = rest[0];
  if (code === undefined) {
    if (json) {
      jsonOut({ schema: 1, ok: true, codes: CODE_DOCS });
      return 0;
    }
    for (const [name, doc] of Object.entries(CODE_DOCS)) {
      process.stdout.write(`${name}  ${doc}\n`);
    }
    return 0;
  }
  const explained = explainCode(code);
  if (explained === undefined) {
    const suggestions = nearestCodes(code);
    if (json) jsonOut({ schema: 1, ok: false, code: displayCode(code), suggestions });
    else process.stderr.write(`unknown code ${displayCode(code)}${suggestions.length > 0 ? `; did you mean ${suggestions.join(', ')}?` : ''}\n`);
    return 1;
  }
  if (json) {
    jsonOut({ schema: 1, ok: true, ...explained });
    return 0;
  }
  const lines = [`${explained.code}  ${explained.doc}`];
  for (const repair of explained.repairs) {
    lines.push('', `  ${repair.name}`, `  ${repair.note}`, `  broken: ${repair.broken}`, `  fixed: ${repair.fixed}`);
    if (repair.fix !== undefined) lines.push(`  fix: ${repair.fix}`);
  }
  process.stdout.write(lines.join('\n') + '\n');
  return 0;
}

const HELP = `grhm - Generative Reactive Hypermedia Metalanguage

usage: grhm <command> [options]

commands:
  new <name>          create a new GRHM project
  check               parse and validate; print structured diagnostics
  fmt [--check]       format all project sources canonically
      [--compact|--descriptive]  rewrite op names to that projection
  build               compile and bundle for production
  dev                 compile, watch, and serve with hot reload
  test [--unit|--e2e] lower (tests ...) to Vitest + Playwright and run them
  eval "<expr>"       evaluate a pure-core expression (project fns available)
  repl                interactive pure-core evaluator
  start               run the production server (generated API + dist/)
  ast                 print the canonical AST as JSON
  inspect --node <id> print one node, its parent, and its file
  migrate [--check]   apply database migrations (or validate and roll back)
  db <operation>      backup, verify, or restore a SQLite snapshot
  patch <file>        apply a structural patch to the program
  fix [--dry-run]     apply the safe fixes diagnostics carry; --level review,
      --fix <id>, --code <CODE>, --revision <rev>, --no-format
  serve               long-lived compiler server (JSON lines on stdio)
  lsp                 language server (LSP over stdio)
  reference [--full]  print the compact reference (or detailed descriptions)
  codes [CODE]        list all diagnostic codes, or explain one with worked repairs

options:
  --json              machine-readable output (schema-versioned)
`;

export function main(argv: string[]): number {
  const json = argv.includes('--json');
  const args = argv.filter((a) => a !== '--json');
  const command = args[0];
  const rest = args.slice(1);
  try {
    switch (command) {
      case 'new':
        return cmdNew(rest);
      case 'check':
        return cmdCheck(json);
      case 'fmt':
        return cmdFmt(json, rest);
      case 'build':
        return cmdBuild(json);
      case 'dev':
        return cmdDev();
      case 'test':
        return cmdTest(json, rest);
      case 'eval':
        return cmdEval(rest, json);
      case 'repl':
        return cmdRepl();
      case 'start':
        return cmdStart();
      case 'ast':
        return cmdAst(json);
      case 'inspect':
        return cmdInspect(rest, json);
      case 'db': {
        nodeTsArgs();
        const outcome = spawnSync(process.execPath, [fileURLToPath(new URL('./runtime/db-admin.js', import.meta.url)), ...rest], { stdio: 'inherit' });
        return outcome.status ?? 1;
      }
      case 'migrate': {
        if (rest.length > 1 || (rest.length === 1 && rest[0] !== '--check')) {
          process.stderr.write('usage: grhm migrate [--check]\n');
          return 2;
        }
        const project = openProject();
        const result = project.compile();
        if (hasErrors(result.diagnostics)) { printDiagnostics(project, result.diagnostics); return 1; }
        if (!result.files.has('server.ts')) {
          throw new CliError('migrate: this app declares no (db ...), (api ...), or (uploads), so no server is generated and there is no database to migrate');
        }
        project.writeArtifacts(result.files);
        const outcome = spawnSync(process.execPath, [...nodeTsArgs(), path.join(project.config.root, project.config.outDir, 'server.ts')], {
          cwd: project.config.root, stdio: 'inherit', env: { ...process.env, GRHM_MIGRATE: args.includes('--check') ? 'check' : 'apply' },
        });
        return outcome.status ?? 1;
      }
      case 'patch':
        return cmdPatch(rest, json);
      case 'fix':
        return cmdFix(rest, json);
      case 'serve':
        runServer(process.cwd());
        return -1;
      case 'lsp':
        runLsp(process.cwd());
        return -1;
      case 'reference':
        return cmdReference(json, rest.includes('--full'));
      case 'codes':
        return cmdCodes(rest, json);
      case 'version':
      case '--version':
        if (json) jsonOut({ schema: 1, ok: true, name: 'grhm', version: VERSION });
        else process.stdout.write(`grhm ${VERSION}\n`);
        return 0;
      default:
        process.stdout.write(HELP);
        return command === undefined || command === 'help' || command === '--help' ? 0 : 2;
    }
  } catch (err) {
    if (err instanceof CliError) {
      if (json) jsonOut({ schema: 1, ok: false, error: err.message });
      else process.stderr.write(`error: ${err.message}\n`);
      return err.exitCode;
    }
    const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
    if (json) jsonOut({ schema: 1, ok: false, code: 'E900', error: message });
    else process.stderr.write(`internal error (E900): ${message}\n`);
    return 3;
  }
}

const code = main(process.argv.slice(2));
if (code >= 0) process.exitCode = code;
