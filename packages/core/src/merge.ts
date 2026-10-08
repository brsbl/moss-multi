// The pure half of a CLI push (A§17 step 2): a three-way merge of the `.md` file text. Exact when the doc still equals
// the base. Otherwise both sides are diffed against the base and their edits are combined on base positions: a
// pushed edit whose base region the doc also changed is returned as a failed hunk and the doc's text stays, so a
// push never consumes concurrent human work. Edits are grouped per line, so a rewrite of a sentence lands whole or not
// at all. The DocDO lands the target through the identity-preserving reconcile, so untouched blocks keep their items.
import { cleanupSemantic, DIFF_DELETE, DIFF_EQUAL, DIFF_INSERT, type Diff, makeDiff } from '@sanity/diff-match-patch';

/** The share of the base a push may delete before it is refused as degenerate without --force. */
export const DEGENERATE_DELETE_RATIO = 0.6;

/** LF line endings; every text entering the merge passes through this. */
export const normalizeEol = (text: string): string => text.replace(/\r\n?/g, '\n');

export interface MergeComputation {
  /** What the doc's file should become. */
  target: string;
  /** Pushed edits that were not applied because the doc changed the same region since the base. */
  failedHunks: string[];
  /** The share of the base's characters the push deletes. */
  deletedRatio: number;
  /** Whether the doc changed since the base was pulled. */
  drifted: boolean;
  /** Changed runs between the current text and the target. */
  applied: number;
}

/** One side's edit: base[start, end) becomes `text`. */
interface Edit {
  start: number;
  end: number;
  text: string;
}

const deleted = (diffs: Diff[]): number => diffs.reduce((sum, [op, text]) => sum + (op === DIFF_DELETE ? text.length : 0), 0);
const changes = (diffs: Diff[]): number => diffs.reduce((sum, [op]) => sum + (op === DIFF_EQUAL ? 0 : 1), 0);

/**
 * The edits turning `base` into `side`, those on one line separated only by unchanged text joined into one. The raw
 * diff is used: a semantic cleanup can fold the blank line between two edited paragraphs into one edit.
 */
function editsOf(base: string, side: string): Edit[] {
  const runs: { start: number; end: number; from: number; to: number }[] = [];
  let at = 0;
  let from = 0;
  for (const [op, text] of makeDiff(base, side)) {
    if (op !== DIFF_EQUAL) {
      const last = runs.at(-1);
      const run = last && last.end === at && last.to === from ? last : { start: at, end: at, from, to: from };
      if (run !== last) runs.push(run);
      if (op === DIFF_DELETE) run.end = at += text.length;
      if (op === DIFF_INSERT) run.to = from += text.length;
    } else {
      at += text.length;
      from += text.length;
    }
  }
  const joined: typeof runs = [];
  for (const run of runs) {
    const last = joined.at(-1);
    if (last && !base.slice(last.end, run.start).includes('\n')) Object.assign(last, { end: run.end, to: run.to });
    else joined.push({ ...run });
  }
  return joined.map(({ start, end, from: a, to: b }) => ({ start, end, text: side.slice(a, b) }));
}

/** Whether two edits touch the same base region; an insertion at the edge of another edit does not. */
function overlaps(a: Edit, b: Edit): boolean {
  if (a.start === a.end && b.start === b.end) return a.start === b.start;
  if (a.start === a.end) return b.start < a.start && a.start < b.end;
  if (b.start === b.end) return a.start < b.start && b.start < a.end;
  return a.start < b.end && b.start < a.end;
}

const lines = (prefix: string, text: string): string[] => (text === '' ? [] : text.split('\n').map((line) => `${prefix}${line}`));

function describeHunk(base: string, edit: Edit): string {
  const line = base.slice(0, edit.start).split('\n').length;
  return [`@@ line ${line} @@`, ...lines('-', base.slice(edit.start, edit.end)), ...lines('+', edit.text)].join('\n');
}

export function computeMergedTarget(current: string, base: string, next: string): MergeComputation {
  const drifted = current !== base;
  if (base === next) return { target: current, failedHunks: [], deletedRatio: 0, drifted, applied: 0 };
  const deletedRatio = deleted(cleanupSemantic(makeDiff(base, next))) / Math.max(base.length, 1);
  if (!drifted) return { target: next, failedHunks: [], deletedRatio, drifted, applied: changes(cleanupSemantic(makeDiff(current, next))) };
  const theirs = editsOf(base, current);
  const accepted: Edit[] = [];
  const failed: Edit[] = [];
  for (const edit of editsOf(base, next)) {
    // Made identically on both sides: already in the doc.
    if (theirs.some((other) => other.start === edit.start && other.end === edit.end && other.text === edit.text)) continue;
    (theirs.some((other) => overlaps(edit, other)) ? failed : accepted).push(edit);
  }
  const ordered = [...theirs, ...accepted].sort((a, b) => a.start - b.start || (a.end - a.start) - (b.end - b.start));
  let target = '';
  let at = 0;
  for (const edit of ordered) {
    target += base.slice(at, edit.start) + edit.text;
    at = edit.end;
  }
  target += base.slice(at);
  const applied = target === current ? 0 : changes(cleanupSemantic(makeDiff(current, target)));
  return { target, failedHunks: failed.map((edit) => describeHunk(base, edit)), deletedRatio, drifted, applied };
}

/** A push that empties the doc, or deletes more than DEGENERATE_DELETE_RATIO of its base, drifted or not. */
export function isDegenerate(base: string, next: string, deletedRatio: number): boolean {
  if (base === next) return false;
  return (next.trim() === '' && base.trim() !== '') || deletedRatio > DEGENERATE_DELETE_RATIO;
}
