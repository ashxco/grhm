import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { compile } from '../src/codegen/index.js';

const ROOT = path.join(__dirname, '..');
const SOURCE = `(app a
  (component listing (props (items list)) (each items items (txt items)))
  (component totals (props (values list)) (each sum values (txt (+ sum (sum (arr 1 2))))))
  (component passthrough (slot))
  (page "/items/{id}" detail :title id (txt "Detail"))
  (page "/" home (listing :items (arr 1 2)))
  (page "/conditional" conditional (if true (txt "yes") (txt "no")))
  (page "/visible" visible (when true (txt "visible")))
  (page "/empty" empty (each item () (txt item)))
  (page "/loop" loop (each item (arr 1 2) (txt item))))`;

let directory: string;
let compiledRuntime: string;
let compiledComponents: string;
let compiledHelpers: string;

beforeAll(() => {
  const result = compile(SOURCE);
  expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  directory = fs.mkdtempSync(path.join(ROOT, '.tmp-client-'));
  for (const [name, content] of result.files) {
    if (!name.endsWith('.ts') && !name.endsWith('.tsx')) continue;
    const target = path.join(directory, 'gen', name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  fs.writeFileSync(path.join(directory, 'tsconfig.json'), JSON.stringify({
    compilerOptions: {
      target: 'ES2022', lib: ['ES2022', 'DOM', 'DOM.Iterable'], module: 'ESNext',
      moduleResolution: 'bundler', jsx: 'react-jsx', strict: true, skipLibCheck: true,
      outDir: 'compiled', rootDir: 'gen', types: ['node'], rewriteRelativeImportExtensions: true,
    },
    include: ['gen'],
  }));
  const tsc = path.join(ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'tsc.cmd' : 'tsc');
  const run = spawnSync(tsc, ['-p', path.join(directory, 'tsconfig.json')], { encoding: 'utf8' });
  expect(run.stdout + run.stderr).toBe('');
  expect(run.status).toBe(0);
  compiledRuntime = fs.readFileSync(path.join(directory, 'compiled', 'runtime.js'), 'utf8');
  compiledComponents = fs.readFileSync(path.join(directory, 'compiled', 'components.js'), 'utf8');
  compiledHelpers = fs.readFileSync(path.join(directory, 'compiled', 'helpers.js'), 'utf8');
});

afterAll(() => {
  if (directory !== undefined) fs.rmSync(directory, { recursive: true, force: true });
});

interface ResourceState {
  data: unknown;
  loading: boolean;
  error: string | undefined;
  reload(): void;
}

interface Runtime {
  useResource(url: string, initial?: unknown, pollSeconds?: number, live?: boolean): ResourceState;
  refreshResource(url: string): void;
  resetResources(): void;
  send(method: string, url: string, body?: unknown): Promise<unknown>;
}

interface ResponseStub {
  ok: boolean;
  status?: number;
  json(): Promise<unknown>;
  text?(): Promise<string>;
}

interface ResourceOptions {
  url: string;
  initial?: unknown;
  poll?: number;
  live?: boolean;
}

interface EffectSlot {
  deps: unknown[];
  effect: () => void | (() => void);
  cleanup?: () => void;
}

const activeRuntimes: Runtime[] = [];
afterEach(() => {
  for (const runtime of activeRuntimes.splice(0)) runtime.resetResources();
  vi.clearAllTimers();
  vi.useRealTimers();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const response = (data: unknown): ResponseStub => ({ ok: true, json: async () => data });

/** Exercise emitted hooks with persistent refs and React's effect dependency rules. */
function resourceHarness() {
  vi.useFakeTimers();
  const fetch = vi.fn<(url: string, options: { signal: AbortSignal }) => Promise<ResponseStub>>(async () => response([]));
  class EventSource {
    static instances: EventSource[] = [];
    onmessage: (() => void) | null = null;
    onopen: (() => void) | null = null;
    close = vi.fn();
    constructor() { EventSource.instances.push(this); }
  }
  interface Instance {
    refs: { current: unknown }[];
    effects: EffectSlot[];
    pending: Map<number, EffectSlot>;
    refIndex: number;
    effectIndex: number;
  }
  let current!: Instance;
  const runtime = {} as Runtime;
  const script = compiledRuntime
    .replace(/^import .* from '(?:react|\.\/helpers)';$/gm, '')
    .replace(/^export \{.*\} from '\.\/helpers';$/gm, '')
    .replace(/^export /gm, '') + '\nObject.assign(exports, { useResource, refreshResource, resetResources, send });';
  runInNewContext(script, {
    exports: runtime, fetch, EventSource, AbortController, Error,
    setTimeout, clearTimeout, setInterval, clearInterval,
    Component: class {},
    useRef: (initial: unknown) => {
      const index = current.refIndex++;
      return current.refs[index] ??= { current: initial };
    },
    useEffect: (effect: EffectSlot['effect'], deps: unknown[]) => {
      const index = current.effectIndex++;
      const old = current.effects[index];
      if (old === undefined || deps.some((value, i) => !Object.is(value, old.deps[i]))) current.pending.set(index, { effect, deps });
    },
    useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot(),
  });
  activeRuntimes.push(runtime);
  const mount = (url: string, options: Omit<ResourceOptions, 'url'> = {}, deferCommit = false) => {
    const instance: Instance = { refs: [], effects: [], pending: new Map(), refIndex: 0, effectIndex: 0 };
    let props: ResourceOptions = { url, initial: [], ...options };
    const commit = (): void => {
      for (const [index] of instance.pending) instance.effects[index]?.cleanup?.();
      for (const [index, slot] of instance.pending) {
        instance.effects[index] = slot;
        slot.cleanup = slot.effect() ?? undefined;
      }
      instance.pending.clear();
    };
    const render = (next: Partial<ResourceOptions> = {}, commitEffects = true): ResourceState => {
      props = { ...props, ...next };
      current = instance;
      instance.refIndex = instance.effectIndex = 0;
      const state = runtime.useResource(props.url, props.initial, props.poll, props.live);
      if (commitEffects) commit();
      return state;
    };
    render({}, !deferCommit);
    return {
      read: render,
      update: render,
      commit,
      unmount: () => {
        for (const slot of instance.effects) slot.cleanup?.();
        instance.effects = [];
      },
      replayEffects: () => {
        // StrictMode replays effect setup/cleanup while retaining hook refs.
        for (const slot of instance.effects) slot.cleanup?.();
        for (const slot of instance.effects) slot.cleanup = slot.effect() ?? undefined;
      },
    };
  };
  return { runtime, fetch, EventSource, mount, flush: () => vi.advanceTimersByTimeAsync(0) };
}

describe('generated client regressions', () => {
  it('coalesces live events without aborting slow requests or losing their data', async () => {
    const { fetch, EventSource, mount, flush } = resourceHarness();
    const first = deferred<ResponseStub>();
    const trailing = deferred<ResponseStub>();
    fetch.mockReturnValueOnce(first.promise).mockReturnValueOnce(trailing.promise);
    const resource = mount('/api/items', { live: true });
    const signal = fetch.mock.calls[0]![1].signal;
    for (let i = 0; i < 100; i++) EventSource.instances[0]!.onmessage?.();
    expect(fetch).toHaveBeenCalledOnce();
    expect(signal.aborted).toBe(false);
    first.resolve(response(['first']));
    await flush();
    expect(resource.read().data).toEqual(['first']);
    expect(fetch).toHaveBeenCalledTimes(2);
    trailing.resolve(response(['latest']));
    await flush();
    expect(resource.read().data).toEqual(['latest']);
    expect(resource.read().loading).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('clears retained private data and aborts old requests on successful account changes', async () => {
    const { runtime, fetch, mount, flush } = resourceHarness();
    fetch.mockResolvedValueOnce(response(['Alice']));
    const alice = mount('/api/private');
    await flush();
    expect(alice.read().data).toEqual(['Alice']);
    alice.unmount();
    const pending = deferred<ResponseStub>();
    fetch.mockReturnValueOnce(pending.promise);
    const slow = mount('/api/slow');
    fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true }), text: async () => '{"ok":true}' });
    await runtime.send('post', '/api/auth/logout');
    expect(fetch.mock.calls[1]![1].signal.aborted).toBe(true);
    fetch.mockResolvedValueOnce(response(['Bob']));
    const bob = mount('/api/private');
    expect(bob.read().data).not.toEqual(['Alice']);
    await flush();
    expect(bob.read().data).toEqual(['Bob']);
    pending.resolve(response(['Old secret']));
    await flush();
    expect(slow.read().data).not.toEqual(['Old secret']);
    slow.unmount();
    bob.unmount();
  });

  it('removes cached private data when a refresh loses authorization', async () => {
    const { fetch, mount, flush } = resourceHarness();
    fetch.mockResolvedValueOnce(response(['private']));
    const resource = mount('/api/private', { poll: 1 });
    await flush();
    fetch.mockResolvedValueOnce({ ok: false, status: 401, json: async () => ({ error: 'authentication required' }) });
    await vi.advanceTimersByTimeAsync(1000);
    expect(resource.read()).toMatchObject({ data: undefined, error: 'HTTP 401', loading: false });
    resource.unmount();
  });
  it('typechecks root compositions, shadowed loop sources, slots, and title-only route parameters', () => {
    expect(compiledRuntime).toContain('useResource');
  });

  it('evaluates shadowed loop sources and keeps loop bindings distinct from runtime helpers', () => {
    const components = {} as { Listing(props: { items: number[] }): number[]; Totals(props: { values: number[] }): number[] };
    const script = compiledHelpers.replace(/^export /gm, '') + '\n' + compiledComponents
      .replace(/^import .*$/gm, '')
      .replace(/^export /gm, '') + '\nObject.assign(exports, { Listing, Totals });';
    runInNewContext(script, {
      exports: components,
      _Fragment: Symbol('Fragment'),
      // Preserve the rendered children so assertions observe output text.
      _jsx: (_tag: unknown, props: { children: unknown }) => props.children,
    });
    expect(components.Listing({ items: [1, 2] })).toEqual([1, 2]);
    expect(components.Totals({ values: [1, 2] })).toEqual([4, 5]);
  });

  it('keeps shared live subscriptions until the last consumer unmounts', async () => {
    const { fetch, EventSource, mount, flush } = resourceHarness();
    const first = mount('/api/items', { live: true });
    const second = mount('/api/items', { live: true });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(EventSource.instances).toHaveLength(1);
    const source = EventSource.instances[0]!;
    first.unmount();
    source.onmessage?.();
    await flush();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(source.close).not.toHaveBeenCalled();
    second.unmount();
    expect(source.close).toHaveBeenCalledOnce();
    source.onmessage?.();
    await flush();
    expect(fetch).toHaveBeenCalledTimes(2);
    mount('/api/items', { live: true });
    expect(EventSource.instances).toHaveLength(2);
  });

  it('revalidates live resources when the event stream reconnects', async () => {
    const { fetch, EventSource, mount, flush } = resourceHarness();
    mount('/api/items', { live: true });
    fetch.mockClear();
    EventSource.instances[0]!.onopen?.();
    await flush();
    expect(fetch).toHaveBeenCalledTimes(1);
    EventSource.instances[0]!.onopen?.();
    await flush();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('stops refetching an unmounted URL while other live URLs remain active', async () => {
    const { fetch, EventSource, mount, flush } = resourceHarness();
    const first = mount('/api/first', { live: true });
    mount('/api/second', { live: true });
    first.unmount();
    fetch.mockClear();
    EventSource.instances[0]!.onmessage?.();
    await flush();
    expect(fetch.mock.calls.map(([url]) => url)).toEqual(['/api/second']);
  });

  it('closes and clears live subscriptions when resources are reset', async () => {
    const { runtime, fetch, EventSource, mount, flush } = resourceHarness();
    const first = mount('/api/items', { live: true });
    const oldSource = EventSource.instances[0]!;
    runtime.resetResources();
    expect(oldSource.close).toHaveBeenCalledOnce();
    mount('/api/items', { live: true });
    first.unmount();
    fetch.mockClear();
    oldSource.onmessage?.();
    expect(fetch).not.toHaveBeenCalled();
    const newSource = EventSource.instances[1]!;
    newSource.onmessage?.();
    await flush();
    expect(fetch).toHaveBeenCalledOnce();
    expect(newSource.close).not.toHaveBeenCalled();
  });

  it('shares one polling schedule at the fastest active interval', async () => {
    const { fetch, mount, flush } = resourceHarness();
    const slow = mount('/api/items', { poll: 5 });
    const fast = mount('/api/items', { poll: 2 });
    mount('/api/items');
    await flush();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(fetch).toHaveBeenCalledTimes(2);
    fast.unmount();
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(4999);
    expect(fetch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetch).toHaveBeenCalledTimes(3);
    slow.update({ poll: 1 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetch).toHaveBeenCalledTimes(4);
    slow.update({ poll: 0 });
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it('does not overlap slow polling requests or restart them on interval changes', async () => {
    const { fetch, mount, flush } = resourceHarness();
    const pending = deferred<ResponseStub>();
    fetch.mockReturnValueOnce(pending.promise);
    const resource = mount('/api/items', { poll: 1 });
    const signal = fetch.mock.calls[0]![1].signal;
    await vi.advanceTimersByTimeAsync(5000);
    expect(fetch).toHaveBeenCalledTimes(1);
    resource.update({ poll: 2 });
    expect(signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(2000);
    expect(fetch).toHaveBeenCalledTimes(1);
    pending.resolve(response(['ready']));
    await flush();
    expect(resource.read().data).toEqual(['ready']);
    await vi.advanceTimersByTimeAsync(2000);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('ignores invalid polling intervals and closes live subscriptions independently of polling', async () => {
    const { fetch, EventSource, mount, flush } = resourceHarness();
    const resource = mount('/api/items', { poll: 2, live: true });
    await flush();
    resource.update({ live: false });
    expect(EventSource.instances[0]!.close).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(fetch).toHaveBeenCalledTimes(2);
    for (const poll of [undefined, 0, -1, NaN, Infinity]) {
      resource.update({ poll });
      expect(vi.getTimerCount()).toBe(0);
    }
  });

  it('moves a mounted consumer to a new URL without leaving old requests or timers active', async () => {
    const { fetch, mount, flush } = resourceHarness();
    const pending = deferred<ResponseStub>();
    fetch.mockReturnValueOnce(pending.promise);
    const resource = mount('/api/old', { poll: 1, live: true });
    const signal = fetch.mock.calls[0]![1].signal;
    fetch.mockResolvedValueOnce(response(['new']));
    resource.update({ url: '/api/new', poll: 2 });
    expect(signal.aborted).toBe(true);
    await flush();
    pending.resolve(response(['old']));
    await flush();
    expect(resource.read().data).toEqual(['new']);
    await vi.advanceTimersByTimeAsync(2000);
    expect(fetch.mock.calls.map(([url]) => url)).toEqual(['/api/old', '/api/new', '/api/new']);
  });

  it('aborts superseded fetches and ignores out-of-order bodies and rejections', async () => {
    const { runtime, fetch, mount, flush } = resourceHarness();
    const firstBody = deferred<unknown>();
    fetch.mockResolvedValueOnce({ ok: true, json: () => firstBody.promise });
    const resource = mount('/api/items');
    await flush();
    const firstSignal = fetch.mock.calls[0]![1].signal;
    const superseded = deferred<ResponseStub>();
    fetch.mockReturnValueOnce(superseded.promise);
    runtime.refreshResource('/api/items');
    expect(firstSignal.aborted).toBe(true);
    const secondSignal = fetch.mock.calls[1]![1].signal;
    fetch.mockResolvedValueOnce(response(['latest']));
    resource.read().reload();
    expect(secondSignal.aborted).toBe(true);
    await flush();
    firstBody.resolve(['stale']);
    superseded.reject(new Error('old failure'));
    await flush();
    expect(resource.read()).toMatchObject({ data: ['latest'], loading: false, error: undefined });
  });

  it('surfaces fetch errors, preserves previous data, and recovers on the next poll', async () => {
    const { fetch, mount, flush } = resourceHarness();
    fetch.mockResolvedValueOnce(response(['cached']));
    const resource = mount('/api/items', { poll: 1 });
    await flush();
    fetch.mockResolvedValueOnce({ ok: false, status: 503, json: async () => [] });
    await vi.advanceTimersByTimeAsync(1000);
    expect(resource.read()).toMatchObject({ data: ['cached'], loading: false, error: 'HTTP 503' });
    fetch.mockRejectedValueOnce(new Error('offline'));
    await vi.advanceTimersByTimeAsync(1000);
    expect(resource.read()).toMatchObject({ data: ['cached'], loading: false, error: 'offline' });
    fetch.mockResolvedValueOnce(response(['recovered']));
    await vi.advanceTimersByTimeAsync(1000);
    expect(resource.read()).toMatchObject({ data: ['recovered'], loading: false, error: undefined });
  });

  it('cancels only after the final consumer leaves and re-fetches aborted entries on remount', async () => {
    const { runtime, fetch, mount, flush } = resourceHarness();
    const pending = deferred<ResponseStub>();
    fetch.mockReturnValueOnce(pending.promise);
    const first = mount('/api/items', { poll: 1 });
    const second = mount('/api/items', { poll: 2 });
    const signal = fetch.mock.calls[0]![1].signal;
    first.unmount();
    expect(signal.aborted).toBe(false);
    second.unmount();
    expect(signal.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(10_000);
    runtime.refreshResource('/api/items');
    expect(fetch).toHaveBeenCalledTimes(1);
    fetch.mockResolvedValueOnce(response(['new']));
    const remount = mount('/api/items');
    await flush();
    pending.resolve(response(['old']));
    await flush();
    expect(remount.read()).toMatchObject({ data: ['new'], loading: false, error: undefined });
  });

  it('replays StrictMode effects without leaking polling, live subscriptions, or stale requests', async () => {
    const { fetch, EventSource, mount, flush } = resourceHarness();
    const pending = deferred<ResponseStub>();
    fetch.mockReturnValueOnce(pending.promise);
    const resource = mount('/api/items', { poll: 1, live: true });
    const original = fetch.mock.calls[0]![1].signal;
    resource.replayEffects();
    expect(original.aborted).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(EventSource.instances).toHaveLength(2);
    expect(EventSource.instances[0]!.close).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(1);
    await flush();
    pending.resolve(response(['stale']));
    await flush();
    expect(resource.read().data).toEqual([]);
    resource.unmount();
    expect(EventSource.instances[1]!.close).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('resets pending requests, polling and eviction without letting old cleanup affect remounts', async () => {
    const { runtime, fetch, mount, flush } = resourceHarness();
    const pending = deferred<ResponseStub>();
    fetch.mockReturnValueOnce(pending.promise);
    const old = mount('/api/items', { poll: 1 });
    mount('/api/unused').unmount();
    const signal = fetch.mock.calls[0]![1].signal;
    runtime.resetResources();
    expect(signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    fetch.mockResolvedValueOnce(response(['new']));
    const fresh = mount('/api/items', { poll: 2 });
    old.unmount();
    await flush();
    pending.resolve(response(['stale']));
    await flush();
    expect(fresh.read().data).toEqual(['new']);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it('refreshes a mounted consumer after reset and invalidates retained completed data without fetching', async () => {
    const { runtime, fetch, mount, flush } = resourceHarness();
    fetch.mockResolvedValueOnce(response(['before']));
    const resource = mount('/api/items');
    await flush();
    runtime.resetResources();
    fetch.mockResolvedValueOnce(response(['after']));
    resource.read();
    await flush();
    expect(resource.read().data).toEqual(['after']);
    resource.unmount();
    runtime.refreshResource('/api/items');
    expect(fetch).toHaveBeenCalledTimes(2);
    fetch.mockResolvedValueOnce(response(['fresh']));
    const remount = mount('/api/items');
    await flush();
    expect(remount.read().data).toEqual(['fresh']);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('reuses completed data for 30 seconds, then evicts it', async () => {
    const { fetch, mount, flush } = resourceHarness();
    fetch.mockResolvedValueOnce(response(['cached']));
    const first = mount('/api/items');
    await flush();
    first.unmount();
    await vi.advanceTimersByTimeAsync(29_999);
    const second = mount('/api/items');
    expect(second.read().data).toEqual(['cached']);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    second.unmount();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(vi.getTimerCount()).toBe(0);
    mount('/api/items');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('keeps at most 128 unused entries while preserving active entries', async () => {
    const { fetch, mount, flush } = resourceHarness();
    const active = mount('/api/active');
    for (let i = 0; i < 129; i++) {
      const resource = mount('/api/' + i);
      await flush();
      resource.unmount();
    }
    expect(vi.getTimerCount()).toBe(128);
    const count = fetch.mock.calls.length;
    mount('/api/128');
    expect(fetch).toHaveBeenCalledTimes(count);
    mount('/api/0');
    expect(fetch).toHaveBeenCalledTimes(count + 1);
    expect(active.read().data).toEqual([]);
  });

  it('evicts abandoned renders and reconnects a delayed commit to the current shared entry', async () => {
    const { fetch, mount, flush } = resourceHarness();
    const delayed = mount('/api/items', {}, true);
    expect(fetch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(vi.getTimerCount()).toBe(0);
    fetch.mockResolvedValueOnce(response(['shared']));
    mount('/api/items');
    await flush();
    delayed.commit();
    expect(delayed.read().data).toEqual(['shared']);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
