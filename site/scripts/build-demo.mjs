import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { compile } from '../../dist/codegen/index.js';
import { examples } from '../dist/examples.js';

const site = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const work = path.join(site, '.generated', 'demo');
fs.mkdirSync(work, {recursive:true});
const result = compile(examples[0].source);
const errors = result.diagnostics.filter(d => d.severity === 'error');
if (errors.length) throw new Error(JSON.stringify(errors));
for (const [name, content] of result.files) {
  const target = path.join(work, 'gen', name);
  fs.mkdirSync(path.dirname(target), {recursive:true});
  fs.writeFileSync(target, content);
}
fs.writeFileSync(path.join(work, 'main.tsx'), `import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { PageHome } from './gen/pages/home';
import './gen/styles.css';
import './demo.css';
createRoot(document.getElementById('root')!).render(createElement(PageHome, {params:{}}));
`);
fs.writeFileSync(path.join(work, 'index.html'), `<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>GRHM counter preview</title></head><body><div id="root"></div><script type="module" src="./main.tsx"></script></body></html>`);
fs.writeFileSync(path.join(work, 'demo.css'), `@font-face{font-family:'DM Sans';font-weight:400 700;src:url('/fonts/dm-sans-latin-variable.woff2') format('woff2');font-display:swap}
html,body{margin:0;background:#e9ede4;color:#1f2920;font-family:'DM Sans',Arial,sans-serif}body{min-height:100vh;display:flex;align-items:center}#root{width:100%}#root>div{padding:44px 48px;gap:17px;align-items:flex-start}h1{font-size:30px!important;line-height:1.2;font-weight:500;letter-spacing:-1px;margin:0}p{margin:0}button{font-family:inherit!important;font-size:14px!important;padding:13px 20px!important;min-height:46px;border-radius:4px!important;border:1px solid #26372a!important;background:#26372a!important;color:#f2f5ed!important;cursor:pointer}button+button{background:transparent!important;color:#354231!important;border-color:#bdc7b7!important}button:hover{filter:brightness(1.12)}button:focus-visible{outline:2px solid #26372a;outline-offset:4px}
@media(max-width:400px){#root>div{padding:36px 32px}}`);
await build({root:work,configFile:false,base:'/demo/',logLevel:'warn',build:{outDir:path.join(site,'dist','demo'),emptyOutDir:true},resolve:{dedupe:['react','react-dom']}});
console.log('Built the homepage preview from the actual GRHM compiler output.');
