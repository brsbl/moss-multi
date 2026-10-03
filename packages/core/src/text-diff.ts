// Minimal text edit scripts in Yjs delta form, so `Y.Text.applyDelta` replays one directly (A§10.4). A whole-text
// replace would be a clobber: two people renaming at once would each delete the other's characters.

export type TextOp = { retain: number } | { insert: string } | { delete: number };

/** Cells in one LCS table: a 16 MB Uint32 table, well inside a 128 MB isolate. */
export const LCS_CELL_BUDGET = 4_000_000;

const isHigh = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLow = (code: number) => code >= 0xdc00 && code <= 0xdfff;

/**
 * An edit script that turns `current` into `target`, touching only what changed. The common prefix and suffix are
 * retained, and the middle is aligned by code points while its table fits LCS_CELL_BUDGET, then by lines, and past
 * that is one replace. Every tier is exact; only its granularity degrades. No op splits a surrogate pair.
 */
export function diffText(current: string, target: string): TextOp[] {
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
  const ops: TextOp[] = [];
  if (prefix > 0) ops.push({ retain: prefix });
  ops.push(...middle(a, b));
  return coalesce(ops);
}

function middle(a: string, b: string): TextOp[] {
  if (!a) return b ? [{ insert: b }] : [];
  if (!b) return [{ delete: a.length }];
  const chars = [Array.from(a), Array.from(b)];
  if ((chars[0].length + 1) * (chars[1].length + 1) <= LCS_CELL_BUDGET) return lcs(chars[0], chars[1]);
  const lines = [lineTokens(a), lineTokens(b)];
  if ((lines[0].length + 1) * (lines[1].length + 1) <= LCS_CELL_BUDGET) return lcs(lines[0], lines[1]);
  return [{ delete: a.length }, { insert: b }];
}

/** Each line with the newline that ends it, so the tokens join back to the text exactly. */
function lineTokens(text: string): string[] {
  const tokens = text.split('\n').map((line, i, all) => (i < all.length - 1 ? `${line}\n` : line));
  if (tokens.at(-1) === '') tokens.pop();
  return tokens;
}

/** The LCS alignment of two token lists, as ops sized in UTF-16 units. */
function lcs(a: string[], b: string[]): TextOp[] {
  const m = a.length;
  const n = b.length;
  const table = Array.from({ length: m + 1 }, () => new Uint32Array(n + 1));
  for (let i = m - 1; i >= 0; i -= 1) {
    const row = table[i];
    const below = table[i + 1];
    for (let j = n - 1; j >= 0; j -= 1) row[j] = a[i] === b[j] ? below[j + 1] + 1 : Math.max(below[j], row[j + 1]);
  }
  const ops: TextOp[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      ops.push({ retain: a[i].length });
      i += 1;
      j += 1;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      ops.push({ delete: a[i].length });
      i += 1;
    } else {
      ops.push({ insert: b[j] });
      j += 1;
    }
  }
  for (; i < m; i += 1) ops.push({ delete: a[i].length });
  for (; j < n; j += 1) ops.push({ insert: b[j] });
  return ops;
}

function coalesce(ops: TextOp[]): TextOp[] {
  const out: TextOp[] = [];
  for (const op of ops) {
    const last = out.at(-1);
    if (last && 'retain' in last && 'retain' in op) last.retain += op.retain;
    else if (last && 'delete' in last && 'delete' in op) last.delete += op.delete;
    else if (last && 'insert' in last && 'insert' in op) last.insert += op.insert;
    else out.push({ ...op });
  }
  // A trailing retain changes nothing.
  if (out.length > 0 && 'retain' in out[out.length - 1]) out.pop();
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
