// A CLI push landed on the live doc (A§17 steps 2-5). The pushed file is merged three ways against its base and the
// doc's own `.md` export (glyphdown's computeMergedTarget), a degenerate push is refused unless forced, and the merged
// file lands in one serverWrite through the identity-preserving reconcile (T6.1): untouched blocks keep their Yjs
// items, so a peer typing in them, and the comment anchors on them, survive. `admit` checks the simulated result
// against the state cap and throws to refuse; the reconcile verifies its export, or throws ReconcileRefused.
import type { SerializedEditorState } from 'lexical';
import type * as Y from 'yjs';
import { splitFrontmatter } from '@moss-desktop/common/markdown-layers';
import { importFrontmatter } from '@moss-multi/core/frontmatter';
import { computeMergedTarget, isDegenerate, normalizeEol } from '@moss-multi/core/merge';
import { align, fullOf, type SerializedNode } from '@moss-multi/core/reconcile';
import { markdownToState } from './converter/index.ts';
import { bodyState, reconcileBody } from './reconcile.ts';
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
 * the target keeps the whole run in place.
 */
function keepUntouched(live: SerializedNode[], reimported: SerializedNode[], target: SerializedNode[]): SerializedNode[] {
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
      if (whole) swaps.set(start!, { end: start! + (ri - r), blocks: live.slice(l, li) });
    } else if (li > l) {
      // live[l, li) re-imports as nothing: restore it where its neighbours are still adjacent.
      const before = r === 0 ? -1 : kept.get(r - 1);
      const after = ri === reimported.length ? target.length : kept.get(ri);
      if (before !== undefined && after === before + 1) swaps.set(after, { end: after, blocks: live.slice(l, li) });
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

export function landPush(live: Y.Doc, noteId: string, input: PushInput, origin: unknown, admit?: Admit): PushOutcome {
  const base = normalizeEol(input.base);
  const next = normalizeEol(input.newText);
  const current = exportDocMarkdown(live, noteId);
  const merge = computeMergedTarget(current, base, next);
  if (!input.force && isDegenerate(base, next, merge.deletedRatio)) return { ok: false, reason: 'degenerate', deletedRatio: merge.deletedRatio };
  if (merge.target === current) return { ok: true, applied: 0, failedHunks: merge.failedHunks, changed: false };
  const target = partsOf(merge.target);
  const state = markdownToState(target.body);
  const blocks = keepUntouched(blocksOf(bodyState(live)), blocksOf(markdownToState(partsOf(current).body)), blocksOf(state));
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
