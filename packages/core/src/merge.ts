// The pure half of a CLI push (A§17 step 2): glyphdown's three-way computeMergedTarget over the `.md` file text
// (glyphdown packages/core/src/merge.ts). Exact when the doc still equals the base; otherwise the base→new patches are
// placed on the current text, and a hunk that cannot be placed is returned, never dropped silently. The DocDO then
// lands the target through the identity-preserving reconcile, so what the text merge does not touch keeps its items.
import { applyPatches, cleanupSemantic, DIFF_DELETE, DIFF_EQUAL, type Diff, makeDiff, makePatches, stringifyPatch } from '@sanity/diff-match-patch';

/** The share of the base a push may delete before it is refused as degenerate without --force. */
export const DEGENERATE_DELETE_RATIO = 0.6;

/** LF line endings; every text entering the merge passes through this. */
export const normalizeEol = (text: string): string => text.replace(/\r\n?/g, '\n');

export interface MergeComputation {
  /** What the doc's file should become. */
  target: string;
  /** Patches that could not be placed on the current text. */
  failedHunks: string[];
  /** The share of the base's characters the push deletes. */
  deletedRatio: number;
  /** Whether the doc changed since the base was pulled. */
  drifted: boolean;
  /** Changed runs between the current text and the target. */
  applied: number;
}

const deleted = (diffs: Diff[]): number => diffs.reduce((sum, [op, text]) => sum + (op === DIFF_DELETE ? text.length : 0), 0);
const changes = (diffs: Diff[]): number => diffs.reduce((sum, [op]) => sum + (op === DIFF_EQUAL ? 0 : 1), 0);

export function computeMergedTarget(current: string, base: string, next: string): MergeComputation {
  const drifted = current !== base;
  if (base === next) return { target: current, failedHunks: [], deletedRatio: 0, drifted, applied: 0 };
  const diffs = cleanupSemantic(makeDiff(base, next));
  const deletedRatio = deleted(diffs) / Math.max(base.length, 1);
  let target = next;
  let failedHunks: string[] = [];
  if (drifted) {
    const patches = makePatches(diffs);
    const [merged, results] = applyPatches(patches, current);
    target = merged;
    failedHunks = patches.filter((_, i) => !results[i]).map((patch) => stringifyPatch(patch));
  }
  const applied = target === current ? 0 : changes(cleanupSemantic(makeDiff(current, target)));
  return { target, failedHunks, deletedRatio, drifted, applied };
}

/** A push that empties the doc, or deletes more than DEGENERATE_DELETE_RATIO of its base, drifted or not. */
export function isDegenerate(base: string, next: string, deletedRatio: number): boolean {
  if (base === next) return false;
  return (next.trim() === '' && base.trim() !== '') || deletedRatio > DEGENERATE_DELETE_RATIO;
}
