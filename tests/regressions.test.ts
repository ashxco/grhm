import { describe, expect, it } from 'vitest';

import { compile } from '../src/codegen/index.js';
import { parse } from '../src/parser.js';
import { findReferences, resolveSymbolAt } from '../src/references.js';
import { GrhmProject } from '../src/sdk.js';

function errors(source: string): string[] {
  return compile(source).diagnostics.filter((d) => d.severity === 'error').map((d) => `${d.code}:${d.message}`);
}

describe('security and clean-code generation regressions', () => {
  it('serializes concat literals without a generated template-literal boundary', () => {
    const hostile = 'safe\\`still-data';
    const result = compile(`(app a (state x (concat ${JSON.stringify(hostile)})) (page "/" home (txt x)))`);
    expect(result.diagnostics).toEqual([]);
    const state = result.files.get('state.ts') ?? '';
    expect(state).toContain(JSON.stringify(hostile));
    expect(state).not.toContain('createStore<string>(`');
  });

  it('keeps boolean typing, SQL column needles, and route specificity aligned with output', () => {
    const booleanResult = compile('(app a (state flag (and (!= 1 0) (!= 2 0))) (page "/" home (txt flag)))');
    expect(booleanResult.diagnostics).toEqual([]);
    expect(booleanResult.files.get('state.ts')).toContain('createStore<boolean>(!!(((1 !== 0)) && ((2 !== 0))))');

    const whereResult = compile(
      '(app a (db (table t (id auto) (name string) (email string))) (api (get "/api/t" (select t :where (contains name email)))) (page "/" home (txt "x")))',
    );
    expect(whereResult.diagnostics).toEqual([]);
    expect(whereResult.files.get('server.ts')).toContain('where: "(COALESCE(instr(\\"name\\", grhm_string(\\"email\\", 0)), 0) > 0)", args: []');

    const routes = compile(
      '(app a (auth users) (api (get "/api/{name}" (obj :public true)) (get "/api/secret" :auth true (obj :secret true))) (page "/" home (txt "x")))',
    );
    expect(routes.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    const server = routes.files.get('server.ts') ?? '';
    expect(server.indexOf('pattern: "/api/secret"')).toBeLessThan(server.indexOf('pattern: "/api/{name}"'));
  });

  it('rejects unchecked expressions, unsafe server forms, and schema typos', () => {
    expect(errors('(app a (page "/" home :title missing (txt "x")))').some((e) => e.startsWith('E201:'))).toBe(true);
    expect(errors('(app a (data (resource r "/x" :default missing)) (page "/" home (txt r.loading)))').some((e) => e.startsWith('E201:'))).toBe(true);
    expect(
      errors('(app a (db (table t (id auto) (name string))) (api (post "/api/t" (tx (tx (insert t :name "x"))))) (page "/" home (txt "x")))').some(
        (e) => e.startsWith('E805:'),
      ),
    ).toBe(true);
    expect(
      errors('(app a (db (table t (id auto))) (api (get "/api/t" (select t :where))) (page "/" home (txt "x")))').some((e) => e.startsWith('E105:')),
    ).toBe(true);
    expect(errors('(app a (db (table t (id auto) (x number :default "7") (y string :optinal true))) (page "/" home (txt "x")))')).toHaveLength(2);
    expect(errors('(app a (api (post "/mutate" (obj :ok true))) (page "/" home (txt "x")))').some((e) => e.startsWith('E804:'))).toBe(true);
  });

  it('rejects generated-name collisions and known type-boundary mismatches', () => {
    expect(errors('(app a (state create 1) (page "/" home (txt create)))').some((e) => e.startsWith('E107:'))).toBe(true);
    expect(errors('(app a (state foo 1) (state set-foo 2) (page "/" home (txt set-foo)))').some((e) => e.startsWith('E107:'))).toBe(true);
    expect(errors('(app a (fn count (x) x) (page "/" home (txt "x")))').some((e) => e.startsWith('E107:'))).toBe(true);
    expect(errors('(app a (component slot (txt "own")) (page "/" home (slot)))').some((e) => e.startsWith('E107:'))).toBe(true);
    expect(errors('(app a (use "pkg" (import create-store)) (state x (create-store 1)) (page "/" home (txt x)))').some((e) => e.startsWith('E107:'))).toBe(true);
    expect(errors('(app a (state n 1) (page "/" home (btn "x" (click (set n "oops")))))').some((e) => e.startsWith('E111:'))).toBe(true);
    expect(errors('(app a (component c (props (n number)) (txt n)) (page "/" home (c :n "oops")))').some((e) => e.startsWith('E111:'))).toBe(true);
  });

  it('rejects browser effects and nested Promise-capable interop in Node handlers', () => {
    expect(
      errors('(app a (fn width () window.inner-width) (api (get "/api/x" (width))) (page "/" home (txt "x")))').some((e) => e.startsWith('E805:')),
    ).toBe(true);
    expect(
      errors('(app a (use "pkg" (import lookup)) (db (table t (id auto) (name string))) (api (post "/api/t" (insert t :name (lookup)))) (page "/" home (txt "x")))').some(
        (e) => e.startsWith('E805:'),
      ),
    ).toBe(true);
  });
});

describe('tooling boundary regressions', () => {
  it('contains configured project paths and rejects shell-active path text', () => {
    expect(() => new GrhmProject({ root: '/tmp/grhm-project', entry: 'app.grhm', outDir: '../escaped' })).toThrow(/inside the project root/);
    expect(() => new GrhmProject({ root: '/tmp/grhm-project', entry: 'app.grhm', outDir: 'gen/$(unsafe)' })).toThrow(/relative path/);
  });

  it('does not bind page parameters or i18n keys to same-named state symbols', () => {
    const routeSource = '(app a (state id "global") (page "/{id}" home :title id (txt id)))';
    const routeRoots = parse(routeSource, 'app.grhm').nodes;
    const routeState = resolveSymbolAt(routeRoots, routeSource.indexOf('id "global"') + 1, 'app.grhm');
    expect(routeState).toBeDefined();
    expect(findReferences(routeRoots, routeState!)).toHaveLength(1);

    const i18nSource = '(app a (state greeting "state") (i18n :default en (locale en (msg greeting "Hello"))) (page "/" home (txt (t greeting))))';
    const i18nRoots = parse(i18nSource, 'app.grhm').nodes;
    const i18nState = resolveSymbolAt(i18nRoots, i18nSource.indexOf('greeting "state"') + 1, 'app.grhm');
    expect(i18nState).toBeDefined();
    expect(findReferences(i18nRoots, i18nState!)).toHaveLength(1);
  });
});
