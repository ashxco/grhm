import { CODE_DOCS } from './diagnostics.js';
import {
  API_METHODS,
  BROWSER_GLOBALS,
  COLUMN_TYPES,
  EXPR_OPS,
  MOTION_PROPS,
  OpSchema,
  PropType,
  RESPONSIVE_SUFFIXES,
  SERVER_OPS,
  STYLE_PROPS,
  TEST_STEPS,
  allOps,
} from './schema.js';

/**
 * Model-facing language reference (PRD FR-15). Generated from the live schema
 * registry so it can never drift from what the compiler accepts. Designed for
 * in-context consumption by models with no GRHM training data: compact,
 * complete, and example-grounded.
 */

function propText(name: string, type: PropType): string {
  switch (type.kind) {
    case 'enum':
      return `:${name} ${type.values?.join('|') ?? ''}`;
    case 'number':
      return `:${name} n`;
    case 'string':
      return `:${name} "s"`;
    case 'boolean':
      return `:${name} bool`;
    case 'size':
      return `:${name} size`;
    case 'color':
      return `:${name} color|$token`;
    case 'expr':
      return `:${name} expr`;
    case 'ref':
      return `:${name} state-ref`;
    case 'route':
      return `:${name} route`;
    default: {
      const exhaustive: never = type.kind;
      throw new Error(`unhandled prop kind: ${String(exhaustive)}`);
    }
  }
}

function opLine(op: OpSchema, full: boolean): string {
  const alias = op.aliases.length > 0 ? ` (alias ${op.aliases.join(' ')})` : '';
  const positional = op.positional
    .map((p) => (p.variadic === true ? `${p.name}...` : p.required ? p.name : `[${p.name}]`))
    .join(' ');
  const props = Object.entries(op.props)
    .map(([name, type]) => propText(name, type))
    .join(' ');
  const parts = [op.name + alias];
  if (positional !== '') parts.push(positional);
  if (props !== '') parts.push(props);
  if (op.styled) parts.push('+style');
  return `(${parts.join(' ')})${full ? ` — ${op.doc}` : ''}`;
}

const EXAMPLE = `(app shop
  (theme (token primary "#4f46e5"))
  (data (resource products "/api/products.json" :default (arr)))
  (state cart-count 0)
  (use "./lib/util.ts" (import slugify))

  (page "/" home
    (vstack :pad 24 :gap 16 :enter fade-up
      (heading 1 "Shop")
      (btn "View cart (" cart-count ")" :variant primary
        (click (nav "/cart")))
      (if products.loading
        (txt "Loading...")
        (grid :cols 3 :cols-sm 1 :gap 16
          (each p products.data :key p.id
            (product-card :name p.name :price p.price
              :on-view (nav (path "/p/{id}" :id p.id))))))))

  (page "/p/{id}" detail
    (vstack :pad 24
      (heading 2 "Product " id)
      (btn "Add to cart" (click (set cart-count (+ cart-count 1))))))

  (page "/cart" cart
    (vstack :pad 24 (heading 2 "Cart: " cart-count " items")))

  (component product-card
    (props (name string) (price number) (on-view action))
    (card :gap 8
      (txt name :weight semibold)
      (money price)
      (btn "View" (click on-view)))))

(tests
  (test "home renders" (visit "/") (expect-text "Shop")))
`;

export function generateReference(options: { full?: boolean } = {}): string {
  const sections: string[] = [];

  sections.push(`# GRHM language reference (generated; schema 1)

GRHM is an S-expression language for web UI apps, compiled to React/TS/CSS.
One (app name ...) per program, plus optional (tests ...). Comments: ; to end of line.
Atoms: "strings", numbers, true/false/null, identifiers (kebab-case), :keywords.
Keyword props follow the op: (vstack :pad 24 :gap 8 child...). Dotted access: user.name.
Token refs: $primary reads (token primary ...). Route params {id} bind as strings.`);
  if (!options.full) sections.push('Compact signatures below cover every operation. Run grhm reference --full for detailed operation descriptions; grhm codes <CODE> explains one diagnostic with worked repairs.');

  const byCategory = new Map<string, OpSchema[]>();
  for (const op of allOps()) {
    const bucket = byCategory.get(op.category) ?? [];
    bucket.push(op);
    byCategory.set(op.category, bucket);
  }
  for (const [category, ops] of byCategory) {
    sections.push(`## ${category} ops\n` + ops.map((op) => opLine(op, options.full === true)).join('\n'));
  }

  sections.push(
    `## style props (styled ops only; -sm/-md suffixes apply at ${RESPONSIVE_SUFFIXES.map((s) => s).join('/')} breakpoints)\n` +
      Object.entries(STYLE_PROPS)
        .map(([name, type]) => propText(name, type))
        .join('  '),
  );

  sections.push(
    '## motion props (styled ops)\n' +
      Object.entries(MOTION_PROPS)
        .map(([name, type]) => propText(name, type))
        .join('  '),
  );

  sections.push(
    '## expression ops\n' +
      Object.entries(EXPR_OPS)
        .map(([name, spec]) => {
          if (spec.doc !== undefined && spec.doc.startsWith('(')) return spec.doc;
          const args = ' x'.repeat(spec.minArity) + (spec.maxArity === undefined ? ' ...' : '');
          return `(${name}${args})${spec.doc !== undefined ? ' ' + spec.doc : ''}`;
        })
        .join('  ') +
      '\n(call target.path arg...) — interop invocation; browser globals: ' +
      [...BROWSER_GLOBALS].join(' '),
  );

  sections.push(`## functions
(fn name (a b) body-expr) — top-level pure function; recursion and mutual recursion allowed.
Body sees params, other fns, imports, browser globals — never state or resources.
Call: (name arg...). Pass as value: (map name xs).
(lambda (x) expr) — anonymous function, usable wherever a function is expected.
(let ((x e1) (y e2)) body) — sequential local bindings, an expression.
(if cond then else) — in expression position, a value-producing conditional.
Conditions (if/when/cond tests, and/or/not operands) must be boolean: test other values with (not-null x), (!= n 0), (> (count xs) 0).
Example: (fn total (xs) (reduce (lambda (acc x) (+ acc (* x.price x.qty))) 0 xs))`);

  sections.push(`## server (db + api)
(db (table name (col type [:default v])...)) — column types: ${[...COLUMN_TYPES].join(' ')}; auto is the integer primary key. Compiles to SQLite behind a generated node:http server (src/gen/server.ts; grhm dev runs it).
(api (get "/api/x" handler) ...) — methods: ${[...API_METHODS].join(' ')}. A handler is one expression over route params (bound by name, as strings), body (JSON request body), fns, and imports — never state.
Server-only handler ops: ${Object.entries(SERVER_OPS)
    .map(([, spec]) => spec.doc)
    .join('  ')}
The whole stdlib works in handlers: (get "/api/top" (take 5 (sort-by (lambda (r) r.score) (select rows)))).
Pages read via (resource name "/api/x" ...) and mutate via actions:
(send post|put|delete "/route-or-(path ...)" :prop expr...) — JSON mutation; must match a declared api route.
(refresh resource-name) — re-fetch a resource after a mutation.`);

  sections.push(`## actions
(set state-name expr) | (nav "/route") | (nav (path "/p/{id}" :id expr)) | (call ...) | (send ...) | (refresh name) | action-prop-name
Events wrap actions: (click a...), (change a...), (submit a...).`);

  sections.push(
    '## test steps\n' +
      Object.entries(TEST_STEPS)
        .map(([name, spec]) => `(${name} ${spec.args.join(' ')})`)
        .join(' '),
  );

  sections.push(`## patch protocol
(patch :revision "r" :target node-id
  (set prop value) (delete prop) (append form) (insert-before form)
  (insert-after form) (replace form) (move :before|:after|:into node-id))
Node IDs are stable across formatting; read them from grhm check --json / inspect.`);

  sections.push(
    '## diagnostic codes\n' +
      Object.entries(CODE_DOCS)
        .map(([code, doc]) => `${code} ${doc}`)
        .join('\n'),
  );

  sections.push('## complete example\n```\n' + EXAMPLE + '```');

  const text = sections.join('\n\n') + '\n';
  return text;
}

/** Rough token estimate (chars/4) for prompt budgeting. */
export function referenceTokenEstimate(text: string): number {
  return Math.ceil(text.length / 4);
}
