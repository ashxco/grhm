import assert from 'node:assert/strict';
import { compile } from '../../dist/codegen/index.js';
import { loadProject, projectRevision } from '../../dist/project.js';
import { applyPatch } from '../../dist/patch.js';

// Regenerated with the local compiler so the site never invents tool responses.
export function buildAgentExample() {
  const source = `(app catalog
  (page "/" home
    (grid :id "product-grid"
      :cols 4 :gap 16
      (txt "Books")
      (txt "Music")
      (txt "Film")
      (txt "Art"))))`;
  const revision = projectRevision(loadProject('app.grhm', file => file === 'app.grhm' ? source : undefined));
  const patch = `(patch :revision "${revision}"
  :target product-grid
  (set cols 3))`;
  const result = applyPatch(source, patch);
  assert.equal(result.ok, true);
  assert.deepEqual(result.diagnostics, []);
  const { newSource, newSources: _sources, ...response } = result;
  assert.deepEqual(compile(newSource).diagnostics, []);
  const stale = applyPatch(newSource, patch);
  assert.equal(stale.conflict, true);
  const broken = '(app hello\n  (page "/" home\n    (txt "Hello" :id "greeting" :colr "#d3f5a2")))';
  const diagnostic = compile(broken).diagnostics.find(d => d.code === 'E102');
  assert.ok(diagnostic?.suggestions?.includes(':color'));
  const invalid = applyPatch(source, patch.replace('(set cols 3)', '(set colz 3)'));
  assert.equal(invalid.ok, false);
  assert.equal(invalid.newSource, undefined);
  return { source, revision, patch, result: { schema: 1, ...response }, after: newSource, broken, diagnostic };
}
