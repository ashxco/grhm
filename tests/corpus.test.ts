import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { compile } from '../src/codegen/index.js';
import { format } from '../src/format.js';
import { parse } from '../src/parser.js';
import { applyPatch } from '../src/patch.js';

/**
 * The grounding corpus (PRD FR-15) must never drift from the compiler:
 * every example compiles cleanly and is canonically formatted; every repair
 * transcript reproduces its diagnostic and its fix compiles; every patch
 * transcript applies and produces the documented result.
 */

const CORPUS = path.join(__dirname, '..', 'corpus');

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

describe('corpus repair transcripts', () => {
  const { repairs } = JSON.parse(fs.readFileSync(path.join(CORPUS, 'repairs.json'), 'utf8')) as {
    repairs: { name: string; code: string; broken: string; fixed: string }[];
  };

  for (const repair of repairs) {
    it(`${repair.name}: broken emits ${repair.code}, fixed is clean`, () => {
      const diagnostic = compile(repair.broken).diagnostics.find((d) => d.code === repair.code);
      expect(diagnostic?.span).toBeDefined();
      expect(diagnostic?.received !== undefined || diagnostic?.expected !== undefined || !!diagnostic?.suggestions?.length).toBe(true);
      const fixedErrors = compile(repair.fixed).diagnostics.filter((d) => d.severity === 'error');
      expect(fixedErrors).toEqual([]);
    });
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
