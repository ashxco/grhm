import { CONFIDENCE_RANK, Diagnostic, Fix, FixConfidence, TextEdit, editsConflict, hasErrors, makeDiag, preferredFix } from './diagnostics.js';
import { format } from './format.js';
import { parse } from './parser.js';
import { Project, ReadFile, diagnoseProject, loadProject, projectRevision } from './project.js';
import { fnv1aHex } from './util.js';

/**
 * Applies the machine-applicable `fixes` that diagnostics carry (PRD FR-8).
 *
 * The applier is pure and in-memory, mirroring patch.ts: load, diagnose, pick
 * one fix per diagnostic, apply the non-conflicting batch as text edits,
 * reload, and keep the result only if it still parses and every applied fix
 * removed the diagnostic it claimed from its (moved) site. Passes repeat until
 * nothing more applies, because fixing one diagnostic routinely reveals the
 * next (an unknown op masks its subtree). Nothing touches disk; the SDK
 * commits `newSources`.
 */

export type FixLevel = 'none' | 'safe' | 'review';
/** Nothing left to apply; the pass budget ran out with eligible fixes left; or every remaining fix undid an earlier one. */
export type FixStopReason = 'fixed-point' | 'max-passes' | 'cycle';
export type FixSkipReason = 'ambiguous' | 'invalid-edit' | 'ineffective' | 'broke-parse' | 'deferred';

export interface FixRequest {
  /** Highest confidence tier applied in bulk (default `safe`); placeholders never qualify. */
  level?: FixLevel;
  /** Fix ids to apply regardless of confidence, as reported against the current revision; each applies once. */
  fix?: string[];
  /** Only diagnostics with these codes are fixed in bulk; explicit ids are exempt. */
  codes?: string[];
  /** Optimistic-concurrency precondition, as the patch protocol's `:revision`. */
  revision?: string;
  /** Upper bound on diagnose-and-apply passes (default 8, clamped to 1..32). */
  maxPasses?: number;
  /** Re-canonicalize changed files that were canonical before (default true). */
  format?: boolean;
}

export interface AppliedFix {
  id: string;
  code: string;
  title: string;
  confidence: FixConfidence;
  /** Where the fixed diagnostic was reported, in the text before the pass. */
  file: string;
  line: number;
  col: number;
  nodeId?: string;
  /** 1-based index among the passes `FixResult.passes` counts: the batch this fix landed in. */
  pass: number;
}

export interface SkippedFix {
  /** The id at the pass that skipped the fix; `diagnostics` carries the ids valid for the next request. */
  id: string;
  code: string;
  title: string;
  confidence: FixConfidence;
  reason: FixSkipReason;
}

export interface FixResult {
  ok: boolean;
  /** No errors remain in the resulting program. */
  clean: boolean;
  conflict: boolean;
  /** Revision after the fixes (present when ok). */
  revision?: string;
  /** Current revision (present on conflict). */
  currentRevision?: string;
  /** Passes that applied at least one fix. */
  passes: number;
  /** Why the pass loop ended (present when ok). */
  stopped?: FixStopReason;
  applied: AppliedFix[];
  skipped: SkippedFix[];
  /** Errors in the result whose code, file, and message were absent before fixing. */
  uncovered: Diagnostic[];
  /** Diagnostics of the resulting program (when ok), so remaining fix ids are valid for the next request. */
  diagnostics: Diagnostic[];
  /** New source of the entry file (present when something changed). */
  newSource?: string;
  /** New source per changed file (present when something changed). */
  newSources?: Map<string, string>;
  /** Files whose content changed, in load order (present when something changed). */
  changedFiles?: string[];
}

export const FIX_LEVELS: readonly FixLevel[] = ['none', 'safe', 'review'];

export function isFixLevel(value: unknown): value is FixLevel {
  return typeof value === 'string' && (FIX_LEVELS as readonly string[]).includes(value);
}

/** Highest confidence rank a level applies in bulk; `placeholder` outranks every level. */
const LEVEL_RANK: Record<FixLevel, number> = { none: -1, safe: CONFIDENCE_RANK.safe, review: CONFIDENCE_RANK.review };
const DEFAULT_PASSES = 8;
const MAX_PASSES = 32;

/** The failure shape shared with the SDK's commit path. */
export function fixFailure(diagnostics: Diagnostic[], conflict = false, currentRevision?: string): FixResult {
  return { ok: false, clean: false, conflict, currentRevision, passes: 0, applied: [], skipped: [], uncovered: [], diagnostics };
}

/** Apply pairwise non-conflicting edits to one file's text; descending order keeps every offset valid. */
export function applyTextEdits(text: string, edits: readonly TextEdit[]): string {
  let out = text;
  for (const edit of [...edits].sort((a, b) => b.start - a.start || b.end - a.end)) {
    out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
  }
  return out;
}

/** Identity of a diagnostic across text changes: offsets move, the message does not. */
function fingerprint(d: Diagnostic, entry: string): string {
  return `${d.code}|${d.span?.file ?? entry}|${d.message}`;
}

/**
 * Where an offset lands once `edits` (pairwise non-conflicting, so order-free)
 * have rewritten its text: an offset past an edit shifts by the edit's length
 * change, one inside a replaced range collapses to that range's start.
 */
export function mapOffset(offset: number, edits: readonly TextEdit[]): number {
  let mapped = offset;
  for (const edit of edits) {
    if (offset >= edit.end) mapped += edit.text.length - (edit.end - edit.start);
    else if (offset > edit.start) mapped -= offset - edit.start;
  }
  return mapped;
}

type EditsByFile = Map<string, readonly TextEdit[]>;

/**
 * A diagnostic's identity at its site: the fingerprint plus its start offset,
 * moved through `edits` when given so a pre-edit site can be looked up in the
 * post-edit text. A span-less diagnostic is its fingerprint alone.
 */
function siteKey(d: Diagnostic, entry: string, edits?: EditsByFile): string {
  const key = fingerprint(d, entry);
  if (d.span === undefined) return key;
  const start = edits === undefined ? d.span.start : mapOffset(d.span.start, edits.get(d.span.file ?? entry) ?? []);
  return `${start}\u001f${key}`;
}

function countSites(diags: Diagnostic[], entry: string, edits?: EditsByFile): Map<string, number> {
  const counts = new Map<string, number>();
  for (const d of diags) {
    const key = siteKey(d, entry, edits);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

/** A fix together with the files it edits: identical edits in two files share an id but are two fixes, and the plan keeps them apart by this. */
export function candidateKey(fix: Fix, entry: string): string {
  return [fix.id, ...[...new Set(fix.edits.map((e) => e.file ?? entry))].sort()].join('\u001e');
}

/** Offset-free identity of a fix, so a rejected fix stays rejected after the text around it moves. */
function shapeOf(code: string, fix: Fix): string {
  return [code, fix.title, ...fix.edits.map((e) => e.text)].join('\u001f');
}

function stateHash(project: Project): string {
  return fnv1aHex(project.files.map((f) => `${f.file}\u0000${f.source}`).join('\u0001'));
}

function clampPasses(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested)) return DEFAULT_PASSES;
  return Math.min(MAX_PASSES, Math.max(1, Math.floor(requested)));
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function positionAt(text: string, offset: number): { line: number; col: number } {
  const before = text.slice(0, offset);
  const lastBreak = before.lastIndexOf('\n');
  return { line: before.split('\n').length, col: offset - lastBreak };
}

interface Candidate {
  fix: Fix;
  code: string;
  /** Every diagnostic offering this fix; each must be gone from its site for the fix to count. */
  diagnostics: [Diagnostic, ...Diagnostic[]];
  /** Position in the request's `fix` list, or Infinity when selected by level. */
  requestIndex: number;
  hasError: boolean;
  /** File of the first edit, its load order, and the extent of all edits. */
  file: string;
  fileIndex: number;
  start: number;
  end: number;
}

interface Plan {
  candidates: Candidate[];
  /** Eligible fixes of a lower confidence tier than this pass applies; they are re-planned next pass. */
  heldBack: number;
  /** Requested ids that no diagnostic offers. */
  missing: string[];
}

interface Trial {
  sources: Map<string, string>;
  project: Project;
  diags: Diagnostic[];
  /** Diagnostics per site (see `siteKey`). */
  counts: Map<string, number>;
  /** The edits that produced this text from the pass's starting text, per file. */
  edits: EditsByFile;
  hash: string;
}

type Verdict = 'accepted' | 'broke-parse' | 'ineffective' | 'cycle';

/** A rejected fix is reported as what failed; a cycle means its edit undid an earlier one. */
function skipReasonOf(verdict: Exclude<Verdict, 'accepted'>): FixSkipReason {
  switch (verdict) {
    case 'broke-parse':
      return 'broke-parse';
    case 'ineffective':
    case 'cycle':
      return 'ineffective';
    default: {
      const exhaustive: never = verdict;
      throw new Error(`unhandled verdict: ${String(exhaustive)}`);
    }
  }
}

class FixRun {
  private readonly level: FixLevel;
  private readonly maxPasses: number;
  private readonly requestedIds: string[];
  /** The candidate key that took each requested id, so the id never applies at a second site (see `requestedFix`). */
  private readonly claimedIds = new Map<string, string>();
  /** Request index of each requested fix the previous pass deferred, by offset-free shape (see `requestedFix`). */
  private readonly deferredRequests = new Map<string, number>();
  private readonly codes: Set<string> | undefined;
  private readonly revision: string | undefined;
  private readonly reformat: boolean;
  private readonly blocked = new Set<string>();
  private readonly skipped = new Map<string, SkippedFix>();
  private readonly seen = new Set<string>();
  private readonly applied: AppliedFix[] = [];
  private passes = 0;

  constructor(private readonly entry: string, private readonly readFile: ReadFile, request: FixRequest) {
    this.level = request.level ?? 'safe';
    this.maxPasses = clampPasses(request.maxPasses);
    this.requestedIds = request.fix ?? [];
    this.codes = request.codes !== undefined ? new Set(request.codes) : undefined;
    this.revision = request.revision;
    this.reformat = request.format !== false;
  }

  run(): FixResult {
    const project = loadProject(this.entry, this.readFile);
    if (hasErrors(project.diagnostics)) {
      return fixFailure([makeDiag('E503', 'error', 'Cannot fix: current source does not parse'), ...project.diagnostics]);
    }
    const currentRevision = projectRevision(project);
    if (this.revision !== undefined && this.revision !== currentRevision) {
      return fixFailure(
        [
          makeDiag('E504', 'error', `Revision conflict: fix expects "${this.revision}" but program is at "${currentRevision}"`, {
            received: this.revision,
            expected: currentRevision,
          }),
        ],
        true,
        currentRevision,
      );
    }
    const original = new Map(project.files.map((f) => [f.file, f.source]));
    const wasCanonical = new Set(project.files.filter((f) => format(f.nodes) === f.source).map((f) => f.file));
    const initialDiags = diagnoseProject(project);
    const initialErrors = new Set(initialDiags.filter((d) => d.severity === 'error').map((d) => fingerprint(d, this.entry)));

    let state: Trial = { sources: original, project, diags: initialDiags, counts: countSites(initialDiags, this.entry), edits: new Map(), hash: stateHash(project) };
    this.seen.add(state.hash);
    let stopped: FixStopReason = 'fixed-point';
    let pendingDeferred: Candidate[] = [];
    for (let pass = 1; ; pass += 1) {
      const plan = this.plan(state);
      if (pass === 1 && plan.missing.length > 0) {
        return fixFailure(
          plan.missing.map((id) =>
            makeDiag('E504', 'error', `Fix "${id}" is not available at revision "${currentRevision}"; re-run check`, { received: id, expected: currentRevision }),
          ),
          true,
          currentRevision,
        );
      }
      const batch: Candidate[] = [];
      pendingDeferred = [];
      for (const candidate of plan.candidates) {
        const claimed = batch.some((b) => b.fix.edits.some((taken) => candidate.fix.edits.some((edit) => editsConflict(taken, edit, this.entry))));
        (claimed ? pendingDeferred : batch).push(candidate);
      }
      // A requested fix displaced by a conflicting edit keeps its request for the next pass, when its id will have moved.
      this.deferredRequests.clear();
      for (const candidate of pendingDeferred) {
        if (Number.isFinite(candidate.requestIndex)) this.deferredRequests.set(shapeOf(candidate.code, candidate.fix), candidate.requestIndex);
      }
      if (batch.length === 0) break;
      if (pass > this.maxPasses) {
        stopped = 'max-passes';
        break;
      }
      const outcome = this.applyBatch(state, batch);
      if (outcome.accepted.length > 0) {
        this.passes += 1;
        for (const candidate of outcome.accepted) this.applied.push(this.siteOf(candidate, state, this.passes));
        state = outcome.state;
        this.seen.add(state.hash);
      } else if (pendingDeferred.length === 0 && plan.heldBack === 0) {
        stopped = outcome.cycled ? 'cycle' : 'fixed-point';
        break;
      }
    }
    for (const candidate of pendingDeferred) this.skip(candidate, 'deferred');

    const final = new Map(state.sources);
    let reformatted = false;
    for (const [file, text] of state.sources) {
      if (text === original.get(file) || !this.reformat || !wasCanonical.has(file)) continue;
      final.set(file, format(parse(text, file).nodes));
      reformatted = true;
    }
    const finalProject = reformatted ? loadProject(this.entry, (p) => final.get(p) ?? this.readFile(p)) : state.project;
    const finalDiags = reformatted ? diagnoseProject(finalProject) : state.diags;
    const newSources = new Map([...final].filter(([file, text]) => text !== original.get(file)));
    return {
      ok: true,
      clean: !hasErrors(finalDiags),
      conflict: false,
      revision: projectRevision(finalProject),
      passes: this.passes,
      stopped,
      applied: this.applied,
      skipped: [...this.skipped.values()],
      uncovered: finalDiags.filter((d) => d.severity === 'error' && !initialErrors.has(fingerprint(d, this.entry))),
      diagnostics: finalDiags,
      ...(newSources.size > 0
        ? { newSource: newSources.get(this.entry) ?? original.get(this.entry), newSources, changedFiles: [...newSources.keys()] }
        : {}),
    };
  }

  /**
   * One candidate per diagnostic, deduplicated by fix id and edited files
   * (identical edits in two files share an id but are two fixes), visited in
   * (file load order, offset) order so an explicit id lands on its first site,
   * and ordered for the greedy claim.
   */
  private plan(state: Trial): Plan {
    const fileIndex = new Map(state.project.files.map((f, i) => [f.file, i]));
    const fileOf = (d: Diagnostic): number => fileIndex.get(d.span?.file ?? this.entry) ?? 0;
    const ordered = [...state.diags].sort((a, b) => fileOf(a) - fileOf(b) || (a.span?.start ?? -1) - (b.span?.start ?? -1));
    const byKey = new Map<string, Candidate>();
    const offered = new Set<string>();
    for (const d of ordered) {
      const fixes = d.fixes ?? [];
      for (const fix of fixes) offered.add(fix.id);
      if (fixes.length === 0) continue;
      const requested = this.requestedFix(d.code, fixes);
      let pick: Fix | undefined = requested?.fix;
      if (pick === undefined) {
        if (this.codes !== undefined && !this.codes.has(d.code)) continue;
        pick = LEVEL_RANK[this.level] >= CONFIDENCE_RANK.safe ? preferredFix(d) : undefined;
        if (pick === undefined) {
          const eligible = fixes.filter((f) => CONFIDENCE_RANK[f.confidence] <= LEVEL_RANK[this.level]);
          if (eligible.length > 1) {
            for (const fix of eligible) this.skip({ fix, code: d.code }, 'ambiguous');
            continue;
          }
          pick = eligible[0];
        }
      }
      if (pick === undefined) continue;
      const [firstEdit] = pick.edits;
      if (firstEdit === undefined || !this.validEdits(pick, state.sources)) {
        this.skip({ fix: pick, code: d.code }, 'invalid-edit');
        continue;
      }
      if (this.blocked.has(shapeOf(d.code, pick))) continue;
      const requestIndex = requested?.index ?? Number.POSITIVE_INFINITY;
      const key = candidateKey(pick, this.entry);
      const existing = byKey.get(key);
      if (existing !== undefined) {
        existing.diagnostics.push(d);
        existing.requestIndex = Math.min(existing.requestIndex, requestIndex);
        existing.hasError = existing.hasError || d.severity === 'error';
        continue;
      }
      byKey.set(key, {
        fix: pick,
        code: d.code,
        diagnostics: [d],
        requestIndex,
        hasError: d.severity === 'error',
        file: firstEdit.file ?? this.entry,
        fileIndex: Math.min(...pick.edits.map((e) => fileIndex.get(e.file ?? this.entry) ?? 0)),
        start: Math.min(...pick.edits.map((e) => e.start)),
        end: Math.max(...pick.edits.map((e) => e.end)),
      });
    }
    const candidates = [...byKey.values()].sort(
      (a, b) =>
        (a.requestIndex === b.requestIndex ? 0 : a.requestIndex < b.requestIndex ? -1 : 1) ||
        Number(b.hasError) - Number(a.hasError) ||
        a.fileIndex - b.fileIndex ||
        a.start - b.start ||
        b.end - a.end ||
        compareStrings(a.code, b.code) ||
        compareStrings(a.fix.id, b.fix.id),
    );
    // A pass applies one confidence tier, the most trusted one offered: review
    // fixes encode choices, so they wait until every safe correction has
    // landed and the diagnostics it caused downstream have disappeared.
    const tier = Math.min(...candidates.filter((c) => !Number.isFinite(c.requestIndex)).map((c) => CONFIDENCE_RANK[c.fix.confidence]));
    const selected = candidates.filter((c) => Number.isFinite(c.requestIndex) || CONFIDENCE_RANK[c.fix.confidence] === tier);
    return { candidates: selected, heldBack: candidates.length - selected.length, missing: this.requestedIds.filter((id) => !offered.has(id)) };
  }

  /**
   * The explicitly requested fix among a diagnostic's fixes, if any. A request
   * names one fix: the first site ever offering the id claims it, and a
   * same-id fix at another site (identical edits in another file, in this or a
   * later pass) is selected by level like any other. Ids are offset-bound, so
   * a requested fix the previous pass deferred is recognised by its offset-free
   * shape instead; that entry is consumed by the first site offering the shape.
   */
  private requestedFix(code: string, fixes: Fix[]): { fix: Fix; index: number } | undefined {
    let best: { fix: Fix; index: number; deferredShape?: string } | undefined;
    for (const fix of fixes) {
      const direct = this.requestedIds.indexOf(fix.id);
      const owner = this.claimedIds.get(fix.id);
      const shape = shapeOf(code, fix);
      const deferred = this.deferredRequests.get(shape);
      const found = direct !== -1 && (owner === undefined || owner === candidateKey(fix, this.entry))
        ? { fix, index: direct }
        : deferred !== undefined
          ? { fix, index: deferred, deferredShape: shape }
          : undefined;
      if (found === undefined || (best !== undefined && best.index <= found.index)) continue;
      best = found;
    }
    if (best === undefined) return undefined;
    if (best.deferredShape !== undefined) this.deferredRequests.delete(best.deferredShape);
    else this.claimedIds.set(best.fix.id, candidateKey(best.fix, this.entry));
    return { fix: best.fix, index: best.index };
  }

  private validEdits(fix: Fix, sources: Map<string, string>): boolean {
    for (const [i, edit] of fix.edits.entries()) {
      const text = sources.get(edit.file ?? this.entry);
      if (text === undefined || !Number.isInteger(edit.start) || !Number.isInteger(edit.end)) return false;
      if (edit.start < 0 || edit.end < edit.start || edit.end > text.length) return false;
      if (fix.edits.slice(i + 1).some((other) => editsConflict(edit, other, this.entry))) return false;
    }
    return true;
  }

  /** The whole batch at once, else one fix at a time onto the accepted ones, rejecting fixes that fail alone. */
  private applyBatch(state: Trial, batch: Candidate[]): { accepted: Candidate[]; state: Trial; cycled: boolean } {
    if (batch.length > 1) {
      const whole = this.attempt(state.sources, batch.map((c) => c.fix));
      if (this.judge(whole, state, batch) === 'accepted') return { accepted: batch, state: whole, cycled: false };
    }
    const accepted: Candidate[] = [];
    let current = state;
    let cycled = false;
    for (const candidate of batch) {
      const trial = this.attempt(state.sources, [...accepted, candidate].map((c) => c.fix));
      const single = this.judge(trial, state, [candidate]);
      if (single === 'accepted') {
        accepted.push(candidate);
        current = trial;
        continue;
      }
      cycled = cycled || single === 'cycle';
      this.reject(candidate, single);
    }
    return { accepted, state: current, cycled };
  }

  private attempt(base: Map<string, string>, fixes: readonly Fix[]): Trial {
    const sources = new Map(base);
    const byFile = new Map<string, TextEdit[]>();
    for (const fix of fixes) {
      for (const edit of fix.edits) {
        const file = edit.file ?? this.entry;
        const edits = byFile.get(file);
        if (edits === undefined) byFile.set(file, [edit]);
        else edits.push(edit);
      }
    }
    for (const [file, edits] of byFile) {
      const text = sources.get(file);
      if (text !== undefined) sources.set(file, applyTextEdits(text, edits));
    }
    const project = loadProject(this.entry, (p) => sources.get(p) ?? this.readFile(p));
    const diags = hasErrors(project.diagnostics) ? project.diagnostics : diagnoseProject(project);
    return { sources, project, diags, counts: countSites(diags, this.entry), edits: byFile, hash: stateHash(project) };
  }

  /**
   * Accept when the program still parses, every candidate's diagnostics are
   * gone from their sites, and the text is new. Sites are judged where the
   * trial's edits moved them, so a fix that unmasks the same message elsewhere
   * (an unknown op hiding an identical one inside it) still counts; a
   * span-less diagnostic falls back to its fingerprint count.
   */
  private judge(trial: Trial, base: Trial, candidates: Candidate[]): Verdict {
    if (hasErrors(trial.project.diagnostics)) return 'broke-parse';
    const before = countSites(base.diags, this.entry, trial.edits);
    for (const candidate of candidates) {
      for (const d of candidate.diagnostics) {
        const key = siteKey(d, this.entry, trial.edits);
        if ((trial.counts.get(key) ?? 0) >= (before.get(key) ?? 0)) return 'ineffective';
      }
    }
    return this.seen.has(trial.hash) ? 'cycle' : 'accepted';
  }

  private reject(candidate: Candidate, verdict: Exclude<Verdict, 'accepted'>): void {
    this.blocked.add(shapeOf(candidate.code, candidate.fix));
    this.skip(candidate, skipReasonOf(verdict));
  }

  /** Recorded once per offset-free shape; a later sighting refreshes the id. */
  private skip(candidate: { fix: Fix; code: string }, reason: FixSkipReason): void {
    const { fix, code } = candidate;
    this.skipped.set(shapeOf(code, fix), { id: fix.id, code, title: fix.title, confidence: fix.confidence, reason });
  }

  /** The fixed diagnostic's position, or the first edit's when it carries no span. */
  private siteOf(candidate: Candidate, state: Trial, pass: number): AppliedFix {
    const [first] = candidate.diagnostics;
    const { span } = first;
    const site = span !== undefined
      ? { file: span.file ?? this.entry, line: span.line, col: span.col }
      : { file: candidate.file, ...positionAt(state.sources.get(candidate.file) ?? '', candidate.start) };
    return {
      id: candidate.fix.id,
      code: candidate.code,
      title: candidate.fix.title,
      confidence: candidate.fix.confidence,
      ...site,
      ...(first.nodeId !== undefined ? { nodeId: first.nodeId } : {}),
      pass,
    };
  }
}

/** Fix a (possibly multi-file) project held behind `readFile`; only files whose text changes are reported. */
export function applyFixesToProject(entry: string, readFile: ReadFile, request: FixRequest = {}): FixResult {
  return new FixRun(entry, readFile, request).run();
}

/** Fix a single-source program held in memory. */
export function applyFixes(source: string, request: FixRequest = {}): FixResult {
  const read: ReadFile = (p) => (p === 'app.grhm' ? source : undefined);
  return applyFixesToProject('app.grhm', read, request);
}
