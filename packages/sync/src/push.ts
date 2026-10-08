// A CLI push landed on the live doc (A§17 steps 2-5). The pushed file is merged three ways against its base and the
// doc's own `.md` export (glyphdown's computeMergedTarget), a degenerate push is refused unless forced, and the merged
// file lands in one serverWrite through the identity-preserving reconcile (T6.1): untouched blocks keep their Yjs
// items, so a peer typing in them, and the comment anchors on them, survive. `admit` checks the simulated result
// against the state cap and throws to refuse; the reconcile verifies its export, or throws ReconcileRefused.
import type * as Y from 'yjs';
import { splitFrontmatter } from '@moss-desktop/common/markdown-layers';
import { importFrontmatter } from '@moss-multi/core/frontmatter';
import { computeMergedTarget, isDegenerate, normalizeEol } from '@moss-multi/core/merge';
import { markdownToState } from './converter/index.ts';
import { reconcileBody } from './reconcile.ts';
import { exportDocMarkdown, type Admit } from './server-doc.ts';

export interface PushInput {
  base: string;
  newText: string;
  force: boolean;
}

export type PushOutcome =
  | { ok: true; applied: number; failedHunks: string[]; changed: boolean }
  | { ok: false; reason: 'degenerate'; deletedRatio: number };

export function landPush(live: Y.Doc, noteId: string, input: PushInput, origin: unknown, admit?: Admit): PushOutcome {
  const base = normalizeEol(input.base);
  const next = normalizeEol(input.newText);
  const current = exportDocMarkdown(live, noteId);
  const merge = computeMergedTarget(current, base, next);
  if (!input.force && isDegenerate(base, next, merge.deletedRatio)) return { ok: false, reason: 'degenerate', deletedRatio: merge.deletedRatio };
  if (merge.target === current) return { ok: true, applied: 0, failedHunks: merge.failedHunks, changed: false };
  const parts = splitFrontmatter(merge.target);
  // A block that does not parse as frontmatter stays body text, as on import, and the properties stay as they are.
  const fenced = parts.hasFrontmatter && !parts.error;
  const frontmatter = fenced ? merge.target.slice(0, merge.target.length - parts.body.length) : '';
  const changed = reconcileBody(live, markdownToState(fenced ? parts.body : merge.target), origin, admit, {
    mutate(doc) {
      if (fenced || !parts.hasFrontmatter) importFrontmatter(doc, frontmatter, origin);
    },
    verify() {},
  });
  return { ok: true, applied: merge.applied, failedHunks: merge.failedHunks, changed };
}
