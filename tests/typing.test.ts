import { describe, expect, it } from 'vitest';

import { compile } from '../src/codegen/index.js';
import { parse } from '../src/parser.js';
import { baseScope, inferInfo, typeLabel } from '../src/typing.js';

const wrap = (expression: string, declarations = ''): string => `(app a ${declarations} (page "/" home (txt ${expression})))`;
const errors = (source: string) => compile(source).diagnostics.filter((diagnostic) => diagnostic.severity === 'error');
function typeOf(expression: string, declarations = ''): string {
  const result = compile(wrap('"x"', declarations));
  expect(result.diagnostics.filter((diagnostic) => diagnostic.severity === 'error')).toEqual([]);
  const node = parse(expression).nodes[0];
  if (result.app === undefined || node === undefined) throw new Error('Expected a parsed expression and app');
  return typeLabel(inferInfo(node, baseScope(result.app), result.app.tables));
}

const table = '(db (table people (id auto) (name string) (age number :optional true)))';

describe('structured value inference', () => {
  it('retains element types through arrays, map, reduce, slicing and lookup', () => {
    expect(typeOf('(arr 1 2)')).toBe('list<number>');
    expect(typeOf('(map (lambda (n) (to-str n)) (arr 1 2))')).toBe('list<string>');
    expect(typeOf('(reduce (lambda (total n) (+ total n)) 0 (arr 1 2))')).toBe('number');
    expect(typeOf('(slice 0 1 (arr "one" "two"))')).toBe('list<string>');
    expect(typeOf('(first (arr 1 2))')).toBe('number | null');
    expect(typeOf('(first (arr))')).toBe('null');
    expect(typeOf('(or-else (first (arr 1 2)) 0)')).toBe('number');
    expect(typeOf('(arr 1 "two")')).toBe('list<number | string>');
    expect(typeOf('(not-null null)')).toBe('boolean');
  });

  it('infers records, fields, branches, and nested record lists', () => {
    expect(typeOf('(get (obj :name "Ada") "name")')).toBe('string');
    expect(typeOf('(get (obj :name "Ada") "missing")')).toBe('null');
    expect(typeOf('(let ((profile (obj :details (obj :age 12)))) profile.details.age)')).toBe('number');
    expect(typeOf('(if true 1 null)')).toBe('number | null');
    expect(typeOf('(cond (true 1))')).toBe('number | null');
    expect(typeOf('(attempt 1 null)')).toBe('number | null');
    expect(typeOf('(map (lambda (profile) profile.age) (arr (obj :age 12)))')).toBe('list<number>');
    expect(errors(wrap('(let ((profile (obj :details (obj :age 12)))) profile.details.typo)')).some((diagnostic) => diagnostic.code === 'E808')).toBe(true);
  });

  it('flows return types and row provenance through declared and anonymous functions', () => {
    const declarations = `${table} (fn identity (value) value) (fn double ((value number)) (* value 2))`;
    expect(typeOf('(identity (arr 1 2))', declarations)).toBe('list<number>');
    expect(typeOf('(map identity (select people))', declarations)).toBe('list<people row>');
    expect(typeOf('(let ((callback (lambda (value) (to-str value)))) (call callback 1))', declarations)).toBe('string');
    expect(typeOf('(double 2)', declarations)).toBe('number');
    expect(errors(wrap('(+ (identity "one") 2)', declarations)).some((diagnostic) => diagnostic.code === 'E111')).toBe(true);
    expect(errors(wrap('(double null)', declarations)).some((diagnostic) => diagnostic.code === 'E111')).toBe(true);
  });

  it('keeps opaque interop and external resource payloads unknown', () => {
    expect(typeOf('(lookup)', '(use "./interop.ts" (import lookup))')).toBe('unknown');
    expect(typeOf('remote.data', '(data (resource remote "/external" :default (arr)))')).toBe('unknown');
  });
});

describe('nullable checking and flow narrowing', () => {
  it.each(['(+ (first (arr 1)) 1)', '(+ (first (arr)) 1)', '(+ (if true 1 null) 1)', '(+ (get (obj :name "Ada") "missing") 1)'])('rejects a known absent value in %s', (expression) => {
    const result = compile(wrap(expression));
    expect(result.diagnostics.some((diagnostic) => diagnostic.code === 'E111')).toBe(true);
    expect(result.files.size).toBe(0);
  });

  it.each([
    '(let ((n (first (arr 1)))) (if (not-null n) (+ n 1) 0))',
    '(let ((n (first (arr 1)))) (if (is-null n) 0 (+ n 1)))',
    '(let ((n (first (arr 1)))) (if (not (is-null n)) (+ n 1) 0))',
    '(let ((n (first (arr 1)))) (cond ((is-null n) 0) (else (+ n 1))))',
    '(let ((n (first (arr 1)))) (and (not-null n) (> n 0)))',
    '(let ((n (first (arr 1)))) (or (is-null n) (> n 0)))',
    '(+ (or-else (first (arr 1)) 0) 1)',
  ])('accepts guarded nullable arithmetic in %s', (expression) => {
    expect(errors(wrap(expression))).toEqual([]);
  });

  it('preserves nullable row fields and narrows dotted paths in handlers and page branches', () => {
    const invalid = `(app a ${table} (api (get "/api/ages" (map (lambda (person) (+ person.age 1)) (select people)))) (page "/" home (txt "x")))`;
    expect(errors(invalid).some((diagnostic) => diagnostic.code === 'E111')).toBe(true);
    const valid = `(app a ${table} (api (get "/api/people" (select people))) (data (resource people "/api/people" :default (arr))) (page "/" home (each person people.data (when (not-null person.age) (txt (+ person.age 1))))))`;
    expect(errors(valid)).toEqual([]);
    expect(errors(wrap('(let ((person (first (arr (obj :name "Ada"))))) person.name)')).some((diagnostic) => diagnostic.code === 'E111')).toBe(true);
    expect(errors(wrap('(let ((person (first (arr (obj :name "Ada"))))) (if (not-null person) person.name "missing"))'))).toEqual([]);
    expect(errors(wrap('(let ((n (first (arr 1)))) (if (!= n null) (+ n 1) 0))')).some((diagnostic) => diagnostic.code === 'E111')).toBe(true);
    expect(errors('(app a (state value (let ((item (first (arr)))) (if (!= item null) item.name "none"))) (page "/" home (txt "x")))').some((diagnostic) => diagnostic.code === 'E111')).toBe(true);
  });

  it('preserves writable storage contracts while narrowing reads', () => {
    const global = '(app a (state item (if true (obj :name "a") null)) (page "/" home (when (not-null item) (btn item.name (click (set item null))))))';
    const local = '(app a (page "/" home (local item (if true (obj :name "a") null)) (when (not-null item) (btn item.name (click (set item null))))))';
    expect(errors(global)).toEqual([]);
    expect(errors(local)).toEqual([]);
    const dotted = '(app a (state item (obj :name (if true "a" null))) (page "/" home (when (not-null item.name) (btn "x" (click (set item.name "b"))))))';
    expect(errors(dotted).some((diagnostic) => diagnostic.code === 'E202')).toBe(true);
  });

  it('narrows nullable list elements through a filter predicate', () => {
    expect(typeOf('(filter (lambda (n) (not-null n)) (arr 1 null 2))')).toBe('list<number>');
    expect(errors(wrap('(sum (filter (lambda (n) (not-null n)) (arr 1 null 2)))'))).toEqual([]);
    expect(typeOf('(filter present (arr 1 null 2))', '(fn present (n) (not-null n))')).toBe('list<number>');
    const strictFilter = '(map increment (filter (lambda (n) (!= n null)) (arr (first (arr)) 1)))';
    expect(errors(wrap(strictFilter, '(fn increment ((n number)) (+ n 1))')).some((diagnostic) => diagnostic.code === 'E111')).toBe(true);
  });
});

describe('callable and collection contracts', () => {
  it('checks lambda aliases, callback argument types, and untyped function bodies at known call sites', () => {
    const declarations = '(fn double ((value number)) (* value 2)) (fn untyped (value) (+ value 1))';
    for (const expression of ['(map double (arr "one"))', '(untyped "one")', '(let ((callback (lambda (n) (+ n 1)))) (call callback "one"))']) {
      expect(errors(wrap(expression, declarations)).some((diagnostic) => diagnostic.code === 'E111')).toBe(true);
    }
    expect(errors(wrap('(let ((callback (lambda (n) (+ n 1)))) (call callback))')).some((diagnostic) => diagnostic.code === 'E112')).toBe(true);
    expect(errors(wrap('(let ((callback (lambda (n) (+ n 1)))) (map callback (arr 1 2)))'))).toEqual([]);
    expect(errors(wrap('(let ((callback (lambda (n) (+ n 1)))) (filter callback (arr 1 2)))'))).toEqual([]);
    expect(errors(wrap('(let ((callback (if true (lambda (n) (+ n 1)) null))) (call callback 1))')).some((diagnostic) => diagnostic.code === 'E601')).toBe(true);
    expect(errors(wrap('(let ((callback (if true (lambda (n) (+ n 1)) (lambda (n) (- n 1))))) (call callback 1))'))).toEqual([]);
    expect(errors(wrap('(let ((callback (if true (lambda (n) (+ n 1)) null))) (if (not-null callback) (call callback 1) 0))'))).toEqual([]);
  });

  it('validates list consumers, inferred each elements, and state writes', () => {
    expect(errors(wrap('(map (lambda (n) n) 1)')).some((diagnostic) => diagnostic.code === 'E111')).toBe(true);
    expect(errors('(app a (page "/" home (each n (arr "one") (txt (+ n 1)))))').some((diagnostic) => diagnostic.code === 'E111')).toBe(true);
    expect(errors('(app a (state numbers (arr 1 2)) (page "/" home (btn "Change" (click (set numbers (arr "one"))))))').some((diagnostic) => diagnostic.code === 'E111')).toBe(true);
    expect(errors('(app a (state numbers (arr)) (page "/" home (btn "Change" (click (set numbers (arr 1))))))')).toEqual([]);
    expect(errors(wrap('(sum (arr "1" "2"))'))).toEqual([]);
  });

  it('checks required and optional input contracts with nullable values', () => {
    const declarations = `${table} (api (post "/api/person" (input (name string) (age number :optional true)) (insert people :name body.name :age body.age)))`;
    expect(errors(wrap('"x"', declarations))).toEqual([]);
    const invalid = `(app a ${table} (api (post "/api/person" (input (name string :optional true)) (insert people :name body.name))) (page "/" home (txt "x")))`;
    expect(errors(invalid).some((diagnostic) => diagnostic.code === 'E111')).toBe(true);
    expect(errors(wrap('"x"', `${table} (fn broken ((person people)) (+ (get person "missing") 1))`)).some((diagnostic) => diagnostic.code === 'E111')).toBe(true);
  });

  it('checks inferred property values and callback state return types', () => {
    expect(errors('(app a (fn width () "wide") (page "/" home (img "image.png" :alt "Image" :w (obj :bad 1))))').some((diagnostic) => diagnostic.code === 'E111')).toBe(true);
    expect(errors('(app a (state callback (lambda (n) (+ n 1))) (page "/" home (btn "Change" (click (set callback (lambda (n) (concat n "!")))))))').some((diagnostic) => diagnostic.code === 'E111')).toBe(true);
    const unions = `${table} (db (table notes (id auto) (text string))) (fn bad ((a people) (b notes) (flag boolean)) (let ((value (if flag a b))) value.name))`;
    expect(errors(wrap('"x"', unions)).some((diagnostic) => diagnostic.code === 'E803')).toBe(true);
  });

  it('emits useful state, parameter, and return annotations', () => {
    const source = `(app a ${table} (fn double ((value number)) (* value 2)) (fn person-name ((person people)) person.name) (fn factorial ((n number)) (if (<= n 1) 1 (* n (factorial (- n 1))))) (state names (map (lambda (n) (to-str n)) (arr 1 2))) (state maybe (first (arr 1))) (page "/" home (txt "x")))`;
    const result = compile(source);
    expect(result.diagnostics.filter((diagnostic) => diagnostic.severity === 'error')).toEqual([]);
    expect(result.files.get('state.ts')).toContain('createStore<string[]>');
    expect(result.files.get('state.ts')).toContain('createStore<number | null | undefined>');
    expect(result.files.get('lib.ts')).toContain('export function double(value: number): number');
    expect(result.files.get('lib.ts')).toContain('export function factorial(n: number): number');
    expect(result.files.get('lib.ts')).toContain('"age": number | null | undefined');
  });
});
