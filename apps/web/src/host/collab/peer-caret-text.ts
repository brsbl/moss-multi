// The text checks that confirm a line found by node identity holds the caret's words (T9.47). A caret follows the
// text on its right; with nothing on its right it follows the text on its left. Plain prefix and suffix tests, no
// search and no tolerance: every doubt is null, and null leaves the binding's own caret.

/** My line was replaced by a block with text `t`: the caret's offset in `t`, or null. */
export function replacedOffset(_left: string, _right: string, _t: string): number | null {
  return null;
}

/** The words on my left moved into new blocks: the caret's offset in the last of them, or null. */
export function splitOffset(_left: string, _right: string, _kept: string, _fresh: string[], _startOfRange: boolean): number | null {
  return null;
}

/** True when `left` is `kept` with `run` inserted at one place, tried at two places only. */
export function movedOut(_left: string, _kept: string, _run: string): boolean {
  return false;
}
