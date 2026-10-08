// The pure half of a CLI push (A§17 step 2): a three-way merge of the `.md` file text. Exact when the doc still equals
// the base. Otherwise both sides are diffed against the base and their edits are combined on base positions: a
// pushed edit whose base region the doc also changed is returned as a failed hunk and the doc's text stays, so a
// push never consumes concurrent human work. Edits are grouped per line, so a rewrite of a sentence lands whole or not
// at all. The DocDO lands the target through the identity-preserving reconcile, so untouched blocks keep their items.

/** The share of the base a push may delete before it is refused as degenerate without --force. */
export const DEGENERATE_DELETE_RATIO = 0.6;

// Pushed text is up to 2 MB: every scan over it below is linear (or n log n), with no backtracking regex, except the
// diff searches. Those are counted in steps, never read from a clock: on deployed Workers the clock does not move during
// synchronous code, so a deadline would never fire.

/** The search one push's merge may do, in steps (a diagonal searched or a token matched): under 100 ms of CPU. */
export const MERGE_WORK = 8_000_000;
/** One diff's search stops past this many steps (its trace stays under 8 MB) and replaces its whole span instead. */
export const DIFF_WORK = 2_000_000;
/** Nor may a character diff pass this many steps per character compared: that dense a change is a rewrite, replaced whole. */
export const DENSE_WORK = 32;

/** The steps a push's merge has left; every diff draws on it, so changed regions cannot each restart a limit. */
export interface MergeBudget {
  work: number;
}

export const mergeBudget = (work = MERGE_WORK): MergeBudget => ({ work });

/** The merge ran out of budget before it finished; nothing of it may land. */
export class MergeBudgetExceeded extends Error {
  constructor() {
    super('the merge ran out of budget');
  }
}

/**
 * Charges `steps`. A strict diff (of a drifted doc, whose edits must be exact) throws once the budget is spent; a
 * lenient one goes on with nothing left to search, so each later diff replaces its whole span.
 */
function charge(budget: MergeBudget, steps: number, strict: boolean): void {
  if (steps > budget.work && strict) throw new MergeBudgetExceeded();
  budget.work = Math.max(0, budget.work - steps);
}

/** LF line endings; every text entering the merge passes through this. */
export const normalizeEol = (text: string): string => text.split('\r\n').join('\n').split('\r').join('\n');

export interface MergeComputation {
  /** What the doc's file should become. */
  target: string;
  /** Pushed edits that were not applied because the doc changed the same region since the base. */
  failedHunks: string[];
  /** The share of the base's characters the push deletes. */
  deletedRatio: number;
  /** Whether the doc changed since the base was pulled. */
  drifted: boolean;
  /** Pushed edits applied to the current text. */
  applied: number;
  /** Refused as degenerate (only with refuseDegenerate): the regions were not merged and `target` is the current text. */
  degenerate: boolean;
}

export interface MergeOptions {
  /** Refuse a degenerate push before merging its regions (a push without --force). */
  refuseDegenerate?: boolean;
  budget?: MergeBudget;
}

/** One side's edit: base[start, end) becomes `text`. */
export interface Edit {
  start: number;
  end: number;
  text: string;
}

/** A changed run: a[start, end) became b[from, to), in tokens or in UTF-16 units. */
interface Run {
  start: number;
  end: number;
  from: number;
  to: number;
}

/**
 * Myers' shortest edit script of a[aFrom, aTo) and b[bFrom, bTo), appended to `out` as changed runs of token indexes,
 * or false once it passes `cap` steps (a diagonal searched or a token matched). `spent.steps` is what it took. Round d
 * keeps its d + 1 diagonals and costs at least d + 1 steps, so the trace never holds more than `cap` integers.
 */
function myers(a: Int32Array, aFrom: number, aTo: number, b: Int32Array, bFrom: number, bTo: number, cap: number, out: Run[], spent: { steps: number }): boolean {
  const n = aTo - aFrom;
  const m = bTo - bFrom;
  const reach = Math.min(n + m, Math.ceil(Math.sqrt(2 * cap)) + 1) + 1;
  const v = new Int32Array(2 * reach + 1);
  const trace: Int32Array[] = [];
  let steps = 0;
  let found = -1;
  for (let d = 0; found < 0; d++) {
    const row = new Int32Array(d + 1);
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[reach + k - 1]! < v[reach + k + 1]!) ? v[reach + k + 1]! : v[reach + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[aFrom + x] === b[bFrom + y]) {
        x++;
        y++;
        steps++;
      }
      v[reach + k] = x;
      row[(k + d) >> 1] = x;
      if (++steps > cap) {
        spent.steps = steps;
        return false;
      }
      if (x >= n && y >= m) {
        found = d;
        break;
      }
    }
    trace.push(row);
  }
  spent.steps = steps;
  // Walk back from the end; each round is one move from (x, y): 1 inserts b[y], 0 deletes a[x]. Kept last to first.
  const moves: number[] = [];
  let x = n;
  let y = m;
  for (let d = found; d > 0; d--) {
    const prev = trace[d - 1]!;
    const at = (k: number): number => prev[(k + d - 1) >> 1]!;
    const k = x - y;
    const down = k === -d || (k !== d && at(k - 1) < at(k + 1));
    const pk = down ? k + 1 : k - 1;
    x = at(pk);
    y = x - pk;
    moves.push(down ? 1 : 0, x, y);
  }
  for (let i = moves.length - 3; i >= 0; i -= 3) {
    const mx = aFrom + moves[i + 1]!;
    const my = bFrom + moves[i + 2]!;
    const last = out.at(-1);
    const run = last && last.end === mx && last.to === my ? last : { start: mx, end: mx, from: my, to: my };
    if (run !== last) out.push(run);
    if (moves[i] === 1) run.to++;
    else run.end++;
  }
  return true;
}

/**
 * The gaps of a[aFrom, aTo) and b[bFrom, bTo) between the longest chain of tokens that occur once on each side and
 * keep their order (patience diff), as flat [aStart, aEnd, bStart, bEnd] quadruples trimmed of their equal ends.
 */
function patience(a: Int32Array, aFrom: number, aTo: number, b: Int32Array, bFrom: number, bTo: number): number[] {
  const inA = new Map<number, number>(); // a token's index in a when it occurs there once, else -1
  for (let i = aFrom; i < aTo; i++) inA.set(a[i]!, inA.has(a[i]!) ? -1 : i);
  const inB = new Map<number, number>();
  for (let j = bFrom; j < bTo; j++) if ((inA.get(b[j]!) ?? -1) >= 0) inB.set(b[j]!, inB.has(b[j]!) ? -1 : j);
  const pairs: number[] = []; // [i, j] flat, in a's order
  for (let i = aFrom; i < aTo; i++) {
    const j = inB.get(a[i]!) ?? -1;
    if (j >= 0 && inA.get(a[i]!) === i) pairs.push(i, j);
  }
  // The longest chain of pairs increasing in b, by patience sorting: O(p log p).
  const count = pairs.length / 2;
  const tails: number[] = [];
  const back = new Int32Array(count).fill(-1);
  for (let p = 0; p < count; p++) {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (pairs[2 * tails[mid]! + 1]! < pairs[2 * p + 1]!) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) back[p] = tails[lo - 1]!;
    tails[lo] = p;
  }
  const chain: number[] = [];
  for (let p = tails.at(-1) ?? -1; p >= 0; p = back[p]!) chain.push(p);
  const gaps: number[] = [];
  let i = aFrom;
  let j = bFrom;
  for (let c = chain.length - 1; c >= -1; c--) {
    const ai = c >= 0 ? pairs[2 * chain[c]!]! : aTo;
    const bj = c >= 0 ? pairs[2 * chain[c]! + 1]! : bTo;
    let s = i;
    let f = j;
    let e = ai;
    let t = bj;
    while (s < e && f < t && a[s] === b[f]) {
      s++;
      f++;
    }
    while (e > s && t > f && a[e - 1] === b[t - 1]) {
      e--;
      t--;
    }
    gaps.push(s, e, f, t);
    i = ai + 1;
    j = bj + 1;
  }
  return gaps;
}

/**
 * The changed runs between token lists `a` and `b`. With `anchors` (lines), patience gaps come first, so scattered
 * edits cost only their own gaps. A gap whose search passes DIFF_WORK (or, by character, DENSE_WORK) is replaced
 * whole; a strict diff throws once the push's budget is spent.
 */
function tokenRuns(a: Int32Array, b: Int32Array, anchors: boolean, budget: MergeBudget, strict: boolean): Run[] {
  let aFrom = 0;
  let bFrom = 0;
  let aTo = a.length;
  let bTo = b.length;
  while (aFrom < aTo && bFrom < bTo && a[aFrom] === b[bFrom]) {
    aFrom++;
    bFrom++;
  }
  while (aTo > aFrom && bTo > bFrom && a[aTo - 1] === b[bTo - 1]) {
    aTo--;
    bTo--;
  }
  const gaps = anchors && aFrom < aTo && bFrom < bTo ? patience(a, aFrom, aTo, b, bFrom, bTo) : [aFrom, aTo, bFrom, bTo];
  const out: Run[] = [];
  const spent = { steps: 0 };
  for (let g = 0; g < gaps.length; g += 4) {
    const s = gaps[g]!;
    const e = gaps[g + 1]!;
    const f = gaps[g + 2]!;
    const t = gaps[g + 3]!;
    if (s === e && f === t) continue;
    spent.steps = 0;
    const found = s < e && f < t && myers(a, s, e, b, f, t, Math.min(budget.work, DIFF_WORK, anchors ? DIFF_WORK : DENSE_WORK * (e - s + t - f)), out, spent);
    charge(budget, spent.steps, strict);
    if (!found) out.push({ start: s, end: e, from: f, to: t });
  }
  return out;
}

/** Each line with its newline; a last line without one stays as it is. */
function splitLines(text: string): string[] {
  const out: string[] = [];
  let from = 0;
  for (let at = text.indexOf('\n'); at >= 0; at = text.indexOf('\n', from)) {
    out.push(text.slice(from, at + 1));
    from = at + 1;
  }
  if (from < text.length) out.push(text.slice(from));
  return out;
}

/** text[from, to) as code points, so no run splits a surrogate pair. */
function codePoints(text: string, from: number, to: number): Int32Array {
  const out = new Int32Array(to - from);
  let n = 0;
  for (let at = from; at < to; n++) {
    const code = text.codePointAt(at)!;
    out[n] = code;
    at += code > 0xffff ? 2 : 1;
  }
  return out.subarray(0, n);
}

/** Token runs as UTF-16 runs offset by `at` and `from`, appended to `out`; the runs are in order, so one walk sizes them. */
function unitRuns(runs: Run[], sizeA: (i: number) => number, sizeB: (j: number) => number, at: number, from: number, out: Run[]): void {
  let i = 0;
  let j = 0;
  for (const run of runs) {
    for (; i < run.start; i++) at += sizeA(i);
    for (; j < run.from; j++) from += sizeB(j);
    const start = at;
    const was = from;
    for (; i < run.end; i++) at += sizeA(i);
    for (; j < run.to; j++) from += sizeB(j);
    out.push({ start, end: at, from: was, to: from });
  }
}

const unitSize = (codes: Int32Array) => (i: number): number => (codes[i]! > 0xffff ? 2 : 1);

/**
 * The edits turning `base` into `side`, and the base characters they delete. Lines are diffed first, so an unchanged
 * line always separates two edits and a character diff never aligns one paragraph with another; changed lines are
 * then diffed by character, and changes on one line separated only by unchanged text are one edit.
 */
function sideEdits(base: string, side: string, budget: MergeBudget, strict: boolean): { edits: Edit[]; deleted: number } {
  const ids = new Map<string, number>();
  const sizes: number[] = [];
  const encode = (text: string): Int32Array => Int32Array.from(splitLines(text), (line) => {
    let id = ids.get(line);
    if (id === undefined) {
      ids.set(line, (id = ids.size));
      sizes.push(line.length);
    }
    return id;
  });
  const baseLines = encode(base);
  const sideLines = encode(side);
  const regions: Run[] = [];
  unitRuns(tokenRuns(baseLines, sideLines, true, budget, strict), (i) => sizes[baseLines[i]!]!, (j) => sizes[sideLines[j]!]!, 0, 0, regions);
  const runs: Run[] = [];
  for (const region of regions) {
    const a = codePoints(base, region.start, region.end);
    const b = codePoints(side, region.from, region.to);
    unitRuns(tokenRuns(a, b, false, budget, strict), unitSize(a), unitSize(b), region.start, region.from, runs);
  }
  let deleted = 0;
  let newline = -1; // the first newline at or after the last joined run's end, or base.length
  const joined: Run[] = [];
  for (const run of runs) {
    deleted += run.end - run.start;
    const last = joined.at(-1);
    if (last && newline < last.end) {
      newline = base.indexOf('\n', last.end);
      if (newline < 0) newline = base.length;
    }
    if (last && newline >= run.start) Object.assign(last, { end: run.end, to: run.to });
    else joined.push({ ...run });
  }
  return { edits: joined.map(({ start, end, from, to }) => ({ start, end, text: side.slice(from, to) })), deleted };
}

/**
 * The edits turning `base` into `side` (see sideEdits), drawing on `budget`. A strict diff throws MergeBudgetExceeded
 * once the budget is spent; a lenient one returns coarser edits instead.
 */
export function editsOf(base: string, side: string, budget: MergeBudget = mergeBudget(), strict = true): Edit[] {
  return sideEdits(base, side, budget, strict).edits;
}

/** Whether two edits touch the same base region; an insertion at the edge of another edit does not. */
function overlaps(a: Edit, b: Edit): boolean {
  if (a.start === a.end && b.start === b.end) return a.start === b.start;
  if (a.start === a.end) return b.start < a.start && a.start < b.end;
  if (b.start === b.end) return a.start < b.start && b.start < a.end;
  return a.start < b.end && b.start < a.end;
}

const lines = (prefix: string, text: string): string[] => (text === '' ? [] : text.split('\n').map((line) => `${prefix}${line}`));

/** Each failed edit (in base order) as a hunk naming its 1-based base line, counted in one pass. */
function describeHunks(base: string, edits: Edit[]): string[] {
  let line = 1;
  let at = 0;
  return edits.map((edit) => {
    for (let next = base.indexOf('\n', at); next >= 0 && next < edit.start; next = base.indexOf('\n', at)) {
      line++;
      at = next + 1;
    }
    return [`@@ line ${line} @@`, ...lines('-', base.slice(edit.start, edit.end)), ...lines('+', edit.text)].join('\n');
  });
}

function bodyEnd(text: string): number {
  let end = text.length;
  while (end > 0 && text.charCodeAt(end - 1) === 10) end--;
  return end;
}
const finalEol = (text: string): string => text.slice(bodyEnd(text));
export const withoutFinalEol = (text: string): string => text.slice(0, bodyEnd(text));

/**
 * Final newlines are not content (an editor adds one on save; the export has none), so the three texts merge without
 * them and the target keeps `current`'s. With refuseDegenerate, a degenerate push is refused before the doc's own edits
 * are diffed. Every diff draws on one budget; a drifted merge throws MergeBudgetExceeded once it is spent.
 */
export function computeMergedTarget(current: string, base: string, next: string, options: MergeOptions = {}): MergeComputation {
  const merge = mergeBodies(withoutFinalEol(current), withoutFinalEol(base), withoutFinalEol(next), options.refuseDegenerate === true, options.budget ?? mergeBudget());
  return { ...merge, target: merge.target + finalEol(current) };
}

function mergeBodies(current: string, base: string, next: string, refuseDegenerate: boolean, budget: MergeBudget): MergeComputation {
  const drifted = current !== base;
  const unchanged = { failedHunks: [], drifted, applied: 0, degenerate: false };
  if (base === next) return { ...unchanged, target: current, deletedRatio: 0 };
  // An undrifted push lands `next` whatever its edits are, so only a drifted merge needs them exact.
  const pushed = sideEdits(base, next, budget, drifted);
  const deletedRatio = pushed.deleted / Math.max(base.length, 1);
  if (refuseDegenerate && isDegenerate(base, next, deletedRatio)) return { ...unchanged, target: current, deletedRatio, degenerate: true };
  if (!drifted) return { ...unchanged, target: next, deletedRatio, applied: pushed.edits.length };
  const theirs = editsOf(base, current, budget, true);
  const accepted: Edit[] = [];
  const failed: Edit[] = [];
  // Both lists are in base order and each is disjoint, so one sweep finds every edit of theirs a pushed edit touches.
  let first = 0;
  for (const edit of pushed.edits) {
    while (first < theirs.length && theirs[first]!.end < edit.start) first++;
    let same = false;
    let clash = false;
    for (let k = first; k < theirs.length && theirs[k]!.start <= edit.end; k++) {
      const other = theirs[k]!;
      if (other.start === edit.start && other.end === edit.end && other.text === edit.text) same = true;
      else if (overlaps(edit, other)) clash = true;
    }
    // Made identically on both sides: already in the doc.
    if (!same) (clash ? failed : accepted).push(edit);
  }
  const ordered = [...theirs, ...accepted].sort((a, b) => a.start - b.start || (a.end - a.start) - (b.end - b.start));
  let target = '';
  let at = 0;
  for (const edit of ordered) {
    target += base.slice(at, edit.start) + edit.text;
    at = edit.end;
  }
  target += base.slice(at);
  return { target, failedHunks: describeHunks(base, failed), deletedRatio, drifted, applied: accepted.length, degenerate: false };
}

/** A push that empties the doc, or deletes more than DEGENERATE_DELETE_RATIO of its base, drifted or not. */
export function isDegenerate(base: string, next: string, deletedRatio: number): boolean {
  if (base === next) return false;
  return (next.trim() === '' && base.trim() !== '') || deletedRatio > DEGENERATE_DELETE_RATIO;
}
