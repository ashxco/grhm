/// <reference lib="dom" />
// @vitest-environment jsdom

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { act, createElement, StrictMode, type ComponentType } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer, type ViteDevServer } from 'vite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { compile } from '../src/codegen/index.js';

const ROOT = path.join(__dirname, '..');
const SOURCE = `(app local-values
  (use "./effects.ts"
    (import make-initial makeInitial)
    (import make-next makeNext)
    (import note-render noteRender))
  (page "/" home
    (local value (make-initial))
    (v
      (txt (note-render (or-else (to-num (first (map value (arr 3)))) 0)))
      (btn "Replace" (click (set value (make-next)))))))`;
const EFFECTS = `export const counts = {
  renders: 0, initializers: 0, replacements: 0,
  initialCalls: [] as number[], replacementCalls: [] as number[],
};
export function makeInitial(): (value: number) => number {
  counts.initializers++;
  return (value: number) => { counts.initialCalls.push(value); return value + 1; };
}
const replacement = (value: number): number => { counts.replacementCalls.push(value); return value * 3; };
export function makeNext(): (value: number) => number { counts.replacements++; return replacement; }
export function noteRender(value: number): number { counts.renders++; return value; }
export function resetCounts(): void {
  counts.renders = counts.initializers = counts.replacements = 0;
  counts.initialCalls.length = counts.replacementCalls.length = 0;
}
`;

interface Effects {
  counts: { renders: number; initializers: number; replacements: number; initialCalls: number[]; replacementCalls: number[] };
  resetCounts(): void;
}

let directory: string;
let server: ViteDevServer | undefined;
let Page: ComponentType<{ params: Record<string, string> }>;
let effects: Effects;
let root: Root | undefined;
let container: HTMLDivElement;
const globals = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
let previousActEnvironment: boolean | undefined;

beforeAll(async () => {
  const result = compile(SOURCE);
  expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  directory = fs.mkdtempSync(path.join(ROOT, '.tmp-local-state-'));
  for (const [name, content] of result.files) {
    const target = path.join(directory, 'src', 'gen', name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  fs.writeFileSync(path.join(directory, 'effects.ts'), EFFECTS);
  fs.writeFileSync(path.join(directory, 'tsconfig.json'), JSON.stringify({
    compilerOptions: {
      target: 'ES2022', lib: ['ES2022', 'DOM', 'DOM.Iterable'], module: 'ESNext',
      moduleResolution: 'bundler', jsx: 'react-jsx', strict: true, skipLibCheck: true,
      noEmit: true, allowImportingTsExtensions: true, types: ['node'],
    },
    include: ['**/*.ts', '**/*.tsx'],
  }));
  const tsc = path.join(ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'tsc.cmd' : 'tsc');
  const checked = spawnSync(tsc, ['-p', path.join(directory, 'tsconfig.json')], { encoding: 'utf8', timeout: 30_000 });
  expect(checked.status, checked.stdout + checked.stderr).toBe(0);
  server = await createServer({
    root: directory, configFile: false, logLevel: 'error',
    server: { middlewareMode: true, hmr: false, watch: null },
    appType: 'custom', resolve: { dedupe: ['react', 'react-dom'] },
  });
  Page = (await server.ssrLoadModule('/src/gen/pages/home.tsx')).PageHome as typeof Page;
  effects = await server.ssrLoadModule('/effects.ts') as Effects;
  previousActEnvironment = globals.IS_REACT_ACT_ENVIRONMENT;
  globals.IS_REACT_ACT_ENVIRONMENT = true;
}, 30_000);

beforeEach(() => {
  effects.resetCounts();
  container = document.createElement('div');
  document.body.append(container);
});

afterEach(async () => {
  if (root !== undefined) await act(async () => root!.unmount());
  root = undefined;
  container?.remove();
});

afterAll(async () => {
  globals.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
  await server?.close();
  if (directory !== undefined) fs.rmSync(directory, { recursive: true, force: true });
});

describe('function-valued local state with real React', () => {
  it('preserves an initial callback and evaluates its initializer once per render', () => {
    const markup = renderToStaticMarkup(createElement(Page, { params: {} }));
    expect(markup).toContain('>4<');
    expect(effects.counts).toEqual({ renders: 1, initializers: 1, replacements: 0, initialCalls: [3], replacementCalls: [] });
  });

  it('stores replacement callbacks as values and evaluates the assignment once under StrictMode', async () => {
    root = createRoot(container);
    await act(async () => root!.render(createElement(StrictMode, {}, createElement(Page, { params: {} }))));
    expect(container.textContent).toBe('4Replace');
    expect(effects.counts.renders).toBeGreaterThan(1);
    expect(effects.counts.initializers).toBe(effects.counts.renders);
    expect(effects.counts.initialCalls).toEqual(Array(effects.counts.renders).fill(3));
    const originalCallbackCalls = effects.counts.initialCalls.length;
    await act(async () => container.querySelector('button')!.click());
    expect(container.textContent).toBe('9Replace');
    expect(effects.counts.replacements).toBe(1);
    expect(effects.counts.initializers).toBe(effects.counts.renders);
    expect(effects.counts.initialCalls).toHaveLength(originalCallbackCalls);
    expect(effects.counts.replacementCalls.length).toBeGreaterThan(0);
    expect(effects.counts.replacementCalls.every((value) => value === 3)).toBe(true);
    await act(async () => container.querySelector('button')!.click());
    expect(effects.counts.replacements).toBe(2);
    expect(effects.counts.initializers).toBe(effects.counts.renders);
    expect(container.textContent).toBe('9Replace');
  });
});
