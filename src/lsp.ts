import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { analyze, AppModel } from './analyze.js';
import { ListNode, SExpr, Span, isList, opName, walkLists } from './ast.js';
import { Diagnostic, preferredFix } from './diagnostics.js';
import { format } from './format.js';
import { MAX_PROTOCOL_BYTES } from './limits.js';
import { parse } from './parser.js';
import { SymbolInfo, findReferences, resolveSymbolAt, validNewName } from './references.js';
import { EXPR_OPS, allOpNames, allowedProps, lookupOp } from './schema.js';
import { GrhmProject } from './sdk.js';
import { VERSION } from './version.js';

/**
 * Language Server Protocol server (PRD FR-13), hand-rolled over stdio with
 * Content-Length framing. Capabilities: diagnostics (full sync), hover,
 * completion, go-to-definition, references, rename, and document formatting.
 */

interface Position {
  line: number;
  character: number;
}

interface LspRange {
  start: Position;
  end: Position;
}

function positionAt(source: string, offset: number): Position {
  let line = 0;
  let lineStart = 0;
  for (let i = 0; i < offset && i < source.length; i += 1) {
    if (source[i] === '\n') {
      line += 1;
      lineStart = i + 1;
    }
  }
  return { line, character: offset - lineStart };
}

function offsetAt(source: string, pos: Position): number {
  let line = 0;
  let offset = 0;
  while (line < pos.line && offset < source.length) {
    if (source[offset] === '\n') line += 1;
    offset += 1;
  }
  return Math.min(offset + pos.character, source.length);
}

function rangeOf(source: string, span: Span): LspRange {
  return { start: positionAt(source, span.start), end: positionAt(source, span.end) };
}

/** Whether a code action kind passes the client's `context.only` filter (kinds are dot-separated hierarchies). */
function kindRequested(kind: string, only: string[] | undefined): boolean {
  return only === undefined || only.some((wanted) => wanted === '' || kind === wanted || kind.startsWith(wanted + '.'));
}

function toLspDiagnostic(d: Diagnostic, source: string): Record<string, unknown> {
  const span = d.span ?? { start: 0, end: 0, line: 1, col: 1 };
  return {
    range: rangeOf(source, span),
    severity: d.severity === 'error' ? 1 : d.severity === 'warning' ? 2 : 3,
    code: d.code,
    source: 'grhm',
    message: d.message,
  };
}

/** Innermost list containing the offset, plus the atom directly at it. */
function nodeAt(roots: SExpr[], offset: number): { list?: ListNode; atom?: SExpr } {
  let list: ListNode | undefined;
  let atom: SExpr | undefined;
  const visit = (e: SExpr): void => {
    if (e.span.start > offset || e.span.end < offset) return;
    if (isList(e)) {
      list = e;
      for (const item of e.items) visit(item);
    } else {
      atom = e;
    }
  };
  for (const root of roots) visit(root);
  return { list, atom };
}

function hoverText(roots: SExpr[], app: AppModel | undefined, offset: number): string | undefined {
  const { list, atom } = nodeAt(roots, offset);
  if (atom !== undefined && atom.kind === 'ident') {
    const schema = lookupOp(atom.name);
    if (schema !== undefined && list !== undefined && list.items[0] === atom) {
      const props = Object.keys(schema.props).map((p) => ':' + p);
      const styled = schema.styled ? ' (+style props)' : '';
      return `**${schema.name}** — ${schema.doc}${props.length > 0 ? `\n\nProps: ${props.join(' ')}` : ''}${styled}`;
    }
    const exprOp = EXPR_OPS[atom.name];
    if (exprOp !== undefined && list !== undefined && list.items[0] === atom) {
      const arity = exprOp.maxArity === undefined ? `${exprOp.minArity}+ args` : exprOp.minArity === exprOp.maxArity ? `${exprOp.minArity} args` : `${exprOp.minArity}-${exprOp.maxArity} args`;
      return `**${atom.name}** — ${exprOp.doc ?? 'expression operator'} (${arity})`;
    }
    if (app !== undefined) {
      const head = atom.name.split('.')[0] ?? atom.name;
      if (app.states.has(head)) return `**${head}** — app state`;
      if (app.resources.has(head)) return `**${head}** — resource (${app.resources.get(head)?.url ?? ''})`;
      if (app.components.has(head)) return `**${head}** — component`;
      if (app.imports.has(head)) return `**${head}** — import from "${app.imports.get(head)?.module ?? ''}"`;
      const fn = app.functions.get(head);
      if (fn !== undefined) return `**${head}** — fn (${fn.params.join(' ')})`;
      const en = app.enums.get(head);
      if (en !== undefined) return `**${head}** — enum (${en.values.join(' | ')})`;
    }
  }
  if (atom !== undefined && atom.kind === 'keyword' && list !== undefined) {
    const op = opName(list);
    const schema = op !== undefined ? lookupOp(op) : undefined;
    if (schema !== undefined) return `**:${atom.name}** — property of ${schema.name}`;
  }
  return undefined;
}

function completions(source: string, roots: SExpr[], offset: number): { label: string; kind: number; detail?: string }[] {
  const before = source.slice(0, offset);
  const lastMeaning = before.replace(/[a-z0-9-]+$/i, '').trimEnd();
  if (lastMeaning.endsWith('(')) {
    const ops = allOpNames().map((name) => ({ label: name, kind: 3, detail: lookupOp(name)?.doc }));
    const exprOps = Object.entries(EXPR_OPS).map(([name, spec]) => ({ label: name, kind: 3, detail: spec.doc }));
    const seen = new Set(ops.map((o) => o.label));
    return [...ops, ...exprOps.filter((o) => !seen.has(o.label))];
  }
  const inKeyword = /:[a-z0-9-]*$/i.test(before);
  if (inKeyword) {
    const { list } = nodeAt(roots, Math.max(0, offset - 1));
    const op = list !== undefined ? opName(list) : undefined;
    const schema = op !== undefined ? lookupOp(op) : undefined;
    if (schema !== undefined) {
      return [...allowedProps(schema)].sort().map((name) => ({ label: ':' + name, kind: 10 }));
    }
  }
  return [];
}

// Framing ---------------------------------------------------------------------

type Handler = (params: Record<string, unknown>) => unknown;

export function runLsp(cwd: string): void {
  const project = GrhmProject.fromCwd(cwd);
  /** Open document contents by URI. */
  const docs = new Map<string, string>();
  /** Last published diagnostics per URI, kept for code actions. */
  const lastDiags = new Map<string, Diagnostic[]>();

  const write = (message: Record<string, unknown>): void => {
    const body = JSON.stringify({ jsonrpc: '2.0', ...message });
    process.stdout.write(`Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`);
  };

  // Resolve symlinks (e.g. /var vs /private/var on macOS) so URI-derived
  // paths and the project root agree.
  const realRoot = fs.existsSync(project.config.root) ? fs.realpathSync(project.config.root) : project.config.root;

  const uriToRel = (uri: string): string => {
    const filePath = fileURLToPath(uri);
    const real = fs.existsSync(filePath) ? fs.realpathSync(filePath) : filePath;
    return path.relative(realRoot, real).split(path.sep).join('/');
  };

  // A file the client has open keeps the URI it was opened under (which may
  // spell a symlinked path differently from the project root), so edits and
  // locations land in that buffer; any other file is addressed from the root.
  const relToUri = (rel: string): string => {
    for (const uri of docs.keys()) if (uriToRel(uri) === rel) return uri;
    return pathToFileURL(path.join(project.config.root, rel)).href;
  };

  const publishDiagnostics = (): void => {
    for (const [uri, source] of docs) project.overlay.set(uriToRel(uri), source);
    const summary = project.check();
    // A change in one included module can create or clear diagnostics in any
    // other open module. Republish every open document from the same project
    // snapshot so editors never retain stale cross-file errors.
    for (const [uri, source] of docs) {
      const rel = uriToRel(uri);
      const mine = summary.diagnostics.filter((d) => (d.span?.file ?? project.config.entry) === rel);
      lastDiags.set(uri, mine);
      write({ method: 'textDocument/publishDiagnostics', params: { uri, diagnostics: mine.map((d) => toLspDiagnostic(d, source)) } });
    }
  };

  const docContext = (uri: string): { source: string; roots: SExpr[]; app: AppModel | undefined } => {
    const source = docs.get(uri) ?? '';
    const parsed = parse(source, uriToRel(uri));
    const scratch: Diagnostic[] = [];
    const app = analyze(parsed.nodes, scratch);
    return { source, roots: parsed.nodes, app };
  };

  /** Resolve the symbol at a position project-wide: occurrences + file sources. */
  const symbolOccurrences = (
    uri: string,
    pos: Position,
  ): { info: SymbolInfo; spans: Span[]; sources: Map<string, string> } | undefined => {
    const source = docs.get(uri) ?? '';
    const rel = uriToRel(uri);
    const loaded = project.load();
    const allRoots = loaded.files.flatMap((f) => f.nodes);
    const info = resolveSymbolAt(allRoots, offsetAt(source, pos), rel);
    if (info === undefined) return undefined;
    const sources = new Map(loaded.files.map((f) => [f.file, f.source]));
    return { info, spans: findReferences(allRoots, info), sources };
  };

  const spanLocation = (span: Span, sources: Map<string, string>): { uri: string; range: LspRange } => {
    const rel = span.file ?? project.config.entry;
    return { uri: relToUri(rel), range: rangeOf(sources.get(rel) ?? '', span) };
  };

  const handlers: Record<string, Handler> = {
    initialize: () => ({
      capabilities: {
        textDocumentSync: 1,
        hoverProvider: true,
        completionProvider: { triggerCharacters: ['(', ':'] },
        definitionProvider: true,
        referencesProvider: true,
        renameProvider: true,
        documentFormattingProvider: true,
        codeActionProvider: { codeActionKinds: ['quickfix'] },
      },
      serverInfo: { name: 'grhm-lsp', version: VERSION },
    }),
    shutdown: () => null,
    'textDocument/hover': (params) => {
      const doc = params['textDocument'] as { uri: string };
      const pos = params['position'] as Position;
      const { source, roots, app } = docContext(doc.uri);
      const text = hoverText(roots, app, offsetAt(source, pos));
      return text !== undefined ? { contents: { kind: 'markdown', value: text } } : null;
    },
    'textDocument/completion': (params) => {
      const doc = params['textDocument'] as { uri: string };
      const pos = params['position'] as Position;
      const { source, roots } = docContext(doc.uri);
      return completions(source, roots, offsetAt(source, pos));
    },
    'textDocument/definition': (params) => {
      const doc = params['textDocument'] as { uri: string };
      const pos = params['position'] as Position;
      const found = symbolOccurrences(doc.uri, pos);
      if (found === undefined) return null;
      return spanLocation(found.info.declSpan, found.sources);
    },
    'textDocument/references': (params) => {
      const doc = params['textDocument'] as { uri: string };
      const pos = params['position'] as Position;
      const found = symbolOccurrences(doc.uri, pos);
      if (found === undefined) return null;
      const context = params['context'] as { includeDeclaration?: boolean } | undefined;
      const spans = context?.includeDeclaration === false
        ? found.spans.filter((span) => !(
            span.start === found.info.declSpan.start &&
            span.end === found.info.declSpan.end &&
            span.file === found.info.declSpan.file
          ))
        : found.spans;
      return spans.map((span) => spanLocation(span, found.sources));
    },
    'textDocument/rename': (params) => {
      const doc = params['textDocument'] as { uri: string };
      const pos = params['position'] as Position;
      const newName = params['newName'] as string;
      if (!validNewName(newName)) {
        throw new Error(`"${newName}" is not a valid GRHM name (lowercase, digits, hyphens)`);
      }
      const found = symbolOccurrences(doc.uri, pos);
      if (found === undefined) return null;
      if (!found.info.renameable) {
        throw new Error(`${found.info.kind} "${found.info.name}" cannot be renamed automatically`);
      }
      const changes: Record<string, { range: LspRange; newText: string }[]> = {};
      for (const span of found.spans) {
        const loc = spanLocation(span, found.sources);
        (changes[loc.uri] ??= []).push({ range: loc.range, newText: newName });
      }
      return { changes };
    },
    'textDocument/codeAction': (params) => {
      const doc = params['textDocument'] as { uri: string };
      const range = params['range'] as LspRange;
      const context = params['context'] as { only?: string[] } | undefined;
      if (!kindRequested('quickfix', context?.only)) return [];
      const source = docs.get(doc.uri) ?? '';
      const rel = uriToRel(doc.uri);
      const start = offsetAt(source, range.start);
      const end = offsetAt(source, range.end);
      const actions: Record<string, unknown>[] = [];
      for (const d of lastDiags.get(doc.uri) ?? []) {
        if (d.span === undefined || d.fixes === undefined) continue;
        if (d.span.end < start || d.span.start > end) continue;
        // `fixes` arrive most confident first, so the preferred (unique safe) one leads.
        const preferred = preferredFix(d);
        for (const fix of d.fixes) {
          // Edit offsets index the text the diagnostics were computed from:
          // this document's buffer, or another project file's overlay/disk text.
          const changes: Record<string, { range: LspRange; newText: string }[]> = {};
          let complete = true;
          for (const edit of fix.edits) {
            const editRel = edit.file ?? project.config.entry;
            const text = editRel === rel ? source : project.readFile(editRel);
            if (text === undefined) {
              complete = false;
              break;
            }
            const uri = editRel === rel ? doc.uri : relToUri(editRel);
            (changes[uri] ??= []).push({ range: { start: positionAt(text, edit.start), end: positionAt(text, edit.end) }, newText: edit.text });
          }
          if (!complete) continue;
          actions.push({
            title: fix.title,
            kind: 'quickfix',
            diagnostics: [toLspDiagnostic(d, source)],
            isPreferred: fix === preferred,
            edit: { changes },
          });
        }
      }
      return actions;
    },
    'textDocument/formatting': (params) => {
      const doc = params['textDocument'] as { uri: string };
      const source = docs.get(doc.uri) ?? '';
      const parsed = parse(source);
      if (parsed.diagnostics.some((d) => d.severity === 'error')) return [];
      const formatted = format(parsed.nodes);
      if (formatted === source) return [];
      return [{ range: { start: { line: 0, character: 0 }, end: positionAt(source, source.length) }, newText: formatted }];
    },
  };

  const notifications: Record<string, (params: Record<string, unknown>) => void> = {
    initialized: () => undefined,
    exit: () => process.exit(0),
    'textDocument/didOpen': (params) => {
      const doc = params['textDocument'] as { uri: string; text: string };
      docs.set(doc.uri, doc.text);
      publishDiagnostics();
    },
    'textDocument/didChange': (params) => {
      const doc = params['textDocument'] as { uri: string };
      const changes = params['contentChanges'] as { text: string }[];
      const last = changes[changes.length - 1];
      if (last !== undefined) {
        docs.set(doc.uri, last.text);
        publishDiagnostics();
      }
    },
    'textDocument/didClose': (params) => {
      const doc = params['textDocument'] as { uri: string };
      docs.delete(doc.uri);
      lastDiags.delete(doc.uri);
      project.overlay.delete(uriToRel(doc.uri));
      write({ method: 'textDocument/publishDiagnostics', params: { uri: doc.uri, diagnostics: [] } });
      publishDiagnostics();
    },
    'textDocument/didSave': () => undefined,
  };

  let buffer = Buffer.alloc(0);
  const rejectOversize = (): void => {
    process.stderr.write('LSP message exceeds protocol byte budget\n');
    buffer = Buffer.alloc(0);
    process.exitCode = 1;
    process.stdin.destroy();
  };
  process.stdin.on('data', (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      const headerEnd = buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) {
        if (buffer.length > 8192) rejectOversize();
        return;
      }
      if (headerEnd > 8192) { rejectOversize(); return; }
      const header = buffer.slice(0, headerEnd).toString('utf8');
      const match = /Content-Length: (\d+)/i.exec(header);
      if (match === null) {
        buffer = buffer.slice(headerEnd + 4);
        continue;
      }
      const length = Number(match[1]);
      if (!Number.isSafeInteger(length) || length > MAX_PROTOCOL_BYTES) { rejectOversize(); return; }
      const bodyStart = headerEnd + 4;
      if (buffer.length < bodyStart + length) return;
      const body = buffer.slice(bodyStart, bodyStart + length).toString('utf8');
      buffer = buffer.slice(bodyStart + length);

      let parsed: unknown;
      try {
        parsed = JSON.parse(body) as unknown;
      } catch {
        continue;
      }
      if (
        typeof parsed !== 'object' ||
        parsed === null ||
        Array.isArray(parsed) ||
        typeof (parsed as { method?: unknown }).method !== 'string' ||
        ((parsed as { id?: unknown }).id !== undefined && !['string', 'number'].includes(typeof (parsed as { id?: unknown }).id)) ||
        ((parsed as { params?: unknown }).params !== undefined &&
          (typeof (parsed as { params?: unknown }).params !== 'object' || (parsed as { params?: unknown }).params === null || Array.isArray((parsed as { params?: unknown }).params)))
      ) {
        continue;
      }
      const message = parsed as { id?: number | string; method: string; params?: Record<string, unknown> };
      const method = message.method ?? '';
      if (message.id !== undefined) {
        const handler = handlers[method];
        if (handler !== undefined) {
          try {
            write({ id: message.id, result: handler(message.params ?? {}) });
          } catch (err) {
            write({ id: message.id, error: { code: -32603, message: err instanceof Error ? err.message : String(err) } });
          }
        } else {
          write({ id: message.id, error: { code: -32601, message: `method not found: ${method}` } });
        }
      } else {
        try {
          notifications[method]?.(message.params ?? {});
        } catch {
          // Malformed notifications have no response channel; ignore them
          // without taking down the long-lived language server.
        }
      }
    }
  });
}
