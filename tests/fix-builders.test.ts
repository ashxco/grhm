import { describe, expect, it } from 'vitest';

import { IdentAtom, KeywordAtom, ListNode, Span, StringAtom } from '../src/ast.js';
import { Diagnostic, editsConflict, formatHuman, makeDiag, preferredFix, TextEdit } from '../src/diagnostics.js';
import {
  appendChildFix,
  editAt,
  fixId,
  fixesOf,
  insertAfterFix,
  insertChildFix,
  insertPropFix,
  isSafeSpelling,
  keywordFix,
  literalFix,
  makeFix,
  placeholderLiteral,
  renameHeadFix,
  replaceIdentSegment,
  replaceSpan,
  spellingFix,
  tokenFix,
  wrapFix,
} from '../src/fix-builders.js';
import { parse } from '../src/parser.js';
import { nearest, nearestAll } from '../src/util.js';

/**
 * Fix builders are pure functions over spans. These tests pin the offset
 * arithmetic, the validation rules that make a malformed edit vanish instead
 * of corrupting a file, and the id/conflict contracts the applier relies on.
 */

function span(start: number, end: number, file?: string): Span {
  return { start, end, line: 1, col: start + 1, ...(file !== undefined ? { file } : {}) };
}

function ident(name: string, start: number, file?: string): IdentAtom {
  return { kind: 'ident', name, span: span(start, start + name.length, file) };
}

function keyword(name: string, start: number): KeywordAtom {
  return { kind: 'keyword', name, span: span(start, start + name.length + 1) };
}

function str(value: string, start: number): StringAtom {
  return { kind: 'string', value, span: span(start, start + value.length + 2) };
}

function root(source: string): ListNode {
  const node = parse(source).nodes[0];
  if (node === undefined || node.kind !== 'list') throw new Error('expected a list');
  return node;
}

describe('nearestAll', () => {
  it('returns every candidate at the minimum distance, in iteration order', () => {
    expect(nearestAll('cont', ['count', 'cent', 'const', 'zzz'])).toEqual(['count', 'cent', 'const']);
    expect(nearestAll('colr', ['color', 'col', 'cols'])).toEqual(['color', 'col', 'cols']);
    expect(nearestAll('nmae', ['name', 'id'])).toEqual(['name']);
  });

  it('is empty when nothing is within the distance budget and ignores duplicates', () => {
    expect(nearestAll('finished', ['open', 'closed'])).toEqual([]);
    expect(nearestAll('cont', ['count', 'count'])).toEqual(['count']);
    expect(nearestAll('abc', ['abcd'], 0)).toEqual([]);
  });

  it('keeps nearest as the first hit', () => {
    expect(nearest('cont', ['cent', 'count'])).toBe('cent');
    expect(nearest('xyz', ['count'])).toBeUndefined();
  });
});

describe('editsConflict', () => {
  const entry = 'app.grhm';
  const edit = (start: number, end: number, file?: string): TextEdit => ({ start, end, text: 'x', ...(file !== undefined ? { file } : {}) });

  it('flags a shared start offset, including two insertions at one point', () => {
    expect(editsConflict(edit(5, 5), edit(5, 5), entry)).toBe(true);
    expect(editsConflict(edit(5, 5), edit(5, 10), entry)).toBe(true);
  });

  it('flags proper intersections and an insertion strictly inside the other edit', () => {
    expect(editsConflict(edit(5, 10), edit(8, 12), entry)).toBe(true);
    expect(editsConflict(edit(7, 7), edit(5, 10), entry)).toBe(true);
    expect(editsConflict(edit(5, 10), edit(6, 9), entry)).toBe(true);
  });

  it('allows touching boundaries', () => {
    expect(editsConflict(edit(5, 10), edit(10, 15), entry)).toBe(false);
    expect(editsConflict(edit(10, 10), edit(5, 10), entry)).toBe(false);
    expect(editsConflict(edit(0, 3), edit(4, 4), entry)).toBe(false);
  });

  it('never conflicts across files and treats a missing file as the entry', () => {
    expect(editsConflict(edit(5, 10, 'a.grhm'), edit(5, 10, 'b.grhm'), entry)).toBe(false);
    expect(editsConflict(edit(5, 10), edit(5, 10, entry), entry)).toBe(true);
    expect(editsConflict(edit(5, 10), edit(5, 10, 'other.grhm'), entry)).toBe(false);
  });
});

describe('makeFix', () => {
  it('rejects empty, non-integer, negative, inverted, and conflicting edits', () => {
    expect(makeFix('t', 'safe', [])).toBeUndefined();
    expect(makeFix('t', 'safe', [{ start: 1.5, end: 2, text: '' }])).toBeUndefined();
    expect(makeFix('t', 'safe', [{ start: -1, end: 2, text: '' }])).toBeUndefined();
    expect(makeFix('t', 'safe', [{ start: 3, end: 2, text: '' }])).toBeUndefined();
    expect(makeFix('t', 'safe', [{ start: 2, end: 6, text: 'a' }, { start: 4, end: 8, text: 'b' }])).toBeUndefined();
    expect(makeFix('t', 'safe', [{ start: 2, end: 2, text: 'a' }, { start: 2, end: 2, text: 'b' }])).toBeUndefined();
  });

  it('sorts edits by file then offset and stamps a content id that ignores input order', () => {
    const a: TextEdit = { file: 'b.grhm', start: 1, end: 2, text: 'x' };
    const b: TextEdit = { file: 'a.grhm', start: 9, end: 9, text: 'y' };
    const c: TextEdit = { file: 'a.grhm', start: 3, end: 4, text: 'z' };
    const first = makeFix('Do it', 'review', [a, b, c]);
    const second = makeFix('Do it', 'review', [c, a, b]);
    expect(first?.edits).toEqual([c, b, a]);
    expect(first?.id).toBe(second?.id);
    expect(first?.id).toMatch(/^f[0-9a-f]{8}$/);
    expect(first?.id).toBe(fixId('Do it', 'review', [b, c, a]));
  });

  it('hashes offsets and text but not the file, so a single-source compile and the project loader agree', () => {
    expect(fixId('Do it', 'safe', [{ start: 1, end: 2, text: 'x' }])).toBe(fixId('Do it', 'safe', [{ file: 'app.grhm', start: 1, end: 2, text: 'x' }]));
    expect(makeFix('Do it', 'safe', [{ file: 'a.grhm', start: 1, end: 2, text: 'x' }])?.id).toBe(makeFix('Do it', 'safe', [{ file: 'b.grhm', start: 1, end: 2, text: 'x' }])?.id);
  });

  it('changes the id when the title, confidence, or any edit changes', () => {
    const edits: TextEdit[] = [{ start: 1, end: 2, text: 'x' }];
    const base = makeFix('Do it', 'safe', edits)?.id;
    expect(makeFix('Do that', 'safe', edits)?.id).not.toBe(base);
    expect(makeFix('Do it', 'review', edits)?.id).not.toBe(base);
    expect(makeFix('Do it', 'safe', [{ start: 1, end: 2, text: 'y' }])?.id).not.toBe(base);
    expect(makeFix('Do it', 'safe', [{ start: 1, end: 3, text: 'x' }])?.id).not.toBe(base);
  });
});

describe('span builders', () => {
  it('editAt covers the span or a sub-range and copies the file', () => {
    expect(editAt(span(3, 8, 'm.grhm'), 'x')).toEqual({ file: 'm.grhm', start: 3, end: 8, text: 'x' });
    expect(editAt(span(3, 8), 'x', 4, 6)).toEqual({ start: 4, end: 6, text: 'x' });
  });

  it('replaceSpan defaults to safe', () => {
    const fix = replaceSpan(span(2, 5, 'a.grhm'), 'abc', 'Replace "xy" with "abc"');
    expect(fix?.confidence).toBe('safe');
    expect(fix?.edits).toEqual([{ file: 'a.grhm', start: 2, end: 5, text: 'abc' }]);
  });

  it('renameHeadFix edits only an identifier head and quotes it in the title', () => {
    const fix = renameHeadFix(root('(vv (txt "x"))'), 'v');
    expect(fix?.title).toBe('Rename "vv" to "v"');
    expect(fix?.edits).toEqual([{ start: 1, end: 3, text: 'v' }]);
    expect(renameHeadFix(root('("vv" (txt "x"))'), 'v')).toBeUndefined();
    expect(renameHeadFix(root('()'), 'v')).toBeUndefined();
  });

  it('replaceIdentSegment edits one dotted segment from the identifier text alone', () => {
    const atom = ident('a.bb.c', 10, 'x.grhm');
    expect(replaceIdentSegment(atom, 0, 'z', 't')?.edits).toEqual([{ file: 'x.grhm', start: 10, end: 11, text: 'z' }]);
    expect(replaceIdentSegment(atom, 1, 'X', 't')?.edits).toEqual([{ file: 'x.grhm', start: 12, end: 14, text: 'X' }]);
    expect(replaceIdentSegment(atom, 2, 'Y', 't', 'review')?.confidence).toBe('review');
    expect(replaceIdentSegment(atom, 3, 'Y', 't')).toBeUndefined();
    // An empty segment has no text to replace; a zero-width "Replace" would insert instead.
    expect(replaceIdentSegment(ident('.n', 10, 'x.grhm'), 0, 'n', 't')).toBeUndefined();
    expect(replaceIdentSegment(ident('n.', 10, 'x.grhm'), 1, 'id', 't')).toBeUndefined();
  });

  it('replaceIdentSegment refuses an identifier whose span does not match its text', () => {
    const fabricated: IdentAtom = { kind: 'ident', name: 'a.b', span: span(10, 20) };
    expect(replaceIdentSegment(fabricated, 0, 'z', 't')).toBeUndefined();
  });

  it('keywordFix keeps the colon and tokenFix keeps the dollar sign', () => {
    const kw = keywordFix(keyword('colr', 7), 'color');
    expect(kw?.title).toBe('Replace ":colr" with ":color"');
    expect(kw?.edits).toEqual([{ start: 7, end: 12, text: ':color' }]);
    expect(keywordFix({ kind: 'keyword', name: 'colr', span: span(7, 11) }, 'color')).toBeUndefined();
    const token = tokenFix(ident('$primry', 20), 'primary');
    expect(token?.title).toBe('Replace "$primry" with "$primary"');
    expect(token?.edits).toEqual([{ start: 20, end: 27, text: '$primary' }]);
  });

  it('literalFix replaces an identifier whole and a string inside its quotes', () => {
    expect(literalFix(ident('centre', 5), 'center')?.edits).toEqual([{ start: 5, end: 11, text: 'center' }]);
    const quoted = literalFix(str('centre', 5), 'center');
    expect(quoted?.title).toBe('Replace "centre" with "center"');
    expect(quoted?.edits).toEqual([{ start: 6, end: 12, text: 'center' }]);
    expect(literalFix({ kind: 'string', value: 'a"b', span: span(0, 6) }, 'ab')).toBeUndefined();
    expect(literalFix(str('x', 0), 'has"quote')).toBeUndefined();
  });

  it('wrapFix is two insertions and refuses an empty span', () => {
    const fix = wrapFix(span(4, 9), '(or-else ', ' 0)', 'Wrap in (or-else … 0)', 'review');
    expect(fix?.edits).toEqual([{ start: 4, end: 4, text: '(or-else ' }, { start: 9, end: 9, text: ' 0)' }]);
    expect(wrapFix(span(4, 4), '(', ')', 't', 'review')).toBeUndefined();
  });

  it('insertAfterFix and insertPropFix insert after the anchor with one leading space, or not at all without one', () => {
    expect(insertAfterFix(ident('btn', 1), '"Label"', 't', 'placeholder')?.edits).toEqual([{ start: 4, end: 4, text: ' "Label"' }]);
    expect(insertPropFix(ident('img', 1), 'alt', '""', 't', 'placeholder')?.edits).toEqual([{ start: 4, end: 4, text: ' :alt ""' }]);
    expect(insertPropFix(undefined, 'alt', '""', 't', 'placeholder')).toBeUndefined();
  });

  it('appendChildFix inserts before the closing paren', () => {
    expect(appendChildFix(root('(match s ("a" 1))'), '(status.b null)', 't', 'placeholder')?.edits).toEqual([{ start: 16, end: 16, text: ' (status.b null)' }]);
  });

  it('insertChildFix places a child after the app name, else before the first child at its indentation, else before the paren', () => {
    const app = insertChildFix(root('(app a (page "/" home (txt "x")))'), '(uploads)', 'Add (uploads) to app', 'safe');
    expect(app?.edits).toEqual([{ start: 6, end: 6, text: ' (uploads)' }]);
    const nested = insertChildFix(root('(data\n   (resource r "/x"))'), '(x)', 't', 'safe');
    expect(nested?.edits).toEqual([{ start: 9, end: 9, text: '(x)\n   ' }]);
    const empty = insertChildFix(root('(data)'), '(x)', 't', 'safe');
    expect(empty?.edits).toEqual([{ start: 5, end: 5, text: ' (x)' }]);
  });

  it('placeholderLiteral maps zero values and falls back to null', () => {
    expect(placeholderLiteral('string')).toBe('""');
    expect(placeholderLiteral('number')).toBe('0');
    expect(placeholderLiteral('auto')).toBe('0');
    expect(placeholderLiteral('boolean')).toBe('false');
    expect(placeholderLiteral('list')).toBe('(arr)');
    expect(placeholderLiteral('row')).toBe('null');
    expect(placeholderLiteral('action')).toBe('null');
    expect(placeholderLiteral('unknown')).toBe('null');
  });
});

describe('spellingFix', () => {
  const edit = (atom: IdentAtom) => (hit: string, confidence: 'safe' | 'review' | 'placeholder') => replaceSpan(atom.span, hit, `Replace "${atom.name}" with "${hit}"`, confidence);

  it('yields one safe fix for a unique hit', () => {
    const atom = ident('cont', 3);
    const spelled = spellingFix('cont', ['count', 'other'], (hit) => hit, edit(atom));
    expect(spelled.suggestions).toEqual(['count']);
    expect(spelled.fixes.map((f) => f.confidence)).toEqual(['safe']);
    expect(spelled.fixes[0]?.edits).toEqual([{ start: 3, end: 7, text: 'count' }]);
  });

  it('yields one review fix per tied hit, rendered the same way as the suggestions', () => {
    const atom = ident('cont', 3);
    const spelled = spellingFix('cont', ['count', 'cent'], (hit) => ':' + hit, edit(atom));
    expect(spelled.suggestions).toEqual([':count', ':cent']);
    expect(spelled.fixes.map((f) => [f.confidence, f.edits[0]?.text])).toEqual([['review', 'count'], ['review', 'cent']]);
  });

  it('marks a unique hit safe only when the typo leaves most of the name intact', () => {
    expect(isSafeSpelling('id', 'n')).toBe(false);
    expect(isSafeSpelling('vv', 'v')).toBe(false);
    expect(isSafeSpelling('one', 'n')).toBe(false);
    expect(isSafeSpelling('dta', 'data')).toBe(true);
    expect(isSafeSpelling('nmae', 'name')).toBe(true);
    expect(isSafeSpelling('colr', 'color')).toBe(true);
    for (const [wrong, hit] of [['id', 'n'], ['one', 'n'], ['vv', 'v']]) {
      const spelled = spellingFix(wrong ?? '', [hit ?? ''], (h) => h, edit(ident(wrong ?? '', 0)));
      expect(spelled.suggestions).toEqual([hit]);
      expect(spelled.fixes.map((f) => f.confidence)).toEqual(['review']);
    }
    expect(spellingFix('dta', ['data'], (h) => h, edit(ident('dta', 0))).fixes.map((f) => f.confidence)).toEqual(['safe']);
  });

  it('yields nothing for a distance-0 self-hit or no hit', () => {
    expect(spellingFix('id', ['id', 'name'], (hit) => hit, edit(ident('id', 0)))).toEqual({ suggestions: [], fixes: [] });
    expect(spellingFix('finished', ['open', 'closed'], (hit) => hit, edit(ident('finished', 0)))).toEqual({ suggestions: [], fixes: [] });
  });

  it('drops hits whose edit could not be built', () => {
    const spelled = spellingFix('cont', ['count'], (hit) => hit, () => undefined);
    expect(spelled.suggestions).toEqual(['count']);
    expect(spelled.fixes).toEqual([]);
    expect(fixesOf(undefined, replaceSpan(span(0, 1), 'x', 't'), undefined)).toHaveLength(1);
  });
});

describe('diagnostic fix plumbing', () => {
  const safe = replaceSpan(span(0, 2), 'a', 'Replace "xy" with "a"');
  const review = replaceSpan(span(0, 2), 'b', 'Replace "xy" with "b"', 'review');
  const placeholder = insertPropFix(ident('xy', 0), 'alt', '""', 'Add :alt "" (fill in)', 'placeholder');
  if (safe === undefined || review === undefined || placeholder === undefined) throw new Error('fixtures must build');

  it('makeDiag omits fixes when none were built', () => {
    expect('fixes' in makeDiag('E101', 'error', 'm', { fixes: [] })).toBe(false);
    expect('fixes' in makeDiag('E101', 'error', 'm', { fixes: undefined })).toBe(false);
    expect(makeDiag('E101', 'error', 'm', { fixes: [safe] }).fixes).toEqual([safe]);
  });

  it('preferredFix is the unique safe entry', () => {
    const one: Diagnostic = makeDiag('E101', 'error', 'm', { fixes: [safe, review, placeholder] });
    expect(preferredFix(one)).toBe(safe);
    expect(preferredFix(makeDiag('E101', 'error', 'm', { fixes: [review, placeholder] }))).toBeUndefined();
    const other = replaceSpan(span(0, 2), 'c', 'Replace "xy" with "c"');
    if (other === undefined) throw new Error('fixture must build');
    expect(preferredFix(makeDiag('E101', 'error', 'm', { fixes: [safe, other] }))).toBeUndefined();
    expect(preferredFix(makeDiag('E101', 'error', 'm'))).toBeUndefined();
  });

  it('formatHuman lists each fix after the suggestion line', () => {
    const text = formatHuman(makeDiag('E102', 'error', 'bad', { span: span(0, 2), suggestions: [':a'], fixes: [safe, placeholder] }), 'xy z', 'app.grhm');
    const lines = text.split('\n');
    expect(lines[1]).toBe('  suggestion: :a');
    expect(lines[2]).toBe(`  fix [safe] ${safe.id}: Replace "xy" with "a"`);
    expect(lines[3]).toBe(`  fix [placeholder] ${placeholder.id}: Add :alt "" (fill in)`);
    expect(lines[4]).toBe('  | xy z');
  });
});
