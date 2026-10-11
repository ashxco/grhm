import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { compile } from '../dist/codegen/index.js';
import { applyFixes } from '../dist/fix.js';
import { format } from '../dist/format.js';
import { parse } from '../dist/parser.js';
import { applyPatch } from '../dist/patch.js';
import { loadRepairs } from '../dist/repairs.js';

/**
 * The corpus eval harness (PRD FR-15's machine-native mission): replays every
 * corpus task the way an agent would exercise the toolchain and emits a
 * scorecard. Categories:
 *
 * - examples: each program compiles with zero errors, is canonically
 *   formatted, and diagnostics stay empty after a format round-trip.
 * - repairs: each broken program emits its documented diagnostic code WITH
 *   actionable metadata (span + received/expected/suggestions), and the
 *   documented fix compiles clean. This scores diagnostic quality, the thing
 *   agents depend on to self-repair. A repair that declares a `fix` level must
 *   replay through `grhm fix` to exactly the documented program; one that does
 *   not must not become clean at level safe (so new auto-fixes get declared).
 * - patches: each patch transcript applies atomically and lands the
 *   documented result.
 *
 * Run `npm run build` first; use --json for a machine-readable scorecard.
 */

const canonical = (source) => format(parse(source).nodes);

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CORPUS = path.join(root, 'corpus');
const json = process.argv.includes('--json');

const results = { examples: [], repairs: [], patches: [] };

for (const file of fs.readdirSync(path.join(CORPUS, 'examples')).filter((f) => f.endsWith('.grhm')).sort()) {
  const source = fs.readFileSync(path.join(CORPUS, 'examples', file), 'utf8');
  const started = performance.now();
  const compiled = compile(source);
  const elapsedMs = performance.now() - started;
  const errors = compiled.diagnostics.filter((d) => d.severity === 'error');
  const canonical = format(parse(source).nodes) === source;
  const roundTrip = compile(format(parse(source).nodes)).diagnostics.filter((d) => d.severity === 'error');
  results.examples.push({
    name: file,
    ok: errors.length === 0 && canonical && roundTrip.length === 0,
    errors: errors.map((d) => d.code),
    canonical,
    files: compiled.files.size,
    elapsedMs: Math.round(elapsedMs * 10) / 10,
  });
}

const repairs = loadRepairs(path.join(CORPUS, 'repairs.json'));
for (const repair of repairs) {
  const brokenDiags = compile(repair.broken).diagnostics;
  const hit = brokenDiags.find((d) => d.code === repair.code);
  const actionable =
    hit !== undefined &&
    hit.span !== undefined &&
    (hit.received !== undefined || hit.expected !== undefined || (hit.suggestions !== undefined && hit.suggestions.length > 0));
  const fixedErrors = compile(repair.fixed).diagnostics.filter((d) => d.severity === 'error');
  const replay = applyFixes(repair.broken, { level: repair.fix ?? 'safe' });
  const replayClean = replay.ok && replay.clean;
  const replayExact = replayClean && replay.newSource !== undefined && canonical(replay.newSource) === canonical(repair.fixed);
  // An undeclared repair's documented diagnostic must survive bulk safe fixing (a refused run touches nothing; a warning-only transcript is always "clean").
  const ratchet = repair.fix !== undefined ? replayExact : !replay.ok || replay.diagnostics.some((d) => d.code === repair.code);
  results.repairs.push({
    name: repair.name,
    code: repair.code,
    ok: actionable && fixedErrors.length === 0 && ratchet,
    actionable,
    fixedClean: fixedErrors.length === 0,
    fix: repair.fix,
    replayExact,
    ratchet,
  });
}

const { patches } = JSON.parse(fs.readFileSync(path.join(CORPUS, 'patches.json'), 'utf8'));
for (const entry of patches) {
  const revision = compile(entry.source).revision;
  const applied = applyPatch(entry.source, entry.patch.replace('$REVISION', revision));
  results.patches.push({
    name: entry.name,
    ok: applied.ok && (applied.newSource ?? '').includes(entry.expect),
  });
}

const score = (items) => `${items.filter((r) => r.ok).length}/${items.length}`;
const actionableCount = results.repairs.filter((r) => r.actionable).length;
const declaredFixes = results.repairs.filter((r) => r.fix !== undefined);
const allOk =
  results.examples.every((r) => r.ok) && results.repairs.every((r) => r.ok) && results.patches.every((r) => r.ok);

if (json) {
  console.log(JSON.stringify({ schema: 1, ok: allOk, ...results }, null, 2));
} else {
  console.log(`examples  ${score(results.examples)} compile clean + canonical`);
  console.log(`repairs   ${score(results.repairs)} reproduce their code and fix clean (${actionableCount}/${results.repairs.length} with actionable metadata)`);
  console.log(`fixes     ${declaredFixes.filter((r) => r.replayExact).length}/${declaredFixes.length} declared repairs replay exactly`);
  console.log(`patches   ${score(results.patches)} apply and land the documented result`);
  for (const group of ['examples', 'repairs', 'patches']) {
    for (const r of results[group]) {
      if (r.ok) continue;
      const detail = r.errors !== undefined ? ' ' + r.errors.join(',') : r.ratchet === false ? (r.fix !== undefined ? ` (does not replay at level ${r.fix})` : ' (auto-fixable at level safe; declare "fix": "safe")') : '';
      console.log(`  FAIL ${group}: ${r.name}${detail}`);
    }
  }
  console.log(allOk ? 'scorecard: all green' : 'scorecard: FAILURES');
}
process.exit(allOk ? 0 : 1);
