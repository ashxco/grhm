import { SExpr, isList, opName, splitList } from '../ast.js';
import { TableDecl } from '../analyze.js';
import { BROWSER_GLOBALS, EXPR_OPS, WHERE_OPS } from '../schema.js';
import { camelCase } from '../util.js';

/** Translation of GRHM expressions and actions to TypeScript. */

export type BindingKind = 'state' | 'local' | 'resource' | 'eachvar' | 'param' | 'prop' | 'action' | 'js' | 'fn' | 'enum';

export interface Binding {
  kind: BindingKind;
  /** TypeScript expression that reads the value. */
  js: string;
  /** Setter function name for writable state. */
  setter?: string;
}

/** Generated namespaces cannot be spelled by a source binding (no underscores). */
export function isolatedBindingName(kind: 'fn' | 'import', name: string): string {
  return `__grhm_${kind}_${camelCase(name)}`;
}

export interface JsImports {
  /** JS export name -> local name. */
  named: Map<string, string>;
  /** Local names bound to the default export. */
  defaults: Set<string>;
}

export interface FileUses {
  useState: boolean;
  useId: boolean;
  menu: boolean;
  tabs: boolean;
  useStore: boolean;
  useResource: boolean;
  navigate: boolean;
  fmtMoney: boolean;
  fragment: boolean;
  changeEvent: boolean;
  formEvent: boolean;
  mouseEvent: boolean;
  stores: Set<string>;
  components: Set<string>;
  /** Module specifier -> imports required by this file. */
  jsImports: Map<string, JsImports>;
  /** Runtime helper functions (sortBy/range/sum) referenced by expressions. */
  helpers: Set<string>;
  /** User-defined GRHM fns referenced by this file (imported from gen lib). */
  libFns: Set<string>;
  /** True when (send ...) is used: imports send and makes handlers async. */
  send: boolean;
  /** True when (refresh ...) is used: imports refreshResource. */
  refresh: boolean;
  /** True when (toast ...) is used: imports showToast. */
  toast: boolean;
  /** True when (t ...) is used: imports tMsg from the generated i18n module. */
  i18n: boolean;
  /** True when the function needs a useEffect import (page titles, polling). */
  effect: boolean;
  /** True when (dialog ...) is used: imports DialogShell (focus trap + Esc). */
  dialog: boolean;
  /** True when (file-input ...) is used: imports uploadFile. */
  upload: boolean;
}

export function newUses(): FileUses {
  return {
    useState: false,
    useId: false,
    menu: false,
    tabs: false,
    useStore: false,
    useResource: false,
    navigate: false,
    fmtMoney: false,
    fragment: false,
    changeEvent: false,
    formEvent: false,
    mouseEvent: false,
    stores: new Set(),
    components: new Set(),
    jsImports: new Map(),
    helpers: new Set(),
    libFns: new Set(),
    send: false,
    refresh: false,
    toast: false,
    i18n: false,
    effect: false,
    dialog: false,
    upload: false,
  };
}

export function addJsImport(uses: FileUses, module: string, jsName: string, localName: string, isDefault: boolean): void {
  const entry = uses.jsImports.get(module) ?? { named: new Map(), defaults: new Set() };
  if (isDefault) entry.defaults.add(localName);
  else entry.named.set(jsName, localName);
  uses.jsImports.set(module, entry);
}

/**
 * Rewrite a project-root-relative interop module (./lib/x.ts) into a path
 * relative to the generated file. npm packages pass through unchanged.
 * Node-executed modules (lib/server) keep the extension: the Node ESM loader
 * requires it, and Vite + allowImportingTsExtensions accept it.
 */
function moduleSpecifier(module: string, fileDepth: number, outDirDepth: number, keepExtension: boolean): string {
  if (!module.startsWith('./') && !module.startsWith('../')) return module;
  const clean = keepExtension ? module.replace(/^\.\//, '') : module.replace(/^\.\//, '').replace(/\.(ts|tsx|js|jsx)$/, '');
  return (outDirDepth + fileDepth === 0 ? './' : '../'.repeat(outDirDepth + fileDepth)) + clean;
}

export function jsImportLines(uses: FileUses, fileDepth: number, outDirDepth: number, keepExtension = false): string {
  const lines: string[] = [];
  for (const [module, imp] of [...uses.jsImports].sort(([a], [b]) => a.localeCompare(b))) {
    const spec = moduleSpecifier(module, fileDepth, outDirDepth, keepExtension);
    // Module specifiers originate in GRHM string literals. Serialize them as
    // JavaScript strings rather than interpolating inside quotes, otherwise a
    // quote in `(use "...")` can escape the import and inject top-level code.
    const specLiteral = JSON.stringify(spec);
    for (const local of [...imp.defaults].sort()) {
      lines.push(`import ${local} from ${specLiteral};`);
    }
    if (imp.named.size > 0) {
      const named = [...imp.named]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([jsName, local]) => (jsName === local ? jsName : `${jsName} as ${local}`));
      lines.push(`import { ${named.join(', ')} } from ${specLiteral};`);
    }
  }
  return lines.length > 0 ? lines.join('\n') + '\n' : '';
}

export interface GenCtx {
  bindings: Map<string, Binding>;
  classFor: Map<string, string>;
  uses: FileUses;
  /** Component names defined in the file being generated (no import needed). */
  sameFileComponents: Set<string>;
  /** Resource name -> URL, for lowering (refresh name) to refreshResource(url). */
  resourceUrls?: Map<string, string>;
  /** Table declarations, for lowering (select :where ...) to SQL. */
  tables?: Map<string, TableDecl>;
  /** Default locale name when the app declares (i18n ...). */
  defaultLocale?: string;
}

const JS_IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const EXPR_HELPERS = new Set(['range', 'sum', 'sortBy', 'zip', 'chunk', 'groupBy', 'dissoc', 'mergeRecords', 'tMsg', 'dbAll', 'dbSelect', 'dbInsert', 'dbUpdate', 'dbDelete', 'apiFail', 'dbTx', 'handleActionError']);

/** Keep lexical bindings distinct from the surrounding generated names. */
export function genBindingName(name: string, bindings: Map<string, Binding>): string {
  const used = new Set([...bindings.values()].flatMap((binding) => binding.js.match(/[A-Za-z_$][A-Za-z0-9_$]*/g) ?? []));
  let js = camelCase(name);
  while (used.has(js) || EXPR_HELPERS.has(js)) js += '$';
  return js;
}

function accessPath(base: string, segments: string[]): string {
  let out = base;
  for (const seg of segments) {
    out += JS_IDENT.test(seg) ? `.${seg}` : `[${JSON.stringify(seg)}]`;
  }
  return out;
}

export function genIdent(name: string, ctx: GenCtx): string {
  const segments = name.split('.');
  const head = segments[0] ?? name;
  const binding = ctx.bindings.get(head);
  if (binding?.kind === 'fn') ctx.uses.libFns.add(head);
  // Enum member reads lower to their string value: status.open -> "open".
  if (binding?.kind === 'enum') return JSON.stringify(segments[1] ?? '');
  const base = binding !== undefined ? binding.js : camelCase(head);
  return accessPath(base, segments.slice(1));
}

/** Compile a (select :where ...) expression to a SQL fragment + JS params. */
export function genWhere(e: SExpr, table: TableDecl, ctx: GenCtx): { sql: string; params: string[] } {
  const params: string[] = [];
  const go = (x: SExpr, preferHandlerBinding = false): string => {
    // Comparisons conventionally put the column on the left and the value on
    // the right. When a route param/body binding has the same name as a column
    // (the common `(= id id)` case), prefer that binding in value position so
    // the predicate cannot silently degrade to `"id" = "id"`.
    if (x.kind === 'ident' && preferHandlerBinding) {
      const binding = ctx.bindings.get(x.name);
      if (binding?.kind === 'param' || binding?.kind === 'eachvar') {
        params.push(genExpr(x, ctx));
        return '?';
      }
    }
    if (x.kind === 'ident' && table.columns.some((c) => c.name === x.name)) {
      return `"${x.name}"`;
    }
    if (isList(x)) {
      const op = opName(x);
      if (op !== undefined && WHERE_OPS.has(op)) {
        const args = x.items.slice(1);
        const operand = (index: number, preferBinding = false): string => {
          const arg = args[index];
          return arg !== undefined ? go(arg, preferBinding) : 'NULL';
        };
        switch (op) {
          case 'and':
          case 'or':
            return args.length > 0 ? '(' + args.map((arg) => go(arg)).join(` ${op.toUpperCase()} `) + ')' : '(NULL)';
          case 'not':
            return `(NOT ${operand(0)})`;
          case 'contains': {
            // The needle may itself be a column. In value position a handler
            // binding with the same name still wins (for example a route
            // parameter named `name`). Convert values with JS String semantics:
            // SQLite's text conversion would turn true into '1' and 7 into '7.0'.
            const col = args[0] !== undefined ? go(args[0]) : '""';
            const value = args[1];
            let needle: string;
            const binding = value?.kind === 'ident' ? ctx.bindings.get(value.name) : undefined;
            const column = value?.kind === 'ident' && binding?.kind !== 'param' && binding?.kind !== 'eachvar'
              ? table.columns.find((c) => c.name === value.name)
              : undefined;
            if (value !== undefined && (column !== undefined || (isList(value) && WHERE_OPS.has(opName(value) ?? '')))) {
              needle = `grhm_string(${go(value)}, ${column === undefined || column.type === 'boolean' ? 1 : 0})`;
            } else {
              params.push(value !== undefined ? `String(${genExpr(value, ctx)})` : '"undefined"');
              needle = '?';
            }
            // instr is case-sensitive and treats %, _, and backslashes literally.
            // A null haystack is a nonmatch, including under NOT/OR.
            return `(COALESCE(instr(${col}, ${needle}), 0) > 0)`;
          }
          case '=':
          case '!=': {
            // IS keeps normal column affinity but returns a boolean for nulls:
            // null equals null; null differs from every nonnull value.
            const sqlOp = op === '=' ? 'IS' : 'IS NOT';
            return `(${operand(0)} ${sqlOp} ${operand(1, true)})`;
          }
          default:
            return `(${operand(0)} ${op} ${operand(1, true)})`;
        }
      }
    }
    // Anything else is a handler-side value bound as a SQL parameter.
    params.push(genExpr(x, ctx));
    return '?';
  };
  const sql = go(e);
  return { sql, params };
}

function genTemplate(e: SExpr, ctx: GenCtx, encodeDynamic: boolean): string {
  if (!isList(e)) return genExpr(e, ctx);
  const parts = splitList(e);
  const template = parts.rest[0];
  if (template === undefined || template.kind !== 'string') return '""';
  const chunks: string[] = [];
  let text = template.value;
  for (;;) {
    const open = text.indexOf('{');
    if (open === -1) break;
    const close = text.indexOf('}', open);
    if (close === -1) break;
    const param = text.slice(open + 1, close);
    const value = parts.props.get(param)?.value;
    chunks.push(JSON.stringify(text.slice(0, open)));
    const dynamic = `String(${value !== undefined ? genExpr(value, ctx) : '""'})`;
    chunks.push(encodeDynamic ? `encodeURIComponent(${dynamic})` : dynamic);
    text = text.slice(close + 1);
  }
  chunks.push(JSON.stringify(text));
  return chunks.length === 1 ? chunks[0] ?? '""' : `(${chunks.join(' + ')})`;
}

export function genPathTemplate(e: SExpr, ctx: GenCtx): string {
  return genTemplate(e, ctx, true);
}

export function genExpr(e: SExpr, ctx: GenCtx): string {
  switch (e.kind) {
    case 'string':
      return JSON.stringify(e.value);
    case 'number':
      return Object.is(e.value, -0) ? '-0' : String(e.value);
    case 'boolean':
      return e.value ? 'true' : 'false';
    case 'null':
      return 'null';
    case 'keyword':
      return JSON.stringify(':' + e.name);
    case 'ident':
      return genIdent(e.name, ctx);
    case 'list': {
      const parts = splitList(e);
      const op = parts.op?.name;
      if (op === undefined) return '[]';
      const args = e.items.slice(1);
      const spec = EXPR_OPS[op];
      /** Generated i-th argument. */
      const a = (i: number): string => genExpr(args[i] ?? e, ctx);
      /** Argument as a list, degrading null/undefined to []. */
      const list = (i: number): string => {
        const arg = args[i];
        // TS rejects an unreachable ?? fallback on string/array literals.
        if (arg?.kind === 'string' || (arg !== undefined && isList(arg) && (arg.items.length === 0 || opName(arg) === 'arr'))) return `(${a(i)})`;
        return `((${a(i)}) ?? [])`;
      };
      switch (op) {
        case 'path':
          return genPathTemplate(e, ctx);
        case 'call': {
          const target = args[0];
          const callArgs = args.slice(1).map((x) => genExpr(x, ctx));
          if (target === undefined || target.kind !== 'ident') return '/* invalid call */ undefined';
          return `${genIdent(target.name, ctx)}(${callArgs.join(', ')})`;
        }
        case 'if':
          return `((${a(0)}) ? (${a(1)}) : (${a(2)}))`;
        case 'lambda': {
          const paramList = args[0];
          const params = paramList !== undefined && isList(paramList) ? paramList.items : [];
          const names: string[] = [];
          const inner: GenCtx = { ...ctx, bindings: new Map(ctx.bindings) };
          for (const p of params) {
            const js = p.kind === 'ident' ? genBindingName(p.name, inner.bindings) : '_';
            names.push(js);
            if (p.kind === 'ident') inner.bindings.set(p.name, { kind: 'eachvar', js });
          }
          const body = args[1];
          return `(${names.map((n) => `${n}: any`).join(', ')}) => (${body !== undefined ? genExpr(body, inner) : 'undefined'})`;
        }
        case 'let': {
          const bindingList = args[0];
          const body = args[1];
          const pairs = bindingList !== undefined && isList(bindingList) ? bindingList.items : [];
          const inner: GenCtx = { ...ctx, bindings: new Map(ctx.bindings) };
          const stmts: string[] = [];
          for (const pair of pairs) {
            if (!isList(pair)) continue;
            const name = pair.items[0];
            const value = pair.items[1];
            if (name === undefined || name.kind !== 'ident' || value === undefined) continue;
            // A same-named JS declaration would put outer reads (including
            // earlier initializers) in its temporal dead zone. Give lexical
            // shadows distinct names while preserving sequential visibility.
            const js = genBindingName(name.name, inner.bindings);
            stmts.push(`const ${js} = ${genExpr(value, inner)};`);
            inner.bindings.set(name.name, { kind: 'eachvar', js });
          }
          return `(() => { ${stmts.join(' ')} return ${body !== undefined ? genExpr(body, inner) : 'undefined'}; })()`;
        }
        case 'arr':
          return '[' + args.map((x) => genExpr(x, ctx)).join(', ') + ']';
        case 'concat': {
          const chunks = args.map((x) => (x.kind === 'string' ? JSON.stringify(x.value) : `String(${genExpr(x, ctx)})`));
          return chunks.length === 0 ? '""' : `(${chunks.join(' + ')})`;
        }
        case 'and':
          return `Boolean(${args.map((x) => `(${genExpr(x, ctx)})`).join(' && ')})`;
        case 'or':
          return `Boolean(${args.map((x) => `(${genExpr(x, ctx)})`).join(' || ')})`;
        case 'count':
          return `(${list(0)}).length`;
        case 'not':
          return `!(${a(0)})`;
        case '-':
          if (args.length === 1) return `(-(${a(0)}))`;
          return '(' + args.map((x) => genExpr(x, ctx)).join(' - ') + ')';
        case 'mod':
          return `((${a(0)}) % (${a(1)}))`;
        case 'abs':
        case 'round':
        case 'floor':
        case 'ceil':
        case 'sqrt':
          return `Math.${op}(${a(0)})`;
        case 'pow':
          return `Math.pow(${a(0)}, ${a(1)})`;
        case 'min':
        case 'max':
          return `Math.${op}(${args.map((x) => genExpr(x, ctx)).join(', ')})`;
        case 'random':
          return 'Math.random()';
        case 'to-fixed':
          return `Number(${a(1)}).toFixed(${a(0)})`;
        case 'to-num':
          return `Number(${a(0)})`;
        case 'to-str':
          return `String(${a(0)})`;
        case 'upper':
          return `String(${a(0)}).toUpperCase()`;
        case 'lower':
          return `String(${a(0)}).toLowerCase()`;
        case 'trim':
          return `String(${a(0)}).trim()`;
        case 'split':
          return `String(${a(1)}).split(${a(0)})`;
        case 'join':
          return `${list(1)}.join(${a(0)})`;
        case 'replace':
          return `String(${a(2)}).replaceAll(${a(0)}, ${a(1)})`;
        case 'starts-with':
          return `String(${a(1)}).startsWith(${a(0)})`;
        case 'ends-with':
          return `String(${a(1)}).endsWith(${a(0)})`;
        case 'slice':
          return `(${a(2)}).slice(${a(0)}, ${a(1)})`;
        case 'map':
          return `${list(1)}.map(${a(0)})`;
        case 'filter':
          return `${list(1)}.filter(${a(0)})`;
        case 'find':
          return `${list(1)}.find(${a(0)})`;
        case 'some':
          return `${list(1)}.some(${a(0)})`;
        case 'every':
          return `${list(1)}.every(${a(0)})`;
        case 'reduce':
          return `${list(2)}.reduce(${a(0)}, ${a(1)})`;
        case 'sort-by':
          ctx.uses.helpers.add('sortBy');
          return `sortBy(${a(0)}, ${a(1)})`;
        case 'reverse':
          return `[...${list(0)}].reverse()`;
        case 'take':
          return `${list(1)}.slice(0, ${a(0)})`;
        case 'drop':
          return `${list(1)}.slice(${a(0)})`;
        case 'nth':
          return `${list(1)}[${a(0)}]`;
        case 'first':
          return `${list(0)}[0]`;
        case 'last':
          return `${list(0)}.at(-1)`;
        case 'append':
          return `[...${list(0)}, ${a(1)}]`;
        case 'contains':
          return `((${a(0)}) as any).includes(${a(1)})`;
        case 'range':
          ctx.uses.helpers.add('range');
          return `range(${a(0)}, ${a(1)})`;
        case 'sum':
          ctx.uses.helpers.add('sum');
          return `sum(${a(0)})`;
        case 'obj': {
          const fields: string[] = [];
          for (const [name, entry] of parts.props) {
            fields.push(`${JSON.stringify(name)}: ${genExpr(entry.value, ctx)}`);
          }
          return '{ ' + fields.join(', ') + ' }';
        }
        case 'get':
          return `((${a(0)}) as any)?.[String(${a(1)})]`;
        case 'keys':
        case 'values':
        case 'entries':
          return `Object.${op}(${a(0)})`;
        case 'from-entries':
          return `Object.fromEntries(${list(0)})`;
        case 'assoc':
          return `({ ...(${a(0)}), [${args[1]?.kind === 'string' ? a(1) : `String(${a(1)})`}]: ${a(2)} })`;
        case 'dissoc':
          ctx.uses.helpers.add('dissoc');
          return `dissoc(${a(0)}, ${args[1]?.kind === 'string' ? a(1) : `String(${a(1)})`})`;
        case 'merge':
          ctx.uses.helpers.add('mergeRecords');
          return `mergeRecords(${args.map(x => genExpr(x, ctx)).join(', ')})`;
        case 'has-key':
          return `Object.hasOwn(${a(0)}, String(${a(1)}))`;
        case 'json-parse':
          return `JSON.parse(${a(0)})`;
        case 'json-stringify':
          return `(JSON.stringify(${a(0)}) ?? 'null')`;
        case 'flat-map':
          return `${list(1)}.flatMap(${a(0)})`;
        case 'flatten':
          return `${list(0)}.flat()`;
        case 'unique':
          return `[...new Set(${list(0)})]`;
        case 'zip':
          ctx.uses.helpers.add('zip');
          return `zip(${a(0)}, ${a(1)})`;
        case 'chunk':
          ctx.uses.helpers.add('chunk');
          return `chunk(${a(0)}, ${a(1)})`;
        case 'group-by':
          ctx.uses.helpers.add('groupBy');
          return `groupBy(${a(0)}, ${a(1)})`;
        case 'regex-test':
          return `new RegExp(${a(0)}, ${args[2] === undefined ? "''" : a(2)}).test(${a(1)})`;
        case 'regex-find':
          return `((__grhmMatch: any) => __grhmMatch === null ? null : Array.from(__grhmMatch))(new RegExp(${a(0)}, ${args[2] === undefined ? "''" : a(2)}).exec(${a(1)}))`;
        case 'regex-replace':
          return `String(${a(2)}).replace(new RegExp(${a(0)}, ${args[3] === undefined ? "'g'" : a(3)}), ${a(1)})`;
        case 'url-encode':
          return `encodeURIComponent(${a(0)})`;
        case 'url-decode':
          return `decodeURIComponent(${a(0)})`;
        case 'date-iso':
          return `new Date(${a(0)}).toISOString()`;
        case 'date-parse':
          return `Date.parse(${a(0)})`;
        case 'clamp':
          return `Math.min(${a(1)}, Math.max(${a(0)}, ${a(2)}))`;
        case 'trunc': case 'sign': case 'sin': case 'cos': case 'tan':
        case 'asin': case 'acos': case 'atan': case 'atan2': case 'exp': case 'log': case 'log10':
          return `Math.${op}(${args.map(x => genExpr(x, ctx)).join(', ')})`;
        case 'or-else':
          return `((${a(0)}) ?? (${a(1)}))`;
        case 'is-null':
          return `((${a(0)}) == null)`;
        case 'not-null':
          return `((${a(0)}) != null)`;
        case 'attempt':
          return `(() => { try { return ${a(0)}; } catch { return ${a(1)}; } })()`;
        case 'now':
          return 'Date.now()';
        case 'date-str':
          return `new Date(${a(0)}).toLocaleDateString()`;
        case 'fmt':
          return genTemplate(e, ctx, false);
        case 't': {
          ctx.uses.i18n = true;
          const key = args[0];
          const keyName = key !== undefined && key.kind === 'ident' ? key.name : '';
          const fields: string[] = [];
          for (const [name, entry] of parts.props) {
            fields.push(`${JSON.stringify(name)}: ${genExpr(entry.value, ctx)}`);
          }
          const localeExpr = ctx.bindings.has('locale') ? genIdent('locale', ctx) : JSON.stringify(ctx.defaultLocale ?? 'en');
          const paramsArg = fields.length > 0 ? `, { ${fields.join(', ')} }` : '';
          return `tMsg(${localeExpr}, ${JSON.stringify(keyName)}${paramsArg})`;
        }
        case 'cond': {
          let out = '(';
          let closed = false;
          for (const clause of args) {
            if (!isList(clause)) continue;
            const test = clause.items[0];
            const value = clause.items[1];
            if (test !== undefined && test.kind === 'ident' && test.name === 'else') {
              out += `(${value !== undefined ? genExpr(value, ctx) : 'undefined'})`;
              closed = true;
              break;
            }
            out += `(${test !== undefined ? genExpr(test, ctx) : 'false'}) ? (${value !== undefined ? genExpr(value, ctx) : 'undefined'}) : `;
          }
          if (!closed) out += 'undefined';
          return out + ')';
        }
        case 'match': {
          const scrutinee = args[0];
          const sExpr = scrutinee !== undefined ? genExpr(scrutinee, ctx) : 'undefined';
          let out = '(';
          let closed = false;
          for (const clause of args.slice(1)) {
            if (!isList(clause)) continue;
            const pattern = clause.items[0];
            const value = clause.items[1];
            if (pattern !== undefined && pattern.kind === 'ident' && pattern.name === 'else') {
              out += `(${value !== undefined ? genExpr(value, ctx) : 'undefined'})`;
              closed = true;
              break;
            }
            out += `__grhmMatch === (${pattern !== undefined ? genExpr(pattern, ctx) : 'undefined'}) ? (${value !== undefined ? genExpr(value, ctx) : 'undefined'}) : `;
          }
          if (!closed) out += 'undefined';
          // The scrutinee can contain random, interop, or a database mutation.
          // Evaluate it once, including matches with only an else clause.
          return `((__grhmMatch: any) => ${out}))(${sExpr})`;
        }
        // Server ops (checker restricts these to api handlers; the helpers
        // are defined in the generated server module).
        case 'select': {
          const table = args[0]?.kind === 'ident' ? args[0].name : '';
          const props = parts.props;
          if (props.size === 0) return `dbAll(${JSON.stringify(table)})`;
          const decl = ctx.tables?.get(table);
          const whereExpr = props.get('where')?.value;
          const where = whereExpr !== undefined && decl !== undefined ? genWhere(whereExpr, decl, ctx) : undefined;
          const orderProp = props.get('order')?.value;
          const descProp = props.get('desc')?.value;
          const order =
            orderProp !== undefined && orderProp.kind === 'ident'
              ? `"${orderProp.name}"${descProp !== undefined && descProp.kind === 'boolean' && descProp.value ? ' DESC' : ''}`
              : undefined;
          const opts: string[] = [];
          if (where !== undefined) opts.push(`where: ${JSON.stringify(where.sql)}, args: [${where.params.join(', ')}]`);
          if (order !== undefined) opts.push(`order: ${JSON.stringify(order)}`);
          const limit = props.get('limit')?.value;
          if (limit !== undefined) opts.push(`limit: ${genExpr(limit, ctx)}`);
          const offset = props.get('offset')?.value;
          if (offset !== undefined) opts.push(`offset: ${genExpr(offset, ctx)}`);
          return `dbSelect(${JSON.stringify(table)}, { ${opts.join(', ')} })`;
        }
        case 'fail':
          return `apiFail(${a(0)}, ${a(1)})`;
        case 'tx':
          return `dbTx(() => (${a(0)}))`;
        case 'insert':
        case 'update': {
          const table = args[0]?.kind === 'ident' ? args[0].name : '';
          const props = parts.props;
          const fields: string[] = [];
          for (const [name, entry] of props) {
            if (op === 'update' && name === 'id') continue;
            fields.push(`${JSON.stringify(name)}: ${genExpr(entry.value, ctx)}`);
          }
          const values = '{ ' + fields.join(', ') + ' }';
          if (op === 'insert') return `dbInsert(${JSON.stringify(table)}, ${values})`;
          const idExpr = props.get('id') !== undefined ? genExpr(props.get('id')!.value, ctx) : 'undefined';
          return `dbUpdate(${JSON.stringify(table)}, ${idExpr}, ${values})`;
        }
        case 'delete-row': {
          const table = args[0]?.kind === 'ident' ? args[0].name : '';
          const idExpr = parts.props.get('id') !== undefined ? genExpr(parts.props.get('id')!.value, ctx) : 'undefined';
          return `dbDelete(${JSON.stringify(table)}, ${idExpr})`;
        }
        default: {
          if (spec !== undefined && spec.js !== undefined) {
            return '(' + args.map((x) => genExpr(x, ctx)).join(' ' + spec.js + ' ') + ')';
          }
          // Direct call of a user fn or interop binding: (subtotal xs).
          const kind = ctx.bindings.get(op)?.kind;
          if (kind === 'fn' || kind === 'js' || BROWSER_GLOBALS.has(op)) {
            return `${genIdent(op, ctx)}(${args.map((x) => genExpr(x, ctx)).join(', ')})`;
          }
          // Checker rejects unknown expression ops; emit something inspectable.
          return '/* unsupported */ undefined';
        }
      }
    }
    default: {
      const exhaustive: never = e;
      throw new Error(`unhandled node kind: ${String(exhaustive)}`);
    }
  }
}

/** One action (set/nav/action-prop call) as a TypeScript statement, no semicolon. */
export function genAction(e: SExpr, ctx: GenCtx): string {
  if (e.kind === 'ident') {
    return genIdent(e.name, ctx) + '()';
  }
  if (!isList(e)) return '/* invalid action */';
  const parts = splitList(e);
  const op = parts.op?.name;
  if (op === 'set') {
    const target = parts.rest[0];
    const value = parts.rest[1];
    if (target === undefined || target.kind !== 'ident' || value === undefined) return '/* invalid set */';
    const binding = ctx.bindings.get(target.name);
    const setter = binding?.setter ?? 'set' + camelCase(target.name);
    return `${setter}(${genExpr(value, ctx)})`;
  }
  if (op === 'nav') {
    ctx.uses.navigate = true;
    const to = parts.rest[0];
    if (to === undefined) return '/* invalid nav */';
    if (to.kind === 'string') return `navigate(${JSON.stringify(to.value)})`;
    return `navigate(${genPathTemplate(to, ctx)})`;
  }
  if (op === 'send') {
    ctx.uses.send = true;
    const method = parts.rest[0];
    const target = parts.rest[1];
    if (method === undefined || method.kind !== 'ident' || target === undefined) return '/* invalid send */';
    const url = target.kind === 'string' ? JSON.stringify(target.value) : genPathTemplate(target, ctx);
    const fields: string[] = [];
    for (const [name, entry] of parts.props) {
      fields.push(`${JSON.stringify(name)}: ${genExpr(entry.value, ctx)}`);
    }
    const body = fields.length > 0 ? `, { ${fields.join(', ')} }` : '';
    return `await send(${JSON.stringify(method.name)}, ${url}${body})`;
  }
  if (op === 'refresh') {
    ctx.uses.refresh = true;
    const target = parts.rest[0];
    const url = target?.kind === 'ident' ? ctx.resourceUrls?.get(target.name) : undefined;
    if (url === undefined) return '/* invalid refresh */';
    return `refreshResource(${JSON.stringify(url)})`;
  }
  if (op === 'toast') {
    ctx.uses.toast = true;
    const message = parts.rest[0];
    const tone = parts.props.get('tone')?.value;
    const toneName = tone !== undefined && tone.kind === 'ident' ? tone.name : tone !== undefined && tone.kind === 'string' ? tone.value : 'info';
    return `showToast(${message !== undefined ? genExpr(message, ctx) : '""'}, ${JSON.stringify(toneName)})`;
  }
  if (op === 'try') {
    const bodyActions: SExpr[] = [];
    let catchActions: SExpr[] = [];
    for (const item of parts.rest) {
      if (isList(item) && opName(item) === 'catch') {
        catchActions = splitList(item).rest;
      } else {
        bodyActions.push(item);
      }
    }
    const bodyStmts = bodyActions.map((x) => genAction(x, ctx) + ';').join(' ');
    const catchStmts = catchActions.map((x) => genAction(x, ctx) + ';').join(' ');
    return `try { ${bodyStmts} } catch { ${catchStmts} }`;
  }
  if (op === 'call' || (op !== undefined && (ctx.bindings.get(op)?.kind === 'js' || BROWSER_GLOBALS.has(op)))) {
    return genExpr(e, ctx);
  }
  return '/* invalid action */';
}

/** Async event failures are reported and shown instead of becoming unhandled rejections. */
export function actionStatements(stmts: string[], ctx: GenCtx): string {
  const body = stmts.map((statement) => statement + ';').join(' ');
  if (!stmts.some((statement) => statement.includes('await '))) return body;
  ctx.uses.helpers.add('handleActionError');
  return `try { ${body} } catch (__grhmError: unknown) { handleActionError(__grhmError); }`;
}

/** Zero-argument handler wrapping one or more actions. */
export function genHandler(actions: SExpr[], ctx: GenCtx): string {
  const stmts = actions.map((a) => genAction(a, ctx));
  const prefix = stmts.some((s) => s.includes('await ')) ? 'async ' : '';
  if (stmts.length === 1 && prefix === '') return `() => ${stmts[0]}`;
  return `${prefix}() => { ${actionStatements(stmts, ctx)} }`;
}
