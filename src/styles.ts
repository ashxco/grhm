import { type AppModel } from './analyze.js';
import { type ListNode, type SExpr, isList, opName, splitList } from './ast.js';
import { type Diagnostic, makeDiag } from './diagnostics.js';

/** Native CSS names are intentionally open-ended, including vendor and custom properties. */
export function isCssProperty(name: string): boolean {
  return /^(?:--[A-Za-z_][\w-]*|-?[a-z][a-z0-9-]*)$/.test(name);
}

const UNITLESS = new Set([
  'animation-iteration-count', 'aspect-ratio', 'border-image-outset', 'border-image-slice',
  'border-image-width', 'box-flex', 'box-flex-group', 'box-ordinal-group', 'column-count',
  'columns', 'fill-opacity', 'flex', 'flex-grow', 'flex-negative', 'flex-order',
  'flex-positive', 'flex-shrink', 'flood-opacity', 'font-size-adjust', 'font-weight',
  'grid-area', 'grid-column', 'grid-column-end', 'grid-column-span', 'grid-column-start',
  'grid-row', 'grid-row-end', 'grid-row-span', 'grid-row-start', 'line-clamp',
  'line-height', 'opacity', 'order', 'orphans', 'scale', 'shape-image-threshold',
  'stop-opacity', 'stroke-dasharray', 'stroke-dashoffset', 'stroke-miterlimit',
  'stroke-opacity', 'stroke-width', 'tab-size', 'widows', 'z-index', 'zoom',
]);

/** Match React's numeric style convention; explicit CSS strings retain their units. */
export function nativeCssNumberHasUnit(property: string): boolean {
  return !property.startsWith('--') && !UNITLESS.has(property.replace(/^-(?:webkit|moz|ms|o)-/, ''));
}

export function cssPropertyToJS(property: string): string {
  if (property.startsWith('--')) return property;
  return property.replace(/^-ms-/, 'ms-').replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
}

export function isNativeStyleStatic(value: SExpr): boolean {
  return value.kind === 'string' || value.kind === 'number' || (value.kind === 'ident' && value.name.startsWith('$'));
}

export function nativeCssValue(property: string, value: SExpr): string | undefined {
  if (value.kind === 'ident' && value.name.startsWith('$')) return `var(--${value.name.slice(1)})`;
  if (value.kind === 'string') return value.value;
  if (value.kind === 'number') return `${value.value}${value.value !== 0 && nativeCssNumberHasUnit(property) ? 'px' : ''}`;
  return undefined;
}

export function isMotionProperty(property: string): boolean {
  return /^(?:-(?:webkit|moz|ms|o)-)?(?:animation|transition)(?:-|$)/.test(property) || property === 'scroll-behavior';
}

/** Injective node/property encoding used to carry dynamic motion into a guarded CSS rule. */
export function nativeStyleVariable(nodeId: string, property: string): string {
  const encode = (value: string): string => Array.from(value, (ch) => ch.codePointAt(0)!.toString(16)).join('-');
  return `--g-style-${encode(nodeId)}--${encode(property)}`;
}

/**
 * Validate a single CSS syntax fragment, never a stylesheet. Quoted delimiters
 * (e.g. a data URL or content string) are valid; unquoted block/declaration
 * delimiters, comments, unbalanced groups, and controls cannot escape a rule.
 * This is structural validation, not a browser CSS grammar or value checker.
 */
export function isSafeCssFragment(text: string): boolean {
  if (text.trim() === '' || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) return false;
  const stack: string[] = [];
  let quote = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === '\\') {
      if (i + 1 >= text.length || /[\r\n]/.test(text[i + 1]!)) return false;
      i++;
      continue;
    }
    if (quote !== '') {
      if (ch === quote) quote = '';
      else if (ch === '\n' || ch === '\r') return false;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === ';' || ch === '{' || ch === '}' || (ch === '/' && text[i + 1] === '*') || (ch === '*' && text[i + 1] === '/')) return false;
    if (ch === '(' || ch === '[') stack.push(ch);
    if (ch === ')' || ch === ']') {
      if (stack.pop() !== (ch === ')' ? '(' : '[')) return false;
    }
  }
  return quote === '' && stack.length === 0;
}

function styleError(node: ListNode, out: Diagnostic[], message: string, value: SExpr = node, field?: string, expected?: string): void {
  out.push(makeDiag('E121', 'error', message, {
    span: value.span, nodeId: node.id, op: opName(node), field,
    received: value.kind === 'string' ? value.value : value.kind === 'ident' ? value.name : value.kind,
    expected,
  }));
}

function checkDuplicates(node: ListNode, out: Diagnostic[]): void {
  const names = new Set<string>();
  for (const item of node.items) {
    if (item.kind !== 'keyword') continue;
    if (names.has(item.name)) styleError(node, out, `Duplicate CSS property ":${item.name}"`, item, item.name, 'one value per CSS property');
    names.add(item.name);
  }
  const dangling = splitList(node).danglingKeyword;
  if (dangling !== undefined) styleError(node, out, `CSS property ":${dangling.name}" is missing a value`, dangling, dangling.name, 'a CSS value');
}

function checkDeclarations(node: ListNode, app: AppModel, out: Diagnostic[], dynamic?: (value: SExpr, property: string) => void, skipId = true): void {
  checkDuplicates(node, out);
  for (const [property, { value, keyword }] of splitList(node).props) {
    if (property === 'id' && skipId) {
      if (value.kind !== 'string') styleError(node, out, ':id must be a string', value, 'id', 'string');
      continue;
    }
    if (!isCssProperty(property)) styleError(node, out, `Invalid CSS property ":${property}"`, keyword, property, 'a kebab-case CSS property or --custom-property');
    if (value.kind === 'ident' && value.name.startsWith('$')) {
      if (!app.tokens.has(value.name.slice(1))) out.push(makeDiag('E205', 'error', `Unknown design token "${value.name}"`, {
        span: value.span, nodeId: node.id, op: opName(node), field: property,
        received: value.name, expected: [...app.tokens.keys()].map((name) => '$' + name).join(' | '),
      }));
    } else if (value.kind === 'string') {
      if (!isSafeCssFragment(value.value)) styleError(node, out, `CSS property ":${property}" contains malformed or unsafe syntax`, value, property, 'a balanced CSS value without unquoted semicolons, braces, comments, or controls');
    } else if (value.kind === 'number') {
      if (!Number.isFinite(value.value)) styleError(node, out, 'CSS numbers must be finite', value, property, 'finite number');
    } else if (dynamic !== undefined && value.kind !== 'boolean' && value.kind !== 'null') dynamic(value, property);
    else styleError(node, out, `CSS property ":${property}" requires ${dynamic === undefined ? 'a static ' : 'a '}string, number, or $token`, value, property, dynamic === undefined ? 'literal CSS string, number, or $token' : 'string or number expression');
  }
}

/** Validate the explicit object shape so keys remain CSS syntax, not record fields. */
export function checkNativeStyle(value: SExpr, owner: ListNode, app: AppModel, out: Diagnostic[], dynamic?: (value: SExpr, property: string) => void): void {
  if (!isList(value) || opName(value) !== 'obj') {
    styleError(owner, out, ':css requires an (obj :css-property value ...) declaration', value, 'css', '(obj :property value ...)');
    return;
  }
  if (splitList(value).rest.length !== 0) styleError(owner, out, ':css contains positional values', value, 'css', 'keyword CSS properties only');
  checkDeclarations(value, app, out, dynamic, false);
}

const GROUPS = new Set(['stylesheet', 'media', 'supports', 'container', 'layer']);
const CHILD_FORMS = new Set([...GROUPS].filter((name) => name !== 'stylesheet').concat(['rule', 'keyframes', 'font-face']));
const KEYFRAME_NAME = /^(?!none$|initial$|inherit$|unset$|revert$|default$)-?[A-Za-z_][\w-]*$/;

/** Dedicated tree checking prevents declaration nodes from being interpreted as UI or expressions. */
export function checkStylesheets(sheets: readonly ListNode[], app: AppModel, out: Diagnostic[]): void {
  const names = new Set<string>();
  const visit = (node: ListNode): void => {
    const op = opName(node)!;
    const parts = splitList(node);
    if (op === 'rule' || op === 'frame' || op === 'font-face') {
      const selector = parts.rest[0];
      const count = op === 'font-face' ? 0 : 1;
      if (parts.rest.length !== count || (count === 1 && (selector?.kind !== 'string' || !isSafeCssFragment(selector.value)))) {
        styleError(node, out, `${op} requires ${count === 0 ? 'only keyword CSS declarations' : 'one balanced literal selector and keyword CSS declarations'}`, selector ?? node, undefined, op === 'font-face' ? '(font-face :font-family "..." :src "url(...)")' : `(${op} "selector" :property value ...)`);
      } else if (op === 'frame' && selector?.kind === 'string') {
        const valid = selector.value.split(',').every((part) => /^(?:from|to)$/.test(part.trim()) || (/^(?:\d+(?:\.\d+)?|\.\d+)%$/.test(part.trim()) && Number.parseFloat(part) <= 100));
        if (!valid) styleError(node, out, 'A keyframe selector must be from, to, or a percentage from 0% to 100%', selector, undefined, 'from | to | 0%..100% (comma-separated)');
      } else if (op === 'rule' && selector?.kind === 'string' && selector.value.trimStart().startsWith('@')) {
        styleError(node, out, 'Use a stylesheet group form for an at-rule', selector, undefined, 'an element selector');
      }
      checkDeclarations(node, app, out);
      return;
    }
    checkDuplicates(node, out);
    for (const [prop, entry] of parts.props) {
      if (prop !== 'id' || entry.value.kind !== 'string') styleError(node, out, `${op} does not accept ":${prop}"`, entry.keyword, prop, 'only an optional :id string');
    }
    const positional = op === 'stylesheet' ? 0 : 1;
    const arg = parts.rest[0];
    if (positional === 1) {
      const text = op === 'keyframes' && arg?.kind === 'ident' ? arg.name : arg?.kind === 'string' ? arg.value : undefined;
      if (text === undefined || !isSafeCssFragment(text) || (op === 'keyframes' && !KEYFRAME_NAME.test(text)) || (op === 'layer' && !/^[A-Za-z_][\w-]*(?:\.[A-Za-z_][\w-]*)*$/.test(text))) {
        styleError(node, out, `${op} requires a valid ${op === 'keyframes' ? 'animation name' : op === 'layer' ? 'layer name' : 'literal condition'}`, arg ?? node, undefined, op === 'keyframes' ? 'identifier' : 'CSS string');
      }
      if (op === 'keyframes' && text !== undefined) {
        if (names.has(text)) styleError(node, out, `Duplicate keyframes "${text}"`, arg, undefined, 'a unique keyframes name');
        names.add(text);
      }
    }
    for (const child of parts.rest.slice(positional)) {
      if (!isList(child) || (op === 'keyframes' ? opName(child) !== 'frame' : !CHILD_FORMS.has(opName(child) ?? ''))) {
        styleError(node, out, `${op} has an invalid child`, child, undefined, op === 'keyframes' ? '(frame "from|to|percentage" :property value ...)' : 'rule | media | supports | container | layer | font-face | keyframes');
      } else visit(child);
    }
  };
  for (const sheet of sheets) visit(sheet);
}
