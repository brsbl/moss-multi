// A CLI push landed on the live doc (A§17 steps 2-5). The pushed file is merged three ways against its base and the
// doc's own `.md` export (glyphdown's computeMergedTarget), a degenerate push is refused unless forced, and the merged
// file lands in one serverWrite through the identity-preserving reconcile (T6.1): untouched blocks keep their Yjs
// items, so a peer typing in them, and the comment anchors on them, survive. `admit` checks the simulated result
// against the state cap and throws to refuse; the reconcile verifies its export, or throws ReconcileRefused.
import type { SerializedEditorState } from 'lexical';
import type * as Y from 'yjs';
import { splitFrontmatter } from '@moss-desktop/common/markdown-layers';
import { importFrontmatter } from '@moss-multi/core/frontmatter';
import { computeMergedTarget, editsOf, isDegenerate, normalizeEol } from '@moss-multi/core/merge';
import { align, fullOf, type SerializedNode } from '@moss-multi/core/reconcile';
import { createConverterEditor, exportMarkdown, markdownToState } from './converter/index.ts';
import { bodyState, reconcileBody, ReconcileRefused } from './reconcile.ts';
import { exportDocMarkdown, type Admit } from './server-doc.ts';

export interface PushInput {
  base: string;
  newText: string;
  force: boolean;
}

export type PushOutcome =
  | { ok: true; applied: number; failedHunks: string[]; changed: boolean }
  | { ok: false; reason: 'degenerate'; deletedRatio: number };

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

/**
 * The converter does not re-import every export exactly (a fence inside a 4-backtick block, entity spaces), so a
 * target block the merge left as the export wrote it is swapped back for the live block it came from, and only
 * edited blocks are re-imported. Each run of blocks whose re-import differs from the live tree is swapped whole, when
 * the target keeps the whole run in place; when it does not (the push edits such a run), this returns null.
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
    if (ri > r) {
      // reimported[r, ri) is how live[l, li) re-imports: swap it back when the target kept all of it, in order.
      const start = kept.get(r);
      let whole = start !== undefined;
      for (let k = r + 1; whole && k < ri; k++) whole = kept.get(k) === start! + (k - r);
      if (!whole) return null;
      swaps.set(start!, { end: start! + (ri - r), blocks: live.slice(l, li) });
    } else if (li > l) {
      // live[l, li) re-imports as nothing: restore it where its neighbours are still adjacent.
      const before = r === 0 ? -1 : kept.get(r - 1);
      const after = ri === reimported.length ? target.length : kept.get(ri);
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
 * blocks is re-imported from its own new text alone. Throws ReconcileRefused when the blocks cannot be found.
 */
function spliceByBlock(liveState: SerializedEditorState, current: string, target: string): SerializedNode[] {
  const live = blocksOf(liveState);
  if (live.length === 0) return blocksOf(markdownToState(target));
  const editor = createConverterEditor();
  const bounds: number[] = [];
  let cursor = 0;
  for (const block of live) {
    editor.setEditorState(editor.parseEditorState({ ...liveState, root: { ...liveState.root, children: [block] } } as never));
    const text = exportMarkdown(editor);
    const at = current.indexOf(text, cursor);
    if (at < 0 || current.slice(cursor, at).trim() !== '') throw new ReconcileRefused('mismatch', 'the push cannot be placed in this note block by block');
    bounds.push(bounds.length === 0 ? 0 : at);
    cursor = at + text.length;
  }
  if (current.slice(cursor).trim() !== '') throw new ReconcileRefused('mismatch', 'the push cannot be placed in this note block by block');
  bounds.push(current.length);
  // Block i owns [bounds[i], bounds[i + 1]): its text and the separator after it.
  const edits = editsOf(current, target);
  const touched = live.map((_, i) => edits.some(({ start, end }) =>
    start === end ? bounds[i]! <= start && start <= bounds[i + 1]! : start < bounds[i + 1]! && end > bounds[i]!));
  /** Where `at` in `current` lands in `target`; an insertion at `at` itself counts only for the end of a run. */
  const shift = (at: number, end: boolean): number => edits.reduce(
    (sum, edit) => (edit.end < at || (edit.end === at && (end || edit.start < at)) ? sum + edit.text.length - (edit.end - edit.start) : sum), at);
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
    if (text.trim() !== '') out.push(...blocksOf(markdownToState(text)));
    i = j;
  }
  return out;
}

export function landPush(live: Y.Doc, noteId: string, input: PushInput, origin: unknown, admit?: Admit): PushOutcome {
  const base = normalizeEol(input.base);
  const next = normalizeEol(input.newText);
  const current = exportDocMarkdown(live, noteId);
  const merge = computeMergedTarget(current, base, next);
  if (!input.force && isDegenerate(base, next, merge.deletedRatio)) return { ok: false, reason: 'degenerate', deletedRatio: merge.deletedRatio };
  if (merge.target === current) return { ok: true, applied: 0, failedHunks: merge.failedHunks, changed: false };
  const target = partsOf(merge.target);
  const state = markdownToState(target.body);
  const liveState = bodyState(live);
  const currentBody = partsOf(current).body;
  const blocks = keepUntouched(blocksOf(liveState), blocksOf(markdownToState(currentBody)), blocksOf(state))
    ?? spliceByBlock(liveState, currentBody, target.body);
  const root = { ...state.root, children: blocks } as unknown as SerializedEditorState['root'];
  const changed = reconcileBody(live, { ...state, root }, origin, admit, {
    mutate(doc) {
      // The properties stay as they are when the file's frontmatter block does not parse.
      if (target.fenced || !target.hasFrontmatter) importFrontmatter(doc, target.frontmatter, origin);
    },
    verify() {},
  });
  return { ok: true, applied: merge.applied, failedHunks: merge.failedHunks, changed };
}
