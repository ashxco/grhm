import { describe, expect, it } from 'vitest';

import { compile } from '../src/codegen/index.js';

function errors(source: string) {
  return compile(source).diagnostics.filter((diagnostic) => diagnostic.severity === 'error');
}

function server(expression: string, declarations = ''): string {
  return `(app a ${declarations} (api (get "/api/result" ${expression})) (page "/" home (txt "x")))`;
}

describe('server effect analysis', () => {
  const browserFn = '(fn browser-value (x) window.inner-width)';
  const asyncFn = '(use "./interop.ts" (import lookup)) (fn fetch-value (x) (lookup x))';

  it.each([
    '(let ((result (browser-value 1))) result)',
    '(map browser-value (arr 1))',
    '(cond ((browser-value 1) "wide") (else "narrow"))',
  ])('rejects browser dependencies in %s', (expression) => {
    expect(errors(server(expression, browserFn)).some((diagnostic) => diagnostic.code === 'E805')).toBe(true);
  });

  it.each([
    '(let ((result (fetch-value 1))) (obj :result result))',
    '(map fetch-value (arr 1))',
    '(map lookup (arr 1))',
    '(let ((callback lookup)) (map callback (arr 1)))',
    '(let ((callback lookup)) (call callback 1))',
  ])('rejects nested Promise-capable dependencies in %s', (expression) => {
    expect(errors(server(expression, asyncFn)).some((diagnostic) => diagnostic.code === 'E805')).toBe(true);
  });

  it('applies effect checks to transactions, jobs, and pure test assertions', () => {
    const transaction = server('(tx (map fetch-value (arr 1)))', asyncFn);
    expect(errors(transaction).some((diagnostic) => diagnostic.op === 'tx' && diagnostic.code === 'E805')).toBe(true);
    const job = `(app a ${browserFn} (db (table entries (id auto))) (job task :every 60 (map browser-value (arr 1))) (page "/" home (txt "x")))`;
    expect(errors(job).some((diagnostic) => diagnostic.code === 'E805')).toBe(true);
    const assertion = `(app a ${browserFn} (page "/" home (txt "x"))) (tests (test "pure" (expect-eq (map browser-value (arr 1)) (arr 1))))`;
    expect(errors(assertion).some((diagnostic) => diagnostic.code === 'E701')).toBe(true);
  });

  it('follows imported callbacks through declared and local function parameters', () => {
    expect(errors(server('(run lookup)', `${asyncFn} (fn run (callback) (map callback (arr 1)))`)).some((diagnostic) => diagnostic.code === 'E805')).toBe(true);
    expect(errors(server('(let ((run (lambda (callback) (map callback (arr 1))))) (call run lookup))', asyncFn)).some((diagnostic) => diagnostic.code === 'E805')).toBe(true);
  });

  it('keeps direct awaited interop and pure callbacks valid', () => {
    expect(errors(server('(fetch-value 1)', asyncFn))).toEqual([]);
    expect(errors(server('(call fetch-value 1)', asyncFn))).toEqual([]);
    expect(errors(server('(map increment (arr 1))', '(fn increment (x) (+ x 1))'))).toEqual([]);
    expect(errors(server('(let ((lookup (lambda (x) (+ x 1)))) (map lookup (arr 1)))', asyncFn))).toEqual([]);
    expect(errors(server('(map (lambda (window) window) (arr 1))'))).toEqual([]);
    expect(errors(server('(identity 1)', '(fn identity (window) window)'))).toEqual([]);
    expect(errors('(app a (api (get "/api/{window}" window)) (page "/" home (txt "x")))')).toEqual([]);
  });
});

describe('callable expression validation', () => {
  it.each(['map', 'filter', 'find', 'some', 'every', 'sort-by'])('rejects a known number supplied to %s', (operation) => {
    const result = compile(`(app a (page "/" home (txt (let ((callback 3)) (${operation} callback (arr 1))))))`);
    expect(result.diagnostics.some((diagnostic) => diagnostic.code === 'E109')).toBe(true);
    expect(result.files.size).toBe(0);
  });

  it('validates explicit call targets and declared function signatures', () => {
    expect(errors('(app a (state value 1) (page "/" home (txt (call value))))').some((diagnostic) => diagnostic.code === 'E601')).toBe(true);
    expect(errors('(app a (fn increment ((value number)) (+ value 1)) (page "/" home (txt (call increment))))').some((diagnostic) => diagnostic.code === 'E112')).toBe(true);
    expect(errors('(app a (fn increment ((value number)) (+ value 1)) (page "/" home (txt (call increment "bad"))))').some((diagnostic) => diagnostic.code === 'E111')).toBe(true);
    expect(errors('(app a (fn increment ((value number)) (+ value 1)) (page "/" home (txt (call increment 1))))')).toEqual([]);
    expect(errors('(app a (page "/" home (txt (let ((callback (lambda (x) (+ x 1)))) (call callback 2)))))')).toEqual([]);
  });
});
