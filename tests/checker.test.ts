import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { analyze } from '../src/analyze.js';
import { check } from '../src/checker.js';
import { Diagnostic } from '../src/diagnostics.js';
import { parse } from '../src/parser.js';

const FIXTURE = fs.readFileSync(path.join(__dirname, 'fixtures', 'store.grhm'), 'utf8');

function diagsFor(source: string): Diagnostic[] {
  const { nodes, diagnostics } = parse(source);
  const app = analyze(nodes, diagnostics);
  if (app !== undefined) check(app, diagnostics);
  return diagnostics;
}

function codesFor(source: string): string[] {
  return diagsFor(source).map((d) => d.code);
}

function page(body: string): string {
  return `(app a (page "/" home ${body}))`;
}

describe('checker', () => {
  it('accepts the store fixture without errors', () => {
    const diags = diagsFor(FIXTURE);
    expect(diags.filter((d) => d.severity === 'error')).toEqual([]);
  });

  it('E101 unknown operation, with suggestion', () => {
    const diags = diagsFor(page('(vv (txt "x"))'));
    const e = diags.find((d) => d.code === 'E101');
    expect(e).toBeDefined();
    expect(e?.suggestions).toContain('v');
  });

  it('E102 unknown property, with suggestion', () => {
    const diags = diagsFor(page('(txt "x" :colr "#fff")'));
    const e = diags.find((d) => d.code === 'E102');
    expect(e).toBeDefined();
    expect(e?.suggestions).toContain(':color');
  });

  it('E103 invalid enum value', () => {
    expect(codesFor(page('(txt "x" :weight heavy)'))).toContain('E103');
  });

  it('E104 wrong positional shape', () => {
    expect(codesFor('(app a (state))')).toContain('E104');
  });

  it('E105 dangling keyword', () => {
    expect(codesFor(page('(v :pad)'))).toContain('E105');
  });

  it('E106 missing required component prop', () => {
    const source = '(app a (component chip (props (label string)) (txt label)) (page "/" home (chip)))';
    expect(codesFor(source)).toContain('E106');
  });

  it('E107 duplicate declaration', () => {
    expect(codesFor('(app a (state x 1) (state x 2))')).toContain('E107');
  });

  it('E108 duplicate route', () => {
    expect(codesFor('(app a (page "/" home (txt "a")) (page "/" other (txt "b")))')).toContain('E108');
  });

  it('E109 invalid expression op and arity', () => {
    expect(codesFor(page('(txt (frobnicate 1))'))).toContain('E109');
    expect(codesFor(page('(txt (= 1))'))).toContain('E109');
  });

  it('E110 declaration in element position', () => {
    expect(codesFor(page('(state x 1)'))).toContain('E110');
  });

  it('E201 unknown reference, with suggestion', () => {
    const diags = diagsFor('(app a (state count 0) (page "/" home (txt cont)))');
    const e = diags.find((d) => d.code === 'E201');
    expect(e).toBeDefined();
    expect(e?.suggestions).toContain('count');
  });

  it('E202 set target must be writable', () => {
    const source = '(app a (data (resource r "/x" :default (arr))) (page "/" home (btn "x" (click (set r 1)))))';
    expect(codesFor(source)).toContain('E202');
  });

  it('E203 unknown navigation target', () => {
    expect(codesFor(page('(btn "go" (click (nav "/nowhere")))'))).toContain('E203');
  });

  it('E204 invalid resource field', () => {
    const source = '(app a (data (resource r "/x" :default (arr))) (page "/" home (txt r.datum)))';
    expect(codesFor(source)).toContain('E204');
  });

  it('E205 unknown token, with suggestion', () => {
    const diags = diagsFor('(app a (theme (token primary "#111")) (page "/" home (v :bg $primry (txt "x"))))');
    const e = diags.find((d) => d.code === 'E205');
    expect(e).toBeDefined();
    expect(e?.suggestions).toContain('$primary');
  });

  it('E206 missing route parameter', () => {
    const source = '(app a (page "/p/{id}" detail (txt id)) (page "/" home (btn "go" (click (nav (path "/p/{id}"))))))';
    expect(codesFor(source)).toContain('E206');
  });

  it('W301 unguarded resource data read', () => {
    const source = '(app a (data (resource r "/x")) (page "/" home (each p r.data (txt p.name))))';
    const diags = diagsFor(source);
    expect(diags.some((d) => d.code === 'W301' && d.severity === 'warning')).toBe(true);
  });

  it('W301 not raised when guarded or defaulted', () => {
    const guarded = '(app a (data (resource r "/x")) (page "/" home (if r.loading (txt "...") (each p r.data (txt p.name)))))';
    expect(codesFor(guarded)).not.toContain('W301');
    const defaulted = '(app a (data (resource r "/x" :default (arr))) (page "/" home (each p r.data (txt p.name))))';
    expect(codesFor(defaulted)).not.toContain('W301');
  });

  it('W401 image without alt', () => {
    expect(codesFor(page('(img "/a.png")'))).toContain('W401');
  });

  it('W402 button without a label', () => {
    expect(codesFor(page('(btn (click (nav "/")))'))).toContain('W402');
  });

  it('diagnostics carry node IDs and spans', () => {
    const diags = diagsFor(page('(txt "x" :colr "#fff")'));
    const e = diags.find((d) => d.code === 'E102');
    expect(e?.nodeId).toBeTruthy();
    expect(e?.span).toBeDefined();
    expect(e?.op).toBe('text');
    expect(e?.field).toBe('colr');
  });
});
