import { inspect, isDeepStrictEqual } from 'node:util';
import { transformWithOxc } from 'vite';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { type SExpr, opName, walkLists } from '../src/ast.js';
import { genExpr, newUses, type Binding } from '../src/codegen/expr.js';
import { compile } from '../src/codegen/index.js';
import { contextFromApp, evalExpr } from '../src/eval.js';
import { parse } from '../src/parser.js';
import { camelCase } from '../src/util.js';
import { EXPR_OPS } from '../src/schema.js';
import { BOUNDARY_EXPRESSIONS, expressions, minimize, serialize } from './parity-generator.js';

const APP = `(app parity
  (enum status open closed)
  (i18n (locale en (msg hello "Hello {name}")))
  (fn double ((value number)) (+ value value))
  (fn factorial ((value number)) (if (<= value 1) 1 (* value (factorial (- value 1)))))
  (page "/" home (txt "Parity")))`;
const app = compile(APP);
const context = contextFromApp(app.app);
const bindings = new Map<string, Binding>();
for (const name of app.app!.functions.keys()) bindings.set(name, { kind: 'fn', js: camelCase(name) });
for (const name of app.app!.enums.keys()) bindings.set(name, { kind: 'enum', js: '' });
let prelude: string;

beforeAll(async () => {
  expect(app.diagnostics.filter((diagnostic) => diagnostic.severity === 'error')).toEqual([]);
  const source = ['helpers.ts', 'i18n.ts', 'lib.ts'].map((name) => app.files.get(name) ?? '').join('\n')
    .replace(/^import .*$/gm, '').replace(/^export /gm, '');
  prelude = (await transformWithOxc(source, 'parity-prelude.ts')).code;
});

type Outcome = { threw: true } | { threw: false; value: unknown } | { compileError: string };
function outcome(run: () => unknown): Outcome {
  try { return { threw: false, value: run() }; } catch { return { threw: true }; }
}

async function compare(expr: SExpr): Promise<{ equal: boolean; interpreted: Outcome; compiled: Outcome }> {
  const interpreted = outcome(() => evalExpr(expr, context));
  let compiled: Outcome;
  try {
    const ts = genExpr(expr, { bindings, uses: newUses(), classFor: new Map(), sameFileComponents: new Set(), defaultLocale: 'en' });
    // Use a real TS transformer; regex-based annotation stripping can alter
    // string literals such as ": any" and conceal compiler/interpreter drift.
    const transformed = await transformWithOxc(`const result = () => (${ts});`, 'parity-case.ts');
    const evaluate = new Function(prelude + '\n' + transformed.code + '\nreturn result();');
    compiled = outcome(() => evaluate());
  } catch (error) {
    // Syntax/code-generation failures are also reduced and reported with a
    // replay seed, and must never count as equivalent runtime exceptions.
    compiled = { compileError: error instanceof Error ? error.message : String(error) };
  }
  // isDeepStrictEqual distinguishes null, undefined, NaN, infinity and -0,
  // including nested arrays/records; JSON normalization would erase these.
  return { equal: isDeepStrictEqual(interpreted, compiled), interpreted, compiled };
}

describe('seeded interpreter/compiler parity', () => {
  const extraSeed = process.env.GRHM_PARITY_SEED;
  const seeds = extraSeed === undefined ? [1, 42, 20260912, 0xdeadbeef, 0xffffffff] : [Number(extraSeed)];
  const count = Number(process.env.GRHM_PARITY_CASES ?? 200);

  it('matches time and random operations with controlled providers', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1234567890);
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.25);
    try {
      for (const source of ['(now)', '(random)']) {
        expect((await compare(parse(source).nodes[0]!)).equal).toBe(true);
      }
    } finally {
      clock.mockRestore();
      random.mockRestore();
    }
  });

  it.each(BOUNDARY_EXPRESSIONS)('preserves boundary semantics: %s', async (source) => {
    const parsed = parse(source);
    expect(parsed.diagnostics).toEqual([]);
    const result = await compare(parsed.nodes[0]!);
    expect(result.equal, `interpreted: ${inspect(result.interpreted)}\ncompiled: ${inspect(result.compiled)}`).toBe(true);
  });

  it.each(seeds)('matches bounded generated expressions for seed %s', async (seed) => {
    expect(Number.isSafeInteger(seed) && seed >= 0 && seed <= 0xffffffff).toBe(true);
    expect(Number.isSafeInteger(count) && count > 0 && count <= 100_000).toBe(true);
    for (const [index, source] of expressions(seed, count).entries()) {
      const parsed = parse(source);
      expect(parsed.diagnostics, source).toEqual([]);
      const expr = parsed.nodes[0]!;
      const result = await compare(expr);
      if (result.equal) continue;
      const reduced = await minimize(expr, async (candidate) => (await compare(candidate)).equal === false);
      const minimized = await compare(reduced);
      const details = `seed=${seed} case=${index}\noriginal: ${source}\nminimized: ${serialize(reduced)}\ninterpreted: ${inspect(minimized.interpreted)}\ncompiled: ${inspect(minimized.compiled)}\nReplay: GRHM_PARITY_SEED=${seed} GRHM_PARITY_CASES=${index + 1} npm test -- tests/parity-random.test.ts`;
      // Keep the same comparator as detection; looser assertion equality can
      // otherwise hide missing keys, sparse arrays, or other structural drift.
      expect(minimized.equal, details).toBe(true);
    }
  });

  it('generates deterministically and structurally shrinks a reproducible failure', async () => {
    expect(expressions(42, 10)).toEqual(expressions(42, 10));
    expect(expressions(42, 10)).not.toEqual(expressions(43, 10));
    const expr = parse('(let ((value (+ 4 8))) (concat "prefix" (to-str value)))').nodes[0]!;
    const reduced = await minimize(expr, async (candidate) => serialize(candidate).includes('concat'));
    expect(serialize(reduced).length).toBeLessThan(serialize(expr).length);
    expect(serialize(reduced)).toContain('concat');
    expect(parse(serialize(reduced)).diagnostics).toEqual([]);
  });

  it('covers the deterministic operation families in its default sample', () => {
    const covered = new Set<string>();
    for (const source of [...BOUNDARY_EXPRESSIONS, ...expressions(42, 200)]) {
      walkLists(parse(source).nodes, (node) => {
        const op = opName(node);
        if (op !== undefined) covered.add(op);
      });
    }
    // Every schema operation must execute in the parity corpus. Time and RNG
    // need controlled providers and are exercised separately below.
    const required = Object.keys(EXPR_OPS).filter((op) => op !== 'now' && op !== 'random');
    expect(required.filter((op) => !covered.has(op))).toEqual([]);
  });
});
