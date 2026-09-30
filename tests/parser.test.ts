import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { equalStructure, isList, opName } from '../src/ast.js';
import { format } from '../src/format.js';
import { lex } from '../src/lexer.js';
import { parse } from '../src/parser.js';

const FIXTURE = fs.readFileSync(path.join(__dirname, 'fixtures', 'store.grhm'), 'utf8');

describe('lexer', () => {
  it('lexes atoms, keywords, and strings', () => {
    const { tokens, diagnostics } = lex('(txt "hi \\"there\\"" :pad 16 some-ident 3.5 -2)');
    expect(diagnostics).toHaveLength(0);
    const kinds = tokens.map((t) => t.kind);
    expect(kinds).toEqual(['lparen', 'ident', 'string', 'keyword', 'number', 'ident', 'number', 'number', 'rparen', 'eof']);
    expect(tokens[2]?.text).toBe('hi "there"');
  });

  it('skips comments', () => {
    const { tokens } = lex('; a comment\n(v) ; trailing');
    expect(tokens.map((t) => t.kind)).toEqual(['lparen', 'ident', 'rparen', 'eof']);
  });

  it('tracks line and column', () => {
    const { tokens } = lex('(v\n  (txt "x"))');
    const txt = tokens.find((t) => t.text === 'txt');
    expect(txt?.span.line).toBe(2);
    expect(txt?.span.col).toBe(4);
  });

  it('reports unterminated strings', () => {
    const { diagnostics } = lex('(txt "oops)');
    expect(diagnostics.some((d) => d.code === 'E001')).toBe(true);
  });

  it('lexes css-unit idents like 16px as idents', () => {
    const { tokens } = lex('1rem');
    expect(tokens[0]?.kind).toBe('ident');
  });
});

describe('parser', () => {
  it('parses nested structure', () => {
    const { nodes, diagnostics } = parse('(app a (page "/" home (v (txt "hi"))))');
    expect(diagnostics).toHaveLength(0);
    expect(nodes).toHaveLength(1);
    const app = nodes[0];
    expect(app !== undefined && isList(app) && opName(app) === 'app').toBe(true);
  });

  it('converts true/false/null idents', () => {
    const { nodes } = parse('(x true false null none)');
    const list = nodes[0];
    if (list === undefined || !isList(list)) throw new Error('expected list');
    expect(list.items.map((i) => i.kind)).toEqual(['ident', 'boolean', 'boolean', 'null', 'null']);
  });

  it('reports unbalanced parens with codes', () => {
    expect(parse('(v (txt "x")').diagnostics.some((d) => d.code === 'E003')).toBe(true);
    expect(parse('(v))').diagnostics.some((d) => d.code === 'E002')).toBe(true);
  });

  it('recovers from long malformed input without overflowing the stack', () => {
    expect(parse(')'.repeat(5000)).diagnostics).toHaveLength(5000);
    const deep = parse('('.repeat(5000) + ')'.repeat(5000) + ' (txt "recovered")');
    expect(deep.diagnostics.map((d) => d.code)).toEqual(['E004']);
    const recovered = deep.nodes.at(-1)!;
    expect(isList(recovered) && opName(recovered)).toBe('txt');
    expect(parse('('.repeat(5000)).diagnostics.some((d) => d.code === 'E004')).toBe(true);
  });
});

describe('formatter', () => {
  it('round-trips: parse -> format -> parse is structurally equal', () => {
    const first = parse(FIXTURE);
    expect(first.diagnostics).toHaveLength(0);
    const formatted = format(first.nodes);
    const second = parse(formatted);
    expect(second.diagnostics).toHaveLength(0);
    expect(first.nodes).toHaveLength(second.nodes.length);
    for (let i = 0; i < first.nodes.length; i += 1) {
      expect(equalStructure(first.nodes[i]!, second.nodes[i]!)).toBe(true);
    }
  });

  it('is idempotent', () => {
    const once = format(parse(FIXTURE).nodes);
    const twice = format(parse(once).nodes);
    expect(twice).toBe(once);
  });

  it('keeps short forms inline', () => {
    const out = format(parse('(txt "hello")').nodes);
    expect(out).toBe('(txt "hello")\n');
  });

  it('escapes strings', () => {
    const out = format(parse('(txt "a\\"b\\nc")').nodes);
    expect(out).toContain('"a\\"b\\nc"');
  });

  it('preserves negative zero through canonical formatting', () => {
    const canonical = format(parse('-0').nodes);
    expect(canonical).toBe('-0\n');
    const reparsed = parse(canonical).nodes[0];
    expect(reparsed?.kind === 'number' && Object.is(reparsed.value, -0)).toBe(true);
  });
});
