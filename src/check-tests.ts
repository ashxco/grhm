import { SExpr, isList, opName, splitList, walkLists } from './ast.js';
import { AppModel } from './analyze.js';
import { Diagnostic, makeDiag } from './diagnostics.js';
import { TEST_STEPS } from './schema.js';

/** Validation of (tests ...) suites: step shapes, routes, node references. */

/** True when a concrete route (no params) matches a page's route template. */
function matchStaticRoute(template: string, route: string): boolean {
  const tSegs = template.split('/').filter((s) => s !== '');
  const rSegs = route.split('/').filter((s) => s !== '');
  if (tSegs.length !== rSegs.length) return false;
  return tSegs.every((seg, i) => seg.startsWith('{') || seg === rSegs[i]);
}

/** `expect-eq` has no design-token binding in the generated test process. */
function rejectTestTokens(e: SExpr, out: Diagnostic[]): void {
  if (e.kind === 'ident' && e.name.startsWith('$')) {
    out.push(
      makeDiag('E701', 'error', `expect-eq cannot read design token "${e.name}"`, {
        span: e.span,
        received: e.name,
        expected: 'literals, lexical bindings, stdlib expressions, enums, i18n, or declared fns',
      }),
    );
    return;
  }
  if (isList(e)) for (const item of e.items) rejectTestTokens(item, out);
}

export function checkTests(app: AppModel, out: Diagnostic[], checkPureExpr: (expr: SExpr) => void): void {
  if (app.tests.length === 0) return;
  const nodeIds = new Set<string>();
  walkLists([app.node], (n) => {
    if (n.id !== undefined) nodeIds.add(n.id);
  });
  const routeOk = (route: string): boolean => app.pages.some((p) => matchStaticRoute(p.route, route));

  for (const test of app.tests) {
    for (const step of test.steps) {
      const op = opName(step) ?? '?';
      const spec = TEST_STEPS[op];
      if (spec === undefined) {
        out.push(
          makeDiag('E701', 'error', `"${op}" is not a test step`, {
            span: step.span,
            nodeId: step.id,
            op,
            expected: Object.keys(TEST_STEPS).join(' '),
          }),
        );
        continue;
      }
      const args = splitList(step).rest;
      spec.args.forEach((shape, i) => {
        const arg = args[i];
        if (arg === undefined) {
          out.push(
            makeDiag('E701', 'error', `"${op}" requires ${spec.args.length} argument(s)`, {
              span: step.span,
              nodeId: step.id,
              op,
              expected: spec.args.join(' '),
            }),
          );
          return;
        }
        switch (shape) {
          case 'route':
            if (arg.kind !== 'string') {
              out.push(makeDiag('E701', 'error', `"${op}" expects a route string`, { span: arg.span, op }));
            } else if (!routeOk(arg.value)) {
              out.push(
                makeDiag('E203', 'error', `"${arg.value}" does not match any page route`, {
                  span: arg.span,
                  nodeId: step.id,
                  op,
                  received: arg.value,
                  expected: app.pages.map((p) => p.route).join(' '),
                }),
              );
            }
            break;
          case 'string':
            if (arg.kind !== 'string') {
              out.push(makeDiag('E701', 'error', `"${op}" expects a string`, { span: arg.span, op, received: arg.kind }));
            }
            break;
          case 'node-or-string':
            if (arg.kind === 'ident' && !nodeIds.has(arg.name)) {
              out.push(
                makeDiag('E204', 'error', `Node "${arg.name}" does not exist`, {
                  span: arg.span,
                  nodeId: step.id,
                  op,
                  received: arg.name,
                }),
              );
            } else if (arg.kind !== 'ident' && arg.kind !== 'string') {
              out.push(
                makeDiag('E701', 'error', `"${op}" expects a node id or a label string`, { span: arg.span, op, received: arg.kind }),
              );
            }
            break;
          case 'number':
            if (arg.kind !== 'number') {
              out.push(makeDiag('E701', 'error', `"${op}" expects a number`, { span: arg.span, op, received: arg.kind }));
            }
            break;
          case 'expr':
            rejectTestTokens(arg, out);
            checkPureExpr(arg);
            break;
          default: {
            const exhaustive: never = shape;
            throw new Error(`unhandled step arg shape: ${String(exhaustive)}`);
          }
        }
      });
    }
  }
}
