import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { compile } from '../src/codegen/index.js';
import { CONFIDENCE_RANK, Diagnostic, Fix, editsConflict, preferredFix } from '../src/diagnostics.js';
import { applyFixes, applyTextEdits } from '../src/fix.js';
import { makeFix } from '../src/fix-builders.js';
import { parse } from '../src/parser.js';
import { compileProject, loadProject } from '../src/project.js';

/**
 * Diagnostics carry machine-applicable `fixes`. Every fix the checker emits
 * must validate, quote the exact source it replaces, and (when `safe`) clear
 * its own diagnostic when applied alone. The sweep runs over the corpus plus
 * one program per fix-producing site; the targeted tests pin the edit shapes.
 */

const CORPUS = path.join(__dirname, '..', 'corpus');

const diagnosticsOf = (source: string): Diagnostic[] => compile(source).diagnostics;
const key = (d: Diagnostic): string => `${d.code}|${d.message}`;
const countOf = (diags: Diagnostic[], k: string): number => diags.filter((d) => key(d) === k).length;

function find(source: string, code: string, title?: string): { diagnostic: Diagnostic; fix: Fix } {
  const diags = diagnosticsOf(source);
  for (const diagnostic of diags.filter((d) => d.code === code)) {
    const fix = (diagnostic.fixes ?? []).find((f) => title === undefined || f.title === title);
    if (fix !== undefined) return { diagnostic, fix };
  }
  throw new Error(`no ${code} fix${title === undefined ? '' : ` titled ${title}`} in:\n${JSON.stringify(diags, null, 2)}`);
}

/** Applying the fix alone must leave a parsable program with fewer of the targeted diagnostic. */
function expectClears(source: string, code: string, title?: string): string {
  const { diagnostic, fix } = find(source, code, title);
  const patched = applyTextEdits(source, fix.edits);
  expect(parse(patched).diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  expect(countOf(diagnosticsOf(patched), key(diagnostic))).toBeLessThan(countOf(diagnosticsOf(source), key(diagnostic)));
  return patched;
}

function expectWellFormed(fix: Fix, source: string): void {
  expect(fix.edits.length).toBeGreaterThan(0);
  for (const edit of fix.edits) {
    expect(Number.isInteger(edit.start) && Number.isInteger(edit.end)).toBe(true);
    expect(edit.start).toBeGreaterThanOrEqual(0);
    expect(edit.end).toBeGreaterThanOrEqual(edit.start);
    expect(edit.end).toBeLessThanOrEqual(source.length);
    expect(edit.file).toBeUndefined();
  }
  for (const [i, a] of fix.edits.entries()) {
    const previous = fix.edits[i - 1];
    if (previous !== undefined) expect(previous.start).toBeLessThanOrEqual(a.start);
    for (const b of fix.edits.slice(i + 1)) expect(editsConflict(a, b, 'app.grhm')).toBe(false);
  }
  expect(makeFix(fix.title, fix.confidence, fix.edits)).toEqual(fix);
  const quoted = /^(?:Replace|Rename|Delete) "([^"]*)"/.exec(fix.title);
  if (quoted !== null) {
    expect(fix.edits).toHaveLength(1);
    const edit = fix.edits[0];
    expect(edit !== undefined && source.slice(edit.start, edit.end)).toBe(quoted[1]);
  }
  expect(fix.title.endsWith('(fill in)')).toBe(fix.confidence === 'placeholder');
}

const SITE_PROGRAMS: [string, string][] = [
  ['E101 unknown op', '(app a (page "/" home (cardd (txt "x"))))'],
  ['E101 short unknown op', '(app a (page "/" home (vv (txt "x"))))'],
  ['E201 short reference', '(app a (state n 0) (page "/" home (txt id)))'],
  ['E201 dotted ident', '(app a (state count 0) (page "/" home (txt cont.length)))'],
  ['E201 set target', '(app a (state count 0) (page "/" home (btn "x" (click (set cont 1)))))'],
  ['E201 tie', '(app a (state count 0) (state cent 0) (page "/" home (txt cont)))'],
  ['E111 or-else wrap', '(app a (page "/" home (txt (+ (first (arr 1 2)) 1))))'],
  ['E111 nullable segment', '(app a (db (table t (id auto) (n number))) (api (get "/api/x" (let ((r (first (select t)))) r.n))) (page "/" home (txt "x")))'],
  ['E111 conditions', '(app a (state n 0) (state s "") (state items (arr 1)) (page "/" home (if n (txt "a")) (when s (txt "b")) (txt (if (first (arr true)) "c" "d")) (txt (not (first (arr (arr 1))))) (txt (and items (json-parse "1")))))'],
  ['E815 missing arms', '(app a (enum status open closed done) (state s status.open) (page "/" home (txt (match s ("open" "O")))))'],
  ['E103 string enum', '(app a (page "/" home (txt "x" :align "centre")))'],
  ['E103 ident enum', '(app a (page "/" home (txt "x" :weight semibld)))'],
  ['E205 token', '(app a (theme (token primary "#111")) (page "/" home (v :bg $primry (txt "x"))))'],
  ['E105 dangling keyword', '(app a (page "/" home (v :pad)))'],
  ['W401 W402', '(app a (page "/" home (img "/a.png") (btn (click (nav "/")))))'],
  ['W801 throwing op', '(app a (state s "") (page "/" home (txt (json-stringify (json-parse s)))))'],
  ['E106 dialog', '(app a (state show false) (page "/" home (dialog :title "Hi" (txt "Body"))))'],
  ['E106 link', '(app a (page "/" home (link (txt "x"))))'],
  ['E106 E102 component', '(app a (component chip (props (label string)) (txt label)) (page "/" home (chip :labl "x")))'],
  ['E106 stagger', '(app a (page "/" home (v :stagger 60 (txt "a") (txt "b"))))'],
  ['E206 path', '(app a (page "/p/{id}" detail (txt id)) (page "/" home (btn "go" (click (nav (path "/p/{id}" :idd 1))))))'],
  ['E206 fmt', '(app a (page "/" home (txt (fmt "Hi {name}" :nam "x"))))'],
  ['E206 t', '(app a (i18n (locale en (msg greeting "Hi {name}"))) (page "/" home (txt (t greeting :nam "x"))))'],
  ['E814 message key', '(app a (i18n (locale en (msg greeting "Hi"))) (page "/" home (txt (t greting))))'],
  ['E810 E805', '(app a (db (table t (id auto) (n number) (s string))) (api (post "/api/t" (insert t :n 1)) (put "/api/u" (update t :n 2))) (page "/" home (txt "x")))'],
  ['E811 E807', '(app a (db (table t (id auto) (n number))) (api (get "/api/t" (select t :order nn))) (data (resource items "/api/t" :default (arr))) (page "/" home (btn "r" (click (refresh itms)))))'],
  ['E204 resource field', '(app a (data (resource r "/x" :default (arr))) (page "/" home (txt r.datum)))'],
  ['E802 E803 seed', '(app a (db (table t (id auto) (n number)) (seed tt (row :n 1)) (seed t (row :nn 1))) (page "/" home (txt "x")))'],
  ['E812 enum member', '(app a (enum status open closed) (state s status.open) (page "/" home (btn "Done" (click (set s status.opn)))))'],
  ['E809 input fields', '(app a (db (table wishes (id auto) (name string))) (api (post "/api/wishes" (input (name string)) (insert wishes :name body.name))) (state n "") (page "/" home (btn "Add" (click (send post "/api/wishes" :nme n)))))'],
  ['E206 send path', '(app a (db (table t (id auto) (n number))) (api (put "/api/t/{id}" (update t :id id :n 1))) (page "/" home (btn "x" (click (send put (path "/api/t/{id}") :n 2)))))'],
  ['E701 E203 test steps', '(app a (page "/" home (txt "x")) (page "/about" about (txt "y")))\n(tests (test "t" (vist "/") (visit "/abot")))'],
  ['E109 expression op', '(app a (state xs (arr 1)) (page "/" home (txt (coun xs))))'],
  ['E110 action op', '(app a (state n 0) (page "/" home (btn "x" (click (sett n 1)))))'],
  ['E815 enum member pattern', '(app a (enum status open closed) (state s status.open) (page "/" home (txt (match s (status.opn "O") (status.closed "C")))))'],
  ['E815 enum head pattern', '(app a (enum status open closed) (state s status.open) (page "/" home (txt (match s (statuz.open "O") (status.closed "C")))))'],
  ['E203 string nav', '(app a (page "/" home (btn "go" (click (nav "/abot")))) (page "/about" about (txt "y")))'],
  ['E806 send route', '(app a (db (table w (id auto) (name string))) (api (post "/api/wishes" (insert w :name body.name))) (state n "") (page "/" home (btn "Add" (click (send post "/api/wish" :name n)))))'],
  ['E806 send path template', '(app a (db (table t (id auto) (n number))) (api (put "/api/t/{id}" (update t :id id :n 1))) (page "/" home (btn "x" (click (send put (path "/api/t/{idd}" :idd 1) :n 2)))))'],
  ['E805 select prop', '(app a (db (table t (id auto) (n number))) (api (get "/api/t" (select t :oder n))) (page "/" home (txt "x")))'],
  ['E201 where column', '(app a (db (table t (id auto) (name string))) (api (get "/api/t/{id}" (select t :where (= nme "x")))) (page "/" home (txt "x")))'],
  ['E818 malformed uploads', '(app a (uploads 5) (state p "") (page "/" home (file-input :label "Photo" :to p)))'],
  ['E201 empty segment', '(app a (state n 0) (page "/" home (txt .n) (btn "x" (click (set n. 1)))))'],
  ['E201 dotted set target', '(app a (state count 0) (page "/" home (btn "x" (click (set cont.x 1)))))'],
  ['E202 dotted set target', '(app a (state count 0) (page "/" home (btn "x" (click (set count.x 1)))))'],
  ['E201 bare enum', '(app a (enum status open closed) (state s status.open) (page "/" home (txt statu)))'],
  ['W801 throwing fn call', '(app a (fn p ((s string)) (json-parse s)) (state raw "") (page "/" home (txt (json-stringify (p raw)))))'],
];

describe('fix sweep', () => {
  const programs: [string, string][] = [
    ...fs.readdirSync(path.join(CORPUS, 'examples')).filter((f) => f.endsWith('.grhm')).map((f): [string, string] => [`example ${f}`, fs.readFileSync(path.join(CORPUS, 'examples', f), 'utf8')]),
    ...(JSON.parse(fs.readFileSync(path.join(CORPUS, 'repairs.json'), 'utf8')) as { repairs: { name: string; broken: string }[] }).repairs.map((r): [string, string] => [`repair ${r.name}`, r.broken]),
    ...SITE_PROGRAMS,
  ];

  for (const [name, source] of programs) {
    it(`${name}: every fix validates and every safe fix clears its diagnostic`, () => {
      const diags = diagnosticsOf(source);
      for (const d of diags) {
        const fixes = d.fixes ?? [];
        expect(fixes.filter((f) => f.confidence === 'safe').length).toBeLessThanOrEqual(1);
        expect(new Set(fixes.map((f) => f.id)).size).toBe(fixes.length);
        for (const [i, fix] of fixes.entries()) {
          const previous = fixes[i - 1];
          if (previous !== undefined) expect(CONFIDENCE_RANK[previous.confidence]).toBeLessThanOrEqual(CONFIDENCE_RANK[fix.confidence]);
          expectWellFormed(fix, source);
          if (fix.confidence !== 'safe') continue;
          const patched = applyTextEdits(source, fix.edits);
          expect(parse(patched).diagnostics.filter((e) => e.severity === 'error')).toEqual([]);
          expect(countOf(diagnosticsOf(patched), key(d))).toBeLessThan(countOf(diags, key(d)));
        }
      }
    });
  }

  it('bulk fixing at level review reaches a truthful fixed point and never rejects a fix it offered', () => {
    for (const [name, source] of programs) {
      const result = applyFixes(source, { level: 'review' });
      if (!result.ok) {
        // Only a program that does not parse is refused.
        expect(result.diagnostics[0]?.code, name).toBe('E503');
        continue;
      }
      // A rejection (`ineffective`, `broke-parse`, `invalid-edit`) would mean a builder produced an edit that fails its own diagnostic.
      expect(result.skipped.filter((s) => s.reason !== 'ambiguous' && s.reason !== 'deferred'), name).toEqual([]);
      expect(result.stopped, name).toBe('fixed-point');
      expect(applyFixes(result.newSource ?? source, { level: 'review' }), name).toMatchObject({ passes: 0, applied: [] });
    }
  });

  it('the corpus repairs expose the expected safe fixes', () => {
    const { repairs } = JSON.parse(fs.readFileSync(path.join(CORPUS, 'repairs.json'), 'utf8')) as { repairs: { name: string; code: string; broken: string; fixed: string; fix?: string }[] };
    const safeCodes = new Set<string>();
    for (const repair of repairs) {
      for (const d of diagnosticsOf(repair.broken)) {
        if (d.code === repair.code && preferredFix(d) !== undefined) safeCodes.add(d.code);
      }
    }
    // A code whose transcript exposes a safe fix has a transcript declared `safe` (replayed by tests/corpus.test.ts), and only those codes do.
    expect([...safeCodes].sort()).toEqual([...new Set(repairs.filter((r) => r.fix === 'safe').map((r) => r.code))].sort());
    // Where the transcript's fix is the safe spelling/declaration, applying it reproduces the documented `fixed` program.
    for (const name of ['typo in a style prop', 'insert into a column that does not exist', 'body field not in the input contract', 'file-input without an uploads declaration', 'send to a route the api does not declare']) {
      const repair = repairs.find((r) => r.name === name);
      if (repair === undefined) throw new Error(`missing repair ${name}`);
      const { fix } = find(repair.broken, repair.code);
      expect(fix.confidence).toBe('safe');
      expect(applyTextEdits(repair.broken, fix.edits)).toBe(repair.fixed);
    }
  });
});

describe('fix shapes', () => {
  it('E101 renames only the head identifier', () => {
    const source = '(app a (page "/" home (cardd (txt "x"))))';
    const { fix } = find(source, 'E101');
    expect(fix).toMatchObject({ title: 'Rename "cardd" to "card"', confidence: 'safe' });
    expect(fix.edits).toEqual([{ start: source.indexOf('cardd'), end: source.indexOf('cardd') + 5, text: 'card' }]);
    expect(applyTextEdits(source, fix.edits)).toBe('(app a (page "/" home (card (txt "x"))))');
  });

  it('a unique spelling is safe only when the typo leaves most of the name intact', () => {
    const confidenceOf = (source: string, code: string): [string, string | undefined] => {
      const { diagnostic, fix } = find(source, code);
      return [fix.confidence, preferredFix(diagnostic)?.title];
    };
    // One- and two-character names are rewrites, not typos: the suggestion stays, the fix asks for review.
    expect(confidenceOf('(app a (page "/" home (vv (txt "x"))))', 'E101')).toEqual(['review', undefined]);
    expect(confidenceOf('(app a (state n 0) (page "/" home (txt id)))', 'E201')).toEqual(['review', undefined]);
    expect(find('(app a (state n 0) (page "/" home (txt id)))', 'E201').diagnostic.suggestions).toEqual(['n']);
    // Three-character names tolerate one edit, longer names two.
    expect(confidenceOf('(app a (state n 0) (page "/" home (txt one)))', 'E201')).toEqual(['review', undefined]);
    expect(confidenceOf('(app a (state tags (arr)) (page "/" home (txt (count tgs))))', 'E201')).toEqual(['safe', 'Replace "tgs" with "tags"']);
    expect(confidenceOf('(app a (state total 0) (page "/" home (txt tolta)))', 'E201')).toEqual(['safe', 'Replace "tolta" with "total"']);
  });

  it('E201 re-spells only the head segment of a dotted identifier', () => {
    const source = '(app a (state count 0) (page "/" home (txt cont.length)))';
    const { fix } = find(source, 'E201');
    expect(fix.title).toBe('Replace "cont" with "count"');
    expect(applyTextEdits(source, fix.edits)).toBe('(app a (state count 0) (page "/" home (txt count.length)))');
  });

  it('E803/E808 re-spell only the field segment', () => {
    const source = '(app a (db (table wishes (id auto) (name string))) (api (post "/api/wishes" (input (name string)) (insert wishes :name body.nmae))) (page "/" home (txt "hi")))';
    const { fix } = find(source, 'E808');
    expect(applyTextEdits(source, fix.edits)).toContain(':name body.name)');
  });

  it('E803 column suggestions keep the colon and never suggest the id column to itself', () => {
    const source = '(app a (db (table wishes (id auto) (name string))) (api (post "/api/wishes" (insert wishes :nmae "y"))) (page "/" home (txt "x")))';
    const { diagnostic, fix } = find(source, 'E803');
    expect(diagnostic.suggestions).toEqual([':name']);
    expect(fix.title).toBe('Replace ":nmae" with ":name"');
    const selfHit = diagnosticsOf('(app a (db (table wishes (id auto) (name string))) (api (post "/api/wishes" (insert wishes :id 1 :name "y"))) (page "/" home (txt "x")))').find((d) => d.code === 'E803');
    expect(selfHit?.suggestions).toEqual([]);
    expect(selfHit?.fixes).toBeUndefined();
  });

  it('E103 keeps a string value quoted and an identifier bare', () => {
    expect(expectClears('(app a (page "/" home (txt "x" :align "centre")))', 'E103')).toBe('(app a (page "/" home (txt "x" :align "center")))');
    expect(expectClears('(app a (page "/" home (txt "x" :weight semibld)))', 'E103')).toBe('(app a (page "/" home (txt "x" :weight semibold)))');
  });

  it('E205 keeps the token sigil', () => {
    expect(expectClears('(app a (theme (token primary "#111")) (page "/" home (v :bg $primry (txt "x"))))', 'E205')).toContain(':bg $primary');
  });

  it('E812 replaces the whole enum read and leaves an over-long member path alone', () => {
    const { fix } = find('(app a (enum status open closed) (state s status.open) (page "/" home (btn "Done" (click (set s status.opn)))))', 'E812');
    expect(fix.title).toBe('Replace "status.opn" with "status.open"');
    const nested = diagnosticsOf('(app a (enum status open closed) (state s status.open) (page "/" home (btn "Done" (click (set s status.opn.x)))))').find((d) => d.code === 'E812');
    expect(nested?.suggestions).toEqual([]);
    expect(nested?.fixes).toBeUndefined();
  });

  it('E818 adds (uploads) right after the app name as a safe fix', () => {
    const source = '(app a (db (table t (id auto))) (state photo "") (page "/" home (file-input :label "Photo" :to photo)))';
    const { diagnostic, fix } = find(source, 'E818');
    expect(fix).toMatchObject({ title: 'Add (uploads) to app', confidence: 'safe' });
    expect(preferredFix(diagnostic)).toBe(fix);
    expect(expectClears(source, 'E818')).toBe('(app a (uploads) (db (table t (id auto))) (state photo "") (page "/" home (file-input :label "Photo" :to photo)))');
  });

  it('E111 offers a review or-else wrap and a placeholder not-null guard that both satisfy the checker', () => {
    const wrapped = expectClears('(app a (page "/" home (txt (+ (first (arr 1 2)) 1))))', 'E111', 'Wrap in (or-else … 0)');
    expect(wrapped).toBe('(app a (page "/" home (txt (+ (or-else (first (arr 1 2)) 0) 1))))');
    const { fix: review } = find('(app a (page "/" home (txt (+ (first (arr 1 2)) 1))))', 'E111');
    expect(review.confidence).toBe('review');
    const guarded = expectClears('(app a (db (table t (id auto) (n number))) (api (get "/api/x" (let ((r (first (select t)))) r.n))) (page "/" home (txt "x")))', 'E111', 'Wrap in (if (not-null r) … null) (fill in)');
    expect(guarded).toContain('(let ((r (first (select t)))) (if (not-null r) r.n null))');
    expect(diagnosticsOf(guarded).filter((d) => d.code === 'E111')).toEqual([]);
    expect(diagnosticsOf('(app a (page "/" home (txt (count (first (arr (arr 1)))))))').find((d) => d.code === 'E111')?.fixes).toBeUndefined();
  });

  it('E815 adds every missing arm in one placeholder fix', () => {
    const source = '(app a (enum status open closed done) (state s status.open) (page "/" home (txt (match s ("open" "O")))))';
    const { fix } = find(source, 'E815');
    expect(fix).toMatchObject({ title: 'Add missing match arms (fill in)', confidence: 'placeholder' });
    expect(fix.edits).toHaveLength(1);
    expect(expectClears(source, 'E815')).toContain('(match s ("open" "O") (status.closed null) (status.done null))');
  });

  it('tied spellings are review fixes with no preferred entry', () => {
    const { diagnostic } = find('(app a (state count 0) (state cent 0) (page "/" home (txt cont)))', 'E201');
    expect(diagnostic.suggestions).toEqual(['count', 'cent']);
    expect(diagnostic.fixes?.map((f) => [f.confidence, f.title])).toEqual([['review', 'Replace "cont" with "count"'], ['review', 'Replace "cont" with "cent"']]);
    expect(preferredFix(diagnostic)).toBeUndefined();
  });

  it('set targets only consider writable bindings', () => {
    const source = '(app a (data (resource counts "/x" :default (arr))) (state count 0) (page "/" home (btn "x" (click (set coun 1)))))';
    const { diagnostic } = find(source, 'E201');
    expect(diagnostic.suggestions).toEqual(['count']);
  });

  it('placeholder and review insertions clear their diagnostics', () => {
    expect(expectClears('(app a (page "/" home (link (txt "x"))))', 'E106')).toContain('(link :to "" (txt "x"))');
    expect(expectClears('(app a (component chip (props (label string)) (txt label)) (page "/" home (chip)))', 'E106')).toContain('(chip :label "")');
    expect(expectClears('(app a (page "/" home (v :stagger 60 (txt "a") (txt "b"))))', 'E106')).toContain('(v :stagger 60 :enter fade');
    expect(expectClears('(app a (page "/" home (v :pad)))', 'E105')).toBe('(app a (page "/" home (v )))');
    expect(expectClears('(app a (db (table t (id auto) (n number) (s string))) (api (post "/api/t" (insert t :n 1))) (page "/" home (txt "x")))', 'E810')).toContain('(insert t :s "" :n 1)');
    expect(expectClears('(app a (db (table w (id auto) (name string))) (api (post "/api/w" (input (name string)) (insert w :name body.name))) (page "/" home (btn "Add" (click (send post "/api/w")))))', 'E809')).toContain('(send post "/api/w" :name "")');
    expect(expectClears('(app a (data (resource users "/x")) (page "/" home (txt (count users.data))))', 'W301')).toContain('(resource users "/x" :default null)');
    expect(expectClears('(app a (page "/" home (img "/a.png")))', 'W401')).toContain('(img "/a.png" :alt "")');
    expect(expectClears('(app a (page "/" home (btn (click (nav "/")))))', 'W402')).toContain('(btn "Label" (click');
    expect(expectClears('(app a (page "/" home (txt (fmt "Hi {name}"))))', 'E206')).toContain('(fmt "Hi {name}" :name "")');
  });

  it('slots that take a reference or an action form get no placeholder, only received/expected', () => {
    const noFix = (source: string, code: string, field?: string): void => {
      const diags = diagnosticsOf(source).filter((d) => d.code === code && (field === undefined || d.field === field));
      expect(diags.length, source).toBeGreaterThan(0);
      for (const d of diags) {
        expect(d.fixes, source).toBeUndefined();
        expect(d.expected, source).toBeDefined();
      }
    };
    noFix('(app a (state show false) (page "/" home (dialog :title "Hi" (txt "Body"))))', 'E106');
    noFix('(app a (uploads) (page "/" home (file-input :label "Photo")))', 'E818', 'to');
    noFix('(app a (db (table t (id auto) (n number))) (api (put "/api/u" (update t :n 2))) (page "/" home (txt "x")))', 'E805', 'id');
    noFix('(app a (page "/p/{id}" detail (txt id)) (page "/" home (btn "go" (click (nav (path "/p/{id}"))))))', 'E206');
    noFix('(app a (db (table t (id auto) (n number))) (api (put "/api/t/{id}" (update t :id id :n 1))) (page "/" home (btn "x" (click (send put (path "/api/t/{id}") :n 2)))))', 'E206');
    noFix('(app a (component chip (props (on-pick action)) (btn "x" (click on-pick))) (page "/" home (chip)))', 'E106');
  });

  it('E109, E110, E815, E203, E806, E805, and :where columns re-spell from the names valid in their position', () => {
    expect(expectClears('(app a (state xs (arr 1)) (page "/" home (txt (coun xs))))', 'E109')).toContain('(count xs)');
    expect(expectClears('(app a (state n 0) (page "/" home (btn "x" (click (sett n 1)))))', 'E110')).toContain('(set n 1)');
    const match = (pattern: string): string => `(app a (enum status open closed) (state s status.open) (page "/" home (txt (match s (${pattern} "O") (status.closed "C")))))`;
    expect(expectClears(match('status.opn'), 'E815', 'Replace "status.opn" with "status.open"')).toContain('(status.open "O")');
    expect(expectClears(match('statuz.open'), 'E815', 'Replace "statuz.open" with "status.open"')).toContain('(status.open "O")');
    expect(expectClears('(app a (page "/" home (btn "go" (click (nav "/abot")))) (page "/about" about (txt "y")))', 'E203')).toContain('(nav "/about")');
    expect(expectClears('(app a (db (table w (id auto) (name string))) (api (post "/api/wishes" (insert w :name body.name))) (state n "") (page "/" home (btn "Add" (click (send post "/api/wish" :name n)))))', 'E806')).toContain('(send post "/api/wishes" :name n)');
    // A (path ...) template is re-spelled inside its quotes; the params stay for the next pass.
    expect(expectClears('(app a (db (table t (id auto) (n number))) (api (put "/api/t/{id}" (update t :id id :n 1))) (page "/" home (btn "x" (click (send put (path "/api/t/{idd}" :idd 1) :n 2)))))', 'E806')).toContain('(path "/api/t/{id}" :idd 1)');
    expect(expectClears('(app a (db (table t (id auto) (n number))) (api (get "/api/t" (select t :oder n))) (page "/" home (txt "x")))', 'E805')).toContain('(select t :order n)');
    const where = find('(app a (db (table t (id auto) (name string))) (api (get "/api/t/{id}" (select t :where (= nme "x")))) (page "/" home (txt "x")))', 'E201');
    expect(where.diagnostic).toMatchObject({ received: 'nme', expected: 'id | name', suggestions: ['name'] });
    expect(where.fix.title).toBe('Replace "nme" with "name"');
    // A static route is never re-spelled to a parametrised template.
    expect(diagnosticsOf('(app a (page "/" home (btn "go" (click (nav "/p/x")))) (page "/p/{id}" detail (txt id)))').find((d) => d.code === 'E203')?.fixes).toBeUndefined();
  });

  it('E818 inserts (uploads) only when the app declares none', () => {
    for (const declared of ['(uploads 5)', '(uploads :max-kb "x")']) {
      const source = `(app a ${declared} (state p "") (page "/" home (file-input :label "Photo" :to p)))`;
      const diags = diagnosticsOf(source);
      expect(diags.map((d) => d.code), declared).toEqual(['E818', 'E818']);
      expect(diags.map((d) => d.fixes), declared).toEqual([undefined, undefined]);
      expect(applyFixes(source), declared).toMatchObject({ applied: [], clean: false });
      expect(applyFixes(source).newSource, declared).toBeUndefined();
    }
  });

  it('an empty path segment is a malformed reference with no spelling', () => {
    const sources = [
      '(app a (state n 0) (page "/" home (txt .n)))',
      '(app a (state n 0) (page "/" home (txt n.)))',
      '(app a (state rows (arr (obj :n 1))) (page "/" home (each r rows (txt r.))))',
      '(app a (state n 0) (page "/" home (btn "x" (click (set .n 1)))))',
      '(app a (state n 0) (page "/" home (btn "x" (click (set n..x 1)))))',
    ];
    for (const source of sources) {
      const diags = diagnosticsOf(source);
      expect(diags.map((d) => d.code), source).toEqual(['E201']);
      expect(diags[0], source).toMatchObject({ message: expect.stringContaining('empty path segment') as string, expected: 'a name or dotted path such as item.field' });
      expect(diags[0]?.fixes, source).toBeUndefined();
      expect(diags[0]?.suggestions, source).toBeUndefined();
      expect(applyFixes(source, { level: 'review' }).applied, source).toEqual([]);
    }
  });

  it('set re-spells only the head of a dotted target and refuses a field path on a known state', () => {
    const source = '(app a (state count 0) (page "/" home (btn "x" (click (set cont.x 1)))))';
    const { diagnostic, fix } = find(source, 'E201');
    expect(diagnostic).toMatchObject({ message: 'Unknown reference "cont"', received: 'cont' });
    expect(fix).toMatchObject({ title: 'Replace "cont" with "count"', confidence: 'safe' });
    expect(applyTextEdits(source, fix.edits)).toBe('(app a (state count 0) (page "/" home (btn "x" (click (set count.x 1)))))');
    const dotted = diagnosticsOf('(app a (state count 0) (page "/" home (btn "x" (click (set count.x 1)))))');
    expect(dotted.map((d) => [d.code, d.received, d.expected, d.fixes])).toEqual([['E202', 'count.x', 'state | local', undefined]]);
  });

  it('spelling candidates are the names valid in the position', () => {
    // A bare enum is never a value; a dotted head may be one.
    const enums = (expr: string): Diagnostic | undefined => diagnosticsOf(`(app a (enum status open closed) (state s status.open) (page "/" home (txt ${expr})))`).find((d) => d.code === 'E201');
    expect(enums('statu')?.suggestions).toEqual([]);
    expect(enums('statu')?.fixes).toBeUndefined();
    expect(enums('statu.open')?.fixes?.map((f) => [f.confidence, f.title])).toEqual([['safe', 'Replace "statu" with "status"']]);
    expect(find('(app a (enum mode a b) (state model "") (page "/" home (txt modl)))', 'E201').fix.title).toBe('Replace "modl" with "model"');
    // Element position never suggests a declaration or an action; action position suggests only actions.
    expect(diagnosticsOf('(app a (state n 0) (page "/" home (sett "x")))').find((d) => d.code === 'E101')?.suggestions).not.toContain('set');
    expect(diagnosticsOf('(app a (page "/" home (stat "x")))').find((d) => d.code === 'E101')?.suggestions).not.toContain('state');
    expect(find('(app a (state n 0) (page "/" home (btn "x" (click (sett n 1)))))', 'E110').fix.title).toBe('Rename "sett" to "set"');
    expect(diagnosticsOf('(app a (state n 0) (page "/" home (btn "x" (click (txtt n)))))').find((d) => d.code === 'E110')?.suggestions).toEqual([]);
  });

  it('W801 at a call of a throwing fn wraps the call, and a bare fn reference gets no wrap', () => {
    const source = '(app a (fn p ((s string)) (json-parse s)) (state raw "") (page "/" home (txt (json-stringify (p raw)))))';
    expect(find(source, 'W801').fix).toMatchObject({ title: 'Wrap in (attempt … null) (fill in)', confidence: 'placeholder' });
    expect(expectClears(source, 'W801')).toContain('(attempt (p raw) null)');
    const mapped = diagnosticsOf('(app a (fn p ((s string)) (json-parse s)) (state raw "") (page "/" home (txt (json-stringify (map p (arr raw))))))').find((d) => d.code === 'W801');
    expect(mapped?.message).toBe('"map" calls "p", which may throw at runtime; wrap in (attempt expr fallback)');
    expect(mapped?.fixes).toBeUndefined();
  });

  it('W801 wraps the throwing call in attempt with the zero value of its result type as the placeholder fallback', () => {
    const page = (expr: string): string => `(app a (state s "") (state n 0) (page "/" home (txt ${expr})))`;
    expect(find(page('(json-stringify (json-parse s))'), 'W801').fix).toMatchObject({ title: 'Wrap in (attempt … null) (fill in)', confidence: 'placeholder' });
    expect(expectClears(page('(if (regex-test s "abc") "y" "n")'), 'W801')).toContain('(if (attempt (regex-test s "abc") false) "y" "n")');
    expect(expectClears(page('(url-decode s)'), 'W801')).toContain('(attempt (url-decode s) "")');
    expect(expectClears(page('(date-iso n)'), 'W801')).toContain('(attempt (date-iso n) "")');
    expect(expectClears(page('(regex-replace s "b" "abc")'), 'W801')).toContain('(attempt (regex-replace s "b" "abc") "")');
    expect(expectClears(page('(json-stringify (chunk n (arr 1)))'), 'W801')).toContain('(attempt (chunk n (arr 1)) (arr))');
    expect(expectClears(page('(json-stringify (json-parse s))'), 'W801')).toContain('(attempt (json-parse s) null)');
    expect(expectClears(page('(json-stringify (regex-find s "abc"))'), 'W801')).toContain('(attempt (regex-find s "abc") null)');
  });

  it('test suites get step and route spellings', () => {
    const source = '(app a (page "/" home (txt "x")) (page "/about" about (txt "y")))\n(tests (test "t" (vist "/") (visit "/abot")))';
    expect(expectClears(source, 'E701')).toContain('(visit "/")');
    expect(expectClears(source, 'E203')).toContain('(visit "/about")');
  });

  it('fixes in included files carry that file and its offsets', () => {
    const files = new Map<string, string>([
      ['app.grhm', '(app a (include "shared.grhm") (page "/" home (chip)))'],
      ['shared.grhm', '(component chip (txt "x" :colr "#fff"))'],
    ]);
    const result = compileProject(loadProject('app.grhm', (p) => files.get(p)));
    const fix = result.diagnostics.find((d) => d.code === 'E102')?.fixes?.[0];
    const shared = files.get('shared.grhm') ?? '';
    expect(fix?.edits).toEqual([{ file: 'shared.grhm', start: shared.indexOf(':colr'), end: shared.indexOf(':colr') + 5, text: ':color' }]);
  });
});
