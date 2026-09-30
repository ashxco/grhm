import { SExpr, isList, opName, splitList } from './ast.js';
import { ApiRouteDecl, AppModel, ColumnType, ComponentModel, PageModel, TableDecl } from './analyze.js';
import { BROWSER_GLOBALS, EXPR_OPS } from './schema.js';

export type VarKind = 'state' | 'local' | 'resource' | 'eachvar' | 'param' | 'prop' | 'action' | 'js' | 'fn' | 'enum';
export type ValueType = 'number' | 'string' | 'boolean' | 'list' | 'row' | 'record' | 'function' | 'null' | 'union' | 'never' | 'unknown';

/** A function retains its lexical scope so untyped parameters can be inferred at a call site. */
export interface CallableInfo {
  params: TypeInfo[];
  pure?: boolean;
  names: string[];
  result?: TypeInfo;
  body?: SExpr;
  scope?: Scope;
  tables?: Map<string, TableDecl>;
}

/** Known shape, including absence, collection elements, and callable contracts. */
export interface TypeInfo {
  type: ValueType;
  nullable?: boolean;
  rowTable?: string;
  element?: TypeInfo;
  fields?: Map<string, TypeInfo>;
  callable?: CallableInfo;
  members?: TypeInfo[];
  enumName?: string;
}

export interface VarInfo {
  kind: VarKind;
  valueType?: ValueType;
  rowTable?: string;
  browser?: boolean;
  enumValues?: string[];
  enumName?: string;
  /** Legacy field metadata remains available to diagnostic consumers. */
  fields?: Map<string, ValueType>;
  optionalFields?: Set<string>;
  info?: TypeInfo;
  /** A flow-refined read must not narrow the set of values writable to storage. */
  storageInfo?: TypeInfo;
}

export type Scope = Map<string, VarInfo>;
const UNKNOWN: TypeInfo = { type: 'unknown' };
const NEVER: TypeInfo = { type: 'never' };
const NULL: TypeInfo = { type: 'null', nullable: true };

export const NUMERIC_OPS = new Set(['+', '-', '*', '/', '<', '>', '<=', '>=', 'mod', 'abs', 'round', 'floor', 'ceil', 'sqrt', 'pow', 'min', 'max']);
const NUMBER_RESULT = new Set(['+', '-', '*', '/', 'mod', 'count', 'abs', 'round', 'floor', 'ceil', 'sqrt', 'pow', 'min', 'max', 'random', 'to-num', 'sum', 'now']);
const BOOLEAN_RESULT = new Set(['=', '!=', '<', '>', '<=', '>=', 'and', 'or', 'not', 'starts-with', 'ends-with', 'contains', 'some', 'every', 'is-null', 'not-null']);
const STRING_RESULT = new Set(['concat', 'path', 'fmt', 'to-str', 'to-fixed', 'upper', 'lower', 'trim', 'join', 'replace', 'date-str', 't']);
const PRESERVES_ELEMENT: Record<string, number> = { filter: 1, 'sort-by': 1, reverse: 0, take: 1, drop: 1 };
const ELEMENT_RESULT: Record<string, number> = { first: 0, last: 0, nth: 1, find: 1 };

export function columnValueType(type: ColumnType): ValueType {
  switch (type) {
    case 'auto':
    case 'number': return 'number';
    case 'string': return 'string';
    case 'boolean': return 'boolean';
    default: {
      const exhaustive: never = type;
      throw new Error(`unhandled column type: ${String(exhaustive)}`);
    }
  }
}

export function declaredType(name: string | undefined, tables?: Map<string, TableDecl>): TypeInfo {
  if (name === 'number' || name === 'string' || name === 'boolean') return { type: name };
  if (name === 'list') return listInfo(UNKNOWN);
  if (name !== undefined && tables?.has(name)) return { type: 'row', rowTable: name };
  return UNKNOWN;
}

export function bindingInfo(binding: VarInfo): TypeInfo {
  if (binding.info !== undefined) return binding.info;
  const fields = binding.fields === undefined ? undefined : new Map([...binding.fields].map(([name, type]) => [name, { type, nullable: binding.optionalFields?.has(name) === true }]));
  return { type: binding.valueType ?? (fields !== undefined ? 'record' : 'unknown'), rowTable: binding.rowTable, fields, enumName: binding.enumName };
}

export function bindingFromInfo(kind: VarKind, info: TypeInfo): VarInfo {
  return {
    kind, valueType: info.type, rowTable: info.rowTable, enumName: info.enumName, info,
    storageInfo: kind === 'state' || kind === 'local' ? info : undefined,
    fields: info.fields === undefined ? undefined : new Map([...info.fields].map(([name, field]) => [name, field.type])),
    optionalFields: info.fields === undefined ? undefined : new Set([...info.fields].filter(([, field]) => isNullable(field)).map(([name]) => name)),
  };
}

export function isNullable(info: TypeInfo): boolean {
  return info.nullable === true || info.type === 'null' || info.members?.some(isNullable) === true;
}

export function withoutNull(info: TypeInfo): TypeInfo {
  if (info.type === 'null') return NEVER;
  if (info.type === 'union') return (info.members ?? []).map(withoutNull).reduce(mergeInfo, NEVER);
  return { ...info, nullable: false };
}

export function listInfo(element: TypeInfo): TypeInfo {
  return { type: 'list', element, rowTable: element.type === 'row' ? element.rowTable : undefined };
}

export function elementInfo(info: TypeInfo): TypeInfo {
  if (info.type === 'union') return (info.members ?? []).map(elementInfo).reduce(mergeInfo, NEVER);
  return info.element ?? (info.rowTable !== undefined && info.type === 'list' ? { type: 'row', rowTable: info.rowTable } : UNKNOWN);
}

/** Merge branches without discarding known mismatches into opaque unknown. */
export function mergeInfo(a: TypeInfo, b: TypeInfo): TypeInfo {
  if (a.type === 'never') return b;
  if (b.type === 'never') return a;
  if (a.type === 'null') return { ...b, nullable: true };
  if (b.type === 'null') return { ...a, nullable: true };
  if (a.type === 'unknown' || b.type === 'unknown') return { type: 'unknown', nullable: isNullable(a) || isNullable(b) };
  const nullable = isNullable(a) || isNullable(b);
  if (a.type === b.type && a.rowTable === b.rowTable) {
    if (a.type === 'list') return { ...listInfo(mergeInfo(elementInfo(a), elementInfo(b))), nullable };
    if (a.type === 'record' && a.fields !== undefined && b.fields !== undefined) {
      const fields = new Map<string, TypeInfo>();
      for (const name of new Set([...a.fields.keys(), ...b.fields.keys()])) fields.set(name, mergeInfo(a.fields.get(name) ?? NULL, b.fields.get(name) ?? NULL));
      return { type: 'record', fields, nullable };
    }
    if (a.type !== 'function' && a.type !== 'union') return { ...a, nullable, enumName: a.enumName === b.enumName ? a.enumName : undefined };
    if (a.callable !== undefined && a.callable === b.callable) return { ...a, nullable };
  }
  const members: TypeInfo[] = [];
  for (const candidate of [...(a.members ?? [a]), ...(b.members ?? [b])]) {
    const clean = { ...candidate, nullable: false };
    const existing = members.findIndex((member) => member.type === clean.type && member.rowTable === clean.rowTable && member.type !== 'function');
    if (existing < 0) members.push(clean);
    else members[existing] = mergeInfo(members[existing] ?? NEVER, clean);
  }
  return members.length === 1 ? { ...(members[0] ?? UNKNOWN), nullable } : { type: 'union', members, nullable };
}

export function typeLabel(info: TypeInfo): string {
  let label = info.type === 'row' ? `${info.rowTable ?? 'table'} row` : info.type;
  if (info.type === 'list') label = `list<${typeLabel(elementInfo(info))}>`;
  if (info.type === 'function' && info.callable !== undefined) label = `(${info.callable.params.map(typeLabel).join(', ')}) => ${typeLabel(info.callable.result ?? UNKNOWN)}`;
  if (info.type === 'union') label = (info.members ?? []).map(typeLabel).join(' | ');
  return isNullable(info) && info.type !== 'null' ? `${label} | null` : label;
}

/** Unknown inputs retain the interop escape hatch; known unions must all fit. */
export function isAssignable(actual: TypeInfo, expected: TypeInfo): boolean {
  if (actual.type === 'never' || expected.type === 'unknown' || expected.type === 'never') return true;
  if (actual.type === 'unknown') return !isNullable(actual) || isNullable(expected);
  if (isNullable(actual) && !isNullable(expected)) return false;
  if (actual.type === 'null') return isNullable(expected) || expected.type === 'null';
  if (actual.type === 'union') return (actual.members ?? []).every((member) => isAssignable(member, expected));
  if (expected.type === 'union') return (expected.members ?? []).some((member) => isAssignable(actual, { ...member, nullable: isNullable(expected) }));
  if (actual.type !== expected.type) return false;
  if (expected.type === 'row') return actual.rowTable === expected.rowTable;
  if (expected.type === 'list') return isAssignable(elementInfo(actual), elementInfo(expected));
  if (expected.type === 'record' && expected.fields !== undefined) return [...expected.fields].every(([key, field]) => isAssignable(actual.fields?.get(key) ?? NULL, field));
  if (expected.type === 'function' && actual.callable !== undefined && expected.callable !== undefined) {
    return actual.callable.params.length === expected.callable.params.length
      && expected.callable.params.every((param, i) => isAssignable(param, actual.callable?.params[i] ?? UNKNOWN))
      && isAssignable(inferCall(actual, expected.callable.params), inferCall(expected, expected.callable.params));
  }
  return true;
}

/** Render inferred shapes for generated storage/function annotations. */
export function typeScriptType(info: TypeInfo, tables?: Map<string, TableDecl>, depth = 0): string {
  if (depth > 12) return 'any';
  const render = (value: TypeInfo): string => typeScriptType(value, tables, depth + 1);
  let text: string;
  switch (info.type) {
    case 'number': case 'string': case 'boolean': text = info.type; break;
    case 'null': return 'null | undefined';
    case 'never': return 'never';
    case 'unknown': return 'any';
    case 'list': {
      const element = elementInfo(info);
      const value = element.type === 'never' ? 'any' : render(element);
      text = `${element.type === 'union' || isNullable(element) || element.type === 'function' ? `(${value})` : value}[]`;
      break;
    }
    case 'row': {
      const table = info.rowTable === undefined ? undefined : tables?.get(info.rowTable);
      text = table === undefined ? 'Record<string, any>' : `{ ${table.columns.map((column) => `${JSON.stringify(column.name)}: ${render({ type: columnValueType(column.type), nullable: column.optional })}`).join('; ')} }`;
      break;
    }
    case 'record': text = info.fields === undefined ? 'Record<string, any>' : `{ ${[...info.fields].map(([name, field]) => `${JSON.stringify(name)}${isNullable(field) ? '?' : ''}: ${render(field)}`).join('; ')} }`; break;
    case 'function': {
      const signature = info.callable;
      text = signature === undefined ? '(...args: any[]) => any' : `(${signature.params.map((param, i) => `arg${i}: ${render(param)}`).join(', ')}) => ${render(signature.result ?? inferCall(info, signature.params, tables))}`;
      text = `(${text})`;
      break;
    }
    case 'union': text = (info.members ?? []).map(render).join(' | ') || 'any'; break;
    default: {
      const exhaustive: never = info.type;
      throw new Error(`unhandled type: ${String(exhaustive)}`);
    }
  }
  return isNullable(info) ? `${text} | null | undefined` : text;
}

export function literalType(e: SExpr): ValueType {
  if (e.kind === 'number' || e.kind === 'string' || e.kind === 'boolean' || e.kind === 'null') return e.kind;
  return isList(e) && (e.items.length === 0 || opName(e) === 'arr') ? 'list' : 'unknown';
}

/** Pure globals are captured before page/state bindings are introduced. */
function moduleScope(app: AppModel, browser = true): Scope {
  const scope: Scope = new Map();
  for (const name of app.imports.keys()) scope.set(name, { kind: 'js' });
  for (const [name, decl] of app.enums) scope.set(name, { kind: 'enum', enumValues: decl.values });
  if (browser) for (const name of BROWSER_GLOBALS) scope.set(name, { kind: 'js', browser: true });
  for (const [name, decl] of app.functions) {
    scope.set(name, bindingFromInfo('fn', { type: 'function', callable: { names: decl.params, pure: true, params: decl.paramTypes.map((type) => declaredType(type, app.tables)), body: decl.body, scope, tables: app.tables } }));
  }
  return scope;
}

export function initializerInfo(kind: 'state' | 'local', init: SExpr, scope: Scope, app: AppModel): VarInfo {
  const inferred = inferInfo(init, scope, app.tables);
  // An initially empty slot has no declared payload type; later writes remain opaque.
  return bindingFromInfo(kind, inferred.type === 'null' ? { type: 'unknown', nullable: true } : inferred);
}

export function stateInitializerScope(app: AppModel): Scope { return new Map(moduleScope(app)); }

export function handlerRowTable(app: AppModel, route: ApiRouteDecl): { table: string; list: boolean } | undefined {
  if (route.handler === undefined) return undefined;
  const info = inferInfo(route.handler, handlerScope(app, route), app.tables);
  if (info.rowTable === undefined) return undefined;
  if (info.type === 'list') return { table: info.rowTable, list: true };
  if (info.type === 'row') return { table: info.rowTable, list: false };
  return undefined;
}

export function resourceRowTable(app: AppModel, url: string): string | undefined {
  const route = app.apis.find((candidate) => candidate.method === 'get' && candidate.route === url);
  const result = route === undefined ? undefined : handlerRowTable(app, route);
  return result?.list === true ? result.table : undefined;
}

export function baseScope(app: AppModel): Scope {
  const scope = stateInitializerScope(app);
  for (const [name, state] of app.states) scope.set(name, initializerInfo('state', state.init, scope, app));
  for (const [name, resource] of app.resources) {
    const route = app.apis.find((candidate) => candidate.method === 'get' && candidate.route === resource.url);
    const response = route?.handler === undefined ? UNKNOWN : inferInfo(route.handler, handlerScope(app, route), app.tables);
    const data = resource.defaultValue === undefined ? { ...response, nullable: true } : mergeInfo(response, inferInfo(resource.defaultValue, scope, app.tables));
    scope.set(name, { ...bindingFromInfo('resource', data), rowTable: data.rowTable });
  }
  return scope;
}

export function pageInitializerScope(app: AppModel, page: PageModel): Scope {
  const scope = baseScope(app);
  for (const param of page.params) scope.set(param, bindingFromInfo('param', { type: 'string' }));
  return scope;
}

export function componentInitializerScope(app: AppModel, component: ComponentModel): Scope {
  const scope = baseScope(app);
  for (const prop of component.props) {
    const info = prop.type === 'action' ? { type: 'function' as const, callable: { names: [], params: [], result: UNKNOWN } } : declaredType(prop.type, app.tables);
    scope.set(prop.name, bindingFromInfo(prop.type === 'action' ? 'action' : 'prop', info));
  }
  return scope;
}

export function fnScope(app: AppModel, params: string[], paramInfos?: (VarInfo | undefined)[]): Scope {
  const scope = new Map(moduleScope(app));
  params.forEach((param, i) => scope.set(param, paramInfos?.[i] ?? { kind: 'eachvar' }));
  return scope;
}

export function jobScope(app: AppModel): Scope {
  const scope = new Map(moduleScope(app, false));
  if (app.envs.size > 0) scope.set('env', bindingFromInfo('eachvar', { type: 'record', fields: new Map([...app.envs.keys()].map((name) => [name, { type: 'string' }])) }));
  return scope;
}

export function handlerScope(app: AppModel, route: ApiRouteDecl): Scope {
  const scope = jobScope(app);
  for (const param of route.params) scope.set(param, bindingFromInfo('param', { type: 'string' }));
  scope.set('body', bindingFromInfo('eachvar', route.input === undefined ? UNKNOWN : { type: 'record', fields: new Map(route.input.map((field) => [field.name, { type: field.type, nullable: field.optional }])) }));
  if (route.auth && app.auth !== undefined) scope.set('user', bindingFromInfo('eachvar', { type: 'row', rowTable: app.auth.usersTable }));
  return scope;
}

/** Refine a named value/field in a condition's true or false branch. */
export function narrowScope(test: SExpr, scope: Scope, truthy: boolean, tables?: Map<string, TableDecl>): Scope {
  if (!isList(test)) return scope;
  const op = opName(test);
  const args = test.items.slice(1);
  if (op === 'not' && args[0] !== undefined) return narrowScope(args[0], scope, !truthy, tables);
  if ((op === 'and' && truthy) || (op === 'or' && !truthy)) return args.reduce((inner, arg) => narrowScope(arg, inner, truthy, tables), scope);
  let target: SExpr | undefined;
  let present = truthy;
  if (op === 'is-null' || op === 'not-null') {
    target = args[0];
    present = op === 'not-null' ? truthy : !truthy;
  } else if (op === '=' || op === '!=') {
    if (args[0]?.kind === 'null') target = args[1];
    if (args[1]?.kind === 'null') target = args[0];
    present = op === '!=' ? truthy : !truthy;
    // Equality lowers to ===/!==. Unlike is-null/not-null it cannot rule out
    // undefined (for example, an out-of-range first/nth result).
    if (present) return scope;
  }
  if (target?.kind !== 'ident') return scope;
  const info = inferInfo(target, scope, tables);
  const head = target.name.split('.')[0] ?? target.name;
  const original = scope.get(target.name) ?? scope.get(head);
  const inner = new Map(scope);
  const refined = bindingFromInfo(target.name === head ? original?.kind ?? 'eachvar' : 'eachvar', present ? withoutNull(info) : NULL);
  if (target.name === head && original?.storageInfo !== undefined) refined.storageInfo = original.storageInfo;
  inner.set(target.name, refined);
  return inner;
}

export function fieldInfo(info: TypeInfo, field: string, tables?: Map<string, TableDecl>): TypeInfo {
  if (info.type === 'union') return (info.members ?? []).map((member) => fieldInfo(member, field, tables)).reduce(mergeInfo, NEVER);
  if (info.fields !== undefined) return info.fields.get(field) ?? NULL;
  if (info.type === 'row' && info.rowTable !== undefined) {
    const table = tables?.get(info.rowTable);
    const column = table?.columns.find((candidate) => candidate.name === field);
    if (column !== undefined) return { type: columnValueType(column.type), nullable: column.optional };
    if (table !== undefined) return NULL;
  }
  if ((info.type === 'list' || info.type === 'string') && field === 'length') return { type: 'number' };
  return UNKNOWN;
}

/** Infer an invocation, specializing opaque parameters while preserving annotations. */
export function inferCall(info: TypeInfo, args: TypeInfo[], tables?: Map<string, TableDecl>, visiting = new Set<CallableInfo>()): TypeInfo {
  if (info.type === 'union') return (info.members ?? []).map((member) => inferCall(member, args, tables, visiting)).reduce(mergeInfo, NEVER);
  const fn = info.callable;
  if (fn === undefined) return UNKNOWN;
  if (fn.result !== undefined) return fn.result;
  if (fn.body === undefined || fn.scope === undefined || visiting.has(fn)) return UNKNOWN;
  const inner = new Map(fn.scope);
  fn.names.forEach((name, i) => inner.set(name, bindingFromInfo('eachvar', fn.params[i]?.type === 'unknown' ? args[i] ?? UNKNOWN : fn.params[i] ?? UNKNOWN)));
  const next = new Set(visiting);
  next.add(fn);
  return inferInfo(fn.body, inner, tables ?? fn.tables, next);
}

/** Infer values and shapes without executing user code or resolving JS imports. */
export function inferInfo(e: SExpr, scope: Scope, tables?: Map<string, TableDecl>, visiting = new Set<CallableInfo>()): TypeInfo {
  const infer = (expr: SExpr | undefined, inner = scope): TypeInfo => expr === undefined ? UNKNOWN : inferInfo(expr, inner, tables, visiting);
  if (e.kind === 'number' || e.kind === 'string' || e.kind === 'boolean') return { type: e.kind };
  if (e.kind === 'null') return NULL;
  if (e.kind === 'keyword') return UNKNOWN;
  if (e.kind === 'ident') {
    const segments = e.name.split('.');
    const head = segments[0] ?? e.name;
    if (head.startsWith('$')) return { type: 'string' };
    const exact = scope.get(e.name);
    if (segments.length > 1 && exact !== undefined) return bindingInfo(exact);
    const binding = scope.get(head);
    if (binding === undefined || binding.kind === 'js') return UNKNOWN;
    if (binding.kind === 'enum') return segments.length === 2 ? { type: 'string', enumName: head } : UNKNOWN;
    let info = bindingInfo(binding);
    let start = 1;
    if (binding.kind === 'resource') {
      const field = segments[1];
      if (field === 'loading') return { type: 'boolean' };
      if (field === 'error') return { type: 'string', nullable: true };
      if (field !== 'data') return UNKNOWN;
      start = 2;
    }
    for (const segment of segments.slice(start)) info = fieldInfo(info, segment, tables);
    return info;
  }
  const op = opName(e);
  if (op === undefined) return e.items.length === 0 ? listInfo(NEVER) : UNKNOWN;
  const args = e.items.slice(1);
  if (op === 'lambda') {
    const params = args[0];
    const names = params !== undefined && isList(params) ? params.items.flatMap((param) => param.kind === 'ident' ? [param.name] : []) : [];
    return { type: 'function', callable: { names, params: names.map(() => UNKNOWN), body: args[1], scope: new Map(scope), tables } };
  }
  if (op === 'let') {
    const bindings = args[0];
    const inner = new Map(scope);
    if (bindings !== undefined && isList(bindings)) for (const binding of bindings.items) {
      if (!isList(binding) || binding.items[0]?.kind !== 'ident' || binding.items[1] === undefined) continue;
      inner.set(binding.items[0].name, bindingFromInfo('eachvar', infer(binding.items[1], inner)));
    }
    return infer(args[1], inner);
  }
  if (op === 'if') return mergeInfo(infer(args[1], args[0] === undefined ? scope : narrowScope(args[0], scope, true, tables)), infer(args[2], args[0] === undefined ? scope : narrowScope(args[0], scope, false, tables)));
  if (op === 'or-else') {
    const value = infer(args[0]);
    if (value.type === 'null') return infer(args[1]);
    if (value.type !== 'unknown' && !isNullable(value)) return value;
    return mergeInfo(withoutNull(value), infer(args[1]));
  }
  if (op === 'attempt') return mergeInfo(infer(args[0]), infer(args[1]));
  if (op === 'cond' || op === 'match') {
    let result = NEVER;
    let inner = scope;
    let exhaustive = false;
    for (const clause of args.slice(op === 'match' ? 1 : 0)) {
      if (!isList(clause)) continue;
      const test = clause.items[0];
      const isElse = test?.kind === 'ident' && test.name === 'else';
      exhaustive ||= isElse;
      result = mergeInfo(result, infer(clause.items[1], op === 'cond' && test !== undefined && !isElse ? narrowScope(test, inner, true, tables) : inner));
      if (op === 'cond' && test !== undefined && !isElse) inner = narrowScope(test, inner, false, tables);
    }
    // Enum exhaustiveness is checked separately; a missing default can still return undefined.
    if (op === 'match' && args[0] !== undefined) {
      const enumName = infer(args[0]).enumName;
      const values = enumName === undefined ? undefined : scope.get(enumName)?.enumValues;
      const covered = args.slice(1).flatMap((clause) => !isList(clause) ? [] : clause.items[0]?.kind === 'string' ? [clause.items[0].value] : clause.items[0]?.kind === 'ident' ? [clause.items[0].name.split('.')[1]] : []);
      exhaustive ||= values !== undefined && values.every((value) => covered.includes(value));
    }
    return exhaustive ? result : { ...result, nullable: true };
  }
  if (op === 'obj') return { type: 'record', fields: new Map([...splitList(e).props].map(([name, entry]) => [name, infer(entry.value)])) };
  if (op === 'get') {
    const object = infer(args[0]);
    const key = args[1];
    if (key?.kind === 'string') {
      const field = fieldInfo(object, key.value, tables);
      return isNullable(object) ? { ...field, nullable: true } : field;
    }
    if (key?.kind === 'number' && object.type === 'list') return { ...elementInfo(object), nullable: true };
    if (object.fields !== undefined) return [...object.fields.values()].reduce(mergeInfo, NULL);
    return { type: 'unknown', nullable: true };
  }
  if (op === 'arr') return listInfo(args.map((arg) => infer(arg)).reduce(mergeInfo, NEVER));
  if (op === 'keys') return listInfo({ type: 'string' });
  if (op === 'values' || op === 'entries') {
    const record = infer(args[0]);
    const fields = record.fields ?? (record.rowTable === undefined ? undefined : new Map(tables?.get(record.rowTable)?.columns.map((column) => [column.name, { type: columnValueType(column.type), nullable: column.optional }])));
    const value = fields === undefined ? UNKNOWN : [...fields.values()].reduce(mergeInfo, NEVER);
    return listInfo(op === 'values' ? value : listInfo(mergeInfo({ type: 'string' }, value)));
  }
  if (op === 'assoc' || op === 'dissoc') {
    const record = infer(args[0]), key = args[1];
    if (record.fields === undefined || key?.kind !== 'string') return { type: 'record' };
    const fields = new Map(record.fields);
    if (op === 'assoc') fields.set(key.value, infer(args[2])); else fields.delete(key.value);
    return { type: 'record', fields };
  }
  if (op === 'merge') {
    const records = args.map((arg) => infer(arg));
    if (records.some((record) => record.fields === undefined)) return { type: 'record' };
    return { type: 'record', fields: new Map(records.flatMap((record) => [...record.fields!])) };
  }
  if (op === 'from-entries' || op === 'group-by') return { type: 'record' };
  if (op === 'json-parse') return { type: 'unknown', nullable: true };
  if (op === 'regex-find') return { ...listInfo({ type: 'string', nullable: true }), nullable: true };
  if (op === 'unique') return { ...infer(args[0]), nullable: false, type: 'list' };
  if (op === 'zip') return listInfo(listInfo(mergeInfo(elementInfo(infer(args[0])), elementInfo(infer(args[1])))));
  if (op === 'chunk') return listInfo(listInfo(elementInfo(infer(args[1]))));
  if (op === 'flatten' || op === 'flat-map') {
    const value = op === 'flatten' ? elementInfo(infer(args[0])) : inferCall(infer(args[0]), [elementInfo(infer(args[1]))], tables, visiting);
    const flattened = (part: TypeInfo): TypeInfo => part.type === 'list' ? mergeInfo(elementInfo(part), isNullable(part) ? NULL : NEVER) : part;
    return listInfo(value.type === 'union' ? (value.members ?? []).map(flattened).reduce(mergeInfo, value.nullable ? NULL : NEVER) : flattened(value));
  }
  if (op === 'select') return args[0]?.kind === 'ident' && tables?.has(args[0].name) ? listInfo({ type: 'row', rowTable: args[0].name }) : listInfo(UNKNOWN);
  if (op === 'insert' || op === 'update') return args[0]?.kind === 'ident' && tables?.has(args[0].name) ? { type: 'row', rowTable: args[0].name, nullable: op === 'update' } : UNKNOWN;
  if (op === 'delete-row') return { type: 'record', fields: new Map([['ok', { type: 'boolean' }]]) };
  if (op === 'tx') return infer(args[0]);
  if (op === 'fail') return NEVER;
  if (op === 'map') return listInfo(inferCall(infer(args[0]), [elementInfo(infer(args[1]))], tables, visiting));
  if (op === 'reduce') return mergeInfo(infer(args[1]), inferCall(infer(args[0]), [infer(args[1]), elementInfo(infer(args[2]))], tables, visiting));
  const preserve = PRESERVES_ELEMENT[op];
  if (preserve !== undefined) {
    let element = elementInfo(infer(args[preserve]));
    const predicate = op === 'filter' ? infer(args[0]).callable : undefined;
    const param = predicate?.names[0];
    if (predicate?.body !== undefined && param !== undefined) {
      const inner = new Map(predicate.scope ?? scope);
      inner.set(param, bindingFromInfo('eachvar', element));
      element = bindingInfo(narrowScope(predicate.body, inner, true, tables).get(param) ?? bindingFromInfo('eachvar', element));
    }
    return listInfo(element);
  }
  if (op === 'append') return listInfo(mergeInfo(elementInfo(infer(args[0])), infer(args[1])));
  const element = ELEMENT_RESULT[op];
  if (element !== undefined) {
    const value = elementInfo(infer(args[element]));
    return value.type === 'never' ? NULL : { ...value, nullable: true };
  }
  if (op === 'range') return listInfo({ type: 'number' });
  if (op === 'split') return listInfo({ type: 'string' });
  if (op === 'slice') return infer(args[2]);
  if (op === 'call') return inferCall(infer(args[0]), args.slice(1).map((arg) => infer(arg)), tables, visiting);
  const scalarResult = EXPR_OPS[op]?.result;
  if (scalarResult !== undefined) return { type: scalarResult };
  if (NUMBER_RESULT.has(op)) return { type: 'number' };
  if (BOOLEAN_RESULT.has(op)) return { type: 'boolean' };
  if (STRING_RESULT.has(op)) return { type: 'string' };
  const binding = scope.get(op);
  return binding === undefined ? UNKNOWN : inferCall(bindingInfo(binding), args.map((arg) => infer(arg)), tables, visiting);
}

export function inferType(e: SExpr, scope: Scope, tables?: Map<string, TableDecl>): ValueType { return inferInfo(e, scope, tables).type; }
