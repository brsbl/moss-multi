// A CLI push landed on the live doc (A§17 steps 2-5). The pushed file is merged three ways against its base and the
// doc's own `.md` export (computeMergedTarget), a degenerate push is refused unless forced, and the merged file lands
// in one serverWrite through the identity-preserving reconcile (T6.1): untouched blocks keep their Yjs items, so a
// peer typing in them, and the comment anchors on them, survive. Verify or refuse: the result's export must equal the
// merged target byte for byte (so every region the push did not edit equals the live export), or nothing lands and
// ReconcileRefused (409) names the block. `admit` checks the simulated result against the state cap and throws to refuse.
import type { SerializedEditorState } from 'lexical';
import type * as Y from 'yjs';
import { splitFrontmatter } from '@moss-desktop/common/markdown-layers';
import { importFrontmatter } from '@moss-multi/core/frontmatter';
import { computeMergedTarget, editsOf, type MergeBudget, mergeBudget, MergeBudgetExceeded, normalizeEol, withoutFinalEol } from '@moss-multi/core/merge';
import { align, fullOf, type SerializedNode } from '@moss-multi/core/reconcile';
import { createConverterEditor, exportMarkdown, markdownToState, stateToMarkdown } from './converter/index.ts';
import { bodyState, reconcileBody, ReconcileRefused, type ForkTarget } from './reconcile.ts';
import { exportDocMarkdown, exportMirror, type Admit } from './server-doc.ts';

export interface PushInput {
  base: string;
  newText: string;
  force: boolean;
  /** `--suggest`: the merge is written as a fork under a leased client and collected as record ops; the doc is untouched. */
  fork?: ForkTarget;
  /** The merge's work; one per push by default. */
  budget?: MergeBudget;
}

export type PushOutcome =
  | { ok: true; applied: number; failedHunks: string[]; changed: boolean }
  | { ok: false; reason: 'degenerate'; deletedRatio: number }
  /** A suggestion holds body text only; a push that changes the note's properties cannot be suggested. */
  | { ok: false; reason: 'properties' };

/** A file's frontmatter block, when it parses, and its body; a block that does not parse stays body text. */
function partsOf(file: string): { body: string; frontmatter: string; fenced: boolean; hasFrontmatter: boolean } {
  const parts = splitFrontmatter(file);
  const fenced = parts.hasFrontmatter && !parts.error;
  return {
    body: fenced ? parts.body : file,
    frontmatter: fenced ? file.slice(0, file.length - parts.body.length) : '',
    fenced,
    hasFrontmatter: parts.hasFrontmatter,
  };
}

const childrenOf = (node: SerializedNode): SerializedNode[] | null => (Array.isArray(node.children) ? node.children as SerializedNode[] : null);

/**
 * A touched block, `target`, with each of its children the push left alone swapped back for the live child it came
 * from (recursively), when `live`, its re-import and `target` are the same kind of element; otherwise `target`.
 */
function reuseBlock(live: SerializedNode, reimported: SerializedNode, target: SerializedNode): SerializedNode {
  const liveKids = childrenOf(live);
  const reimportedKids = childrenOf(reimported);
  const targetKids = childrenOf(target);
  if (!liveKids || !reimportedKids || !targetKids || live.type !== target.type || reimported.type !== target.type) return target;
  const children = keepUntouched(liveKids, reimportedKids, targetKids);
  return children ? { ...target, children } : target;
}

/**
 * The converter does not re-import every export exactly (a fence inside a 4-backtick block, entity spaces), so a
 * target node the merge left as the export wrote it is swapped back for the live node it came from, and only edited
 * nodes are re-imported. Each run of nodes whose re-import differs from the live tree is swapped whole, when the
 * target keeps the whole run in place; a single such node the push edited keeps its untouched children the same way.
 * Returns null when the runs cannot be placed.
 */
function keepUntouched(live: SerializedNode[], reimported: SerializedNode[], target: SerializedNode[]): SerializedNode[] | null {
  const reimportedSigs = reimported.map(fullOf);
  const kept = new Map(align(reimportedSigs, target.map(fullOf)));
  const anchors = align(reimportedSigs, live.map(fullOf));
  anchors.push([reimported.length, live.length]);
  const swaps = new Map<number, { end: number; blocks: SerializedNode[] }>();
  let r = 0;
  let l = 0;
  for (const [ri, li] of anchors) {
    // Where the target holds what sits between reimported[r - 1] and reimported[ri].
    const before = r === 0 ? -1 : kept.get(r - 1);
    const after = ri === reimported.length ? target.length : kept.get(ri);
    if (ri > r) {
      // reimported[r, ri) is how live[l, li) re-imports: swap it back when the target kept all of it, in order.
      const start = kept.get(r);
      let whole = start !== undefined;
      for (let k = r + 1; whole && k < ri; k++) whole = kept.get(k) === start! + (k - r);
      if (whole) {
        swaps.set(start!, { end: start! + (ri - r), blocks: live.slice(l, li) });
      } else if (ri - r === 1 && li - l === 1 && before !== undefined && after === before + 2) {
        // One node, edited by the push: it is the one target node between its kept neighbours.
        swaps.set(before + 1, { end: before + 2, blocks: [reuseBlock(live[l]!, reimported[r]!, target[before + 1]!)] });
      } else {
        return null;
      }
    } else if (li > l) {
      // live[l, li) re-imports as nothing: restore it where its neighbours are still adjacent.
      if (before === undefined || after !== before + 1) return null;
      swaps.set(after, { end: after, blocks: live.slice(l, li) });
    }
    r = ri + 1;
    l = li + 1;
  }
  if (swaps.size === 0) return target;
  const out: SerializedNode[] = [];
  for (let t = 0; t <= target.length;) {
    const swap = swaps.get(t);
    if (swap) out.push(...swap.blocks);
    if (swap && swap.end > t) {
      t = swap.end;
      continue;
    }
    if (t < target.length) out.push(target[t]!);
    t++;
  }
  return out;
}

const blocksOf = (state: SerializedEditorState): SerializedNode[] => state.root.children as unknown as SerializedNode[];

/**
 * The target, block by block, for a push that edits a run of blocks the converter cannot re-import exactly: each live
 * block is found in `current` by its own export, a block no edit touches stays as it is, and each run of touched
 * blocks is re-imported from its own new text alone (a single touched block keeps its untouched children). Throws
 * ReconcileRefused when the blocks cannot be found.
 */
function spliceByBlock(liveState: SerializedEditorState, current: string, target: string, budget: MergeBudget): SerializedNode[] {
  const live = blocksOf(liveState);
  if (live.length === 0) return blocksOf(markdownToState(target));
  const editor = createConverterEditor();
  const bounds: number[] = [];
  let cursor = 0;
  for (const block of live) {
    editor.setEditorState(editor.parseEditorState({ ...liveState, root: { ...liveState.root, children: [block] } } as never));
    const text = exportMarkdown(editor);
    const at = current.indexOf(text, cursor);
    if (at < 0 || current.slice(cursor, at).trim() !== '') throw new ReconcileRefused('unverified', 'a block of this note cannot be placed in its export, so the push cannot be applied block by block');
    bounds.push(bounds.length === 0 ? 0 : at);
    cursor = at + text.length;
  }
  if (current.slice(cursor).trim() !== '') throw new ReconcileRefused('unverified', 'a block of this note cannot be placed in its export, so the push cannot be applied block by block');
  bounds.push(current.length);
  // Block i owns [bounds[i], bounds[i + 1]): its text and the separator after it.
  // Coarser edits only touch more blocks, so this diff never refuses; edits are disjoint and in order, so both scans are linear.
  const edits = editsOf(current, target, budget, false);
  const touched = live.map(() => false);
  for (let i = 0, first = 0; i < live.length; i++) {
    const from = bounds[i]!;
    const to = bounds[i + 1]!;
    while (first < edits.length && edits[first]!.end < from) first++;
    for (let k = first; k < edits.length && edits[k]!.start <= to && !touched[i]; k++) {
      const { start, end } = edits[k]!;
      touched[i] = start === end ? from <= start && start <= to : start < to && end > from;
    }
  }
  const sums = [0];
  for (const edit of edits) sums.push(sums.at(-1)! + edit.text.length - (edit.end - edit.start));
  /** Where `at` in `current` lands in `target`; an insertion at `at` itself counts only for the end of a run. */
  const shift = (at: number, end: boolean): number => {
    // The edits before `at` are a prefix of the list: found by binary search.
    let lo = 0;
    let hi = edits.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const edit = edits[mid]!;
      if (edit.end < at || (edit.end === at && (end || edit.start < at))) lo = mid + 1;
      else hi = mid;
    }
    return at + sums[lo]!;
  };
  const out: SerializedNode[] = [];
  for (let i = 0; i < live.length;) {
    if (!touched[i]) {
      out.push(live[i]!);
      i++;
      continue;
    }
    let j = i;
    while (j < live.length && touched[j]) j++;
    const text = target.slice(shift(bounds[i]!, false), shift(bounds[j]!, true));
    const imported = text.trim() === '' ? [] : blocksOf(markdownToState(text));
    const reimported = j - i === 1 && imported.length === 1 ? blocksOf(markdownToState(current.slice(bounds[i]!, bounds[j]!))) : [];
    if (reimported.length === 1) out.push(reuseBlock(live[i]!, reimported[0]!, imported[0]!));
    else out.push(...imported);
    i = j;
  }
  return out;
}

/** Counts `\n\n` separators before `at`: the 1-based block `at` falls in, as the file reads. */
function blockAt(text: string, at: number): number {
  let block = 1;
  for (let next = text.indexOf('\n\n'); next >= 0 && next < at; next = text.indexOf('\n\n', next + 2)) block++;
  return block;
}

function firstLine(text: string, start: number): string {
  const end = text.indexOf('\n', start + 1);
  const line = text.slice(start, end < 0 ? text.length : end).trim();
  return line.length > 60 ? `${line.slice(0, 57)}...` : line;
}

/**
 * Why `actual` is refused: the first block where it differs from `expected`, named by its number and first line. A
 * block the live doc already held is one the pull wrote; any other is the push's own, which moss would store differently.
 */
function mismatch(expected: string, actual: string, current: string): string {
  let at = 0;
  while (at < expected.length && at < actual.length && expected.charCodeAt(at) === actual.charCodeAt(at)) at++;
  const start = expected.lastIndexOf('\n\n', at - 1) + 1;
  const end = expected.indexOf('\n\n', at);
  const block = expected.slice(start, end < 0 ? expected.length : end);
  const quoted = firstLine(expected, start);
  const name = `block ${blockAt(expected, at)}${quoted ? ` ("${quoted}")` : ''}`;
  if (block && current.includes(block)) {
    return `${name} would not land exactly as pushed, so nothing changed; pull and push again, leaving that block as the pull wrote it`;
  }
  const stored = firstLine(actual, actual.lastIndexOf('\n\n', at - 1) + 1);
  return `${name} would be stored differently${stored ? ` (as "${stored}")` : ''}, so nothing changed; write it the way moss writes Markdown (for example *emphasis*, **strong**, \`\`\`javascript) and push again`;
}

const OVER_BUDGET = 'the push changes too many places in a note that changed since it was pulled to merge them safely, so nothing changed; pull and push again';

/** A merge past its budget lands nothing: it is refused (409) before anything is written. */
export function landPush(live: Y.Doc, noteId: string, input: PushInput, origin: unknown, admit?: Admit): PushOutcome {
  try {
    return landMerged(live, noteId, input, origin, input.budget ?? mergeBudget(), admit);
  } catch (error) {
    if (error instanceof MergeBudgetExceeded) throw new ReconcileRefused('unverified', OVER_BUDGET);
    throw error;
  }
}

function landMerged(live: Y.Doc, noteId: string, input: PushInput, origin: unknown, budget: MergeBudget, admit?: Admit): PushOutcome {
  const base = normalizeEol(input.base);
  const next = normalizeEol(input.newText);
  const current = exportDocMarkdown(live, noteId);
  const merge = computeMergedTarget(current, base, next, { refuseDegenerate: !input.force, budget });
  if (merge.degenerate) return { ok: false, reason: 'degenerate', deletedRatio: merge.deletedRatio };
  if (merge.target === current) return { ok: true, applied: 0, failedHunks: merge.failedHunks, changed: false };
  const target = partsOf(merge.target);
  const expected = withoutFinalEol(target.body);
  const currentParts = partsOf(current);
  const writesProperties = target.frontmatter !== currentParts.frontmatter && (target.fenced || !target.hasFrontmatter);
  if (input.fork && writesProperties) return { ok: false, reason: 'properties' };
  const state = markdownToState(target.body);
  const liveState = bodyState(live);
  const blocks = keepUntouched(blocksOf(liveState), blocksOf(markdownToState(currentParts.body)), blocksOf(state))
    ?? spliceByBlock(liveState, currentParts.body, target.body, budget);
  const root = { ...state.root, children: blocks } as unknown as SerializedEditorState['root'];
  try {
    // A push may change only payload text (a code block's code), which the note's own update does not show.
    let wrotePayloads = false;
    const admitting: Admit = (diff, payloads) => {
      admit?.(diff, payloads);
      wrotePayloads = payloads.length > 0;
    };
    const changedNote = reconcileBody(live, { ...state, root }, origin, admitting, {
      mutate(doc) {
        // Properties are structured, not converted text: they are written only when the push changed the block, and
        // stay as they are when the file's frontmatter block does not parse.
        if (writesProperties) importFrontmatter(doc, target.frontmatter, origin);
      },
      verify(mirror) {
        const body = withoutFinalEol(partsOf(exportMirror(mirror, noteId)).body);
        if (body !== expected) throw new ReconcileRefused('unverified', mismatch(expected, body, currentParts.body));
      },
    }, undefined, input.fork);
    return { ok: true, applied: merge.applied, failedHunks: merge.failedHunks, changed: changedNote || wrotePayloads };
  } catch (error) {
    if (error instanceof ReconcileRefused && error.reason !== 'unverified') {
      // The reconcile's own check (its result against the composed tree) names no block: name the one that differs.
      let composed = '';
      try {
        composed = withoutFinalEol(stateToMarkdown({ ...state, root }));
      } catch {
        // Unparseable: the message names the first block.
      }
      throw new ReconcileRefused('unverified', mismatch(expected, composed, currentParts.body));
    }
    throw error;
  }
}
