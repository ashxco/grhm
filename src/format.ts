import { SExpr, opName } from './ast.js';
import { lookupOp } from './schema.js';

/**
 * Canonical formatter. Deterministic and idempotent: format(parse(format(x)))
 * always equals format(parse(x)). The formatted text defines the canonical
 * source representation used for revision hashing.
 */

const MAX_INLINE = 72;

/**
 * Dual projections (PRD FR-12): the same program rendered with descriptive
 * operation names (for humans) or compact aliases (for token efficiency).
 * 'preserve' keeps whatever the author wrote and is the canonical default.
 */
export type NameStyle = 'preserve' | 'descriptive' | 'compact';

/** Deep copy with operation idents renamed according to the projection. */
export function projectNames(nodes: SExpr[], style: NameStyle): SExpr[] {
  if (style === 'preserve') return nodes;
  const go = (e: SExpr, isOpPosition: boolean): SExpr => {
    if (e.kind === 'ident' && isOpPosition) {
      const schema = lookupOp(e.name);
      if (schema !== undefined) {
        const renamed = style === 'descriptive' ? schema.name : schema.aliases[0] ?? schema.name;
        return { ...e, name: renamed };
      }
      return e;
    }
    if (e.kind === 'list') {
      return { ...e, items: e.items.map((item, i) => go(item, i === 0)) };
    }
    return e;
  };
  return nodes.map((n) => go(n, false));
}

function escapeString(value: string): string {
  let out = '"';
  for (const ch of value) {
    switch (ch) {
      case '"':
        out += '\\"';
        break;
      case '\\':
        out += '\\\\';
        break;
      case '\n':
        out += '\\n';
        break;
      case '\t':
        out += '\\t';
        break;
      case '\r':
        out += '\\r';
        break;
      default:
        out += ch;
    }
  }
  return out + '"';
}

function renderInline(e: SExpr): string {
  switch (e.kind) {
    case 'string':
      return escapeString(e.value);
    case 'number':
      return Object.is(e.value, -0) ? '-0' : String(e.value);
    case 'boolean':
      return e.value ? 'true' : 'false';
    case 'null':
      return 'null';
    case 'ident':
      return e.name;
    case 'keyword':
      return ':' + e.name;
    case 'list':
      return '(' + e.items.map(renderInline).join(' ') + ')';
    default: {
      const exhaustive: never = e;
      throw new Error(`unhandled node kind: ${String(exhaustive)}`);
    }
  }
}

/** True when a list has grandchildren lists, i.e. real block structure. */
function hasBlockStructure(e: SExpr): boolean {
  if (e.kind !== 'list') return false;
  return e.items.some((item) => item.kind === 'list' && item.items.some((inner) => inner.kind === 'list'));
}

function render(e: SExpr, indent: number): string {
  if (e.kind !== 'list') return renderInline(e);

  const inline = renderInline(e);
  if (indent + inline.length <= MAX_INLINE && !hasBlockStructure(e)) {
    return inline;
  }

  // Opless lists (e.g. let binding lists) fuse their first element onto the
  // opening paren instead of leaving a bare "(" line.
  if (e.items[0]?.kind === 'list') {
    const pad1 = ' '.repeat(indent + 1);
    const parts = e.items.map((item) => render(item, indent + 1));
    return '(' + parts.map((p, idx) => (idx === 0 ? p : pad1 + p)).join('\n') + ')';
  }

  const pad = ' '.repeat(indent + 2);
  const headParts: string[] = [];
  const bodyLines: string[] = [];
  let inHead = true;
  let i = 0;
  // Function forms keep their (flat) parameter list on the head line.
  const op = opName(e);
  let headListAllowance = op === 'fn' || op === 'defn' || op === 'lambda' ? 1 : 0;

  while (i < e.items.length) {
    const item = e.items[i];
    if (item === undefined) break;

    if (inHead) {
      if (item.kind === 'keyword') {
        const value = e.items[i + 1];
        if (value !== undefined && value.kind !== 'keyword' && value.kind !== 'list') {
          headParts.push(':' + item.name + ' ' + renderInline(value));
          i += 2;
          continue;
        }
        inHead = false;
      } else if (item.kind !== 'list') {
        headParts.push(renderInline(item));
        i += 1;
        continue;
      } else if (headListAllowance > 0 && item.items.every((inner) => inner.kind !== 'list')) {
        headListAllowance -= 1;
        headParts.push(renderInline(item));
        i += 1;
        inHead = false;
        continue;
      } else {
        inHead = false;
      }
    }

    if (item.kind === 'keyword') {
      const value = e.items[i + 1];
      if (value !== undefined && value.kind !== 'keyword') {
        bodyLines.push(pad + ':' + item.name + ' ' + render(value, indent + 2));
        i += 2;
        continue;
      }
      bodyLines.push(pad + ':' + item.name);
      i += 1;
      continue;
    }

    bodyLines.push(pad + render(item, indent + 2));
    i += 1;
  }

  const head = '(' + headParts.join(' ');
  if (bodyLines.length === 0) return head + ')';
  // Blank lines between the top-level sections of an app improve scanning.
  const joiner = opName(e) === 'app' ? '\n\n' : '\n';
  return head + '\n' + bodyLines.join(joiner) + ')';
}

export function format(nodes: SExpr[], names: NameStyle = 'preserve'): string {
  return projectNames(nodes, names)
    .map((n) => render(n, 0))
    .join('\n\n') + '\n';
}
