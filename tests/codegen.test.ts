import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { compile } from '../src/codegen/index.js';

const FIXTURE = fs.readFileSync(path.join(__dirname, 'fixtures', 'store.grhm'), 'utf8');
const ROOT = path.join(__dirname, '..');

/** Concatenation of all generated page modules, for content assertions. */
function allPages(files: Map<string, string>): string {
  return [...files]
    .filter(([name]) => name.startsWith('pages/'))
    .map(([, content]) => content)
    .join('\n');
}

describe('compiler', () => {
  const result = compile(FIXTURE);

  it('compiles the store fixture without errors', () => {
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(result.files.size).toBeGreaterThan(0);
  });

  it('emits one module per page plus shared files', () => {
    const names = [...result.files.keys()].sort();
    expect(names).toContain('App.tsx');
    expect(names).toContain('components.tsx');
    expect(names).toContain('runtime.ts');
    expect(names).toContain('state.ts');
    expect(names).toContain('styles.css');
    expect(names).toContain('sourcemap.json');
    expect(names.filter((n) => n.startsWith('pages/'))).toHaveLength(4);
  });

  it('generates page components and a router', () => {
    const pages = allPages(result.files);
    expect(pages).toContain('export function PageHome');
    expect(pages).toContain('export function PageCatalog');
    expect(pages).toContain('export function PageDetail');
    const app = result.files.get('App.tsx') ?? '';
    expect(app).toContain('"/products/{id}"');
    expect(app).toContain('<PageDetail params={params} />');
    expect(app).toContain("lazy(() => import('./pages/detail')");
  });

  it('generates shared state via stores', () => {
    const state = result.files.get('state.ts') ?? '';
    expect(state).toContain('export const cartCountStore = createStore<number>(0)');
    const pages = allPages(result.files);
    expect(pages).toContain('useStore(cartCountStore)');
    expect(pages).toContain('setCartCount((cartCount + 1))');
  });

  it('generates resources with defaults', () => {
    const pages = allPages(result.files);
    expect(pages).toContain('useResource<any>("/api/products.json", [])');
  });

  it('emits a source correlation map covering generated lines', () => {
    const raw = result.files.get('sourcemap.json') ?? '{}';
    const map = JSON.parse(raw) as { schema: number; nodes: Record<string, { source: { line: number }; generated: { file: string; line: number }[] }> };
    expect(map.schema).toBe(1);
    const withGenerated = Object.values(map.nodes).filter((n) => n.generated.length > 0);
    expect(withGenerated.length).toBeGreaterThan(5);
    const first = withGenerated[0]!;
    expect(first.source.line).toBeGreaterThan(0);
  });

  it('generates typed component props including actions', () => {
    const components = result.files.get('components.tsx') ?? '';
    expect(components).toContain('export interface ProductCardProps');
    expect(components).toContain('onView: () => void;');
    expect(components).toContain('price: number;');
    expect(components).toContain('{fmtMoney(__grhmProps.price, "USD")}');
  });

  it('lowers navigation to route templates', () => {
    const pages = allPages(result.files);
    expect(pages).toContain('navigate(("/products/" + encodeURIComponent(String(p.id)) + ""))');
  });

  it('serializes path-template text and URL-encodes dynamic segments', () => {
    const route = '/x/' + String.fromCharCode(92, 96) + '); globalThis.PWN = 1; ///{id}';
    const source = `(app a
      (state slug "a/b?c#d")
      (page ${JSON.stringify(route)} detail (txt "detail"))
      (page "/" home (link "go" :to (path ${JSON.stringify(route)} :id slug))))`;
    const generated = compile(source);
    expect(generated.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);

    const page = generated.files.get('pages/home.tsx') ?? '';
    const prefix = route.slice(0, route.indexOf('{id}'));
    expect(page).toContain(`navigate((${JSON.stringify(prefix)} + encodeURIComponent(String(slug)) + ""))`);
    expect(page).not.toContain('navigate(`');
  });

  it('emits deterministic css with tokens and responsive rules', () => {
    const css = result.files.get('styles.css') ?? '';
    expect(css).toContain('--primary: #4f46e5;');
    expect(css).toContain('grid-template-columns: repeat(4, minmax(0, 1fr))');
    expect(css).toContain('@media (max-width: 640px)');
  });

  it('tags DOM nodes with stable IDs for runtime correlation', () => {
    const pages = allPages(result.files);
    expect(pages).toContain('data-g={');
  });

  it('serializes explicit IDs without allowing JSX or CSS injection', () => {
    const injected = `x" ref={() => { fetch('/pwn') }} data-x="y`;
    const source = `(app a (page "/" home (txt "safe" :id ${JSON.stringify(injected)} :color "#fff")))`;
    const generated = compile(source);
    expect(generated.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);

    const page = generated.files.get('pages/home.tsx') ?? '';
    expect(page).toContain(`data-g={${JSON.stringify(injected)}}`);
    expect(page).not.toContain('data-g="x" ref=');
    expect(page).toMatch(/className="g-i-[a-f0-9-]+"/);

    const css = generated.files.get('styles.css') ?? '';
    expect(css).not.toContain("fetch('/pwn')");
    const sourceMap = JSON.parse(generated.files.get('sourcemap.json') ?? '{}') as {
      nodes: Record<string, { generated: unknown[] }>;
    };
    expect(sourceMap.nodes[injected]?.generated.length).toBeGreaterThan(0);
  });

  it('is deterministic', () => {
    const again = compile(FIXTURE);
    for (const [name, content] of result.files) {
      expect(again.files.get(name)).toBe(content);
    }
    expect(again.revision).toBe(result.revision);
  });

  it('produces no output for invalid programs', () => {
    const bad = compile('(app a (page "/" home (txt unknown-ref)))');
    expect(bad.files.size).toBe(0);
    expect(bad.diagnostics.some((d) => d.code === 'E201')).toBe(true);
  });

  it('generated TypeScript passes tsc under strict mode', () => {
    const outDir = path.join(ROOT, '.tmp-test', 'gen');
    fs.rmSync(path.join(ROOT, '.tmp-test'), { recursive: true, force: true });
    fs.mkdirSync(outDir, { recursive: true });
    for (const [name, content] of result.files) {
      if (name.endsWith('.css') || name.endsWith('.json')) continue;
      const target = path.join(outDir, name);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content);
    }
    fs.writeFileSync(
      path.join(ROOT, '.tmp-test', 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          target: 'ES2022',
          lib: ['ES2022', 'DOM', 'DOM.Iterable'],
          module: 'ESNext',
          moduleResolution: 'bundler',
          jsx: 'react-jsx',
          strict: true,
          skipLibCheck: true,
          noEmit: true,
          allowImportingTsExtensions: true,
          types: ['node'],
        },
        include: ['gen'],
      }),
    );
    const tsc = path.join(ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'tsc.cmd' : 'tsc');
    const run = spawnSync(tsc, ['-p', path.join(ROOT, '.tmp-test', 'tsconfig.json')], { encoding: 'utf8' });
    expect(run.stdout + run.stderr, run.stdout + run.stderr).not.toContain('error TS');
    expect(run.status).toBe(0);
  });
});
