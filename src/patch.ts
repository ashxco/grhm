import { ListNode, SExpr, findNode, isList, opName, splitList, walkLists } from './ast.js';
import { analyze } from './analyze.js';
import { check } from './checker.js';
import { Diagnostic, hasErrors, makeDiag } from './diagnostics.js';
import { format } from './format.js';
import { assignIds } from './ids.js';
import { parse } from './parser.js';
import { ReadFile, loadProject, projectRevision } from './project.js';

/**
 * Structural patch protocol (PRD FR-9).
 *
 * A patch targets one node by stable ID and applies a sequence of operations
 * atomically: if any operation fails, or if the patched program does not pass
 * semantic checking, nothing changes.
 *
 * Patch source form:
 *
 *   (patch :revision "abcd1234" :target b17
 *     (set radius 16)
 *     (delete shadow)
 *     (append (txt "New"))
 *     (insert-before (spacer 8))
 *     (insert-after (spacer 8))
 *     (replace (btn "Save" (click (set saving true))))
 *     (move :before other-id))
 */

export interface PatchResult {
  ok: boolean;
  /** Revision after the patch (present when ok). */
  revision?: string;
  /** Current revision (present on conflict). */
  currentRevision?: string;
  conflict: boolean;
  changed: string[];
  diagnostics: Diagnostic[];
  /** New source of the entry file (present when ok). */
  newSource?: string;
  /** New source per changed file (present when ok). */
  newSources?: Map<string, string>;
  /** Files whose content changed (present when ok). */
  changedFiles?: string[];
}

function fail(diagnostics: Diagnostic[], conflict = false, currentRevision?: string): PatchResult {
  return { ok: false, conflict, changed: [], diagnostics, currentRevision };
}

/** Set (or add) a keyword property on a node. */
function applySet(target: ListNode, prop: string, value: SExpr): void {
  const items = target.items;
  for (let i = 1; i < items.length; i += 1) {
    const item = items[i];
    if (item !== undefined && item.kind === 'keyword' && item.name === prop) {
      items.splice(i + 1, 1, value);
      return;
    }
  }
  // Property not present: insert after the last existing keyword pair, or
  // after leading positional atoms, keeping children last.
  let insertAt = 1;
  for (let i = 1; i < items.length; i += 1) {
    const item = items[i];
    if (item === undefined) break;
    if (item.kind === 'keyword') {
      insertAt = i + 2;
      i += 1;
    } else if (item.kind !== 'list' && insertAt === i) {
      insertAt = i + 1;
    }
  }
  items.splice(insertAt, 0, { kind: 'keyword', name: prop, span: target.span }, value);
}

function applyDelete(target: ListNode, prop: string): boolean {
  const items = target.items;
  for (let i = 1; i < items.length; i += 1) {
    const item = items[i];
    if (item !== undefined && item.kind === 'keyword' && item.name === prop) {
      items.splice(i, 2);
      return true;
    }
  }
  return false;
}

function isDescendant(ancestor: ListNode, node: ListNode): boolean {
  let found = false;
  walkLists([ancestor], (n) => {
    if (n === node && n !== ancestor) found = true;
  });
  return found;
}

/** Patch a single-source program held in memory. */
export function applyPatch(source: string, patchSource: string): PatchResult {
  const read: ReadFile = (p) => (p === 'app.grhm' ? source : undefined);
  return applyPatchToProject('app.grhm', read, patchSource);
}

/**
 * Patch a (possibly multi-file) project. The target node may live in any
 * project file; only files whose canonical text changes are reported.
 */
export function applyPatchToProject(entry: string, readFile: ReadFile, patchSource: string): PatchResult {
  const project = loadProject(entry, readFile);
  if (hasErrors(project.diagnostics)) {
    return fail([
      makeDiag('E503', 'error', 'Cannot patch: current source does not parse'),
      ...project.diagnostics,
    ]);
  }
  const currentRevision = projectRevision(project);
  const allRoots = project.files.flatMap((f) => f.nodes);
  const originalCanonical = new Map(project.files.map((f) => [f.file, format(f.nodes)]));

  const patchParse = parse(patchSource);
  if (hasErrors(patchParse.diagnostics)) {
    return fail([makeDiag('E503', 'error', 'Patch source does not parse'), ...patchParse.diagnostics]);
  }
  const patchNode = patchParse.nodes.find((n): n is ListNode => isList(n) && opName(n) === 'patch');
  if (patchNode === undefined) {
    return fail([makeDiag('E503', 'error', 'Expected a (patch :target id op...) form')]);
  }

  const parts = splitList(patchNode);
  const diagnostics: Diagnostic[] = [];

  const revisionProp = parts.props.get('revision')?.value;
  if (revisionProp === undefined) {
    diagnostics.push(
      makeDiag('W501', 'warning', 'Patch has no :revision precondition; concurrent edits cannot be detected'),
    );
  } else {
    const expected = revisionProp.kind === 'string' ? revisionProp.value : revisionProp.kind === 'ident' ? revisionProp.name : '';
    if (expected !== currentRevision) {
      return fail(
        [
          makeDiag('E504', 'error', `Revision conflict: patch expects "${expected}" but program is at "${currentRevision}"`, {
            received: expected,
            expected: currentRevision,
          }),
        ],
        true,
        currentRevision,
      );
    }
  }

  const targetProp = parts.props.get('target')?.value;
  const targetId =
    targetProp === undefined ? undefined : targetProp.kind === 'ident' ? targetProp.name : targetProp.kind === 'string' ? targetProp.value : undefined;
  if (targetId === undefined) {
    return fail([makeDiag('E501', 'error', 'Patch requires a :target node ID')]);
  }
  const found = findNode(allRoots, targetId);
  if (found === undefined) {
    return fail([
      makeDiag('E501', 'error', `No node with ID "${targetId}"`, { received: targetId }),
    ]);
  }
  const { node: target, parent } = found;
  let reportedNode: ListNode | undefined = target;

  for (const opForm of parts.rest) {
    if (!isList(opForm)) {
      return fail([makeDiag('E501', 'error', 'Patch operations must be lists', { span: opForm.span })]);
    }
    const op = opName(opForm);
    const opParts = splitList(opForm);
    switch (op) {
      case 'set': {
        const prop = opParts.rest[0];
        const value = opParts.rest[1];
        if (prop === undefined || prop.kind !== 'ident' || value === undefined) {
          return fail([makeDiag('E501', 'error', 'set requires a property name and a value', { span: opForm.span })]);
        }
        applySet(target, prop.name, value);
        break;
      }
      case 'delete': {
        const prop = opParts.rest[0];
        if (prop === undefined || prop.kind !== 'ident') {
          return fail([makeDiag('E501', 'error', 'delete requires a property name', { span: opForm.span })]);
        }
        if (!applyDelete(target, prop.name)) {
          return fail([
            makeDiag('E501', 'error', `Node "${targetId}" has no property ":${prop.name}"`, {
              span: opForm.span,
              nodeId: targetId,
              field: prop.name,
            }),
          ]);
        }
        break;
      }
      case 'append': {
        const child = opParts.rest[0];
        if (child === undefined) {
          return fail([makeDiag('E501', 'error', 'append requires a value', { span: opForm.span })]);
        }
        target.items.push(child);
        break;
      }
      case 'insert-before':
      case 'insert-after': {
        const sibling = opParts.rest[0];
        if (sibling === undefined) {
          return fail([makeDiag('E501', 'error', `${op} requires a value`, { span: opForm.span })]);
        }
        if (parent === undefined) {
          return fail([makeDiag('E502', 'error', 'Cannot insert siblings around the root node', { nodeId: targetId })]);
        }
        const index = parent.items.indexOf(target);
        parent.items.splice(op === 'insert-before' ? index : index + 1, 0, sibling);
        break;
      }
      case 'replace': {
        const replacement = opParts.rest[0];
        if (replacement === undefined) {
          return fail([makeDiag('E501', 'error', 'replace requires a value', { span: opForm.span })]);
        }
        if (parent === undefined) {
          return fail([makeDiag('E502', 'error', 'Cannot replace the root node', { nodeId: targetId })]);
        }
        const index = parent.items.indexOf(target);
        parent.items.splice(index, 1, replacement);
        reportedNode = isList(replacement) ? replacement : undefined;
        break;
      }
      case 'move': {
        const before = opParts.props.get('before')?.value;
        const after = opParts.props.get('after')?.value;
        const into = opParts.props.get('into')?.value;
        const destinationCount = [before, after, into].filter((value) => value !== undefined).length;
        if (destinationCount !== 1) {
          return fail([
            makeDiag('E502', 'error', 'move requires exactly one of :before, :after, or :into', {
              span: opForm.span,
              nodeId: targetId,
              op: 'move',
              expected: '(move :before id) | (move :after id) | (move :into id)',
            }),
          ]);
        }
        const refExpr = before ?? after ?? into;
        if (refExpr === undefined || (refExpr.kind !== 'ident' && refExpr.kind !== 'string')) {
          return fail([makeDiag('E502', 'error', 'move requires :before, :after, or :into with a node ID', { span: opForm.span })]);
        }
        const refId = refExpr.kind === 'ident' ? refExpr.name : refExpr.value;
        const ref = findNode(allRoots, refId);
        if (ref === undefined) {
          return fail([makeDiag('E501', 'error', `No node with ID "${refId}"`, { received: refId })]);
        }
        if (ref.node === target || isDescendant(target, ref.node)) {
          return fail([makeDiag('E502', 'error', 'Cannot move a node relative to itself or into its own subtree', { nodeId: targetId })]);
        }
        if (parent === undefined) {
          return fail([makeDiag('E502', 'error', 'Cannot move the root node', { nodeId: targetId })]);
        }
        parent.items.splice(parent.items.indexOf(target), 1);
        if (into !== undefined) {
          ref.node.items.push(target);
        } else {
          if (ref.parent === undefined) {
            return fail([makeDiag('E502', 'error', 'Cannot move relative to the root node', { nodeId: refId })]);
          }
          const refIndex = ref.parent.items.indexOf(ref.node);
          ref.parent.items.splice(before !== undefined ? refIndex : refIndex + 1, 0, target);
        }
        break;
      }
      default:
        return fail([
          makeDiag('E501', 'error', `Unknown patch operation "${op ?? '?'}"`, {
            span: opForm.span,
            expected: 'set | delete | append | insert-before | insert-after | replace | move',
          }),
        ]);
    }
  }

  // Recompute semantic IDs after structural edits. This makes `changed`
  // identify the replacement/moved node as it exists in the resulting
  // program, never a target ID that disappeared during replacement.
  assignIds(project.files.flatMap((file) => file.nodes));

  // Determine which files changed and validate the whole patched program
  // (reloaded from the new sources) before committing anything.
  const newSources = new Map<string, string>();
  const changedFiles: string[] = [];
  for (const file of project.files) {
    const formatted = format(file.nodes);
    if (formatted !== originalCanonical.get(file.file)) {
      newSources.set(file.file, formatted);
      changedFiles.push(file.file);
    }
  }
  const overlay: ReadFile = (p) => newSources.get(p) ?? readFile(p);
  const revalidated = loadProject(entry, overlay);
  const checkDiags: Diagnostic[] = [...revalidated.diagnostics];
  const app = analyze(revalidated.mergedNodes, checkDiags);
  if (app !== undefined) check(app, checkDiags);
  if (hasErrors(checkDiags)) {
    return fail([
      makeDiag('E503', 'error', 'Patch rejected: it would produce an invalid program'),
      ...checkDiags,
    ]);
  }

  diagnostics.push(...checkDiags);
  return {
    ok: true,
    revision: projectRevision(revalidated),
    conflict: false,
    changed: reportedNode !== undefined && reportedNode.id !== '' ? [reportedNode.id] : [],
    diagnostics,
    newSource: newSources.get(entry) ?? originalCanonical.get(entry),
    newSources,
    changedFiles,
  };
}
