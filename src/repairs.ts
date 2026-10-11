import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { CODE_DOCS } from './diagnostics.js';
import { FixLevel } from './fix.js';
import { nearestAll } from './util.js';

/**
 * The corpus repair transcripts (PRD FR-15) as `grhm codes <CODE>` and the
 * compiler server serve them: one broken program per diagnostic, the code it
 * emits, and the repaired program. `corpus/repairs.json` ships beside `dist/`
 * (package.json `files`), so it is located relative to this module in both
 * layouts: `dist/repairs.js` and `src/repairs.ts` under vitest. A layout
 * without the corpus simply has no worked repairs.
 */

/** A repair's declared `grhm fix --level` replay; placeholders never replay in bulk, so `none` does not occur. */
export type RepairFixLevel = Exclude<FixLevel, 'none'>;

export interface Repair {
  name: string;
  code: string;
  note: string;
  broken: string;
  fixed: string;
  /** Present when `grhm fix --level <fix>` replays `broken` to exactly `fixed`. */
  fix?: RepairFixLevel;
}

export interface CodeExplanation {
  code: string;
  doc: string;
  repairs: Repair[];
}

const DEFAULT_REPAIRS_PATH = fileURLToPath(new URL('../corpus/repairs.json', import.meta.url));

const cache = new Map<string, Repair[]>();

/** The required transcript fields, every one a string. */
const TEXT_FIELDS = ['name', 'code', 'note', 'broken', 'fixed'] as const;
type TextField = (typeof TEXT_FIELDS)[number];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasTextFields(entry: Record<string, unknown>): entry is Record<string, unknown> & Record<TextField, string> {
  return TEXT_FIELDS.every((key) => typeof entry[key] === 'string');
}

function repairAt(entry: unknown, index: number, file: string): Repair {
  const where = `${file}: repairs[${index}]`;
  if (!isRecord(entry)) throw new Error(`${where} must be an object`);
  if (!hasTextFields(entry)) {
    const missing = TEXT_FIELDS.find((key) => typeof entry[key] !== 'string');
    throw new Error(`${where}.${missing ?? 'name'} must be a string`);
  }
  const fix = entry['fix'];
  if (fix !== undefined && fix !== 'safe' && fix !== 'review') throw new Error(`${where}.fix must be "safe" or "review"`);
  return { name: entry.name, code: entry.code, note: entry.note, broken: entry.broken, fixed: entry.fixed, ...(fix !== undefined ? { fix } : {}) };
}

/**
 * The validated transcripts of `corpus/repairs.json` (or of `file`), read
 * once per path. A missing file yields no repairs; a malformed one throws
 * naming the offending entry, since the corpus is part of the package.
 */
export function loadRepairs(file: string = DEFAULT_REPAIRS_PATH): Repair[] {
  const cached = cache.get(file);
  if (cached !== undefined) return cached;
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return [];
    throw err;
  }
  const parsed: unknown = JSON.parse(text);
  if (!isRecord(parsed) || !Array.isArray(parsed['repairs'])) throw new Error(`${file}: expected { "repairs": [...] }`);
  const repairs = parsed['repairs'].map((entry, index) => repairAt(entry, index, file));
  cache.set(file, repairs);
  return repairs;
}

/** Codes are matched case-insensitively (`e111` finds E111); the result carries the canonical spelling. */
function canonicalCode(code: string): string {
  return code.trim().toUpperCase();
}

/** One diagnostic code with its documentation line and every repair transcript that reproduces it, or undefined for an unknown code. */
export function explainCode(code: string, repairs: Repair[] = loadRepairs()): CodeExplanation | undefined {
  const canonical = canonicalCode(code);
  const doc = CODE_DOCS[canonical];
  if (doc === undefined) return undefined;
  return { code: canonical, doc, repairs: repairs.filter((r) => r.code === canonical) };
}

/** Codes are four characters; anything longer than this is not a near miss and is not worth echoing whole. */
const MAX_CODE_LENGTH = 16;

/** The documented codes nearest to an unknown one (edit distance at most 2), for "did you mean" hints; none for an over-long input. */
export function nearestCodes(code: string): string[] {
  const canonical = canonicalCode(code);
  return canonical.length > MAX_CODE_LENGTH ? [] : nearestAll(canonical, Object.keys(CODE_DOCS));
}

/** An unknown code as a message echoes it: whole when short, else cut to `MAX_CODE_LENGTH` with an ellipsis. */
export function displayCode(code: string): string {
  return code.length > MAX_CODE_LENGTH ? `${code.slice(0, MAX_CODE_LENGTH)}…` : code;
}
