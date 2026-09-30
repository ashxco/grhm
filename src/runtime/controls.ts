import { monitorEventLoopDelay } from 'node:perf_hooks';
import net from 'node:net';
import type http from 'node:http';

/** A bounded fixed-window limiter, including fail-closed behavior at capacity. */
export class Limiter {
  private readonly windows = new Map<string, { count: number; until: number }>();
  private readonly maximum: number;
  private readonly milliseconds: number;
  private readonly capacity: number;
  constructor(maximum: number, milliseconds: number, capacity = 10_000) {
    this.maximum = maximum; this.milliseconds = milliseconds; this.capacity = capacity;
  }
  allow(key: string, now = Date.now()): boolean {
    const previous = this.windows.get(key);
    if (previous !== undefined && previous.until > now) { previous.count++; return previous.count <= this.maximum; }
    if (this.windows.size >= this.capacity) {
      for (const [name, value] of this.windows) if (value.until <= now) this.windows.delete(name);
      if (this.windows.size >= this.capacity) return false;
    }
    this.windows.set(key, { count: 1, until: now + this.milliseconds });
    return true;
  }
}

/** Forwarded addresses are accepted only from explicitly listed proxy peers. */
export function clientAddress(req: http.IncomingMessage): string {
  const remote = req.socket.remoteAddress ?? '';
  const trusted = (process.env.GRHM_TRUSTED_PROXIES ?? '').split(',').map((value) => value.trim()).filter(Boolean);
  if (!trusted.includes(remote)) return remote;
  const header = req.headers['x-forwarded-for'];
  if (typeof header !== 'string') return remote;
  const chain = header.split(',').map((part) => part.trim());
  if (chain.length > 16 || chain.some((ip) => !net.isIP(ip))) return remote;
  for (let i = chain.length - 1; i >= 0; i--) if (!trusted.includes(chain[i]!)) return chain[i]!;
  return remote;
}

export function createMetrics() {
  const lag = monitorEventLoopDelay({ resolution: 20 });
  lag.enable();
  const buckets = [1, 5, 10, 25, 50, 100, 250, 500, 1000, 5000, Infinity];
  const requests = new Map<string, { count: number; errors: number; milliseconds: number; histogram: number[] }>();
  const started = Date.now();
  return {
    record(route: string, status: number, milliseconds: number): void {
      const key = requests.has(route) || requests.size < 512 ? route : 'other';
      let item = requests.get(key);
      if (item === undefined) { item = { count: 0, errors: 0, milliseconds: 0, histogram: buckets.map(() => 0) }; requests.set(key, item); }
      item.count++; if (status >= 500) item.errors++; item.milliseconds += milliseconds;
      const index = buckets.findIndex((limit) => milliseconds <= limit);
      item.histogram[index] = (item.histogram[index] ?? 0) + 1;
    },
    snapshot() {
      return { schema: 1, uptimeSeconds: (Date.now() - started) / 1000, memory: process.memoryUsage(),
        eventLoopMilliseconds: { p95: lag.percentile(95) / 1e6, p99: lag.percentile(99) / 1e6, max: lag.max / 1e6 },
        latencyBucketUpperMs: buckets.map((n) => Number.isFinite(n) ? n : null), requests: Object.fromEntries(requests) };
    },
    close(): void { lag.disable(); },
  };
}
