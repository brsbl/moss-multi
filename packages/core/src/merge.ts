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

interface Run {
  start: number;
  end: number;
  from: number;
  to: number;
}

/** Changed runs of a character diff, positions offset into the whole texts. */
function charRuns(base: string, side: string, at: number, from: number, runs: Run[]): void {
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
}

const splitLines = (text: string): string[] => text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
const MAX_LINES = 0xd000; // one BMP code unit per distinct line, below the surrogates

/**
 * The edits turning `base` into `side`. Lines are diffed first, so an unchanged line always separates two edits and a
 * character diff never aligns one paragraph with another; changed lines are then diffed by character, and changes on
 * one line separated only by unchanged text are one edit.
 */
function editsOf(base: string, side: string): Edit[] {
  const runs: Run[] = [];
  const codes = new Map<string, string>();
  const encode = (text: string): string => splitLines(text).map((line) => {
    let code = codes.get(line);
    if (code === undefined) codes.set(line, (code = String.fromCharCode(codes.size + 1)));
    return code;
  }).join('');
  const baseCodes = encode(base);
  const sideCodes = encode(side);
  if (codes.size >= MAX_LINES) {
    charRuns(base, side, 0, 0, runs);
  } else {
    const lines = [...codes.keys()];
    const length = (codesOf: string): number => [...codesOf].reduce((sum, code) => sum + lines[code.charCodeAt(0) - 1]!.length, 0);
    let at = 0;
    let from = 0;
    let region: Run | null = null;
    const flush = (): void => {
      if (region) charRuns(base.slice(region.start, region.end), side.slice(region.from, region.to), region.start, region.from, runs);
      region = null;
    };
    for (const [op, text] of makeDiff(baseCodes, sideCodes, { checkLines: false })) {
      const size = length(text);
      if (op === DIFF_EQUAL) {
        flush();
        at += size;
        from += size;
        continue;
      }
      region ??= { start: at, end: at, from, to: from };
      if (op === DIFF_DELETE) region.end = at += size;
      if (op === DIFF_INSERT) region.to = from += size;
    }
    flush();
  }
  const joined: Run[] = [];
  for (const run of runs) {
    const last = joined.at(-1);
    if (last && !base.slice(last.end, run.start).includes('\n')) Object.assign(last, { end: run.end, to: run.to });
    else joined.push({ ...run });
  }
  return joined.map(({ start, end, from, to }) => ({ start, end, text: side.slice(from, to) }));
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

const finalEol = (text: string): string => text.slice(text.replace(/\n+$/, '').length);
const withoutFinalEol = (text: string): string => text.slice(0, text.length - finalEol(text).length);

/**
 * Final newlines are not content (an editor adds one on save; the export has none), so the three texts merge without
 * them and the target keeps `current`'s.
 */
export function computeMergedTarget(current: string, base: string, next: string): MergeComputation {
  const merge = mergeBodies(withoutFinalEol(current), withoutFinalEol(base), withoutFinalEol(next));
  return { ...merge, target: merge.target + finalEol(current) };
}

function mergeBodies(current: string, base: string, next: string): MergeComputation {
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
