import { compile } from '../dist/codegen/index.js';
import { applyPatch } from '../dist/patch.js';
import { parse } from '../dist/parser.js';
import { walkLists } from '../dist/ast.js';

/**
 * Performance measurement against the PRD 12.1 targets:
 * - full check+compile of a ~1,600-node program: P50 under 300 ms
 * - warm patch validation: P50 under 200 ms
 * Run `npm run build` first; this benchmarks the compiled dist/ output.
 */

function synthProgram(pages, cardsPerPage) {
  const lines = ['(app bench', '  (theme (token primary "#4f46e5"))', '  (state n 0)'];
  for (let p = 0; p < pages; p++) {
    lines.push(`  (page "/p${p}" page${p}`);
    lines.push('    (v :pad 32 :gap 16');
    lines.push(`      (heading "Page ${p}")`);
    lines.push('      (grid :cols 4 :cols-sm 1 :gap 16');
    for (let c = 0; c < cardsPerPage; c++) {
      lines.push(`        (card :pad 16 :gap 8 (txt "Item ${p}-${c}" :weight medium) (txt "Description ${c}") (btn "Add ${c}" (click (set n (+ n 1)))))`);
    }
    lines.push('      )))');
  }
  lines.push(')');
  return lines.join('\n');
}

function median(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function bench(label, runs, fn) {
  fn(); // warm up
  const samples = [];
  for (let i = 0; i < runs; i++) {
    const start = performance.now();
    fn();
    samples.push(performance.now() - start);
  }
  const p50 = median(samples);
  const p95 = [...samples].sort((a, b) => a - b)[Math.floor(samples.length * 0.95)];
  console.log(`${label}: p50 ${p50.toFixed(1)}ms  p95 ${p95.toFixed(1)}ms  (${runs} runs)`);
  return p50;
}

const source = synthProgram(10, 22);
let nodes = 0;
walkLists(parse(source).nodes, () => {
  nodes += 1;
});
console.log(`synthetic program: ${nodes} semantic nodes, ${source.length} bytes\n`);

const checkP50 = bench('full check + compile', 30, () => compile(source));

const compiled = compile(source);
const revision = compiled.revision;
// Any mid-program node id, taken from the source correlation map.
const map = JSON.parse(compiled.files.get('sourcemap.json') ?? '{}');
const targetId = Object.keys(map.nodes ?? {})[10] ?? '';
const patch = `(patch :revision "${revision}" :target ${targetId} (set gap 12))`;
const patchP50 = bench('warm patch validation', 30, () => applyPatch(source, patch));

console.log('\nPRD 12.1 targets: check p50 < 300ms, patch p50 < 200ms');
const ok = checkP50 < 300 && patchP50 < 200;
console.log(ok ? 'within targets' : 'OVER TARGET');
process.exit(ok ? 0 : 1);
