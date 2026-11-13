// Minimal text edit scripts in Yjs delta form, so `Y.Text.applyDelta` replays one directly (A§10.4). A whole-text
// replace would be a clobber: two people renaming at once would each delete the other's characters.

export type TextOp = { retain: number } | { insert: string } | { delete: number };

/** Cells in one LCS table: a 16 MB Uint32 table, well inside a 128 MB isolate. */
export const LCS_CELL_BUDGET = 4_000_000;

/**
 * The budget for server writes of caller-supplied text (a REST rename, the DocDO mirror): 256 × 256 cells keeps one
 * diff to a few milliseconds of CPU whatever the text, and a title of up to 255 characters still diffs by character.
 */
export const SERVER_CELL_BUDGET = 65_536;

const isHigh = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLow = (code: number) => code >= 0xdc00 && code <= 0xdfff;

/**
 * An edit script that turns `current` into `target`, touching only what changed. The common prefix and suffix are
 * retained, and the middle is aligned by code points while its table fits `budget` cells, then by lines, and past
 * that is one replace. Every tier is exact; only its granularity degrades. No op splits a surrogate pair.
 *
 * With `sparse`, a middle past the table first searches for a short edit script (Myers, work proportional to the
 * edits) by code point, then by word, each within `budget` steps: a long paragraph changed in a few places keeps
 * its unchanged text, where the line tier would replace a single-line paragraph whole.
 */
export function diffText(current: string, target: string, budget = LCS_CELL_BUDGET, sparse = false): TextOp[] {
  if (current === target) return [];
  const max = Math.min(current.length, target.length);
  let prefix = 0;
  while (prefix < max && current.charCodeAt(prefix) === target.charCodeAt(prefix)) prefix += 1;
  if (prefix > 0 && isHigh(current.charCodeAt(prefix - 1))) prefix -= 1;
  let suffix = 0;
  while (suffix < max - prefix && current.charCodeAt(current.length - 1 - suffix) === target.charCodeAt(target.length - 1 - suffix)) suffix += 1;
  if (suffix > 0 && isLow(current.charCodeAt(current.length - suffix))) suffix -= 1;
  const a = current.slice(prefix, current.length - suffix);
  const b = target.slice(prefix, target.length - suffix);
  // Ops are coalesced as they are appended: a large paste would otherwise build an op per code point, and
  // spreading that many into one call throws past the engine's argument limit.
  const ops: TextOp[] = [];
  if (prefix > 0) ops.push({ retain: prefix });
  middle(a, b, ops, budget, sparse);
  // A trailing retain changes nothing.
  if (ops.length > 0 && 'retain' in ops[ops.length - 1]) ops.pop();
  return ops;
}

function middle(a: string, b: string, ops: TextOp[], budget: number, sparse: boolean): void {
  if (!a || !b) {
    if (a) append(ops, { delete: a.length });
    if (b) append(ops, { insert: b });
    return;
  }
  // Sized before splitting, so a middle past the budget never allocates a token per character or line.
  if ((codePoints(a) + 1) * (codePoints(b) + 1) <= budget) return lcs(Array.from(a), Array.from(b), ops);
  if (sparse && a.length + b.length <= budget && myers(Array.from(a), Array.from(b), ops, budget)) return;
  if (sparse && words(a) + words(b) <= budget && myers(wordTokens(a), wordTokens(b), ops, budget)) return;
  if ((newlines(a) + 2) * (newlines(b) + 2) <= budget) return lcs(lineTokens(a), lineTokens(b), ops);
  append(ops, { delete: a.length });
  append(ops, { insert: b });
}

function codePoints(text: string): number {
  let n = text.length;
  for (let i = 1; i < text.length; i += 1) if (isLow(text.charCodeAt(i)) && isHigh(text.charCodeAt(i - 1))) n -= 1;
  return n;
}

const isSpace = (code: number) => code === 32 || (code >= 9 && code <= 13) || code === 0xa0 || code === 0x2028 || code === 0x2029 || code === 0x3000 || (code >= 0x2000 && code <= 0x200a);

/** Runs of space and of non-space: the word tokens, counted without allocating them. */
function words(text: string): number {
  let n = 0;
  for (let i = 0; i < text.length; i += 1) if (i === 0 || isSpace(text.charCodeAt(i)) !== isSpace(text.charCodeAt(i - 1))) n += 1;
  return n;
}

/** Runs of space and of non-space, which join back to the text exactly; a surrogate pair is never space. */
function wordTokens(text: string): string[] {
  const tokens: string[] = [];
  let start = 0;
  for (let i = 1; i <= text.length; i += 1) {
    if (i === text.length || isSpace(text.charCodeAt(i)) !== isSpace(text.charCodeAt(i - 1))) {
      tokens.push(text.slice(start, i));
      start = i;
    }
  }
  return tokens;
}

function newlines(text: string): number {
  let n = 0;
  for (let at = text.indexOf('\n'); at !== -1; at = text.indexOf('\n', at + 1)) n += 1;
  return n;
}

/** Each line with the newline that ends it, so the tokens join back to the text exactly. */
function lineTokens(text: string): string[] {
  const tokens = text.split('\n').map((line, i, all) => (i < all.length - 1 ? `${line}\n` : line));
  if (tokens.at(-1) === '') tokens.pop();
  return tokens;
}

/** Tokens as integers, so comparing two costs one integer comparison however long they are. */
function interned(a: string[], b: string[]): [Int32Array, Int32Array] {
  const ids = new Map<string, number>();
  const intern = (tokens: string[]) =>
    Int32Array.from(tokens, (token) => {
      let id = ids.get(token);
      if (id === undefined) ids.set(token, (id = ids.size));
      return id;
    });
  return [intern(a), intern(b)];
}

/**
 * Myers' greedy shortest edit script of two token lists, appended to `ops` and true, or false with `ops` untouched
 * once the search passes `budget` steps (a diagonal visited or a token matched). Work and memory grow with the
 * number of edits, not the product of the lengths.
 */
function myers(a: string[], b: string[], ops: TextOp[], budget: number): boolean {
  const [x, y] = interned(a, b);
  const n = x.length;
  const m = y.length;
  const offset = n + m + 1;
  // v[offset + k] is the furthest x reached on diagonal k = x - y; trace[d] keeps diagonals -d..d after round d.
  const v = new Int32Array(2 * offset + 1);
  const trace: Int32Array[] = [];
  let work = 0;
  let found = -1;
  for (let d = 0; d <= n + m && found < 0; d += 1) {
    for (let k = -d; k <= d; k += 2) {
      let px = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? v[offset + k + 1] : v[offset + k - 1] + 1;
      let py = px - k;
      while (px < n && py < m && x[px] === y[py]) {
        px += 1;
        py += 1;
        work += 1;
      }
      v[offset + k] = px;
      work += 1;
      if (work > budget) return false;
      if (px >= n && py >= m) {
        found = d;
        break;
      }
    }
    trace.push(v.slice(offset - d, offset + d + 1));
  }
  // Walk back from the end; steps are 0 kept, 1 deleted from a, 2 inserted from b, each with its token index.
  const steps: number[] = [];
  let i = n;
  let j = m;
  for (let d = found; d > 0; d -= 1) {
    const prev = trace[d - 1];
    const at = (k: number) => prev[k + d - 1];
    const k = i - j;
    const down = k === -d || (k !== d && at(k - 1) < at(k + 1));
    const pk = down ? k + 1 : k - 1;
    const pi = at(pk);
    const pj = pi - pk;
    const start = down ? pi : pi + 1;
    while (i > start) {
      i -= 1;
      j -= 1;
      steps.push(0, i);
    }
    if (down) steps.push(2, j - 1);
    else steps.push(1, i - 1);
    i = pi;
    j = pj;
  }
  while (i > 0) {
    i -= 1;
    steps.push(0, i);
  }
  for (let s = steps.length - 2; s >= 0; s -= 2) {
    const token = steps[s + 1];
    if (steps[s] === 0) append(ops, { retain: a[token].length });
    else if (steps[s] === 1) append(ops, { delete: a[token].length });
    else append(ops, { insert: b[token] });
  }
  return true;
}

/**
 * The LCS alignment of two token lists, appended to `ops` sized in UTF-16 units. Tokens are interned to integers
 * first, so a cell costs one integer comparison however long its lines are.
 */
function lcs(a: string[], b: string[], ops: TextOp[]): void {
  const [x, y] = interned(a, b);
  const m = x.length;
  const n = y.length;
  const width = n + 1;
  // table[i * width + j] is the LCS length of a[i..] and b[j..].
  const table = new Uint32Array((m + 1) * width);
  for (let i = m - 1; i >= 0; i -= 1) {
    const row = i * width;
    const below = row + width;
    for (let j = n - 1; j >= 0; j -= 1) {
      table[row + j] = x[i] === y[j] ? table[below + j + 1] + 1 : Math.max(table[below + j], table[row + j + 1]);
    }
  }
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (x[i] === y[j]) {
      append(ops, { retain: a[i].length });
      i += 1;
      j += 1;
    } else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) {
      append(ops, { delete: a[i].length });
      i += 1;
    } else {
      append(ops, { insert: b[j] });
      j += 1;
    }
  }
  if (i < m) append(ops, { delete: a.slice(i).reduce((sum, token) => sum + token.length, 0) });
  if (j < n) append(ops, { insert: b.slice(j).join('') });
}

/** Appends `op`, merged into the last op when they are the same kind. */
function append(ops: TextOp[], op: TextOp): void {
  const last = ops[ops.length - 1];
  if (last && 'retain' in last && 'retain' in op) last.retain += op.retain;
  else if (last && 'delete' in last && 'delete' in op) last.delete += op.delete;
  else if (last && 'insert' in last && 'insert' in op) last.insert += op.insert;
  else ops.push({ ...op });
}

/**
 * The one edit a field's input made, read with the caret after it: everything after the caret is unchanged, so typing
 * inside a run of equal characters lands where it was typed ("a|a" plus "a" is an insert at 1, not at the end).
 */
export function diffAtCaret(before: string, after: string, caret: number): TextOp[] {
  if (before === after) return [];
  const max = Math.min(before.length, after.length);
  let suffix = 0;
  const suffixMax = Math.min(max, Math.max(0, after.length - caret));
  while (suffix < suffixMax && before.charCodeAt(before.length - 1 - suffix) === after.charCodeAt(after.length - 1 - suffix)) suffix += 1;
  if (suffix > 0 && isLow(after.charCodeAt(after.length - suffix))) suffix -= 1;
  let prefix = 0;
  while (prefix < max - suffix && before.charCodeAt(prefix) === after.charCodeAt(prefix)) prefix += 1;
  if (prefix > 0 && isHigh(after.charCodeAt(prefix - 1))) prefix -= 1;
  const ops: TextOp[] = [];
  if (prefix > 0) ops.push({ retain: prefix });
  if (before.length - prefix - suffix > 0) ops.push({ delete: before.length - prefix - suffix });
  if (after.length - prefix - suffix > 0) ops.push({ insert: after.slice(prefix, after.length - suffix) });
  return ops;
}

/** A change in Yjs delta form; an embed counts one. */
export type Delta = readonly { retain?: number; insert?: unknown; delete?: number }[];

/**
 * Where an offset belongs after `delta`, read from the change itself: a diff of the two texts cannot tell "aa" -> "aaa"
 * at the start from the same edit at the end. Text inserted before it moves it right, text deleted before it moves it
 * left (a cut spanning it leaves it at the cut), and an insert exactly at it leaves it in front, or behind with `behind`.
 */
export function mapOffset(offset: number, delta: Delta, behind = false): number {
  let at = 0;
  let shift = 0;
  for (const op of delta) {
    if (behind ? at > offset : at >= offset) break;
    if (op.retain !== undefined) at += op.retain;
    else if (op.insert !== undefined) shift += typeof op.insert === 'string' ? op.insert.length : 1;
    else if (op.delete !== undefined) {
      shift -= Math.min(op.delete, offset - at);
      at += op.delete;
    }
  }
  return Math.max(0, offset + shift);
}

/**
 * `ops`, an edit of `before`, rebased onto `current` (which a peer's edits moved on from `before`): the edit deletes
 * only the characters of `before` it removed that are still in `current`, and inserts where its range now starts, so it
 * removes only what its author saw and a peer's text, even inside the range, is kept.
 */
export function rebaseOps(before: string, ops: readonly TextOp[], current: string): TextOp[] {
  if (before === current) return ops.slice();
  const edits: { at: number; remove: number; insert: string }[] = [];
  let at = 0;
  for (const op of ops) {
    if ('retain' in op) at += op.retain;
    else {
      const last = edits.at(-1);
      const open = last && last.at + last.remove === at && (last.insert === '' || 'insert' in op);
      const edit = open ? last : { at, remove: 0, insert: '' };
      if (!open) edits.push(edit);
      if ('delete' in op) { edit.remove += op.delete; at += op.delete; } else edit.insert += op.insert;
    }
  }
  const moved = diffText(before, current);
  // Where each unit of `before` is in `current`, or -1 where the peer deleted it.
  const where = new Int32Array(before.length);
  let from = 0;
  let to = 0;
  for (const op of moved) {
    if ('retain' in op) for (let k = 0; k < op.retain; k += 1) where[from++] = to++;
    else if ('delete' in op) for (let k = 0; k < op.delete; k += 1) where[from++] = -1;
    else to += op.insert.length;
  }
  while (from < before.length) where[from++] = to++;
  const out: TextOp[] = [];
  let cursor = 0;
  for (const edit of edits) {
    // The insert goes behind a peer's insert at the start of a replaced range, never inside the peer's text.
    const start = Math.max(cursor, mapOffset(edit.at, moved, edit.remove > 0));
    if (start > cursor) append(out, { retain: start - cursor });
    cursor = start;
    if (edit.insert) append(out, { insert: edit.insert });
    for (let i = edit.at; i < edit.at + edit.remove; i += 1) {
      const p = where[i];
      if (p < cursor) continue;
      if (p > cursor) append(out, { retain: p - cursor });
      append(out, { delete: 1 });
      cursor = p + 1;
    }
  }
  return out;
}

/** `ops` applied to `current`. */
export function applyOps(current: string, ops: readonly TextOp[]): string {
  let out = '';
  let at = 0;
  for (const op of ops) {
    if ('retain' in op) {
      out += current.slice(at, at + op.retain);
      at += op.retain;
    } else if ('insert' in op) {
      out += op.insert;
    } else {
      at += op.delete;
    }
  }
  return out + current.slice(at);
}
