import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { allOps, EXPR_OPS, STYLE_PROPS, MOTION_PROPS, TEST_STEPS, SERVER_OPS } from '../../dist/schema.js';
import { CODE_DOCS } from '../../dist/diagnostics.js';
import { generateReference } from '../../dist/reference.js';
import { compile } from '../../dist/codegen/index.js';
import { examples } from '../dist/examples.js';
import { buildAgentExample } from './agent-example.mjs';

const site = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(site, 'dist');
const modelReference = generateReference();
const specialForms = modelReference.split('\n')
  .filter(line => ['(lambda ', '(let ', '(if cond ', '(send ', '(refresh ', '(call target.'].some(prefix => line.startsWith(prefix)))
  .map(doc => ({name: doc.slice(1).split(' ')[0], doc}));
const reference = {ops: allOps(), expressions: EXPR_OPS, styles: STYLE_PROPS, motion: MOTION_PROPS, tests: TEST_STEPS, server: SERVER_OPS, diagnostics: CODE_DOCS, specialForms};
fs.writeFileSync(path.join(output, 'reference.json'), JSON.stringify(reference));
fs.writeFileSync(path.join(output, 'language-reference.txt'), modelReference);
fs.writeFileSync(path.join(output, 'agent-example.js'), `export const agentExample = ${JSON.stringify(buildAgentExample(), null, 2)};\n`);
fs.mkdirSync(path.join(output, 'examples'), {recursive:true});
for (const example of examples) {
  const result = compile(example.source);
  const errors = result.diagnostics.filter(d => d.severity === 'error');
  if (errors.length) throw new Error(`${example.id}: ${JSON.stringify(errors)}`);
  fs.writeFileSync(path.join(output, 'examples', example.id + '.grhm'), result.canonicalSource ?? example.source);
}
console.log(`Synchronized ${reference.ops.length} operations, ${Object.keys(reference.expressions).length} expressions, and ${examples.length} compiler-checked examples.`);
