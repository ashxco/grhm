import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { analyze } from '../src/analyze.js';
import { Diagnostic } from '../src/diagnostics.js';
import { EvalError, contextFromApp, evalExpr, formatValue } from '../src/eval.js';
import { genExpr, newUses, type Binding, type GenCtx } from '../src/codegen/expr.js';
import { compile } from '../src/codegen/index.js';
import { parse } from '../src/parser.js';

/** The pure-core interpreter behind grhm eval/repl (PRD FR-11). */

function run(source: string, appSource?: string): unknown {
  const scratch: Diagnostic[] = [];
  const app = appSource !== undefined ? analyze(parse(appSource).nodes, scratch) : undefined;
  const nodes = parse(source).nodes;
  expect(nodes.length).toBeGreaterThan(0);
  let result: unknown;
  for (const node of nodes) result = evalExpr(node, contextFromApp(app));
  return result;
}

// Runtime helpers the compiled output calls. Their internals are covered by
// the codegen-tsc and example suites; here they just need to be in scope so
// the parity check exercises genExpr vs evalExpr on the operations themselves.
const sortBy = (key: (x: any) => any, xs: unknown[]): unknown[] =>
  [...(xs ?? [])].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
const range = (from: number, to: number): number[] => {
  const out: number[] = [];
  for (let i = from; i < to; i += 1) out.push(i);
  return out;
};
const sum = (xs: unknown[]): number => (xs ?? []).reduce((acc: number, x: unknown) => acc + Number(x), 0);
const toNum = (value: unknown): number | null => (Number.isNaN(Number(value)) ? null : Number(value));
const dateParse = (text: string): number | null => (Number.isNaN(Date.parse(text)) ? null : Date.parse(text));

/** Lower one pure expression to JS and run it with the runtime helpers in scope. */
function runCompiled(source: string, bindings = new Map<string, Binding>()): unknown {
  const node = parse(source).nodes[0]!;
  const ctx: GenCtx = { bindings, classFor: new Map(), uses: newUses(), sameFileComponents: new Set() };
  // genExpr targets TypeScript; drop the `: any` param annotations and `as any`
  // casts it emits so the result is runnable JS.
  const js = genExpr(node, ctx)
    .replace(/ as any/g, '')
    .replace(/: any/g, '');
  return new Function('sortBy', 'range', 'sum', 'toNum', 'dateParse', `return (${js});`)(sortBy, range, sum, toNum, dateParse);
}

const norm = (v: unknown): unknown => JSON.parse(JSON.stringify(v ?? null));

describe('grhm eval: pure core interpreter', () => {
  it('evaluates literals and arithmetic', () => {
    expect(run('(+ 1 2 3)')).toBe(6);
    expect(run('(- 10 4)')).toBe(6);
    expect(run('(- 5)')).toBe(-5);
    expect(run('(* 2 3 4)')).toBe(24);
    expect(run('(/ 12 4)')).toBe(3);
    expect(run('(mod 7 3)')).toBe(1);
    expect(run('(pow 2 10)')).toBe(1024);
    expect(run('(max 1 9 4)')).toBe(9);
  });

  it('matches compiled + semantics: strings concatenate', () => {
    expect(run('(+ "a" "b")')).toBe('ab');
    expect(run('(concat "n=" 4)')).toBe('n=4');
  });

  it('evaluates comparisons and logic', () => {
    expect(run('(= 1 1)')).toBe(true);
    expect(run('(!= "a" "b")')).toBe(true);
    expect(run('(and (< 1 2) (>= 2 2))')).toBe(true);
    expect(run('(or false (not false))')).toBe(true);
  });

  it('evaluates strings and lists', () => {
    expect(run('(upper (trim "  hi  "))')).toBe('HI');
    expect(run('(join "-" (arr 1 2 3))')).toBe('1-2-3');
    expect(run('(split "," "a,b,c")')).toEqual(['a', 'b', 'c']);
    expect(run('(map (lambda (x) (* x x)) (arr 1 2 3))')).toEqual([1, 4, 9]);
    expect(run('(filter (lambda (x) (> x 1)) (arr 1 2 3))')).toEqual([2, 3]);
    expect(run('(reduce (lambda (acc x) (+ acc x)) 0 (range 1 5))')).toBe(10);
    expect(run('(sort-by (lambda (x) x.k) (arr (obj :k 2) (obj :k 1)))')).toEqual([{ k: 1 }, { k: 2 }]);
    expect(run('(sum (arr 1 2 3))')).toBe(6);
    expect(run('(take 2 (reverse (arr 1 2 3)))')).toEqual([3, 2]);
    expect(run('(contains "hello" "ell")')).toBe(true);
  });

  it('evaluates special forms: if, let, cond, match', () => {
    expect(run('(if (> 2 1) "yes" "no")')).toBe('yes');
    expect(run('(let ((x 3) (y (* x 2))) (+ x y))')).toBe(9);
    expect(run('(cond ((> 1 2) "a") ((> 2 1) "b") (else "c"))')).toBe('b');
    expect(run('(match "open" ("open" 1) ("closed" 2) (else 0))')).toBe(1);
    expect(run('(match "gone" ("open" 1) (else 0))')).toBe(0);
  });

  it('evaluates records and null handling', () => {
    expect(run('(get (obj :a 1 :b 2) "b")')).toBe(2);
    expect(run('(or-else null "fallback")')).toBe('fallback');
    expect(run('(is-null null)')).toBe(true);
    expect(run('(not-null 0)')).toBe(true);
    expect(run('(attempt (nth 0 (arr 7)) -1)')).toBe(7);
  });

  it('templates via fmt', () => {
    expect(run('(fmt "Hi {name}, {n} new" :name "Ada" :n 3)')).toBe('Hi Ada, 3 new');
  });

  it('counts strings and preserves template coercions and path escaping', () => {
    expect(run('(count "hello")')).toBe(5);
    expect(run('(count null)')).toBe(0);
    expect(run('(fmt "{value}" :value null)')).toBe('null');
    expect(run('(fmt "{value}" :value (first (arr)))')).toBe('undefined');
    expect(run('(path "/items/{id}" :id "a/b ?#é")')).toBe('/items/a%2Fb%20%3F%23%C3%A9');
  });

  it('preserves lexical shadowing and the scopes captured by closures', () => {
    const cases: [string, number][] = [
      ['(let ((x 3)) (let ((x (+ x 1))) x))', 4],
      ['(let ((x 3)) (let ((y x) (x 7)) (+ x y)))', 10],
      ['(let ((x 3)) (let ((x (+ x 1))) (let ((x (+ x 1))) x)))', 5],
      ['(let ((x 1)) (let ((read-x (lambda (ignored) x)) (x 2)) (first (map read-x (arr 0)))))', 1],
      ['(let ((foo1 1)) (let ((foo-1 (+ foo1 1))) (+ foo-1 foo1)))', 3],
      ['(let ((sum 2)) (+ sum (sum (arr 1 2))))', 5],
      ['(first (map (lambda (range) (+ range (count (range 0 3)))) (arr 2)))', 5],
    ];
    for (const [source, expected] of cases) {
      expect(compile(`(app a (page "/" home (txt ${source})))`).diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
      expect(run(source)).toBe(expected);
      expect(runCompiled(source)).toBe(expected);
    }
  });

  it('allows lexical bindings to shadow enum names', () => {
    const app = '(app a (enum status open closed) (page "/" home (txt "x")))';
    const source = '(let ((status (arr 7))) (first status))';
    expect(run(source, app)).toBe(7);
    expect(runCompiled(source, new Map([['status', { kind: 'enum', js: 'status' }]]))).toBe(7);
  });

  it('generates strict TypeScript for shadowing and helper-named function parameters', () => {
    const source = `(app a
      (i18n (locale en (msg hi "Hi")))
      (fn total ((sum number)) (+ sum (sum (arr 1 2))))
      (fn numbers ((range number)) (+ range (count (range 0 3))))
      (fn localized ((t-msg string)) (concat t-msg (t hi)))
      (fn text-size () (count "hello"))
      (fn shadow ((x number)) (let ((x (+ x 1))) x))
      (fn closure ((x number))
        (let ((read-x (lambda (ignored) x)) (x 7))
          (first (map read-x (arr 0)))))
      (fn branch ((x number)) (match x (0 "zero") (1 "one") (else "other")))
      (page "/" home (txt (total 4))))`;
    const generated = compile(source);
    expect(generated.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    const root = path.join(__dirname, '..');
    const directory = fs.mkdtempSync(path.join(root, '.tmp-eval-'));
    try {
      for (const name of ['lib.ts', 'helpers.ts', 'i18n.ts']) fs.writeFileSync(path.join(directory, name), generated.files.get(name)!);
      fs.writeFileSync(path.join(directory, 'tsconfig.json'), JSON.stringify({
        compilerOptions: {
          target: 'ES2022', module: 'ESNext', moduleResolution: 'bundler', strict: true,
          skipLibCheck: true, noEmit: true, allowImportingTsExtensions: true, types: ['node'],
        },
        include: ['*.ts'],
      }));
      const tsc = path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'tsc.cmd' : 'tsc');
      const result = spawnSync(tsc, ['-p', path.join(directory, 'tsconfig.json')], { encoding: 'utf8' });
      expect(result.status, result.stdout + result.stderr).toBe(0);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('evaluates a match scrutinee exactly once', () => {
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.5);
    try {
      for (const source of [
        '(match (random) (0 "zero") (0.5 "half") (else "other"))',
        '(match (random) (else "half"))',
      ]) {
        for (const evaluate of [run, runCompiled]) {
          random.mockClear();
          expect(evaluate(source)).toBe('half');
          expect(random).toHaveBeenCalledTimes(1);
        }
      }
    } finally {
      random.mockRestore();
    }
  });

  it('calls user fns and reads enums from a project', () => {
    const app = '(app a (enum status open closed) (fn double ((x number)) (* x 2)) (fn shout ((s string)) (upper s)) (page "/" home (txt "x")))';
    expect(run('(double 21)', app)).toBe(42);
    expect(run('(shout "hey")', app)).toBe('HEY');
    expect(run('status.open', app)).toBe('open');
    expect(run('(match status.open ("open" "O") ("closed" "C"))', app)).toBe('O');
  });

  it('supports recursion in user fns', () => {
    const app = '(app a (fn fact ((n number)) (if (<= n 1) 1 (* n (fact (- n 1))))) (page "/" home (txt "x")))';
    expect(run('(fact 10)', app)).toBe(3628800);
  });

  it('resolves i18n messages with the default locale', () => {
    const app = '(app a (i18n (locale en (msg hi "Hello, {name}!"))) (page "/" home (txt (t hi :name "x"))))';
    expect(run('(t hi :name "Ada")', app)).toBe('Hello, Ada!');
    expect(run('(t hi :name null)', app)).toBe('Hello, null!');
  });

  it('rejects non-pure references with a clear error', () => {
    expect(() => run('(count items)')).toThrow(EvalError);
    expect(() => run('(select users)')).toThrow(/pure core/);
    expect(() => run('(frobnicate 1)')).toThrow(/unknown operation/);
  });

  it('formats values for display', () => {
    expect(formatValue(run('(arr 1 "a" true null)'))).toBe('[1,"a",true,null]');
    expect(formatValue(run('(lambda (x) x)'))).toBe('#<fn>');
    expect(formatValue(undefined)).toBe('null');
    // Non-finite numbers print as themselves, so they never read as the null of an unparseable to-num.
    expect(formatValue(run('(/ 0 0)'))).toBe('NaN');
    expect(formatValue(run('(to-num "1e309")'))).toBe('Infinity');
    expect(formatValue(run('(to-num "-1e309")'))).toBe('-Infinity');
    expect(formatValue(run('(to-num "x")'))).toBe('null');
    expect(formatValue(run('(to-str (/ 0 0))'))).toBe('"NaN"');
    expect(formatValue(run('(obj :a (/ 1 0) :b (to-num "x") :c (arr 0 (/ 0 0)))'))).toBe('{"a":Infinity,"b":null,"c":[0,NaN]}');
  });

  // The interpreter (src/eval.ts) and the codegen lowering (codegen/expr.ts)
  // must agree on every pure operation. This runs both paths on the same
  // expressions and asserts identical results, so neither can drift silently.
  it('interpreter and compiled output agree on pure semantics', () => {
    const cases = [
      '(+ 1 2 3)',
      '(- 10 4)',
      '(* 2 3 4)',
      '(/ 12 4)',
      '(mod 7 3)',
      '(pow 2 10)',
      '(max 1 9 4)',
      '(min 3 1 2)',
      '(round 2.6)',
      '(to-fixed 2 3.14159)',
      '(to-num "42")',
      '(to-num "abc")',
      '(to-num "")',
      '(to-num null)',
      '(or-else (to-num "x") 0)',
      '(+ 1 (to-num "x"))',
      '(to-fixed 2 (or-else (to-num "x") 0))',
      '(date-parse "1970-01-01T00:00:00.000Z")',
      '(date-parse "nope")',
      '(is-null (date-parse ""))',
      '(+ "a" "b")',
      '(concat "n=" 4)',
      '(upper (trim "  hi  "))',
      '(lower "HELLO")',
      '(join "-" (arr 1 2 3))',
      '(split "," "a,b,c")',
      '(replace "a" "b" "banana")',
      '(starts-with "hello" "he")',
      '(ends-with "hello" "lo")',
      '(slice 1 3 "abcdef")',
      '(= 1 1)',
      '(!= "a" "b")',
      '(and (< 1 2) (>= 2 2))',
      '(or false (not false))',
      '(map (lambda (x) (* x x)) (arr 1 2 3))',
      '(filter (lambda (x) (> x 1)) (arr 1 2 3))',
      '(reduce (lambda (acc x) (+ acc x)) 0 (range 1 5))',
      '(sort-by (lambda (x) x.k) (arr (obj :k 2) (obj :k 1)))',
      '(sum (arr 1 2 3))',
      '(count (arr 1 2 3))',
      '(count "hello")',
      '(count null)',
      '(take 2 (reverse (arr 1 2 3)))',
      '(drop 1 (arr 1 2 3))',
      '(first (arr 9 8 7))',
      '(last (arr 9 8 7))',
      '(nth 1 (arr 9 8 7))',
      '(append (arr 1 2) 3)',
      '(contains "hello" "ell")',
      '(some (lambda (x) (> x 2)) (arr 1 2 3))',
      '(every (lambda (x) (> x 0)) (arr 1 2 3))',
      '(find (lambda (x) (> x 1)) (arr 1 2 3))',
      '(if (> 2 1) "yes" "no")',
      '(let ((x 3) (y (* x 2))) (+ x y))',
      '(cond ((> 1 2) "a") ((> 2 1) "b") (else "c"))',
      '(match "open" ("open" 1) ("closed" 2) (else 0))',
      '(match "gone" ("open" 1) (else 0))',
      '(get (obj :a 1 :b 2) "b")',
      '(or-else null "fallback")',
      '(is-null null)',
      '(not-null 0)',
      '(let ((item (first (arr)))) (attempt item.name "missing"))',
      '(fmt "Hi {name}, {n} new" :name "Ada" :n 3)',
      '(fmt "Hi {name}" :name "A B")',
      '(fmt "{value}" :value null)',
      '(fmt "{value}" :value (first (arr)))',
      '(path "/items/{id}" :id "a/b ?#é")',
    ];
    for (const src of cases) {
      expect({ src, value: norm(runCompiled(src)) }).toEqual({ src, value: norm(run(src)) });
    }
  });
});
