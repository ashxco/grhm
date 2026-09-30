import { CODE_DOCS, hasErrors } from './diagnostics.js';
import { MAX_PROTOCOL_BYTES } from './limits.js';
import { generateReference, referenceTokenEstimate } from './reference.js';
import { GrhmProject } from './sdk.js';
import { VERSION } from './version.js';

/**
 * Compiler server (PRD FR-10): a long-lived process that answers
 * newline-delimited JSON requests on stdin with JSON responses on stdout,
 * avoiding process startup on every agent interaction.
 *
 * Request:  {"id": 1, "method": "check", "params": {...}}
 * Response: {"id": 1, "result": {...}} or {"id": 1, "error": {"message": ...}}
 */

interface Request {
  id: number | string;
  method: string;
  params?: Record<string, unknown>;
}

export function handleRequest(project: GrhmProject, method: string, params: Record<string, unknown>): unknown {
  switch (method) {
    case 'version':
      return { name: 'grhm', version: VERSION, schema: 1 };
    case 'check':
      return project.check();
    case 'revision':
      return { revision: project.revision() };
    case 'compile': {
      const result = project.compile();
      const ok = !hasErrors(result.diagnostics);
      const write = params['write'] !== false;
      const artifacts = ok && write ? project.writeArtifacts(result.files) : [];
      return {
        ok,
        revision: result.revision,
        diagnostics: result.diagnostics,
        artifacts,
        files: write ? undefined : Object.fromEntries(result.files),
      };
    }
    case 'inspect': {
      const nodeId = String(params['node'] ?? '');
      const found = project.inspect(nodeId);
      if (found === undefined) return { ok: false, error: `no node with ID "${nodeId}"` };
      return { ok: true, ...found };
    }
    case 'patch': {
      const patchSource = String(params['patch'] ?? '');
      const preview = params['preview'] === true;
      const result = project.applyPatch(patchSource, !preview);
      const { newSources, ...rest } = result;
      return { ...rest, newSources: newSources !== undefined ? Object.fromEntries(newSources) : undefined };
    }
    case 'format': {
      const checkOnly = params['check'] === true;
      return project.formatAll('preserve', checkOnly);
    }
    case 'reference': {
      const text = generateReference({ full: params['full'] === true });
      return { text, tokenEstimate: referenceTokenEstimate(text) };
    }
    case 'codes':
      return { codes: CODE_DOCS };
    default:
      throw new Error(`unknown method "${method}"`);
  }
}

export function runServer(cwd: string): void {
  const project = GrhmProject.fromCwd(cwd);
  process.stdout.write(JSON.stringify({ schema: 1, ready: true, root: project.config.root }) + '\n');
  const handleLine = (line: string): void => {
    const trimmed = line.trim();
    if (trimmed === '') return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed) as unknown;
    } catch {
      process.stdout.write(JSON.stringify({ id: null, error: { message: 'invalid JSON' } }) + '\n');
      return;
    }
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      Array.isArray(parsed) ||
      typeof (parsed as { method?: unknown }).method !== 'string' ||
      !(['string', 'number'].includes(typeof (parsed as { id?: unknown }).id)) ||
      ((parsed as { params?: unknown }).params !== undefined &&
        (typeof (parsed as { params?: unknown }).params !== 'object' || (parsed as { params?: unknown }).params === null || Array.isArray((parsed as { params?: unknown }).params)))
    ) {
      process.stdout.write(JSON.stringify({ id: null, error: { message: 'invalid request envelope' } }) + '\n');
      return;
    }
    const request = parsed as Request;
    try {
      const result = handleRequest(project, request.method, request.params ?? {});
      process.stdout.write(JSON.stringify({ id: request.id, result }) + '\n');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stdout.write(JSON.stringify({ id: request.id, error: { message } }) + '\n');
    }
  };
  let pending = Buffer.alloc(0);
  let discarding = false;
  process.stdin.on('data', (chunk: Buffer) => {
    pending = Buffer.concat([pending, chunk]);
    for (;;) {
      const end = pending.indexOf(10);
      const length = end < 0 ? pending.length : end;
      if (length > MAX_PROTOCOL_BYTES && !discarding) {
        discarding = true;
        process.stdout.write(JSON.stringify({ id: null, error: { message: 'request exceeds protocol byte budget' } }) + '\n');
      }
      if (end < 0) {
        if (discarding) pending = Buffer.alloc(0);
        return;
      }
      if (!discarding) handleLine(pending.subarray(0, end).toString('utf8'));
      pending = pending.subarray(end + 1);
      discarding = false;
    }
  });
  process.stdin.on('end', () => { if (!discarding && pending.length > 0) handleLine(pending.toString('utf8')); });
}
