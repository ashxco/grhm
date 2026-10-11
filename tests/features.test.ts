import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { getEncoding } from 'js-tiktoken';

import { compile } from '../src/codegen/index.js';
import { FixConfidence } from '../src/diagnostics.js';
import { applyTextEdits } from '../src/fix.js';
import { format } from '../src/format.js';
import { parse } from '../src/parser.js';
import { applyPatchToProject } from '../src/patch.js';
import { compileProject, loadProject, projectRevision, ReadFile } from '../src/project.js';
import { generateReference, referenceTokenEstimate } from '../src/reference.js';
import { findReferences, resolveSymbol, symbolAt, validNewName } from '../src/references.js';
import { genPlaywrightSpec, genVitestSpec, playwrightConfig } from '../src/testgen.js';

const FIXTURE = fs.readFileSync(path.join(__dirname, 'fixtures', 'store.grhm'), 'utf8');

function codesOf(source: string): string[] {
  return compile(source).diagnostics.map((d) => d.code);
}

const wrap = (body: string): string => `(app a (page "/" home ${body}))`;

describe('interop', () => {
  it('accepts use declarations and direct calls of imported functions', () => {
    const src = `(app a
      (use "./lib/helpers.ts" (import slugify))
      (page "/" home (txt (slugify "Hello World"))))`;
    const result = compile(src);
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    const page = result.files.get('pages/home.tsx') ?? '';
    expect(page).toContain('import { slugify } from "../../../lib/helpers";');
    expect(page).toContain('slugify("Hello World")');
  });

  it('supports default imports and js-name aliases', () => {
    const src = `(app a
      (use "canvas-confetti" (import-default confetti))
      (use "date-fns" (import ago formatDistanceToNow))
      (page "/" home (btn "Party" (click (confetti)))))`;
    const result = compile(src);
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    const page = result.files.get('pages/home.tsx') ?? '';
    expect(page).toContain('import confetti from "canvas-confetti";');
    expect(page).toContain('confetti()');
  });

  it('rejects JavaScript export aliases that cannot be emitted in an import specifier', () => {
    expect(codesOf(`(app a (use "pkg" (import helper foo-bar)) (page "/" home (txt "x")))`)).toContain('E601');
    expect(codesOf(`(app a (use "pkg" (import helper pkg/name)) (page "/" home (txt "x")))`)).toContain('E601');
  });

  it('serializes module specifiers without allowing import-statement injection', () => {
    const moduleName = `react'; fetch('/pwn'); import 'react`;
    const src = `(app a
      (use ${JSON.stringify(moduleName)} (import make createElement))
      (page "/" home (txt (make "span" null))))`;
    const result = compile(src);
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    const page = result.files.get('pages/home.tsx') ?? '';
    expect(page).toContain(`import { createElement as make } from ${JSON.stringify(moduleName)};`);
    expect(page).not.toContain("from 'react'; fetch('/pwn')");
  });

  it('warns W601 on browser-global calls but still compiles', () => {
    const src = wrap('(btn "Save" (click (call localStorage.setItem "k" "v")))');
    const result = compile(src);
    expect(result.diagnostics.some((d) => d.code === 'W601')).toBe(true);
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect([...result.files.values()].join()).toContain('localStorage.setItem("k", "v")');
  });

  it('rejects malformed use forms with E601', () => {
    expect(codesOf('(app a (use bad-module) (page "/" home (txt "x")))')).toContain('E601');
    expect(codesOf('(app a (use "pkg" (txt "not an import")) (page "/" home (txt "x")))')).toContain('E601');
  });

  it('rejects calls to unknown targets with E201', () => {
    expect(codesOf(wrap('(btn "Go" (click (call nonexistent.fn)))'))).toContain('E201');
  });
});

describe('widgets', () => {
  it('requires :open on dialog', () => {
    expect(codesOf(wrap('(dialog (txt "hi"))'))).toContain('E106');
  });

  it('rejects non-tab children of tabs', () => {
    expect(codesOf(wrap('(tabs (txt "loose"))'))).toContain('E110');
  });

  it('rejects non-col children of table', () => {
    expect(codesOf(wrap('(table row (arr) (txt "loose"))'))).toContain('E110');
  });

  it('generates tabs with synthesized state and aria roles', () => {
    const result = compile(wrap('(tabs (tab "A" (txt "a")) (tab "B" (txt "b")))'));
    const page = result.files.get('pages/home.tsx') ?? '';
    expect(page).toContain('useState<number>(0)');
    expect(page).toContain('role="tablist"');
    expect(page).toContain('aria-selected=');
  });

  it('generates menus that close on item activation', () => {
    const src = `(app a (state mode "x") (page "/" home
      (menu "Options" (item "Reset" (set mode "x")))))`;
    const page = compile(src).files.get('pages/home.tsx') ?? '';
    expect(page).toContain('.triggerProps}');
    expect(page).toContain('role="menuitem"');
    expect(page).toContain('.close(); setMode("x");');
  });

  it('generates tables with headers and row-scoped cells', () => {
    const src = `(app a
      (data (resource items "/api/items.json" :default (arr)))
      (page "/" home
        (if items.loading (txt "...")
          (table it items.data (col "Name" it.name) (col "Qty" it.qty)))))`;
    const page = compile(src).files.get('pages/home.tsx') ?? '';
    expect(page).toContain('<thead>');
    expect(page).toContain('{it.name}');
    expect(page).toContain('.map((it: any, index: number)');
  });

  it('generates forms that prevent default submission', () => {
    const src = `(app a (page "/" home
      (local q "")
      (form (submit (set q "")) (input :value q))))`;
    const page = compile(src).files.get('pages/home.tsx') ?? '';
    expect(page).toContain('__grhmEvent.preventDefault();');
    expect(page).toContain('setQ("")');
  });

  it('writes native widget values using the bound state primitive', () => {
    const src = `(app a
      (uploads)
      (state amount 0)
      (state amount-string-type 0)
      (state accepted false)
      (state open false)
      (state active-tab 0)
      (state upload-url "")
      (state choice "a")
      (page "/" home
        (v
          (input :type number :value amount)
          (input :type "number" :value amount-string-type)
          (checkbox :checked accepted)
          (dialog :open open (txt "inside"))
          (tabs :value active-tab (tab "A" (txt "a")))
          (file-input :to upload-url)
          (select :value choice :options (arr "a" "b")))))`;
    const result = compile(src);
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    const page = result.files.get('pages/home.tsx') ?? '';
    expect(page).toContain('setAmount(__grhmEvent.target.valueAsNumber)');
    expect(page).toContain('setAmountStringType(__grhmEvent.target.valueAsNumber)');
    expect(page).toContain('setAccepted(__grhmEvent.target.checked)');
    expect(page).toContain('setOpen(false)');
    expect(page).toContain('setActiveTab(0)');
    expect(page).toContain('uploadFile(file).then(setUploadUrl)');
    expect(page).toContain('setChoice(__grhmEvent.target.value)');
  });

  it('rejects writable widget bindings with incompatible primitive types', () => {
    const cases = [
      '(state value "1") (page "/" home (input :type number :value value))',
      '(state value 1) (page "/" home (input :value value))',
      '(state value "yes") (page "/" home (checkbox :checked value))',
      '(state value 1) (page "/" home (dialog :open value (txt "x")))',
      '(state value false) (page "/" home (tabs :value value (tab "A" (txt "a"))))',
      '(uploads) (state value false) (page "/" home (file-input :to value))',
      '(state value 1) (page "/" home (select :value value :options (arr "a")))',
    ];
    for (const body of cases) expect(codesOf(`(app a ${body})`)).toContain('E111');
  });
});

describe('motion', () => {
  it('lowers :enter to a reduced-motion-guarded animation', () => {
    const css = compile(wrap('(v :enter fade-up :dur 200 :delay 50 :ease spring (txt "x"))')).files.get('styles.css') ?? '';
    expect(css).toContain('@media (prefers-reduced-motion: no-preference)');
    expect(css).toContain('animation: g-fade-up 200ms cubic-bezier(0.22, 1, 0.36, 1) both');
    expect(css).toContain('animation-delay: 50ms');
    expect(css).toContain('@keyframes g-fade-up');
  });

  it('rejects unknown motion kinds', () => {
    expect(codesOf(wrap('(v :enter wobble (txt "x"))'))).toContain('E103');
  });

  it('lowers :stagger to per-child animation delays', () => {
    const css = compile(wrap('(v :enter fade :stagger 80 :delay 100 (txt "a") (txt "b"))')).files.get('styles.css') ?? '';
    expect(css).toContain('> * {');
    expect(css).toContain('animation: g-fade 300ms ease-out both');
    expect(css).toContain(':nth-child(1)');
    expect(css).toContain('animation-delay: 100ms');
    expect(css).toContain('animation-delay: 180ms');
  });

  it('requires :enter alongside :stagger', () => {
    expect(codesOf(wrap('(v :stagger 80 (txt "a"))'))).toContain('E106');
  });

  it('lowers :hover gestures to guarded transitions', () => {
    const css = compile(wrap('(card :hover lift (txt "x"))')).files.get('styles.css') ?? '';
    expect(css).toContain('transition: transform 150ms ease');
    expect(css).toContain(':hover,');
    expect(css).toContain('transform: translateY(-2px)');
    expect(css).toContain('@media (prefers-reduced-motion: no-preference)');
  });

  it('rejects unknown hover gestures', () => {
    expect(codesOf(wrap('(card :hover spin (txt "x"))'))).toContain('E103');
  });
});

describe('safe CSS literals', () => {
  it('rejects structural CSS injection in style props and theme tokens', () => {
    const style = compile(wrap('(txt "safe" :color "red; } body { display:none }")'));
    expect(style.diagnostics.map((d) => d.code)).toContain('E103');
    expect(style.files.size).toBe(0);

    const token = compile('(app a (theme (token primary "red; } body { display:none }")) (page "/" home (txt "x")))');
    expect(token.diagnostics.map((d) => d.code)).toContain('E103');
    expect(token.files.size).toBe(0);

    expect(codesOf(wrap('(v :w "url(https://example.invalid/x)" (txt "x"))'))).toContain('E103');
  });

  it('keeps ordinary color, spacing, calc, and function values valid', () => {
    const result = compile(`(app a
      (theme (token primary "color-mix(in srgb, #fff 80%, #000)"))
      (page "/" home (v :w "calc(100% - 2rem)" :margin "0 auto" (txt "x" :color $primary))))`);
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  });
});

describe('functions and stdlib', () => {
  it('compiles user-defined functions into a shared lib module', () => {
    const src = `(app a
      (fn double (x) (* x 2))
      (page "/" home (txt (double 21))))`;
    const result = compile(src);
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(result.files.get('lib.ts')).toContain('export function double(x: any): number {');
    const page = result.files.get('pages/home.tsx') ?? '';
    expect(page).toContain("import { double } from '../lib';");
    expect(page).toContain('double(21)');
  });

  it('supports recursion', () => {
    const src = `(app a
      (fn fact (n) (if (<= n 1) 1 (* n (fact (- n 1)))))
      (page "/" home (txt (fact 5))))`;
    const result = compile(src);
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(result.files.get('lib.ts')).toContain('fact((n - 1))');
  });

  it('lowers lambda, let, and if-expressions', () => {
    const src = `(app a
      (fn describe-nums (xs)
        (let ((evens (filter (lambda (x) (= (mod x 2) 0)) xs)))
          (if (> (count evens) 0) (join ", " evens) "none")))
      (page "/" home (txt (describe-nums (arr 1 2 3 4)))))`;
    const result = compile(src);
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    const lib = result.files.get('lib.ts') ?? '';
    expect(lib).toContain('const evens =');
    expect(lib).toContain('.filter((x: any) =>');
    expect(lib).toContain('? (');
  });

  it('imports runtime helpers used by stdlib ops', () => {
    const src = wrap('(txt (sum (map (lambda (x) (* x x)) (range 1 4))))');
    const result = compile(src);
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    const page = result.files.get('pages/home.tsx') ?? '';
    expect(page).toContain("import { range, sum } from '../runtime';");
    expect(page).toContain('sum(((range(1, 4)) ?? []).map(');
  });

  it('reports wrong argument counts on fn calls with E112', () => {
    const src = `(app a (fn double (x) (* x 2)) (page "/" home (txt (double 1 2))))`;
    expect(codesOf(src)).toContain('E112');
  });

  it('reports lambda arity mismatches with E112', () => {
    expect(codesOf(wrap('(txt (count (map (lambda (a b) a) (arr 1))))'))).toContain('E112');
    expect(codesOf(wrap('(txt (reduce (lambda (acc) acc) 0 (arr 1)))'))).toContain('E112');
  });

  it('keeps fn bodies pure: state references are out of scope', () => {
    const src = `(app a
      (state total 0)
      (fn bad () (+ total 1))
      (page "/" home (txt (bad))))`;
    expect(codesOf(src)).toContain('E201');
  });

  it('rejects duplicate fn/state names with E107', () => {
    const src = `(app a (state x 0) (fn x (y) y) (page "/" home (txt x)))`;
    expect(codesOf(src)).toContain('E107');
  });

  it('rejects malformed special forms with E109', () => {
    expect(codesOf(wrap('(txt (if true 1))'))).toContain('E109');
    expect(codesOf(wrap('(txt (let (x 1) x))'))).toContain('E109');
    expect(codesOf(wrap('(txt (lambda (x)))'))).toContain('E109');
  });

  it('resolves and renames fns across call sites', () => {
    const src = `(app a
      (fn tax (p) (* p 1.2))
      (page "/" home (txt (tax 10) " " (map tax (arr 1 2)))))`;
    const { nodes } = parse(src);
    const info = resolveSymbol(nodes, 'tax');
    expect(info?.kind).toBe('fn');
    expect(info?.renameable).toBe(true);
    expect(findReferences(nodes, info!)).toHaveLength(3);
  });

  it('scopes lambda params and lets them shadow globals', () => {
    const src = `(app a
      (state x 5)
      (fn id (x) x)
      (page "/" home (txt x)))`;
    const { nodes } = parse(src);
    const info = resolveSymbol(nodes, 'x');
    expect(info?.kind).toBe('state');
    // The fn param shadows the state, so only the decl + page read remain.
    expect(findReferences(nodes, info!)).toHaveLength(2);
  });
});

describe('throwing operations (W801)', () => {
  const handler = (expr: string): string => `(app a (db (table notes (id auto) (text string))) (api (post "/api/notes" ${expr})) (page "/" home (txt "x")))`;

  it('warns W801 on a dynamic operand in a handler and in a page, and the app still compiles', () => {
    const api = compile(handler('(json-parse body.text)'));
    expect(api.diagnostics.map((d) => [d.code, d.message])).toEqual([['W801', '"json-parse" may throw at runtime; wrap in (attempt expr fallback)']]);
    expect(api.files.size).toBeGreaterThan(0);
    const page = compile('(app a (state pattern "a") (state s "b") (page "/" home (txt (if (regex-test pattern s) "yes" "no"))))');
    expect(page.diagnostics.map((d) => d.code)).toEqual(['W801']);
    expect(page.diagnostics[0]).toMatchObject({ severity: 'warning', op: 'regex-test', expected: 'literal operands or an enclosing (attempt expr fallback)' });
    expect(page.files.size).toBeGreaterThan(0);
    expect(codesOf('(app a (state raw "[]") (state parsed (json-parse raw)) (page "/" home (txt "x")))')).toEqual(['W801']);
  });

  it('stays quiet inside the guarded operand of attempt, in fn bodies, in expect-eq, and for verified literals', () => {
    expect(codesOf('(app a (state p "a") (state s "b") (page "/" home (txt (if (attempt (regex-test p s) false) "yes" "no"))))')).toEqual([]);
    expect(codesOf(handler('(attempt (json-parse body.text) (fail 400 "text must be JSON"))'))).toEqual([]);
    expect(codesOf('(app a (fn p ((s string)) (json-parse s)) (page "/" home (txt "x")))')).toEqual([]);
    expect(codesOf('(app a (page "/" home (txt "x")))\n(tests (test "t" (expect-eq (json-parse "[1]") (arr 1))))')).toEqual([]);
    expect(codesOf(wrap('(txt (json-stringify (json-parse "[1]")) (if (regex-test "^a" "abc" "i") "y" "n") (url-decode "a%2Fb") (date-iso 0) (json-stringify (chunk 2 (arr 1))))'))).toEqual([]);
    // Only the pattern and flags of a regex op can throw; the text may be anything.
    expect(codesOf('(app a (state s "") (page "/" home (txt (regex-replace "a" "b" s))))')).toEqual([]);
    // The fallback operand of attempt is not guarded.
    expect(codesOf('(app a (state s "") (page "/" home (txt (attempt "x" (json-parse s)))))')).toEqual(['W801']);
  });

  it('rejects literal operands that can never work with E109, even inside attempt', () => {
    const cases: [string, string, string][] = [
      ['(json-stringify (json-parse "{bad"))', 'invalid JSON literal: ', '{bad'],
      ['(if (regex-test "[" "abc") "y" "n")', 'invalid regular expression: ', '['],
      ['(regex-replace "a" "b" "abc" "z")', 'invalid regular expression: ', 'z'],
      ['(url-decode "%")', 'invalid URL component literal: ', '%'],
      ['(json-stringify (chunk 0 (arr 1)))', 'invalid chunk size: ', '0'],
      ['(date-iso 86400000000000000)', 'invalid date literal: ', '86400000000000000'],
    ];
    for (const [expr, prefix, received] of cases) {
      const result = compile(wrap(`(txt ${expr})`));
      const error = result.diagnostics.find((d) => d.code === 'E109');
      expect(error?.message.startsWith(prefix), expr).toBe(true);
      expect(error, expr).toMatchObject({ received });
      expect(error?.expected, expr).toBeDefined();
      expect(result.files.size).toBe(0);
    }
    expect(codesOf(wrap('(txt (if (attempt (regex-test "[" "abc") false) "y" "n"))'))).toEqual(['E109']);
  });

  it('verifies a literal flags operand on its own, whatever the pattern', () => {
    const page = (expr: string): string => `(app a (state p "a") (state f "i") (page "/" home (txt ${expr})))`;
    const cases: [string, string][] = [['(regex-test p "x" "bad")', 'bad'], ['(regex-find p "x" "zz")', 'zz'], ['(regex-replace p "r" "x" "gg")', 'gg']];
    for (const [expr, received] of cases) {
      const result = compile(page(expr));
      expect(result.diagnostics.map((d) => [d.code, d.received, d.expected]), expr).toEqual([['E109', received, 'RegExp flags']]);
      expect(result.files.size, expr).toBe(0);
    }
    expect(codesOf('(app a (fn hit ((p string)) (regex-test p "x" "bad")) (page "/" home (txt (hit "q"))))')).toEqual(['E109']);
    // Valid literal flags over a dynamic pattern, or a literal pattern under dynamic flags, stay dynamic.
    expect(codesOf(page('(regex-test p "abc" "i")'))).toEqual(['W801']);
    expect(codesOf(page('(regex-test "abc" "abc" f)'))).toEqual(['W801']);
  });

  it('reports a fn whose body may throw at its call sites, with the wrap on the call', () => {
    const fns = '(fn p ((s string)) (json-parse s)) (fn q ((s string)) (p s)) (fn guarded ((s string)) (attempt (json-parse s) null))';
    const app = (expr: string): string => `(app a ${fns} (db (table notes (id auto) (text string))) (api (post "/api/notes" (input (text string)) ${expr})) (page "/" home (txt "x")))`;
    const call = compile(app('(p body.text)'));
    expect(call.diagnostics.map((d) => [d.code, d.message])).toEqual([['W801', '"p" may throw at runtime (its body has an unguarded throwing operation); wrap the call in (attempt expr fallback)']]);
    expect(call.diagnostics[0]?.fixes?.map((f) => [f.confidence, f.title])).toEqual([['placeholder', 'Wrap in (attempt … null) (fill in)']]);
    expect(call.files.size).toBeGreaterThan(0);
    expect(codesOf(app('(call p body.text)'))).toEqual(['W801']);
    // Through another fn, whatever the declaration order.
    expect(codesOf(app('(q body.text)'))).toEqual(['W801']);
    expect(codesOf('(app a (fn q ((s string)) (p s)) (fn p ((s string)) (json-parse s)) (state raw "") (page "/" home (txt (json-stringify (q raw)))))')).toEqual(['W801']);
    // A bare fn reference is invoked by the consuming op, so the warning names it and offers no wrap.
    const mapped = compile(app('(map p (arr body.text))')).diagnostics;
    expect(mapped.map((d) => [d.code, d.message, d.fixes])).toEqual([['W801', '"map" calls "p", which may throw at runtime; wrap in (attempt expr fallback)', undefined]]);
    // Arguments are not inlined: a literal argument still warns at the call.
    expect(codesOf('(app a (fn p ((s string)) (json-parse s)) (page "/" home (txt (json-stringify (p "1")))))')).toEqual(['W801']);
    // Guarded inside the fn, guarded at the call, or never called: quiet.
    expect(codesOf(app('(guarded body.text)'))).toEqual([]);
    expect(codesOf(app('(attempt (p body.text) (fail 400 "text must be JSON"))'))).toEqual([]);
    expect(codesOf(`(app a ${fns} (page "/" home (txt "x")))`)).toEqual([]);
  });

  it('checks a job body like a handler: literal operands are verified, dynamic ones warn and still compile', () => {
    const job = (expr: string): string => `(app a (db (table t (id auto) (s string))) (env raw) (job prune :every 60 ${expr}) (page "/" home (txt "x")))`;
    expect(codesOf(job('(json-parse "x")'))).toEqual(['E109']);
    const dynamic = compile(job('(json-parse env.raw)'));
    expect(dynamic.diagnostics.map((d) => [d.code, d.message, d.fixes?.map((f) => [f.confidence, f.title])])).toEqual([
      ['W801', '"json-parse" may throw at runtime; wrap in (attempt expr fallback)', [['placeholder', 'Wrap in (attempt … null) (fill in)']]],
    ]);
    expect(dynamic.files.size).toBeGreaterThan(0);
    expect(codesOf(job('(attempt (json-parse env.raw) null)'))).toEqual([]);
  });

  it('verifies a literal once however many call sites specialise the enclosing fn', () => {
    const literal = JSON.stringify(Array.from({ length: 2000 }, (_, i) => i));
    const calls = Array.from({ length: 12 }, (_, i) => `(txt (count (f ${i})))`).join(' ');
    const parse = vi.spyOn(JSON, 'parse');
    try {
      const result = compile(`(app a (fn f (x) (json-parse ${JSON.stringify(literal)})) (page "/" home ${calls}))`);
      expect(result.diagnostics).toEqual([]);
      expect(parse.mock.calls.filter(([text]) => text === literal)).toHaveLength(1);
    } finally {
      parse.mockRestore();
    }
  });
});

describe('expression typing', () => {
  it('rejects arithmetic on strings with E111', () => {
    expect(codesOf('(app a (state n 0) (page "/" home (txt (+ n "oops"))))')).toContain('E111');
  });

  it('rejects comparisons of known strings with E111', () => {
    expect(codesOf('(app a (state s "x") (page "/" home (if (< s 3) (txt "y"))))')).toContain('E111');
  });

  it('accepts numeric state, count, and unknown-typed data', () => {
    const src = `(app a (state n 1)
      (data (resource r "/api/r.json" :default (arr)))
      (page "/" home (if r.loading (txt "...") (txt (+ n (count r.data))))))`;
    expect(compile(src).diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  });

  const errorsOf = (source: string): string[] => compile(source).diagnostics.filter((d) => d.severity === 'error').map((d) => `${d.code}:${d.message}`);

  it('requires a boolean test at every condition site with E111', () => {
    const sites: [string, string, string][] = [
      ['if', '(state items (arr 1 2)) (page "/" home (txt (if items "some" "none")))', 'list<number>'],
      ['if', '(state n 0) (page "/" home (if n (txt "a")))', 'number'],
      ['when', '(state s "") (page "/" home (when s (txt "a")))', 'string'],
      ['cond', '(state n 0) (page "/" home (txt (cond (n "a") (else "b"))))', 'number'],
      ['and', '(state n 0) (page "/" home (txt (and n true)))', 'number'],
      ['or', '(state s "") (page "/" home (txt (or false s)))', 'string'],
      ['not', '(state items (arr 1)) (page "/" home (txt (not items)))', 'list<number>'],
    ];
    for (const [op, body, received] of sites) {
      const source = `(app a ${body})`;
      expect(errorsOf(source), source).toEqual([`E111:"${op}" expects boolean, got ${received}`]);
      expect(compile(source).diagnostics[0]).toMatchObject({ op, received, expected: 'boolean' });
    }
  });

  it('accepts boolean, unknown, never, and narrowed conditions', () => {
    const programs = [
      '(app a (state flag false) (page "/" home (if flag (txt "a"))))',
      '(app a (use "pkg" (import flag)) (page "/" home (when (flag) (txt "a"))))',
      '(app a (fn f (x) (if x 1 2)) (page "/" home (txt "a")))',
      '(app a (page "/" home (txt (let ((x null)) (if (not-null x) (if x 1 2) 3)))))',
      '(app a (page "/" home (txt (let ((b (first (arr true)))) (and (not-null b) b)))))',
      '(app a (page "/" home (txt (let ((x (first (arr 1)))) (cond ((is-null x) "none") ((> x 0) "some") (else "zero"))))))',
    ];
    for (const source of programs) expect(errorsOf(source), source).toEqual([]);
  });

  it('repairs a non-boolean condition with the test the author meant', () => {
    const cases: [string, string, FixConfidence, string][] = [
      ['(app a (state n 0) (page "/" home (if n (txt "a"))))', 'Wrap in (!= … 0)', 'safe', '(if (!= n 0) (txt "a"))'],
      ['(app a (state s "") (page "/" home (when s (txt "a"))))', 'Wrap in (!= … "")', 'safe', '(when (!= s "") (txt "a"))'],
      ['(app a (page "/" home (if (first (arr true)) (txt "a"))))', 'Wrap in (or-else … false)', 'safe', '(if (or-else (first (arr true)) false) (txt "a"))'],
      ['(app a (page "/" home (if (first (arr (arr 1))) (txt "a"))))', 'Wrap in (not-null …)', 'safe', '(if (not-null (first (arr (arr 1)))) (txt "a"))'],
      ['(app a (page "/" home (if (json-parse "1") (txt "a"))))', 'Wrap in (not-null …)', 'review', '(if (not-null (json-parse "1")) (txt "a"))'],
      ['(app a (state items (arr 1)) (page "/" home (if items (txt "a"))))', 'Wrap in (> (count …) 0)', 'review', '(if (> (count items) 0) (txt "a"))'],
    ];
    for (const [source, title, confidence, expected] of cases) {
      const [fix, ...rest] = compile(source).diagnostics.find((d) => d.code === 'E111')?.fixes ?? [];
      expect(fix, source).toMatchObject({ title, confidence });
      expect(rest).toEqual([]);
      if (fix === undefined) throw new Error(source);
      const patched = applyTextEdits(source, fix.edits);
      expect(patched).toContain(expected);
      expect(errorsOf(patched)).toEqual([]);
    }
  });

  it('guards a nullable record, function, or union test with not-null, reviewed only when the value may be a scalar', () => {
    const cases: [string, string, FixConfidence][] = [
      ['(app a (page "/" home (if (first (arr (obj :a 1))) (txt "a"))))', 'record | null', 'safe'],
      ['(app a (fn f (x) x) (page "/" home (if (first (arr f)) (txt "a"))))', '(unknown) => unknown | null', 'safe'],
      ['(app a (page "/" home (if (first (arr 1 "a")) (txt "a"))))', 'number | string | null', 'review'],
    ];
    for (const [source, received, confidence] of cases) {
      const error = compile(source).diagnostics.find((d) => d.code === 'E111');
      expect(error, source).toMatchObject({ message: `"if" expects boolean, got ${received}`, received });
      // Only a nullable scalar gets the spelled-out `(and (not-null x) (!= x …))` hint.
      expect(error?.suggestions, source).toBeUndefined();
      expect(error?.fixes?.map((f) => [f.title, f.confidence]), source).toEqual([['Wrap in (not-null …)', confidence]]);
      const fix = error?.fixes?.[0];
      if (fix === undefined) throw new Error(source);
      expect(errorsOf(applyTextEdits(source, fix.edits)), source).toEqual([]);
    }
  });

  it('spells the exact repair of a nullable scalar condition as a suggestion beside a review not-null fix', () => {
    const source = '(app a (data (resource users "/api/users.json" :default (arr))) (page "/" home (when users.error (txt "Error: " users.error))))';
    const error = compile(source).diagnostics.find((d) => d.code === 'E111');
    expect(error).toMatchObject({ message: '"when" expects boolean, got string | null', suggestions: ['(and (not-null users.error) (!= users.error ""))'] });
    expect(error?.fixes?.map((f) => [f.title, f.confidence])).toEqual([['Wrap in (not-null …)', 'review']]);
    const number = compile('(app a (page "/" home (if (first (arr 1 2)) (txt "a"))))').diagnostics.find((d) => d.code === 'E111');
    expect(number?.suggestions).toEqual(['(and (not-null (first (arr 1 2))) (!= (first (arr 1 2)) 0))']);
  });

  it('offers no fix for a condition that is always truthy or always falsy', () => {
    for (const source of ['(app a (page "/" home (if (obj :a 1) (txt "a"))))', '(app a (page "/" home (if null (txt "a"))))']) {
      const error = compile(source).diagnostics.find((d) => d.code === 'E111');
      expect(error?.expected, source).toBe('boolean');
      expect(error?.fixes, source).toBeUndefined();
    }
  });

  it('reports a condition that fails its own check only once', () => {
    expect(errorsOf('(app a (page "/" home (if missing (txt "a"))))')).toEqual(['E201:Unknown reference "missing"']);
    expect(errorsOf('(app a (page "/" home (if (+ "a" 1) (txt "a"))))')).toEqual(['E111:"+" expects number, got string']);
  });

  it('keeps a not-null wrapped error read as a W301 guard', () => {
    expect(codesOf('(app a (data (resource r "/x")) (page "/" home (when (not-null r.error) (each u r.data (txt u)))))')).toEqual([]);
    expect(codesOf('(app a (data (resource r "/x")) (page "/" home (each u r.data (txt u))))')).toEqual(['W301']);
  });
});

describe('ID stability under sibling insertion', () => {
  it('keeps text-node IDs when an unrelated sibling is inserted before them', () => {
    const before = parse(wrap('(v (txt "First") (txt "Second"))'));
    const after = parse(wrap('(v (txt "Inserted") (txt "First") (txt "Second"))'));
    const idsFor = (nodes: ReturnType<typeof parse>['nodes'], text: string): string[] => {
      const out: string[] = [];
      const visit = (e: (typeof nodes)[number]): void => {
        if (e.kind !== 'list') return;
        if (e.items.some((i) => i.kind === 'string' && i.value === text)) out.push(e.id);
        for (const item of e.items) visit(item);
      };
      for (const n of nodes) visit(n);
      return out;
    };
    expect(idsFor(after.nodes, 'First')).toEqual(idsFor(before.nodes, 'First'));
    expect(idsFor(after.nodes, 'Second')).toEqual(idsFor(before.nodes, 'Second'));
  });
});

describe('multi-file projects', () => {
  const files: Record<string, string> = {
    'app.grhm': `(app shop
  (state n 0)
  (include "pages/home.grhm")
  (include "shared/widgets.grhm"))`,
    'pages/home.grhm': `(page "/" home
  (v :pad 16
    (fancy-button :label "Hi")
    (btn "Inc" (click (set n (+ n 1))))))`,
    'shared/widgets.grhm': `(component fancy-button
  (props (label string))
  (btn label :variant primary))`,
  };
  const read: ReadFile = (p) => files[p];

  it('loads, merges, and compiles includes', () => {
    const project = loadProject('app.grhm', read);
    expect(project.diagnostics).toEqual([]);
    expect(project.files.map((f) => f.file)).toEqual(['app.grhm', 'pages/home.grhm', 'shared/widgets.grhm']);
    const result = compileProject(project);
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(result.files.get('components.tsx')).toContain('FancyButton');
  });

  it('tags diagnostics with the file they came from', () => {
    const broken: Record<string, string> = { ...files, 'pages/home.grhm': '(page "/" home (txt missing-ref))' };
    const project = loadProject('app.grhm', (p) => broken[p]);
    const result = compileProject(project);
    const err = result.diagnostics.find((d) => d.code === 'E201');
    expect(err?.span?.file).toBe('pages/home.grhm');
  });

  it('reports missing includes and cycles as E603', () => {
    const missing = loadProject('app.grhm', (p) => (p === 'app.grhm' ? '(app a (include "nope.grhm") (page "/" h (txt "x")))' : undefined));
    expect(missing.diagnostics.some((d) => d.code === 'E603')).toBe(true);

    const cyclic: Record<string, string> = {
      'a.grhm': '(app a (include "b.grhm") (page "/" h (txt "x")))',
      'b.grhm': '(include "a.grhm")',
    };
    const cycle = loadProject('a.grhm', (p) => cyclic[p]);
    expect(cycle.diagnostics.some((d) => d.code === 'E603')).toBe(true);
  });

  it('patches a node inside an included file, rewriting only that file', () => {
    const project = loadProject('app.grhm', read);
    const revision = projectRevision(project);
    const widgets = project.files.find((f) => f.file === 'shared/widgets.grhm')!;
    const btnNode = (() => {
      let found: string | undefined;
      const visit = (e: (typeof widgets.nodes)[number]): void => {
        if (e.kind !== 'list') return;
        const head = e.items[0];
        if (head?.kind === 'ident' && head.name === 'btn') found = e.id;
        for (const item of e.items) visit(item);
      };
      for (const n of widgets.nodes) visit(n);
      return found;
    })();
    expect(btnNode).toBeDefined();
    const result = applyPatchToProject('app.grhm', read, `(patch :revision "${revision}" :target ${btnNode} (set radius 12))`);
    expect(result.ok).toBe(true);
    expect(result.changedFiles).toEqual(['shared/widgets.grhm']);
    expect(result.newSources?.get('shared/widgets.grhm')).toContain(':radius 12');
  });
});

describe('projections (FR-12)', () => {
  it('rewrites compact aliases to descriptive names and back', () => {
    const src = wrap('(v :pad 8 (txt "hello") (btn "Go" (click (nav "/"))))');
    const parsed = parse(src);
    const descriptive = format(parsed.nodes, 'descriptive');
    expect(descriptive).toContain('(vstack');
    expect(descriptive).toContain('(text "hello")');
    expect(descriptive).toContain('(button');
    const compact = format(parse(descriptive).nodes, 'compact');
    expect(compact).toContain('(v ');
    expect(compact).toContain('(txt "hello")');
    // Projections never change program identity.
    expect(format(parse(compact).nodes, 'descriptive')).toBe(descriptive);
  });
});

describe('model-facing reference (FR-15)', () => {
  const text = generateReference();

  it('documents every op, style prop, expression op, and diagnostic code', () => {
    expect(text).toContain('(vstack');
    expect(text).toContain('(dialog');
    expect(text).toContain(':pad size');
    expect(text).toContain('(call target.path arg...)');
    expect(text).toContain('E504');
    expect(text).toContain('patch');
    expect(text).toContain('(app shop');
  });

  it('fits an in-context token budget', () => {
    expect(referenceTokenEstimate(text)).toBeLessThan(4000);
    for (const name of ['cl100k_base', 'o200k_base'] as const) {
      expect(getEncoding(name).encode(text).length, name).toBeLessThan(4000);
    }
    expect(generateReference({ full: true }).length).toBeGreaterThan(text.length);
  });
});

describe('test lowering (FR-14)', () => {
  it('lowers steps to a Playwright spec', () => {
    const result = compile(FIXTURE);
    expect(result.app).toBeDefined();
    const spec = genPlaywrightSpec(result.app!) ?? '';
    expect(spec).toContain("import { test, expect } from '@playwright/test';");
    expect(spec).toContain("test(\"home renders and navigates\"");
    expect(spec).toContain("await page.goto(\"/\");");
    expect(spec).toContain("getByRole('button', { name: \"Shop all\", exact: true }).click()");
    expect(spec).toContain('toHaveURL');
  });

  it('lowers suites to a jsdom Vitest spec as well', () => {
    const src = `(app a (page "/" home (heading "Welcome") (btn "Go" (click (nav "/")))))
(tests (test "smoke" (visit "/") (click "Go") (expect-text "Welcome") (expect-url "/")))`;
    const result = compile(src);
    const unit = genVitestSpec(result.app!) ?? '';
    // Split so vitest's docblock scanner doesn't treat THIS file as jsdom.
    expect(unit).toContain(['@vitest-environment', 'jsdom'].join(' '));
    expect(unit).toContain('root.render(<App />)');
    expect(unit).toContain('await click(button("Go"));');
    expect(unit).toContain('toContain("Welcome")');
    expect(unit).toContain('window.history.pushState');
  });

  it('validates steps: unknown steps, bad routes, and missing nodes', () => {
    const base = '(app a (page "/" home (txt "x")))';
    expect(codesOf(base + '\n(tests (test "t" (frobnicate "/")))')).toContain('E701');
    expect(codesOf(base + '\n(tests (test "t" (visit "/nope")))')).toContain('E203');
    expect(codesOf(base + '\n(tests (test "t" (expect-node no-such-node)))')).toContain('E204');
  });

  it('uses normal expression arity and lexical-scope checks for expect-eq', () => {
    const base = '(app a (page "/" home (txt "x")))';
    expect(codesOf(base + '\n(tests (test "t" (expect-eq (+ 1) 1)))')).toContain('E109');

    const lexical = compile(base + '\n(tests (test "t" (expect-eq (let ((x 1)) (+ x 1)) 2)))');
    expect(lexical.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  });
});

describe('references and rename', () => {
  const SRC = `(app a
  (theme (token primary "#4f46e5"))
  (state n 0)
  (use "./lib/x.ts" (import helper))
  (component chip (props (label string)) (txt label :color $primary))
  (page "/" home
    (local n-draft "")
    (txt n)
    (each n products (txt n.name))
    (btn "Up" (click (set n (+ n 1))))))`;
  const roots = parse(SRC).nodes;

  it('finds the identifier head at a position', () => {
    expect(symbolAt(roots, SRC.indexOf('(txt n)') + 6)).toBe('n');
    expect(symbolAt(roots, SRC.indexOf('n.name') + 1)).toBe('n');
  });

  it('scopes each variables to their loop, not the app state', () => {
    const info = resolveSymbol(roots, 'n');
    expect(info?.kind).toBe('state');
    expect(info?.scope).toBe('global');
    const refs = findReferences(roots, info!);
    // decl, (txt n), set target, + operand — but NOT the each var or n.name.
    expect(refs.length).toBe(4);
  });

  it('resolves tokens and includes $-references', () => {
    const info = resolveSymbol(roots, '$primary');
    expect(info?.kind).toBe('token');
    const refs = findReferences(roots, info!);
    expect(refs.length).toBe(2); // token decl + $primary use
  });

  it('resolves components globally and locals to their page', () => {
    expect(resolveSymbol(roots, 'chip')?.kind).toBe('component');
    const local = resolveSymbol(roots, 'n-draft');
    expect(local?.kind).toBe('local');
    expect(local?.scope).not.toBe('global');
  });

  it('marks imports and component props as non-renameable', () => {
    expect(resolveSymbol(roots, 'helper')?.renameable).toBe(false);
    expect(resolveSymbol(roots, 'label')?.renameable).toBe(false);
  });

  it('validates proposed names', () => {
    expect(validNewName('cart-count')).toBe(true);
    expect(validNewName('CartCount')).toBe(false);
    expect(validNewName('9lives')).toBe(false);
    expect(validNewName('foo--bar')).toBe(false);
    expect(validNewName('class')).toBe(false);
  });
});

describe('initializer scopes, generated names, and shadowing', () => {
  it('infers expression result types for state and local initializers', () => {
    const result = compile(`(app a
      (state total (+ 1 2))
      (page "/" home
        (local doubled (* total 2))
        (txt doubled)))`);
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(result.files.get('state.ts')).toContain('createStore<number>((1 + 2))');
    expect(result.files.get('pages/home.tsx')).toContain('const __grhmInitialDoubled = (total * 2);');
    expect(result.files.get('pages/home.tsx')).toContain('useState<number>(() => __grhmInitialDoubled)');
  });

  it('allows only earlier state and local initializer dependencies', () => {
    const ordered = compile(`(app a
      (state first 1)
      (state second first)
      (page "/" home
        (local a first)
        (local b a)
        (txt (+ second b))))`);
    expect(ordered.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(ordered.files.get('state.ts')).toContain('createStore<number>(firstStore.get())');
    expect(ordered.files.get('pages/home.tsx')).toContain('const __grhmInitialB = a;');
    expect(ordered.files.get('pages/home.tsx')).toContain('useState<number>(() => __grhmInitialB)');

    expect(codesOf(`(app a (state first second) (state second 2) (page "/" home (txt first)))`)).toContain('E201');
    expect(codesOf(`(app a (page "/" home (local first second) (local second 2) (txt first)))`)).toContain('E201');
  });

  it('does not admit resources into module-level state initialization', () => {
    const src = `(app a
      (data (resource items "/api/items" :default (arr)))
      (state initial items.data)
      (page "/" home (txt "x")))`;
    expect(codesOf(src)).toContain('E201');
  });

  it('imports direct JS dependencies and i18n helpers used by state initializers', () => {
    const imported = compile(`(app a
      (use "./lib/helpers.ts" (import make-value makeValue))
      (state value (make-value))
      (page "/" home (txt value)))`);
    expect(imported.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(imported.files.get('state.ts')).toContain('import { makeValue }');
    expect(imported.files.get('state.ts')).toContain('createStore<any>(makeValue())');

    const translated = compile(`(app a
      (i18n (locale en (msg greeting "Hello")))
      (state greeting (t greeting))
      (page "/" home (txt greeting)))`);
    expect(translated.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(translated.files.get('state.ts')).toContain("import { tMsg } from './i18n';");
  });

  it('rejects declarations that collapse to the same generated identifier', () => {
    expect(codesOf(`(app a (state foo-1 1) (state foo1 2) (page "/" home (txt "x")))`)).toContain('E107');
    expect(codesOf(`(app a (state class 1) (page "/" home (txt "x")))`)).toContain('E104');
    expect(codesOf(`(app a (state foo1 1) (page "/" home (local foo-1 2) (txt foo-1)))`)).toContain('E107');
  });

  it.each(['merge-records', 'group-by', 'upload-file', 'send'])('rejects declarations that collide with runtime helper %s', (name) => {
    expect(codesOf(`(app a (state ${name} 1) (page "/" home (txt ${name})))`)).toContain('E107');
    expect(codesOf(`(app a (data (resource ${name} "/data.json")) (page "/" home (txt "x")))`)).toContain('E107');
  });

  it('rejects duplicate and colliding generated page names', () => {
    expect(codesOf(`(app a (page "/a" home (txt "a")) (page "/b" home (txt "b")))`)).toContain('E107');
    expect(codesOf(`(app a (page "/a" foo-1 (txt "a")) (page "/b" foo1 (txt "b")))`)).toContain('E107');
  });

  it('keeps route params, component props, and locals ahead of same-named globals', () => {
    const result = compile(`(app a
      (state id "global")
      (page "/items/{id}" item (txt id))
      (component badge (props (id string)) (txt id))
      (page "/local" local-page (local id "local") (txt id)))`);
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    const paramPage = result.files.get('pages/item.tsx') ?? '';
    expect(paramPage).toContain('__grhmProps.params["id"]');
    expect(paramPage).not.toContain('useStore(idStore)');
    const components = result.files.get('components.tsx') ?? '';
    expect(components).toContain('__grhmProps.id');
    expect(components).not.toContain('useStore(idStore)');
    const localPage = result.files.get('pages/local-page.tsx') ?? '';
    expect(localPage).toContain('const __grhmInitialId = "local";');
    expect(localPage).toContain('useState<string>(() => __grhmInitialId)');
    expect(localPage).not.toContain('useStore(idStore)');
  });

  it('rejects a local initializer that reads the same-named shadowed global', () => {
    const src = `(app a (state n 1) (page "/" home (local n (+ n 1)) (txt n)))`;
    expect(codesOf(src)).toContain('E201');
  });

  it('validates lexical binders and checks each :key in loop scope', () => {
    expect(codesOf(wrap('(txt (let ((foo-1 1) (foo1 2)) foo1))'))).toContain('E107');
    expect(codesOf(wrap('(txt (count (map (lambda (class) class) (arr 1))))'))).toContain('E104');
    expect(codesOf(wrap('(each index (arr 1) (txt index))'))).toContain('E107');

    const each = compile(wrap('(each item (arr (obj :id 1)) :key item.id (txt item.id))'));
    expect(each.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  });
});

describe('full-stack: db, api, send, refresh', () => {
  const APP = `(app shop
    (db
      (table wishes
        (id auto)
        (name string)
        (done boolean :default false)))
    (api
      (get "/api/wishes" (sort-by (lambda (w) w.id) (select wishes)))
      (post "/api/wishes" (insert wishes :name (trim body.name)))
      (put "/api/wishes/{id}" (update wishes :id id :done body.done))
      (delete "/api/wishes/{id}" (delete-row wishes :id id)))
    (data (resource wishes "/api/wishes" :default (arr)))
    (state new-name "")
    (page "/" home
      (v
        (form
          (submit (send post "/api/wishes" :name new-name) (refresh wishes) (set new-name ""))
          (input :value new-name :label "Wish"))
        (each w wishes.data
          (h
            (txt w.name)
            (btn "Done" (click (send put (path "/api/wishes/{id}" :id w.id) :done true) (refresh wishes)))
            (btn "Drop" (click (send delete (path "/api/wishes/{id}" :id w.id)) (refresh wishes))))))))`;

  it('compiles db + api + send + refresh with no errors', () => {
    const result = compile(APP);
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect([...result.files.keys()]).toContain('server.ts');
    expect([...result.files.keys()]).toContain('helpers.ts');
  });

  it('generates a sqlite schema, route table, and http entry in server.ts', () => {
    const result = compile(APP);
    const server = result.files.get('server.ts') ?? '';
    expect(server).toContain("import { DatabaseSync } from 'node:sqlite';");
    expect(server).toContain('{ name: "wishes", columns: [');
    expect(server).toContain('"\\"id\\" INTEGER PRIMARY KEY AUTOINCREMENT"');
    expect(server).toContain('"\\"done\\" INTEGER NOT NULL DEFAULT 0"');
    expect(server).toContain('migrateSchema(db, SCHEMA, SEEDS, AUTH?.usersTable');
    expect(server).toContain('{ method: "GET", pattern: "/api/wishes"');
    expect(server).toContain('dbInsert("wishes", { "name": String(body.name).trim() })');
    expect(server).toContain('dbUpdate("wishes", params["id"], { "done": body.done })');
    expect(server).toContain('dbDelete("wishes", params["id"])');
    expect(server).toContain('export async function handleApi');
    expect(server).toContain('export function startServer');
    expect(result.files.get('storage.ts')).toContain("DELETE FROM sqlite_sequence WHERE name = ?");
  });

  it('binds a same-named route parameter on the value side of a SQL predicate', () => {
    const src = `(app a
      (db (table users (id auto) (name string)))
      (api (get "/api/users/{id}" (select users :where (= id id))))
      (page "/" home (txt "x")))`;
    const result = compile(src);
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    const server = result.files.get('server.ts') ?? '';
    expect(server).toContain('where: "(\\"id\\" IS ?)", args: [params["id"]]');
    expect(server).not.toContain('where: "(\\"id\\" IS \\"id\\")"');
  });

  it('awaits Promise-returning API handlers and captures async job failures', () => {
    const src = `(app a
      (use "./lib/async.ts" (import lookup))
      (db (table items (id auto)))
      (api (get "/api/items" (lookup)))
      (job sync :every 60 (lookup))
      (page "/" home (txt "x")))`;
    const result = compile(src);
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    const server = result.files.get('server.ts') ?? '';
    expect(server).toContain('const result = await route.handler(params, payload, user);');
    expect(server).toContain('handler: (params: Record<string, string>, body: unknown, user: unknown) => unknown | Promise<unknown>;');
    expect(server).toContain('run: () => unknown | Promise<unknown>');
    expect(server).toContain('.then(() => job.run())');
    expect(server).toContain('.catch((err: unknown) => {');
  });

  it('rejects potentially asynchronous interop inside tx, including through user fns', () => {
    const direct = `(app a
      (use "./lib/async.ts" (import lookup))
      (db (table items (id auto)))
      (api (post "/api/items" (tx (lookup))))
      (page "/" home (txt "x")))`;
    expect(codesOf(direct)).toContain('E805');

    const transitive = `(app a
      (use "./lib/async.ts" (import lookup))
      (fn wrapped () (lookup))
      (db (table items (id auto)))
      (api (post "/api/items" (tx (wrapped))))
      (page "/" home (txt "x")))`;
    expect(codesOf(transitive)).toContain('E805');

    const sync = compile(`(app a
      (db (table items (id auto) (name string)))
      (api (post "/api/items" (tx (insert items :name "x"))))
      (page "/" home (txt "x")))`);
    expect(sync.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  });

  it('generates a unique auth email index and handles uniqueness conflicts', () => {
    const server = compile('(app a (auth users) (page "/" home (txt "x")))').files.get('server.ts') ?? '';
    expect(server).toContain('uniqueIndexes: ["email"]');
    expect(server).toContain('uniqueIndexes: [\"email\"]');
    expect(server).toContain("err.message.includes('UNIQUE constraint failed')");
    expect(server).toContain("status: 409, payload: { error: 'email already registered' }");
  });

  it('lowers send/refresh to async client actions', () => {
    const page = compile(APP).files.get('pages/home.tsx') ?? '';
    expect(page).toContain("import { useStore, useResource, send, refreshResource, handleActionError } from '../runtime';");
    expect(page).toContain('async (__grhmEvent: FormEvent) => { __grhmEvent.preventDefault(); try { await send("post", "/api/wishes", { "name": newName });');
    expect(page).toContain('refreshResource("/api/wishes")');
    expect(page).toContain('await send("delete", ("/api/wishes/" + encodeURIComponent(String(w.id)) + ""))');
    expect(page).toContain('await send("put", ("/api/wishes/" + encodeURIComponent(String(w.id)) + ""), { "done": true })');
  });

  it('shares pure fns between client and server via lib.ts', () => {
    const src = `(app a
      (db (table items (id auto) (name string)))
      (fn shout (s) (upper (trim s)))
      (api (post "/api/items" (insert items :name (shout body.name))))
      (page "/" home (txt (shout "hi"))))`;
    const result = compile(src);
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    const server = result.files.get('server.ts') ?? '';
    expect(server).toContain("import { shout as __grhm_fn_shout } from './lib.ts';");
    expect(server).toContain('dbInsert("items", { "name": __grhm_fn_shout(body.name) })');
    const lib = result.files.get('lib.ts') ?? '';
    expect(lib).toContain('export function shout');
  });

  it('rejects malformed tables and duplicate columns with E801', () => {
    expect(codesOf('(app a (db (table t (id auto) (x blob))) (page "/" home (txt "x")))')).toContain('E801');
    expect(codesOf('(app a (db (table t (id auto) (x string) (x string))) (page "/" home (txt "x")))')).toContain('E801');
  });

  it('rejects unknown tables (E802) and unknown columns (E803)', () => {
    const base = '(app a (db (table wishes (id auto) (name string))) (api (get "/api/x" (select whishes))) (page "/" home (txt "x")))';
    const diags = compile(base).diagnostics;
    expect(diags.map((d) => d.code)).toContain('E802');
    expect(diags.find((d) => d.code === 'E802')?.suggestions).toContain('wishes');
    const cols = '(app a (db (table wishes (id auto) (name string))) (api (post "/api/x" (insert wishes :nmae "y"))) (page "/" home (txt "x")))';
    const colDiags = compile(cols).diagnostics;
    expect(colDiags.map((d) => d.code)).toContain('E803');
    expect(colDiags.find((d) => d.code === 'E803')?.suggestions).toContain(':name');
  });

  it('rejects duplicate api routes with E804 and missing :id with E805', () => {
    const dup = `(app a (db (table t (id auto)))
      (api (get "/api/t" (select t)) (get "/api/t" (select t)))
      (page "/" home (txt "x")))`;
    expect(codesOf(dup)).toContain('E804');
    const noId = '(app a (db (table t (id auto) (n number))) (api (put "/api/t" (update t :n 1))) (page "/" home (txt "x")))';
    expect(codesOf(noId)).toContain('E805');
  });

  it('rejects server ops outside handlers with E805', () => {
    const src = '(app a (db (table t (id auto))) (page "/" home (txt (count (select t)))))';
    expect(codesOf(src)).toContain('E805');
  });

  it('rejects database mutations in GET handlers, including inside tx', () => {
    const handlers = [
      '(insert t :name "x")',
      '(update t :id 1 :name "x")',
      '(delete-row t :id 1)',
      '(tx (delete-row t :id 1))',
    ];
    for (const handler of handlers) {
      const src = `(app a
        (db (table t (id auto) (name string)))
        (api (get "/api/t" ${handler}))
        (page "/" home (txt "x")))`;
      expect(codesOf(src)).toContain('E805');
    }

    const readOnly = compile(`(app a
      (db (table t (id auto) (name string)))
      (api (get "/api/t" (select t)))
      (page "/" home (txt "x")))`);
    expect(readOnly.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  });

  it('rejects unknown API properties, non-boolean :auth, and dangling properties', () => {
    const base = (route: string): string => `(app a
      (db (table t (id auto)))
      (api ${route})
      (page "/" home (txt "x")))`;
    expect(codesOf(base('(get "/api/t" :ath true (select t))'))).toContain('E102');
    expect(codesOf(base('(get "/api/t" :auth "true" (select t))'))).toContain('E103');
    expect(codesOf(base('(get "/api/t" (select t) :auth)'))).toContain('E105');
  });

  it('validates every :where operator arity before SQL generation', () => {
    const malformed = ['(= id)', '(= id 1 2)', '(not)', '(not (= id 1) (= id 2))', '(and (= id 1))', '(or (= id 1))', '(contains name)'];
    for (const where of malformed) {
      const src = `(app a
        (db (table t (id auto) (name string)))
        (api (get "/api/t" (select t :where ${where})))
        (page "/" home (txt "x")))`;
      const result = compile(src);
      expect(result.diagnostics.map((d) => d.code)).toContain('E811');
      expect(result.files.size).toBe(0);
    }
  });

  it('rejects send to undeclared routes (E806) and refresh of unknown resources (E807)', () => {
    const badSend = `(app a (db (table t (id auto)))
      (api (post "/api/t" (insert t)))
      (page "/" home (btn "Go" (click (send post "/api/nope")))))`;
    expect(codesOf(badSend)).toContain('E806');
    const badMethod = `(app a (db (table t (id auto)))
      (api (post "/api/t" (insert t)))
      (page "/" home (btn "Go" (click (send delete "/api/t")))))`;
    expect(codesOf(badMethod)).toContain('E806');
    const badRefresh = '(app a (page "/" home (btn "Go" (click (refresh ghosts)))))';
    expect(codesOf(badRefresh)).toContain('E807');
  });

  it('lets a table and the resource reading it share a name', () => {
    const result = compile(APP);
    expect(result.diagnostics.filter((d) => d.code === 'E107')).toEqual([]);
  });

  it('handlers see route params and body but not app state', () => {
    const src = `(app a (db (table t (id auto) (n number)))
      (state counter 0)
      (api (post "/api/t" (insert t :n counter)))
      (page "/" home (txt counter)))`;
    expect(codesOf(src)).toContain('E201');
  });

  it('generates a unit spec that routes /api through the real handlers', () => {
    const withTests = APP + '\n(tests (test "wish flow" (visit "/") (expect-text "Wish")))';
    const result = compile(withTests);
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    const unit = genVitestSpec(result.app!) ?? '';
    expect(unit).toContain("GRHM_DB: ':memory:'");
    expect(unit).toContain("realFetch('http://127.0.0.1:' + apiPort + url, init)");
    expect(unit).toContain('/__grhm/reset');
    expect(unit).toContain('resetResources();');
    const config = playwrightConfig(true);
    expect(config).toContain('src/gen/server.ts');
    expect(config).toContain("GRHM_DB: ':memory:'");
  });
});

describe('live resources, jobs, uploads, references, screenshots', () => {
  it('lowers :live resources to an SSE subscription and generates the event feed', () => {
    const result = compile(FIXTURE);
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    const server = result.files.get('server.ts') ?? '';
    expect(server).toContain("pathname === '/api/_events'");
    expect(server).toContain('broadcastChange(table)');
    const runtime = result.files.get('runtime.ts') ?? '';
    expect(runtime).toContain("new EventSource(apiUrl('/api/_events'), { withCredentials: true })");
    const pages = [...result.files].filter(([name]) => name.startsWith('pages/')).map(([, text]) => text);
    expect(pages.some((p) => p.includes('>("/api/reviews", [], 60, true)') && !p.includes('useResource<any>'))).toBe(true);
  });

  it('rejects :live without a server with E816', () => {
    const src = '(app a (data (resource r "/data.json" :live true)) (page "/" home (txt "x")))';
    expect(codesOf(src)).toContain('E816');
  });

  it('lowers (job ...) declarations into the generated server', () => {
    const server = compile(FIXTURE).files.get('server.ts') ?? '';
    expect(server).toContain('const JOBS: { name: string; everySeconds: number; run: () => unknown | Promise<unknown> }[] = [');
    expect(server).toContain('{ name: "audit-reviews", everySeconds: 3600, run: () => (');
    expect(server).toContain('function startJobs()');
  });

  it('validates jobs: malformed shape and missing server (E817), no request context', () => {
    expect(codesOf('(app a (db (table t (id auto))) (job j (select t)) (page "/" home (txt "x")))')).toContain('E817');
    expect(codesOf('(app a (job j :every 60 (+ 1 2)) (page "/" home (txt "x")))')).toContain('E817');
    const noBody = '(app a (db (table t (id auto) (n number))) (job j :every 60 (insert t :n body.n)) (page "/" home (txt "x")))';
    expect(codesOf(noBody)).toContain('E201');
  });

  it('lowers (uploads) + (file-input :to state) to an upload route and client picker', () => {
    const result = compile(FIXTURE);
    const server = result.files.get('server.ts') ?? '';
    expect(server).toContain('maxKb: 1024, public: false, quotaMb: 1024, userQuotaMb: 100');
    expect(server).toContain('createUploadStore');
    expect(result.files.get('uploads.ts')).toContain('upload storage quota exceeded');
    expect(server).toContain("pathname.startsWith('/uploads/')");
    const catalog = result.files.get('pages/catalog.tsx') ?? '';
    expect(catalog).toContain('type="file"');
    expect(catalog).toContain('uploadFile(file).then(setPhotoUrl)');
  });

  it('rejects file-input without (uploads ...) or :to with E818', () => {
    const noDecl = '(app a (state u "") (page "/" home (file-input :to u)))';
    expect(codesOf(noDecl)).toContain('E818');
    const noTo = '(app a (uploads) (page "/" home (file-input :label "Pic")))';
    expect(codesOf(noTo)).toContain('E818');
  });

  it('emits REFERENCES clauses for :references columns and validates targets', () => {
    const server = compile(FIXTURE).files.get('server.ts') ?? '';
    expect(server).toContain('REFERENCES \\"reviews\\"(\\"id\\")');
    const bad = '(app a (db (table t (id auto) (x number :references ghosts))) (page "/" home (txt "x")))';
    expect(codesOf(bad)).toContain('E819');
  });

  it('lowers (screenshot ...) to a Playwright visual assertion and skips it in jsdom', () => {
    const result = compile(FIXTURE);
    const spec = genPlaywrightSpec(result.app!) ?? '';
    expect(spec).toContain('await expect(page).toHaveScreenshot("home.png", { fullPage: true });');
    const unit = genVitestSpec(result.app!) ?? '';
    expect(unit).not.toContain('toHaveScreenshot');
  });
});
