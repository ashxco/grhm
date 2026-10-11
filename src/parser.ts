import { ListNode, SExpr } from './ast.js';
import { Diagnostic, makeDiag } from './diagnostics.js';
import { editAt, fixesOf, makeFix, replaceSpan } from './fix-builders.js';
import { assignIds } from './ids.js';
import { lex, Token } from './lexer.js';

export interface ParseResult {
  nodes: SExpr[];
  diagnostics: Diagnostic[];
}

/** Bound recursion throughout parsing, formatting, checking, and generation. */
export const MAX_PARSE_DEPTH = 256;

/**
 * Parse GRHM source into a canonical AST with stable node IDs assigned.
 * Recovers from unbalanced parentheses so later phases still get a tree.
 */
export function parse(source: string, file?: string): ParseResult {
  const { tokens, diagnostics } = lex(source, file);
  let index = 0;

  const peek = (): Token => tokens[index] ?? tokens[tokens.length - 1]!;
  const next = (): Token => {
    const t = peek();
    if (t.kind !== 'eof') index += 1;
    return t;
  };

  const parseExpr = (depth = 0): SExpr | undefined => {
    const t = next();
    switch (t.kind) {
      case 'eof':
        return undefined;
      case 'rparen':
        // Deleting the stray paren is a choice: it may instead mark a missing "(" earlier.
        diagnostics.push(
          makeDiag('E002', 'error', 'Unexpected ")"', {
            span: t.span,
            received: ')',
            expected: 'a matching open parenthesis',
            fixes: fixesOf(replaceSpan(t.span, '', 'Delete ")"', 'review')),
          }),
        );
        return undefined;
      case 'string':
        return { kind: 'string', value: t.text, span: t.span };
      case 'number':
        return { kind: 'number', value: Number(t.text), span: t.span };
      case 'keyword':
        return { kind: 'keyword', name: t.text, span: t.span };
      case 'ident':
        if (t.text === 'true') return { kind: 'boolean', value: true, span: t.span };
        if (t.text === 'false') return { kind: 'boolean', value: false, span: t.span };
        if (t.text === 'null' || t.text === 'none') return { kind: 'null', span: t.span };
        return { kind: 'ident', name: t.text, span: t.span };
      case 'lparen': {
        if (depth >= MAX_PARSE_DEPTH) {
          diagnostics.push(makeDiag('E004', 'error', `Maximum nesting depth (${MAX_PARSE_DEPTH}) exceeded`, {
            span: t.span, received: String(depth + 1), expected: `at most ${MAX_PARSE_DEPTH} nested lists`,
          }));
          // Skip this subtree iteratively, then recover at its following sibling.
          let pending = 1;
          while (pending > 0 && peek().kind !== 'eof') {
            const skipped = next();
            if (skipped.kind === 'lparen') pending++;
            else if (skipped.kind === 'rparen') pending--;
          }
          return undefined;
        }
        const items: SExpr[] = [];
        for (;;) {
          const la = peek();
          if (la.kind === 'rparen') {
            next();
            const list: ListNode = {
              kind: 'list',
              items,
              span: { start: t.span.start, end: la.span.end, line: t.span.line, col: t.span.col, ...(t.span.file !== undefined ? { file: t.span.file } : {}) },
              id: '',
            };
            return list;
          }
          if (la.kind === 'eof') {
            // Closing at end of input is a choice: the missing ")" may belong earlier.
            diagnostics.push(
              makeDiag('E003', 'error', 'Unclosed "("', {
                span: t.span,
                received: 'end of input',
                expected: 'a closing parenthesis',
                fixes: fixesOf(makeFix('Add ")" at end of input', 'review', [editAt(la.span, ')')])),
              }),
            );
            const list: ListNode = {
              kind: 'list',
              items,
              span: { start: t.span.start, end: la.span.end, line: t.span.line, col: t.span.col, ...(t.span.file !== undefined ? { file: t.span.file } : {}) },
              id: '',
            };
            return list;
          }
          const item = parseExpr(depth + 1);
          if (item !== undefined) items.push(item);
        }
      }
      default: {
        const exhaustive: never = t.kind;
        throw new Error(`unhandled token kind: ${String(exhaustive)}`);
      }
    }
  };

  const nodes: SExpr[] = [];
  while (peek().kind !== 'eof') {
    const e = parseExpr();
    if (e !== undefined) nodes.push(e);
  }

  assignIds(nodes);
  return { nodes, diagnostics };
}
