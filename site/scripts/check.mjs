import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { articles, pages } from '../dist/content.js';
import { examples } from '../dist/examples.js';
import { compile } from '../../dist/codegen/index.js';
import { parse } from '../../dist/parser.js';
import { allOps, EXPR_OPS } from '../../dist/schema.js';
import { agentExample } from '../dist/agent-example.js';
import { buildAgentExample } from './agent-example.mjs';

const site = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(site, 'dist');
let snippets = 0;
const content = articles((source, label = 'app.grhm') => {
  if (label.endsWith('.grhm')) {
    const result = parse(source);
    assert.deepEqual(result.diagnostics, [], label);
    snippets++;
  }
  return '<pre></pre>';
});
const routes = new Set(['/', '/examples', ...pages.map(([id]) => '/docs' + (id ? '/' + id : ''))]);
const home = fs.readFileSync(path.join(output, 'app.js'), 'utf8');
for (const [,target] of home.matchAll(/href="(\/[^"]*)"/g)) {
  const url = new URL(target, 'http://localhost');
  assert.ok(routes.has(url.pathname) || fs.existsSync(path.join(output, url.pathname)), `broken homepage link: ${target}`);
  if (url.hash && url.pathname.startsWith('/docs')) {
    const slug = url.pathname.replace(/^\/docs\/?/, '');
    assert.ok(content[slug]?.sections.some(s => s.id === url.hash.slice(1)), `broken guide anchor: ${target}`);
  }
}
for (const [slug, page] of Object.entries(content)) {
  assert.ok(routes.has('/docs' + (slug ? '/' + slug : '')), slug);
  const ids = new Set(page.sections.map(s => s.id));
  assert.equal(ids.size, page.sections.length, 'duplicate section anchor');
  for (const match of page.sections.map(s=>s.body).join('').matchAll(/href="([^"#]+)(?:#[^"]*)?"/g)) {
    assert.ok(routes.has(match[1]), `broken route in ${slug}: ${match[1]}`);
  }
}
for (const example of examples) {
  const result = compile(example.source);
  assert.deepEqual(result.diagnostics.filter(d=>d.severity==='error'), [], example.id);
  const downloaded = fs.readFileSync(path.join(output,'examples',example.id+'.grhm'),'utf8');
  assert.equal(compile(downloaded).revision, result.revision, `outdated download: ${example.id}`);
}
const reference = JSON.parse(fs.readFileSync(path.join(output,'reference.json'),'utf8'));
assert.deepEqual(agentExample, buildAgentExample(), 'regenerate agent workflow with npm run site:sync');
assert.deepEqual(reference.ops, allOps(), 'regenerate reference with npm run site:sync');
assert.deepEqual(reference.expressions, JSON.parse(JSON.stringify(EXPR_OPS)), 'regenerate reference with npm run site:sync');
for (const asset of ['index.html','app.js','content.js','style.css','reference.json','language-reference.txt','demo/index.html','fonts/dm-sans-latin-variable.woff2','fonts/ibm-plex-mono-latin-400.woff2']) assert.ok(fs.statSync(path.join(output, asset)).size > 0, asset);
const css = fs.readFileSync(path.join(output,'style.css'),'utf8');
for (const [,asset] of css.matchAll(/url\(['"]?(\/[^)'" ]+)/g)) assert.ok(fs.existsSync(path.join(output,asset)),asset);
assert.equal(/https?:\/\//.test(css), false, 'styles should not load remote assets');
console.log(`${routes.size} routes, ${snippets} guide snippets, ${examples.length} compiled examples, verified agent patch/diagnostic workflow, schema reference, and local assets checked.`);
