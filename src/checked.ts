import { type SExpr, isList, opName, splitList } from './ast.js';
import type { AppModel } from './analyze.js';
import { type Scope, type TypeInfo, bindingInfo, handlerScope, inferInfo, jobScope } from './typing.js';

/** Checked metadata for server expressions; unknown interop stays explicit. */
export interface CheckedExpression {
  source: SExpr;
  type: TypeInfo;
  bindings: ReadonlyMap<string, TypeInfo>;
  reads: ReadonlySet<string>;
  writes: ReadonlySet<string>;
  opaque: boolean;
}
export type CheckedProgram = ReadonlyMap<string, CheckedExpression>;

function expression(source: SExpr, scope: Scope, app: AppModel): CheckedExpression {
  const reads = new Set<string>();
  const writes = new Set<string>();
  let opaque = false;
  const queue = [source];
  const visitedFunctions = new Set<string>();
  while (queue.length > 0) {
    const node = queue.pop()!;
    if (!isList(node)) continue;
    const op = opName(node);
    const first = splitList(node).rest[0];
    if (first?.kind === 'ident' && app.tables.has(first.name)) {
      if (op === 'select') reads.add(first.name);
      if (op === 'insert' || op === 'update' || op === 'delete' || op === 'delete-row') writes.add(first.name);
    }
    if (op !== undefined && app.imports.has(op)) opaque = true;
    if (op !== undefined && !visitedFunctions.has(op) && app.functions.has(op)) { visitedFunctions.add(op); queue.push(app.functions.get(op)!.body); }
    queue.push(...node.items);
  }
  return { source, type: inferInfo(source, scope, app.tables), bindings: new Map([...scope].map(([name, binding]) => [name, bindingInfo(binding)])), reads, writes, opaque };
}

/** Called only after successful analysis/checking; codegen consumes this data. */
export function checkedProgram(app: AppModel): CheckedProgram {
  const result = new Map<string, CheckedExpression>();
  for (const route of app.apis) if (route.handler !== undefined && route.node.id !== undefined) result.set(route.node.id, expression(route.handler, handlerScope(app, route), app));
  for (const job of app.jobs) if (job.node.id !== undefined) result.set(job.node.id, expression(job.body, jobScope(app), app));
  return result;
}
