import { fieldErrors } from './runtime/contracts.js';
import { BooleanAtom, IdentAtom, ListNode, NullAtom, NumberAtom, SExpr, Span, StringAtom, isList, opName, splitList } from './ast.js';
import { ApiMethod, ApiRouteDecl, AppModel, ComponentModel, PageModel, TableDecl, danglingKeywordDiag } from './analyze.js';
import { checkTests } from './check-tests.js';
import { Diagnostic, Fix, FixConfidence, makeDiag } from './diagnostics.js';
import { NO_SPELLING, appendChildFix, fixesOf, insertAfterFix, insertChildFix, insertPropFix, keywordFix, literalFix, placeholderLiteral, renameHeadFix, replaceIdentSegment, replaceSpan, spellingFix, tokenFix, wrapFix } from './fix-builders.js';
import { renderInline } from './format.js';
import { ACTION_OPS, BROWSER_GLOBALS, EXPR_OPS, OpSchema, SELECT_PROPS, SEND_METHODS, SERVER_OPS, WHERE_OPS, allOpNames, allowedProps, lookupOp, propType } from './schema.js';
import {
  NUMERIC_OPS,
  CallableInfo,
  Scope,
  TypeInfo,
  VarInfo,
  baseScope,
  bindingFromInfo,
  bindingInfo,
  columnValueType,
  componentInitializerScope,
  declaredType,
  elementInfo,
  fieldInfo,
  fnScope,
  handlerScope,
  inferCall,
  inferInfo,
  inferType,
  initializerInfo,
  isAssignable,
  isNullable,
  jobScope,
  narrowScope,
  pageInitializerScope,
  stateInitializerScope,
  typeLabel,
  withoutNull,
} from './typing.js';
import { camelCase, isSafeCssLiteral, validBindingName } from './util.js';

/**
 * Semantic checker (PRD FR-2). Validates element structure, properties,
 * references, routes, resource-state discipline, expression types, interop,
 * and basic accessibility, producing structured diagnostics only. No user
 * code is executed.
 */

export type { VarKind, VarInfo, ValueType } from './typing.js';
export { inferType } from './typing.js';

interface Ctx {
  app: AppModel;
  out: Diagnostic[];
  /** Resources whose loading/error state is acknowledged in this branch. */
  guarded: Set<string>;
  inComponent: boolean;
  /** True while checking an (api ...) handler body, enabling server-only ops. */
  inHandler?: boolean;
  /** HTTP method of the current api handler; absent for jobs. */
  routeMethod?: ApiMethod;
  /** True while checking the body of a synchronous SQLite transaction. */
  inTransaction?: boolean;
  /** Stop recursive call-site specialization while checking function bodies. */
  checkingCalls?: Set<CallableInfo>;
  /** True inside a pure fn body or a test expect-eq expression, where a throw reaches the caller or fails the test rather than the UI (silences W801). */
  inFn?: boolean;
  /** True while checking the first operand of (attempt expr fallback), whose throw is the documented path. */
  inAttempt?: boolean;
  /** Declared fns whose bodies may throw to their caller (see throwingFunctions); a call outside attempt/fn/test is W801. */
  throwingFns: Set<string>;
  /** Literal verification per throwing-op node, so a body specialised at many call sites verifies its literals once. */
  literalVerdicts: Map<ListNode, LiteralVerdict>;
}

const RESOURCE_FIELDS = new Set(['data', 'loading', 'error']);
/** Special forms accepted in expression position beside EXPR_OPS (the rest of the `expected` list of E109). */
const EXPR_FORMS = ['call', 'if', 'let', 'lambda'];
const EVENT_OPS = new Set(['click', 'change', 'submit']);
const DB_MUTATION_OPS = new Set(['insert', 'update', 'delete-row']);

function isCallable(info: TypeInfo): boolean {
  return !isNullable(info) && (info.type === 'unknown' || info.type === 'function' || (info.type === 'union' && (info.members ?? []).every(isCallable)));
}

/** The hints a type mismatch carries: display-only suggestions and machine-applicable fixes. */
interface TypeRepair {
  suggestions?: string[];
  fixes?: Fix[];
}

function checkType(value: SExpr, wanted: TypeInfo, scope: Scope, ctx: Ctx, op: string, field?: string, repair: (received: TypeInfo) => TypeRepair = (received) => fallbackRepair(value, received, wanted)): void {
  const received = inferInfo(value, scope, ctx.app.tables);
  if (isAssignable(received, wanted)) return;
  ctx.out.push(makeDiag('E111', 'error', `"${op}" expects ${typeLabel(wanted)}, got ${typeLabel(received)}`, {
    span: value.span, op, field, received: typeLabel(received), expected: typeLabel(wanted), ...repair(received),
  }));
}

/** A nullable value where a non-nullable one is wanted: offer a fallback, as a fix only when the wanted type has a zero value. */
function fallbackRepair(value: SExpr, received: TypeInfo, wanted: TypeInfo): TypeRepair {
  if (!isNullable(received) || isNullable(wanted)) return {};
  const fallback = wanted.type === 'string' || wanted.type === 'number' || wanted.type === 'boolean' || wanted.type === 'list' ? placeholderLiteral(wanted.type) : undefined;
  return {
    suggestions: ['guard with (not-null value) or use (or-else value fallback)'],
    fixes: fallback === undefined ? undefined : fixesOf(wrapFix(value.span, '(or-else ', ` ${fallback})`, `Wrap in (or-else … ${fallback})`, 'review')),
  };
}

/**
 * A non-boolean condition lowers to JavaScript truthiness, where (if items …)
 * is true for an empty list, so the repair spells out the test the author
 * meant. It is `safe` where it preserves behaviour (a number against 0, a
 * string against "", a nullable boolean defaulted to false, a nullable object
 * guarded with not-null) and `review` where it changes it (an empty list) or
 * where the exact spelling needs the operand twice (a nullable number or
 * string: `(and (not-null x) (!= x 0))`), which a wrap cannot express.
 */
function conditionRepair(test: SExpr, received: TypeInfo): TypeRepair {
  const wrap = (before: string, after: string, confidence: FixConfidence): TypeRepair =>
    ({ fixes: fixesOf(wrapFix(test.span, before, after, `Wrap in ${before}…${after}`, confidence)) });
  if (isNullable(received)) {
    switch (received.type) {
      case 'boolean':
        return wrap('(or-else ', ' false)', 'safe');
      case 'row':
      case 'record':
      case 'list':
      case 'function':
        return wrap('(not-null ', ')', 'safe');
      case 'number':
      case 'string': {
        const text = renderInline(test);
        return { suggestions: [`(and (not-null ${text}) (!= ${text} ${placeholderLiteral(received.type)}))`], ...wrap('(not-null ', ')', 'review') };
      }
      case 'unknown':
      case 'union':
        return wrap('(not-null ', ')', 'review');
      case 'null':
      case 'never':
        return {};
      default: {
        const exhaustive: never = received.type;
        throw new Error(`unhandled condition type: ${String(exhaustive)}`);
      }
    }
  }
  switch (received.type) {
    case 'number':
      return wrap('(!= ', ' 0)', 'safe');
    case 'string':
      return wrap('(!= ', ' "")', 'safe');
    case 'list':
      return wrap('(> (count ', ') 0)', 'review');
    case 'boolean':
    case 'row':
    case 'record':
    case 'function':
    case 'union':
    case 'null':
    case 'never':
    case 'unknown':
      return {};
    default: {
      const exhaustive: never = received.type;
      throw new Error(`unhandled condition type: ${String(exhaustive)}`);
    }
  }
}

/**
 * The test of if/when/cond or an operand of and/or/not: checked as an
 * expression, then held to boolean (unknown and never pass). A test whose own
 * check already failed is not reported a second time.
 */
function checkCondition(test: SExpr, scope: Scope, ctx: Ctx, op: string): void {
  const before = ctx.out.length;
  checkExpr(test, scope, ctx);
  for (let i = before; i < ctx.out.length; i += 1) if (ctx.out[i]?.severity === 'error') return;
  checkType(test, { type: 'boolean' }, scope, ctx, op, undefined, (received) => conditionRepair(test, received));
}

/** Check all possible callable signatures and specialize unannotated bodies. */
function checkInvocation(info: TypeInfo, args: TypeInfo[], node: SExpr, op: string, ctx: Ctx): void {
  if (info.type === 'union') {
    for (const member of info.members ?? []) checkInvocation(member, args, node, op, ctx);
    return;
  }
  const fn = info.callable;
  if (fn === undefined) return;
  if (fn.params.length !== args.length) {
    ctx.out.push(makeDiag('E112', 'error', `"${op}" takes ${fn.params.length} argument(s), got ${args.length}`, {
      span: node.span, nodeId: isList(node) ? node.id : undefined, op, received: String(args.length), expected: String(fn.params.length),
    }));
    return;
  }
  fn.params.forEach((expected, i) => {
    const actual = args[i] ?? { type: 'unknown' };
    if (!isAssignable(actual, expected)) ctx.out.push(makeDiag('E111', 'error', `"${op}" parameter "${fn.names[i] ?? i}" expects ${typeLabel(expected)}, got ${typeLabel(actual)}`, {
      span: node.span, nodeId: isList(node) ? node.id : undefined, op, field: fn.names[i], received: typeLabel(actual), expected: typeLabel(expected),
    }));
  });
  if (fn.name !== undefined && ctx.throwingFns.has(fn.name) && ctx.inAttempt !== true && ctx.inFn !== true) warnThrowingCall(fn.name, info, args, node, op, ctx);
  if (fn.body === undefined || fn.scope === undefined || ctx.checkingCalls?.has(fn) === true) return;
  if (!fn.params.some((param, i) => param.type === 'unknown' && args[i]?.type !== 'unknown')) return;
  const inner = new Map(fn.scope);
  fn.names.forEach((name, i) => inner.set(name, bindingFromInfo('eachvar', fn.params[i]?.type === 'unknown' ? args[i] ?? { type: 'unknown' } : fn.params[i] ?? { type: 'unknown' })));
  const checkingCalls = new Set(ctx.checkingCalls);
  checkingCalls.add(fn);
  checkExpr(fn.body, inner, { ...ctx, checkingCalls, inHandler: fn.pure === true ? false : ctx.inHandler, inFn: true });
}

/**
 * A call of a fn whose body may throw (see throwingFunctions): the fallback is
 * the caller's to choose, so W801 and its placeholder attempt wrap land on the
 * call form. A bare fn reference handed to map/filter/call is invoked by that
 * op, so it carries the warning without a wrap.
 */
function warnThrowingCall(name: string, info: TypeInfo, args: TypeInfo[], node: SExpr, op: string, ctx: Ctx): void {
  const result = inferCall(info, args, ctx.app.tables);
  const fallback = isNullable(result) ? 'null' : placeholderLiteral(result.type);
  const message = op === name
    ? `"${name}" may throw at runtime (its body has an unguarded throwing operation); wrap the call in (attempt expr fallback)`
    : `"${op}" calls "${name}", which may throw at runtime; wrap in (attempt expr fallback)`;
  ctx.out.push(
    makeDiag('W801', 'warning', message, {
      span: node.span,
      nodeId: isList(node) ? node.id : undefined,
      op,
      expected: 'an enclosing (attempt expr fallback)',
      fixes: isList(node) ? fixesOf(wrapFix(node.span, '(attempt ', ` ${fallback})`, `Wrap in (attempt … ${fallback}) (fill in)`, 'placeholder')) : undefined,
    }),
  );
}

/** `.n`, `n.`, `a..b`: a dotted path with an empty segment names nothing, so no spelling is attempted. */
function malformedReference(ident: IdentAtom, extra: { nodeId?: string; op?: string; field?: string } = {}): Diagnostic {
  return makeDiag('E201', 'error', `Malformed reference "${ident.name}": empty path segment`, {
    span: ident.span, ...extra, received: ident.name, expected: 'a name or dotted path such as item.field',
  });
}

const WHERE_ARITY: Record<string, { min: number; max?: number }> = {
  '=': { min: 2, max: 2 },
  '!=': { min: 2, max: 2 },
  '<': { min: 2, max: 2 },
  '>': { min: 2, max: 2 },
  '<=': { min: 2, max: 2 },
  '>=': { min: 2, max: 2 },
  contains: { min: 2, max: 2 },
  not: { min: 1, max: 1 },
  and: { min: 2 },
  or: { min: 2 },
};

interface EffectBinding {
  value: SExpr;
  scope: EffectScope;
}

type EffectScope = Map<string, EffectBinding | undefined>;

/**
 * Walk evaluated expressions rather than treating every list as a call: let
 * bindings and cond clauses contain expressions in their first position.
 * Follow function values as well as direct calls, keeping lexical shadows
 * and callback aliases separate from the module's imports and functions.
 */
function mayUseEffect(e: SExpr, app: AppModel, effect: 'browser' | 'async', scope?: Scope): boolean {
  const initial: EffectScope = new Map();
  for (const [name, binding] of scope ?? []) {
    if (binding.kind !== 'fn' && binding.kind !== 'js' && binding.kind !== 'enum') initial.set(name, undefined);
  }
  const visit = (expr: SExpr, locals: EffectScope, visiting: Set<string>, called = false, callArgs?: EffectBinding[]): boolean => {
    const reference = (name: string, invoked: boolean, supplied?: EffectBinding[]): boolean => {
      const head = name.split('.')[0] ?? name;
      if (locals.has(head)) {
        const alias = locals.get(head);
        return invoked && alias !== undefined ? visit(alias.value, alias.scope, visiting, true, supplied) : false;
      }
      if (BROWSER_GLOBALS.has(head)) return effect === 'browser' || invoked;
      if (effect === 'async' && invoked && app.imports.has(head)) return true;
      const fn = app.functions.get(name);
      if (fn === undefined || visiting.has(name)) return false;
      const inner = new Set(visiting);
      inner.add(name);
      return visit(fn.body, new Map(fn.params.map((param, i) => [param, supplied?.[i]])), inner, called);
    };
    if (expr.kind === 'ident') return reference(expr.name, called, callArgs);
    if (!isList(expr)) return false;
    const op = opName(expr);
    const args = expr.items.slice(1);
    if (op === 'let') {
      const bindings = args[0];
      const inner: EffectScope = new Map(locals);
      if (bindings !== undefined && isList(bindings)) {
        for (const binding of bindings.items) {
          if (!isList(binding)) continue;
          const name = binding.items[0];
          const value = binding.items[1];
          if (value === undefined) continue;
          if (visit(value, inner, visiting)) return true;
          if (name?.kind === 'ident') inner.set(name.name, { value, scope: new Map(inner) });
        }
      }
      return args.slice(1).some((arg) => visit(arg, inner, visiting, called, callArgs));
    }
    if (op === 'lambda') {
      const params = args[0];
      const inner: EffectScope = new Map(locals);
      if (params !== undefined && isList(params)) {
        params.items.forEach((param, i) => {
          if (param.kind === 'ident') inner.set(param.name, callArgs?.[i]);
        });
      }
      return args.slice(1).some((arg) => visit(arg, inner, visiting));
    }
    if (op === 'cond' || op === 'match') {
      if (op === 'match' && args[0] !== undefined && visit(args[0], locals, visiting)) return true;
      return args.slice(op === 'match' ? 1 : 0).some((clause) => {
        if (!isList(clause)) return false;
        const test = clause.items[0];
        if (op === 'cond' && test !== undefined && !(test.kind === 'ident' && test.name === 'else') && visit(test, locals, visiting)) return true;
        return clause.items.slice(1).some((value) => visit(value, locals, visiting, called));
      });
    }
    if (op === 'call') {
      const target = args[0];
      const supplied = args.slice(1).map((value) => ({ value, scope: locals }));
      if (target?.kind === 'ident' && reference(target.name, true, supplied)) return true;
      return args.slice(1).some((arg) => visit(arg, locals, visiting));
    }
    if (op !== undefined && reference(op, true, args.map((value) => ({ value, scope: locals })))) return true;
    return args.some((arg, i) => visit(arg, locals, visiting, i === 0 && op !== undefined && EXPR_OPS[op]?.fnArity !== undefined));
  };
  return visit(e, initial, new Set());
}

/** Transactions must not commit before a Promise-capable callback settles. */
function mayCallAsyncInterop(e: SExpr, app: AppModel, scope?: Scope): boolean {
  return mayUseEffect(e, app, 'async', scope);
}

/** Browser dependencies also flow through callbacks and lexical bindings. */
function mayUseBrowserGlobal(e: SExpr, app: AppModel, scope?: Scope): boolean {
  return mayUseEffect(e, app, 'browser', scope);
}

/**
 * The generated server awaits a handler's outer result. Promise-capable
 * interop is therefore safe only when it is the complete returned expression
 * (possibly through a fn that directly returns it), not nested in a DB/object
 * operation that consumes the Promise synchronously.
 */
function asyncInteropIsOuterResult(e: SExpr, app: AppModel, visiting = new Set<string>()): boolean {
  if (!isList(e)) return false;
  const op = opName(e);
  if (op === undefined) return false;
  const head = op.split('.')[0] ?? op;
  if (app.imports.has(head)) return true;
  let fnName = op;
  if (op === 'call') {
    const target = splitList(e).rest[0];
    const targetHead = target?.kind === 'ident' ? target.name.split('.')[0] : undefined;
    if (targetHead !== undefined && app.imports.has(targetHead)) return true;
    if (target?.kind !== 'ident') return false;
    fnName = target.name;
  }
  const fn = app.functions.get(fnName);
  if (fn === undefined || visiting.has(fnName)) return false;
  const inner = new Set(visiting);
  inner.add(fnName);
  return asyncInteropIsOuterResult(fn.body, app, inner);
}

/** Does a route pattern match a concrete path string? */
export function routeMatchesPath(pattern: string, path: string): boolean {
  const pSegs = pattern.split('/').filter((s) => s !== '');
  const aSegs = path.split('/').filter((s) => s !== '');
  if (pattern === '/' || path === '/') return pattern === path;
  if (pSegs.length !== aSegs.length) return false;
  return pSegs.every((seg, i) => seg.startsWith('{') || seg === aSegs[i]);
}

function checkNavTarget(target: SExpr, scope: Scope, ctx: Ctx): void {
  if (target.kind === 'string') {
    const matched = ctx.app.pages.some((p) => routeMatchesPath(p.route, target.value));
    if (!matched) {
      // Static routes only: a template with {params} is never the literal the author meant.
      const routes = ctx.app.pages.map((p) => p.route);
      const spelled = spellingFix(target.value, routes.filter((route) => !route.includes('{')), (hit) => hit, (hit, confidence) => literalFix(target, hit, confidence));
      ctx.out.push(
        makeDiag('E203', 'error', `No route matches "${target.value}"`, {
          span: target.span,
          op: 'nav',
          received: target.value,
          expected: routes.join(' | '),
          suggestions: spelled.suggestions,
          fixes: spelled.fixes,
        }),
      );
    }
    return;
  }
  if (isList(target) && opName(target) === 'path') {
    const parts = splitList(target);
    const template = parts.rest[0];
    if (template === undefined || template.kind !== 'string') {
      ctx.out.push(
        makeDiag('E104', 'error', 'path requires a template string', {
          span: target.span,
          nodeId: target.id,
          op: 'path',
          expected: '(path "/route/{param}" :param value)',
        }),
      );
      return;
    }
    const page = ctx.app.pages.find((p) => p.route === template.value);
    if (page === undefined) {
      ctx.out.push(
        makeDiag('E203', 'error', `No route with pattern "${template.value}"`, {
          span: template.span,
          nodeId: target.id,
          op: 'path',
          received: template.value,
          expected: ctx.app.pages.map((p) => p.route).join(' | '),
        }),
      );
      return;
    }
    for (const param of page.params) {
      const supplied = parts.props.get(param);
      if (supplied === undefined) {
        ctx.out.push(
          makeDiag('E206', 'error', `Route parameter ":${param}" is required by "${template.value}"`, {
            span: target.span,
            nodeId: target.id,
            op: 'path',
            field: param,
            expected: page.params.map((p) => ':' + p).join(' '),
          }),
        );
      } else {
        checkExpr(supplied.value, scope, ctx);
      }
    }
    for (const [name, entry] of parts.props) {
      if (!page.params.includes(name)) {
        const spelled = spellingFix(name, page.params, (hit) => ':' + hit, (hit, confidence) => keywordFix(entry.keyword, hit, confidence));
        ctx.out.push(
          makeDiag('E206', 'error', `":${name}" is not a parameter of "${template.value}"`, {
            span: entry.keyword.span,
            nodeId: target.id,
            op: 'path',
            field: name,
            expected: page.params.map((p) => ':' + p).join(' ') || '(no parameters)',
            suggestions: spelled.suggestions,
            fixes: spelled.fixes,
          }),
        );
      }
    }
    return;
  }
  ctx.out.push(
    makeDiag('E104', 'error', 'nav target must be a route string or a (path ...) form', {
      span: target.kind === 'list' ? target.span : target.span,
      op: 'nav',
    }),
  );
}

export function checkExpr(e: SExpr, scope: Scope, ctx: Ctx): void {
  switch (e.kind) {
    case 'string':
    case 'number':
    case 'boolean':
    case 'null':
      return;
    case 'keyword':
      ctx.out.push(
        makeDiag('E109', 'error', `Unexpected keyword ":${e.name}" in expression position`, { span: e.span }),
      );
      return;
    case 'ident': {
      const segments = e.name.split('.');
      const head = segments[0] ?? e.name;
      // Token references like $primary are validated at the property site.
      if (head.startsWith('$')) return;
      if (segments.includes('')) {
        ctx.out.push(malformedReference(e));
        return;
      }
      const binding = scope.get(head);
      if (binding === undefined) {
        // A bare enum name is never a value, so it is no candidate for one; a dotted head may still be an enum (statu.open).
        const candidates = [...scope].filter(([, info]) => segments.length > 1 || info.kind !== 'enum').map(([name]) => name);
        const spelled = spellingFix(head, candidates, (hit) => hit, (hit, confidence) => replaceIdentSegment(e, 0, hit, `Replace "${head}" with "${hit}"`, confidence));
        ctx.out.push(
          makeDiag('E201', 'error', `Unknown reference "${head}"`, {
            span: e.span,
            received: head,
            suggestions: spelled.suggestions,
            fixes: spelled.fixes,
          }),
        );
        return;
      }
      if (binding.kind === 'js') return;
      if (binding.kind === 'enum') {
        const member = segments[1];
        const values = binding.enumValues ?? [];
        if (member === undefined || segments.length !== 2 || !values.includes(member)) {
          const spelled = member === undefined || segments.length !== 2
            ? NO_SPELLING
            : spellingFix(member, values, (hit) => `${head}.${hit}`, (hit, confidence) => replaceSpan(e.span, `${head}.${hit}`, `Replace "${e.name}" with "${head}.${hit}"`, confidence));
          ctx.out.push(
            makeDiag('E812', 'error', member === undefined ? `Enum "${head}" must be read as ${head}.member` : `Enum "${head}" has no member "${member}"`, {
              span: e.span,
              received: member ?? head,
              expected: values.map((v) => `${head}.${v}`).join(' | '),
              suggestions: spelled.suggestions,
              fixes: spelled.fixes,
            }),
          );
        }
        return;
      }
      // Inspect every known path segment; nullable rows/records must be guarded.
      const start = binding.kind === 'resource' ? 2 : 1;
      for (let i = start; i < segments.length; i += 1) {
        const parentName = segments.slice(0, i).join('.');
        const parent = inferInfo({ ...e, name: parentName }, scope, ctx.app.tables);
        const field = segments[i];
        if (field === undefined) continue;
        if (isNullable(parent)) {
          ctx.out.push(makeDiag('E111', 'error', `"${parentName}" may be null; guard it before reading "${field}"`, {
            span: e.span, field, received: typeLabel(parent), expected: typeLabel(withoutNull(parent)),
            suggestions: [`(not-null ${parentName})`],
            fixes: fixesOf(wrapFix(e.span, `(if (not-null ${parentName}) `, ' null)', `Wrap in (if (not-null ${parentName}) … null) (fill in)`, 'placeholder')),
          }));
          return;
        }
        for (const alternative of parent.members ?? [parent]) {
          const table = alternative.rowTable === undefined ? undefined : ctx.app.tables.get(alternative.rowTable);
          const names = alternative.type === 'row' && table !== undefined ? table.columns.map((column) => column.name) : alternative.fields === undefined ? undefined : [...alternative.fields.keys()];
          if (names !== undefined && !names.includes(field)) {
            const spelled = spellingFix(field, names, (hit) => hit, (hit, confidence) => replaceIdentSegment(e, i, hit, `Replace "${field}" with "${hit}"`, confidence));
            ctx.out.push(makeDiag(alternative.type === 'row' ? 'E803' : 'E808', 'error', `"${parentName}" has no declared field "${field}"`, {
              span: e.span, field, received: field, expected: names.join(' | ') || '(no fields declared)', suggestions: spelled.suggestions, fixes: spelled.fixes,
            }));
            return;
          }
          if (names === undefined && alternative.type !== 'unknown' && alternative.type !== 'never' && !((alternative.type === 'string' || alternative.type === 'list') && field === 'length')) {
            ctx.out.push(makeDiag('E111', 'error', `Cannot read "${field}" from ${typeLabel(alternative)}`, { span: e.span, field, received: typeLabel(alternative), expected: 'a row or record with this field' }));
            return;
          }
        }
      }
      if (binding.kind === 'resource') {
        const field = segments[1];
        if (field === undefined) return;
        if (!RESOURCE_FIELDS.has(field)) {
          const spelled = spellingFix(field, RESOURCE_FIELDS, (hit) => `${head}.${hit}`, (hit, confidence) => replaceIdentSegment(e, 1, hit, `Replace "${field}" with "${hit}"`, confidence));
          ctx.out.push(
            makeDiag('E204', 'error', `Resource "${head}" has no field "${field}"`, {
              span: e.span,
              field,
              received: field,
              expected: 'data | loading | error',
              suggestions: spelled.suggestions,
              fixes: spelled.fixes,
            }),
          );
          return;
        }
        if (field === 'data' && !ctx.guarded.has(head)) {
          const decl = ctx.app.resources.get(head);
          if (decl !== undefined && decl.defaultValue === undefined) {
            // The default's type is the author's call (a list, a record, ...), so the stand-in is the untyped null.
            const url = splitList(decl.node).rest[1];
            ctx.out.push(
              makeDiag(
                'W301',
                'warning',
                `"${head}.data" is read without acknowledging loading/error states; guard with (if ${head}.loading ...) or declare :default`,
                {
                  span: e.span,
                  field: 'data',
                  expected: `(if ${head}.loading ...) around the read or :default on (resource ${head} ...)`,
                  fixes: fixesOf(insertPropFix(url, 'default', placeholderLiteral('unknown'), 'Add :default null (fill in)', 'placeholder')),
                },
              ),
            );
          }
        }
      }
      return;
    }
    case 'list': {
      const parts = splitList(e);
      const op = parts.op;
      if (op === undefined) {
        // Empty list is the empty-list literal; anything else is invalid.
        if (e.items.length > 0) {
          ctx.out.push(makeDiag('E109', 'error', 'Expression list must start with an operation', { span: e.span, nodeId: e.id }));
        }
        return;
      }
      if (op.name === 'path') {
        checkNavTarget(e, scope, ctx);
        return;
      }
      if (op.name === 'call') {
        checkCall(e, scope, ctx);
        return;
      }
      if (op.name === 'if') {
        checkIfExpr(e, scope, ctx);
        return;
      }
      if (op.name === 'lambda') {
        checkLambda(e, scope, ctx, undefined);
        return;
      }
      if (op.name === 'let') {
        checkLet(e, scope, ctx);
        return;
      }
      if (op.name === 'obj') {
        for (const [, entry] of parts.props) checkExpr(entry.value, scope, ctx);
        if (parts.rest.length > 0) {
          ctx.out.push(
            makeDiag('E109', 'error', 'obj takes only :key value properties', { span: e.span, nodeId: e.id, op: 'obj', expected: '(obj :name "Ada" :age 36)' }),
          );
        }
        return;
      }
      if (op.name === 'fmt') {
        checkTemplate(e, scope, ctx);
        return;
      }
      if (op.name === 't') {
        checkT(e, scope, ctx);
        return;
      }
      if (op.name === 'cond') {
        checkCond(e, scope, ctx);
        return;
      }
      if (op.name === 'match') {
        checkMatch(e, scope, ctx);
        return;
      }
      if (SERVER_OPS[op.name] !== undefined) {
        checkServerOp(e, scope, ctx);
        return;
      }
      const spec = EXPR_OPS[op.name];
      if (spec === undefined) {
        const binding = scope.get(op.name);
        // Direct call of a user fn: (subtotal cart).
        if (binding !== undefined && binding.kind === 'fn') {
          const args = e.items.slice(1);
          for (const arg of args) checkExpr(arg, scope, ctx);
          checkInvocation(bindingInfo(binding), args.map((arg) => inferInfo(arg, scope, ctx.app.tables)), e, op.name, ctx);
          return;
        }
        // Direct call of an imported JS function: (format-distance a b).
        if (binding !== undefined && binding.kind === 'js') {
          if (binding.browser === true) warnUnchecked(op.name, e, ctx);
          for (const arg of e.items.slice(1)) checkExpr(arg, scope, ctx);
          return;
        }
        // Candidates are what this position accepts: stdlib ops, the special forms, and the callable bindings in scope.
        const callables = [...scope].filter(([, info]) => info.kind === 'fn' || info.kind === 'js').map(([name]) => name);
        const spelled = spellingFix(op.name, [...Object.keys(EXPR_OPS), ...EXPR_FORMS, ...callables], (hit) => hit, (hit, confidence) => renameHeadFix(e, hit, confidence));
        ctx.out.push(
          makeDiag('E109', 'error', `"${op.name}" is not an expression operation`, {
            span: e.span,
            nodeId: e.id,
            op: op.name,
            expected: [...Object.keys(EXPR_OPS), ...EXPR_FORMS].join(' '),
            suggestions: spelled.suggestions,
            fixes: spelled.fixes,
          }),
        );
        return;
      }
      const args = e.items.slice(1);
      if (spec.fnArity !== undefined) {
        // Type the lambda parameter from the consumed list's element type:
        // (filter (lambda (w) w.done) wishes.data) gives w the row type.
        const listIdx = op.name === 'reduce' ? 2 : 1;
        const listArg = args[listIdx];
        const listType = listArg !== undefined ? inferInfo(listArg, scope, ctx.app.tables) : { type: 'unknown' as const };
        if (listArg !== undefined) checkType(listArg, { type: 'list', nullable: true }, scope, ctx, op.name);
        const elemInfo = bindingFromInfo('eachvar', elementInfo(listType));
        const initial = args[1] === undefined ? undefined : bindingFromInfo('eachvar', inferInfo(args[1], scope, ctx.app.tables));
        const paramInfos: (VarInfo | undefined)[] = op.name === 'reduce' ? [initial, elemInfo] : [elemInfo];
        const f = args[0];
        if (f !== undefined) checkFnValue(f, spec.fnArity, op.name, scope, ctx, paramInfos);
        for (const arg of args.slice(1)) checkExpr(arg, scope, ctx);
        if (args.length < spec.minArity || (spec.maxArity !== undefined && args.length > spec.maxArity)) {
          ctx.out.push(
            makeDiag('E112', 'error', `"${op.name}" expects ${spec.minArity} arguments, got ${args.length}`, {
              span: e.span,
              nodeId: e.id,
              op: op.name,
              received: String(args.length),
            }),
          );
        }
        return;
      }
      if (args.length < spec.minArity || (spec.maxArity !== undefined && args.length > spec.maxArity)) {
        ctx.out.push(
          makeDiag('E109', 'error', `"${op.name}" expects ${spec.minArity}${spec.maxArity === undefined ? '+' : spec.maxArity === spec.minArity ? '' : `..${spec.maxArity}`} arguments, got ${args.length}`, {
            span: e.span,
            nodeId: e.id,
            op: op.name,
            received: String(args.length),
          }),
        );
      }
      let argScope = scope;
      for (const [i, arg] of args.entries()) {
        // The first operand of attempt runs inside its try; a throw there is the documented path.
        const argCtx = op.name === 'attempt' && i === 0 ? { ...ctx, inAttempt: true } : ctx;
        if (op.name === 'and' || op.name === 'or' || op.name === 'not') checkCondition(arg, argScope, argCtx, op.name);
        else checkExpr(arg, argScope, argCtx);
        if (op.name === 'and' || op.name === 'or') argScope = narrowScope(arg, argScope, op.name === 'and', ctx.app.tables);
      }
      if (NUMERIC_OPS.has(op.name)) for (const arg of args) checkType(arg, { type: 'number' }, scope, ctx, op.name);
      checkStdlibInputs(e, scope, ctx);
      if (spec.throws === true) checkThrowingOp(e, scope, ctx);
      return;
    }
    default: {
      const exhaustive: never = e;
      throw new Error(`unhandled node kind: ${String(exhaustive)}`);
    }
  }
}

/** (if cond then else) in expression position: a value-producing ternary. */
function checkIfExpr(e: ListNode, scope: Scope, ctx: Ctx): void {
  const args = e.items.slice(1);
  if (args.length !== 3) {
    ctx.out.push(
      makeDiag('E109', 'error', 'if-expression requires exactly (if cond then else)', {
        span: e.span,
        nodeId: e.id,
        op: 'if',
        received: String(args.length),
        expected: '(if cond then else)',
      }),
    );
  }
  if (args[0] !== undefined) checkCondition(args[0], scope, ctx, 'if');
  for (let i = 1; i < args.length; i += 1) {
    const arg = args[i];
    if (arg !== undefined) checkExpr(arg, args[0] === undefined ? scope : narrowScope(args[0], scope, i === 1, ctx.app.tables), ctx);
  }
}

function checkLexicalBinding(
  name: string,
  binding: SExpr,
  owner: ListNode,
  kind: string,
  seen: Map<string, string>,
  ctx: Ctx,
): boolean {
  if (!validBindingName(name)) {
    ctx.out.push(
      makeDiag('E104', 'error', `Invalid ${kind} name "${name}"`, {
        span: binding.span,
        nodeId: owner.id,
        op: kind,
        received: name,
        expected: 'lowercase kebab-case name that is safe as a JavaScript binding',
      }),
    );
    return false;
  }
  const generated = camelCase(name);
  const previous = seen.get(generated);
  if (previous !== undefined) {
    ctx.out.push(
      makeDiag('E107', 'error', `Binding "${name}" collides with "${previous}" after JavaScript name generation`, {
        span: binding.span,
        nodeId: owner.id,
        op: kind,
        received: name,
        expected: `a unique name that does not generate "${generated}"`,
      }),
    );
    return false;
  }
  seen.set(generated, name);
  return true;
}

/** (lambda (params...) body). expectedArity comes from the consuming op. */
function checkLambda(e: ListNode, scope: Scope, ctx: Ctx, expectedArity: number | undefined, paramInfos?: (VarInfo | undefined)[]): void {
  const paramList = e.items[1];
  const body = e.items[2];
  if (paramList === undefined || !isList(paramList) || body === undefined || e.items.length !== 3) {
    ctx.out.push(
      makeDiag('E109', 'error', 'lambda requires a parameter list and one body expression: (lambda (x) expr)', {
        span: e.span,
        nodeId: e.id,
        op: 'lambda',
        expected: '(lambda (x) (* x 2))',
      }),
    );
    return;
  }
  const inner: Scope = new Map(scope);
  const params: string[] = [];
  const generatedParams = new Map<string, string>();
  for (const p of paramList.items) {
    if (p.kind !== 'ident') {
      ctx.out.push(makeDiag('E109', 'error', 'lambda parameters must be identifiers', { span: p.span, nodeId: e.id, op: 'lambda' }));
      return;
    }
    if (!checkLexicalBinding(p.name, p, e, 'lambda parameter', generatedParams, ctx)) return;
    inner.set(p.name, paramInfos?.[params.length] ?? { kind: 'eachvar' });
    params.push(p.name);
  }
  if (expectedArity !== undefined && params.length !== expectedArity) {
    ctx.out.push(
      makeDiag('E112', 'error', `This lambda must take ${expectedArity} parameter(s), got ${params.length}`, {
        span: paramList.span,
        nodeId: e.id,
        op: 'lambda',
        received: String(params.length),
        expected: String(expectedArity),
      }),
    );
  }
  checkExpr(body, inner, ctx);
}

/** (let ((x e1) (y e2)) body) — sequential bindings. */
function checkLet(e: ListNode, scope: Scope, ctx: Ctx): void {
  const bindingList = e.items[1];
  const body = e.items[2];
  if (bindingList === undefined || !isList(bindingList) || body === undefined || e.items.length !== 3) {
    ctx.out.push(
      makeDiag('E109', 'error', 'let requires a binding list and one body expression: (let ((x 1)) expr)', {
        span: e.span,
        nodeId: e.id,
        op: 'let',
        expected: '(let ((x 1) (y 2)) (+ x y))',
      }),
    );
    return;
  }
  const inner: Scope = new Map(scope);
  const generatedBindings = new Map<string, string>();
  for (const b of bindingList.items) {
    const name = isList(b) ? b.items[0] : undefined;
    const value = isList(b) ? b.items[1] : undefined;
    if (!isList(b) || name === undefined || name.kind !== 'ident' || value === undefined || b.items.length !== 2) {
      ctx.out.push(
        makeDiag('E109', 'error', 'let bindings must be (name expr) pairs', {
          span: b.span,
          nodeId: e.id,
          op: 'let',
        }),
      );
      return;
    }
    if (!checkLexicalBinding(name.name, name, e, 'let binding', generatedBindings, ctx)) return;
    checkExpr(value, inner, ctx);
    const info = inferInfo(value, inner, ctx.app.tables);
    inner.set(name.name, bindingFromInfo('eachvar', info));
  }
  checkExpr(body, inner, ctx);
}

/** (fmt "Hi {name}" :name expr): every placeholder needs a matching prop. */
function checkTemplate(e: ListNode, scope: Scope, ctx: Ctx): void {
  const parts = splitList(e);
  const template = parts.rest[0];
  if (template === undefined || template.kind !== 'string' || parts.rest.length !== 1) {
    ctx.out.push(
      makeDiag('E109', 'error', 'fmt requires a template string: (fmt "Hi {name}" :name expr)', {
        span: e.span,
        nodeId: e.id,
        op: 'fmt',
      }),
    );
    return;
  }
  const placeholders = [...template.value.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]).filter((p): p is string => p !== undefined);
  for (const p of placeholders) {
    if (!parts.props.has(p)) {
      ctx.out.push(
        makeDiag('E206', 'error', `Template placeholder "{${p}}" has no matching :${p} property`, {
          span: template.span,
          nodeId: e.id,
          op: 'fmt',
          field: p,
          expected: placeholders.map((x) => ':' + x).join(' '),
          fixes: fixesOf(insertPropFix(template, p, placeholderLiteral('string'), `Add :${p} (fill in)`, 'placeholder')),
        }),
      );
    }
  }
  for (const [name, entry] of parts.props) {
    if (!placeholders.includes(name)) {
      const spelled = spellingFix(name, placeholders, (hit) => ':' + hit, (hit, confidence) => keywordFix(entry.keyword, hit, confidence));
      ctx.out.push(
        makeDiag('E206', 'error', `":${name}" does not appear in the template`, {
          span: entry.keyword.span,
          nodeId: e.id,
          op: 'fmt',
          field: name,
          suggestions: spelled.suggestions,
          fixes: spelled.fixes,
        }),
      );
    }
    checkExpr(entry.value, scope, ctx);
  }
}

/** (t msg-key :param expr ...): key must exist in the default locale. */
function checkT(e: ListNode, scope: Scope, ctx: Ctx): void {
  const parts = splitList(e);
  const key = parts.rest[0];
  if (key === undefined || key.kind !== 'ident' || parts.rest.length !== 1) {
    ctx.out.push(
      makeDiag('E814', 'error', 't requires a message key: (t greeting :name x)', { span: e.span, nodeId: e.id, op: 't' }),
    );
    return;
  }
  const defaultLocale = ctx.app.defaultLocale;
  const messages = defaultLocale !== undefined ? ctx.app.locales.get(defaultLocale) : undefined;
  if (messages === undefined) {
    ctx.out.push(
      makeDiag('E814', 'error', '(t ...) requires an (i18n ...) declaration with at least one locale', {
        span: e.span,
        nodeId: e.id,
        op: 't',
      }),
    );
    return;
  }
  const template = messages.get(key.name);
  if (template === undefined) {
    const spelled = spellingFix(key.name, messages.keys(), (hit) => hit, (hit, confidence) => replaceSpan(key.span, hit, `Replace "${key.name}" with "${hit}"`, confidence));
    ctx.out.push(
      makeDiag('E814', 'error', `Unknown message key "${key.name}"`, {
        span: key.span,
        nodeId: e.id,
        op: 't',
        received: key.name,
        expected: [...messages.keys()].join(' | ') || '(no messages declared)',
        suggestions: spelled.suggestions,
        fixes: spelled.fixes,
      }),
    );
    return;
  }
  const placeholders = [...template.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]).filter((p): p is string => p !== undefined);
  for (const p of placeholders) {
    if (!parts.props.has(p)) {
      ctx.out.push(
        makeDiag('E206', 'error', `Message "${key.name}" needs :${p} for its "{${p}}" placeholder`, {
          span: e.span,
          nodeId: e.id,
          op: 't',
          field: p,
          expected: placeholders.map((x) => ':' + x).join(' '),
          fixes: fixesOf(insertPropFix(key, p, placeholderLiteral('string'), `Add :${p} (fill in)`, 'placeholder')),
        }),
      );
    }
  }
  for (const [name, entry] of parts.props) {
    if (!placeholders.includes(name)) {
      const spelled = spellingFix(name, placeholders, (hit) => ':' + hit, (hit, confidence) => keywordFix(entry.keyword, hit, confidence));
      ctx.out.push(
        makeDiag('E206', 'error', `":${name}" does not appear in message "${key.name}"`, {
          span: entry.keyword.span,
          nodeId: e.id,
          op: 't',
          field: name,
          suggestions: spelled.suggestions,
          fixes: spelled.fixes,
        }),
      );
    }
    checkExpr(entry.value, scope, ctx);
  }
}

/** (cond (test value)... (else value)) — first truthy test wins. */
function checkCond(e: ListNode, scope: Scope, ctx: Ctx): void {
  const clauses = e.items.slice(1);
  let inner = scope;
  clauses.forEach((clause, i) => {
    const isLast = i === clauses.length - 1;
    if (!isList(clause) || clause.items.length !== 2) {
      ctx.out.push(
        makeDiag('E109', 'error', 'cond clauses must be (test value) pairs, optionally ending with (else value)', {
          span: clause.span,
          nodeId: e.id,
          op: 'cond',
          expected: '(cond ((< x 5) "low") (else "high"))',
        }),
      );
      return;
    }
    const test = clause.items[0];
    const value = clause.items[1];
    if (test !== undefined && test.kind === 'ident' && test.name === 'else') {
      if (!isLast) {
        ctx.out.push(makeDiag('E109', 'error', '(else ...) must be the last cond clause', { span: clause.span, nodeId: e.id, op: 'cond' }));
      }
    } else if (test !== undefined) {
      checkCondition(test, inner, ctx, 'cond');
    }
    if (value !== undefined) checkExpr(value, test === undefined ? inner : narrowScope(test, inner, true, ctx.app.tables), ctx);
    if (test !== undefined) inner = narrowScope(test, inner, false, ctx.app.tables);
  });
}

/** (match x (literal value)... (else value)); exhaustive over enum-typed x. */
function checkMatch(e: ListNode, scope: Scope, ctx: Ctx): void {
  const scrutinee = e.items[1];
  const clauses = e.items.slice(2);
  if (scrutinee === undefined || clauses.length === 0) {
    ctx.out.push(
      makeDiag('E815', 'error', 'match requires a value and at least one (literal value) clause', {
        span: e.span,
        nodeId: e.id,
        op: 'match',
        expected: '(match status ("open" "Open") (else "Done"))',
      }),
    );
    return;
  }
  checkExpr(scrutinee, scope, ctx);
  const covered: string[] = [];
  let hasElse = false;
  clauses.forEach((clause, i) => {
    if (!isList(clause) || clause.items.length !== 2) {
      ctx.out.push(
        makeDiag('E815', 'error', 'match clauses must be (literal value) pairs or a final (else value)', {
          span: clause.span,
          nodeId: e.id,
          op: 'match',
        }),
      );
      return;
    }
    const pattern = clause.items[0];
    const value = clause.items[1];
    if (pattern !== undefined && pattern.kind === 'ident' && pattern.name === 'else') {
      hasElse = true;
      if (i !== clauses.length - 1) {
        ctx.out.push(makeDiag('E815', 'error', '(else ...) must be the last match clause', { span: clause.span, nodeId: e.id, op: 'match' }));
      }
    } else if (pattern !== undefined && (pattern.kind === 'string' || pattern.kind === 'number' || pattern.kind === 'boolean')) {
      if (pattern.kind === 'string') covered.push(pattern.value);
    } else if (pattern !== undefined && pattern.kind === 'ident') {
      // Enum member patterns: (match s (status.open "Open") ...).
      const segments = pattern.name.split('.');
      const [head, member] = segments;
      const decl = head !== undefined ? ctx.app.enums.get(head) : undefined;
      if (decl !== undefined && member !== undefined && segments.length === 2 && decl.values.includes(member)) {
        covered.push(member);
      } else {
        // A two-segment pattern is a near-miss of an enum read: re-spell the member against the enum, or the head against the enums.
        const spelled = segments.length !== 2 || head === undefined || head === '' || member === undefined || member === ''
          ? NO_SPELLING
          : decl !== undefined
            ? spellingFix(member, decl.values, (hit) => `${head}.${hit}`, (hit, confidence) => replaceSpan(pattern.span, `${head}.${hit}`, `Replace "${pattern.name}" with "${head}.${hit}"`, confidence))
            : spellingFix(head, ctx.app.enums.keys(), (hit) => `${hit}.${member}`, (hit, confidence) => replaceSpan(pattern.span, `${hit}.${member}`, `Replace "${pattern.name}" with "${hit}.${member}"`, confidence));
        ctx.out.push(
          makeDiag('E815', 'error', 'match patterns must be literals, enum members, or else', {
            span: pattern.span,
            nodeId: e.id,
            op: 'match',
            received: pattern.name,
            ...(decl === undefined ? {} : { expected: decl.values.map((v) => `${head}.${v}`).join(' | ') }),
            suggestions: spelled.suggestions,
            fixes: spelled.fixes,
          }),
        );
      }
    } else if (pattern !== undefined) {
      ctx.out.push(
        makeDiag('E815', 'error', 'match patterns must be literals, enum members, or else', { span: pattern.span, nodeId: e.id, op: 'match' }),
      );
    }
    if (value !== undefined) checkExpr(value, scope, ctx);
  });
  // Exhaustiveness over enum-typed scrutinees.
  if (!hasElse && scrutinee.kind === 'ident') {
    const binding = scope.get(scrutinee.name.split('.')[0] ?? scrutinee.name);
    const enumName = binding?.enumName;
    const decl = enumName !== undefined ? ctx.app.enums.get(enumName) : undefined;
    if (decl !== undefined) {
      const missing = decl.values.filter((v) => !covered.includes(v));
      if (missing.length > 0) {
        ctx.out.push(
          makeDiag('E815', 'error', `match over enum "${decl.name}" is missing: ${missing.join(', ')}`, {
            span: e.span,
            nodeId: e.id,
            op: 'match',
            expected: decl.values.join(' | '),
            received: covered.join(' '),
            suggestions: missing.map((m) => `(${decl.name}.${m} ...)`),
            // No (else ...) clause exists here, so the arms go before the closing paren.
            fixes: fixesOf(appendChildFix(e, missing.map((m) => `(${decl.name}.${m} null)`).join(' '), 'Add missing match arms (fill in)', 'placeholder')),
          }),
        );
      }
    }
  }
}

/** A function-valued argument, with contextual list/accumulator parameter types. */
function checkFnValue(f: SExpr, arity: number, opLabel: string, scope: Scope, ctx: Ctx, paramInfos?: (VarInfo | undefined)[]): void {
  if (isList(f) && opName(f) === 'lambda') {
    checkLambda(f, scope, ctx, arity, paramInfos);
    return;
  }
  checkExpr(f, scope, ctx);
  const info = inferInfo(f, scope, ctx.app.tables);
  if (!isCallable(info)) {
    ctx.out.push(makeDiag('E109', 'error', `"${opLabel}" expects a function as its first argument`, {
      span: f.span, op: opLabel, received: typeLabel(info), expected: '(lambda (x) ...) or a fn name',
    }));
    return;
  }
  const args = Array.from({ length: arity }, (_, i) => paramInfos?.[i] === undefined ? { type: 'unknown' as const } : bindingInfo(paramInfos[i]!));
  checkInvocation(info, args, f, opLabel, ctx);
}

/** Operations that consume lists keep the runtime's null-as-empty convention. */
function checkStdlibInputs(e: ListNode, scope: Scope, ctx: Ctx): void {
  const op = opName(e) ?? '?';
  const args = e.items.slice(1);
  const spec = EXPR_OPS[op];
  args.forEach((arg, i) => {
    const type = spec?.inputs?.[i] ?? (spec?.variadicInput === true ? spec.inputs?.at(-1) : undefined);
    if (type === undefined || type === 'any') return;
    if (type === 'record') {
      const actual = inferInfo(arg, scope, ctx.app.tables);
      // Typed database rows are records too.
      if (actual.type === 'row' && !isNullable(actual)) return;
    }
    checkType(arg, { type, nullable: type === 'list' }, scope, ctx, op);
  });
  const listIndexes: Record<string, number> = { join: 1, reverse: 0, take: 1, drop: 1, nth: 1, first: 0, last: 0, append: 0, sum: 0 };
  const listIndex = listIndexes[op];
  if (listIndex !== undefined && args[listIndex] !== undefined) checkType(args[listIndex], { type: 'list', nullable: true }, scope, ctx, op);
  const numericIndexes: Record<string, number[]> = { range: [0, 1], take: [0], drop: [0], nth: [0], slice: [0, 1] };
  for (const i of numericIndexes[op] ?? []) if (args[i] !== undefined) checkType(args[i], { type: 'number' }, scope, ctx, op);
  if (op === 'slice' && args[2] !== undefined) checkType(args[2], { type: 'union', members: [{ type: 'string' }, { type: 'list' }] }, scope, ctx, op);
  if ((op === 'count' || op === 'contains') && args[0] !== undefined) checkType(args[0], { type: 'union', members: [{ type: 'string' }, { type: 'list' }], nullable: op === 'count' }, scope, ctx, op);
}

type Literal = StringAtom | NumberAtom | BooleanAtom | NullAtom;

function isLiteral(e: SExpr): e is Literal {
  return e.kind === 'string' || e.kind === 'number' || e.kind === 'boolean' || e.kind === 'null';
}

/** A literal operand a throwing op can never accept. */
interface LiteralFault {
  span: Span;
  message: string;
  received: string;
  expected: string;
}

/** A faulty literal, `'dynamic'` when a deciding operand is only known at runtime, or undefined when the literals pass. */
type LiteralVerdict = LiteralFault | 'dynamic' | undefined;

/** The engine's reason, without V8's "Invalid regular expression: /pattern/flags: " echo of a literal the diagnostic already quotes. */
function faultReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^Invalid regular expression: \/.*\/[a-z]*: /, '');
}

/**
 * Verifies the operands that decide whether a throwing op throws (the text of
 * json-parse and url-decode, the size of chunk, the epoch of date-iso, the
 * pattern and flags of the regex ops) by running the op's own builtin over the
 * literal ones. That validates a literal; no user code runs. `'dynamic'` means
 * a deciding operand is only known at runtime; `undefined` means the literals
 * passed, or the input contract already rejected their kind.
 */
function verifyThrowingLiterals(op: string, args: SExpr[]): LiteralVerdict {
  const trying = (run: () => unknown, span: Span, label: string, received: string, expected: string): LiteralFault | undefined => {
    try {
      run();
      return undefined;
    } catch (error) {
      return { span, message: `${label}: ${faultReason(error)}`, received, expected };
    }
  };
  if (op === 'regex-test' || op === 'regex-find' || op === 'regex-replace') {
    // Flags are valid or not whatever the pattern, so a literal flags operand is verified on its own and the fault
    // points at it; a pattern's validity depends on the flags (u/v mode parses escapes differently), so the pattern
    // is verified only when both are literal.
    const pattern = args[0];
    const flagsArg = args[op === 'regex-replace' ? 3 : 2];
    if (flagsArg !== undefined && isLiteral(flagsArg)) {
      if (flagsArg.kind !== 'string') return undefined;
      const badFlags = trying(() => new RegExp('', flagsArg.value), flagsArg.span, 'invalid regular expression', flagsArg.value, 'RegExp flags');
      if (badFlags !== undefined) return badFlags;
    }
    if ((pattern !== undefined && !isLiteral(pattern)) || (flagsArg !== undefined && !isLiteral(flagsArg))) return 'dynamic';
    if (pattern?.kind !== 'string') return undefined;
    const flags = flagsArg?.kind === 'string' ? flagsArg.value : op === 'regex-replace' ? 'g' : '';
    return trying(() => new RegExp(pattern.value, flags), pattern.span, 'invalid regular expression', pattern.value, 'valid regular expression');
  }
  const first = args[0];
  if (first !== undefined && !isLiteral(first)) return 'dynamic';
  switch (op) {
    case 'json-parse':
      return first?.kind === 'string' ? trying(() => JSON.parse(first.value), first.span, 'invalid JSON literal', first.value, 'valid JSON') : undefined;
    case 'url-decode':
      return first?.kind === 'string'
        ? trying(() => decodeURIComponent(first.value), first.span, 'invalid URL component literal', first.value, 'percent-encoded URL component')
        : undefined;
    case 'date-iso':
      return first?.kind === 'number'
        ? trying(() => new Date(first.value).toISOString(), first.span, 'invalid date literal', String(first.value), 'epoch milliseconds within ±8.64e15')
        : undefined;
    case 'chunk':
      return first?.kind === 'number' && !(Number.isSafeInteger(first.value) && first.value > 0)
        ? { span: first.span, message: 'invalid chunk size: must be a positive integer', received: String(first.value), expected: 'positive integer' }
        : undefined;
    default:
      return undefined;
  }
}

/** The verdict for one throwing-op node, computed once per check() run however many call-site specialisations revisit it. */
function literalVerdict(e: ListNode, verdicts: Map<ListNode, LiteralVerdict>): LiteralVerdict {
  if (verdicts.has(e)) return verdicts.get(e);
  const verdict = verifyThrowingLiterals(opName(e) ?? '?', e.items.slice(1));
  verdicts.set(e, verdict);
  return verdict;
}

/**
 * The declared fns that may throw to their caller: a body with a throwing op
 * whose deciding operands are dynamic outside the guarded operand of attempt,
 * or a reference to another such fn, resolved to a fixpoint so declaration
 * order and recursion do not matter. References are matched by name, so a
 * local that shadows a fn name counts as one. The body itself stays quiet
 * (the fallback is the caller's to choose); checkInvocation warns at the call.
 */
function throwingFunctions(app: AppModel, verdicts: Map<ListNode, LiteralVerdict>): Set<string> {
  const throwing = new Set<string>();
  const references = new Map<string, Set<string>>();
  for (const [name, decl] of app.functions) {
    const referenced = new Set<string>();
    const walk = (e: SExpr, guarded: boolean): void => {
      if (e.kind === 'ident') {
        const head = e.name.split('.')[0] ?? e.name;
        if (app.functions.has(head)) referenced.add(head);
        return;
      }
      if (!isList(e)) return;
      const op = opName(e);
      if (op !== undefined && EXPR_OPS[op]?.throws === true && !guarded && literalVerdict(e, verdicts) === 'dynamic') throwing.add(name);
      e.items.forEach((item, i) => walk(item, guarded || (op === 'attempt' && i === 1)));
    };
    walk(decl.body, false);
    references.set(name, referenced);
  }
  for (let changed = true; changed; ) {
    changed = false;
    for (const [name, referenced] of references) {
      if (throwing.has(name) || ![...referenced].some((callee) => throwing.has(callee))) continue;
      throwing.add(name);
      changed = true;
    }
  }
  return throwing;
}

/**
 * An op the schema marks `throws`: literal deciding operands are verified now
 * and a bad one is E109; dynamic ones get W801 with a placeholder attempt
 * wrap, unless the context absorbs the throw (the guarded operand of attempt,
 * a fn body, a test expression). The fallback is the natural zero value of
 * the result type, and null where the result is nullable anyway.
 */
function checkThrowingOp(e: ListNode, scope: Scope, ctx: Ctx): void {
  const op = opName(e) ?? '?';
  const verdict = literalVerdict(e, ctx.literalVerdicts);
  if (verdict === undefined) return;
  if (verdict !== 'dynamic') {
    ctx.out.push(makeDiag('E109', 'error', verdict.message, { span: verdict.span, nodeId: e.id, op, received: verdict.received, expected: verdict.expected }));
    return;
  }
  if (ctx.inAttempt === true || ctx.inFn === true) return;
  const result = inferInfo(e, scope, ctx.app.tables);
  const fallback = isNullable(result) ? 'null' : placeholderLiteral(result.type);
  ctx.out.push(
    makeDiag('W801', 'warning', `"${op}" may throw at runtime; wrap in (attempt expr fallback)`, {
      span: e.span,
      nodeId: e.id,
      op,
      expected: 'literal operands or an enclosing (attempt expr fallback)',
      fixes: fixesOf(wrapFix(e.span, '(attempt ', ` ${fallback})`, `Wrap in (attempt … ${fallback}) (fill in)`, 'placeholder')),
    }),
  );
}

/** A (select :where ...) expression: comparisons over columns and JS values. */
function checkWhere(e: SExpr, table: TableDecl, scope: Scope, ctx: Ctx): void {
  if (e.kind === 'ident') {
    // Bare idents that are column names reference the column; anything else
    // is an ordinary value expression evaluated in the handler.
    if (table.columns.some((c) => c.name === e.name)) return;
    if (!e.name.includes('.') && !e.name.startsWith('$') && scope.get(e.name) === undefined) {
      // Unknown everywhere: most likely a misspelt column, so the columns join the handler bindings as candidates.
      const columns = table.columns.map((c) => c.name);
      const bindings = [...scope].filter(([, info]) => info.kind !== 'enum').map(([name]) => name);
      const spelled = spellingFix(e.name, [...columns, ...bindings], (hit) => hit, (hit, confidence) => replaceSpan(e.span, hit, `Replace "${e.name}" with "${hit}"`, confidence));
      ctx.out.push(
        makeDiag('E201', 'error', `Unknown reference "${e.name}"`, {
          span: e.span,
          op: 'select',
          received: e.name,
          expected: columns.join(' | '),
          suggestions: spelled.suggestions,
          fixes: spelled.fixes,
        }),
      );
      return;
    }
    checkExpr(e, scope, ctx);
    return;
  }
  if (!isList(e)) return;
  const op = opName(e);
  if (op === undefined || !WHERE_OPS.has(op)) {
    ctx.out.push(
      makeDiag('E811', 'error', `":where" supports ${[...WHERE_OPS].join(' ')} over columns and values`, {
        span: e.span,
        nodeId: e.id,
        op: 'select',
        received: op,
        expected: [...WHERE_OPS].join(' | '),
      }),
    );
    return;
  }
  const args = e.items.slice(1);
  const arity = WHERE_ARITY[op];
  if (arity !== undefined && (args.length < arity.min || (arity.max !== undefined && args.length > arity.max))) {
    const expected = arity.max === arity.min ? `${arity.min}` : `${arity.min} or more`;
    ctx.out.push(
      makeDiag('E811', 'error', `":where" operator "${op}" expects ${expected} operand${arity.min === 1 ? '' : 's'}, got ${args.length}`, {
        span: e.span,
        nodeId: e.id,
        op: 'select',
        received: String(args.length),
        expected,
      }),
    );
    return;
  }
  for (const arg of args) checkWhere(arg, table, scope, ctx);
}

/** select/insert/update/delete-row/fail/tx: server-only handler operations. */
function checkServerOp(e: ListNode, scope: Scope, ctx: Ctx): void {
  const op = opName(e) ?? '?';
  if (ctx.inHandler !== true) {
    ctx.out.push(
      makeDiag('E805', 'error', `"${op}" is a server operation; it can only appear inside an (api ...) handler`, {
        span: e.span,
        nodeId: e.id,
        op,
        expected: 'use (send ...) and (refresh ...) from the client',
      }),
    );
    return;
  }
  if (ctx.routeMethod === 'get' && DB_MUTATION_OPS.has(op)) {
    ctx.out.push(
      makeDiag('E805', 'error', `Database mutation "${op}" is not allowed in a GET handler`, {
        span: e.span,
        nodeId: e.id,
        op,
        expected: 'use a POST, PUT, or DELETE api route for database mutations',
      }),
    );
    return;
  }
  const parts = splitList(e);
  if (parts.danglingKeyword !== undefined) {
    ctx.out.push(danglingKeywordDiag(parts.danglingKeyword, e.id, op));
    return;
  }
  if (op === 'fail') {
    const status = parts.rest[0];
    const message = parts.rest[1];
    if (status === undefined || status.kind !== 'number' || !Number.isInteger(status.value) || status.value < 400 || status.value > 599 || message === undefined || parts.rest.length !== 2) {
      ctx.out.push(
        makeDiag('E805', 'error', 'fail requires an integer error status (400–599) and a message: (fail 404 "not found")', {
          span: e.span,
          nodeId: e.id,
          op: 'fail',
          expected: '(fail 400 "invalid request")',
        }),
      );
      return;
    }
    checkExpr(message, scope, ctx);
    return;
  }
  if (op === 'tx') {
    const body = parts.rest[0];
    if (body === undefined || parts.rest.length !== 1) {
      ctx.out.push(
        makeDiag('E805', 'error', 'tx requires exactly one expression: (tx expr)', { span: e.span, nodeId: e.id, op: 'tx' }),
      );
      return;
    }
    if (ctx.inTransaction === true) {
      ctx.out.push(
        makeDiag('E805', 'error', 'Nested tx forms are not supported by the generated SQLite transaction runtime', {
          span: e.span,
          nodeId: e.id,
          op: 'tx',
          expected: 'one outer (tx ...) around the database operations',
        }),
      );
      return;
    }
    if (mayCallAsyncInterop(body, ctx.app, scope)) {
      ctx.out.push(
        makeDiag('E805', 'error', 'tx cannot contain JavaScript interop because it may be asynchronous', {
          span: body.span,
          nodeId: e.id,
          op: 'tx',
          expected: 'use only synchronous GRHM expressions and database operations inside tx',
        }),
      );
    }
    checkExpr(body, scope, { ...ctx, inTransaction: true });
    return;
  }
  const tableAtom = parts.rest[0];
  if (tableAtom === undefined || tableAtom.kind !== 'ident') {
    ctx.out.push(
      makeDiag('E805', 'error', `${op} requires a table name in the first position`, {
        span: e.span,
        nodeId: e.id,
        op,
        expected: `(${op} table ...)`,
      }),
    );
    return;
  }
  const table = ctx.app.tables.get(tableAtom.name);
  if (table === undefined) {
    const spelled = spellingFix(tableAtom.name, ctx.app.tables.keys(), (hit) => hit, (hit, confidence) => replaceSpan(tableAtom.span, hit, `Replace "${tableAtom.name}" with "${hit}"`, confidence));
    ctx.out.push(
      makeDiag('E802', 'error', `Unknown table "${tableAtom.name}"`, {
        span: tableAtom.span,
        nodeId: e.id,
        op,
        received: tableAtom.name,
        suggestions: spelled.suggestions,
        fixes: spelled.fixes,
      }),
    );
    return;
  }
  const columnNames = new Set(table.columns.map((c) => c.name));
  const needsId = op === 'update' || op === 'delete-row';
  if (needsId && !parts.props.has('id')) {
    ctx.out.push(
      makeDiag('E805', 'error', `${op} requires an :id`, {
        span: e.span,
        nodeId: e.id,
        op,
        field: 'id',
        expected: `(${op} ${table.name} :id expr ...)`,
      }),
    );
  }
  if (op === 'insert') {
    for (const col of table.columns) {
      if (col.type === 'auto' || col.optional || col.defaultValue !== undefined) continue;
      if (!parts.props.has(col.name)) {
        ctx.out.push(
          makeDiag('E810', 'error', `insert into "${table.name}" is missing required column ":${col.name}"`, {
            span: e.span,
            nodeId: e.id,
            op: 'insert',
            field: col.name,
            expected: table.columns.filter((c) => c.type !== 'auto' && !c.optional && c.defaultValue === undefined).map((c) => ':' + c.name).join(' '),
            fixes: fixesOf(insertPropFix(tableAtom, col.name, placeholderLiteral(col.type), `Add :${col.name} (fill in)`, 'placeholder')),
          }),
        );
      }
    }
  }
  for (const [name, entry] of parts.props) {
    if (name === 'id' && needsId) {
      checkExpr(entry.value, scope, ctx);
      continue;
    }
    if (op === 'select') {
      if (!SELECT_PROPS.has(name)) {
        const spelled = spellingFix(name, SELECT_PROPS, (hit) => ':' + hit, (hit, confidence) => keywordFix(entry.keyword, hit, confidence));
        ctx.out.push(
          makeDiag('E805', 'error', `select does not take a ":${name}" property`, {
            span: entry.keyword.span,
            nodeId: e.id,
            op,
            field: name,
            expected: [...SELECT_PROPS].map((p) => ':' + p).join(' '),
            suggestions: spelled.suggestions,
            fixes: spelled.fixes,
          }),
        );
        continue;
      }
      if (name === 'where') {
        checkWhere(entry.value, table, scope, ctx);
      } else if (name === 'order') {
        const order = entry.value;
        if (order.kind !== 'ident' || !columnNames.has(order.name)) {
          const spelled = order.kind === 'ident'
            ? spellingFix(order.name, columnNames, (hit) => hit, (hit, confidence) => replaceSpan(order.span, hit, `Replace "${order.name}" with "${hit}"`, confidence))
            : NO_SPELLING;
          ctx.out.push(
            makeDiag('E811', 'error', `":order" must name a column of "${table.name}"`, {
              span: order.span,
              nodeId: e.id,
              op,
              field: 'order',
              expected: table.columns.map((c) => c.name).join(' | '),
              suggestions: spelled.suggestions,
              fixes: spelled.fixes,
            }),
          );
        }
      } else {
        checkExpr(entry.value, scope, ctx);
      }
      continue;
    }
    if (op === 'delete-row') {
      ctx.out.push(
        makeDiag('E805', 'error', `${op} does not take a ":${name}" property`, {
          span: entry.keyword.span,
          nodeId: e.id,
          op,
          field: name,
        }),
      );
      continue;
    }
    if (!columnNames.has(name) || name === 'id') {
      const writable = table.columns.filter((c) => c.type !== 'auto' && c.name !== 'id').map((c) => c.name);
      const spelled = spellingFix(name, writable, (hit) => ':' + hit, (hit, confidence) => keywordFix(entry.keyword, hit, confidence));
      ctx.out.push(
        makeDiag('E803', 'error', `Table "${table.name}" has no writable column "${name}"`, {
          span: entry.keyword.span,
          nodeId: e.id,
          op,
          field: name,
          received: name,
          expected: table.columns.filter((c) => c.type !== 'auto').map((c) => ':' + c.name).join(' '),
          suggestions: spelled.suggestions,
          fixes: spelled.fixes,
        }),
      );
      continue;
    }
    checkExpr(entry.value, scope, ctx);
    const col = table.columns.find((c) => c.name === name);
    if (col !== undefined && col.type !== 'auto') {
      checkType(entry.value, { type: columnValueType(col.type), nullable: col.optional }, scope, ctx, op, name);
    }
  }
}

/** (send method route-or-path :prop expr ...) — client mutation against the api. */
function checkSend(e: ListNode, scope: Scope, ctx: Ctx): void {
  const parts = splitList(e);
  const method = parts.rest[0];
  const target = parts.rest[1];
  if (method === undefined || method.kind !== 'ident' || !SEND_METHODS.has(method.name) || target === undefined) {
    ctx.out.push(
      makeDiag('E804', 'error', 'send requires a method and a route: (send post "/api/x" :prop expr ...)', {
        span: e.span,
        nodeId: e.id,
        op: 'send',
        expected: `send ${[...SEND_METHODS].join('|')} "/route"`,
        received: method?.kind === 'ident' ? method.name : undefined,
      }),
    );
    return;
  }
  // The route text is the string target itself or the template of a (path ...) form.
  const pathParts = isList(target) && opName(target) === 'path' ? splitList(target) : undefined;
  if (pathParts !== undefined) for (const [, entry] of pathParts.props) checkExpr(entry.value, scope, ctx);
  const templateAtom = target.kind === 'string' ? target : pathParts?.rest[0];
  if (templateAtom === undefined || templateAtom.kind !== 'string') {
    ctx.out.push(
      makeDiag('E804', 'error', 'send target must be a route string or a (path ...) form', {
        span: target.span,
        nodeId: e.id,
        op: 'send',
      }),
    );
    return;
  }
  const template = templateAtom.value;
  const route = ctx.app.apis.find((a) => a.method === method.name && a.route === template);
  if (route === undefined) {
    const spelled = spellingFix(template, ctx.app.apis.filter((a) => a.method === method.name).map((a) => a.route), (hit) => hit, (hit, confidence) => literalFix(templateAtom, hit, confidence));
    ctx.out.push(
      makeDiag('E806', 'error', `No api route ${method.name.toUpperCase()} ${template}`, {
        span: target.span,
        nodeId: e.id,
        op: 'send',
        received: `${method.name} ${template}`,
        expected: ctx.app.apis.map((a) => `${a.method} ${a.route}`).join(' | ') || '(no api routes declared)',
        suggestions: spelled.suggestions,
        fixes: spelled.fixes,
      }),
    );
  } else {
    if (pathParts !== undefined) {
      for (const param of route.params) {
        if (!pathParts.props.has(param)) {
          ctx.out.push(
            makeDiag('E206', 'error', `Route parameter ":${param}" is required by "${template}"`, {
              span: target.span,
              nodeId: e.id,
              op: 'send',
              field: param,
              expected: route.params.map((p) => ':' + p).join(' '),
            }),
          );
        }
      }
    }
    // Validate the send body against the route's declared (input ...) contract.
    if (route.input !== undefined) {
      const declared = new Map(route.input.map((f) => [f.name, f]));
      for (const field of route.input) {
        const literal = parts.props.get(field.name)?.value;
        if (literal !== undefined && ['number', 'string', 'boolean'].includes(literal.kind) && 'value' in literal) {
          for (const message of fieldErrors(field, literal.value)) ctx.out.push(makeDiag('E809', 'error', message, { span: literal.span, nodeId: e.id, op: 'send', field: field.name, received: String(literal.value), expected: message }));
        }

        if (!field.optional && !parts.props.has(field.name)) {
          ctx.out.push(
            makeDiag('E809', 'error', `${method.name.toUpperCase()} ${template} requires ":${field.name}" (${field.type})`, {
              span: e.span,
              nodeId: e.id,
              op: 'send',
              field: field.name,
              expected: route.input.map((f) => `:${f.name} ${f.type}${f.optional ? '?' : ''}`).join(' '),
              fixes: fixesOf(insertPropFix(target, field.name, placeholderLiteral(field.type), `Add :${field.name} (fill in)`, 'placeholder')),
            }),
          );
        }
      }
      for (const [name, entry] of parts.props) {
        const field = declared.get(name);
        if (field === undefined) {
          const spelled = spellingFix(name, declared.keys(), (hit) => ':' + hit, (hit, confidence) => keywordFix(entry.keyword, hit, confidence));
          ctx.out.push(
            makeDiag('E809', 'error', `":${name}" is not a declared input of ${method.name.toUpperCase()} ${template}`, {
              span: entry.keyword.span,
              nodeId: e.id,
              op: 'send',
              field: name,
              received: name,
              expected: route.input.map((f) => ':' + f.name).join(' ') || '(no input fields)',
              suggestions: spelled.suggestions,
              fixes: spelled.fixes,
            }),
          );
          continue;
        }
        checkType(entry.value, { type: field.type, nullable: field.optional }, scope, ctx, 'send', name);
      }
    }
  }
  for (const [, entry] of parts.props) checkExpr(entry.value, scope, ctx);
}

function warnUnchecked(name: string, e: SExpr, ctx: Ctx): void {
  ctx.out.push(
    makeDiag('W601', 'warning', `Unchecked interop call to browser global "${name}"; validated only by TypeScript at build time`, {
      span: e.span,
      nodeId: isList(e) ? e.id : undefined,
      received: name,
    }),
  );
}

/** (call target.path arg...) — explicit interop invocation. */
function checkCall(e: ListNode, scope: Scope, ctx: Ctx): void {
  const parts = splitList(e);
  const target = parts.rest[0];
  if (target === undefined || target.kind !== 'ident') {
    ctx.out.push(
      makeDiag('E601', 'error', 'call requires a target path: (call target.method arg...)', {
        span: e.span,
        nodeId: e.id,
        op: 'call',
        expected: '(call navigator.clipboard.writeText "text")',
      }),
    );
    return;
  }
  const head = target.name.split('.')[0] ?? target.name;
  const binding = scope.get(head);
  if (binding === undefined) {
    ctx.out.push(
      makeDiag('E201', 'error', `Unknown reference "${head}"`, {
        span: target.span,
        nodeId: e.id,
        op: 'call',
        received: head,
      }),
    );
    return;
  }
  if (target.name === head && binding.kind === 'fn') {
    checkExpr({ ...e, items: [target, ...parts.rest.slice(1)] }, scope, ctx);
    return;
  }
  checkExpr(target, scope, ctx);
  const targetInfo = inferInfo(target, scope, ctx.app.tables);
  if (!isCallable(targetInfo)) {
    ctx.out.push(
      makeDiag('E601', 'error', `"${target.name}" is not callable`, {
        span: target.span,
        nodeId: e.id,
        op: 'call',
        received: typeLabel(targetInfo),
        expected: 'a function or JavaScript method',
      }),
    );
  }
  checkInvocation(targetInfo, parts.rest.slice(1).map((arg) => inferInfo(arg, scope, ctx.app.tables)), e, 'call', ctx);
  if (binding.kind === 'js' && binding.browser === true) warnUnchecked(target.name, e, ctx);
  for (const arg of parts.rest.slice(1)) checkExpr(arg, scope, ctx);
}

function checkAction(e: SExpr, scope: Scope, ctx: Ctx): void {
  if (e.kind === 'ident') {
    const binding = scope.get(e.name);
    if (binding === undefined) {
      ctx.out.push(
        makeDiag('E201', 'error', `Unknown action reference "${e.name}"`, { span: e.span, received: e.name }),
      );
    } else if (binding.kind !== 'prop' && binding.kind !== 'action' && binding.kind !== 'js') {
      ctx.out.push(
        makeDiag('E110', 'error', `"${e.name}" is not callable as an action`, { span: e.span, received: binding.kind }),
      );
    }
    return;
  }
  if (!isList(e)) {
    ctx.out.push(makeDiag('E110', 'error', 'Expected an action form', { span: e.span }));
    return;
  }
  const op = opName(e);
  if (op === 'call') {
    checkCall(e, scope, ctx);
    return;
  }
  if (op !== undefined && scope.get(op)?.kind === 'js') {
    if (scope.get(op)?.browser === true) warnUnchecked(op, e, ctx);
    for (const arg of e.items.slice(1)) checkExpr(arg, scope, ctx);
    return;
  }
  const parts = splitList(e);
  switch (op) {
    case 'set': {
      const target = parts.rest[0];
      const value = parts.rest[1];
      if (target === undefined || target.kind !== 'ident' || value === undefined) {
        ctx.out.push(
          makeDiag('E104', 'error', 'set requires a target and a value: (set target value)', {
            span: e.span,
            nodeId: e.id,
            op: 'set',
            expected: '(set target value)',
          }),
        );
        return;
      }
      const segments = target.name.split('.');
      const head = segments[0] ?? target.name;
      // The full name first: a flow-narrowed field read sits in scope under its dotted path.
      const binding = scope.get(target.name);
      if (segments.includes('')) {
        ctx.out.push(malformedReference(target, { nodeId: e.id, op: 'set', field: 'target' }));
      } else if (binding === undefined && scope.get(head) === undefined) {
        const writable = [...scope].filter(([, info]) => info.kind === 'state' || info.kind === 'local').map(([name]) => name);
        const spelled = spellingFix(head, writable, (hit) => hit, (hit, confidence) => replaceIdentSegment(target, 0, hit, `Replace "${head}" with "${hit}"`, confidence));
        ctx.out.push(
          makeDiag('E201', 'error', `Unknown reference "${head}"`, {
            span: target.span,
            nodeId: e.id,
            op: 'set',
            field: 'target',
            received: head,
            suggestions: spelled.suggestions,
            fixes: spelled.fixes,
          }),
        );
      } else if (binding === undefined) {
        // A known head under a field path: set assigns a whole state or local, and dropping the path is a content choice, not a fix.
        ctx.out.push(
          makeDiag('E202', 'error', `"${target.name}" is not writable state (set assigns a whole state or local, not a field)`, {
            span: target.span,
            nodeId: e.id,
            op: 'set',
            field: 'target',
            received: target.name,
            expected: 'state | local',
          }),
        );
      } else if (binding.kind !== 'state' && binding.kind !== 'local') {
        ctx.out.push(
          makeDiag('E202', 'error', `"${target.name}" is not writable state (it is a ${binding.kind})`, {
            span: target.span,
            nodeId: e.id,
            op: 'set',
            field: 'target',
            received: binding.kind,
            expected: 'state | local',
          }),
        );
      }
      checkExpr(value, scope, ctx);
      if (binding !== undefined && (binding.kind === 'state' || binding.kind === 'local')) {
        checkType(value, binding.storageInfo ?? bindingInfo(binding), scope, ctx, 'set', target.name);
      }
      return;
    }
    case 'nav': {
      const to = parts.rest[0];
      if (to === undefined) {
        ctx.out.push(
          makeDiag('E104', 'error', 'nav requires a target', { span: e.span, nodeId: e.id, op: 'nav' }),
        );
        return;
      }
      checkNavTarget(to, scope, ctx);
      return;
    }
    case 'send': {
      checkSend(e, scope, ctx);
      return;
    }
    case 'toast': {
      const message = parts.rest[0];
      if (message === undefined) {
        ctx.out.push(makeDiag('E104', 'error', 'toast requires a message', { span: e.span, nodeId: e.id, op: 'toast' }));
        return;
      }
      checkExpr(message, scope, ctx);
      const tone = parts.props.get('tone')?.value;
      if (tone !== undefined) {
        const text = tone.kind === 'ident' ? tone.name : tone.kind === 'string' ? tone.value : undefined;
        if (text === undefined || !['info', 'success', 'error'].includes(text)) {
          ctx.out.push(
            makeDiag('E103', 'error', '":tone" must be one of: info, success, error', {
              span: tone.span,
              nodeId: e.id,
              op: 'toast',
              field: 'tone',
              received: text,
              expected: 'info | success | error',
            }),
          );
        }
      }
      return;
    }
    case 'try': {
      let sawCatch = false;
      for (const [i, item] of parts.rest.entries()) {
        if (isList(item) && opName(item) === 'catch') {
          sawCatch = true;
          if (i !== parts.rest.length - 1) {
            ctx.out.push(
              makeDiag('E110', 'error', '(catch ...) must be the last child of (try ...)', { span: item.span, nodeId: e.id, op: 'try' }),
            );
          }
          for (const action of splitList(item).rest) checkAction(action, scope, ctx);
        } else {
          checkAction(item, scope, ctx);
        }
      }
      if (!sawCatch) {
        ctx.out.push(
          makeDiag('E104', 'error', 'try requires a trailing (catch actions...) child', {
            span: e.span,
            nodeId: e.id,
            op: 'try',
            expected: '(try (send ...) (catch (toast "Failed" :tone error)))',
          }),
        );
      }
      return;
    }
    case 'refresh': {
      const target = parts.rest[0];
      if (target === undefined || target.kind !== 'ident' || !ctx.app.resources.has(target.name)) {
        const named = target?.kind === 'ident' ? target : undefined;
        const spelled = named === undefined
          ? NO_SPELLING
          : spellingFix(named.name, ctx.app.resources.keys(), (hit) => hit, (hit, confidence) => replaceSpan(named.span, hit, `Replace "${named.name}" with "${hit}"`, confidence));
        ctx.out.push(
          makeDiag('E807', 'error', 'refresh requires the name of a declared resource', {
            span: target?.span ?? e.span,
            nodeId: e.id,
            op: 'refresh',
            received: named?.name,
            expected: [...ctx.app.resources.keys()].join(' | ') || '(no resources declared)',
            suggestions: spelled.suggestions,
            fixes: spelled.fixes,
          }),
        );
      }
      return;
    }
    default: {
      const spelled = op === undefined ? NO_SPELLING : spellingFix(op, ACTION_OPS, (hit) => hit, (hit, confidence) => renameHeadFix(e, hit, confidence));
      ctx.out.push(
        makeDiag('E110', 'error', `"${op ?? '?'}" is not an action (expected one of: ${ACTION_OPS.join(', ')})`, {
          span: e.span,
          nodeId: e.id,
          op,
          expected: ACTION_OPS.join(' | '),
          suggestions: spelled.suggestions,
          fixes: spelled.fixes,
        }),
      );
    }
  }
}

function checkProps(node: ListNode, schema: OpSchema, scope: Scope, ctx: Ctx): void {
  const parts = splitList(node);
  if (schema.name === 'skeleton') {
    const lines = parts.props.get('lines')?.value;
    if (lines !== undefined && (lines.kind !== 'number' || !Number.isInteger(lines.value) || lines.value < 1 || lines.value > 100)) {
      ctx.out.push(makeDiag('E103', 'error', 'skeleton :lines must be a literal integer from 1 to 100', {
        span: lines.span, nodeId: node.id, op: 'skeleton', field: 'lines', expected: 'integer literal 1–100',
      }));
    }
  }
  const staggerEntry = parts.props.get('stagger');
  if (staggerEntry !== undefined && !parts.props.has('enter')) {
    ctx.out.push(
      makeDiag('E106', 'error', '":stagger" requires an ":enter" animation on the same element', {
        span: staggerEntry.keyword.span,
        nodeId: node.id,
        op: schema.name,
        field: 'enter',
        expected: ':enter fade|fade-up|fade-down|scale-in|slide-left|slide-right',
        fixes: fixesOf(insertPropFix(staggerEntry.value, 'enter', 'fade', 'Add :enter fade', 'review')),
      }),
    );
  }
  if (parts.danglingKeyword !== undefined) {
    ctx.out.push(danglingKeywordDiag(parts.danglingKeyword, node.id, schema.name));
  }
  for (const [name, entry] of parts.props) {
    const resolved = propType(schema, name);
    if (resolved === undefined) {
      const spelled = spellingFix(name, allowedProps(schema), (hit) => ':' + hit, (hit, confidence) => keywordFix(entry.keyword, hit, confidence));
      ctx.out.push(
        makeDiag('E102', 'error', `"${schema.name}" has no property ":${name}"`, {
          span: entry.keyword.span,
          nodeId: node.id,
          op: schema.name,
          field: name,
          expected: [...allowedProps(schema)].sort().join(' '),
          suggestions: spelled.suggestions,
          fixes: spelled.fixes,
        }),
      );
      continue;
    }
    const value = entry.value;
    const t = resolved.type;
    switch (t.kind) {
      case 'number':
        if (value.kind === 'string' || value.kind === 'boolean' || value.kind === 'null') {
          ctx.out.push(
            makeDiag('E103', 'error', `":${name}" expects a number`, {
              span: value.span,
              nodeId: node.id,
              op: schema.name,
              field: name,
              received: value.kind,
              expected: 'number',
            }),
          );
        } else if (value.kind !== 'number') {
          checkExpr(value, scope, ctx);
          checkType(value, { type: 'number' }, scope, ctx, schema.name, name);
        }
        break;
      case 'string':
        if (value.kind === 'number' || value.kind === 'boolean' || value.kind === 'null') {
          ctx.out.push(
            makeDiag('E103', 'error', `":${name}" expects a string`, {
              span: value.span,
              nodeId: node.id,
              op: schema.name,
              field: name,
              received: value.kind,
              expected: 'string',
            }),
          );
        } else if (value.kind !== 'string') {
          checkExpr(value, scope, ctx);
          checkType(value, { type: 'string' }, scope, ctx, schema.name, name);
        }
        break;
      case 'boolean':
        if (value.kind === 'string' || value.kind === 'number' || value.kind === 'null') {
          ctx.out.push(
            makeDiag('E103', 'error', `":${name}" expects a boolean`, {
              span: value.span,
              nodeId: node.id,
              op: schema.name,
              field: name,
              received: value.kind,
              expected: 'true | false',
            }),
          );
        } else if (value.kind !== 'boolean') {
          checkExpr(value, scope, ctx);
          checkType(value, { type: 'boolean' }, scope, ctx, schema.name, name);
        }
        break;
      case 'size':
        if (value.kind === 'ident' && value.name.startsWith('$')) {
          checkTokenRef(value, node, ctx);
        } else if (value.kind === 'boolean' || value.kind === 'null') {
          ctx.out.push(
            makeDiag('E103', 'error', `":${name}" expects a size (number, css string, or $token)`, {
              span: value.span,
              nodeId: node.id,
              op: schema.name,
              field: name,
              received: value.kind,
              expected: 'number | "css-value" | $token',
            }),
          );
        } else if (value.kind === 'string' && !isSafeCssLiteral(value.value)) {
          ctx.out.push(
            makeDiag('E103', 'error', `":${name}" contains unsafe CSS syntax`, {
              span: value.span,
              nodeId: node.id,
              op: schema.name,
              field: name,
              received: value.value,
              expected: 'a non-empty CSS value without ;, braces, comments, control characters, or url(...)',
            }),
          );
        } else if (value.kind === 'ident' || value.kind === 'list') {
          checkExpr(value, scope, ctx);
          checkType(value, { type: 'union', members: [{ type: 'number' }, { type: 'string' }] }, scope, ctx, schema.name, name);
        }
        break;
      case 'color':
        if (value.kind === 'ident' && value.name.startsWith('$')) {
          checkTokenRef(value, node, ctx);
        } else if (value.kind !== 'string') {
          ctx.out.push(
            makeDiag('E103', 'error', `":${name}" expects a color string or $token`, {
              span: value.span,
              nodeId: node.id,
              op: schema.name,
              field: name,
              received: value.kind,
              expected: '"#rrggbb" | "css-color" | $token',
            }),
          );
        } else if (!isSafeCssLiteral(value.value)) {
          ctx.out.push(
            makeDiag('E103', 'error', `":${name}" contains unsafe CSS syntax`, {
              span: value.span,
              nodeId: node.id,
              op: schema.name,
              field: name,
              received: value.value,
              expected: 'a CSS color without ;, braces, comments, control characters, or url(...)',
            }),
          );
        }
        break;
      case 'enum': {
        const literal = value.kind === 'ident' || value.kind === 'string' ? value : undefined;
        const text = literal === undefined ? undefined : literal.kind === 'ident' ? literal.name : literal.value;
        if (text === undefined || !(t.values ?? []).includes(text)) {
          const spelled = literal === undefined || text === undefined
            ? NO_SPELLING
            : spellingFix(text, t.values ?? [], (hit) => hit, (hit, confidence) => literalFix(literal, hit, confidence));
          ctx.out.push(
            makeDiag('E103', 'error', `":${name}" must be one of: ${(t.values ?? []).join(', ')}`, {
              span: value.span,
              nodeId: node.id,
              op: schema.name,
              field: name,
              received: text ?? value.kind,
              expected: (t.values ?? []).join(' | '),
              suggestions: spelled.suggestions,
              fixes: spelled.fixes,
            }),
          );
        }
        break;
      }
      case 'expr':
        checkExpr(value, scope, ctx);
        break;
      case 'ref': {
        if (value.kind !== 'ident') {
          ctx.out.push(
            makeDiag('E103', 'error', `":${name}" expects a state reference`, {
              span: value.span,
              nodeId: node.id,
              op: schema.name,
              field: name,
              received: value.kind,
              expected: 'state or local name',
            }),
          );
          break;
        }
        const binding = scope.get(value.name);
        if (binding === undefined) {
          ctx.out.push(
            makeDiag('E201', 'error', `Unknown reference "${value.name}"`, {
              span: value.span,
              nodeId: node.id,
              op: schema.name,
              field: name,
              received: value.name,
            }),
          );
        } else if (binding.kind !== 'state' && binding.kind !== 'local') {
          ctx.out.push(
            makeDiag('E202', 'error', `":${name}" must reference writable state`, {
              span: value.span,
              nodeId: node.id,
              op: schema.name,
              field: name,
              received: binding.kind,
              expected: 'state | local',
            }),
          );
        } else {
          let expectedType: 'string' | 'number' | 'boolean' | undefined;
          if (schema.name === 'input' && name === 'value') {
            const inputType = parts.props.get('type')?.value;
            const inputTypeName = inputType?.kind === 'ident' ? inputType.name : inputType?.kind === 'string' ? inputType.value : undefined;
            expectedType = inputTypeName === 'number' ? 'number' : 'string';
          } else if (schema.name === 'checkbox' && name === 'checked') {
            expectedType = 'boolean';
          } else if (schema.name === 'dialog' && name === 'open') {
            expectedType = 'boolean';
          } else if (schema.name === 'tabs' && name === 'value') {
            expectedType = 'number';
          } else if (schema.name === 'file-input' && name === 'to') {
            expectedType = 'string';
          } else if (schema.name === 'select' && name === 'value') {
            expectedType = 'string';
          }
          if (expectedType !== undefined && binding.valueType !== expectedType) {
            ctx.out.push(
              makeDiag('E111', 'error', `":${name}" on ${schema.name} writes ${expectedType} values, but "${value.name}" is ${binding.valueType ?? 'unknown'}`, {
                span: value.span,
                nodeId: node.id,
                op: schema.name,
                field: name,
                received: binding.valueType ?? 'unknown',
                expected: `${expectedType} state or local`,
              }),
            );
          }
        }
        break;
      }
      case 'route':
        checkNavTarget(value, scope, ctx);
        break;
      default: {
        const exhaustive: never = t.kind;
        throw new Error(`unhandled prop type: ${String(exhaustive)}`);
      }
    }
  }
}

function checkTokenRef(token: IdentAtom, node: ListNode, ctx: Ctx): void {
  const tokenName = token.name.slice(1);
  if (!ctx.app.tokens.has(tokenName)) {
    const spelled = spellingFix(tokenName, ctx.app.tokens.keys(), (hit) => '$' + hit, (hit, confidence) => tokenFix(token, hit, confidence));
    ctx.out.push(
      makeDiag('E205', 'error', `Unknown design token "$${tokenName}"`, {
        span: token.span,
        nodeId: node.id,
        received: token.name,
        expected: [...ctx.app.tokens.keys()].map((t) => '$' + t).join(' ') || '(no tokens declared)',
        suggestions: spelled.suggestions,
        fixes: spelled.fixes,
      }),
    );
  }
}

/** Resources acknowledged by a condition expression (guards `.data` reads). */
function guardedResources(cond: SExpr, ctx: Ctx): string[] {
  const found: string[] = [];
  const go = (e: SExpr): void => {
    if (e.kind === 'ident') {
      const [head, field] = e.name.split('.');
      if (head !== undefined && field !== undefined && ctx.app.resources.has(head) && (field === 'loading' || field === 'error')) {
        found.push(head);
      }
    } else if (e.kind === 'list') {
      for (const item of e.items) go(item);
    }
  };
  go(cond);
  return found;
}

function checkComponentInstance(node: ListNode, component: ComponentModel, scope: Scope, ctx: Ctx): void {
  const parts = splitList(node);
  const declared = new Map(component.props.map((p) => [p.name, p]));
  for (const prop of component.props) {
    if (!parts.props.has(prop.name)) {
      ctx.out.push(
        makeDiag('E106', 'error', `"${component.name}" requires property ":${prop.name}"`, {
          span: node.span,
          nodeId: node.id,
          op: component.name,
          field: prop.name,
          expected: component.props.map((p) => ':' + p.name).join(' '),
          // An action slot takes a form, not a value, so it has no stand-in.
          fixes: prop.type === 'action' ? undefined : fixesOf(insertPropFix(parts.op, prop.name, placeholderLiteral(prop.type), `Add :${prop.name} (fill in)`, 'placeholder')),
        }),
      );
    }
  }
  for (const [name, entry] of parts.props) {
    if (name === 'id' || name === 'key') continue;
    const decl = declared.get(name);
    if (decl === undefined) {
      const spelled = spellingFix(name, declared.keys(), (hit) => ':' + hit, (hit, confidence) => keywordFix(entry.keyword, hit, confidence));
      ctx.out.push(
        makeDiag('E102', 'error', `"${component.name}" has no property ":${name}"`, {
          span: entry.keyword.span,
          nodeId: node.id,
          op: component.name,
          field: name,
          expected: component.props.map((p) => ':' + p.name).join(' ') || '(no properties)',
          suggestions: spelled.suggestions,
          fixes: spelled.fixes,
        }),
      );
      continue;
    }
    if (decl.type === 'action') {
      checkAction(entry.value, scope, ctx);
    } else {
      checkExpr(entry.value, scope, ctx);
      if (decl.type === 'string' || decl.type === 'number' || decl.type === 'boolean' || decl.type === 'list') {
        checkType(entry.value, declaredType(decl.type, ctx.app.tables), scope, ctx, component.name, name);
      }
    }
  }
  const children = parts.rest;
  if (children.length > 0 && !component.hasSlot) {
    ctx.out.push(
      makeDiag('E110', 'error', `"${component.name}" does not accept children (it has no slot)`, {
        span: node.span,
        nodeId: node.id,
        op: component.name,
      }),
    );
  }
  for (const child of children) checkElement(child, scope, ctx);
}

export function checkElement(e: SExpr, scope: Scope, ctx: Ctx): void {
  if (!isList(e)) {
    ctx.out.push(
      makeDiag('E110', 'error', 'Expected an element form here', { span: e.span }),
    );
    return;
  }
  const op = opName(e);
  if (op === undefined) {
    ctx.out.push(makeDiag('E110', 'error', 'Element list must start with an operation name', { span: e.span, nodeId: e.id }));
    return;
  }

  const component = ctx.app.components.get(op);
  if (component !== undefined) {
    checkComponentInstance(e, component, scope, ctx);
    return;
  }

  const schema = lookupOp(op);
  if (schema === undefined) {
    // Candidates are what element position accepts: every op but the declarations and actions rejected below, plus components.
    const elementOps = allOpNames().filter((name) => {
      const category = lookupOp(name)?.category;
      return category !== 'declaration' && category !== 'action';
    });
    const spelled = spellingFix(op, [...elementOps, ...ctx.app.components.keys()], (hit) => hit, (hit, confidence) => renameHeadFix(e, hit, confidence));
    ctx.out.push(
      makeDiag('E101', 'error', `Unknown operation "${op}"`, {
        span: e.span,
        nodeId: e.id,
        op,
        suggestions: spelled.suggestions,
        fixes: spelled.fixes,
      }),
    );
    return;
  }

  if (schema.category === 'declaration' || schema.category === 'action') {
    ctx.out.push(
      makeDiag('E110', 'error', `"${op}" is not allowed in element position`, {
        span: e.span,
        nodeId: e.id,
        op,
      }),
    );
    return;
  }

  // each's :key expression runs inside the loop and is checked after the loop
  // variable has been introduced below.
  if (schema.name !== 'each') checkProps(e, schema, scope, ctx);
  const parts = splitList(e);
  const rest = parts.rest;

  switch (schema.name) {
    case 'each': {
      const varAtom = rest[0];
      const items = rest[1];
      if (varAtom === undefined || varAtom.kind !== 'ident' || items === undefined) {
        ctx.out.push(
          makeDiag('E104', 'error', 'each requires a variable and a list: (each var items body...)', {
            span: e.span,
            nodeId: e.id,
            op: 'each',
            expected: '(each var items body...)',
          }),
        );
        return;
      }
      const generatedLoopBindings = new Map<string, string>([['index', 'index']]);
      if (!checkLexicalBinding(varAtom.name, varAtom, e, 'each variable', generatedLoopBindings, ctx)) return;
      checkExpr(items, scope, ctx);
      const inner: Scope = new Map(scope);
      const itemsInfo = inferInfo(items, scope, ctx.app.tables);
      checkType(items, { type: 'list', nullable: true }, scope, ctx, 'each');
      inner.set(varAtom.name, bindingFromInfo('eachvar', elementInfo(itemsInfo)));
      inner.set('index', { kind: 'eachvar', valueType: 'number' });
      checkProps(e, schema, inner, ctx);
      for (const child of rest.slice(2)) checkElement(child, inner, ctx);
      return;
    }
    case 'if': {
      const cond = rest[0];
      if (cond === undefined) {
        ctx.out.push(makeDiag('E104', 'error', 'if requires a condition', { span: e.span, nodeId: e.id, op: 'if' }));
        return;
      }
      checkCondition(cond, scope, ctx, 'if');
      const branches = rest.slice(1);
      if (branches.length < 1 || branches.length > 2) {
        ctx.out.push(
          makeDiag('E104', 'error', `if takes one or two branches, got ${branches.length}`, {
            span: e.span,
            nodeId: e.id,
            op: 'if',
            received: String(branches.length),
            expected: '(if cond then else?)',
          }),
        );
      }
      const guarded = new Set(ctx.guarded);
      for (const r of guardedResources(cond, ctx)) guarded.add(r);
      branches.forEach((branch, i) => checkElement(branch, narrowScope(cond, scope, i === 0, ctx.app.tables), { ...ctx, guarded }));
      return;
    }
    case 'when': {
      const cond = rest[0];
      if (cond === undefined) {
        ctx.out.push(makeDiag('E104', 'error', 'when requires a condition', { span: e.span, nodeId: e.id, op: 'when' }));
        return;
      }
      checkCondition(cond, scope, ctx, 'when');
      const guarded = new Set(ctx.guarded);
      for (const r of guardedResources(cond, ctx)) guarded.add(r);
      for (const child of rest.slice(1)) checkElement(child, narrowScope(cond, scope, true, ctx.app.tables), { ...ctx, guarded });
      return;
    }
    case 'slot': {
      if (!ctx.inComponent) {
        ctx.out.push(
          makeDiag('E110', 'error', 'slot is only allowed inside a component', { span: e.span, nodeId: e.id, op: 'slot' }),
        );
      }
      return;
    }
    case 'text':
    case 'heading': {
      if (rest.length === 0) {
        ctx.out.push(
          makeDiag('E104', 'error', `${schema.name} requires content`, { span: e.span, nodeId: e.id, op: schema.name }),
        );
      }
      for (const part of rest) checkExpr(part, scope, ctx);
      return;
    }
    case 'image': {
      const src = rest[0];
      if (src === undefined) {
        ctx.out.push(makeDiag('E104', 'error', 'image requires a source', { span: e.span, nodeId: e.id, op: 'image' }));
      } else {
        checkExpr(src, scope, ctx);
      }
      if (!parts.props.has('alt')) {
        ctx.out.push(
          makeDiag('W401', 'warning', 'image should declare :alt text for accessibility', {
            span: e.span,
            nodeId: e.id,
            op: 'image',
            field: 'alt',
            expected: ':alt "description of the image"',
            fixes: fixesOf(insertPropFix(src ?? parts.op, 'alt', '""', 'Add :alt "" (fill in)', 'placeholder')),
          }),
        );
      }
      return;
    }
    case 'money': {
      const amount = rest[0];
      if (amount === undefined) {
        ctx.out.push(makeDiag('E104', 'error', 'money requires an amount', { span: e.span, nodeId: e.id, op: 'money' }));
      } else {
        checkExpr(amount, scope, ctx);
      }
      return;
    }
    case 'spacer': {
      const size = rest[0];
      if (size !== undefined) checkExpr(size, scope, ctx);
      return;
    }
    case 'button': {
      let hasLabel = false;
      for (const item of rest) {
        if (isList(item) && EVENT_OPS.has(opName(item) ?? '')) {
          checkEvent(item, scope, ctx);
        } else if (isList(item)) {
          hasLabel = true;
          checkElement(item, scope, ctx);
        } else {
          hasLabel = true;
          checkExpr(item, scope, ctx);
        }
      }
      if (!hasLabel) {
        ctx.out.push(
          makeDiag('W402', 'warning', 'button has no accessible label', {
            span: e.span,
            nodeId: e.id,
            op: 'button',
            expected: 'a label expression or element child before the event handlers',
            fixes: fixesOf(insertAfterFix(parts.op, '"Label"', 'Add a label (fill in)', 'placeholder')),
          }),
        );
      }
      return;
    }
    case 'dialog': {
      if (!parts.props.has('open')) {
        ctx.out.push(
          makeDiag('E106', 'error', 'dialog requires an :open state reference', {
            span: e.span,
            nodeId: e.id,
            op: 'dialog',
            field: 'open',
            expected: ':open boolean-state reference',
          }),
        );
      }
      for (const item of rest) checkElement(item, scope, ctx);
      return;
    }
    case 'tabs': {
      for (const item of rest) {
        if (!isList(item) || opName(item) !== 'tab') {
          ctx.out.push(
            makeDiag('E110', 'error', 'tabs children must be (tab "Label" body...) forms', {
              span: item.span,
              nodeId: e.id,
              op: 'tabs',
              expected: '(tab "Label" body...)',
            }),
          );
          continue;
        }
        const tabParts = splitList(item);
        const label = tabParts.rest[0];
        if (label === undefined) {
          ctx.out.push(makeDiag('E104', 'error', 'tab requires a label', { span: item.span, nodeId: item.id, op: 'tab' }));
          continue;
        }
        checkExpr(label, scope, ctx);
        for (const child of tabParts.rest.slice(1)) checkElement(child, scope, ctx);
      }
      return;
    }
    case 'menu': {
      const label = rest[0];
      if (label === undefined) {
        ctx.out.push(makeDiag('E104', 'error', 'menu requires a label', { span: e.span, nodeId: e.id, op: 'menu' }));
      } else {
        checkExpr(label, scope, ctx);
      }
      for (const item of rest.slice(1)) {
        if (!isList(item) || opName(item) !== 'item') {
          ctx.out.push(
            makeDiag('E110', 'error', 'menu children must be (item "Label" action...) forms', {
              span: item.span,
              nodeId: e.id,
              op: 'menu',
              expected: '(item "Label" action...)',
            }),
          );
          continue;
        }
        const itemParts = splitList(item);
        const itemLabel = itemParts.rest[0];
        if (itemLabel === undefined) {
          ctx.out.push(makeDiag('E104', 'error', 'item requires a label', { span: item.span, nodeId: item.id, op: 'item' }));
          continue;
        }
        checkExpr(itemLabel, scope, ctx);
        for (const action of itemParts.rest.slice(1)) checkAction(action, scope, ctx);
      }
      return;
    }
    case 'table': {
      const varAtom = rest[0];
      const items = rest[1];
      if (varAtom === undefined || varAtom.kind !== 'ident' || items === undefined) {
        ctx.out.push(
          makeDiag('E104', 'error', 'table requires a row variable and items: (table row items (col ...) ...)', {
            span: e.span,
            nodeId: e.id,
            op: 'table',
            expected: '(table row items (col "Header" cell...) ...)',
          }),
        );
        return;
      }
      const generatedRowBindings = new Map<string, string>([['index', 'index']]);
      if (!checkLexicalBinding(varAtom.name, varAtom, e, 'table row variable', generatedRowBindings, ctx)) return;
      checkExpr(items, scope, ctx);
      const rowScope: Scope = new Map(scope);
      const rowInfo = inferInfo(items, scope, ctx.app.tables);
      checkType(items, { type: 'list', nullable: true }, scope, ctx, 'table');
      rowScope.set(varAtom.name, bindingFromInfo('eachvar', elementInfo(rowInfo)));
      for (const colForm of rest.slice(2)) {
        if (!isList(colForm) || opName(colForm) !== 'col') {
          ctx.out.push(
            makeDiag('E110', 'error', 'table children must be (col "Header" cell...) forms', {
              span: colForm.span,
              nodeId: e.id,
              op: 'table',
              expected: '(col "Header" cell...)',
            }),
          );
          continue;
        }
        const colParts = splitList(colForm);
        const header = colParts.rest[0];
        if (header === undefined) {
          ctx.out.push(makeDiag('E104', 'error', 'col requires a header', { span: colForm.span, nodeId: colForm.id, op: 'col' }));
          continue;
        }
        checkExpr(header, scope, ctx);
        for (const cell of colParts.rest.slice(1)) {
          if (isList(cell)) checkElement(cell, rowScope, ctx);
          else checkExpr(cell, rowScope, ctx);
        }
      }
      return;
    }
    case 'input':
    case 'checkbox':
    case 'select': {
      for (const item of rest) {
        if (isList(item) && EVENT_OPS.has(opName(item) ?? '')) {
          checkEvent(item, scope, ctx);
        } else {
          ctx.out.push(
            makeDiag('E110', 'error', `${schema.name} children must be event handlers`, {
              span: item.span,
              nodeId: e.id,
              op: schema.name,
              expected: 'click | change | submit',
            }),
          );
        }
      }
      return;
    }
    case 'file-input': {
      if (ctx.app.uploads === undefined) {
        // A malformed (uploads ...) is absent from the model but present in the source, and already carries its own E818.
        const declared = ctx.app.node.items.some((item) => isList(item) && opName(item) === 'uploads');
        ctx.out.push(
          makeDiag('E818', 'error', 'file-input requires an (uploads ...) declaration in the app', {
            span: e.span,
            nodeId: e.id,
            op: 'file-input',
            ...(declared ? {} : { suggestions: ['(uploads)'], fixes: fixesOf(insertChildFix(ctx.app.node, '(uploads)', 'Add (uploads) to app', 'safe')) }),
          }),
        );
      }
      if (!parts.props.has('to')) {
        ctx.out.push(
          makeDiag('E818', 'error', 'file-input requires a :to string state that receives the uploaded URL', {
            span: e.span,
            nodeId: e.id,
            op: 'file-input',
            field: 'to',
            expected: '(file-input :label "Photo" :to photo-url)',
          }),
        );
      }
      return;
    }
    case 'link': {
      if (!parts.props.has('to')) {
        ctx.out.push(
          makeDiag('E106', 'error', 'link requires a :to route', {
            span: e.span,
            nodeId: e.id,
            op: 'link',
            field: 'to',
            fixes: fixesOf(insertPropFix(parts.op, 'to', '""', 'Add :to "" (fill in)', 'placeholder')),
          }),
        );
      }
      for (const item of rest) {
        if (isList(item)) checkElement(item, scope, ctx);
        else checkExpr(item, scope, ctx);
      }
      return;
    }
    default: {
      // Generic containers: children are elements or event handlers.
      for (const item of rest) {
        if (isList(item) && EVENT_OPS.has(opName(item) ?? '')) {
          checkEvent(item, scope, ctx);
        } else {
          checkElement(item, scope, ctx);
        }
      }
    }
  }
}

function checkEvent(e: ListNode, scope: Scope, ctx: Ctx): void {
  const parts = splitList(e);
  if (parts.rest.length === 0) {
    ctx.out.push(
      makeDiag('E104', 'error', `${opName(e) ?? 'event'} requires at least one action`, {
        span: e.span,
        nodeId: e.id,
        op: opName(e),
      }),
    );
  }
  for (const action of parts.rest) checkAction(action, scope, ctx);
}

/** Resolve a declared fn parameter type to a scope binding. */
function fnParamInfo(app: AppModel, typeName: string | undefined, decl: { name: string; node: ListNode }, out: Diagnostic[]): VarInfo | undefined {
  if (typeName === undefined) return undefined;
  if (typeName === 'number' || typeName === 'string' || typeName === 'boolean' || typeName === 'list') {
    return { kind: 'eachvar', valueType: typeName };
  }
  if (app.tables.has(typeName)) {
    return { kind: 'eachvar', valueType: 'row', rowTable: typeName };
  }
  out.push(
    makeDiag('E104', 'error', `Unknown parameter type "${typeName}" in fn "${decl.name}"`, {
      span: decl.node.span,
      nodeId: decl.node.id,
      op: 'fn',
      received: typeName,
      expected: 'number | string | boolean | list | a table name',
    }),
  );
  return undefined;
}

export function check(app: AppModel, out: Diagnostic[]): void {
  const literalVerdicts = new Map<ListNode, LiteralVerdict>();
  const base: Ctx = { app, out, guarded: new Set(), inComponent: false, throwingFns: throwingFunctions(app, literalVerdicts), literalVerdicts };

  const stateScope = stateInitializerScope(app);
  for (const [name, state] of app.states) {
    checkExpr(state.init, stateScope, base);
    stateScope.set(name, initializerInfo('state', state.init, stateScope, app));
  }

  // fn bodies are pure: params + other fns + imports + globals, no state.
  for (const [, decl] of app.functions) {
    const paramInfos = decl.paramTypes.map((t) => fnParamInfo(app, t, decl, out));
    checkExpr(decl.body, fnScope(app, decl.params, paramInfos), { ...base, inFn: true });
  }

  // api handlers: route params + body + user + fns + imports, server ops enabled.
  for (const route of app.apis) {
    if (route.handler === undefined) continue;
    const scope = handlerScope(app, route);
    if (mayUseBrowserGlobal(route.handler, app, scope)) {
      out.push(
        makeDiag('E805', 'error', `API route ${route.method.toUpperCase()} ${route.route} cannot use browser globals`, {
          span: route.handler.span,
          nodeId: route.node.id,
          op: route.method,
          expected: 'server-safe expressions, imports, and fns',
        }),
      );
    }
    if (mayCallAsyncInterop(route.handler, app, scope) && !asyncInteropIsOuterResult(route.handler, app)) {
      out.push(
        makeDiag('E805', 'error', 'Promise-capable JavaScript interop must be the outer result of an API handler', {
          span: route.handler.span,
          nodeId: route.node.id,
          op: route.method,
          expected: 'return the interop call directly; do not nest it inside db/object operations',
        }),
      );
    }
    checkExpr(route.handler, scope, { ...base, inHandler: true, routeMethod: route.method });
  }

  // job bodies run inside the generated server: db ops allowed, no request context.
  for (const job of app.jobs) {
    if (app.tables.size === 0 && app.apis.length === 0) {
      out.push(
        makeDiag('E817', 'error', `Job "${job.name}" requires the generated server: declare (db ...) or (api ...)`, {
          span: job.node.span,
          nodeId: job.node.id,
          op: 'job',
        }),
      );
      continue;
    }
    const scope = jobScope(app);
    if (mayUseBrowserGlobal(job.body, app, scope)) {
      out.push(
        makeDiag('E805', 'error', `Job "${job.name}" cannot use browser globals`, {
          span: job.body.span,
          nodeId: job.node.id,
          op: 'job',
          expected: 'server-safe expressions, imports, and fns',
        }),
      );
    }
    if (mayCallAsyncInterop(job.body, app, scope) && !asyncInteropIsOuterResult(job.body, app)) {
      out.push(
        makeDiag('E805', 'error', `Promise-capable JavaScript interop must be the outer result of job "${job.name}"`, {
          span: job.body.span,
          nodeId: job.node.id,
          op: 'job',
        }),
      );
    }
    checkExpr(job.body, scope, { ...base, inHandler: true });
  }

  // Resource defaults are evaluated in generated page modules. They may use
  // globals, but not another resource whose hook may not exist or may be
  // declared later in that page.
  const resourceDefaultScope = baseScope(app);
  for (const name of app.resources.keys()) resourceDefaultScope.delete(name);
  for (const [, resource] of app.resources) {
    if (resource.defaultValue !== undefined) checkExpr(resource.defaultValue, resourceDefaultScope, base);
  }

  // :live resources subscribe to the generated server's change events.
  const hasServer = app.tables.size > 0 || app.apis.length > 0 || app.uploads !== undefined;
  for (const [, resource] of app.resources) {
    if (resource.live && !hasServer) {
      out.push(
        makeDiag('E816', 'error', `Resource "${resource.name}" is :live but the app declares no server (db/api)`, {
          span: resource.node.span,
          nodeId: resource.node.id,
          op: 'resource',
          field: 'live',
          expected: 'db, api, or uploads declaration',
        }),
      );
    }
  }

  // :references must point at a declared table (soft foreign keys to id).
  for (const [, table] of app.tables) {
    for (const col of table.columns) {
      if (col.references !== undefined && !app.tables.has(col.references)) {
        out.push(
          makeDiag('E819', 'error', `Column "${col.name}" references unknown table "${col.references}"`, {
            span: col.node.span,
            nodeId: col.node.id,
            op: 'table',
            field: col.name,
            received: col.references,
            expected: [...app.tables.keys()].join(' '),
          }),
        );
      }
    }
  }

  // Seeds: table and columns must exist, values must be literals.
  for (const seed of app.seeds) {
    const table = app.tables.get(seed.table);
    if (table === undefined) {
      const tableAtom = splitList(seed.node).rest[0];
      const spelled = tableAtom?.kind === 'ident'
        ? spellingFix(seed.table, app.tables.keys(), (hit) => hit, (hit, confidence) => replaceSpan(tableAtom.span, hit, `Replace "${seed.table}" with "${hit}"`, confidence))
        : NO_SPELLING;
      out.push(
        makeDiag('E802', 'error', `Unknown table "${seed.table}" in (seed ...)`, {
          span: seed.node.span,
          nodeId: seed.node.id,
          op: 'seed',
          received: seed.table,
          suggestions: spelled.suggestions,
          fixes: spelled.fixes,
        }),
      );
      continue;
    }
    const writable = table.columns.filter((c) => c.type !== 'auto').map((c) => c.name);
    for (const row of seed.rows) {
      const keywords = splitList(row.node).props;
      for (const [name, value] of row.props) {
        const col = table.columns.find((c) => c.name === name);
        if (col === undefined || col.type === 'auto') {
          const keyword = keywords.get(name)?.keyword;
          const spelled = keyword === undefined
            ? NO_SPELLING
            : spellingFix(name, writable, (hit) => ':' + hit, (hit, confidence) => keywordFix(keyword, hit, confidence));
          out.push(
            makeDiag('E803', 'error', `Table "${table.name}" has no writable column "${name}"`, {
              span: row.node.span,
              nodeId: row.node.id,
              op: 'seed',
              field: name,
              expected: table.columns.filter((c) => c.type !== 'auto').map((c) => ':' + c.name).join(' '),
              suggestions: spelled.suggestions,
              fixes: spelled.fixes,
            }),
          );
          continue;
        }
        if (value.kind !== 'string' && value.kind !== 'number' && value.kind !== 'boolean') {
          out.push(
            makeDiag('E801', 'error', 'seed values must be literals', { span: value.span, nodeId: row.node.id, op: 'seed', field: name }),
          );
        }
      }
    }
  }

  // i18n: every key in the default locale should exist in the others.
  if (app.defaultLocale !== undefined) {
    const defaults = app.locales.get(app.defaultLocale);
    if (defaults !== undefined) {
      for (const [locName, messages] of app.locales) {
        if (locName === app.defaultLocale) continue;
        for (const key of defaults.keys()) {
          if (!messages.has(key)) {
            out.push(
              makeDiag('W701', 'warning', `Locale "${locName}" is missing message "${key}"`, {
                span: app.node.span,
                nodeId: app.node.id,
                op: 'i18n',
                field: key,
                received: locName,
              }),
            );
          }
        }
      }
    }
  }

  for (const page of app.pages) {
    const scope = pageInitializerScope(app, page);
    for (const local of page.locals) {
      const outer = scope.get(local.name);
      const initScope =
        outer !== undefined &&
        (outer.kind === 'state' || outer.kind === 'resource' || outer.kind === 'fn' || outer.kind === 'enum' || (outer.kind === 'js' && outer.browser !== true))
          ? new Map(scope)
          : scope;
      if (initScope !== scope) initScope.delete(local.name);
      checkExpr(local.init, initScope, base);
      scope.set(local.name, initializerInfo('local', local.init, initScope, app));
    }
    if (page.title !== undefined) checkExpr(page.title, scope, base);
    for (const child of page.body) checkElement(child, scope, { ...base, guarded: new Set() });
  }

  for (const [, component] of app.components) {
    const scope = componentInitializerScope(app, component);
    const ctx: Ctx = { ...base, inComponent: true };
    for (const local of component.locals) {
      const outer = scope.get(local.name);
      const initScope =
        outer !== undefined &&
        (outer.kind === 'state' || outer.kind === 'resource' || outer.kind === 'fn' || outer.kind === 'enum' || (outer.kind === 'js' && outer.browser !== true))
          ? new Map(scope)
          : scope;
      if (initScope !== scope) initScope.delete(local.name);
      checkExpr(local.init, initScope, ctx);
      scope.set(local.name, initializerInfo('local', local.init, initScope, app));
    }
    for (const child of component.body) checkElement(child, scope, { ...ctx, guarded: new Set() });
  }

  const testScope = fnScope(app, []);
  for (const [name, binding] of testScope) if (binding.kind === 'js') testScope.delete(name);
  checkTests(app, out, (expr) => {
    if (mayUseBrowserGlobal(expr, app, testScope) || mayCallAsyncInterop(expr, app, testScope)) {
      out.push(
        makeDiag('E701', 'error', 'expect-eq runs in Node and cannot call browser or Promise-capable interop', {
          span: expr.span,
          expected: 'pure synchronous GRHM expressions',
        }),
      );
    }
    // A throw inside expect-eq fails the test, which is the assertion the author wants.
    checkExpr(expr, testScope, { ...base, guarded: new Set(), inFn: true });
  });
}
