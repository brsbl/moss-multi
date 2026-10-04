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
 */
export function diffText(current: string, target: string, budget = LCS_CELL_BUDGET): TextOp[] {
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
  middle(a, b, ops, budget);
  // A trailing retain changes nothing.
  if (ops.length > 0 && 'retain' in ops[ops.length - 1]) ops.pop();
  return ops;
}

function middle(a: string, b: string, ops: TextOp[], budget: number): void {
  if (!a || !b) {
    if (a) append(ops, { delete: a.length });
    if (b) append(ops, { insert: b });
    return;
  }
  // Sized before splitting, so a middle past the budget never allocates a token per character or line.
  if ((codePoints(a) + 1) * (codePoints(b) + 1) <= budget) return lcs(Array.from(a), Array.from(b), ops);
  if ((newlines(a) + 2) * (newlines(b) + 2) <= budget) return lcs(lineTokens(a), lineTokens(b), ops);
  append(ops, { delete: a.length });
  append(ops, { insert: b });
}

function codePoints(text: string): number {
  let n = text.length;
  for (let i = 1; i < text.length; i += 1) if (isLow(text.charCodeAt(i)) && isHigh(text.charCodeAt(i - 1))) n -= 1;
  return n;
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

/**
 * The LCS alignment of two token lists, appended to `ops` sized in UTF-16 units. Tokens are interned to integers
 * first, so a cell costs one integer comparison however long its lines are.
 */
function lcs(a: string[], b: string[], ops: TextOp[]): void {
  const ids = new Map<string, number>();
  const intern = (tokens: string[]) =>
    Int32Array.from(tokens, (token) => {
      let id = ids.get(token);
      if (id === undefined) ids.set(token, (id = ids.size));
      return id;
    });
  const x = intern(a);
  const y = intern(b);
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
