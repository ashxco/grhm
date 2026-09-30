import { SExpr, splitList } from './ast.js';

/**
 * Stable node identity (PRD FR-9).
 *
 * IDs are deterministic hashes of a node's semantic path: parent key, its
 * operation name, and either a declared name (pages, components, state,
 * resources, each-vars) or its occurrence index among same-operation
 * siblings. Formatting and edits to unrelated regions therefore do not
 * change IDs. An explicit `:id "literal"` property always wins, which is the
 * recommended practice for patch-heavy agent workflows.
 */

function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function shortHash(input: string): string {
  return fnv1a(input).toString(36).padStart(7, '0').slice(0, 7);
}

/** Ops whose first positional identifier is a declaration name. */
const NAMED_OPS = new Set(['app', 'page', 'component', 'state', 'local', 'resource', 'token', 'each', 'test', 'fn', 'defn', 'table']);

/**
 * Semantic key base for a node among its siblings. Declarations key by their
 * declared name; content nodes with a literal string (buttons, headings,
 * text) key by that string, so inserting an unrelated sibling does not shift
 * the identity of existing nodes. Anything else keys by operation name and
 * is disambiguated by occurrence index.
 */
function keyBase(node: SExpr): string {
  if (node.kind !== 'list') return '?';
  const parts = splitList(node);
  const op = parts.op?.name ?? '?';
  if (NAMED_OPS.has(op)) {
    const first = parts.rest.find((e) => e.kind === 'ident' || e.kind === 'string');
    if (first !== undefined) {
      const name = first.kind === 'ident' ? first.name : first.value;
      return `${op}~${name}`;
    }
    return op;
  }
  const firstString = parts.rest.find((e) => e.kind === 'string');
  if (firstString !== undefined && firstString.kind === 'string') {
    return `${op}~s${shortHash(firstString.value)}`;
  }
  return op;
}

export function assignIds(roots: SExpr[]): void {
  const used = new Set<string>();

  const unique = (base: string): string => {
    let id = base;
    let n = 1;
    while (used.has(id)) {
      n += 1;
      id = `${base}${n}`;
    }
    used.add(id);
    return id;
  };

  const assign = (node: SExpr, parentKey: string, base: string, occurrence: number): void => {
    if (node.kind !== 'list') return;
    const parts = splitList(node);
    const key = `${parentKey}/${base}#${occurrence}`;

    // Only literal string `:id` values are node IDs. An `:id p.id` inside an
    // `each` template is a data expression (e.g. a React key), not identity.
    const explicit = parts.props.get('id')?.value;
    if (explicit !== undefined && explicit.kind === 'string') {
      node.id = unique(explicit.value);
    } else {
      node.id = unique(shortHash(key));
    }

    const counts = new Map<string, number>();
    for (const item of node.items) {
      if (item.kind === 'list') {
        const childBase = keyBase(item);
        const idx = counts.get(childBase) ?? 0;
        counts.set(childBase, idx + 1);
        assign(item, key, childBase, idx);
      }
    }
  };

  const counts = new Map<string, number>();
  for (const root of roots) {
    if (root.kind === 'list') {
      const base = keyBase(root);
      const idx = counts.get(base) ?? 0;
      counts.set(base, idx + 1);
      assign(root, '', base, idx);
    }
  }
}
