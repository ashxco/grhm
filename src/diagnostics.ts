import { Span } from './ast.js';

export type Severity = 'error' | 'warning' | 'info';

/**
 * How much trust a machine-applicable fix deserves.
 * - safe: the unique mechanical correction — a unique nearest spelling within
 *   edit distance 2 from a closed candidate set that leaves most of the name
 *   intact (`isSafeSpelling`: never for one- or two-character names, one edit
 *   for three-character ones), re-spelled in the token's own syntax (a keyword
 *   keeps its `:`, a token its `$`, a string its quotes, a dotted identifier
 *   its other segments), or a declaration the program provably needs with no
 *   free choice such as `(uploads)`. Applying it cannot change code that was
 *   already correct.
 * - review: well-formed and clears the diagnostic, but encodes a choice (a
 *   fallback value, a tied spelling candidate, deleting a dangling keyword).
 * - placeholder: inserts a syntactically valid stand-in the author must
 *   replace (`""`, `0`, `false`, `null`, `(arr)`, `(E.m null)`); titles end
 *   with "(fill in)". Never applied by confidence level, only by explicit id.
 */
export type FixConfidence = 'safe' | 'review' | 'placeholder';

/** Confidence tiers ranked most trusted first; consumers sort and gate by this rank. */
export const CONFIDENCE_RANK: Record<FixConfidence, number> = { safe: 0, review: 1, placeholder: 2 };

/**
 * One text replacement. `start`/`end` follow Span exactly: UTF-16 code-unit
 * offsets into the file's current text (the raw file or an LSP overlay, never
 * canonical text), `end` exclusive. `start === end` inserts; `text === ''`
 * deletes.
 */
export interface TextEdit {
  /** As Span.file; absent in single-source compiles, where consumers substitute the project entry. */
  file?: string;
  start: number;
  end: number;
  text: string;
}

/** A machine-applicable repair for one diagnostic; its edits apply together or not at all. */
export interface Fix {
  /** `'f' + fnv1a` of title, confidence, and sorted edits (offsets and text, not the file): identical fixes from two diagnostics collapse into one. */
  id: string;
  /** Imperative, quoting the exact before/after text where there is one: `Replace ":colr" with ":color"`. */
  title: string;
  confidence: FixConfidence;
  /** Sorted by (file, start); pairwise non-conflicting (see editsConflict). */
  edits: TextEdit[];
}

/**
 * Structured diagnostic (PRD FR-8). Machine-readable first; the human
 * rendering is a projection of this schema.
 */
export interface Diagnostic {
  schema: 1;
  code: string;
  severity: Severity;
  message: string;
  span?: Span;
  nodeId?: string;
  op?: string;
  field?: string;
  received?: string;
  expected?: string;
  /** Display-only hints (candidate spellings, prose); never spliced into source. */
  suggestions?: string[];
  /** Machine-applicable repairs, most confident first, at most one `safe`; absent when none is known. */
  fixes?: Fix[];
}

export interface DiagOptions {
  span?: Span;
  nodeId?: string;
  op?: string;
  field?: string;
  received?: string;
  expected?: string;
  suggestions?: string[];
  fixes?: Fix[];
}

export function makeDiag(code: string, severity: Severity, message: string, opts: DiagOptions = {}): Diagnostic {
  const { fixes, ...rest } = opts;
  return { schema: 1, code, severity, message, ...rest, ...(fixes !== undefined && fixes.length > 0 ? { fixes } : {}) };
}

/**
 * Two edits conflict when they touch the same file (a missing file means the
 * project entry) and share a start offset or properly intersect, which also
 * covers an insertion strictly inside the other edit. Adjacent ranges and an
 * insertion at the other edit's end do not conflict.
 */
export function editsConflict(a: TextEdit, b: TextEdit, entry: string): boolean {
  if ((a.file ?? entry) !== (b.file ?? entry)) return false;
  return a.start === b.start || (a.start < b.end && b.start < a.end);
}

/** The one fix a consumer may apply without asking: the unique `safe` entry. */
export function preferredFix(d: Diagnostic): Fix | undefined {
  const safe = (d.fixes ?? []).filter((f) => f.confidence === 'safe');
  return safe.length === 1 ? safe[0] : undefined;
}

export function hasErrors(diagnostics: Diagnostic[]): boolean {
  return diagnostics.some((d) => d.severity === 'error');
}

/** Stable documentation for every diagnostic code. */
export const CODE_DOCS: Record<string, string> = {
  E001: 'Lexical error (bad character, escape, or unterminated string)',
  E002: 'Unexpected closing parenthesis',
  E003: 'Unclosed parenthesis',
  E004: 'Compiler source, token, or nesting budget exceeded; split or simplify the source',
  E101: 'Unknown operation',
  E102: 'Unknown property for this operation',
  E103: 'Invalid property value',
  E104: 'Invalid positional arguments (wrong count or type)',
  E105: 'Keyword property is missing a value',
  E106: 'Missing required property',
  E107: 'Duplicate declaration name',
  E108: 'Duplicate route',
  E109: 'Invalid expression',
  E110: 'Form is not allowed in this position',
  E111: 'Type mismatch in expression',
  E112: 'Wrong number of arguments',
  E201: 'Unknown reference',
  E202: 'Target of set is not writable state',
  E203: 'Navigation target does not match any route',
  E204: 'Invalid resource field (allowed: data, loading, error)',
  E205: 'Unknown design token',
  E206: 'Route parameter missing or unknown',
  W301: 'Resource data read without acknowledging loading/error states',
  W401: 'Image is missing alt text',
  W402: 'Button has no accessible label',
  E501: 'Patch target or property not found',
  E502: 'Invalid patch move',
  E503: 'Patch or fix would produce an invalid program',
  E504: 'Patch or fix revision conflict',
  W501: 'Patch has no revision precondition',
  E601: 'Invalid interop declaration or call',
  W601: 'Unchecked interop call (validated only by TypeScript at build time)',
  E602: 'Interop module not found',
  W602: 'Interop package not installed in node_modules',
  E603: 'Include could not be resolved (missing file, cycle, unsafe path, or project budget)',
  E701: 'Invalid test step',
  E801: 'Malformed db/table/column/seed declaration',
  E802: 'Unknown table',
  E803: 'Unknown column or row field',
  E804: 'Malformed or duplicate api route',
  E805: 'Invalid handler expression',
  E806: 'send targets no declared api route',
  E807: 'refresh targets an unknown resource',
  E808: 'Unknown or invalid request body field',
  E809: 'send body does not match the route input contract',
  E810: 'insert is missing a required column',
  E811: 'Invalid select query (:where/:order must use table columns)',
  E812: 'Unknown enum member',
  E813: 'Invalid auth declaration or :auth without (auth ...)',
  E814: 'Unknown i18n message key',
  W701: 'Message key missing from a non-default locale',
  E815: 'Invalid or non-exhaustive match expression',
  E816: ':live requires the generated API server (a db or api declaration)',
  E817: 'Invalid job declaration',
  E818: 'Invalid uploads declaration or file-input without (uploads ...)',
  E819: ':references targets an unknown table',
  W801: 'Operation may throw at runtime; wrap in (attempt expr fallback)',
  E900: 'Internal compiler error',
};

function lineOf(source: string, span: Span): string {
  const lines = source.split('\n');
  return lines[span.line - 1] ?? '';
}

/** Human projection of a diagnostic, with a small code frame when source is available. */
export function formatHuman(d: Diagnostic, source?: string, file?: string): string {
  const loc = d.span !== undefined ? `${file ?? 'input'}:${d.span.line}:${d.span.col}` : (file ?? 'input');
  const head = `${d.severity} ${d.code} at ${loc}: ${d.message}`;
  const parts: string[] = [head];
  if (d.nodeId !== undefined) parts.push(`  node: ${d.nodeId}`);
  if (d.expected !== undefined) parts.push(`  expected: ${d.expected}`);
  if (d.received !== undefined) parts.push(`  received: ${d.received}`);
  if (d.suggestions !== undefined && d.suggestions.length > 0) parts.push(`  suggestion: ${d.suggestions.join(' | ')}`);
  for (const fix of d.fixes ?? []) parts.push(`  fix [${fix.confidence}] ${fix.id}: ${fix.title}`);
  if (source !== undefined && d.span !== undefined) {
    const text = lineOf(source, d.span);
    parts.push(`  | ${text}`);
    parts.push(`  | ${' '.repeat(Math.max(0, d.span.col - 1))}^`);
  }
  return parts.join('\n');
}
