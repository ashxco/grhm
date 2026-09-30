import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { ListNode, walkLists } from '../src/ast.js';
import { format } from '../src/format.js';
import { parse } from '../src/parser.js';

const FIXTURE = fs.readFileSync(path.join(__dirname, 'fixtures', 'store.grhm'), 'utf8');

function idsByPath(source: string): Map<string, string> {
  const { nodes } = parse(source);
  const map = new Map<string, string>();
  walkLists(nodes, (node) => {
    const head = node.items[0];
    const op = head !== undefined && head.kind === 'ident' ? head.name : '?';
    map.set(node.id, op);
  });
  return map;
}

function findByOpAndText(source: string, op: string, text: string): ListNode | undefined {
  const { nodes } = parse(source);
  let found: ListNode | undefined;
  walkLists(nodes, (node) => {
    const head = node.items[0];
    const opName = head !== undefined && head.kind === 'ident' ? head.name : '';
    if (opName !== op || found !== undefined) return;
    const hasText = node.items.some((i) => i.kind === 'string' && i.value === text);
    if (hasText) found = node;
  });
  return found;
}

describe('stable node IDs', () => {
  it('assigns unique IDs to every list node', () => {
    const { nodes } = parse(FIXTURE);
    const seen = new Set<string>();
    walkLists(nodes, (node) => {
      expect(node.id).not.toBe('');
      expect(seen.has(node.id)).toBe(false);
      seen.add(node.id);
    });
  });

  it('IDs survive formatting', () => {
    const before = idsByPath(FIXTURE);
    const after = idsByPath(format(parse(FIXTURE).nodes));
    expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
  });

  it('IDs survive unrelated edits (adding a later page)', () => {
    const btnBefore = findByOpAndText(FIXTURE, 'btn', 'Shop all');
    const edited = FIXTURE.replace(/\)\n$/, '\n  (page "/about" about (v (txt "About"))))\n');
    const btnAfter = findByOpAndText(edited, 'btn', 'Shop all');
    expect(btnBefore?.id).toBeDefined();
    expect(btnAfter?.id).toBe(btnBefore?.id);
  });

  it('explicit string :id wins', () => {
    const { nodes } = parse('(app a (page "/" home (v (txt "x" :id "hero-text"))))');
    let found = false;
    walkLists(nodes, (node) => {
      if (node.id === 'hero-text') found = true;
    });
    expect(found).toBe(true);
  });

  it('expression :id inside each templates is not treated as identity', () => {
    const { nodes } = parse('(app a (page "/" home (each p items (card :id p.id (txt "x")))))');
    let cardId = '';
    walkLists(nodes, (node) => {
      const head = node.items[0];
      if (head !== undefined && head.kind === 'ident' && head.name === 'card') cardId = node.id;
    });
    expect(cardId).not.toBe('');
    expect(cardId).not.toContain('p.id');
  });
});
