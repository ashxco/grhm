import { AppModel } from '../analyze.js';
import { ListNode, SExpr, isList, opName, splitList } from '../ast.js';
import { lookupOp, propType, BREAKPOINTS } from '../schema.js';

/**
 * Deterministic static CSS generation. Every element node with literal style
 * properties (or structural layout semantics) gets a `.g-<nodeId>` rule.
 * Expression-valued style props fall back to inline styles in the TSX layer.
 */

/** GRHM style prop to CSS property (kebab) mapping. */
export const STYLE_TO_CSS: Record<string, string> = {
  pad: 'padding',
  gap: 'gap',
  margin: 'margin',
  bg: 'background',
  color: 'color',
  radius: 'border-radius',
  size: 'font-size',
  weight: 'font-weight',
  align: 'align-items',
  justify: 'justify-content',
  w: 'width',
  h: 'height',
  'max-w': 'max-width',
  grow: 'flex',
  wrap: 'flex-wrap',
  border: 'border',
  shadow: 'box-shadow',
};

/** GRHM style prop to React inline-style key. */
export const STYLE_TO_JS: Record<string, string> = {
  pad: 'padding',
  gap: 'gap',
  margin: 'margin',
  bg: 'background',
  color: 'color',
  radius: 'borderRadius',
  size: 'fontSize',
  weight: 'fontWeight',
  align: 'alignItems',
  justify: 'justifyContent',
  w: 'width',
  h: 'height',
  'max-w': 'maxWidth',
  grow: 'flex',
  wrap: 'flexWrap',
  border: 'border',
  shadow: 'boxShadow',
};

const WEIGHT_MAP: Record<string, string> = { normal: '400', medium: '500', semibold: '600', bold: '700' };
const ALIGN_MAP: Record<string, string> = {
  start: 'flex-start',
  end: 'flex-end',
  center: 'center',
  stretch: 'stretch',
  baseline: 'baseline',
};
const JUSTIFY_MAP: Record<string, string> = {
  start: 'flex-start',
  end: 'flex-end',
  center: 'center',
  between: 'space-between',
  around: 'space-around',
};
const SHADOW_MAP: Record<string, string> = {
  sm: '0 1px 2px rgba(0,0,0,0.08)',
  md: '0 4px 12px rgba(0,0,0,0.10)',
  lg: '0 12px 32px rgba(0,0,0,0.14)',
};

/** True when a style prop value can be lowered to static CSS. */
export function isStyleLiteral(value: SExpr): boolean {
  if (value.kind === 'string' || value.kind === 'number' || value.kind === 'boolean') return true;
  if (value.kind === 'ident' && value.name.startsWith('$')) return true;
  if (value.kind === 'ident') return false;
  return false;
}

/** CSS text for a literal style value in a given prop. */
export function cssValue(prop: string, value: SExpr): string | undefined {
  if (value.kind === 'ident' && value.name.startsWith('$')) {
    return `var(--${value.name.slice(1)})`;
  }
  const raw =
    value.kind === 'number' ? value.value : value.kind === 'string' ? value.value : value.kind === 'boolean' ? value.value : undefined;
  if (raw === undefined) return undefined;
  switch (prop) {
    case 'weight':
      return WEIGHT_MAP[String(raw)] ?? String(raw);
    case 'align':
      return ALIGN_MAP[String(raw)] ?? String(raw);
    case 'justify':
      return JUSTIFY_MAP[String(raw)] ?? String(raw);
    case 'shadow':
      return SHADOW_MAP[String(raw)] ?? String(raw);
    case 'grow':
      return raw === true ? '1 1 0%' : '0 1 auto';
    case 'wrap':
      return raw === true ? 'wrap' : 'nowrap';
    case 'border':
      return `1px solid ${String(raw)}`;
    default:
      return typeof raw === 'number' ? `${raw}px` : String(raw);
  }
}

/** enum idents (weight/align/justify/shadow) also count as literals. */
export function isStyleValueStatic(base: string, value: SExpr): boolean {
  if (isStyleLiteral(value)) return true;
  if (value.kind === 'ident' && ['weight', 'align', 'justify', 'shadow', 'fit', 'dir', 'variant'].includes(base)) return true;
  return false;
}

function enumText(value: SExpr): string | undefined {
  if (value.kind === 'ident') return value.name;
  if (value.kind === 'string') return value.value;
  return undefined;
}

interface Rule {
  selector: string;
  decls: string[];
}

/**
 * A collision-free CSS class token for an arbitrary semantic node ID.
 * Explicit :id strings are intentionally user-facing and may contain spaces,
 * quotes, or CSS punctuation, so they must never be used as selectors/classes
 * verbatim. Encoding every Unicode code point keeps the mapping deterministic
 * and injective while limiting generated syntax to [a-f0-9-].
 */
function nodeClassName(nodeId: string): string {
  const encoded = Array.from(nodeId, (ch) => ch.codePointAt(0)?.toString(16) ?? '').join('-');
  return `g-i-${encoded === '' ? 'empty' : encoded}`;
}

function nodeSelector(nodeId: string): string {
  return `.${nodeClassName(nodeId)}`;
}

function structuralDecls(node: ListNode): string[] {
  const op = opName(node);
  const schema = op !== undefined ? lookupOp(op) : undefined;
  const name = schema?.name;
  const parts = splitList(node);
  switch (name) {
    case 'vstack':
    case 'section':
      return ['display: flex', 'flex-direction: column'];
    case 'hstack':
      return ['display: flex', 'flex-direction: row', 'align-items: center'];
    case 'grid': {
      const cols = parts.props.get('cols')?.value;
      const n = cols !== undefined && cols.kind === 'number' ? cols.value : 2;
      return ['display: grid', `grid-template-columns: repeat(${n}, minmax(0, 1fr))`];
    }
    case 'scroll': {
      const dir = enumText(parts.props.get('dir')?.value ?? { kind: 'ident', name: 'y', span: node.span });
      return dir === 'x' ? ['overflow-x: auto'] : ['overflow-y: auto'];
    }
    case 'spacer': {
      const size = parts.rest[0];
      if (size !== undefined && size.kind === 'number') return [`height: ${size.value}px`, 'flex-shrink: 0'];
      return ['flex: 1 1 0%'];
    }
    case 'image': {
      const fit = parts.props.get('fit')?.value;
      const fitText = fit !== undefined ? enumText(fit) : undefined;
      return fitText !== undefined ? [`object-fit: ${fitText}`, 'width: 100%'] : [];
    }
    default:
      return [];
  }
}

const EASE_MAP: Record<string, string> = {
  linear: 'linear',
  ease: 'ease',
  'ease-in': 'ease-in',
  'ease-out': 'ease-out',
  'ease-in-out': 'ease-in-out',
  spring: 'cubic-bezier(0.22, 1, 0.36, 1)',
};

/** Maximum children covered by generated :stagger nth-child delay rules. */
const STAGGER_LIMIT = 12;

interface MotionRules {
  /** Keyframe names used (for emission). */
  kinds: string[];
  /** Rules that must sit behind the reduced-motion guard. */
  rules: Rule[];
}

/** Motion rules (entrance, stagger sequence, hover gesture) for one node. */
function motionRule(node: ListNode): MotionRules | undefined {
  const parts = splitList(node);
  const kinds: string[] = [];
  const rules: Rule[] = [];
  const selector = nodeSelector(node.id);

  const enter = parts.props.get('enter')?.value;
  const kind = enter !== undefined ? enumText(enter) : undefined;
  if (kind !== undefined && KEYFRAMES[kind] !== undefined) {
    const durProp = parts.props.get('dur')?.value;
    const delayProp = parts.props.get('delay')?.value;
    const easeProp = parts.props.get('ease')?.value;
    const staggerProp = parts.props.get('stagger')?.value;
    const dur = durProp !== undefined && durProp.kind === 'number' ? durProp.value : 300;
    const ease = EASE_MAP[easeProp !== undefined ? enumText(easeProp) ?? 'ease-out' : 'ease-out'] ?? 'ease-out';
    const baseDelay = delayProp !== undefined && delayProp.kind === 'number' ? delayProp.value : 0;
    const stagger = staggerProp !== undefined && staggerProp.kind === 'number' ? staggerProp.value : undefined;
    kinds.push(kind);
    if (stagger === undefined) {
      const decls = [`animation: g-${kind} ${dur}ms ${ease} both`];
      if (baseDelay > 0) decls.push(`animation-delay: ${baseDelay}ms`);
      rules.push({ selector, decls });
    } else {
      // Sequence: each direct child plays the enter animation, offset by :stagger.
      rules.push({ selector: `${selector} > *`, decls: [`animation: g-${kind} ${dur}ms ${ease} both`] });
      for (let i = 1; i <= STAGGER_LIMIT; i++) {
        rules.push({
          selector: `${selector} > :nth-child(${i})`,
          decls: [`animation-delay: ${baseDelay + (i - 1) * stagger}ms`],
        });
      }
    }
  }

  const hover = parts.props.get('hover')?.value;
  const gesture = hover !== undefined ? enumText(hover) : undefined;
  if (gesture !== undefined && HOVER_DECLS[gesture] !== undefined) {
    rules.push({ selector, decls: ['transition: transform 150ms ease, box-shadow 150ms ease, opacity 150ms ease'] });
    rules.push({ selector: `${selector}:hover, ${selector}:focus-visible`, decls: HOVER_DECLS[gesture] });
  }

  return rules.length > 0 ? { kinds, rules } : undefined;
}

const HOVER_DECLS: Record<string, string[]> = {
  lift: ['transform: translateY(-2px)', 'box-shadow: 0 6px 20px rgba(0,0,0,0.12)'],
  grow: ['transform: scale(1.03)'],
  dim: ['opacity: 0.75'],
};

const KEYFRAMES: Record<string, string> = {
  fade: '@keyframes g-fade { from { opacity: 0; } to { opacity: 1; } }',
  'fade-up': '@keyframes g-fade-up { from { opacity: 0; transform: translateY(12px); } to { opacity: 1; transform: none; } }',
  'fade-down': '@keyframes g-fade-down { from { opacity: 0; transform: translateY(-12px); } to { opacity: 1; transform: none; } }',
  'scale-in': '@keyframes g-scale-in { from { opacity: 0; transform: scale(0.95); } to { opacity: 1; transform: none; } }',
  'slide-left': '@keyframes g-slide-left { from { opacity: 0; transform: translateX(24px); } to { opacity: 1; transform: none; } }',
  'slide-right': '@keyframes g-slide-right { from { opacity: 0; transform: translateX(-24px); } to { opacity: 1; transform: none; } }',
};

function nodeRules(node: ListNode): { base: Rule | undefined; media: Map<string, Rule> } {
  const op = opName(node);
  const schema = op !== undefined ? lookupOp(op) : undefined;
  const media = new Map<string, Rule>();
  if (schema === undefined) return { base: undefined, media };

  const decls = structuralDecls(node);
  const parts = splitList(node);

  for (const [propName, entry] of parts.props) {
    const resolved = propType(schema, propName);
    if (resolved === undefined || resolved.base === 'id') continue;

    // Responsive grid columns are structural, not in STYLE_TO_CSS.
    if (resolved.base === 'cols' && resolved.media !== undefined) {
      const value = entry.value;
      if (value.kind === 'number') {
        const rule = media.get(resolved.media) ?? { selector: nodeSelector(node.id), decls: [] };
        rule.decls.push(`grid-template-columns: repeat(${value.value}, minmax(0, 1fr))`);
        media.set(resolved.media, rule);
      }
      continue;
    }

    const cssProp = STYLE_TO_CSS[resolved.base];
    if (cssProp === undefined) continue;
    if (!isStyleValueStatic(resolved.base, entry.value)) continue;
    const text = cssValue(resolved.base, entry.value);
    if (text === undefined) continue;

    if (resolved.media !== undefined) {
      const rule = media.get(resolved.media) ?? { selector: nodeSelector(node.id), decls: [] };
      rule.decls.push(`${cssProp}: ${text}`);
      media.set(resolved.media, rule);
    } else {
      decls.push(`${cssProp}: ${text}`);
    }
  }

  const base = decls.length > 0 ? { selector: nodeSelector(node.id), decls } : undefined;
  return { base, media };
}

const PREAMBLE = `/* Generated by grhm. Do not edit by hand. */
* { box-sizing: border-box; margin: 0; }
body {
  font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
  color: #18181b;
  background: #fafafa;
  line-height: 1.5;
}
img { max-width: 100%; display: block; }
a { color: inherit; }
ul { padding-left: 1.25rem; }
button { font: inherit; cursor: pointer; }
.g-btn {
  padding: 8px 16px;
  border-radius: 8px;
  border: 1px solid #d4d4d8;
  background: #ffffff;
}
.g-btn:hover { background: #f4f4f5; }
.g-btn-primary { background: #18181b; border-color: #18181b; color: #ffffff; }
.g-btn-primary:hover { background: #3f3f46; }
.g-btn-ghost { border-color: transparent; background: transparent; }
.g-card {
  background: #ffffff;
  border: 1px solid #e4e4e7;
  border-radius: 12px;
  padding: 16px;
  display: flex;
  flex-direction: column;
}
.g-input, .g-select {
  padding: 8px 12px;
  border: 1px solid #d4d4d8;
  border-radius: 8px;
  font: inherit;
  background: #ffffff;
}
.g-field { display: flex; flex-direction: column; gap: 4px; }
.g-check { display: flex; align-items: center; gap: 8px; }
.g-runtime-error, .g-notfound {
  padding: 16px;
  margin: 16px;
  border: 1px solid #fca5a5;
  border-radius: 8px;
  background: #fef2f2;
  color: #991b1b;
  font-family: ui-monospace, monospace;
}
.g-form { display: flex; flex-direction: column; gap: 12px; }
.g-dialog-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.4);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
}
.g-dialog {
  background: #ffffff;
  border-radius: 12px;
  padding: 20px;
  min-width: 320px;
  max-width: min(90vw, 560px);
  max-height: 85vh;
  overflow-y: auto;
  box-shadow: 0 24px 64px rgba(0, 0, 0, 0.24);
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.g-dialog-head { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
.g-dialog-x { border: none; background: transparent; font-size: 20px; line-height: 1; padding: 4px; }
.g-tabs { display: flex; flex-direction: column; gap: 12px; }
.g-tablist { display: flex; gap: 4px; border-bottom: 1px solid #e4e4e7; }
.g-tab {
  border: none;
  background: transparent;
  padding: 8px 14px;
  border-bottom: 2px solid transparent;
  color: #52525b;
}
.g-tab-on { border-bottom-color: #18181b; color: #18181b; font-weight: 600; }
.g-menu { position: relative; display: inline-flex; }
.g-menu-list {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  min-width: 160px;
  background: #ffffff;
  border: 1px solid #e4e4e7;
  border-radius: 8px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.12);
  display: flex;
  flex-direction: column;
  padding: 4px;
  z-index: 50;
}
.g-menu-item { border: none; background: transparent; text-align: left; padding: 8px 12px; border-radius: 6px; }
.g-menu-item:hover { background: #f4f4f5; }
.g-table { border-collapse: collapse; width: 100%; }
.g-table th, .g-table td {
  text-align: left;
  padding: 8px 12px;
  border-bottom: 1px solid #e4e4e7;
}
.g-table th { font-weight: 600; color: #52525b; }
.g-input-error { color: #b91c1c; font-size: 0.85em; }
.g-input[aria-invalid="true"] { border-color: #f87171; }
.g-loading { min-height: 40vh; }
.g-dialog-shell { display: contents; outline: none; }
.g-toasts {
  position: fixed;
  bottom: 16px;
  right: 16px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  z-index: 200;
}
.g-toast {
  padding: 10px 16px;
  border-radius: 8px;
  background: #18181b;
  color: #fafafa;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18);
  max-width: 360px;
}
.g-toast-success { background: #14532d; }
.g-toast-error { background: #7f1d1d; }
.g-skeleton { display: flex; flex-direction: column; gap: 8px; }
.g-skeleton-bar {
  height: 14px;
  border-radius: 6px;
  background: #e4e4e7;
}
.g-skeleton-bar:last-child { width: 60%; }
@media (prefers-reduced-motion: no-preference) {
  .g-skeleton-bar { animation: g-skeleton-pulse 1.4s ease-in-out infinite; }
}
@keyframes g-skeleton-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.45; }
}
`;

export interface CssResult {
  css: string;
  classFor: Map<string, string>;
}

export function genCss(app: AppModel): CssResult {
  const classFor = new Map<string, string>();
  const rules: Rule[] = [];
  const mediaRules = new Map<string, Rule[]>();
  const motionRules: Rule[] = [];
  const usedKeyframes = new Set<string>();

  const visit = (e: SExpr): void => {
    if (!isList(e)) return;
    const { base, media } = nodeRules(e);
    if (base !== undefined) {
      rules.push(base);
      classFor.set(e.id, nodeClassName(e.id));
    }
    for (const [query, rule] of media) {
      const bucket = mediaRules.get(query) ?? [];
      bucket.push(rule);
      mediaRules.set(query, bucket);
      classFor.set(e.id, nodeClassName(e.id));
    }
    const motion = motionRule(e);
    if (motion !== undefined) {
      motionRules.push(...motion.rules);
      for (const kind of motion.kinds) usedKeyframes.add(kind);
      classFor.set(e.id, nodeClassName(e.id));
    }
    for (const item of e.items) visit(item);
  };

  for (const page of app.pages) for (const e of page.body) visit(e);
  for (const [, component] of app.components) for (const e of component.body) visit(e);

  let css = PREAMBLE;
  if (app.tokens.size > 0) {
    css += ':root {\n';
    for (const [name, token] of app.tokens) css += `  --${name}: ${token.value};\n`;
    css += '}\n';
  }
  if (app.darkTokens.size > 0) {
    css += '@media (prefers-color-scheme: dark) {\n  :root {\n';
    for (const [name, token] of app.darkTokens) css += `    --${name}: ${token.value};\n`;
    css += '  }\n}\n';
  }
  for (const rule of rules) {
    css += `${rule.selector} {\n${rule.decls.map((d) => `  ${d};`).join('\n')}\n}\n`;
  }
  for (const [query, bucket] of mediaRules) {
    css += `@media ${query} {\n`;
    for (const rule of bucket) {
      css += `  ${rule.selector} {\n${rule.decls.map((d) => `    ${d};`).join('\n')}\n  }\n`;
    }
    css += '}\n';
  }
  if (motionRules.length > 0) {
    css += '@media (prefers-reduced-motion: no-preference) {\n';
    for (const rule of motionRules) {
      css += `  ${rule.selector} {\n${rule.decls.map((d) => `    ${d};`).join('\n')}\n  }\n`;
    }
    css += '}\n';
    for (const kind of [...usedKeyframes].sort()) {
      css += KEYFRAMES[kind] + '\n';
    }
  }
  return { css, classFor };
}

export { BREAKPOINTS };
