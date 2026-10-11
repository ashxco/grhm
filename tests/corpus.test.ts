import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { compile } from '../src/codegen/index.js';
import { CODE_DOCS } from '../src/diagnostics.js';
import { applyFixes } from '../src/fix.js';
import { format } from '../src/format.js';
import { parse } from '../src/parser.js';
import { applyPatch } from '../src/patch.js';
import { loadRepairs } from '../src/repairs.js';

/**
 * The grounding corpus (PRD FR-15) must never drift from the compiler:
 * every example compiles cleanly and is canonically formatted; every repair
 * transcript reproduces its diagnostic and its fix compiles; every patch
 * transcript applies and produces the documented result. Repairs that declare
 * a `fix` level must replay through the fix applier to exactly the documented
 * program, and undeclared repairs must not become auto-fixable unnoticed: bulk
 * safe fixing must leave their documented diagnostic in place. Every code the
 * compiler can emit for a single-file program has at least one repair, so
 * `grhm codes <CODE>` always has a worked example to show.
 */

const CORPUS = path.join(__dirname, '..', 'corpus');
const canonical = (source: string): string => format(parse(source).nodes);

describe('corpus examples', () => {
  const files = fs.readdirSync(path.join(CORPUS, 'examples')).filter((f) => f.endsWith('.grhm'));

  it('covers a meaningful set of programs', () => {
    expect(files.length).toBeGreaterThanOrEqual(10);
  });

  for (const file of files) {
    it(`${file} compiles with zero errors and is canonical`, () => {
      const source = fs.readFileSync(path.join(CORPUS, 'examples', file), 'utf8');
      const result = compile(source);
      expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
      expect(format(parse(source).nodes)).toBe(source);
    });
  }
});

/**
 * Codes `compile()` cannot emit for a single-file program, so no repair
 * transcript can reproduce them.
 */
const UNREPRODUCIBLE_CODES = new Set([
  // Patch and fix pipeline: replayed by corpus/patches.json and tests/fix.test.ts instead.
  'E501', 'E502', 'E503', 'E504', 'W501',
  // GrhmProject.load filesystem checks: an interop module missing on disk or from node_modules.
  'E602', 'W602',
  // Project loader: a missing file, cycle, unsafe path, or budget needs a multi-file project; the
  // single-file fallback can only say that no loader ran, which a transcript would "fix" by deleting the include.
  'E603',
  // The CLI's catch-all envelope for thrown errors, never a compiler diagnostic.
  'E900',
]);

describe('corpus repair transcripts', () => {
  // The shared loader validates the file's shape (name, code, note, broken, fixed, optional fix level).
  const repairs = loadRepairs(path.join(CORPUS, 'repairs.json'));

  it('declares fix levels from the applier vocabulary only', () => {
    expect(repairs.every((r) => r.fix === undefined || r.fix === 'safe' || r.fix === 'review')).toBe(true);
    expect(repairs.filter((r) => r.fix !== undefined).length).toBeGreaterThanOrEqual(10);
  });

  it('covers every diagnostic code a single-file compile can emit', () => {
    const covered = new Set(repairs.map((r) => r.code));
    expect(Object.keys(CODE_DOCS).filter((code) => !UNREPRODUCIBLE_CODES.has(code) && !covered.has(code))).toEqual([]);
    // An exemption that gains a transcript is stale: drop it from the set.
    expect(repairs.filter((r) => UNREPRODUCIBLE_CODES.has(r.code))).toEqual([]);
    expect([...covered].filter((code) => CODE_DOCS[code] === undefined)).toEqual([]);
  });

  for (const repair of repairs) {
    it(`${repair.name}: broken emits ${repair.code}, fixed is clean`, () => {
      const diagnostic = compile(repair.broken).diagnostics.find((d) => d.code === repair.code);
      expect(diagnostic?.span).toBeDefined();
      expect(diagnostic?.received !== undefined || diagnostic?.expected !== undefined || !!diagnostic?.suggestions?.length).toBe(true);
      const fixedErrors = compile(repair.fixed).diagnostics.filter((d) => d.severity === 'error');
      expect(fixedErrors).toEqual([]);
    });

    if (repair.fix !== undefined) {
      it(`${repair.name}: grhm fix --level ${repair.fix} replays the documented fix`, () => {
        const result = applyFixes(repair.broken, { level: repair.fix });
        expect(result.ok && result.clean, JSON.stringify(result.diagnostics)).toBe(true);
        expect(canonical(result.newSource ?? '')).toBe(canonical(repair.fixed));
      });
    } else {
      it(`${repair.name}: is not auto-fixable at level safe`, () => {
        // The documented diagnostic must survive bulk safe fixing (a refused run
        // touches nothing); `clean` alone would pass trivially for a warning-only transcript.
        const result = applyFixes(repair.broken, { level: 'safe' });
        expect(!result.ok || result.diagnostics.some((d) => d.code === repair.code), `${repair.name} now replays at level safe; declare "fix": "safe"`).toBe(true);
      });
    }
  }
});

describe('corpus patch transcripts', () => {
  const { patches } = JSON.parse(fs.readFileSync(path.join(CORPUS, 'patches.json'), 'utf8')) as {
    patches: { name: string; source: string; patch: string; expect: string }[];
  };

  for (const entry of patches) {
    it(`${entry.name}: applies and produces the documented result`, () => {
      const revision = compile(entry.source).revision;
      const result = applyPatch(entry.source, entry.patch.replace('$REVISION', revision));
      expect(result.ok).toBe(true);
      expect(result.newSource ?? '').toContain(entry.expect);
    });
  }
});
