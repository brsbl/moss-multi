// The text checks that confirm a line found by node identity holds the caret's words (T9.47). A caret follows the
// text on its right; with nothing on its right it follows the text on its left. Plain prefix and suffix tests, no
// search and no tolerance: every doubt is null, and null leaves the binding's own caret.

/**
 * My line was replaced by a block with text `t`: the caret's offset in `t`, or null. `left` and `right` are my old
 * line's text either side of the caret.
 */
export function replacedOffset(left: string, right: string, t: string): number | null {
  if (left === '' && right === '') return t.length;
  if (t === '') return 0;
  if (right === '' || t.endsWith(right)) {
    const head = t.slice(0, t.length - right.length);
    // Idle; my typed keys or Backspaces still on their way; a peer's text at my caret; a peer's "- " shortcut.
    if (head.startsWith(left) || left.startsWith(head)) return head.length;
    // A peer removed text from the start of my line in the same commit: a Markdown shortcut consumes its marker.
    if (left.endsWith(head)) return head.length;
  }
  // A peer's edit on my right in the same commit.
  if (left !== '' && t.startsWith(left)) return left.length;
  return null;
}

/**
 * The words on my left moved into new blocks (`fresh`, their texts in order) and my line kept `kept` ('' when it
 * went too): the caret's offset in the last of them, or null. `startOfRange` is set for the earlier end of a range.
 */
export function splitOffset(left: string, right: string, kept: string, fresh: string[], startOfRange: boolean): number | null {
  const last = fresh[fresh.length - 1];
  if (last === undefined || !last.endsWith(right)) return null;
  const moved = fresh.join('');
  // What moved from the left of my caret.
  const run = moved.slice(0, moved.length - right.length);
  // Nothing on my left moved: I am exactly at the split, where only a range's start follows its first character.
  if (run === '') return startOfRange && left === kept ? last.length - right.length : null;
  const joined = left === kept + run;
  // The same, with my unsent keys left in the first half: only when the caret has text on its right to follow.
  const typed = right !== '' && movedOut(left, kept, run);
  return joined || typed ? last.length - right.length : null;
}

/** True when `left` is `kept` with `run` inserted at one place, tried at two places only. */
export function movedOut(left: string, kept: string, run: string): boolean {
  if (left.length !== kept.length + run.length) return false;
  let hi = 0;
  while (hi < kept.length && left.charCodeAt(hi) === kept.charCodeAt(hi)) hi += 1;
  let suffix = 0;
  while (suffix < kept.length && left.charCodeAt(left.length - 1 - suffix) === kept.charCodeAt(kept.length - 1 - suffix)) suffix += 1;
  const lo = kept.length - suffix;
  if (lo > hi) return false;
  return [hi, lo].some(at => left === kept.slice(0, at) + run + kept.slice(at));
}
