import { AppModel } from './analyze.js';
import { SExpr, opName, splitList } from './ast.js';
import { Binding, GenCtx, genExpr, newUses } from './codegen/expr.js';
import { camelCase } from './util.js';

/**
 * `grhm test` (PRD FR-14): lower (tests ...) suites to a Playwright spec
 * (real browser) and a Vitest spec (jsdom, no browser). Node references
 * become [data-g] locators; label strings use accessible roles/text,
 * matching what the generated app renders.
 */

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Locator for a node id (ident) or an exact accessible button label (string). */
function buttonLocator(e: SExpr): string {
  if (e.kind === 'ident') return `page.locator(${JSON.stringify(`[data-g="${e.name}"]`)})`;
  const text = e.kind === 'string' ? e.value : '';
  return `page.getByRole('button', { name: ${JSON.stringify(text)}, exact: true })`;
}

/** Input node id or placeholder string, matching the Vitest lowering. */
function inputLocator(e: SExpr): string {
  if (e.kind === 'ident') return `page.locator(${JSON.stringify(`[data-g="${e.name}"]`)})`;
  const text = e.kind === 'string' ? e.value : '';
  return `page.getByPlaceholder(${JSON.stringify(text)}, { exact: true })`;
}

/**
 * (expect-eq a b) expressions are pure by construction (checker enforces
 * literals + stdlib + fns only), so they lower to plain TypeScript evaluated
 * in the test process, with user fns imported from the generated lib.
 */
function pureExprGen(app: AppModel): { gen: (e: SExpr) => string; importLines: () => string } {
  const uses = newUses();
  const bindings = new Map<string, Binding>();
  for (const name of app.functions.keys()) {
    bindings.set(name, { kind: 'fn', js: camelCase(name) });
  }
  for (const name of app.enums.keys()) {
    bindings.set(name, { kind: 'enum', js: '' });
  }
  const ctx: GenCtx = { bindings, classFor: new Map(), uses, sameFileComponents: new Set(), defaultLocale: app.defaultLocale };
  return {
    gen: (e: SExpr) => genExpr(e, ctx),
    importLines: () => {
      const lines: string[] = [];
      if (uses.libFns.size > 0) {
        const names = [...uses.libFns].map((n) => camelCase(n)).sort();
        lines.push(`import { ${names.join(', ')} } from '../lib';`);
      }
      if (uses.helpers.size > 0) {
        lines.push(`import { ${[...uses.helpers].sort().join(', ')} } from '../helpers';`);
      }
      if (uses.i18n) lines.push(`import { tMsg } from '../i18n';`);
      return lines.length > 0 ? lines.join('\n') + '\n' : '';
    },
  };
}

export function genPlaywrightSpec(app: AppModel): string | undefined {
  if (app.tests.length === 0) return undefined;
  const hasServer = app.tables.size > 0 || app.apis.length > 0 || app.uploads !== undefined;
  const pure = pureExprGen(app);
  const body: string[] = [];
  for (const t of app.tests) {
    body.push(`test(${JSON.stringify(t.name)}, async ({ page }) => {`);
    for (const step of t.steps) {
      const op = opName(step);
      const args = splitList(step).rest;
      const a0 = args[0];
      const a1 = args[1];
      switch (op) {
        case 'visit':
          if (a0?.kind === 'string') body.push(`  await page.goto(${JSON.stringify(a0.value)});`);
          break;
        case 'click':
          if (a0 !== undefined && (a0.kind === 'ident' || a0.kind === 'string')) {
            body.push(`  await ${buttonLocator(a0)}.click();`);
          }
          break;
        case 'fill':
          if (a0 !== undefined && (a0.kind === 'ident' || a0.kind === 'string') && a1?.kind === 'string') {
            body.push(`  await ${inputLocator(a0)}.fill(${JSON.stringify(a1.value)});`);
          }
          break;
        case 'press':
          if (a0?.kind === 'string') body.push(`  await page.keyboard.press(${JSON.stringify(a0.value)});`);
          break;
        case 'expect-text':
          if (a0?.kind === 'string') {
            body.push(`  await expect(page.getByText(${JSON.stringify(a0.value)}).first()).toBeVisible();`);
          }
          break;
        case 'expect-gone':
          if (a0?.kind === 'string') {
            body.push(`  await expect(page.getByText(${JSON.stringify(a0.value)})).toHaveCount(0);`);
          }
          break;
        case 'expect-node':
          if (a0 !== undefined && (a0.kind === 'ident' || a0.kind === 'string')) {
            body.push(`  await expect(${buttonLocator(a0)}.first()).toBeVisible();`);
          }
          break;
        case 'expect-count':
          if (a0 !== undefined && (a0.kind === 'ident' || a0.kind === 'string') && a1?.kind === 'number') {
            body.push(`  await expect(${buttonLocator(a0)}).toHaveCount(${a1.value});`);
          }
          break;
        case 'expect-value':
          if (a0 !== undefined && (a0.kind === 'ident' || a0.kind === 'string') && a1?.kind === 'string') {
            body.push(`  await expect(${inputLocator(a0)}).toHaveValue(${JSON.stringify(a1.value)});`);
          }
          break;
        case 'expect-url':
          if (a0?.kind === 'string') {
            body.push(`  await expect(page).toHaveURL(new RegExp(${JSON.stringify(escapeRegex(a0.value) + '$')}));`);
          }
          break;
        case 'expect-eq':
          if (a0 !== undefined && a1 !== undefined) {
            body.push(`  expect(${pure.gen(a0)}).toEqual(${pure.gen(a1)});`);
          }
          break;
        case 'screenshot':
          if (a0?.kind === 'string') {
            body.push(`  await expect(page).toHaveScreenshot(${JSON.stringify(a0.value + '.png')}, { fullPage: true });`);
          }
          break;
        default:
          body.push(`  // unknown step: ${op ?? '?'}`);
      }
    }
    body.push('});');
    body.push('');
  }
  const lines: string[] = [
    '/* Generated by grhm test. Do not edit by hand. */',
    "import { test, expect } from '@playwright/test';",
    hasServer
      ? `const GRHM_API_PORT = process.env.GRHM_API_PORT ?? '34787';
test.beforeEach(async ({ request }) => {
  const response = await request.post('http://127.0.0.1:' + GRHM_API_PORT + '/__grhm/reset', {
    headers: { 'x-grhm': '1' },
  });
  expect(response.ok()).toBe(true);
});`
      : '',
    pure.importLines(),
    ...body,
  ];
  return lines.join('\n');
}

/** Minimal Playwright config that serves the app with Vite during tests. */
/**
 * Playwright config; when the app declares (db ...)/(api ...), the generated
 * API server is started (in-memory SQLite for hermetic runs) alongside Vite,
 * whose dev proxy forwards /api to it.
 */
export function playwrightConfig(hasServer: boolean, outDir = 'src/gen'): string {
  const generatedDir = outDir.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '') || '.';
  if (!/^[A-Za-z0-9._/-]+$/.test(generatedDir) || generatedDir.startsWith('/') || generatedDir.split('/').includes('..')) {
    throw new Error('outDir must be a safe relative project path');
  }
  const serverPath = generatedDir === '.' ? 'server.ts' : `${generatedDir}/server.ts`;
  const testDir = generatedDir === '.' ? 'tests' : `${generatedDir}/tests`;
  const nodeCommand = JSON.stringify(`node ${JSON.stringify(serverPath)}`);
  const stripCommand = JSON.stringify(`node --experimental-strip-types ${JSON.stringify(serverPath)}`);
  const viteServer = hasServer
    ? `{
      command: 'npx vite --port 5173 --strictPort',
      port: 5173,
      reuseExistingServer: true,
      env: { ...process.env, GRHM_API_PORT: API_PORT },
    }`
    : `{
      command: 'npx vite --port 5173 --strictPort',
      port: 5173,
      reuseExistingServer: true,
    }`;
  const apiServer = `{
      command: (process.features as { typescript?: unknown }).typescript
        ? ${nodeCommand}
        : ${stripCommand},
      port: Number(API_PORT),
      reuseExistingServer: false,
      env: { ...process.env, GRHM_DB: ':memory:', GRHM_TEST_HOOKS: '1', PORT: API_PORT },
    }`;
  const preamble = hasServer
    ? `
// The generated API server runs on an uncommon port during tests so a stray
// process on the default port cannot be mistaken for it. Override with
// GRHM_API_PORT if this port is taken on your machine.
const API_PORT = process.env.GRHM_API_PORT ?? '34787';
`
    : '';
  const webServer = hasServer ? `[\n    ${apiServer},\n    ${viteServer},\n  ]` : `[\n    ${viteServer},\n  ]`;
  return `/* Generated by grhm test. */
import { defineConfig } from '@playwright/test';
${preamble}
export default defineConfig({
  testDir: ${JSON.stringify(testDir)},
  testMatch: '**/*.spec.ts',
  use: { baseURL: 'http://localhost:5173' },
  webServer: ${webServer},
});
`;
}

export const PLAYWRIGHT_CONFIG = playwrightConfig(false);

/**
 * Vitest (jsdom) lowering of the same suites: renders the real <App/> with
 * no browser or dev server. fetch is stubbed to serve resource URLs from
 * public/, mirroring what Vite does in dev.
 */
export function genVitestSpec(app: AppModel, outDir = 'src/gen'): string | undefined {
  if (app.tests.length === 0) return undefined;
  const hasServer = app.tables.size > 0 || app.apis.length > 0 || app.uploads !== undefined;
  const pure = pureExprGen(app);
  const body: string[] = [];
  for (const t of app.tests) {
    body.push(`test(${JSON.stringify(t.name)}, async () => {`);
    for (const step of t.steps) {
      const op = opName(step);
      const args = splitList(step).rest;
      const a0 = args[0];
      const a1 = args[1];
      switch (op) {
        case 'visit':
          if (a0?.kind === 'string') body.push(`  await visit(${JSON.stringify(a0.value)});`);
          break;
        case 'click':
          if (a0?.kind === 'ident') body.push(`  await click(node(${JSON.stringify(a0.name)}));`);
          else if (a0?.kind === 'string') body.push(`  await click(button(${JSON.stringify(a0.value)}));`);
          break;
        case 'fill':
          if (a1?.kind === 'string') {
            if (a0?.kind === 'ident') body.push(`  await fill(node(${JSON.stringify(a0.name)}), ${JSON.stringify(a1.value)});`);
            else if (a0?.kind === 'string') body.push(`  await fill(inputByPlaceholder(${JSON.stringify(a0.value)}), ${JSON.stringify(a1.value)});`);
          }
          break;
        case 'press':
          if (a0?.kind === 'string') body.push(`  await press(${JSON.stringify(a0.value)});`);
          break;
        case 'expect-text':
          if (a0?.kind === 'string') body.push(`  expect(document.body.textContent ?? '').toContain(${JSON.stringify(a0.value)});`);
          break;
        case 'expect-gone':
          if (a0?.kind === 'string') body.push(`  expect(document.body.textContent ?? '').not.toContain(${JSON.stringify(a0.value)});`);
          break;
        case 'expect-node':
          if (a0?.kind === 'ident') body.push(`  expect(document.querySelector(${JSON.stringify(`[data-g="${a0.name}"]`)})).not.toBeNull();`);
          else if (a0?.kind === 'string') body.push(`  expect(button(${JSON.stringify(a0.value)})).toBeTruthy();`);
          break;
        case 'expect-count':
          if (a1?.kind === 'number') {
            if (a0?.kind === 'ident') {
              body.push(`  expect(document.querySelectorAll(${JSON.stringify(`[data-g="${a0.name}"]`)})).toHaveLength(${a1.value});`);
            } else if (a0?.kind === 'string') {
              body.push(`  expect(buttons(${JSON.stringify(a0.value)})).toHaveLength(${a1.value});`);
            }
          }
          break;
        case 'expect-value':
          if (a0?.kind === 'ident' && a1?.kind === 'string') {
            body.push(`  expect((node(${JSON.stringify(a0.name)}) as HTMLInputElement).value).toBe(${JSON.stringify(a1.value)});`);
          } else if (a0?.kind === 'string' && a1?.kind === 'string') {
            body.push(`  expect((inputByPlaceholder(${JSON.stringify(a0.value)}) as HTMLInputElement).value).toBe(${JSON.stringify(a1.value)});`);
          }
          break;
        case 'expect-url':
          if (a0?.kind === 'string') {
            body.push(`  expect(window.location.pathname).toMatch(new RegExp(${JSON.stringify(escapeRegex(a0.value) + '$')}));`);
          }
          break;
        case 'expect-eq':
          if (a0 !== undefined && a1 !== undefined) {
            body.push(`  expect(${pure.gen(a0)}).toEqual(${pure.gen(a1)});`);
          }
          break;
        case 'screenshot':
          // Visual regression runs in the browser suite only (Playwright).
          break;
        default:
          body.push(`  // unknown step: ${op ?? '?'}`);
      }
    }
    body.push('});');
    body.push('');
  }
  return [unitPrelude(hasServer, outDir), pure.importLines(), ...body].join('\n');
}

function unitPrelude(hasServer: boolean, outDir: string): string {
  const serverBoot = hasServer
    ? `
// The app declares (db ...)/(api ...): run the real generated server as a
// subprocess on an ephemeral port (in-memory SQLite) and forward /api to it.
import { spawn, type ChildProcess } from 'node:child_process';
import { afterAll } from 'vitest';
import { resetResources } from '../runtime';

let apiServer: ChildProcess;
const apiPort: number = await new Promise((resolve, reject) => {
  const features = process.features as { typescript?: unknown };
  const args = features.typescript !== undefined && features.typescript !== false ? [] : ['--experimental-strip-types'];
  apiServer = spawn(process.execPath, [...args, path.resolve(process.cwd(), ${JSON.stringify(outDir)}, 'server.ts')], {
    cwd: process.cwd(),
    env: { ...process.env, GRHM_DB: ':memory:', GRHM_TEST_HOOKS: '1', PORT: '0' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  let buffer = '';
  apiServer.stdout?.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
    const match = buffer.match(/"port":(\\d+)/);
    if (match !== null) resolve(Number(match[1]));
  });
  apiServer.on('error', reject);
  setTimeout(() => reject(new Error('generated API server did not start')), 15_000);
});
afterAll(() => {
  apiServer.kill();
});
`
    : '';
  const apiBranch = hasServer
    ? `
    if (url.startsWith('/api')) {
      return realFetch('http://127.0.0.1:' + apiPort + url, init);
    }`
    : '';
  return `// @vitest-environment jsdom
/* Generated by grhm test. Do not edit by hand. */
import fs from 'node:fs';
import path from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { App } from '../App';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
${serverBoot}
// Serve absolute resource URLs from public/, the way the Vite dev server does.
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  if (url.startsWith('/')) {${apiBranch}
    const file = path.join(process.cwd(), 'public', url);
    if (fs.existsSync(file)) {
      return new Response(fs.readFileSync(file, 'utf8'), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response('not found', { status: 404 });
  }
  return realFetch(input, init);
}) as typeof fetch;

let container: HTMLDivElement;
let root: Root;

async function settle(): Promise<void> {
  // Several short real-time turns: actions may involve real HTTP roundtrips
  // to the generated API server subprocess, not just microtasks.
  for (let i = 0; i < 8; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5));
    });
  }
}

async function visit(route: string): Promise<void> {
  await act(async () => {
    window.history.pushState(null, '', route);
    window.dispatchEvent(new PopStateEvent('popstate'));
  });
  await settle();
}

function node(id: string): Element {
  const el = [...document.querySelectorAll('[data-g]')].find((candidate) => candidate.getAttribute('data-g') === id);
  if (el === undefined) throw new Error('node not rendered: ' + id);
  return el;
}

function buttons(label: string): Element[] {
  return [...document.querySelectorAll('button')].filter((b) => (b.textContent ?? '').trim() === label);
}

function button(label: string): Element {
  const el = buttons(label)[0];
  if (el === undefined) throw new Error('no button labeled "' + label + '"');
  return el;
}

function inputByPlaceholder(placeholder: string): Element {
  const el = [...document.querySelectorAll('input')].find((candidate) => candidate.getAttribute('placeholder') === placeholder);
  if (el === undefined) throw new Error('no input with placeholder "' + placeholder + '"');
  return el;
}

async function click(el: Element): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
  await settle();
}

async function press(key: string): Promise<void> {
  const target = document.activeElement ?? document.body;
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
    target.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true, cancelable: true }));
  });
  await settle();
}

async function fill(el: Element, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
  await act(async () => {
    setter?.set?.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

beforeEach(async () => {
${hasServer ? "  const reset = await realFetch('http://127.0.0.1:' + apiPort + '/__grhm/reset', { method: 'POST', headers: { 'x-grhm': '1' } });\n  if (!reset.ok) throw new Error('generated API reset failed: ' + reset.status);\n  resetResources();\n" : ''}  window.history.replaceState(null, '', '/');
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(<App />);
  });
  await settle();
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
});
`;
}
