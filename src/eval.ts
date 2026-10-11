import { AppModel, FnDecl } from './analyze.js';
import { SExpr, isList, opName, splitList } from './ast.js';
import { EXPR_OPS, SERVER_OPS } from './schema.js';

/**
 * The pure-core interpreter behind `grhm eval` and `grhm repl`. It evaluates
 * the functional subset of GRHM — literals, stdlib expression ops, fn/lambda/
 * let/if/cond/match — with semantics that mirror the compiled TypeScript
 * exactly (same coercions, same null handling). UI, state, resources,
 * interop, and server ops are out of scope by design: those only exist in
 * compiled apps. The checker's purity rules and this interpreter agree on
 * what "pure" means.
 */

export type Value = unknown;

export class EvalError extends Error {}

interface Env {
  vars: Map<string, Value>;
  parent?: Env;
}

function lookup(env: Env, name: string): { found: boolean; value: Value } {
  for (let e: Env | undefined = env; e !== undefined; e = e.parent) {
    if (e.vars.has(name)) return { found: true, value: e.vars.get(name) };
  }
  return { found: false, value: undefined };
}

export interface EvalContext {
  functions: Map<string, FnDecl>;
  enums: Map<string, string[]>;
  /** locale -> key -> template; used by (t ...). */
  locales: Map<string, Map<string, string>>;
  defaultLocale: string | undefined;
}

export function contextFromApp(app: AppModel | undefined): EvalContext {
  const enums = new Map<string, string[]>();
  if (app !== undefined) {
    for (const [name, decl] of app.enums) enums.set(name, decl.values);
  }
  return {
    functions: app?.functions ?? new Map(),
    enums,
    locales: app?.locales ?? new Map(),
    defaultLocale: app?.defaultLocale,
  };
}

type Fn = (...args: Value[]) => Value;

function asFn(v: Value, what: string): Fn {
  if (typeof v !== 'function') throw new EvalError(`${what} expects a function`);
  return v as Fn;
}

function asList(v: Value): Value[] {
  // Match emitted JS: only absent values become []; other receivers retain
  // their own methods/iteration behavior, including native type errors.
  return (v ?? []) as Value[];
}

function num(v: Value): number {
  return Number(v);
}

/** Parsing ops report "not a number" as an absent value, mirroring the toNum/dateParse helpers. */
function nanToNull(n: number): number | null {
  return Number.isNaN(n) ? null : n;
}

function sortByKey(key: Fn, xs: Value[]): Value[] {
  return [...xs].sort((a, b) => {
    const ka = key(a) as never;
    const kb = key(b) as never;
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
}

function template(text: string, param: (name: string) => Value, encodeDynamic = false): string {
  let out = '';
  let rest = text;
  for (;;) {
    const open = rest.indexOf('{');
    if (open === -1) break;
    const close = rest.indexOf('}', open);
    if (close === -1) break;
    const name = rest.slice(open + 1, close);
    const value = String(param(name));
    out += rest.slice(0, open) + (encodeDynamic ? encodeURIComponent(value) : value);
    rest = rest.slice(close + 1);
  }
  return out + rest;
}

export function evalExpr(e: SExpr, ctx: EvalContext, env?: Env): Value {
  const scope: Env = env ?? { vars: new Map() };
  switch (e.kind) {
    case 'string':
      return e.value;
    case 'number':
      return e.value;
    case 'boolean':
      return e.value;
    case 'null':
      return null;
    case 'keyword':
      return ':' + e.name;
    case 'ident': {
      const segments = e.name.split('.');
      const head = segments[0] ?? e.name;
      const hit = lookup(scope, head);
      if (!hit.found) {
        if (ctx.enums.has(head)) return segments[1] ?? '';
        if (ctx.functions.has(head)) return fnValue(head, ctx);
        throw new EvalError(`unbound identifier "${head}" (eval covers the pure core: no state, resources, or interop)`);
      }
      let v = hit.value;
      for (const seg of segments.slice(1)) {
        v = (v as Record<string, Value>)[seg];
      }
      return v;
    }
    case 'list':
      return evalList(e, ctx, scope);
    default: {
      const exhaustive: never = e;
      throw new EvalError(`unhandled node kind: ${String(exhaustive)}`);
    }
  }
}

function fnValue(name: string, ctx: EvalContext): Fn {
  const decl = ctx.functions.get(name);
  if (decl === undefined) throw new EvalError(`unknown fn "${name}"`);
  return (...args: Value[]) => {
    const vars = new Map<string, Value>();
    decl.params.forEach((p, i) => vars.set(p, args[i]));
    return evalExpr(decl.body, ctx, { vars });
  };
}

function evalList(e: SExpr & { kind: 'list' }, ctx: EvalContext, env: Env): Value {
  const parts = splitList(e);
  const op = parts.op?.name;
  if (op === undefined) return [];
  const args = e.items.slice(1);
  const a = (i: number): Value => {
    const arg = args[i];
    if (arg === undefined) throw new EvalError(`(${op} ...) is missing argument ${i + 1}`);
    return evalExpr(arg, ctx, env);
  };
  const list = (i: number): Value[] => asList(a(i));
  const fn = (i: number): Fn => asFn(a(i), `(${op} ...)`);

  // User-defined fn call in head position.
  if (ctx.functions.has(op)) {
    const f = fnValue(op, ctx);
    return f(...args.map((x) => evalExpr(x, ctx, env)));
  }

  switch (op) {
    // Special forms ----------------------------------------------------------
    case 'if':
      return evalExpr(args[0] !== undefined && Boolean(evalExpr(args[0], ctx, env)) ? args[1]! : args[2]!, ctx, env);
    case 'lambda': {
      const paramList = args[0];
      const names = paramList !== undefined && isList(paramList) ? paramList.items.map((p) => (p.kind === 'ident' ? p.name : '_')) : [];
      const body = args[1];
      return (...callArgs: Value[]) => {
        const vars = new Map<string, Value>();
        names.forEach((n, i) => vars.set(n, callArgs[i]));
        return body !== undefined ? evalExpr(body, ctx, { vars, parent: env }) : undefined;
      };
    }
    case 'let': {
      const bindingList = args[0];
      const body = args[1];
      let inner: Env = env;
      if (bindingList !== undefined && isList(bindingList)) {
        for (const pair of bindingList.items) {
          if (!isList(pair)) continue;
          const name = pair.items[0];
          const value = pair.items[1];
          if (name === undefined || name.kind !== 'ident' || value === undefined) continue;
          // Each initializer sees only earlier bindings. Closures retain
          // that lexical scope even when a later binding shadows a name.
          inner = { vars: new Map([[name.name, evalExpr(value, ctx, inner)]]), parent: inner };
        }
      }
      return body !== undefined ? evalExpr(body, ctx, inner) : undefined;
    }
    case 'cond': {
      for (const clause of args) {
        if (!isList(clause)) continue;
        const test = clause.items[0];
        const value = clause.items[1];
        if (test !== undefined && test.kind === 'ident' && test.name === 'else') {
          return value !== undefined ? evalExpr(value, ctx, env) : undefined;
        }
        if (test !== undefined && Boolean(evalExpr(test, ctx, env))) {
          return value !== undefined ? evalExpr(value, ctx, env) : undefined;
        }
      }
      return undefined;
    }
    case 'match': {
      const scrutinee = args[0] !== undefined ? evalExpr(args[0], ctx, env) : undefined;
      for (const clause of args.slice(1)) {
        if (!isList(clause)) continue;
        const pattern = clause.items[0];
        const value = clause.items[1];
        if (pattern !== undefined && pattern.kind === 'ident' && pattern.name === 'else') {
          return value !== undefined ? evalExpr(value, ctx, env) : undefined;
        }
        if (pattern !== undefined && scrutinee === evalExpr(pattern, ctx, env)) {
          return value !== undefined ? evalExpr(value, ctx, env) : undefined;
        }
      }
      return undefined;
    }
    case 'attempt':
      try {
        return a(0);
      } catch {
        return a(1);
      }
    case 'call': {
      const target = args[0];
      if (target === undefined || target.kind !== 'ident') throw new EvalError('(call ...) expects a function name');
      const f = asFn(evalExpr(target, ctx, env), '(call ...)');
      return f(...args.slice(1).map((x) => evalExpr(x, ctx, env)));
    }
    case 'obj': {
      const out: Record<string, Value> = {};
      for (const [name, entry] of parts.props) out[name] = evalExpr(entry.value, ctx, env);
      return out;
    }
    case 'fmt':
    case 'path': {
      const text = parts.rest[0];
      if (text === undefined || text.kind !== 'string') return '';
      return template(text.value, (name) => {
        const entry = parts.props.get(name);
        return entry !== undefined ? evalExpr(entry.value, ctx, env) : '';
      }, op === 'path');
    }
    case 't': {
      const key = args[0];
      const keyName = key !== undefined && key.kind === 'ident' ? key.name : '';
      const catalog = ctx.defaultLocale !== undefined ? ctx.locales.get(ctx.defaultLocale) : undefined;
      let text = catalog?.get(keyName) ?? keyName;
      const params = new Map<string, Value>();
      for (const [name, entry] of parts.props) params.set(name, evalExpr(entry.value, ctx, env));
      for (const [name, value] of params) text = text.split('{' + name + '}').join(String(value));
      return text;
    }
    // Operators ---------------------------------------------------------------
    case '+':
      // Mirrors compiled `a + b`: numeric addition, string concatenation.
      return args
        .map((x) => evalExpr(x, ctx, env))
        .reduce((acc: Value, v: Value): Value => (acc as number) + (v as number));
    case '-':
      if (args.length === 1) return -num(a(0));
      return args.map((x) => num(evalExpr(x, ctx, env))).reduce((acc, v) => acc - v);
    case '*':
      return args.map((x) => num(evalExpr(x, ctx, env))).reduce((acc, v) => acc * v);
    case '/':
      return args.map((x) => num(evalExpr(x, ctx, env))).reduce((acc, v) => acc / v);
    case 'mod':
      return num(a(0)) % num(a(1));
    case '=':
      return a(0) === a(1);
    case '!=':
      return a(0) !== a(1);
    case '<':
      return (a(0) as number) < (a(1) as number);
    case '<=':
      return (a(0) as number) <= (a(1) as number);
    case '>':
      return (a(0) as number) > (a(1) as number);
    case '>=':
      return (a(0) as number) >= (a(1) as number);
    case 'and':
      return args.every((x) => Boolean(evalExpr(x, ctx, env)));
    case 'or':
      return args.some((x) => Boolean(evalExpr(x, ctx, env)));
    case 'not':
      return !a(0);
    case 'abs':
      return Math.abs(num(a(0)));
    case 'round':
      return Math.round(num(a(0)));
    case 'floor':
      return Math.floor(num(a(0)));
    case 'ceil':
      return Math.ceil(num(a(0)));
    case 'sqrt':
      return Math.sqrt(num(a(0)));
    case 'pow':
      return Math.pow(num(a(0)), num(a(1)));
    case 'min':
      return Math.min(...args.map((x) => num(evalExpr(x, ctx, env))));
    case 'max':
      return Math.max(...args.map((x) => num(evalExpr(x, ctx, env))));
    case 'random':
      return Math.random();
    case 'to-fixed':
      return num(a(1)).toFixed(num(a(0)));
    case 'to-num':
      return nanToNull(Number(a(0)));
    case 'to-str':
      return String(a(0));
    case 'upper':
      return String(a(0)).toUpperCase();
    case 'lower':
      return String(a(0)).toLowerCase();
    case 'trim':
      return String(a(0)).trim();
    case 'concat':
      return args.map((x) => String(evalExpr(x, ctx, env))).join('');
    case 'split':
      return String(a(1)).split(String(a(0)));
    case 'join':
      return list(1).join(String(a(0)));
    case 'replace':
      return String(a(2)).replaceAll(String(a(0)), String(a(1)));
    case 'starts-with':
      return String(a(1)).startsWith(String(a(0)));
    case 'ends-with':
      return String(a(1)).endsWith(String(a(0)));
    case 'slice':
      return (a(2) as { slice: (x: number, y: number) => Value }).slice(num(a(0)), num(a(1)));
    case 'count':
      return ((a(0) ?? []) as { length: number }).length;
    case 'map':
      return list(1).map(fn(0));
    case 'filter':
      return list(1).filter(fn(0));
    case 'find':
      return list(1).find(fn(0));
    case 'some':
      return list(1).some(fn(0));
    case 'every':
      return list(1).every(fn(0));
    case 'reduce':
      return list(2).reduce(fn(0), a(1));
    case 'sort-by':
      return sortByKey(a(0) as Fn, list(1));
    case 'reverse':
      return [...list(0)].reverse();
    case 'take':
      return list(1).slice(0, num(a(0)));
    case 'drop':
      return list(1).slice(num(a(0)));
    case 'nth':
      return list(1)[num(a(0))];
    case 'first':
      return list(0)[0];
    case 'last':
      return list(0).at(-1);
    case 'append':
      return [...list(0), a(1)];
    case 'contains': {
      const target = a(0);
      const needle = a(1);
      return (target as { includes(value: Value): boolean }).includes(needle);
    }
    case 'range': {
      const out: number[] = [];
      for (let i = num(a(0)); i < num(a(1)); i++) out.push(i);
      return out;
    }
    case 'sum':
      return list(0).reduce((acc: number, x) => acc + num(x), 0);
    case 'arr':
      return args.map((x) => evalExpr(x, ctx, env));
    case 'get': {
      const record = a(0);
      const key = a(1);
      return record === null || record === undefined ? undefined : (record as Record<string, Value>)[String(key)];
    }
    case 'keys': return Object.keys(a(0) as object);
    case 'values': return Object.values(a(0) as object);
    case 'entries': return Object.entries(a(0) as object);
    case 'from-entries': return Object.fromEntries(list(0) as Iterable<readonly [PropertyKey, unknown]>);
    case 'assoc': return { ...(a(0) as object), [String(a(1))]: a(2) };
    case 'dissoc': {
      const record = a(0);
      const key = a(1);
      return Object.fromEntries(Object.entries(record as object).filter(([name]) => name !== String(key)));
    }
    case 'merge': return Object.fromEntries(args.map((arg) => evalExpr(arg, ctx, env)).flatMap((record) => Object.entries(record as object)));
    case 'has-key': return Object.hasOwn(a(0) as object, String(a(1)));
    case 'json-parse': return JSON.parse(a(0) as string);
    case 'json-stringify': return JSON.stringify(a(0)) ?? 'null';
    case 'flat-map': return list(1).flatMap(fn(0));
    case 'flatten': return list(0).flat();
    case 'unique': return [...new Set(list(0))];
    case 'zip': {
      const left = list(0), right = list(1);
      return left.slice(0, Math.min(left.length, right.length)).map((value, index) => [value, right[index]]);
    }
    case 'chunk': {
      const size = a(0) as number;
      const source = list(1), result: Value[][] = [];
      if (!Number.isSafeInteger(size) || size <= 0) throw new RangeError('chunk size must be a positive safe integer');
      for (let index = 0; index < source.length; index += size) result.push(source.slice(index, index + size));
      return result;
    }
    case 'group-by': {
      const key = a(0) as Fn, source = list(1), groups = new Map<string, Value[]>();
      for (const value of source) {
        const name = String(key(value));
        const group = groups.get(name);
        if (group === undefined) groups.set(name, [value]); else group.push(value);
      }
      return Object.fromEntries(groups);
    }
    case 'regex-test': {
      const pattern = a(0), flags = args[2] === undefined ? '' : a(2);
      return new RegExp(pattern as string, flags as string).test(a(1) as string);
    }
    case 'regex-find': {
      const pattern = a(0), flags = args[2] === undefined ? '' : a(2);
      const match = new RegExp(pattern as string, flags as string).exec(a(1) as string);
      return match === null ? null : Array.from(match);
    }
    case 'regex-replace': {
      // Preserve the evaluation order of the generated receiver and arguments.
      const text = String(a(2));
      const pattern = a(0), flags = args[3] === undefined ? 'g' : a(3);
      const regex = new RegExp(pattern as string, flags as string);
      return text.replace(regex, a(1) as string);
    }
    case 'url-encode': return encodeURIComponent(a(0) as string);
    case 'url-decode': return decodeURIComponent(a(0) as string);
    case 'date-iso': return new Date(a(0) as number).toISOString();
    case 'date-parse': return nanToNull(Date.parse(a(0) as string));
    case 'clamp': {
      const maximum = a(1), minimum = a(0), value = a(2);
      return Math.min(maximum as number, Math.max(minimum as number, value as number));
    }
    case 'trunc': case 'sign': case 'sin': case 'cos': case 'tan':
    case 'asin': case 'acos': case 'atan': case 'exp': case 'log': case 'log10':
      return Math[op](a(0) as number);
    case 'atan2': return Math.atan2(a(0) as number, a(1) as number);
    case 'or-else': {
      const v = a(0);
      return v === null || v === undefined ? a(1) : v;
    }
    case 'is-null': {
      const v = a(0);
      return v === null || v === undefined;
    }
    case 'not-null': {
      const v = a(0);
      return v !== null && v !== undefined;
    }
    case 'now':
      return Date.now();
    case 'date-str':
      return new Date(num(a(0))).toLocaleDateString();
    default:
      if (EXPR_OPS[op] !== undefined || SERVER_OPS[op] !== undefined) {
        throw new EvalError(`"${op}" is not part of the pure core (state, resources, and server ops require a compiled app)`);
      }
      throw new EvalError(`unknown operation "${op}"`);
  }
}

/**
 * Format an eval result the way the REPL and CLI print it: JSON for finite
 * values, `#<fn>` for closures, and the bare `NaN`/`Infinity`/`-Infinity`
 * that JSON.stringify would flatten to null, so the non-finite results of
 * arithmetic stay distinguishable from the real null of to-num/date-parse.
 */
export function formatValue(v: Value): string {
  if (v === undefined || v === null) return 'null';
  if (typeof v === 'function') return '#<fn>';
  if (typeof v === 'number') return Number.isFinite(v) ? JSON.stringify(v) : String(v);
  if (typeof v === 'string' || typeof v === 'boolean') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(formatValue).join(',')}]`;
  return `{${Object.entries(v).map(([key, value]) => `${JSON.stringify(key)}:${formatValue(value)}`).join(',')}}`;
}

/** True when a top-level list is a pure-core expression usable in eval. */
export function isEvaluable(e: SExpr): boolean {
  if (!isList(e)) return true;
  const op = opName(e);
  if (op === undefined) return false;
  return EXPR_OPS[op] !== undefined || ['if', 'let', 'lambda', 'cond', 'match'].includes(op);
}
