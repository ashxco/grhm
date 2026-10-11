import { CODE_DOCS, hasErrors } from './diagnostics.js';
import { FixRequest, isFixLevel } from './fix.js';
import { MAX_PROTOCOL_BYTES } from './limits.js';
import { generateReference, referenceTokenEstimate } from './reference.js';
import { displayCode, explainCode, nearestCodes } from './repairs.js';
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

/** Maps do not survive JSON.stringify; source-changing results ship `newSources` as a plain object. */
export function plainSources<T extends { newSources?: Map<string, string> }>(result: T): Omit<T, 'newSources'> & { newSources: Record<string, string> | undefined } {
  const { newSources, ...rest } = result;
  return { ...rest, newSources: newSources !== undefined ? Object.fromEntries(newSources) : undefined };
}

// Optional params are absent or exactly the documented type: a value of the
// wrong type is an error envelope, never a coercion, so a malformed dry run
// cannot become a write.

function stringList(params: Record<string, unknown>, key: string): string[] | undefined {
  const value = params[key];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every((item): item is string => typeof item === 'string')) throw new Error(`"${key}" must be an array of strings`);
  return value;
}

function optionalString(params: Record<string, unknown>, key: string): string | undefined {
  const value = params[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new Error(`"${key}" must be a string`);
  return value;
}

function optionalBoolean(params: Record<string, unknown>, key: string): boolean | undefined {
  const value = params[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw new Error(`"${key}" must be a boolean`);
  return value;
}

function optionalPositiveInteger(params: Record<string, unknown>, key: string): number | undefined {
  const value = params[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) throw new Error(`"${key}" must be a positive integer`);
  return value;
}

function fixRequestFrom(params: Record<string, unknown>): FixRequest {
  const request: FixRequest = {};
  const level = params['level'];
  if (level !== undefined) {
    if (!isFixLevel(level)) throw new Error('"level" must be one of none, safe, review');
    request.level = level;
  }
  const fix = stringList(params, 'fix');
  if (fix !== undefined) request.fix = fix;
  const codes = stringList(params, 'codes');
  if (codes !== undefined) request.codes = codes;
  const revision = optionalString(params, 'revision');
  if (revision !== undefined) request.revision = revision;
  const maxPasses = optionalPositiveInteger(params, 'maxPasses');
  if (maxPasses !== undefined) request.maxPasses = maxPasses;
  const format = optionalBoolean(params, 'format');
  if (format !== undefined) request.format = format;
  return request;
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
      const write = optionalBoolean(params, 'write') ?? true;
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
      const preview = optionalBoolean(params, 'preview') ?? false;
      return plainSources(project.applyPatch(patchSource, !preview));
    }
    case 'fix': {
      const preview = optionalBoolean(params, 'preview') ?? false;
      return plainSources(project.applyFixes(fixRequestFrom(params), !preview));
    }
    case 'format': {
      const checkOnly = optionalBoolean(params, 'check') ?? false;
      return project.formatAll('preserve', checkOnly);
    }
    case 'reference': {
      const text = generateReference({ full: optionalBoolean(params, 'full') ?? false });
      return { text, tokenEstimate: referenceTokenEstimate(text) };
    }
    case 'codes': {
      if (params['code'] === undefined) return { codes: CODE_DOCS };
      const code = String(params['code']);
      const explained = explainCode(code);
      return explained !== undefined ? { ok: true, ...explained } : { ok: false, code: displayCode(code), suggestions: nearestCodes(code) };
    }
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
