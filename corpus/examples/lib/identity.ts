import type { IncomingHttpHeaders } from 'node:http';

/** Integration scaffold: deny until an application's verifier is installed. */
export async function authenticate(_request: { headers: IncomingHttpHeaders; method: string; url: string; signal: AbortSignal }): Promise<{ userId: number } | undefined> {
  return undefined;
}
