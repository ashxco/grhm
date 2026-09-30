import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { compile } from '../dist/codegen/index.js';
import { format } from '../dist/format.js';
import { parse } from '../dist/parser.js';
import { applyPatch } from '../dist/patch.js';

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
 *   agents depend on to self-repair.
 * - patches: each patch transcript applies atomically and lands the
 *   documented result.
 *
 * Run `npm run build` first; use --json for a machine-readable scorecard.
 */

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

const { repairs } = JSON.parse(fs.readFileSync(path.join(CORPUS, 'repairs.json'), 'utf8'));
for (const repair of repairs) {
  const brokenDiags = compile(repair.broken).diagnostics;
  const hit = brokenDiags.find((d) => d.code === repair.code);
  const actionable =
    hit !== undefined &&
    hit.span !== undefined &&
    (hit.received !== undefined || hit.expected !== undefined || (hit.suggestions !== undefined && hit.suggestions.length > 0));
  const fixedErrors = compile(repair.fixed).diagnostics.filter((d) => d.severity === 'error');
  results.repairs.push({
    name: repair.name,
    code: repair.code,
    ok: actionable && fixedErrors.length === 0,
    actionable,
    fixedClean: fixedErrors.length === 0,
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
const allOk =
  results.examples.every((r) => r.ok) && results.repairs.every((r) => r.ok) && results.patches.every((r) => r.ok);

if (json) {
  console.log(JSON.stringify({ schema: 1, ok: allOk, ...results }, null, 2));
} else {
  console.log(`examples  ${score(results.examples)} compile clean + canonical`);
  console.log(`repairs   ${score(results.repairs)} reproduce their code and fix clean (${actionableCount}/${results.repairs.length} with actionable metadata)`);
  console.log(`patches   ${score(results.patches)} apply and land the documented result`);
  for (const group of ['examples', 'repairs', 'patches']) {
    for (const r of results[group]) {
      if (!r.ok) console.log(`  FAIL ${group}: ${r.name}${r.errors !== undefined ? ' ' + r.errors.join(',') : ''}`);
    }
  }
  console.log(allOk ? 'scorecard: all green' : 'scorecard: FAILURES');
}
process.exit(allOk ? 0 : 1);
