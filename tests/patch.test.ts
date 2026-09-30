import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { ListNode, getProp, walkLists } from '../src/ast.js';
import { computeRevision } from '../src/codegen/index.js';
import { format } from '../src/format.js';
import { parse } from '../src/parser.js';
import { applyPatch } from '../src/patch.js';

const FIXTURE = fs.readFileSync(path.join(__dirname, 'fixtures', 'store.grhm'), 'utf8');

function revisionOf(source: string): string {
  return computeRevision(format(parse(source).nodes));
}

function findFirst(source: string, op: string): ListNode {
  const { nodes } = parse(source);
  let found: ListNode | undefined;
  walkLists(nodes, (node) => {
    const head = node.items[0];
    if (found === undefined && head !== undefined && head.kind === 'ident' && head.name === op) {
      found = node;
    }
  });
  if (found === undefined) throw new Error(`no ${op} node in source`);
  return found;
}

describe('patch protocol', () => {
  it('sets a property on a target node', () => {
    const section = findFirst(FIXTURE, 'section');
    const rev = revisionOf(FIXTURE);
    const result = applyPatch(FIXTURE, `(patch :revision "${rev}" :target ${section.id} (set radius 16) (set pad 24))`);
    expect(result.ok).toBe(true);
    expect(result.changed).toEqual([section.id]);
    const patched = findFirst(result.newSource ?? '', 'section');
    expect(getProp(patched, 'radius')?.kind).toBe('number');
    expect(getProp(patched, 'pad')?.kind).toBe('number');
  });

  it('replaces an existing property value', () => {
    const grid = findFirst(FIXTURE, 'grid');
    const result = applyPatch(FIXTURE, `(patch :target ${grid.id} (set cols 6))`);
    expect(result.ok).toBe(true);
    const patched = findFirst(result.newSource ?? '', 'grid');
    const cols = getProp(patched, 'cols');
    expect(cols?.kind === 'number' && cols.value === 6).toBe(true);
  });

  it('appends a child element', () => {
    const section = findFirst(FIXTURE, 'section');
    const result = applyPatch(FIXTURE, `(patch :target ${section.id} (append (txt "Sale ends Sunday")))`);
    expect(result.ok).toBe(true);
    expect(result.newSource).toContain('Sale ends Sunday');
  });

  it('rejects stale revisions with a conflict', () => {
    const section = findFirst(FIXTURE, 'section');
    const result = applyPatch(FIXTURE, `(patch :revision "deadbeef" :target ${section.id} (set pad 8))`);
    expect(result.ok).toBe(false);
    expect(result.conflict).toBe(true);
    expect(result.currentRevision).toBe(revisionOf(FIXTURE));
    expect(result.diagnostics.some((d) => d.code === 'E504')).toBe(true);
  });

  it('warns when no revision precondition is given', () => {
    const section = findFirst(FIXTURE, 'section');
    const result = applyPatch(FIXTURE, `(patch :target ${section.id} (set pad 8))`);
    expect(result.ok).toBe(true);
    expect(result.diagnostics.some((d) => d.code === 'W501')).toBe(true);
  });

  it('is atomic: a failing operation leaves no changes', () => {
    const section = findFirst(FIXTURE, 'section');
    const result = applyPatch(FIXTURE, `(patch :target ${section.id} (set pad 8) (delete no-such-prop))`);
    expect(result.ok).toBe(false);
    expect(result.newSource).toBeUndefined();
    expect(result.diagnostics.some((d) => d.code === 'E501')).toBe(true);
  });

  it('rejects patches that would produce an invalid program', () => {
    const section = findFirst(FIXTURE, 'section');
    const result = applyPatch(FIXTURE, `(patch :target ${section.id} (append (btn "Go" (click (nav "/nowhere")))))`);
    expect(result.ok).toBe(false);
    expect(result.diagnostics.some((d) => d.code === 'E503')).toBe(true);
    expect(result.diagnostics.some((d) => d.code === 'E203')).toBe(true);
  });

  it('rejects unknown target nodes', () => {
    const result = applyPatch(FIXTURE, '(patch :target nope123 (set pad 8))');
    expect(result.ok).toBe(false);
    expect(result.diagnostics.some((d) => d.code === 'E501')).toBe(true);
  });

  it('moves a node before a sibling', () => {
    const source = '(app a (page "/" home (v (txt "one" :id "t1") (txt "two" :id "t2"))))';
    const result = applyPatch(source, '(patch :target t2 (move :before t1))');
    expect(result.ok).toBe(true);
    const patched = result.newSource ?? '';
    expect(patched.indexOf('"two"')).toBeLessThan(patched.indexOf('"one"'));
  });

  it('rejects move operations with conflicting destinations', () => {
    const source = '(app a (page "/" home (v :id "box" (txt "one" :id "t1") (txt "two" :id "t2"))))';
    const result = applyPatch(source, '(patch :target t2 (move :before t1 :into box))');
    expect(result.ok).toBe(false);
    expect(result.diagnostics.some((d) => d.code === 'E502')).toBe(true);
  });

  it('reports the replacement node ID instead of the removed target ID', () => {
    const source = '(app a (page "/" home (txt "old" :id "old-id")))';
    const result = applyPatch(source, '(patch :target old-id (replace (txt "new" :id "new-id")))');
    expect(result.ok).toBe(true);
    expect(result.changed).toEqual(['new-id']);
    expect(result.newSource).toContain(':id "new-id"');
  });

  it('rejects moving a node into its own subtree', () => {
    const source = '(app a (page "/" home (v :id "outer" (v :id "inner" (txt "x")))))';
    const result = applyPatch(source, '(patch :target outer (move :into inner))');
    expect(result.ok).toBe(false);
    expect(result.diagnostics.some((d) => d.code === 'E502')).toBe(true);
  });

  it('rejects moving a node relative to itself', () => {
    const source = '(app a (page "/" home (v (txt "x" :id "same"))))';
    const result = applyPatch(source, '(patch :target same (move :before same))');
    expect(result.ok).toBe(false);
    expect(result.diagnostics.some((d) => d.code === 'E502')).toBe(true);
  });

  it('returns a fresh revision after success', () => {
    const grid = findFirst(FIXTURE, 'grid');
    const result = applyPatch(FIXTURE, `(patch :target ${grid.id} (set cols 6))`);
    expect(result.ok).toBe(true);
    expect(result.revision).toBeDefined();
    expect(result.revision).not.toBe(revisionOf(FIXTURE));
    expect(result.revision).toBe(revisionOf(result.newSource ?? ''));
  });
});
