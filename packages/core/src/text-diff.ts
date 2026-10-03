// Text edit scripts in Yjs delta form (A§10.4): `Y.Text.applyDelta` replays one directly.

export type TextOp = { retain: number } | { insert: string } | { delete: number };

/** Cells in one LCS table (a 16 MB Uint32 table). */
export const LCS_CELL_BUDGET = 4_000_000;

/** An edit script that turns `current` into `target`. */
export function diffText(current: string, target: string): TextOp[] {
  if (current === target) return [];
  return [...(current ? [{ delete: current.length }] : []), ...(target ? [{ insert: target }] : [])];
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
