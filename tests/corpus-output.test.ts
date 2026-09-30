import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createElement, type ComponentType } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer, type ViteDevServer } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { compile, pageFnName, type CompileResult } from '../src/codegen/index.js';

const ROOT = path.join(__dirname, '..');
const EXAMPLES = path.join(ROOT, 'corpus', 'examples');
const examples = fs.readdirSync(EXAMPLES).filter((file) => file.endsWith('.grhm')).sort();
const compiled = new Map<string, CompileResult>();
let directory: string;
let server: ViteDevServer | undefined;
let typecheck: { status: number | null; output: string };

beforeAll(async () => {
  directory = fs.mkdtempSync(path.join(ROOT, '.tmp-corpus-output-'));
  for (const file of examples) {
    const result = compile(fs.readFileSync(path.join(EXAMPLES, file), 'utf8'));
    expect(result.diagnostics.filter((diagnostic) => diagnostic.severity === 'error'), file).toEqual([]);
    compiled.set(file, result);
    const appRoot = path.join(directory, path.basename(file, '.grhm'));
    for (const [name, content] of result.files) {
      const target = path.join(appRoot, 'src', 'gen', name);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content);
    }
    // Use the actual corpus dependencies: missing modules must fail the gate,
    // rather than being hidden by an ambient declaration or an any-typed stub.
    const dependencies = [...(result.app?.imports.values() ?? [])];
    const modules = [...dependencies.map((dependency) => dependency.module), ...(result.app?.auth?.provider ? [result.app.auth.provider] : [])];
    for (const module of modules) {
      const dependency = { module };
      if (!dependency.module.startsWith('./')) continue;
      const source = path.resolve(EXAMPLES, dependency.module);
      expect(source.startsWith(EXAMPLES + path.sep), dependency.module).toBe(true);
      const target = path.resolve(appRoot, dependency.module);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(source, target);
    }
  }
  fs.writeFileSync(path.join(directory, 'tsconfig.json'), JSON.stringify({
    compilerOptions: {
      target: 'ES2022', lib: ['ES2022', 'DOM', 'DOM.Iterable'], module: 'ESNext',
      moduleResolution: 'bundler', jsx: 'react-jsx', strict: true, skipLibCheck: true,
      noEmit: true, allowImportingTsExtensions: true, types: ['node'],
    },
    include: ['**/*.ts', '**/*.tsx'],
  }));
  const tsc = path.join(ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'tsc.cmd' : 'tsc');
  const result = spawnSync(tsc, ['-p', path.join(directory, 'tsconfig.json')], { encoding: 'utf8', timeout: 30_000 });
  typecheck = { status: result.status, output: result.stdout + result.stderr + (result.error?.message ?? '') };
  server = await createServer({
    root: directory, configFile: false, logLevel: 'error',
    server: { middlewareMode: true, hmr: false, watch: null },
    appType: 'custom',
    resolve: { dedupe: ['react', 'react-dom'] },
  });
}, 45_000);

afterAll(async () => {
  await server?.close();
  if (directory !== undefined) fs.rmSync(directory, { recursive: true, force: true });
});

describe('complete generated corpus output', () => {
  it('passes strict TypeScript for every generated client, library, server, and interop dependency', () => {
    expect(typecheck.status, typecheck.output).toBe(0);
    expect(typecheck.output).toBe('');
  });

  for (const file of examples) {
    it(`${file} renders every generated page using real React`, async () => {
      const result = compiled.get(file)!;
      expect(result.app?.pages.length).toBeGreaterThan(0);
      try {
        for (const page of result.app!.pages) {
          const exportName = pageFnName(page);
          const modulePath = [...result.files].find(([name, content]) => name.startsWith('pages/') && content.includes(`export function ${exportName}(`))?.[0];
          expect(modulePath, `${file}: ${page.name}`).toBeDefined();
          const module = await server!.ssrLoadModule(`/${path.basename(file, '.grhm')}/src/gen/${modulePath}`);
          const Page = module[exportName] as ComponentType<{ params: Record<string, string> }>;
          const params = Object.fromEntries(page.params.map((param) => [param, '1']));
          const markup = renderToStaticMarkup(createElement(Page, { params }));
          expect(typeof markup).toBe('string');
          // Some valid pages render an empty list; nonempty output must be HTML.
          if (markup !== '') expect(markup).toContain('<');
        }
      } finally {
        const runtime = await server!.ssrLoadModule(`/${path.basename(file, '.grhm')}/src/gen/runtime.ts`);
        runtime.resetResources();
      }
    });
  }
});
