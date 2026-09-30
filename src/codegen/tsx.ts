import { type Scope, bindingFromInfo, elementInfo, inferInfo, typeScriptType } from '../typing.js';
import { AppModel } from '../analyze.js';
import { ListNode, SExpr, isList, opName, splitList } from '../ast.js';
import { lookupOp, propType, OpSchema } from '../schema.js';
import { STYLE_TO_JS, isStyleValueStatic } from './css.js';
import { GenCtx as ExprCtx, actionStatements, genAction, genBindingName, genExpr, genHandler, genPathTemplate } from './expr.js';
import { camelCase, pascalCase } from '../util.js';

/** JSX generation for GRHM elements. */

export interface TsxCtx extends ExprCtx {
  app: AppModel;
  typeScope: Scope;
  /**
   * Hook declarations synthesized by widgets (tabs/menu internal UI state).
   * The emitting function renders these before the returned JSX.
   */
  synthHooks: string[];
}

/** A stable, valid TS identifier suffix derived from a node id. */
function hookName(nodeId: string): string {
  const encoded = Array.from(nodeId, (ch) => ch.codePointAt(0)?.toString(16) ?? '').join('_');
  return `ui_${encoded === '' ? 'empty' : encoded}`;
}

const EVENT_ATTR: Record<string, string> = { click: 'onClick', change: 'onChange', submit: 'onSubmit' };

function pad(n: number): string {
  return ' '.repeat(n);
}

function attrValue(expr: string): string {
  // Plain string literals render as name="text" for readability.
  if (/^"[^"\\]*"$/.test(expr)) return '=' + expr;
  return '={' + expr + '}';
}

/** A semantic node ID serialized as a JSX expression, never raw attribute text. */
function dataG(nodeId: string): string {
  return `data-g={${JSON.stringify(nodeId)}}`;
}

interface SplitChildren {
  events: Map<string, ListNode>;
  children: SExpr[];
}

function partitionChildren(rest: SExpr[]): SplitChildren {
  const events = new Map<string, ListNode>();
  const children: SExpr[] = [];
  for (const item of rest) {
    const op = isList(item) ? opName(item) : undefined;
    if (op !== undefined && EVENT_ATTR[op] !== undefined && isList(item)) {
      events.set(op, item);
    } else {
      children.push(item);
    }
  }
  return { events, children };
}

function eventAttrs(events: Map<string, ListNode>, ctx: TsxCtx): string[] {
  const attrs: string[] = [];
  for (const [name, node] of events) {
    const actions = splitList(node).rest;
    attrs.push(`${EVENT_ATTR[name]}=${'{'}${genHandler(actions, ctx)}${'}'}`);
  }
  return attrs;
}

/** className plus inline styles for expression-valued style props. */
function styleAttrs(node: ListNode, schema: OpSchema, ctx: TsxCtx, staticClasses: string[]): string[] {
  const attrs: string[] = [];
  const classes = [...staticClasses];
  const generated = ctx.classFor.get(node.id);
  if (generated !== undefined) classes.push(generated);
  if (classes.length > 0) attrs.push(`className="${classes.join(' ')}"`);

  const inline: string[] = [];
  for (const [name, entry] of splitList(node).props) {
    const resolved = propType(schema, name);
    if (resolved === undefined || resolved.media !== undefined) continue;
    const jsName = STYLE_TO_JS[resolved.base];
    if (jsName === undefined) continue;
    if (isStyleValueStatic(resolved.base, entry.value)) continue;
    inline.push(`${jsName}: ${genExpr(entry.value, ctx)}`);
  }
  if (inline.length > 0) attrs.push(`style={{ ${inline.join(', ')} }}`);
  return attrs;
}

function textParts(parts: SExpr[], ctx: TsxCtx): string {
  return parts
    .map((p) => (p.kind === 'string' ? `{${JSON.stringify(p.value)}}` : `{${genExpr(p, ctx)}}`))
    .join('');
}

function openTag(tag: string, attrs: string[], selfClose: boolean): string {
  const joined = attrs.filter((a) => a !== '').join(' ');
  const inner = joined === '' ? '' : ' ' + joined;
  return selfClose ? `<${tag}${inner} />` : `<${tag}${inner}>`;
}

function withChildrenLines(open: string, childLines: string[], close: string, indent: number): string {
  if (childLines.length === 0) return open + close;
  return open + '\n' + childLines.join('\n') + '\n' + pad(indent) + close;
}

/** A JSX child line (or lines) for any child expression or element. */
export function genChild(e: SExpr, ctx: TsxCtx, indent: number): string {
  if (!isList(e)) {
    if (e.kind === 'string') return `{${JSON.stringify(e.value)}}`;
    return `{${genExpr(e, ctx)}}`;
  }
  const op = opName(e);
  switch (op) {
    case 'each':
      return genEach(e, ctx, indent);
    case 'if':
      return genIf(e, ctx, indent);
    case 'when':
      return genWhen(e, ctx, indent);
    case 'slot':
      return '{__grhmProps.children}';
    default:
      return genElement(e, ctx, indent);
  }
}

function genChildrenLines(items: SExpr[], ctx: TsxCtx, indent: number, wrapLi = false): string[] {
  const lines: string[] = [];
  for (const item of items) {
    const rendered = genChild(item, ctx, wrapLi ? indent + 2 : indent);
    if (wrapLi) {
      lines.push(pad(indent) + '<li>');
      lines.push(pad(indent + 2) + rendered);
      lines.push(pad(indent) + '</li>');
    } else {
      lines.push(pad(indent) + rendered);
    }
  }
  return lines;
}

/** Collection expressions are evaluated in the outer scope, before row bindings. */
function genCollection(items: SExpr | undefined, ctx: TsxCtx): string {
  const expression = items !== undefined ? genExpr(items, ctx) : '[]';
  // TypeScript rejects ?? when its left operand is an array literal.
  const literal = items === undefined || (isList(items) && (items.items.length === 0 || opName(items) === 'arr'));
  return literal ? `(${expression})` : `((${expression}) ?? [])`;
}

function genEach(node: ListNode, ctx: TsxCtx, indent: number): string {
  const parts = splitList(node);
  const varAtom = parts.rest[0];
  const items = parts.rest[1];
  const body = parts.rest.slice(2);
  const varName = varAtom !== undefined && varAtom.kind === 'ident' ? genBindingName(varAtom.name, ctx.bindings) : 'item';

  const inner: TsxCtx = {
    ...ctx,
    bindings: new Map(ctx.bindings),
    typeScope: new Map(ctx.typeScope),
  };
  const itemInfo = items === undefined ? { type: 'unknown' as const } : elementInfo(inferInfo(items, ctx.typeScope, ctx.app.tables));
  if (varAtom !== undefined && varAtom.kind === 'ident') {
    inner.typeScope.set(varAtom.name, bindingFromInfo('eachvar', itemInfo));
    inner.bindings.set(varAtom.name, { kind: 'eachvar', js: varName });
  }
  inner.bindings.set('index', { kind: 'eachvar', js: 'index' });
  inner.typeScope.set('index', bindingFromInfo('eachvar', { type: 'number' }));

  // Key: explicit :key, else a child's :id expression, else the index.
  let keyExpr: string | undefined;
  const keyProp = parts.props.get('key')?.value;
  if (keyProp !== undefined) keyExpr = genExpr(keyProp, inner);
  const first = body[0];
  if (keyExpr === undefined && body.length === 1 && first !== undefined && isList(first)) {
    const childId = splitList(first).props.get('id')?.value;
    if (childId !== undefined && childId.kind !== 'string') keyExpr = genExpr(childId, inner);
  }
  if (keyExpr === undefined) keyExpr = 'index';

  const collection = genCollection(items, ctx);
  const head = `{${collection}.map((${varName}: ${typeScriptType(itemInfo, ctx.app.tables)}, index: number) => (`;

  let bodyLines: string[];
  if (body.length === 1 && first !== undefined && isList(first) && lookupOp(opName(first) ?? '')?.category !== 'composition') {
    bodyLines = [pad(indent + 2) + genElement(first, inner, indent + 2, `key={${keyExpr}}`)];
  } else {
    ctx.uses.fragment = true;
    bodyLines = [
      pad(indent + 2) + `<__grhmFragment key={${keyExpr}}>`,
      ...genChildrenLines(body, inner, indent + 4),
      pad(indent + 2) + '</__grhmFragment>',
    ];
  }
  return head + '\n' + bodyLines.join('\n') + '\n' + pad(indent) + '))}';
}

function genIf(node: ListNode, ctx: TsxCtx, indent: number): string {
  const parts = splitList(node);
  const cond = parts.rest[0];
  const thenBranch = parts.rest[1];
  const elseBranch = parts.rest[2];
  const condExpr = cond !== undefined ? genExpr(cond, ctx) : 'false';
  const lines: string[] = [`{(${condExpr}) ? (`];
  lines.push(pad(indent + 2) + (thenBranch !== undefined ? genChildExpr(thenBranch, ctx, indent + 2) : 'null'));
  if (elseBranch !== undefined) {
    lines.push(pad(indent) + ') : (');
    lines.push(pad(indent + 2) + genChildExpr(elseBranch, ctx, indent + 2));
    lines.push(pad(indent) + ')}');
  } else {
    lines.push(pad(indent) + ') : null}');
  }
  return lines.join('\n');
}

function genWhen(node: ListNode, ctx: TsxCtx, indent: number): string {
  const parts = splitList(node);
  const cond = parts.rest[0];
  const body = parts.rest.slice(1);
  const condExpr = cond !== undefined ? genExpr(cond, ctx) : 'false';
  const lines: string[] = [`{(${condExpr}) ? (`];
  if (body.length === 1 && body[0] !== undefined) {
    lines.push(pad(indent + 2) + genChildExpr(body[0], ctx, indent + 2));
  } else {
    lines.push(pad(indent + 2) + '<>');
    lines.push(...genChildrenLines(body, ctx, indent + 4));
    lines.push(pad(indent + 2) + '</>');
  }
  lines.push(pad(indent) + ') : null}');
  return lines.join('\n');
}

/** A branch value: an element, or a nested composition rendered bare. */
function genChildExpr(e: SExpr, ctx: TsxCtx, indent: number): string {
  if (!isList(e)) return genExpr(e, ctx);
  const op = opName(e);
  if (op === 'each' || op === 'if' || op === 'when') {
    // Nested composition inside a branch: render inside a fragment.
    return '<>' + genChild(e, ctx, indent) + '</>';
  }
  return genElement(e, ctx, indent);
}

function genInstance(node: ListNode, ctx: TsxCtx, indent: number, keyAttr?: string): string {
  const op = opName(node) ?? '';
  const component = ctx.app.components.get(op);
  const name = pascalCase(op);
  if (!ctx.sameFileComponents.has(name)) ctx.uses.components.add(name);

  const parts = splitList(node);
  const attrs: string[] = [];
  if (keyAttr !== undefined) attrs.push(keyAttr);
  for (const [propName, entry] of parts.props) {
    if (propName === 'id') continue;
    const decl = component?.props.find((p) => p.name === propName);
    const jsName = camelCase(propName);
    if (decl?.type === 'action') {
      if (entry.value.kind === 'ident' && ctx.bindings.has(entry.value.name)) {
        attrs.push(`${jsName}={${genExpr(entry.value, ctx)}}`);
      } else {
        attrs.push(`${jsName}={${genHandler([entry.value], ctx)}}`);
      }
    } else {
      attrs.push(`${jsName}${attrValue(genExpr(entry.value, ctx))}`);
    }
  }

  const children = parts.rest;
  if (children.length === 0) return openTag(name, attrs, true);
  const open = openTag(name, attrs, false);
  const childLines = genChildrenLines(children, ctx, indent + 2);
  return withChildrenLines(open, childLines, `</${name}>`, indent);
}

export function genElement(node: ListNode, ctx: TsxCtx, indent: number, keyAttr?: string): string {
  const op = opName(node) ?? '';
  if (ctx.app.components.has(op)) {
    return genInstance(node, ctx, indent, keyAttr);
  }
  const schema = lookupOp(op);
  if (schema === undefined) return `{/* unknown op ${op} */}`;

  const parts = splitList(node);
  const { events, children } = partitionChildren(parts.rest);
  const base: string[] = [];
  if (keyAttr !== undefined) base.push(keyAttr);

  switch (schema.name) {
    case 'vstack':
    case 'hstack':
    case 'grid':
    case 'section':
    case 'scroll': {
      const tag = schema.name === 'section' ? 'section' : 'div';
      const attrs = [...base, ...styleAttrs(node, schema, ctx, []), dataG(node.id), ...eventAttrs(events, ctx)];
      return withChildrenLines(openTag(tag, attrs, false), genChildrenLines(children, ctx, indent + 2), `</${tag}>`, indent);
    }
    case 'card': {
      const attrs = [...base, ...styleAttrs(node, schema, ctx, ['g-card']), dataG(node.id), ...eventAttrs(events, ctx)];
      return withChildrenLines(openTag('div', attrs, false), genChildrenLines(children, ctx, indent + 2), '</div>', indent);
    }
    case 'spacer': {
      const attrs = [...base, ...styleAttrs(node, schema, ctx, []), dataG(node.id)];
      return openTag('div', attrs, true);
    }
    case 'list': {
      const attrs = [...base, ...styleAttrs(node, schema, ctx, []), dataG(node.id)];
      return withChildrenLines(openTag('ul', attrs, false), genChildrenLines(children, ctx, indent + 2, true), '</ul>', indent);
    }
    case 'text': {
      const attrs = [...base, ...styleAttrs(node, schema, ctx, []), dataG(node.id), ...eventAttrs(events, ctx)];
      return openTag('span', attrs, false) + textParts(children, ctx) + '</span>';
    }
    case 'heading': {
      const levelProp = parts.props.get('level')?.value;
      const level = levelProp !== undefined && levelProp.kind === 'number' ? Math.min(6, Math.max(1, levelProp.value)) : 1;
      const tag = `h${level}`;
      const attrs = [...base, ...styleAttrs(node, schema, ctx, []), dataG(node.id)];
      return openTag(tag, attrs, false) + textParts(children, ctx) + `</${tag}>`;
    }
    case 'image': {
      const src = children[0];
      const alt = parts.props.get('alt')?.value;
      const attrs = [
        ...base,
        `src${attrValue(src !== undefined ? genExpr(src, ctx) : '""')}`,
        `alt${attrValue(alt !== undefined ? genExpr(alt, ctx) : '""')}`,
        ...styleAttrs(node, schema, ctx, []),
        dataG(node.id),
      ];
      return openTag('img', attrs, true);
    }
    case 'link': {
      const to = parts.props.get('to')?.value;
      let href = '"/"';
      if (to !== undefined && to.kind === 'string') href = JSON.stringify(to.value);
      else if (to !== undefined) href = genPathTemplate(to, ctx);
      // History routing: intercept the click and pushState instead of reloading.
      ctx.uses.navigate = true;
      ctx.uses.mouseEvent = true;
      const onClick = `onClick={(__grhmEvent: MouseEvent<HTMLAnchorElement>) => { if (__grhmEvent.defaultPrevented || __grhmEvent.button !== 0 || __grhmEvent.metaKey || __grhmEvent.ctrlKey || __grhmEvent.shiftKey || __grhmEvent.altKey) return; __grhmEvent.preventDefault(); navigate(${href}); }}`;
      const attrs = [...base, `href${attrValue(href)}`, onClick, ...styleAttrs(node, schema, ctx, []), dataG(node.id)];
      const inline = children.every((c) => !isList(c));
      if (inline) return openTag('a', attrs, false) + textParts(children, ctx) + '</a>';
      return withChildrenLines(openTag('a', attrs, false), genChildrenLines(children, ctx, indent + 2), '</a>', indent);
    }
    case 'money': {
      ctx.uses.fmtMoney = true;
      const amount = children[0];
      const currency = parts.props.get('currency')?.value;
      const currencyExpr = currency !== undefined ? genExpr(currency, ctx) : '"USD"';
      const attrs = [...base, ...styleAttrs(node, schema, ctx, []), dataG(node.id)];
      const amountExpr = amount !== undefined ? genExpr(amount, ctx) : '0';
      return openTag('span', attrs, false) + `{fmtMoney(${amountExpr}, ${currencyExpr})}` + '</span>';
    }
    case 'button': {
      const variant = parts.props.get('variant')?.value;
      const variantName = variant !== undefined && variant.kind === 'ident' ? variant.name : undefined;
      const classes = ['g-btn', ...(variantName !== undefined ? [`g-btn-${variantName}`] : [])];
      const disabled = parts.props.get('disabled')?.value;
      const attrs = [
        ...base,
        'type="button"',
        ...styleAttrs(node, schema, ctx, classes),
        dataG(node.id),
        ...eventAttrs(events, ctx),
        ...(disabled !== undefined ? [`disabled={${genExpr(disabled, ctx)}}`] : []),
      ];
      const inline = children.every((c) => !isList(c));
      if (inline) return openTag('button', attrs, false) + textParts(children, ctx) + '</button>';
      return withChildrenLines(openTag('button', attrs, false), genChildrenLines(children, ctx, indent + 2), '</button>', indent);
    }
    case 'form': {
      const submit = events.get('submit');
      const otherEvents = new Map(events);
      otherEvents.delete('submit');
      ctx.uses.formEvent = true;
      let onSubmit = 'onSubmit={(__grhmEvent: FormEvent) => __grhmEvent.preventDefault()}';
      if (submit !== undefined) {
        const stmts = splitList(submit).rest.map((a) => genAction(a, ctx));
        const prefix = stmts.some((s) => s.includes('await ')) ? 'async ' : '';
        onSubmit = `onSubmit={${prefix}(__grhmEvent: FormEvent) => { __grhmEvent.preventDefault(); ${actionStatements(stmts, ctx)} }}`;
      }
      const attrs = [...base, ...styleAttrs(node, schema, ctx, ['g-form']), dataG(node.id), onSubmit, ...eventAttrs(otherEvents, ctx)];
      return withChildrenLines(openTag('form', attrs, false), genChildrenLines(children, ctx, indent + 2), '</form>', indent);
    }
    case 'dialog': {
      const openRef = parts.props.get('open')?.value;
      const title = parts.props.get('title')?.value;
      const openExpr = openRef !== undefined ? genExpr(openRef, ctx) : 'false';
      const setter =
        openRef !== undefined && openRef.kind === 'ident'
          ? ctx.bindings.get(openRef.name)?.setter ?? 'set' + pascalCase(openRef.name)
          : '() => void';
      ctx.uses.mouseEvent = true;
      const panelAttrs = [
        ...base,
        ...styleAttrs(node, schema, ctx, ['g-dialog']),
        'role="dialog"',
        'aria-modal="true"',
        `aria-label={${title !== undefined ? `String(${genExpr(title, ctx)})` : '"Dialog"'}}`,
        dataG(node.id),
        'onClick={(__grhmEvent: MouseEvent<HTMLDivElement>) => __grhmEvent.stopPropagation()}',
      ];
      ctx.uses.dialog = true;
      const lines: string[] = [`{(${openExpr}) ? (`];
      lines.push(pad(indent + 2) + `<div className="g-dialog-backdrop" onClick={() => ${setter}(false)}>`);
      lines.push(pad(indent + 4) + `<DialogShell onClose={() => ${setter}(false)}>`);
      lines.push(pad(indent + 6) + openTag('div', panelAttrs, false));
      lines.push(pad(indent + 8) + '<div className="g-dialog-head">');
      if (title !== undefined) lines.push(pad(indent + 10) + `<h2>{${genExpr(title, ctx)}}</h2>`);
      lines.push(
        pad(indent + 10) +
          `<button type="button" className="g-dialog-x" aria-label="Close dialog" onClick={() => ${setter}(false)}>{"\\u00d7"}</button>`,
      );
      lines.push(pad(indent + 8) + '</div>');
      lines.push(...genChildrenLines(children, ctx, indent + 8));
      lines.push(pad(indent + 6) + '</div>');
      lines.push(pad(indent + 4) + '</DialogShell>');
      lines.push(pad(indent + 2) + '</div>');
      lines.push(pad(indent) + ') : null}');
      return lines.join('\n');
    }
    case 'tabs': {
      const valueRef = parts.props.get('value')?.value;
      let val: string;
      let setter: string;
      if (valueRef !== undefined && valueRef.kind === 'ident') {
        val = genExpr(valueRef, ctx);
        setter = ctx.bindings.get(valueRef.name)?.setter ?? 'set' + pascalCase(valueRef.name);
      } else {
        const hook = hookName(node.id);
        val = hook;
        setter = 'set' + pascalCase(hook);
        ctx.uses.useState = true;
        ctx.synthHooks.push(`  const [${hook}, ${setter}] = useState<number>(0);`);
      }
      const tabs = children.filter((c): c is ListNode => isList(c) && opName(c) === 'tab');
      const tabId = hookName(node.id) + '_id';
      ctx.uses.useId = true;
      ctx.uses.tabs = true;
      ctx.synthHooks.push(`  const ${tabId} = __grhmUseId();`);
      const attrs = [...base, ...styleAttrs(node, schema, ctx, ['g-tabs']), dataG(node.id)];
      const lines: string[] = [openTag('div', attrs, false)];
      lines.push(pad(indent + 2) + `<div className="g-tablist" role="tablist" onKeyDown={(__grhmEvent) => __grhmTabKeyDown(__grhmEvent, ${setter})}>`);
      tabs.forEach((tab, i) => {
        const label = splitList(tab).rest[0];
        const labelJsx = label !== undefined ? textParts([label], ctx) : '';
        lines.push(
          pad(indent + 4) +
            `<button type="button" role="tab" id={${tabId} + '-tab-${i}'} aria-controls={${tabId} + '-panel-${i}'} tabIndex={${val} === ${i} ? 0 : -1} aria-selected={${val} === ${i}} className={${val} === ${i} ? 'g-tab g-tab-on' : 'g-tab'} onClick={() => ${setter}(${i})}>` +
            labelJsx +
            '</button>',
        );
      });
      lines.push(pad(indent + 2) + '</div>');
      tabs.forEach((tab, i) => {
        const body = splitList(tab).rest.slice(1);
        lines.push(pad(indent + 2) + `<div className="g-tabpanel" role="tabpanel" id={${tabId} + '-panel-${i}'} aria-labelledby={${tabId} + '-tab-${i}'} tabIndex={0} hidden={${val} !== ${i}} ${dataG(tab.id)}>`);
        lines.push(pad(indent + 4) + `{(${val} === ${i}) ? (<>`);
        lines.push(...genChildrenLines(body, ctx, indent + 6));
        lines.push(pad(indent + 4) + '</>) : null}');
        lines.push(pad(indent + 2) + '</div>');
      });
      lines.push(pad(indent) + '</div>');
      return lines.join('\n');
    }
    case 'menu': {
      const label = children[0];
      const items = children.slice(1).filter((c): c is ListNode => isList(c) && opName(c) === 'item');
      const hook = hookName(node.id);
      ctx.uses.menu = true;
      ctx.synthHooks.push(`  const ${hook} = __grhmUseMenu();`);
      const attrs = [...base, ...styleAttrs(node, schema, ctx, ['g-menu']), dataG(node.id), `{...${hook}.rootProps}`];
      const lines: string[] = [openTag('div', attrs, false)];
      lines.push(
        pad(indent + 2) +
          `<button type="button" className="g-btn" {...${hook}.triggerProps}>` +
          (label !== undefined ? textParts([label], ctx) : '') +
          '</button>',
      );
      lines.push(pad(indent + 2) + `{(${hook}.open) ? (`);
      lines.push(pad(indent + 4) + `<div className="g-menu-list" {...${hook}.menuProps}>`);
      for (const item of items) {
        const itemParts = splitList(item);
        const itemLabel = itemParts.rest[0];
        const stmts = itemParts.rest.slice(1).map((a) => genAction(a, ctx));
        const prefix = stmts.some((s) => s.includes('await ')) ? 'async ' : '';
        const handler = `${prefix}() => { ${hook}.close(); ${actionStatements(stmts, ctx)} }`;
        lines.push(
          pad(indent + 6) +
            `<button type="button" role="menuitem" tabIndex={-1} className="g-menu-item" ${dataG(item.id)} onClick={${handler}}>` +
            (itemLabel !== undefined ? textParts([itemLabel], ctx) : '') +
            '</button>',
        );
      }
      lines.push(pad(indent + 4) + '</div>');
      lines.push(pad(indent + 2) + ') : null}');
      lines.push(pad(indent) + '</div>');
      return lines.join('\n');
    }
    case 'table': {
      const varAtom = parts.rest[0];
      const items = parts.rest[1];
      const cols = parts.rest.slice(2).filter((c): c is ListNode => isList(c) && opName(c) === 'col');
      const rowVar = varAtom !== undefined && varAtom.kind === 'ident' ? genBindingName(varAtom.name, ctx.bindings) : 'row';
      const inner: TsxCtx = { ...ctx, bindings: new Map(ctx.bindings) };
      if (varAtom !== undefined && varAtom.kind === 'ident') {
        inner.bindings.set(varAtom.name, { kind: 'eachvar', js: rowVar });
      }
      inner.bindings.set('index', { kind: 'eachvar', js: 'index' });
  inner.typeScope.set('index', bindingFromInfo('eachvar', { type: 'number' }));
      const collection = genCollection(items, ctx);
      const attrs = [...base, ...styleAttrs(node, schema, ctx, ['g-table']), dataG(node.id)];
      const lines: string[] = [openTag('table', attrs, false)];
      lines.push(pad(indent + 2) + '<thead>');
      lines.push(pad(indent + 4) + '<tr>');
      for (const col of cols) {
        const header = splitList(col).rest[0];
        lines.push(pad(indent + 6) + '<th>' + (header !== undefined ? textParts([header], ctx) : '') + '</th>');
      }
      lines.push(pad(indent + 4) + '</tr>');
      lines.push(pad(indent + 2) + '</thead>');
      lines.push(pad(indent + 2) + '<tbody>');
      lines.push(pad(indent + 4) + `{${collection}.map((${rowVar}: any, index: number) => (`);
      lines.push(pad(indent + 6) + '<tr key={index}>');
      for (const col of cols) {
        const cells = splitList(col).rest.slice(1);
        const simple = cells.every((c) => !isList(c));
        if (simple) {
          lines.push(pad(indent + 8) + `<td ${dataG(col.id)}>` + textParts(cells, inner) + '</td>');
        } else {
          lines.push(pad(indent + 8) + `<td ${dataG(col.id)}>`);
          lines.push(...genChildrenLines(cells, inner, indent + 10));
          lines.push(pad(indent + 8) + '</td>');
        }
      }
      lines.push(pad(indent + 6) + '</tr>');
      lines.push(pad(indent + 4) + '))}');
      lines.push(pad(indent + 2) + '</tbody>');
      lines.push(pad(indent) + '</table>');
      return lines.join('\n');
    }
    case 'input': {
      const valueRef = parts.props.get('value')?.value;
      const placeholder = parts.props.get('placeholder')?.value;
      const typeProp = parts.props.get('type')?.value;
      const label = parts.props.get('label')?.value;
      const required = parts.props.get('required')?.value;
      const errorProp = parts.props.get('error')?.value;
      const typeName = typeProp?.kind === 'ident' ? typeProp.name : typeProp?.kind === 'string' ? typeProp.value : undefined;
      const attrs = [...base, ...styleAttrs(node, schema, ctx, ['g-input'])];
      if (typeName !== undefined) attrs.push(`type=${JSON.stringify(typeName)}`);
      if (required !== undefined && !(required.kind === 'boolean' && !required.value)) {
        attrs.push(required.kind === 'boolean' ? 'required' : `required={${genExpr(required, ctx)}}`);
      }
      // Native constraint validation attributes.
      const pattern = parts.props.get('pattern')?.value;
      if (pattern !== undefined) attrs.push(`pattern${attrValue(genExpr(pattern, ctx))}`);
      const min = parts.props.get('min')?.value;
      if (min !== undefined) attrs.push(`min={${genExpr(min, ctx)}}`);
      const max = parts.props.get('max')?.value;
      if (max !== undefined) attrs.push(`max={${genExpr(max, ctx)}}`);
      const minLen = parts.props.get('min-len')?.value;
      if (minLen !== undefined) attrs.push(`minLength={${genExpr(minLen, ctx)}}`);
      const maxLen = parts.props.get('max-len')?.value;
      if (maxLen !== undefined) attrs.push(`maxLength={${genExpr(maxLen, ctx)}}`);
      if (errorProp !== undefined) attrs.push(`aria-invalid={Boolean(${genExpr(errorProp, ctx)})}`);
      if (placeholder !== undefined) attrs.push(`placeholder${attrValue(genExpr(placeholder, ctx))}`);
      if (valueRef !== undefined && valueRef.kind === 'ident') {
        attrs.push(`value={${genExpr(valueRef, ctx)}}`);
        const explicit = events.get('change');
        if (explicit !== undefined) {
          attrs.push(...eventAttrs(events, ctx));
        } else {
          const setter = ctx.bindings.get(valueRef.name)?.setter ?? 'set' + pascalCase(valueRef.name);
          ctx.uses.changeEvent = true;
          const nextValue = typeName === 'number' ? '__grhmEvent.target.valueAsNumber' : '__grhmEvent.target.value';
          attrs.push(`onChange={(__grhmEvent: ChangeEvent<HTMLInputElement>) => ${setter}(${nextValue})}`);
        }
      } else {
        attrs.push(...eventAttrs(events, ctx));
      }
      const input = openTag('input', [...attrs, dataG(node.id)], true);
      const errorLine =
        errorProp !== undefined
          ? `{(${genExpr(errorProp, ctx)}) ? <span className="g-input-error" role="alert">{${genExpr(errorProp, ctx)}}</span> : null}`
          : undefined;
      if (label !== undefined || errorLine !== undefined) {
        const inner = [
          ...(label !== undefined ? [pad(indent + 2) + `<span>{${genExpr(label, ctx)}}</span>`] : []),
          pad(indent + 2) + input,
          ...(errorLine !== undefined ? [pad(indent + 2) + errorLine] : []),
        ];
        return withChildrenLines(openTag('label', ['className="g-field"'], false), inner, '</label>', indent);
      }
      return input;
    }
    case 'file-input': {
      const toRef = parts.props.get('to')?.value;
      const label = parts.props.get('label')?.value;
      const attrs = [...base, ...styleAttrs(node, schema, ctx, ['g-input']), 'type="file"'];
      if (toRef !== undefined && toRef.kind === 'ident') {
        const setter = ctx.bindings.get(toRef.name)?.setter ?? 'set' + pascalCase(toRef.name);
        ctx.uses.upload = true;
        ctx.uses.toast = true;
        ctx.uses.changeEvent = true;
        attrs.push(
          `onChange={(__grhmEvent: ChangeEvent<HTMLInputElement>) => { const file = __grhmEvent.target.files?.[0]; if (file) uploadFile(file).then(${setter}).catch((err: unknown) => showToast(err instanceof Error ? err.message : String(err), 'error')); }}`,
        );
      }
      const input = openTag('input', [...attrs, dataG(node.id)], true);
      if (label !== undefined) {
        const inner = [pad(indent + 2) + `<span>{${genExpr(label, ctx)}}</span>`, pad(indent + 2) + input];
        return withChildrenLines(openTag('label', ['className="g-field"'], false), inner, '</label>', indent);
      }
      return input;
    }
    case 'skeleton': {
      const linesProp = parts.props.get('lines')?.value;
      const count = linesProp !== undefined && linesProp.kind === 'number' ? Math.max(1, Math.floor(linesProp.value)) : 3;
      const attrs = [...base, ...styleAttrs(node, schema, ctx, ['g-skeleton']), 'aria-hidden="true"', dataG(node.id)];
      const bars: string[] = [];
      for (let i = 0; i < count; i += 1) {
        bars.push(pad(indent + 2) + '<div className="g-skeleton-bar" />');
      }
      return withChildrenLines(openTag('div', attrs, false), bars, '</div>', indent);
    }
    case 'checkbox': {
      const checkedRef = parts.props.get('checked')?.value;
      const label = parts.props.get('label')?.value;
      const attrs = [...base, 'type="checkbox"'];
      if (checkedRef !== undefined && checkedRef.kind === 'ident') {
        attrs.push(`checked={${genExpr(checkedRef, ctx)}}`);
        const explicit = events.get('change');
        if (explicit !== undefined) {
          attrs.push(...eventAttrs(events, ctx));
        } else {
          const setter = ctx.bindings.get(checkedRef.name)?.setter ?? 'set' + pascalCase(checkedRef.name);
          ctx.uses.changeEvent = true;
          attrs.push(`onChange={(__grhmEvent: ChangeEvent<HTMLInputElement>) => ${setter}(__grhmEvent.target.checked)}`);
        }
      } else {
        attrs.push(...eventAttrs(events, ctx));
      }
      const labelLine = label !== undefined ? pad(indent + 2) + `<span>{${genExpr(label, ctx)}}</span>` : undefined;
      return withChildrenLines(
        openTag('label', ['className="g-check"', dataG(node.id)], false),
        [pad(indent + 2) + openTag('input', attrs, true), ...(labelLine !== undefined ? [labelLine] : [])],
        '</label>',
        indent,
      );
    }
    case 'select': {
      const valueRef = parts.props.get('value')?.value;
      const options = parts.props.get('options')?.value;
      const label = parts.props.get('label')?.value;
      const attrs = [...base, ...styleAttrs(node, schema, ctx, ['g-select'])];
      if (valueRef !== undefined && valueRef.kind === 'ident') {
        attrs.push(`value={${genExpr(valueRef, ctx)}}`);
        const explicit = events.get('change');
        if (explicit !== undefined) {
          attrs.push(...eventAttrs(events, ctx));
        } else {
          const setter = ctx.bindings.get(valueRef.name)?.setter ?? 'set' + pascalCase(valueRef.name);
          ctx.uses.changeEvent = true;
          attrs.push(`onChange={(__grhmEvent: ChangeEvent<HTMLSelectElement>) => ${setter}(__grhmEvent.target.value)}`);
        }
      }
      const optionsExpr = options !== undefined ? genExpr(options, ctx) : '[]';
      const select = withChildrenLines(
        openTag('select', [...attrs, dataG(node.id)], false),
        [
          pad(indent + 2) + `{((${optionsExpr}) ?? []).map((opt: any) => (`,
          pad(indent + 4) + '<option key={String(opt)} value={String(opt)}>{String(opt)}</option>',
          pad(indent + 2) + '))}',
        ],
        '</select>',
        indent,
      );
      if (label !== undefined) {
        return withChildrenLines(
          openTag('label', ['className="g-field"'], false),
          [pad(indent + 2) + `<span>{${genExpr(label, ctx)}}</span>`, pad(indent + 2) + select],
          '</label>',
          indent,
        );
      }
      return select;
    }
    case 'slot':
      return '{__grhmProps.children}';
    case 'each':
      return genEach(node, ctx, indent);
    case 'if':
      return genIf(node, ctx, indent);
    case 'when':
      return genWhen(node, ctx, indent);
    default:
      return `{/* unsupported op ${schema.name} */}`;
  }
}
