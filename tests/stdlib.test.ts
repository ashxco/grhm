import { describe, expect, it } from 'vitest';
import { compile } from '../src/codegen/index.js';
import { contextFromApp, evalExpr } from '../src/eval.js';
import { parse } from '../src/parser.js';
import { inferInfo, stateInitializerScope, typeScriptType } from '../src/typing.js';

const cases: [string, unknown, string][] = [
  ['(keys (obj :a 1))', ['a'], 'string[]'],
  ['(values (obj :a 1))', [1], 'number[]'],
  ['(entries (obj :a 1))', [['a', 1]], '(string | number)[][]'],
  ['(from-entries (arr (arr "a" 1)))', { a: 1 }, 'Record<string, any>'],
  ['(assoc (obj :a 1) "b" true)', { a: 1, b: true }, '{ "a": number; "b": boolean }'],
  ['(dissoc (obj :a 1 :b true) "a")', { b: true }, '{ "b": boolean }'],
  ['(merge (obj :a 1) (obj :a true))', { a: true }, '{ "a": boolean }'],
  ['(has-key (obj :a 1) "a")', true, 'boolean'],
  ['(json-parse "[1,true]")', [1, true], 'any'],
  ['(json-stringify (arr 1 true))', '[1,true]', 'string'],
  ['(flat-map (lambda (x) (arr x x)) (arr 1 2))', [1, 1, 2, 2], 'number[]'],
  ['(flatten (arr (arr 1) (arr 2)))', [1, 2], 'number[]'],
  ['(unique (arr 1 1 2))', [1, 2], 'number[]'],
  ['(zip (arr 1 2) (arr 3))', [[1, 3]], 'number[][]'],
  ['(chunk 2 (arr 1 2 3))', [[1, 2], [3]], 'number[][]'],
  ['(group-by (lambda (x) (to-str (mod x 2))) (arr 1 2 3))', { '1': [1, 3], '0': [2] }, 'Record<string, any>'],
  ['(regex-test "^a" "ABC" "i")', true, 'boolean'],
  ['(regex-find "(a)?b" "b")', ['b', undefined], '(string | null | undefined)[] | null | undefined'],
  ['(regex-replace "a" "x" "banana")', 'bxnxnx', 'string'],
  ['(url-encode "a/b")', 'a%2Fb', 'string'],
  ['(url-decode "a%2Fb")', 'a/b', 'string'],
  ['(date-iso 0)', '1970-01-01T00:00:00.000Z', 'string'],
  ['(date-parse "1970-01-01T00:00:00.000Z")', 0, 'number | null | undefined'],
  ['(date-parse "nope")', null, 'number | null | undefined'],
  ['(to-num "42")', 42, 'number | null | undefined'],
  ['(to-num "abc")', null, 'number | null | undefined'],
  ['(or-else (to-num "x") 0)', 0, 'number'],
  ['(+ (or-else (to-num "1") 0) 1)', 2, 'number'],
  ['(to-fixed 2 (or-else (to-num "x") 0))', '0.00', 'string'],
  ['(clamp 0 10 20)', 10, 'number'],
  ['(trunc -1.9)', -1, 'number'], ['(sign -0)', -0, 'number'],
  ['(sin 0)', 0, 'number'], ['(cos 0)', 1, 'number'], ['(tan 0)', 0, 'number'],
  ['(asin 0)', 0, 'number'], ['(acos 1)', 0, 'number'], ['(atan 0)', 0, 'number'],
  ['(atan2 0 1)', 0, 'number'], ['(exp 0)', 1, 'number'], ['(log 1)', 0, 'number'], ['(log10 100)', 2, 'number'],
];

describe('extended standard library', () => {
  it.each(cases)('checks, infers, and evaluates %s', (source, expected, type) => {
    const result = compile(`(app test (page "/" home (txt (json-stringify ${source}))))`);
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    const expression = parse(source).nodes[0]!;
    expect(evalExpr(expression, contextFromApp(result.app))).toEqual(expected);
    expect(typeScriptType(inferInfo(expression, stateInitializerScope(result.app!)))).toBe(type);
  });

  it.each([
    '(clamp "bad" 10 2)', '(sin null)', '(atan2 1 "x")', '(url-encode 1)',
    '(date-iso "yesterday")', '(date-parse 42)', '(regex-test 1 "x")',
    '(keys null)', '(assoc 1 "key" 2)', '(merge (obj) 1)', '(has-key (arr) "x")',
    '(json-parse 2)', '(zip (arr) 1)', '(chunk "2" (arr))', '(unique false)',
    '(flat-map (lambda (x) (+ x 1)) (arr "bad"))',
    '(+ (json-parse "null") 1)',
    '(+ (url-encode "x") 1)', '(+ (has-key (obj) "x") 1)',
    '(+ (to-num "1") 1)', '(clamp (date-parse "x") 0 1)', '(sign (to-num "x"))',
    '(date-iso (date-parse "x"))', '(to-fixed 2 (to-num "x"))', '(to-fixed 2 "3.5")', '(to-fixed "2" 3.5)',
  ])('rejects invalid operands in %s', (source) => {
    const result = compile(`(app test (page "/" home (txt ${source})))`);
    expect(result.diagnostics.some((d) => d.code === 'E111')).toBe(true);
    expect(result.files.size).toBe(0);
  });
});
