/**
 * Canonical AST for GRHM.
 *
 * The surface syntax is S-expressions. Every list node carries a stable
 * semantic ID (assigned by `assignIds`) and a source span, which together
 * make structural inspection and patching possible.
 */

export interface Span {
  /** 0-based byte offset of the first character. */
  start: number;
  /** 0-based byte offset one past the last character. */
  end: number;
  /** 1-based line of the first character. */
  line: number;
  /** 1-based column of the first character. */
  col: number;
  /** Source file (relative to project root); absent in single-source compiles. */
  file?: string;
}

export interface StringAtom {
  kind: 'string';
  value: string;
  span: Span;
}

export interface NumberAtom {
  kind: 'number';
  value: number;
  span: Span;
}

export interface BooleanAtom {
  kind: 'boolean';
  value: boolean;
  span: Span;
}

export interface NullAtom {
  kind: 'null';
  span: Span;
}

export interface IdentAtom {
  kind: 'ident';
  /** Full identifier, possibly dotted (`products.data`). */
  name: string;
  span: Span;
}

export interface KeywordAtom {
  kind: 'keyword';
  /** Name without the leading colon. */
  name: string;
  span: Span;
}

export interface ListNode {
  kind: 'list';
  items: SExpr[];
  span: Span;
  /** Stable semantic ID. Empty until `assignIds` runs. */
  id: string;
}

export type Atom = StringAtom | NumberAtom | BooleanAtom | NullAtom | IdentAtom | KeywordAtom;
export type SExpr = Atom | ListNode;

export function isList(e: SExpr): e is ListNode {
  return e.kind === 'list';
}

export function isIdent(e: SExpr, name?: string): e is IdentAtom {
  return e.kind === 'ident' && (name === undefined || e.name === name);
}

export function isKeyword(e: SExpr): e is KeywordAtom {
  return e.kind === 'keyword';
}

/** Operation name of a list form, if its head is an identifier. */
export function opName(list: ListNode): string | undefined {
  const head = list.items[0];
  return head !== undefined && head.kind === 'ident' ? head.name : undefined;
}

export interface PropEntry {
  keyword: KeywordAtom;
  value: SExpr;
}

export interface ListParts {
  op: IdentAtom | undefined;
  /** Keyword properties in source order; last occurrence wins on lookup. */
  props: Map<string, PropEntry>;
  /** Positional arguments and children, in source order. */
  rest: SExpr[];
  /** A trailing keyword with no value, if present (a source error). */
  danglingKeyword: KeywordAtom | undefined;
}

/**
 * Split a list into operation, keyword properties, and positional items.
 * Keyword atoms pair with the immediately following expression.
 */
export function splitList(list: ListNode): ListParts {
  const head = list.items[0];
  const op = head !== undefined && head.kind === 'ident' ? head : undefined;
  const props = new Map<string, PropEntry>();
  const rest: SExpr[] = [];
  let danglingKeyword: KeywordAtom | undefined;
  let i = op !== undefined ? 1 : 0;
  while (i < list.items.length) {
    const item = list.items[i];
    if (item === undefined) break;
    if (item.kind === 'keyword') {
      const value = list.items[i + 1];
      if (value === undefined || value.kind === 'keyword') {
        danglingKeyword = item;
        i += 1;
        continue;
      }
      props.set(item.name, { keyword: item, value });
      i += 2;
    } else {
      rest.push(item);
      i += 1;
    }
  }
  return { op, props, rest, danglingKeyword };
}

/** Value of a keyword property, if present. */
export function getProp(list: ListNode, name: string): SExpr | undefined {
  return splitList(list).props.get(name)?.value;
}

/** Depth-first walk over all list nodes. */
export function walkLists(roots: SExpr[], visit: (node: ListNode, parent: ListNode | undefined) => void): void {
  const go = (e: SExpr, parent: ListNode | undefined): void => {
    if (e.kind !== 'list') return;
    visit(e, parent);
    for (const item of e.items) go(item, e);
  };
  for (const root of roots) go(root, undefined);
}

/** Find a list node by stable ID. */
export function findNode(roots: SExpr[], id: string): { node: ListNode; parent: ListNode | undefined } | undefined {
  let found: { node: ListNode; parent: ListNode | undefined } | undefined;
  walkLists(roots, (node, parent) => {
    if (found === undefined && node.id === id) found = { node, parent };
  });
  return found;
}

/** Structural equality ignoring spans and IDs (used for round-trip tests). */
export function equalStructure(a: SExpr, b: SExpr): boolean {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case 'string':
      return a.value === (b as StringAtom).value;
    case 'number':
      return a.value === (b as NumberAtom).value;
    case 'boolean':
      return a.value === (b as BooleanAtom).value;
    case 'null':
      return true;
    case 'ident':
      return a.name === (b as IdentAtom).name;
    case 'keyword':
      return a.name === (b as KeywordAtom).name;
    case 'list': {
      const bl = b as ListNode;
      if (a.items.length !== bl.items.length) return false;
      return a.items.every((item, i) => {
        const other = bl.items[i];
        return other !== undefined && equalStructure(item, other);
      });
    }
    default: {
      const exhaustive: never = a;
      throw new Error(`unhandled node kind: ${String(exhaustive)}`);
    }
  }
}
