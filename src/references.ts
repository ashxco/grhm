import { ListNode, SExpr, Span, isList, opName, splitList } from './ast.js';
import { EXPR_OPS, SERVER_OPS, lookupOp } from './schema.js';
import { validBindingName } from './util.js';

/**
 * Symbol resolution for find-references and rename (PRD FR-13). The index is
 * built from syntax roles rather than raw identifier spelling: table names,
 * columns, enum members, node IDs, and similarly named value symbols therefore
 * remain in separate namespaces.
 */

export type SymbolKind = 'state' | 'resource' | 'component' | 'token' | 'import' | 'local' | 'each' | 'prop' | 'fn' | 'fnparam';

export interface SymbolInfo {
  name: string;
  kind: SymbolKind;
  /** Span of the declaring name atom. */
  declSpan: Span;
  /** Subtree the binding is visible in; 'global' for app-level names. */
  scope: ListNode | 'global';
  /**
   * Imports are not renameable: `(import name)` doubles as the JS export
   * name, so renaming would silently change which export is imported.
   * Component props are not renameable either (call sites use keywords).
   */
  renameable: boolean;
}

interface IndexedSymbol {
  info: SymbolInfo;
  spans: Span[];
}

interface SymbolIndex {
  symbols: IndexedSymbol[];
  globals: Map<string, IndexedSymbol>;
  tokens: Map<string, IndexedSymbol>;
  components: Map<string, IndexedSymbol>;
  tables: Map<string, Set<string>>;
}

type Env = Map<string, IndexedSymbol>;

/** The identifier head (before any dot) at an offset, or undefined. */
export function symbolAt(roots: SExpr[], offset: number): string | undefined {
  let hit: string | undefined;
  const visit = (e: SExpr): void => {
    if (e.span.start > offset || e.span.end < offset) return;
    if (isList(e)) {
      for (const item of e.items) visit(item);
    } else if (e.kind === 'ident') {
      hit = e.name.split('.')[0] ?? e.name;
    }
  };
  for (const root of roots) visit(root);
  return hit;
}

/** Sub-span covering only the head segment of an identifier. */
function headSpan(span: Span, headLength: number, offset = 0): Span {
  return { ...span, start: span.start + offset, end: span.start + offset + headLength, col: span.col + offset };
}

function sameSpan(a: Span, b: Span): boolean {
  return a.start === b.start && a.end === b.end && a.file === b.file;
}

function addOccurrence(symbol: IndexedSymbol, span: Span): void {
  if (!symbol.spans.some((existing) => sameSpan(existing, span))) symbol.spans.push(span);
}

function declaredName(node: ListNode): { name: string; span: Span } | undefined {
  const atom = node.items[1];
  return atom !== undefined && atom.kind === 'ident' ? { name: atom.name, span: atom.span } : undefined;
}

function makeSymbol(
  index: SymbolIndex,
  name: string,
  kind: SymbolKind,
  declSpan: Span,
  scope: ListNode | 'global',
  renameable: boolean,
): IndexedSymbol {
  const symbol: IndexedSymbol = { info: { name, kind, declSpan, scope, renameable }, spans: [declSpan] };
  index.symbols.push(symbol);
  return symbol;
}

/** Collect global declarations and table columns before resolving uses. */
function collectGlobals(roots: SExpr[]): SymbolIndex {
  const index: SymbolIndex = {
    symbols: [],
    globals: new Map(),
    tokens: new Map(),
    components: new Map(),
    tables: new Map(),
  };

  const visit = (e: SExpr, inDark = false, inDb = false): void => {
    if (!isList(e)) return;
    const op = opName(e);
    const decl = declaredName(e);
    if (decl !== undefined) {
      if (op === 'token') {
        const existing = index.tokens.get(decl.name);
        if (existing !== undefined) addOccurrence(existing, decl.span);
        else {
          const symbol = makeSymbol(index, decl.name, 'token', decl.span, 'global', true);
          index.tokens.set(decl.name, symbol);
        }
      } else if (op === 'state' || op === 'resource' || op === 'component' || op === 'fn' || op === 'defn') {
        const kind: SymbolKind = op === 'component' ? 'component' : op === 'fn' || op === 'defn' ? 'fn' : op;
        if (!index.globals.has(decl.name)) {
          const symbol = makeSymbol(index, decl.name, kind, decl.span, 'global', true);
          index.globals.set(decl.name, symbol);
          if (kind === 'component') index.components.set(decl.name, symbol);
        }
      } else if (op === 'import' || op === 'import-default') {
        if (!index.globals.has(decl.name)) {
          const symbol = makeSymbol(index, decl.name, 'import', decl.span, 'global', false);
          index.globals.set(decl.name, symbol);
        }
      } else if (op === 'table' && inDb) {
        const columns = new Set<string>();
        for (const column of splitList(e).rest.slice(1)) {
          if (!isList(column)) continue;
          const columnName = column.items[0];
          if (columnName?.kind === 'ident') columns.add(columnName.name);
        }
        index.tables.set(decl.name, columns);
      }
    }
    for (const item of e.items) visit(item, inDark || op === 'dark', inDb || op === 'db');
  };
  for (const root of roots) visit(root);
  return index;
}

function paramAtoms(list: SExpr | undefined): { name: string; span: Span }[] {
  if (list === undefined || !isList(list)) return [];
  const out: { name: string; span: Span }[] = [];
  for (const param of list.items) {
    if (param.kind === 'ident') out.push({ name: param.name, span: param.span });
    else if (isList(param)) {
      const name = param.items[0];
      if (name?.kind === 'ident') out.push({ name: name.name, span: name.span });
    }
  }
  return out;
}

function addAtomReference(e: SExpr, env: Env, index: SymbolIndex, ignored?: Set<string>): void {
  if (e.kind !== 'ident') return;
  const head = e.name.split('.')[0] ?? e.name;
  if (head.startsWith('$')) {
    const name = head.slice(1);
    const token = index.tokens.get(name);
    if (token !== undefined) addOccurrence(token, headSpan(e.span, name.length, 1));
    return;
  }
  if (ignored?.has(head) === true) return;
  const symbol = env.get(head);
  if (symbol !== undefined) addOccurrence(symbol, headSpan(e.span, head.length));
}

function visitProps(node: ListNode, env: Env, index: SymbolIndex, ignored?: Set<string>): void {
  for (const [, entry] of splitList(node).props) visitValue(entry.value, env, index, ignored);
}

function visitValues(values: SExpr[], env: Env, index: SymbolIndex, ignored?: Set<string>): void {
  for (const value of values) visitValue(value, env, index, ignored);
}

function visitValue(e: SExpr, env: Env, index: SymbolIndex, ignored?: Set<string>): void {
  if (isList(e)) visitList(e, env, index, ignored);
  else addAtomReference(e, env, index, ignored);
}

function visitPage(node: ListNode, env: Env, index: SymbolIndex): void {
  const rest = splitList(node).rest;
  const children = rest.slice(2);
  const inner = new Map(env);
  const route = rest[0];
  if (route?.kind === 'string') {
    for (const match of route.value.matchAll(/\{([^}]+)\}/g)) {
      const name = match[1];
      if (name !== undefined) inner.delete(name);
    }
  }
  const localSymbols = new Map<ListNode, IndexedSymbol>();
  for (const child of children) {
    if (!isList(child) || opName(child) !== 'local') continue;
    const decl = declaredName(child);
    if (decl === undefined) continue;
    localSymbols.set(child, makeSymbol(index, decl.name, 'local', decl.span, node, true));
  }
  // Local initializers are sequential: each sees globals/route bindings and
  // only earlier locals. The rendered body sees the complete local scope.
  const initEnv = new Map(inner);
  for (const child of children) {
    if (isList(child) && opName(child) === 'local') {
      const init = splitList(child).rest[1];
      const symbol = localSymbols.get(child);
      if (symbol !== undefined && initEnv.get(symbol.info.name)?.info.scope === 'global') {
        initEnv.delete(symbol.info.name);
      }
      if (init !== undefined) visitValue(init, initEnv, index);
      if (symbol !== undefined) initEnv.set(symbol.info.name, symbol);
    }
  }
  const bodyEnv = new Map(initEnv);
  visitProps(node, bodyEnv, index);
  for (const child of children) {
    if (!isList(child) || opName(child) !== 'local') visitValue(child, bodyEnv, index);
  }
}

function visitComponent(node: ListNode, env: Env, index: SymbolIndex): void {
  const children = splitList(node).rest.slice(1);
  const inner = new Map(env);
  const propsNode = children.find((child): child is ListNode => isList(child) && opName(child) === 'props');
  if (propsNode !== undefined) {
    for (const spec of propsNode.items.slice(1)) {
      if (!isList(spec)) continue;
      const atom = spec.items[0];
      if (atom?.kind !== 'ident') continue;
      inner.set(atom.name, makeSymbol(index, atom.name, 'prop', atom.span, node, false));
    }
  }
  const localSymbols = new Map<ListNode, IndexedSymbol>();
  for (const child of children) {
    if (!isList(child) || opName(child) !== 'local') continue;
    const decl = declaredName(child);
    if (decl !== undefined) localSymbols.set(child, makeSymbol(index, decl.name, 'local', decl.span, node, true));
  }

  const initEnv = new Map(inner);
  for (const child of children) {
    if (child === propsNode) continue;
    if (isList(child) && opName(child) === 'local') {
      const init = splitList(child).rest[1];
      const symbol = localSymbols.get(child);
      if (symbol !== undefined && initEnv.get(symbol.info.name)?.info.scope === 'global') {
        initEnv.delete(symbol.info.name);
      }
      if (init !== undefined) visitValue(init, initEnv, index);
      if (symbol !== undefined) initEnv.set(symbol.info.name, symbol);
    }
  }
  const bodyEnv = new Map(initEnv);
  for (const child of children) {
    if (child !== propsNode && (!isList(child) || opName(child) !== 'local')) visitValue(child, bodyEnv, index);
  }
}

function visitFn(node: ListNode, env: Env, index: SymbolIndex): void {
  const params = node.items[2];
  const inner = new Map(env);
  for (const param of paramAtoms(params)) {
    inner.set(param.name, makeSymbol(index, param.name, 'fnparam', param.span, node, true));
  }
  for (const body of node.items.slice(3)) visitValue(body, inner, index);
}

function visitLambda(node: ListNode, env: Env, index: SymbolIndex): void {
  const inner = new Map(env);
  for (const param of paramAtoms(node.items[1])) {
    inner.set(param.name, makeSymbol(index, param.name, 'fnparam', param.span, node, true));
  }
  for (const body of node.items.slice(2)) visitValue(body, inner, index);
}

function visitLet(node: ListNode, env: Env, index: SymbolIndex): void {
  const inner = new Map(env);
  const bindings = node.items[1];
  if (bindings !== undefined && isList(bindings)) {
    for (const pair of bindings.items) {
      if (!isList(pair)) continue;
      const name = pair.items[0];
      const init = pair.items[1];
      if (init !== undefined) visitValue(init, inner, index);
      if (name?.kind === 'ident') {
        inner.set(name.name, makeSymbol(index, name.name, 'fnparam', name.span, node, true));
      }
    }
  }
  for (const body of node.items.slice(2)) visitValue(body, inner, index);
}

function visitEach(node: ListNode, env: Env, index: SymbolIndex): void {
  const parts = splitList(node);
  const variable = parts.rest[0];
  const items = parts.rest[1];
  if (items !== undefined) visitValue(items, env, index);
  const inner = new Map(env);
  inner.delete('index');
  if (variable?.kind === 'ident') {
    inner.set(variable.name, makeSymbol(index, variable.name, 'each', variable.span, node, true));
  }
  // :key is evaluated for each row and therefore sees the loop binding.
  visitProps(node, inner, index);
  visitValues(parts.rest.slice(2), inner, index);
}

function visitUiTable(node: ListNode, env: Env, index: SymbolIndex): void {
  const parts = splitList(node);
  const variable = parts.rest[0];
  const items = parts.rest[1];
  if (items !== undefined) visitValue(items, env, index);
  const inner = new Map(env);
  inner.delete('index');
  if (variable?.kind === 'ident') {
    inner.set(variable.name, makeSymbol(index, variable.name, 'each', variable.span, node, true));
  }
  visitProps(node, env, index);
  for (const column of parts.rest.slice(2)) {
    if (!isList(column) || opName(column) !== 'col') {
      visitValue(column, inner, index);
      continue;
    }
    const columnParts = splitList(column);
    const header = columnParts.rest[0];
    if (header !== undefined) visitValue(header, env, index);
    visitValues(columnParts.rest.slice(1), inner, index);
    visitProps(column, env, index);
  }
}

function visitApi(node: ListNode, env: Env, index: SymbolIndex): void {
  const handlerBase: Env = new Map(
    [...env].filter(([, symbol]) => symbol.info.kind === 'fn' || symbol.info.kind === 'import'),
  );
  for (const route of splitList(node).rest) {
    if (!isList(route)) continue;
    const rest = splitList(route).rest;
    const inner = new Map(handlerBase);
    inner.delete('body');
    inner.delete('user');
    inner.delete('env');
    const pattern = rest[0];
    if (pattern?.kind === 'string') {
      for (const match of pattern.value.matchAll(/\{([^}]+)\}/g)) {
        const name = match[1];
        if (name !== undefined) inner.delete(name);
      }
    }
    for (const child of rest.slice(1)) {
      if (isList(child) && opName(child) === 'input') continue;
      visitValue(child, inner, index);
    }
  }
}

function visitDb(node: ListNode, env: Env, index: SymbolIndex): void {
  for (const declaration of splitList(node).rest) {
    if (!isList(declaration)) continue;
    if (opName(declaration) === 'seed') {
      for (const row of splitList(declaration).rest.slice(1)) {
        if (isList(row)) visitProps(row, env, index);
      }
    }
  }
}

function visitServerOp(node: ListNode, env: Env, index: SymbolIndex): void {
  const parts = splitList(node);
  const table = parts.rest[0];
  const columns = table?.kind === 'ident' ? index.tables.get(table.name) : undefined;
  if (opName(node) === 'select') {
    for (const [name, entry] of parts.props) {
      // :order is a column name, while the remaining query props are expressions
      // and only :where gives bare column identifiers a special namespace.
      if (name === 'where') visitValue(entry.value, env, index, columns);
      else if (name !== 'order') visitValue(entry.value, env, index);
    }
    return;
  }
  for (const [, entry] of parts.props) visitValue(entry.value, env, index);
  visitValues(parts.rest.slice(1), env, index);
}

function visitTests(node: ListNode, env: Env, index: SymbolIndex): void {
  for (const test of splitList(node).rest) {
    if (!isList(test) || opName(test) !== 'test') continue;
    for (const step of splitList(test).rest.slice(1)) {
      if (!isList(step) || opName(step) !== 'expect-eq') continue;
      visitValues(splitList(step).rest, env, index);
    }
  }
}

function visitList(node: ListNode, env: Env, index: SymbolIndex, ignored?: Set<string>): void {
  const op = opName(node);
  const parts = splitList(node);
  if (op === undefined) {
    visitValues(node.items, env, index, ignored);
    return;
  }

  switch (op) {
    case 'app':
      visitValues(parts.rest.slice(1), env, index);
      return;
    case 'page':
      visitPage(node, env, index);
      return;
    case 'component':
      visitComponent(node, env, index);
      return;
    case 'fn':
    case 'defn':
      visitFn(node, env, index);
      return;
    case 'lambda':
      visitLambda(node, env, index);
      return;
    case 'let':
      visitLet(node, env, index);
      return;
    case 't':
      // Message keys occupy the i18n namespace; only interpolation properties
      // are ordinary value expressions.
      visitProps(node, env, index, ignored);
      return;
    case 'each':
      visitEach(node, env, index);
      return;
    case 'api':
      visitApi(node, env, index);
      return;
    case 'db':
      visitDb(node, env, index);
      return;
    case 'tests':
      visitTests(node, env, index);
      return;
    case 'theme':
    case 'dark':
    case 'data':
    case 'i18n':
      visitValues(parts.rest, env, index);
      return;
    case 'token':
    case 'state':
    case 'resource': {
      visitValues(parts.rest.slice(op === 'resource' ? 2 : 1), env, index);
      visitProps(node, env, index);
      return;
    }
    case 'use':
    case 'import':
    case 'import-default':
    case 'props':
    case 'seed':
    case 'row':
    case 'input':
    case 'auth':
    case 'enum':
    case 'locale':
    case 'msg':
    case 'uploads':
      return;
    case 'env':
      visitValues(parts.rest.slice(1), env, index);
      visitProps(node, env, index);
      return;
    case 'job': {
      const inner = new Map(env);
      inner.delete('env');
      visitValues(parts.rest.slice(1), inner, index);
      visitProps(node, inner, index);
      return;
    }
    case 'local':
      // Page/component handlers establish local scope before visiting bodies.
      visitValues(parts.rest.slice(1), env, index);
      return;
    case 'set': {
      const target = parts.rest[0];
      if (target !== undefined) addAtomReference(target, env, index);
      visitValues(parts.rest.slice(1), env, index);
      return;
    }
    case 'refresh': {
      const target = parts.rest[0];
      if (target !== undefined) addAtomReference(target, env, index);
      return;
    }
    case 'call': {
      const target = parts.rest[0];
      if (target !== undefined) addAtomReference(target, env, index);
      visitValues(parts.rest.slice(1), env, index);
      return;
    }
    case 'match': {
      const value = parts.rest[0];
      if (value !== undefined) visitValue(value, env, index);
      for (const arm of parts.rest.slice(1)) {
        if (isList(arm)) visitValues(arm.items.slice(1), env, index);
      }
      return;
    }
    case 'cond':
      for (const arm of parts.rest) {
        if (isList(arm)) visitValues(arm.items, env, index);
      }
      return;
    default:
      break;
  }

  if (SERVER_OPS[op] !== undefined && parts.rest[0]?.kind === 'ident' && index.tables.has(parts.rest[0].name)) {
    visitServerOp(node, env, index);
    return;
  }
  if (op === 'table' && parts.rest[0]?.kind === 'ident') {
    visitUiTable(node, env, index);
    return;
  }

  const component = index.components.get(op);
  if (component !== undefined) addOccurrence(component, headSpan(node.items[0]!.span, op.length));
  else if (EXPR_OPS[op] === undefined && SERVER_OPS[op] === undefined && lookupOp(op) === undefined) {
    const callable = env.get(op);
    if (callable?.info.kind === 'fn' || callable?.info.kind === 'import') {
      addOccurrence(callable, headSpan(node.items[0]!.span, op.length));
    }
  }
  visitValues(parts.rest, env, index, ignored);
  visitProps(node, env, index, ignored);
}

function buildIndex(roots: SExpr[]): SymbolIndex {
  const index = collectGlobals(roots);
  const env: Env = new Map(index.globals);
  for (const root of roots) visitValue(root, env, index);
  return index;
}

function spanContains(span: Span, offset: number, file?: string): boolean {
  if (file !== undefined && span.file !== file) return false;
  return span.start <= offset && offset <= span.end;
}

/** Resolve the exact binding occurrence under a cursor, respecting lexical scope. */
export function resolveSymbolAt(roots: SExpr[], offset: number, file?: string): SymbolInfo | undefined {
  const index = buildIndex(roots);
  for (const symbol of index.symbols) {
    if (symbol.spans.some((span) => spanContains(span, offset, file))) return symbol.info;
    // Token edit spans intentionally exclude '$'; still resolve when the cursor
    // is placed on the sigil itself.
    if (symbol.info.kind === 'token' && symbol.spans.some((span) => spanContains(span, offset + 1, file))) return symbol.info;
  }
  return undefined;
}

/** Locate a declaration by name. Prefer resolveSymbolAt for editor actions. */
export function resolveSymbol(roots: SExpr[], name: string): SymbolInfo | undefined {
  const index = buildIndex(roots);
  if (name.startsWith('$')) return index.tokens.get(name.slice(1))?.info;
  return index.globals.get(name)?.info ?? index.symbols.find((symbol) => symbol.info.name === name && symbol.info.kind !== 'token')?.info;
}

/** All occurrence spans of one resolved symbol, including its declaration. */
export function findReferences(roots: SExpr[], info: SymbolInfo): Span[] {
  const index = buildIndex(roots);
  const symbol = index.symbols.find(
    (candidate) =>
      candidate.info.kind === info.kind &&
      candidate.info.name === info.name &&
      sameSpan(candidate.info.declSpan, info.declSpan),
  );
  return symbol?.spans ?? [];
}

/** Validate a proposed new name for rename. */
export function validNewName(name: string): boolean {
  return validBindingName(name);
}
