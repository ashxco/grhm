import { IdentAtom, KeywordAtom, ListNode, SExpr, Span, StringAtom, opName } from './ast.js';
import { Fix, FixConfidence, TextEdit, editsConflict } from './diagnostics.js';
import { ColumnType, PropTypeName } from './schema.js';
import type { ValueType } from './typing.js';
import { editDistance, fnv1aHex, nearestAll } from './util.js';

/**
 * Builders for the machine-applicable `fixes` a diagnostic can carry. They
 * are pure, never read source text (offsets come from spans alone), and never
 * throw: `undefined` means "no fix" so a malformed edit can only cost the
 * author a quick fix, never the diagnostic itself.
 */

/** Edit covering `span`, or the [start, end) sub-range of it, carrying `span.file`. The only offset-producing primitive at checker sites. */
export function editAt(span: Span, text: string, start: number = span.start, end: number = span.end): TextEdit {
  return { ...(span.file !== undefined ? { file: span.file } : {}), start, end, text };
}

function compareEdits(a: TextEdit, b: TextEdit): number {
  const fileA = a.file ?? '';
  const fileB = b.file ?? '';
  if (fileA !== fileB) return fileA < fileB ? -1 : 1;
  return a.start - b.start || a.end - b.end;
}

/**
 * Content hash shared by every fix with the same title, confidence, and edits
 * (offsets and text), so one repair offered by two diagnostics has one id. The
 * file is deliberately not hashed: a single-source `compile()` reports edits
 * without one while the project loader stamps the entry name, and both must
 * name the same fix. The applier tells identical edits in two files apart.
 */
export function fixId(title: string, confidence: FixConfidence, edits: readonly TextEdit[]): string {
  const keys = [...edits]
    .sort((a, b) => a.start - b.start || a.end - b.end || (a.text < b.text ? -1 : a.text > b.text ? 1 : 0))
    .map((e) => `${e.start}\u001f${e.end}\u001f${e.text}`);
  return 'f' + fnv1aHex([title, confidence, ...keys].join('\u001e'));
}

/** Validates (non-empty, integer offsets, 0 <= start <= end, no conflicting pair), sorts the edits, and stamps the id. */
export function makeFix(title: string, confidence: FixConfidence, edits: TextEdit[]): Fix | undefined {
  if (edits.length === 0) return undefined;
  for (const e of edits) {
    if (!Number.isInteger(e.start) || !Number.isInteger(e.end) || e.start < 0 || e.end < e.start) return undefined;
  }
  for (const [i, a] of edits.entries()) {
    for (const b of edits.slice(i + 1)) if (editsConflict(a, b, '')) return undefined;
  }
  const sorted = [...edits].sort(compareEdits);
  return { id: fixId(title, confidence, sorted), title, confidence, edits: sorted };
}

export function replaceSpan(span: Span, text: string, title: string, confidence: FixConfidence = 'safe'): Fix | undefined {
  return makeFix(title, confidence, [editAt(span, text)]);
}

/** Re-spell the head identifier of a form (`(vv ...)` -> `(v ...)`); its children stay. */
export function renameHeadFix(list: ListNode, hit: string, confidence: FixConfidence = 'safe'): Fix | undefined {
  const head = list.items[0];
  if (head === undefined || head.kind !== 'ident' || head.span.end - head.span.start !== head.name.length) return undefined;
  return replaceSpan(head.span, hit, `Rename "${head.name}" to "${hit}"`, confidence);
}

/** Re-spell dotted segment `index` of an identifier (`a.b.c`, 1 -> `a.X.c`). Ident spans equal their text, so segment offsets follow from the name. An empty segment (`.n`, `n.`) has nothing to replace. */
export function replaceIdentSegment(ident: IdentAtom, index: number, replacement: string, title: string, confidence: FixConfidence = 'safe'): Fix | undefined {
  if (ident.span.end - ident.span.start !== ident.name.length) return undefined;
  const segments = ident.name.split('.');
  const segment = segments[index];
  if (segment === undefined || segment === '') return undefined;
  const start = ident.span.start + segments.slice(0, index).reduce((offset, s) => offset + s.length + 1, 0);
  return makeFix(title, confidence, [editAt(ident.span, replacement, start, start + segment.length)]);
}

/** Keyword re-spelling that keeps the colon (`:nmae` -> `:name`). */
export function keywordFix(keyword: KeywordAtom, hit: string, confidence: FixConfidence = 'safe'): Fix | undefined {
  if (keyword.span.end - keyword.span.start !== keyword.name.length + 1) return undefined;
  return replaceSpan(keyword.span, ':' + hit, `Replace ":${keyword.name}" with ":${hit}"`, confidence);
}

/** Design-token re-spelling that keeps the `$` (`$primry` -> `$primary`). */
export function tokenFix(token: IdentAtom, hit: string, confidence: FixConfidence = 'safe'): Fix | undefined {
  if (token.span.end - token.span.start !== token.name.length) return undefined;
  return replaceSpan(token.span, '$' + hit, `Replace "${token.name}" with "$${hit}"`, confidence);
}

/**
 * Re-spell an identifier or string atom from a closed set (enum members,
 * routes). A string is edited inside its quotes so it stays a string; one
 * whose source text differs from its value (escapes) gets no fix.
 */
export function literalFix(value: IdentAtom | StringAtom, hit: string, confidence: FixConfidence = 'safe'): Fix | undefined {
  if (/["\\\n\r\t]/.test(hit)) return undefined;
  const text = value.kind === 'ident' ? value.name : value.value;
  const title = `Replace "${text}" with "${hit}"`;
  if (value.kind === 'ident') {
    if (value.span.end - value.span.start !== text.length) return undefined;
    return replaceSpan(value.span, hit, title, confidence);
  }
  if (value.span.end - value.span.start !== text.length + 2) return undefined;
  return makeFix(title, confidence, [editAt(value.span, hit, value.span.start + 1, value.span.end - 1)]);
}

/** Wrap a span by inserting `before` at its start and `after` at its end; no source text is needed. */
export function wrapFix(span: Span, before: string, after: string, title: string, confidence: FixConfidence): Fix | undefined {
  return makeFix(title, confidence, [editAt(span, before, span.start, span.start), editAt(span, after, span.end, span.end)]);
}

/** Insert `text` right after `anchor` (a head identifier or the last positional), separated by one space; no fix without an anchor. */
export function insertAfterFix(anchor: SExpr | undefined, text: string, title: string, confidence: FixConfidence): Fix | undefined {
  if (anchor === undefined) return undefined;
  return makeFix(title, confidence, [editAt(anchor.span, ' ' + text, anchor.span.end, anchor.span.end)]);
}

/** ` :prop value` inserted right after `anchor`. */
export function insertPropFix(anchor: SExpr | undefined, prop: string, valueText: string, title: string, confidence: FixConfidence): Fix | undefined {
  return insertAfterFix(anchor, `:${prop} ${valueText}`, title, confidence);
}

/** Append `text` as the last item of a list, right before its closing paren. */
export function appendChildFix(parent: ListNode, text: string, title: string, confidence: FixConfidence): Fix | undefined {
  return makeFix(title, confidence, [editAt(parent.span, ' ' + text, parent.span.end - 1, parent.span.end - 1)]);
}

/**
 * Add a child form to a list. The app node takes it right after its name atom
 * (`(app a (uploads) ...)` checks clean); any other list takes it before its
 * first list child at that child's indentation, or last when it has none.
 */
export function insertChildFix(parent: ListNode, text: string, title: string, confidence: FixConfidence): Fix | undefined {
  const name = parent.items[1];
  if (opName(parent) === 'app' && name !== undefined && name.kind === 'ident') return insertAfterFix(name, text, title, confidence);
  const first = parent.items.find((item) => item.kind === 'list');
  if (first === undefined) return appendChildFix(parent, text, title, confidence);
  const indented = `${text}\n${' '.repeat(Math.max(0, first.span.col - 1))}`;
  return makeFix(title, confidence, [editAt(parent.span, indented, first.span.start, first.span.start)]);
}

/** A syntactically valid stand-in for a value of the given type; `null` when the type has no natural zero value. */
export function placeholderLiteral(type: ValueType | ColumnType | PropTypeName): string {
  switch (type) {
    case 'string':
      return '""';
    case 'number':
    case 'auto':
      return '0';
    case 'boolean':
      return 'false';
    case 'list':
      return '(arr)';
    case 'row':
    case 'record':
    case 'function':
    case 'null':
    case 'union':
    case 'never':
    case 'unknown':
    case 'action':
    case 'any':
      return 'null';
    default: {
      const exhaustive: never = type;
      throw new Error(`unhandled placeholder type: ${String(exhaustive)}`);
    }
  }
}

export interface Spelling {
  suggestions: string[];
  fixes: Fix[];
}

/** No candidate spelling: the hints a site reports when it has nothing to compare against. */
export const NO_SPELLING: Spelling = { suggestions: [], fixes: [] };

/**
 * Whether re-spelling `wrong` as its unique nearest candidate is a mechanical
 * correction rather than a guess: the edit must leave most of the name intact,
 * which a one- or two-character name never can (`id` -> `n` is a rewrite, not
 * a typo). Three-character names tolerate one edit, longer ones two.
 */
export function isSafeSpelling(wrong: string, hit: string): boolean {
  const distance = editDistance(wrong, hit);
  return wrong.length >= 4 ? distance <= 2 : wrong.length === 3 && distance === 1;
}

/**
 * Nearest-name suggestions and their fixes from one nearestAll call, so the
 * two cannot drift. A distance-0 self-hit yields nothing; exactly one hit is
 * a safe fix when `isSafeSpelling` holds and a review fix otherwise; tied hits
 * are one review fix each. `render` gives the display spelling (`':' + hit`,
 * `'$' + hit`, `head + '.' + hit`).
 */
export function spellingFix(
  wrong: string,
  candidates: Iterable<string>,
  render: (hit: string) => string,
  edit: (hit: string, confidence: FixConfidence) => Fix | undefined,
): Spelling {
  const hits = nearestAll(wrong, candidates).filter((hit) => hit !== wrong);
  const [only] = hits;
  const confidence: FixConfidence = only !== undefined && hits.length === 1 && isSafeSpelling(wrong, only) ? 'safe' : 'review';
  return { suggestions: hits.map(render), fixes: fixesOf(...hits.map((hit) => edit(hit, confidence))) };
}

/** The defined fixes among optional builder results. */
export function fixesOf(...candidates: (Fix | undefined)[]): Fix[] {
  return candidates.filter((fix): fix is Fix => fix !== undefined);
}
