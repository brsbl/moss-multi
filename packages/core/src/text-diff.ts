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
  // Ops are coalesced as they are appended: a large paste would otherwise build an op per code point, and
  // spreading that many into one call throws past the engine's argument limit.
  const ops: TextOp[] = [];
  if (prefix > 0) ops.push({ retain: prefix });
  middle(a, b, ops);
  // A trailing retain changes nothing.
  if (ops.length > 0 && 'retain' in ops[ops.length - 1]) ops.pop();
  return ops;
}

function middle(a: string, b: string, ops: TextOp[]): void {
  if (!a || !b) {
    if (a) append(ops, { delete: a.length });
    if (b) append(ops, { insert: b });
    return;
  }
  const chars = [Array.from(a), Array.from(b)];
  if ((chars[0].length + 1) * (chars[1].length + 1) <= LCS_CELL_BUDGET) return lcs(chars[0], chars[1], ops);
  const lines = [lineTokens(a), lineTokens(b)];
  if ((lines[0].length + 1) * (lines[1].length + 1) <= LCS_CELL_BUDGET) return lcs(lines[0], lines[1], ops);
  append(ops, { delete: a.length });
  append(ops, { insert: b });
}

/** Each line with the newline that ends it, so the tokens join back to the text exactly. */
function lineTokens(text: string): string[] {
  const tokens = text.split('\n').map((line, i, all) => (i < all.length - 1 ? `${line}\n` : line));
  if (tokens.at(-1) === '') tokens.pop();
  return tokens;
}

/** The LCS alignment of two token lists, appended to `ops` sized in UTF-16 units. */
function lcs(a: string[], b: string[], ops: TextOp[]): void {
  const m = a.length;
  const n = b.length;
  const table = Array.from({ length: m + 1 }, () => new Uint32Array(n + 1));
  for (let i = m - 1; i >= 0; i -= 1) {
    const row = table[i];
    const below = table[i + 1];
    for (let j = n - 1; j >= 0; j -= 1) row[j] = a[i] === b[j] ? below[j + 1] + 1 : Math.max(below[j], row[j + 1]);
  }
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      append(ops, { retain: a[i].length });
      i += 1;
      j += 1;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
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
