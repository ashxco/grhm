import { describe, expect, it } from 'vitest';

import { compile } from '../src/codegen/index.js';
import { applyFixes, applyFixesToProject, applyTextEdits, mapOffset } from '../src/fix.js';
import { format } from '../src/format.js';
import { parse } from '../src/parser.js';
import { loadProject, projectRevision } from '../src/project.js';

/**
 * The fix applier: multi-pass, fingerprint-checked application of diagnostic
 * fixes over an in-memory project, with the patch protocol's purity and
 * revision discipline.
 */

const CASCADE = '(app a (page "/" home (cardd (txt "x" :colr "#000"))))';
const UPLOADS = '(app a (db (table t (id auto))) (state photo "") (page "/" home (file-input :label "Photo" :to photo)))';

/** Fix ids as the applier itself reports them, the way an agent reads them from `grhm check`. */
function fixIds(source: string, code: string): string[] {
  return applyFixes(source, { level: 'none' }).diagnostics.filter((d) => d.code === code).flatMap((d) => (d.fixes ?? []).map((f) => f.id));
}

describe('fix applier', () => {
  it('accepts a fix that reveals further diagnostics and fixes those in later passes', () => {
    const result = applyFixes(CASCADE);
    expect(result).toMatchObject({ ok: true, clean: true, conflict: false, passes: 2, stopped: 'fixed-point', changedFiles: ['app.grhm'], uncovered: [], skipped: [] });
    expect(result.applied.map((a) => [a.code, a.pass, a.title, a.file, a.line, a.col])).toEqual([
      ['E101', 1, 'Rename "cardd" to "card"', 'app.grhm', 1, 23],
      ['E102', 2, 'Replace ":colr" with ":color"', 'app.grhm', 1, 38],
    ]);
    expect(result.newSource).toBe('(app a (page "/" home (card (txt "x" :color "#000"))))');
    expect(result.diagnostics).toEqual([]);
  });

  it('accepts a fix that unmasks the same diagnostic at another site and fixes that one next pass', () => {
    // The outer unknown op hides the identical one inside it: before the fix
    // there is one E101 with this message, after it still one. Judged by
    // site, the outer one is gone and the inner one is new work.
    const nested = applyFixes('(app a (page "/" home (cardd (cardd (txt "x")))))');
    expect(nested).toMatchObject({ ok: true, clean: true, passes: 2, stopped: 'fixed-point', skipped: [], uncovered: [] });
    expect(nested.applied.map((a) => [a.code, a.pass, a.title, a.col])).toEqual([
      ['E101', 1, 'Rename "cardd" to "card"', 23],
      ['E101', 2, 'Rename "cardd" to "card"', 29],
    ]);
    expect(nested.newSource).toBe('(app a (page "/" home (card (card (txt "x")))))');
    const spread = applyFixes('(app a (page "/" home (cardd (cardd (txt "x"))) (sectoin (cardd (txt "z")))))');
    expect(spread).toMatchObject({ clean: true, passes: 2, stopped: 'fixed-point', skipped: [] });
    expect(spread.applied.map((a) => [a.title, a.pass])).toEqual([
      ['Rename "cardd" to "card"', 1],
      ['Rename "sectoin" to "section"', 1],
      ['Rename "cardd" to "card"', 2],
      ['Rename "cardd" to "card"', 2],
    ]);
    // A fixed point is truthful: fixing the result again applies nothing.
    expect(applyFixes(spread.newSource ?? '')).toMatchObject({ passes: 0, applied: [], stopped: 'fixed-point' });
    const duplicated = applyFixes('(app a (page "/" home (txt "x" :colr "#000" :colr "#111")))');
    expect(duplicated.clean).toBe(true);
    expect(duplicated.newSource).toBe('(app a (page "/" home (txt "x" :color "#000" :color "#111")))');
  });

  it('maps pre-edit offsets through a pass\'s edits', () => {
    const edits = [{ start: 2, end: 4, text: 'XXXX' }, { start: 8, end: 8, text: '+' }, { start: 10, end: 13, text: '' }];
    expect(mapOffset(1, edits)).toBe(1);
    expect(mapOffset(2, edits)).toBe(2);
    expect(mapOffset(3, edits)).toBe(2);
    expect(mapOffset(4, edits)).toBe(6);
    expect(mapOffset(8, edits)).toBe(11);
    expect(mapOffset(11, edits)).toBe(13);
    expect(mapOffset(13, edits)).toBe(13);
    expect(mapOffset(20, edits)).toBe(20);
  });

  it('fixes the head and then the field of one dotted identifier over two passes', () => {
    const result = applyFixes('(app a (data (resource rows "/x" :default (arr))) (page "/" home (txt rowz.datum)))');
    expect(result.applied.map((a) => [a.code, a.pass])).toEqual([['E201', 1], ['E204', 2]]);
    expect(result.newSource).toContain('(txt rows.data)');
    expect(result.clean).toBe(true);
  });

  it('defers a requested fix that conflicts with a claimed edit and lands it next pass', () => {
    const source = '(app a (page "/" home (txt (fmt "Hi {name} {age}"))))';
    const ids = fixIds(source, 'E206');
    expect(ids).toHaveLength(2);
    const result = applyFixes(source, { level: 'none', fix: ids });
    expect(result.applied.map((a) => [a.title, a.pass])).toEqual([['Add :name (fill in)', 1], ['Add :age (fill in)', 2]]);
    expect(result.skipped).toEqual([]);
    expect(result.clean).toBe(true);
    expect(result.newSource).toContain('(fmt "Hi {name} {age}" :age "" :name "")');
  });

  it('applies an explicit id once and leaves same-shaped fixes at other sites to the level', () => {
    const twice = '(app a (page "/" home (txt "a" :colr "#000") (txt "b" :colr "#000")))';
    const [first, second] = fixIds(twice, 'E102');
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(first).not.toBe(second);
    const one = applyFixes(twice, { level: 'none', fix: first === undefined ? [] : [first] });
    expect(one.applied.map((a) => [a.id, a.col])).toEqual([[first, 32]]);
    expect(one.newSource).toBe('(app a (page "/" home (txt "a" :color "#000") (txt "b" :colr "#000")))');
    expect(one.clean).toBe(false);
    // Only a requested fix that a conflicting edit deferred keeps its request
    // into the next pass; a sibling offering the same placeholder does not inherit it.
    const fmt = '(app a (page "/" home (txt (fmt "Hi {name} {age}")) (txt (fmt "Yo {name}"))))';
    const requested = applyFixes(fmt, { level: 'none', fix: fixIds(fmt, 'E206').slice(0, 2) });
    expect(requested.applied.map((a) => [a.title, a.pass])).toEqual([['Add :name (fill in)', 1], ['Add :age (fill in)', 2]]);
    expect(requested.newSource).toContain('(fmt "Hi {name} {age}" :age "" :name "")');
    expect(requested.newSource).toContain('(txt (fmt "Yo {name}"))');
    // A tie resolved by id at one site stays a tie at the other.
    const tied = '(app a (state count 0) (state cent 0) (page "/" home (txt cont) (txt cont)))';
    const cent = fixIds(tied, 'E201')[1];
    const chosen = applyFixes(tied, { level: 'review', fix: cent === undefined ? [] : [cent] });
    expect(chosen.newSource).toBe('(app a (state count 0) (state cent 0) (page "/" home (txt cent) (txt cont)))');
    expect(chosen.skipped.map((s) => s.reason)).toEqual(['ambiguous', 'ambiguous']);
  });

  it('accepts the fix ids a single-source compile reports', () => {
    for (const source of ['(app a (page "/" home (cardd (txt "x"))))', '(app a (page "/" home (link (txt "x"))))']) {
      const ids = compile(source).diagnostics.flatMap((d) => (d.fixes ?? []).map((f) => f.id));
      expect(ids.length).toBeGreaterThan(0);
      const result = applyFixes(source, { level: 'none', fix: ids });
      expect(result).toMatchObject({ ok: true, conflict: false });
      expect(result.applied.map((a) => a.id)).toEqual(ids);
    }
  });

  it('keeps identical edits in two files as two fixes that share an id', () => {
    const files = new Map([
      ['app.grhm', '(app a (include "a.grhm") (include "b.grhm") (page "/" home (chipa) (chipb)))'],
      ['a.grhm', '(component chipa (txt "x" :colr "#fff"))'],
      ['b.grhm', '(component chipb (txt "x" :colr "#fff"))'],
    ]);
    const read = (p: string): string | undefined => files.get(p);
    const both = applyFixesToProject('app.grhm', read);
    expect(both.applied.map((a) => [a.file, a.col])).toEqual([['a.grhm', 27], ['b.grhm', 27]]);
    expect(both.applied[0]?.id).toBe(both.applied[1]?.id);
    expect(both.clean).toBe(true);
    const id = both.applied[0]?.id;
    const first = applyFixesToProject('app.grhm', read, { level: 'none', fix: id === undefined ? [] : [id] });
    expect(first.applied.map((a) => a.file)).toEqual(['a.grhm']);
    expect(first.changedFiles).toEqual(['a.grhm']);
    expect(first.clean).toBe(false);
  });

  it('skips tied spellings as ambiguous and applies one only by explicit id', () => {
    const source = '(app a (state count 0) (state cent 0) (page "/" home (txt cont)))';
    const bulk = applyFixes(source, { level: 'review' });
    expect(bulk).toMatchObject({ ok: true, clean: false, passes: 0, applied: [] });
    expect(bulk.skipped.map((s) => [s.reason, s.confidence, s.title])).toEqual([
      ['ambiguous', 'review', 'Replace "cont" with "count"'],
      ['ambiguous', 'review', 'Replace "cont" with "cent"'],
    ]);
    expect(bulk.newSources).toBeUndefined();
    const cent = fixIds(source, 'E201')[1];
    const chosen = applyFixes(source, { fix: cent === undefined ? [] : [cent] });
    expect(chosen.clean).toBe(true);
    expect(chosen.newSource).toContain('(txt cent)');
  });

  it('applies a placeholder only by explicit id', () => {
    const source = '(app a (page "/" home (link (txt "x"))))';
    expect(applyFixes(source, { level: 'review' }).applied).toEqual([]);
    const result = applyFixes(source, { fix: fixIds(source, 'E106') });
    expect(result.applied.map((a) => [a.confidence, a.title])).toEqual([['placeholder', 'Add :to "" (fill in)']]);
    expect(result.newSource).toContain('(link :to "" (txt "x"))');
  });

  it('reports a stale fix id as a revision conflict without applying anything', () => {
    const result = applyFixes(CASCADE, { fix: ['f00000000'] });
    expect(result).toMatchObject({ ok: false, clean: false, conflict: true, passes: 0, applied: [], skipped: [] });
    expect(result.currentRevision).toMatch(/^[0-9a-f]+$/);
    expect(result.diagnostics.map((d) => d.code)).toEqual(['E504']);
    expect(result.diagnostics[0]?.message).toContain('f00000000');
    expect(result.newSources).toBeUndefined();
  });

  it('rejects a revision mismatch with E504 and accepts the current revision', () => {
    const stale = applyFixes(CASCADE, { revision: 'deadbeef' });
    expect(stale).toMatchObject({ ok: false, conflict: true, applied: [] });
    expect(stale.diagnostics[0]).toMatchObject({ code: 'E504', received: 'deadbeef', expected: stale.currentRevision });
    expect(applyFixes(CASCADE, { revision: stale.currentRevision }).ok).toBe(true);
  });

  it('refuses input that does not parse with E503', () => {
    const result = applyFixes('(app a (page "/" home (txt "x"');
    expect(result).toMatchObject({ ok: false, clean: false, conflict: false, passes: 0 });
    expect(result.diagnostics[0]?.code).toBe('E503');
    expect(result.diagnostics.some((d) => d.code === 'E003')).toBe(true);
  });

  it('is idempotent', () => {
    const first = applyFixes(CASCADE);
    const second = applyFixes(first.newSource ?? '', { revision: first.revision });
    expect(second).toMatchObject({ ok: true, clean: true, passes: 0, applied: [], revision: first.revision });
    expect(second.newSource).toBeUndefined();
    expect(second.newSources).toBeUndefined();
    expect(second.changedFiles).toBeUndefined();
  });

  it('re-canonicalizes files that were canonical and leaves other files minimally edited', () => {
    const canonical = format(parse(UPLOADS).nodes);
    const formatted = applyFixes(canonical);
    expect(formatted.newSource).toBe(format(parse(formatted.newSource ?? '').nodes));
    expect(formatted.newSource).toContain('(app a\n  (uploads)\n');
    const raw = applyFixes(canonical, { format: false });
    expect(raw.newSource).toContain('(app a (uploads)\n');
    expect(raw.revision).toBe(formatted.revision);
    const commented = '; keep me\n(app a\n  (page "/" home (txt "x" :colr "#000")))\n';
    expect(applyFixes(commented).newSource).toBe('; keep me\n(app a\n  (page "/" home (txt "x" :color "#000")))\n');
  });

  it('edits included files in place and never writes through the reader', () => {
    const files = new Map([
      ['app.grhm', '(app a (include "shared.grhm") (page "/" home (chip)))'],
      ['shared.grhm', '(component chip (txt "x" :colr "#fff"))'],
    ]);
    const snapshot = new Map(files);
    const result = applyFixesToProject('app.grhm', (p) => files.get(p));
    expect(result.clean).toBe(true);
    expect(result.applied.map((a) => [a.file, a.line, a.col])).toEqual([['shared.grhm', 1, 26]]);
    expect(result.changedFiles).toEqual(['shared.grhm']);
    expect([...(result.newSources ?? [])]).toEqual([['shared.grhm', '(component chip (txt "x" :color "#fff"))']]);
    expect(result.newSource).toBe(snapshot.get('app.grhm'));
    expect(files).toEqual(snapshot);
    expect(result.revision).toBe(projectRevision(loadProject('app.grhm', (p) => result.newSources?.get(p) ?? files.get(p))));
  });

  it('reports errors the fixes uncovered and fixes nothing it cannot', () => {
    const result = applyFixes('(app a (page "/" home (cardd (txt "x" :colr 1))))');
    expect(result.clean).toBe(false);
    expect(result.applied.map((a) => a.code)).toEqual(['E101', 'E102']);
    expect(result.uncovered.map((d) => d.code)).toEqual(['E103']);
    expect(result.diagnostics.map((d) => d.code)).toEqual(['E103']);
    expect(result.newSource).toBe('(app a (page "/" home (card (txt "x" :color 1))))');
  });

  it('never offers a short or heavily rewritten spelling as a safe fix', () => {
    const short = applyFixes('(app a (state n 0) (page "/" home (txt id)))');
    expect(short).toMatchObject({ clean: false, passes: 0, applied: [] });
    expect(applyFixes('(app a (state n 0) (page "/" home (txt id)))', { level: 'review' }).newSource).toContain('(txt n)');
    expect(applyFixes('(app a (page "/" home (vv (txt "x"))))').applied).toEqual([]);
  });

  it('applies one fix offered by several diagnostics once', () => {
    const result = applyFixes('(app a (db (table t (id auto))) (state p "") (state q "") (page "/" home (file-input :label "P" :to p) (file-input :label "Q" :to q)))');
    expect(result.applied.map((a) => a.title)).toEqual(['Add (uploads) to app']);
    expect(result.clean).toBe(true);
  });

  it('honours the codes filter, level none, and the pass budget', () => {
    expect(applyFixes(CASCADE, { codes: ['E102'] })).toMatchObject({ passes: 0, applied: [] });
    expect(applyFixes(CASCADE, { codes: ['E101'] }).applied.map((a) => a.code)).toEqual(['E101']);
    expect(applyFixes(CASCADE, { level: 'none' })).toMatchObject({ ok: true, clean: false, passes: 0, applied: [], stopped: 'fixed-point' });
    const bounded = applyFixes(CASCADE, { maxPasses: 1 });
    expect(bounded).toMatchObject({ passes: 1, stopped: 'max-passes', clean: false });
    expect(bounded.uncovered.map((d) => d.code)).toEqual(['E102']);
    // The budget is only reported as the stop reason when work remained.
    expect(applyFixes(CASCADE, { maxPasses: 2 })).toMatchObject({ passes: 2, stopped: 'fixed-point', clean: true });
  });

  it('clamps the pass budget to 1..32 around a default of 8', () => {
    // Each unknown op masks the one inside it, so a chain of n needs n passes.
    const chain = (depth: number): string => `(app a (page "/" home ${'(cardd '.repeat(depth)}(txt "x")${')'.repeat(depth)}))`;
    expect(applyFixes(chain(10))).toMatchObject({ passes: 8, stopped: 'max-passes', clean: false });
    expect(applyFixes(chain(10), { maxPasses: Number.NaN })).toMatchObject({ passes: 8, stopped: 'max-passes' });
    expect(applyFixes(chain(10), { maxPasses: 10 })).toMatchObject({ passes: 10, stopped: 'fixed-point', clean: true });
    expect(applyFixes(chain(10), { maxPasses: 0 })).toMatchObject({ passes: 1, stopped: 'max-passes' });
    expect(applyFixes(chain(3), { maxPasses: 2.9 })).toMatchObject({ passes: 2, stopped: 'max-passes' });
    const capped = applyFixes(chain(34), { maxPasses: 100 });
    expect(capped).toMatchObject({ passes: 32, stopped: 'max-passes', clean: false });
    expect(capped.applied.map((a) => a.pass)).toEqual(Array.from({ length: 32 }, (_, i) => i + 1));
  });

  it('exempts explicitly requested fixes from the codes filter', () => {
    const [outer] = fixIds(CASCADE, 'E101');
    const result = applyFixes(CASCADE, { codes: ['E102'], fix: outer === undefined ? [] : [outer] });
    // The requested E101 lands first; the E102 it unmasks is then within the filter.
    expect(result.applied.map((a) => [a.code, a.pass])).toEqual([['E101', 1], ['E102', 2]]);
    expect(result.clean).toBe(true);
    expect(applyFixes(CASCADE, { codes: [] })).toMatchObject({ passes: 0, applied: [] });
  });

  it('numbers applied fixes by the passes it counts', () => {
    for (const source of [CASCADE, '(app a (page "/" home (cardd (cardd (txt "x"))) (sectoin (cardd (txt "z")))))', '(app a (page "/" home (txt (fmt "Hi {name} {age}"))))']) {
      const result = applyFixes(source, { level: 'none', fix: fixIds(source, 'E206').concat(fixIds(source, 'E101'), fixIds(source, 'E102')) });
      const passes = [...new Set(result.applied.map((a) => a.pass))];
      expect(passes).toEqual(Array.from({ length: result.passes }, (_, i) => i + 1));
    }
  });

  it('lands safe fixes before review fixes so consequential diagnostics disappear first', () => {
    const source = '(app a (db (table wishes (id auto) (name string))) (api (post "/api/wishes" (input (name string)) (insert wishes :name body.nmae))) (page "/" home (txt "hi")))';
    const result = applyFixes(source, { level: 'review' });
    expect(result.applied.map((a) => [a.code, a.confidence])).toEqual([['E808', 'safe']]);
    expect(result.newSource).toContain(':name body.name)');
    expect(result.clean).toBe(true);
  });

  it('applies review fixes at level review but not at level safe', () => {
    const source = '(app a (page "/" home (txt (+ (first (arr 1 2)) 1))))';
    expect(applyFixes(source).applied).toEqual([]);
    const result = applyFixes(source, { level: 'review' });
    expect(result.applied.map((a) => a.confidence)).toEqual(['review']);
    expect(result.newSource).toBe('(app a (page "/" home (txt (+ (or-else (first (arr 1 2)) 0) 1))))');
  });

  it('applies non-conflicting text edits regardless of their order', () => {
    expect(applyTextEdits('abcdef', [{ start: 1, end: 2, text: 'X' }, { start: 4, end: 4, text: '+' }, { start: 2, end: 4, text: '' }])).toBe('aX+ef');
  });
});
