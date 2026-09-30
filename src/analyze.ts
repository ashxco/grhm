import { ListNode, SExpr, isList, opName, splitList } from './ast.js';
import type { InputSpec } from './runtime/contracts.js';
import { Diagnostic, makeDiag } from './diagnostics.js';
import { API_METHODS, COLUMN_TYPES, EXPR_OPS, SERVER_OPS, lookupOp } from './schema.js';
import { camelCase, isSafeCssLiteral, pascalCase, routeSpecificity, validBindingName, validJsIdentifier } from './util.js';

/** Semantic model built from the canonical AST. */

export interface StateDecl {
  name: string;
  node: ListNode;
  init: SExpr;
}

export interface ResourceDecl {
  name: string;
  node: ListNode;
  url: string;
  defaultValue: SExpr | undefined;
  /** Re-fetch interval in seconds; undefined = fetch once. */
  poll: number | undefined;
  /** Re-fetch when the generated server broadcasts a db change (SSE). */
  live: boolean;
}

export type PropTypeName = 'string' | 'number' | 'boolean' | 'list' | 'record' | 'action' | 'any';

export interface PropDecl {
  name: string;
  type: PropTypeName;
  node: ListNode;
}

export interface PageModel {
  route: string;
  name: string;
  node: ListNode;
  params: string[];
  locals: StateDecl[];
  body: SExpr[];
  /** Document title expression (string or expr), from :title. */
  title: SExpr | undefined;
}

export interface ComponentModel {
  name: string;
  node: ListNode;
  props: PropDecl[];
  hasSlot: boolean;
  locals: StateDecl[];
  body: SExpr[];
}

export interface ImportDecl {
  /** GRHM-side name. */
  name: string;
  /** Module specifier: npm package or ./relative path. */
  module: string;
  /** JavaScript export name (ignored for default imports). */
  jsName: string;
  isDefault: boolean;
  node: ListNode;
}

export interface TestDecl {
  name: string;
  node: ListNode;
  steps: ListNode[];
}

export interface FnDecl {
  name: string;
  params: string[];
  /** Declared parameter types: number|string|boolean|list, a table name, or undefined (untyped). */
  paramTypes: (string | undefined)[];
  body: SExpr;
  node: ListNode;
}

export type ColumnType = 'auto' | 'string' | 'number' | 'boolean';

export interface ColumnDecl {
  name: string;
  type: ColumnType;
  defaultValue: SExpr | undefined;
  /** Nullable column: may be omitted on insert and read as null. */
  optional: boolean;
  /** Emit a CREATE INDEX for this column. */
  indexed: boolean;
  /** Foreign key: REFERENCES "<table>"("id") in the DDL. */
  references: string | undefined;
  node: ListNode;
}

export interface TableDecl {
  name: string;
  columns: ColumnDecl[];
  node: ListNode;
}

export interface SeedRow {
  props: Map<string, SExpr>;
  node: ListNode;
}

export interface SeedDecl {
  table: string;
  rows: SeedRow[];
  node: ListNode;
}

export type ApiMethod = 'get' | 'post' | 'put' | 'delete';

export type InputFieldType = 'string' | 'number' | 'boolean';

/** One declared request-body field: (input (name type [:optional true]) ...). */
export interface InputField extends InputSpec {
  name: string;
  type: InputFieldType;
  optional: boolean;
  node: ListNode;
}

export interface ApiRouteDecl {
  method: ApiMethod;
  route: string;
  params: string[];
  /** Handler expression; undefined for auth builtins handled by the server core. */
  handler: SExpr | undefined;
  /** Declared request-body contract; undefined = body is unchecked. */
  input: InputField[] | undefined;
  /** Route requires an authenticated session; handler sees `user`. */
  auth: boolean;
  /** Auth builtin implemented by the server core rather than a handler. */
  builtin: 'signup' | 'login' | 'logout' | 'logout-all' | 'me' | undefined;
  node: ListNode;
}

export interface EnumDecl {
  name: string;
  values: string[];
  node: ListNode;
}

export interface EnvDecl {
  name: string;
  defaultValue: string | undefined;
  node: ListNode;
}

export interface AuthDecl {
  usersTable: string;
  provider?: string;
  node: ListNode;
}

/** Recurring server task: (job name :every seconds body-expr). */
export interface JobDecl {
  name: string;
  everySeconds: number;
  body: SExpr;
  node: ListNode;
}

/** (uploads [:max-kb n]): enables POST /api/uploads + /uploads/* serving. */
export interface UploadsDecl {
  maxKb: number;
  public: boolean | undefined;
  quotaMb: number;
  userQuotaMb: number;
  node: ListNode;
}

export interface AppModel {
  name: string;
  node: ListNode;
  tokens: Map<string, { value: string; node: ListNode }>;
  /** Token overrides applied under prefers-color-scheme: dark. */
  darkTokens: Map<string, { value: string; node: ListNode }>;
  states: Map<string, StateDecl>;
  resources: Map<string, ResourceDecl>;
  pages: PageModel[];
  components: Map<string, ComponentModel>;
  imports: Map<string, ImportDecl>;
  functions: Map<string, FnDecl>;
  tables: Map<string, TableDecl>;
  seeds: SeedDecl[];
  apis: ApiRouteDecl[];
  enums: Map<string, EnumDecl>;
  envs: Map<string, EnvDecl>;
  auth: AuthDecl | undefined;
  jobs: JobDecl[];
  uploads: UploadsDecl | undefined;
  /** locale name -> message key -> template text. First locale is the default. */
  locales: Map<string, Map<string, string>>;
  defaultLocale: string | undefined;
  tests: TestDecl[];
}

export function routeParams(route: string): string[] {
  const params: string[] = [];
  for (const match of route.matchAll(/\{([^}]+)\}/g)) {
    const name = match[1];
    if (name !== undefined) params.push(name);
  }
  return params;
}

const PROP_TYPE_NAMES = new Set<PropTypeName>(['string', 'number', 'boolean', 'list', 'record', 'action', 'any']);

const INPUT_FIELD_TYPES = new Set(['string', 'number', 'boolean']);

function containsSlot(body: SExpr[]): boolean {
  for (const e of body) {
    if (isList(e)) {
      if (opName(e) === 'slot') return true;
      if (containsSlot(e.items)) return true;
    }
  }
  return false;
}

/** Validate one source binding and, when supplied, its generated JS namespace. */
function validateBindingName(
  kind: string,
  name: string,
  node: ListNode,
  out: Diagnostic[],
  generatedNames?: Map<string, string>,
): boolean {
  if (!validBindingName(name)) {
    out.push(
      makeDiag('E104', 'error', `Invalid ${kind} name "${name}"`, {
        span: node.span,
        nodeId: node.id,
        op: kind,
        received: name,
        expected: 'lowercase kebab-case name that is safe as a JavaScript binding',
      }),
    );
    return false;
  }
  if (generatedNames !== undefined) {
    const generated = camelCase(name);
    const previous = generatedNames.get(generated);
    if (previous !== undefined && previous !== name) {
      out.push(
        makeDiag('E107', 'error', `Declaration "${name}" collides with "${previous}" after JavaScript name generation`, {
          span: node.span,
          nodeId: node.id,
          op: kind,
          received: name,
          expected: `a name that does not generate "${generated}"`,
        }),
      );
      return false;
    }
    generatedNames.set(generated, name);
  }
  if (
    (kind === 'fn' || kind === 'component' || kind === 'import') &&
    (lookupOp(name) !== undefined || EXPR_OPS[name] !== undefined || SERVER_OPS[name] !== undefined || name === 'slot')
  ) {
    out.push(
      makeDiag('E107', 'error', `${kind} name "${name}" conflicts with a built-in operation`, {
        span: node.span,
        nodeId: node.id,
        op: kind,
        received: name,
        expected: 'a name that is not a built-in GRHM operation',
      }),
    );
    return false;
  }
  return true;
}

function routesOverlap(a: string, b: string): boolean {
  const left = a.split('/').filter(Boolean);
  const right = b.split('/').filter(Boolean);
  if (left.length !== right.length) return false;
  return left.every((segment, index) => {
    const other = right[index];
    return other !== undefined && (segment === other || /^\{[^}]+\}$/.test(segment) || /^\{[^}]+\}$/.test(other));
  });
}


function declarationPropsOk(
  parts: ReturnType<typeof splitList>,
  allowed: Iterable<string>,
  node: ListNode,
  op: string,
  out: Diagnostic[],
): boolean {
  const names = new Set(['id', ...allowed]);
  let ok = true;
  if (parts.danglingKeyword !== undefined) {
    out.push(makeDiag('E105', 'error', `":${parts.danglingKeyword.name}" is missing a value`, { span: parts.danglingKeyword.span, nodeId: node.id, op }));
    ok = false;
  }
  for (const [name, entry] of parts.props) {
    if (names.has(name)) continue;
    out.push(makeDiag('E102', 'error', `"${op}" has no property ":${name}"`, { span: entry.keyword.span, nodeId: node.id, op, field: name }));
    ok = false;
  }
  return ok;
}

function extractLocals(rest: SExpr[], out: Diagnostic[]): { locals: StateDecl[]; body: SExpr[] } {
  const locals: StateDecl[] = [];
  const body: SExpr[] = [];
  const generatedNames = new Map<string, string>();
  for (const e of rest) {
    if (isList(e) && opName(e) === 'local') {
      const parts = splitList(e);
      const nameAtom = parts.rest[0];
      const init = parts.rest[1];
      if (nameAtom === undefined || nameAtom.kind !== 'ident' || init === undefined) {
        out.push(
          makeDiag('E104', 'error', 'local requires a name and an initial value: (local name init)', {
            span: e.span,
            nodeId: e.id,
            op: 'local',
            expected: '(local name init)',
          }),
        );
        continue;
      }
      if (!validateBindingName('local', nameAtom.name, e, out, generatedNames)) continue;
      if (locals.some((local) => local.name === nameAtom.name)) {
        out.push(
          makeDiag('E107', 'error', `Duplicate local declaration "${nameAtom.name}"`, {
            span: e.span,
            nodeId: e.id,
            op: 'local',
            received: nameAtom.name,
          }),
        );
        continue;
      }
      locals.push({ name: nameAtom.name, node: e, init });
    } else {
      body.push(e);
    }
  }
  return { locals, body };
}

export function analyze(roots: SExpr[], out: Diagnostic[]): AppModel | undefined {
  const appNodes = roots.filter((r): r is ListNode => isList(r) && opName(r) === 'app');
  const testsNodes = roots.filter((r): r is ListNode => isList(r) && opName(r) === 'tests');
  for (const other of roots) {
    if (!isList(other) || (opName(other) !== 'app' && opName(other) !== 'tests')) {
      out.push(
        makeDiag('E110', 'error', 'Only (app ...) and (tests ...) forms are allowed at the top level', {
          span: other.span,
          nodeId: isList(other) ? other.id : undefined,
        }),
      );
    }
  }
  const appNode = appNodes[0];
  if (appNode === undefined) {
    out.push(makeDiag('E110', 'error', 'Program must contain an (app name ...) form'));
    return undefined;
  }
  if (appNodes.length > 1) {
    out.push(
      makeDiag('E110', 'error', 'Program must contain exactly one (app ...) form', {
        span: appNodes[1]?.span,
        nodeId: appNodes[1]?.id,
      }),
    );
  }

  const appParts = splitList(appNode);
  const nameAtom = appParts.rest[0];
  const appName = nameAtom !== undefined && nameAtom.kind === 'ident' ? nameAtom.name : 'app';
  if (nameAtom === undefined || nameAtom.kind !== 'ident') {
    out.push(
      makeDiag('E104', 'error', 'app requires a name: (app name ...)', {
        span: appNode.span,
        nodeId: appNode.id,
        op: 'app',
      }),
    );
  }

  const model: AppModel = {
    name: appName,
    node: appNode,
    tokens: new Map(),
    darkTokens: new Map(),
    states: new Map(),
    resources: new Map(),
    pages: [],
    components: new Map(),
    imports: new Map(),
    functions: new Map(),
    tables: new Map(),
    seeds: [],
    apis: [],
    enums: new Map(),
    envs: new Map(),
    auth: undefined,
    jobs: [],
    uploads: undefined,
    locales: new Map(),
    defaultLocale: undefined,
    tests: [],
  };

  const generatedDeclarations = new Map<string, string>();
  const generatedPages = new Map<string, string>();

  // Tables live in their own namespace: they are only referenced in table
  // position of server ops, so (table reviews) and (resource reviews ...)
  // can coexist — the natural way to name a table and the resource reading it.
  const declareName = (kind: string, name: string, node: ListNode): boolean => {
    if (kind !== 'table' && !validateBindingName(kind, name, node, out, generatedDeclarations)) return false;
    const taken =
      kind === 'table'
        ? model.tables.has(name)
        : model.states.has(name) ||
          model.resources.has(name) ||
          model.components.has(name) ||
          model.imports.has(name) ||
          model.functions.has(name) ||
          model.enums.has(name);
    if (taken) {
      out.push(
        makeDiag('E107', 'error', `Duplicate declaration "${name}"`, {
          span: node.span,
          nodeId: node.id,
          op: kind,
          received: name,
        }),
      );
      return false;
    }
    return true;
  };

  for (const child of appParts.rest.slice(1)) {
    if (!isList(child)) {
      out.push(makeDiag('E110', 'error', 'Unexpected value inside (app ...)', { span: child.span }));
      continue;
    }
    const op = opName(child);
    const parts = splitList(child);
    switch (op) {
      case 'theme': {
        const readToken = (t: SExpr, into: Map<string, { value: string; node: ListNode }>): void => {
          if (!isList(t) || opName(t) !== 'token') {
            out.push(
              makeDiag('E110', 'error', 'theme children must be (token name "value") or (dark (token ...)) forms', {
                span: t.span,
                nodeId: isList(t) ? t.id : undefined,
                op: 'theme',
              }),
            );
            return;
          }
          const tp = splitList(t);
          const tokenName = tp.rest[0];
          const tokenValue = tp.rest[1];
          if (tokenName?.kind !== 'ident' || tokenValue?.kind !== 'string') {
            out.push(
              makeDiag('E104', 'error', 'token requires a name and a string value', {
                span: t.span,
                nodeId: t.id,
                op: 'token',
                expected: '(token name "value")',
              }),
            );
            return;
          }
          if (!isSafeCssLiteral(tokenValue.value)) {
            out.push(
              makeDiag('E103', 'error', 'token value contains unsafe CSS syntax', {
                span: tokenValue.span,
                nodeId: t.id,
                op: 'token',
                field: tokenName.name,
                received: tokenValue.value,
                expected: 'a non-empty CSS value without ;, braces, comments, control characters, or url(...)',
              }),
            );
            return;
          }
          into.set(tokenName.name, { value: tokenValue.value, node: t });
        };
        for (const t of parts.rest) {
          if (isList(t) && opName(t) === 'dark') {
            for (const d of splitList(t).rest) readToken(d, model.darkTokens);
          } else {
            readToken(t, model.tokens);
          }
        }
        break;
      }
      case 'data': {
        for (const r of parts.rest) {
          if (!isList(r) || opName(r) !== 'resource') {
            out.push(
              makeDiag('E110', 'error', 'data children must be (resource name "url") forms', {
                span: r.span,
                nodeId: isList(r) ? r.id : undefined,
                op: 'data',
              }),
            );
            continue;
          }
          const rp = splitList(r);
          if (rp.danglingKeyword !== undefined) {
            out.push(makeDiag('E105', 'error', `":${rp.danglingKeyword.name}" is missing a value`, { span: rp.danglingKeyword.span, nodeId: r.id, op: 'resource' }));
            continue;
          }
          let resourcePropsOk = true;
          for (const [name, entry] of rp.props) {
            if (!new Set(['id', 'default', 'poll', 'live']).has(name)) {
              out.push(makeDiag('E102', 'error', `resource has no property ":${name}"`, { span: entry.keyword.span, nodeId: r.id, op: 'resource', field: name }));
              resourcePropsOk = false;
            }
          }
          const liveValue = rp.props.get('live')?.value;
          if (liveValue !== undefined && liveValue.kind !== 'boolean') {
            out.push(makeDiag('E103', 'error', ':live expects true or false', { span: liveValue.span, nodeId: r.id, op: 'resource', field: 'live' }));
            resourcePropsOk = false;
          }
          if (!resourcePropsOk) continue;
          const rName = rp.rest[0];
          const rUrl = rp.rest[1];
          if (rName?.kind !== 'ident' || rUrl?.kind !== 'string') {
            out.push(
              makeDiag('E104', 'error', 'resource requires a name and a string url', {
                span: r.span,
                nodeId: r.id,
                op: 'resource',
                expected: '(resource name "url")',
              }),
            );
            continue;
          }
          const pollValue = rp.props.get('poll')?.value;
          const poll = pollValue !== undefined && pollValue.kind === 'number' && pollValue.value > 0 ? pollValue.value : undefined;
          if (pollValue !== undefined && poll === undefined) {
            out.push(
              makeDiag('E103', 'error', ':poll expects a positive number of seconds', {
                span: pollValue.span,
                nodeId: r.id,
                op: 'resource',
                field: 'poll',
                expected: 'positive number (seconds)',
              }),
            );
          }
          if (declareName('resource', rName.name, r)) {
            model.resources.set(rName.name, {
              name: rName.name,
              node: r,
              url: rUrl.value,
              defaultValue: rp.props.get('default')?.value,
              poll,
              live: liveValue !== undefined && liveValue.kind === 'boolean' && liveValue.value,
            });
          }
        }
        break;
      }
      case 'state': {
        if (!declarationPropsOk(parts, [], child, 'state', out)) break;
        const sName = parts.rest[0];
        const sInit = parts.rest[1];
        if (sName?.kind !== 'ident' || sInit === undefined) {
          out.push(
            makeDiag('E104', 'error', 'state requires a name and an initial value: (state name init)', {
              span: child.span,
              nodeId: child.id,
              op: 'state',
              expected: '(state name init)',
            }),
          );
          break;
        }
        if (declareName('state', sName.name, child)) {
          model.states.set(sName.name, { name: sName.name, node: child, init: sInit });
        }
        break;
      }
      case 'page': {
        if (!declarationPropsOk(parts, ['title'], child, 'page', out)) break;
        const route = parts.rest[0];
        const pName = parts.rest[1];
        if (route?.kind !== 'string' || pName?.kind !== 'ident') {
          out.push(
            makeDiag('E104', 'error', 'page requires a route string and a name: (page "/route" name ...)', {
              span: child.span,
              nodeId: child.id,
              op: 'page',
              expected: '(page "/route" name body...)',
            }),
          );
          break;
        }
        if (model.pages.some((p) => p.route === route.value)) {
          out.push(
            makeDiag('E108', 'error', `Duplicate route "${route.value}"`, {
              span: child.span,
              nodeId: child.id,
              op: 'page',
              received: route.value,
            }),
          );
          break;
        }
        const ambiguousPage = model.pages.find(
          (p) => routesOverlap(p.route, route.value) && routeSpecificity(p.route) === routeSpecificity(route.value),
        );
        if (ambiguousPage !== undefined) {
          out.push(
            makeDiag('E108', 'error', `Route "${route.value}" is ambiguous with "${ambiguousPage.route}"`, {
              span: child.span,
              nodeId: child.id,
              op: 'page',
              received: route.value,
              expected: 'non-overlapping route patterns',
            }),
          );
          break;
        }
        if (!validateBindingName('page', pName.name, child, out, generatedPages)) break;
        if (model.pages.some((p) => p.name === pName.name)) {
          out.push(
            makeDiag('E107', 'error', `Duplicate page declaration "${pName.name}"`, {
              span: child.span,
              nodeId: child.id,
              op: 'page',
              received: pName.name,
            }),
          );
          break;
        }
        const { locals, body } = extractLocals(parts.rest.slice(2), out);
        model.pages.push({
          route: route.value,
          name: pName.name,
          node: child,
          params: routeParams(route.value),
          locals,
          body,
          title: parts.props.get('title')?.value,
        });
        break;
      }
      case 'component': {
        if (!declarationPropsOk(parts, [], child, 'component', out)) break;
        const cName = parts.rest[0];
        if (cName?.kind !== 'ident') {
          out.push(
            makeDiag('E104', 'error', 'component requires a name: (component name ...)', {
              span: child.span,
              nodeId: child.id,
              op: 'component',
              expected: '(component name (props ...) body...)',
            }),
          );
          break;
        }
        let rest = parts.rest.slice(1);
        const props: PropDecl[] = [];
        const first = rest[0];
        if (first !== undefined && isList(first) && opName(first) === 'props') {
          const pp = splitList(first);
          const generatedProps = new Map<string, string>();
          for (const decl of pp.rest) {
            if (!isList(decl)) {
              out.push(
                makeDiag('E104', 'error', 'prop declarations must be (name type) forms', {
                  span: decl.span,
                  op: 'props',
                }),
              );
              continue;
            }
            const dName = decl.items[0];
            const dType = decl.items[1];
            if (dName?.kind !== 'ident' || (dType !== undefined && dType.kind !== 'ident')) {
              out.push(
                makeDiag('E104', 'error', 'prop declarations must be (name type) forms', {
                  span: decl.span,
                  nodeId: decl.id,
                  op: 'props',
                  expected: '(name string|number|boolean|list|record|action|any)',
                }),
              );
              continue;
            }
            const typeName = dType === undefined ? 'any' : dType.name;
            if (!PROP_TYPE_NAMES.has(typeName as PropTypeName)) {
              out.push(
                makeDiag('E103', 'error', `Unknown prop type "${typeName}"`, {
                  span: decl.span,
                  nodeId: decl.id,
                  op: 'props',
                  field: dName.name,
                  received: typeName,
                  expected: 'string | number | boolean | list | record | action | any',
                }),
              );
              continue;
            }
            if (!validateBindingName('prop', dName.name, decl, out, generatedProps)) continue;
            if (props.some((prop) => prop.name === dName.name)) {
              out.push(
                makeDiag('E107', 'error', `Duplicate prop declaration "${dName.name}"`, {
                  span: decl.span,
                  nodeId: decl.id,
                  op: 'props',
                  received: dName.name,
                }),
              );
              continue;
            }
            props.push({ name: dName.name, type: typeName as PropTypeName, node: decl });
          }
          rest = rest.slice(1);
        }
        const { locals, body } = extractLocals(rest, out);
        if (declareName('component', cName.name, child)) {
          model.components.set(cName.name, {
            name: cName.name,
            node: child,
            props,
            hasSlot: containsSlot(body),
            locals,
            body,
          });
        }
        break;
      }
      case 'db': {
        for (const t of parts.rest) {
          if (isList(t) && opName(t) === 'seed') {
            const sp = splitList(t);
            const sTable = sp.rest[0];
            if (sTable?.kind !== 'ident') {
              out.push(
                makeDiag('E801', 'error', 'seed requires a table name: (seed table (row :col v ...) ...)', {
                  span: t.span,
                  nodeId: t.id,
                  op: 'seed',
                  expected: '(seed entries (row :author "Ada" :message "hi"))',
                }),
              );
              continue;
            }
            const rows: SeedRow[] = [];
            for (const r of sp.rest.slice(1)) {
              if (!isList(r) || opName(r) !== 'row') {
                out.push(
                  makeDiag('E801', 'error', 'seed children must be (row :col value ...) forms', {
                    span: r.span,
                    nodeId: isList(r) ? r.id : undefined,
                    op: 'seed',
                  }),
                );
                continue;
              }
              const rp = splitList(r);
              const props = new Map<string, SExpr>();
              for (const [name, entry] of rp.props) props.set(name, entry.value);
              rows.push({ props, node: r });
            }
            model.seeds.push({ table: sTable.name, rows, node: t });
            continue;
          }
          if (!isList(t) || opName(t) !== 'table') {
            out.push(
              makeDiag('E801', 'error', 'db children must be (table ...) or (seed ...) forms', {
                span: t.span,
                nodeId: isList(t) ? t.id : undefined,
                op: 'db',
              }),
            );
            continue;
          }
          const tp = splitList(t);
          const tName = tp.rest[0];
          if (tName?.kind !== 'ident') {
            out.push(
              makeDiag('E801', 'error', 'table requires a name: (table name (col type)...)', {
                span: t.span,
                nodeId: t.id,
                op: 'table',
                expected: '(table todos (id auto) (text string))',
              }),
            );
            continue;
          }
          const columns: ColumnDecl[] = [];
          let ok = true;
          for (const c of tp.rest.slice(1)) {
            if (!isList(c)) {
              out.push(makeDiag('E801', 'error', 'table columns must be (name type [:default v]) forms', { span: c.span, nodeId: t.id, op: 'table' }));
              ok = false;
              continue;
            }
            const cp = splitList(c);
            const cName = cp.op;
            const cType = cp.rest[0];
            if (cName === undefined || cType?.kind !== 'ident' || !COLUMN_TYPES.has(cType.name)) {
              out.push(
                makeDiag('E801', 'error', 'column requires a name and a type', {
                  span: c.span,
                  nodeId: c.id,
                  op: 'table',
                  expected: '(name auto|string|number|boolean [:default v])',
                  received: cType?.kind === 'ident' ? cType.name : undefined,
                }),
              );
              ok = false;
              continue;
            }
            let columnPropsOk = true;
            if (cp.danglingKeyword !== undefined) {
              out.push(makeDiag('E105', 'error', `":${cp.danglingKeyword.name}" is missing a value`, { span: cp.danglingKeyword.span, nodeId: c.id, op: 'table' }));
              columnPropsOk = false;
            }
            for (const [name, entry] of cp.props) {
              if (!new Set(['id', 'default', 'optional', 'indexed', 'references']).has(name)) {
                out.push(makeDiag('E801', 'error', `Column "${cName.name}" has no property ":${name}"`, { span: entry.keyword.span, nodeId: c.id, op: 'table', field: name }));
                columnPropsOk = false;
              }
            }
            const optProp = cp.props.get('optional')?.value;
            const idxProp = cp.props.get('indexed')?.value;
            const refProp = cp.props.get('references')?.value;
            const defaultProp = cp.props.get('default')?.value;
            if (optProp !== undefined && optProp.kind !== 'boolean') {
              out.push(makeDiag('E801', 'error', `":optional" on column "${cName.name}" expects true or false`, { span: optProp.span, nodeId: c.id, op: 'table', field: 'optional' }));
              columnPropsOk = false;
            }
            if (idxProp !== undefined && idxProp.kind !== 'boolean') {
              out.push(makeDiag('E801', 'error', `":indexed" on column "${cName.name}" expects true or false`, { span: idxProp.span, nodeId: c.id, op: 'table', field: 'indexed' }));
              columnPropsOk = false;
            }
            if (refProp !== undefined && refProp.kind !== 'ident') {
              out.push(makeDiag('E801', 'error', `":references" on column "${cName.name}" expects a table name`, { span: refProp.span, nodeId: c.id, op: 'table', field: 'references' }));
              columnPropsOk = false;
            }
            const expectedDefaultKind = cType.name === 'auto' ? undefined : cType.name;
            if (
              defaultProp !== undefined &&
              (expectedDefaultKind === undefined || defaultProp.kind !== expectedDefaultKind)
            ) {
              out.push(makeDiag('E801', 'error', `":default" on column "${cName.name}" must be a ${expectedDefaultKind ?? 'non-auto'} literal`, { span: defaultProp.span, nodeId: c.id, op: 'table', field: 'default', received: defaultProp.kind, expected: expectedDefaultKind }));
              columnPropsOk = false;
            }
            if (!columnPropsOk) {
              ok = false;
              continue;
            }
            if (columns.some((existing) => existing.name === cName.name)) {
              out.push(makeDiag('E801', 'error', `Duplicate column "${cName.name}" in table "${tName.name}"`, { span: c.span, nodeId: c.id, op: 'table', received: cName.name }));
              ok = false;
              continue;
            }
            columns.push({
              name: cName.name,
              type: cType.name as ColumnType,
              defaultValue: cp.props.get('default')?.value,
              optional: optProp !== undefined && optProp.kind === 'boolean' && optProp.value,
              indexed: idxProp !== undefined && idxProp.kind === 'boolean' && idxProp.value,
              references: refProp !== undefined && refProp.kind === 'ident' ? refProp.name : undefined,
              node: c,
            });
          }
          if (ok && declareName('table', tName.name, t)) {
            model.tables.set(tName.name, { name: tName.name, columns, node: t });
          }
        }
        break;
      }
      case 'api': {
        for (const r of parts.rest) {
          const method = isList(r) ? opName(r) : undefined;
          if (!isList(r) || method === undefined || !API_METHODS.has(method)) {
            out.push(
              makeDiag('E804', 'error', 'api children must be (get|post|put|delete "/route" handler) forms', {
                span: r.span,
                nodeId: isList(r) ? r.id : undefined,
                op: 'api',
                received: method,
              }),
            );
            continue;
          }
          const rp = splitList(r);
          let routePropsOk = true;
          if (rp.danglingKeyword !== undefined) {
            out.push(
              makeDiag('E105', 'error', `":${rp.danglingKeyword.name}" is missing a value`, {
                span: rp.danglingKeyword.span,
                nodeId: r.id,
                op: method,
                field: rp.danglingKeyword.name,
              }),
            );
            routePropsOk = false;
          }
          for (const [name, entry] of rp.props) {
            if (name !== 'auth' && name !== 'id') {
              out.push(
                makeDiag('E102', 'error', `API route "${method}" has no property ":${name}"`, {
                  span: entry.keyword.span,
                  nodeId: r.id,
                  op: method,
                  field: name,
                  expected: ':auth | :id',
                }),
              );
              routePropsOk = false;
            } else if (name === 'auth' && entry.value.kind !== 'boolean') {
              out.push(
                makeDiag('E103', 'error', '":auth" expects true or false', {
                  span: entry.value.span,
                  nodeId: r.id,
                  op: method,
                  field: 'auth',
                  received: entry.value.kind,
                  expected: 'true | false',
                }),
              );
              routePropsOk = false;
            } else if (name === 'id' && entry.value.kind !== 'string') {
              out.push(
                makeDiag('E103', 'error', '":id" expects a literal string', {
                  span: entry.value.span,
                  nodeId: r.id,
                  op: method,
                  field: 'id',
                  received: entry.value.kind,
                  expected: 'string',
                }),
              );
              routePropsOk = false;
            }
          }
          if (!routePropsOk) continue;
          const route = rp.rest[0];
          let inputForm: ListNode | undefined;
          let handler: SExpr | undefined;
          const tail = rp.rest.slice(1);
          if (tail.length === 1) {
            handler = tail[0];
          } else if (tail.length === 2 && tail[0] !== undefined && isList(tail[0]) && opName(tail[0]) === 'input') {
            inputForm = tail[0];
            handler = tail[1];
          }
          if (route?.kind !== 'string' || !route.value.startsWith('/api/') || handler === undefined) {
            out.push(
              makeDiag('E804', 'error', `${method} requires a "/route" string, an optional (input ...) contract, and one handler expression`, {
                span: r.span,
                nodeId: r.id,
                op: method,
                expected: `(${method} "/api/things" (input (name string)) (insert things :name body.name))`,
              }),
            );
            continue;
          }
          if (model.apis.some((a) => a.method === method && a.route === route.value)) {
            out.push(
              makeDiag('E804', 'error', `Duplicate api route ${method.toUpperCase()} ${route.value}`, {
                span: r.span,
                nodeId: r.id,
                op: method,
                received: route.value,
              }),
            );
            continue;
          }
          const ambiguousApi = model.apis.find(
            (a) =>
              a.method === method &&
              routesOverlap(a.route, route.value) &&
              routeSpecificity(a.route) === routeSpecificity(route.value),
          );
          if (ambiguousApi !== undefined) {
            out.push(
              makeDiag('E804', 'error', `Ambiguous api route ${method.toUpperCase()} ${route.value} overlaps ${ambiguousApi.route}`, {
                span: r.span,
                nodeId: r.id,
                op: method,
                received: route.value,
                expected: 'non-overlapping route patterns',
              }),
            );
            continue;
          }
          let input: InputField[] | undefined;
          if (inputForm !== undefined) {
            input = [];
            for (const f of splitList(inputForm).rest) {
              const fName = isList(f) ? f.items[0] : undefined;
              const fType = isList(f) ? f.items[1] : undefined;
              if (!isList(f) || fName?.kind !== 'ident' || fType?.kind !== 'ident' || !INPUT_FIELD_TYPES.has(fType.name)) {
                out.push(
                  makeDiag('E808', 'error', 'input fields must be (name string|number|boolean [:optional true]) forms', {
                    span: f.span,
                    nodeId: isList(f) ? f.id : undefined,
                    op: 'input',
                    expected: '(author string) (qty number :optional true)',
                  }),
                );
                continue;
              }
              const fp = splitList(f);
              let inputPropsOk = true;
              if (fp.danglingKeyword !== undefined) {
                out.push(makeDiag('E105', 'error', `":${fp.danglingKeyword.name}" is missing a value`, { span: fp.danglingKeyword.span, nodeId: f.id, op: 'input' }));
                inputPropsOk = false;
              }
              for (const [name, entry] of fp.props) {
                if (!['id', 'optional', 'min', 'max', 'min-len', 'max-len', 'integer', 'format'].includes(name)) {
                  out.push(makeDiag('E808', 'error', `input field "${fName.name}" has no property ":${name}"`, { span: entry.keyword.span, nodeId: f.id, op: 'input', field: name }));
                  inputPropsOk = false;
                }
              }
              const opt = fp.props.get('optional')?.value;
              if (opt !== undefined && opt.kind !== 'boolean') {
                out.push(makeDiag('E808', 'error', `":optional" on input field "${fName.name}" expects true or false`, { span: opt.span, nodeId: f.id, op: 'input', field: 'optional' }));
                inputPropsOk = false;
              }
              const constraints: Partial<InputSpec> = {};
              const invalid = (field: string, message: string): void => {
                inputPropsOk = false;
                out.push(makeDiag('E808', 'error', message, { span: f.span, nodeId: f.id, op: 'input', field, received: JSON.stringify(constraints), expected: message }));
              };
              if (input.some((field) => field.name === fName.name)) invalid(fName.name, 'Duplicate input field: ' + fName.name);
              for (const [key, property] of [['min', 'min'], ['max', 'max'], ['min-len', 'minLength'], ['max-len', 'maxLength']] as const) {
                const value = fp.props.get(key)?.value;
                if (value === undefined) continue;
                const length = key.endsWith('len');
                if (value.kind !== 'number' || !Number.isFinite(value.value) || fType.name !== (length ? 'string' : 'number') || (length && (!Number.isSafeInteger(value.value) || value.value < 0 || value.value > 1_000_000))) invalid(key, 'Invalid input constraint :' + key);
                else constraints[property] = value.value;
              }
              const integer = fp.props.get('integer')?.value;
              if (integer !== undefined) {
                if (integer.kind !== 'boolean' || fType.name !== 'number') invalid('integer', ':integer requires a boolean on a numeric field');
                else constraints.integer = integer.value;
              }
              const format = fp.props.get('format')?.value;
              if (format !== undefined) {
                if (format.kind !== 'ident' || !['email', 'uuid', 'url'].includes(format.name) || fType.name !== 'string') invalid('format', ':format requires email, uuid, or url on a string field');
                else constraints.format = format.name as InputSpec['format'];
              }
              if ((constraints.min ?? -Infinity) > (constraints.max ?? Infinity) || (constraints.minLength ?? 0) > (constraints.maxLength ?? 65_536)) invalid('min', 'Input minimum cannot exceed its maximum');
              if (!inputPropsOk) continue;
              input.push({
                ...constraints,
                name: fName.name,
                type: fType.name as InputFieldType,
                optional: opt !== undefined && opt.kind === 'boolean' && opt.value,
                node: f,
              });
            }
          }
          const authProp = rp.props.get('auth')?.value;
          model.apis.push({
            method: method as ApiMethod,
            route: route.value,
            params: routeParams(route.value),
            handler,
            input,
            auth: authProp !== undefined && authProp.kind === 'boolean' && authProp.value,
            builtin: undefined,
            node: r,
          });
        }
        break;
      }
      case 'fn':
      case 'defn': {
        if (!declarationPropsOk(parts, [], child, 'fn', out)) break;
        const fnName = parts.rest[0];
        const paramList = parts.rest[1];
        const body = parts.rest[2];
        if (fnName?.kind !== 'ident' || paramList === undefined || !isList(paramList) || body === undefined || parts.rest.length !== 3) {
          out.push(
            makeDiag('E104', 'error', 'fn requires a name, a parameter list, and one body expression: (fn name (a b) expr)', {
              span: child.span,
              nodeId: child.id,
              op: 'fn',
              expected: '(fn total (xs) (reduce (lambda (acc x) (+ acc x)) 0 xs))',
            }),
          );
          break;
        }
        const params: string[] = [];
        const paramTypes: (string | undefined)[] = [];
        const generatedParams = new Map<string, string>();
        let paramsOk = true;
        for (const p of paramList.items) {
          // A parameter is `name` (untyped) or `(name type)` where type is a
          // base type (number|string|boolean|list) or a (db ...) table name.
          let pName: string | undefined;
          let pType: string | undefined;
          if (p.kind === 'ident') {
            pName = p.name;
          } else if (isList(p) && p.items.length === 2 && p.items[0]?.kind === 'ident' && p.items[1]?.kind === 'ident') {
            pName = p.items[0].name;
            pType = p.items[1].name;
          }
          if (pName === undefined || params.includes(pName)) {
            out.push(
              makeDiag('E104', 'error', 'fn parameters must be unique identifiers or (name type) pairs', {
                span: p.span,
                nodeId: child.id,
                op: 'fn',
                received: p.kind,
                expected: '(fn add ((a number) (b number)) (+ a b))',
              }),
            );
            paramsOk = false;
            break;
          }
          if (!validateBindingName('fn parameter', pName, isList(p) ? p : child, out, generatedParams)) {
            paramsOk = false;
            break;
          }
          params.push(pName);
          paramTypes.push(pType);
        }
        if (paramsOk && declareName('fn', fnName.name, child)) {
          model.functions.set(fnName.name, { name: fnName.name, params, paramTypes, body, node: child });
        }
        break;
      }
      case 'use': {
        if (!declarationPropsOk(parts, [], child, 'use', out)) break;
        const moduleAtom = parts.rest[0];
        if (moduleAtom?.kind !== 'string') {
          out.push(
            makeDiag('E601', 'error', 'use requires a module string: (use "pkg" (import name) ...)', {
              span: child.span,
              nodeId: child.id,
              op: 'use',
              expected: '(use "package-or-./path" (import name [jsName]) (import-default name))',
            }),
          );
          break;
        }
        for (const imp of parts.rest.slice(1)) {
          if (!isList(imp) || (opName(imp) !== 'import' && opName(imp) !== 'import-default')) {
            out.push(
              makeDiag('E601', 'error', 'use children must be (import name [jsName]) or (import-default name)', {
                span: imp.span,
                nodeId: isList(imp) ? imp.id : undefined,
                op: 'use',
              }),
            );
            continue;
          }
          const ip = splitList(imp);
          const nameAtom = ip.rest[0];
          if (nameAtom?.kind !== 'ident') {
            out.push(
              makeDiag('E601', 'error', 'import requires a name', {
                span: imp.span,
                nodeId: imp.id,
                op: opName(imp),
              }),
            );
            continue;
          }
          const isDefault = opName(imp) === 'import-default';
          const jsAtom = ip.rest[1];
          if (!isDefault && jsAtom !== undefined && (jsAtom.kind !== 'ident' || !validJsIdentifier(jsAtom.name))) {
            out.push(
              makeDiag('E601', 'error', 'Imported JavaScript export names must be valid JavaScript identifiers', {
                span: jsAtom.span,
                nodeId: imp.id,
                op: 'import',
                received: jsAtom.kind === 'ident' ? jsAtom.name : jsAtom.kind,
                expected: '(import local-name validJsExportName)',
              }),
            );
            continue;
          }
          const jsName = jsAtom !== undefined && jsAtom.kind === 'ident' ? jsAtom.name : camelCase(nameAtom.name);
          if (declareName('import', nameAtom.name, imp)) {
            model.imports.set(nameAtom.name, {
              name: nameAtom.name,
              module: moduleAtom.value,
              jsName,
              isDefault,
              node: imp,
            });
          }
        }
        break;
      }
      case 'enum': {
        if (!declarationPropsOk(parts, [], child, 'enum', out)) break;
        const eName = parts.rest[0];
        const values: string[] = [];
        let enumOk = eName?.kind === 'ident' && parts.rest.length >= 3;
        for (const v of parts.rest.slice(1)) {
          if (v.kind !== 'ident' || values.includes(v.name)) {
            enumOk = false;
            break;
          }
          values.push(v.name);
        }
        if (!enumOk || eName?.kind !== 'ident') {
          out.push(
            makeDiag('E104', 'error', 'enum requires a name and two or more unique member identifiers', {
              span: child.span,
              nodeId: child.id,
              op: 'enum',
              expected: '(enum status open closed archived)',
            }),
          );
          break;
        }
        if (declareName('enum', eName.name, child)) {
          model.enums.set(eName.name, { name: eName.name, values, node: child });
        }
        break;
      }
      case 'env': {
        if (!declarationPropsOk(parts, ['default'], child, 'env', out)) break;
        const eName = parts.rest[0];
        if (eName?.kind !== 'ident' || parts.rest.length !== 1) {
          out.push(
            makeDiag('E104', 'error', 'env requires a name: (env name [:default "value"])', {
              span: child.span,
              nodeId: child.id,
              op: 'env',
              expected: '(env stripe-key :default "")',
            }),
          );
          break;
        }
        const def = parts.props.get('default')?.value;
        if (def !== undefined && def.kind !== 'string') {
          out.push(makeDiag('E103', 'error', `":default" on env "${eName.name}" expects a string`, { span: def.span, nodeId: child.id, op: 'env', field: 'default' }));
          break;
        }
        if (model.envs.has(eName.name)) {
          out.push(makeDiag('E107', 'error', `Duplicate env declaration "${eName.name}"`, { span: child.span, nodeId: child.id, op: 'env', received: eName.name }));
          break;
        }
        model.envs.set(eName.name, {
          name: eName.name,
          defaultValue: def !== undefined && def.kind === 'string' ? def.value : undefined,
          node: child,
        });
        break;
      }
      case 'auth': {
        if (!declarationPropsOk(parts, ['provider'], child, 'auth', out)) break;
        const tableAtom = parts.rest[0];
        if (tableAtom?.kind !== 'ident' || parts.rest.length !== 1) {
          out.push(
            makeDiag('E813', 'error', 'auth requires a users table name: (auth users)', {
              span: child.span,
              nodeId: child.id,
              op: 'auth',
              expected: '(auth users)',
            }),
          );
          break;
        }
        if (model.auth !== undefined) {
          out.push(
            makeDiag('E813', 'error', 'Only one (auth ...) declaration is allowed', { span: child.span, nodeId: child.id, op: 'auth' }),
          );
          break;
        }
        const provider = parts.props.get('provider')?.value;
        if (provider !== undefined && (provider.kind !== 'string' || !/^\.\/[A-Za-z0-9_./-]+\.(ts|js|mjs)$/.test(provider.value) || provider.value.split('/').includes('..'))) {
          out.push(makeDiag('E813', 'error', ':provider must name a project-relative JavaScript or TypeScript identity adapter', { span: child.span, nodeId: child.id, op: 'auth', field: 'provider' }));
          break;
        }
        model.auth = { usersTable: tableAtom.name, provider: provider?.kind === 'string' ? provider.value : undefined, node: child };
        break;
      }
      case 'job': {
        if (!declarationPropsOk(parts, ['every'], child, 'job', out)) break;
        const jName = parts.rest[0];
        const jBody = parts.rest[1];
        const everyValue = parts.props.get('every')?.value;
        const every = everyValue !== undefined && everyValue.kind === 'number' && Number.isFinite(everyValue.value) && everyValue.value >= 0.001 && everyValue.value <= Number.MAX_SAFE_INTEGER / 1000 ? everyValue.value : undefined;
        if (jName?.kind !== 'ident' || jBody === undefined || parts.rest.length !== 2 || every === undefined) {
          out.push(
            makeDiag('E817', 'error', 'job requires a name, finite :every seconds (at least 0.001, at most MAX_SAFE_INTEGER / 1000), and one body expression', {
              span: child.span,
              nodeId: child.id,
              op: 'job',
              expected: '(job prune :every 3600 (delete-row sessions :id 1))',
            }),
          );
          break;
        }
        if (model.jobs.some((j) => j.name === jName.name)) {
          out.push(
            makeDiag('E817', 'error', `Duplicate job "${jName.name}"`, { span: child.span, nodeId: child.id, op: 'job', received: jName.name }),
          );
          break;
        }
        model.jobs.push({ name: jName.name, everySeconds: every, body: jBody, node: child });
        break;
      }
      case 'uploads': {
        if (!declarationPropsOk(parts, ['max-kb', 'public', 'quota-mb', 'user-quota-mb'], child, 'uploads', out) || parts.rest.length !== 0) {
          if (parts.rest.length !== 0) {
            out.push(makeDiag('E818', 'error', 'uploads accepts properties only: (uploads :max-kb 5120)', { span: child.span, nodeId: child.id, op: 'uploads' }));
          }
          break;
        }
        if (model.uploads !== undefined) {
          out.push(
            makeDiag('E818', 'error', 'Only one (uploads ...) declaration is allowed', { span: child.span, nodeId: child.id, op: 'uploads' }),
          );
          break;
        }
        const maxValue = parts.props.get('max-kb')?.value;
        const maxKb = maxValue !== undefined && maxValue.kind === 'number' && maxValue.value > 0 ? maxValue.value : 5120;
        if (maxValue !== undefined && (maxValue.kind !== 'number' || !Number.isFinite(maxValue.value) || maxValue.value < 1 || maxValue.value > 102400)) {
          out.push(
            makeDiag('E818', 'error', ':max-kb expects 1–102400 kilobytes', {
              span: maxValue.span,
              nodeId: child.id,
              op: 'uploads',
              field: 'max-kb',
            }),
          );
          break;
        }
        const publicValue = parts.props.get('public')?.value;
        const quota = parts.props.get('quota-mb')?.value;
        const userQuota = parts.props.get('user-quota-mb')?.value;
        const invalid = [quota, userQuota].some((value) => value !== undefined && (value.kind !== 'number' || !Number.isFinite(value.value) || value.value < 1 || value.value > 1_000_000));
        if (invalid || (publicValue !== undefined && publicValue.kind !== 'boolean')) {
          out.push(makeDiag('E818', 'error', 'uploads expects boolean :public and finite quotas from 1 to 1000000 MiB', {
            span: child.span, nodeId: child.id, expected: '(uploads :public true :quota-mb 1024 :user-quota-mb 100)',
          }));
          break;
        }
        model.uploads = { maxKb, public: publicValue?.kind === 'boolean' ? publicValue.value : undefined,
          quotaMb: quota?.kind === 'number' ? quota.value : 1024, userQuotaMb: userQuota?.kind === 'number' ? userQuota.value : 100, node: child };
        break;
      }
      case 'i18n': {
        for (const loc of parts.rest) {
          if (!isList(loc) || opName(loc) !== 'locale') {
            out.push(
              makeDiag('E110', 'error', 'i18n children must be (locale name (msg key "text") ...) forms', {
                span: loc.span,
                nodeId: isList(loc) ? loc.id : undefined,
                op: 'i18n',
              }),
            );
            continue;
          }
          const lp = splitList(loc);
          const locName = lp.rest[0];
          if (locName?.kind !== 'ident') {
            out.push(
              makeDiag('E104', 'error', 'locale requires a name: (locale en (msg key "text") ...)', {
                span: loc.span,
                nodeId: loc.id,
                op: 'locale',
              }),
            );
            continue;
          }
          const messages = new Map<string, string>();
          for (const m of lp.rest.slice(1)) {
            const mp = isList(m) ? splitList(m) : undefined;
            const key = mp?.rest[0];
            const text = mp?.rest[1];
            if (!isList(m) || opName(m) !== 'msg' || key?.kind !== 'ident' || text?.kind !== 'string') {
              out.push(
                makeDiag('E104', 'error', 'locale children must be (msg key "text") forms', {
                  span: m.span,
                  nodeId: isList(m) ? m.id : undefined,
                  op: 'locale',
                  expected: '(msg greeting "Hello, {name}!")',
                }),
              );
              continue;
            }
            messages.set(key.name, text.value);
          }
          if (model.defaultLocale === undefined) model.defaultLocale = locName.name;
          model.locales.set(locName.name, messages);
        }
        break;
      }
      case 'include':
        out.push(
          makeDiag('E603', 'error', 'Unresolved (include ...): includes are resolved by the project loader; check the path', {
            span: child.span,
            nodeId: child.id,
            op: 'include',
          }),
        );
        break;
      default:
        out.push(
          makeDiag('E110', 'error', `"${op ?? '?'}" is not allowed directly inside (app ...)`, {
            span: child.span,
            nodeId: child.id,
            op,
            expected: 'theme | data | state | page | component | fn | enum | env | db | api | auth | job | uploads | i18n | use | include',
          }),
        );
    }
  }

  for (const route of model.apis) {
    const reserved = ['/healthz', '/readyz', '/api/_events'].includes(route.route) || route.route.startsWith('/__grhm/') ||
      (model.uploads !== undefined && route.route === '/api/uploads') ||
      (model.auth !== undefined && ['/api/auth/me', '/api/auth/signup', '/api/auth/login', '/api/auth/logout', '/api/auth/logout-all'].includes(route.route));
    if (reserved) out.push(makeDiag('E804', 'error', 'API route is reserved by the runtime: ' + route.route, {
      span: route.node.span, nodeId: route.node.id, op: route.method, received: route.route, expected: 'an application-owned API route',
    }));
  }

  // Account for every identifier synthesized around state/local declarations,
  // not only camelCase(source). These names coexist with generated imports,
  // store exports, and hook setters in page modules.
  const reservedGenerated = new Set([
    'createStore',
    'useStore',
    'useState',
    'useResource',
    'useEffect',
    'usePath',
    'refreshResource',
    'handleActionError',
    'configureRuntime',
    'reportRuntimeError',
    'navigate',
    'showToast',
    'fmtMoney',
    'tMsg',
    'matchRoute',
    'safeDecode',
    'range',
    'sortBy',
    'sum',
    'zip',
    'chunk',
    'groupBy',
    'dissoc',
    'mergeRecords',
    'send',
    'uploadFile',
  ]);
  for (const [name, decl] of [...model.functions, ...model.imports, ...model.resources]) {
    const generated = camelCase(name);
    if (reservedGenerated.has(generated)) {
      out.push(
        makeDiag('E107', 'error', `Declaration "${name}" generates reserved JavaScript identifier "${generated}"`, {
          span: decl.node.span,
          nodeId: decl.node.id,
          op: model.functions.has(name) ? 'fn' : model.resources.has(name) ? 'resource' : 'import',
          received: name,
          expected: `a name that does not generate reserved "${generated}"`,
        }),
      );
    }
  }
  const reservedComponents = new Set(['App', 'Suspense', 'Toasts', 'DialogShell', 'ErrorBoundary', 'ReactElement', 'ReactNode']);
  for (const [, component] of model.components) {
    const generated = pascalCase(component.name);
    if (reservedComponents.has(generated)) {
      out.push(
        makeDiag('E107', 'error', `Component "${component.name}" generates reserved JavaScript identifier "${generated}"`, {
          span: component.node.span,
          nodeId: component.node.id,
          op: 'component',
          received: component.name,
        }),
      );
    }
  }
  const stateGenerated = new Map<string, string>();
  for (const [, state] of model.states) {
    const names = [camelCase(state.name), `set${pascalCase(state.name)}`, `${camelCase(state.name)}Store`];
    for (const generated of names) {
      const previous = stateGenerated.get(generated);
      if (reservedGenerated.has(generated) || (previous !== undefined && previous !== state.name)) {
        out.push(
          makeDiag('E107', 'error', `State "${state.name}" generates conflicting JavaScript identifier "${generated}"`, {
            span: state.node.span,
            nodeId: state.node.id,
            op: 'state',
            received: state.name,
            expected: previous !== undefined ? `a name that does not collide with "${previous}"` : `a name that does not generate reserved "${generated}"`,
          }),
        );
      } else {
        stateGenerated.set(generated, state.name);
      }
    }
  }

  // Locals compile to lexical `const` bindings. Exact source-name shadowing is
  // intentional, but two distinct GRHM names must not collapse to the same JS
  // identifier when a local and a global are both in scope.
  for (const owner of [...model.pages, ...model.components.values()]) {
    const visibleGenerated = new Map(stateGenerated);
    for (const name of reservedGenerated) visibleGenerated.set(name, '<runtime>');
    for (const local of owner.locals) {
      const generated = camelCase(local.name);
      const global = generatedDeclarations.get(generated);
      if (global !== undefined && global !== local.name) {
        out.push(
          makeDiag('E107', 'error', `Local "${local.name}" collides with global declaration "${global}" after JavaScript name generation`, {
            span: local.node.span,
            nodeId: local.node.id,
            op: 'local',
            received: local.name,
            expected: `a name that does not generate "${generated}"`,
          }),
        );
      }
      for (const localGenerated of [generated, `set${pascalCase(local.name)}`]) {
        const conflict = visibleGenerated.get(localGenerated);
        if (conflict !== undefined && conflict !== local.name) {
          out.push(
            makeDiag('E107', 'error', `Local "${local.name}" generates conflicting JavaScript identifier "${localGenerated}"`, {
              span: local.node.span,
              nodeId: local.node.id,
              op: 'local',
              received: local.name,
              expected: `a name that does not collide with "${conflict}"`,
            }),
          );
        } else {
          visibleGenerated.set(localGenerated, local.name);
        }
      }
    }
  }

  if (model.auth !== undefined) {
    const authNode = model.auth.node;
    const users = model.tables.get(model.auth.usersTable);
    if (users === undefined) {
      // Synthesize the users table: id + email; the server core manages the
      // password hash column internally (it is never exposed to handlers).
      model.tables.set(model.auth.usersTable, {
        name: model.auth.usersTable,
        columns: [
          { name: 'id', type: 'auto', defaultValue: undefined, optional: false, indexed: false, references: undefined, node: authNode },
          { name: 'email', type: 'string', defaultValue: undefined, optional: false, indexed: true, references: undefined, node: authNode },
        ],
        node: authNode,
      });
    } else if (!users.columns.some((c) => c.name === 'email' && c.type === 'string')) {
      out.push(
        makeDiag('E813', 'error', `Auth users table "${users.name}" must declare an (email string) column`, {
          span: users.node.span,
          nodeId: users.node.id,
          op: 'auth',
          expected: '(table users (id auto) (email string))',
        }),
      );
    }
    const builtins: { method: ApiMethod; route: string; builtin: 'signup' | 'login' | 'logout' | 'logout-all' | 'me'; input: InputField[] | undefined }[] = [
      {
        method: 'post',
        route: '/api/auth/signup',
        builtin: 'signup',
        input: [
          { name: 'email', type: 'string', optional: false, node: authNode },
          { name: 'password', type: 'string', optional: false, node: authNode },
        ],
      },
      {
        method: 'post',
        route: '/api/auth/login',
        builtin: 'login',
        input: [
          { name: 'email', type: 'string', optional: false, node: authNode },
          { name: 'password', type: 'string', optional: false, node: authNode },
        ],
      },
      { method: 'post', route: '/api/auth/logout', builtin: 'logout', input: undefined },
      { method: 'post', route: '/api/auth/logout-all', builtin: 'logout-all', input: undefined },
      { method: 'get', route: '/api/auth/me', builtin: 'me', input: undefined },
    ];
    for (const b of builtins) {
      if (model.apis.some((a) => a.method === b.method && a.route === b.route)) continue;
      model.apis.push({
        method: b.method,
        route: b.route,
        params: [],
        handler: undefined,
        input: b.input,
        auth: false,
        builtin: b.builtin,
        node: authNode,
      });
    }
  }

  if (model.uploads?.public === false && model.auth === undefined) {
    out.push(makeDiag('E818', 'error', 'Private uploads require (auth users)', { span: model.uploads.node.span, expected: '(auth users) or :public true' }));
  }
  for (const route of model.apis) {
    if (route.auth && model.auth === undefined) {
      out.push(
        makeDiag('E813', 'error', ':auth true requires an (auth users) declaration', {
          span: route.node.span,
          nodeId: route.node.id,
          op: route.method,
          field: 'auth',
          expected: '(auth users)',
        }),
      );
    }
  }

  for (const testsNode of testsNodes) {
    const tp = splitList(testsNode);
    for (const t of tp.rest) {
      if (!isList(t) || opName(t) !== 'test') {
        out.push(
          makeDiag('E110', 'error', 'tests children must be (test "name" step...) forms', {
            span: t.span,
            nodeId: isList(t) ? t.id : undefined,
            op: 'tests',
          }),
        );
        continue;
      }
      const testParts = splitList(t);
      const nameAtom = testParts.rest[0];
      if (nameAtom?.kind !== 'string') {
        out.push(
          makeDiag('E104', 'error', 'test requires a name string', { span: t.span, nodeId: t.id, op: 'test' }),
        );
        continue;
      }
      const steps: ListNode[] = [];
      for (const step of testParts.rest.slice(1)) {
        if (!isList(step)) {
          out.push(makeDiag('E701', 'error', 'test steps must be forms like (visit "/")', { span: step.span, op: 'test' }));
          continue;
        }
        steps.push(step);
      }
      model.tests.push({ name: nameAtom.value, node: t, steps });
    }
  }

  return model;
}
