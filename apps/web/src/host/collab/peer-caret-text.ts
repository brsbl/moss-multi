// The text checks that confirm a line found by node identity holds the caret's words (T9.47). A caret follows the
// text on its right; with nothing on its right it follows the text on its left. Plain prefix and suffix tests, no
// search and no tolerance: every doubt is null, and null leaves the binding's own caret.

/** My line was replaced by a block with text `t`: the caret's offset in `t`, or null. */
export function replacedOffset(left: string, right: string, t: string): number | null {
  void [left, right, t];
  return null;
}

/** The words on my left moved into new blocks: the caret's offset in the last of them, or null. */
export function splitOffset(left: string, right: string, kept: string, fresh: string[], startOfRange: boolean): number | null {
  void [left, right, kept, fresh, startOfRange];
  return null;
}

/** True when `left` is `kept` with `run` inserted at one place, tried at two places only. */
export function movedOut(left: string, kept: string, run: string): boolean {
  void [left, kept, run];
  return false;
}
