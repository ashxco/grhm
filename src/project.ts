import { analyze } from './analyze.js';
import { ListNode, SExpr, isList, opName, splitList } from './ast.js';
import { check } from './checker.js';
import { compileNodes, CompileOptions, CompileResult, computeRevision } from './codegen/index.js';
import { Diagnostic, hasErrors, makeDiag } from './diagnostics.js';
import { format } from './format.js';
import { assignIds } from './ids.js';
import { MAX_PARSE_DEPTH, parse } from './parser.js';
import { MAX_EXPANDED_NODES, MAX_INCLUDE_DEPTH, MAX_PROJECT_BYTES, MAX_PROJECT_FILES } from './limits.js';

/**
 * Multi-file GRHM programs. A program has one entry file; any file can splice
 * additional files with (include "relative/path.grhm"). Included files hold
 * app-level forms (pages, components, state, ...) at their top level, or
 * (tests ...) suites. Each file keeps its own AST so formatting and patching
 * stay per-file; analysis runs over a merged view that shares node objects.
 */

export interface ProjectFile {
  /** Path relative to the project root, using forward slashes. */
  file: string;
  source: string;
  nodes: SExpr[];
}

export interface Project {
  entry: string;
  files: ProjectFile[];
  /** Parse and include-resolution diagnostics. */
  diagnostics: Diagnostic[];
  /** Merged top-level roots with includes spliced (children are shared). */
  mergedNodes: SExpr[];
  /** Resolved include target (relative file path) per include node. */
  includeTargets: Map<ListNode, string>;
}

export type ReadFile = (relPath: string) => string | undefined;

function normalize(p: string): string {
  if (p.startsWith('/') || p.includes('\\') || p.includes('\0')) throw new Error('include must be a relative project path');
  const segments: string[] = [];
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (segments.length === 0) throw new Error('include must stay inside the project root');
      segments.pop();
    }
    else segments.push(seg);
  }
  return segments.join('/');
}

function dirOf(p: string): string {
  const i = p.lastIndexOf('/');
  return i === -1 ? '' : p.slice(0, i);
}

function includePath(node: ListNode): string | undefined {
  const parts = splitList(node);
  const arg = parts.rest[0];
  return arg !== undefined && arg.kind === 'string' ? arg.value : undefined;
}

/** Load the entry file and every transitively included file. */
export function loadProject(entry: string, readFile: ReadFile): Project {
  const diagnostics: Diagnostic[] = [];
  const files: ProjectFile[] = [];
  const byPath = new Map<string, ProjectFile>();
  const includeTargets = new Map<ListNode, string>();
  const loading = new Set<string>();
  let bytes = 0;

  const loadFile = (relPath: string, from?: ListNode): ProjectFile | undefined => {
    // Order matters: files are registered before their includes are resolved,
    // so an in-progress file found here means a cycle, not a completed load.
    if (loading.has(relPath)) {
      diagnostics.push(
        makeDiag('E603', 'error', `Include cycle involving "${relPath}"`, {
          span: from?.span,
          nodeId: from?.id,
          received: relPath,
        }),
      );
      return undefined;
    }
    const existing = byPath.get(relPath);
    if (existing !== undefined) return existing;
    if (loading.size >= MAX_INCLUDE_DEPTH || files.length >= MAX_PROJECT_FILES) {
      diagnostics.push(makeDiag('E603', 'error', 'Project exceeds include depth or file budget', {
        span: from?.span, expected: `at most ${MAX_INCLUDE_DEPTH} include levels and ${MAX_PROJECT_FILES} files`, received: relPath,
      }));
      return undefined;
    }
    const source = readFile(relPath);
    if (source === undefined) {
      diagnostics.push(
        makeDiag('E603', 'error', `Included file not found: "${relPath}"`, {
          span: from?.span,
          nodeId: from?.id,
          received: relPath,
        }),
      );
      return undefined;
    }
    bytes += Buffer.byteLength(source, 'utf8');
    if (bytes > MAX_PROJECT_BYTES) {
      diagnostics.push(makeDiag('E603', 'error', 'Project exceeds source byte budget', {
        span: from?.span, received: String(bytes), expected: `at most ${MAX_PROJECT_BYTES} UTF-8 bytes`,
      }));
      return undefined;
    }
    loading.add(relPath);
    const parsed = parse(source, relPath);
    diagnostics.push(...parsed.diagnostics);
    const nodes = parsed.nodes;
    const pf: ProjectFile = { file: relPath, source, nodes };
    byPath.set(relPath, pf);
    files.push(pf);

    // Gather iteratively so list nesting does not multiply include recursion.
    const includes: ListNode[] = [];
    const pending = [...nodes].reverse();
    while (pending.length > 0) {
      const e = pending.pop()!;
      if (!isList(e)) continue;
      if (opName(e) === 'include') includes.push(e);
      else for (let i = e.items.length - 1; i >= 0; i--) pending.push(e.items[i]!);
    }
    for (const e of includes) {
      if (opName(e) === 'include') {
        const raw = includePath(e);
        if (raw === undefined) {
          diagnostics.push(makeDiag('E603', 'error', 'include requires a path string', { span: e.span }));
          continue;
        }
        let resolved: string;
        try {
          if (raw.startsWith('/')) throw new Error('include must be relative');
          resolved = normalize(dirOf(relPath) === '' ? raw : `${dirOf(relPath)}/${raw}`);
        } catch (err) {
          diagnostics.push(makeDiag('E603', 'error', String(err), { span: e.span, received: raw, expected: 'a relative path inside the project' }));
          continue;
        }
        const loaded = loadFile(resolved, e);
        if (loaded !== undefined) includeTargets.set(e, resolved);
      }
    }
    loading.delete(relPath);
    return pf;
  };

  loadFile(entry);

  // Assign IDs globally so they are unique across every file, deterministically
  // ordered by include resolution order.
  assignIds(files.flatMap((f) => f.nodes));

  const mergedNodes = files.length > 0 && !hasErrors(diagnostics) ? buildMerged(files[0]!, byPath, includeTargets, diagnostics) : [];
  return { entry, files, diagnostics, mergedNodes, includeTargets };
}

/**
 * Merged top-level roots for analysis. Include forms are replaced by the
 * included file's top-level forms; the containing list is shallow-copied
 * (same id and span) so per-file ASTs stay untouched.
 */
function buildMerged(
  entry: ProjectFile,
  byPath: Map<string, ProjectFile>,
  includeTargets: Map<ListNode, string>,
  diagnostics: Diagnostic[],
): SExpr[] {
  const merged: SExpr[] = [];
  const pending: { nodes: SExpr[]; index: number; out: SExpr[]; depth: number }[] = [{ nodes: entry.nodes, index: 0, out: merged, depth: 0 }];
  let count = 0;
  while (pending.length > 0) {
    const frame = pending[pending.length - 1]!;
    const n = frame.nodes[frame.index++];
    if (n === undefined) { pending.pop(); continue; }
    if (++count > MAX_EXPANDED_NODES || frame.depth > MAX_PARSE_DEPTH) {
      diagnostics.push(makeDiag('E603', 'error', 'Includes exceed expanded program budget', {
        span: n.span, expected: `at most ${MAX_EXPANDED_NODES} nodes and ${MAX_PARSE_DEPTH} nested lists`,
      }));
      return [];
    }
      if (isList(n) && opName(n) === 'include') {
        const target = includeTargets.get(n);
        const included = target !== undefined ? byPath.get(target) : undefined;
        if (included !== undefined) {
          pending.push({ nodes: included.nodes, index: 0, out: frame.out, depth: frame.depth });
          continue;
        }
        frame.out.push(n); // unresolved: analysis reports E603
        continue;
      }
    if (isList(n)) {
      const clone = { ...n, items: [] as SExpr[] };
      frame.out.push(clone);
      pending.push({ nodes: n.items, index: 0, out: clone.items, depth: frame.depth + 1 });
    } else {
      frame.out.push(n);
    }
  }
  return merged;
}

/**
 * Program revision across every project file, in load order. Single-file
 * projects hash exactly like `compile(source)` so revisions agree between
 * the project and single-source APIs.
 */
export function projectRevision(project: Project): string {
  if (project.files.length === 1) return computeRevision(format(project.files[0]!.nodes));
  const canonical = project.files.map((f) => `;; ${f.file}\n${format(f.nodes)}`).join('\n');
  return computeRevision(canonical);
}

/** Every diagnostic of a loaded project without generating code: parse and include errors, then analysis and checking of the merged view. */
export function diagnoseProject(project: Project): Diagnostic[] {
  const out = [...project.diagnostics];
  const app = analyze(project.mergedNodes, out);
  if (app !== undefined) check(app, out);
  return out;
}

/** Compile a loaded project (analysis over the merged view). */
export function compileProject(project: Project, options: CompileOptions = {}): CompileResult {
  const diagnostics = [...project.diagnostics];
  const revision = projectRevision(project);
  return compileNodes(project.mergedNodes, diagnostics, revision, {
    entryFile: project.entry,
    ...options,
  });
}
