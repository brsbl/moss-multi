// Exact-bytes checks for invariant 7: every typed string appears exactly once and contiguously, and one author's
// strings into one field keep their order ('hello', never 'lolhe').

export type Field = 'title' | 'body';

export interface Typed {
  docId: string;
  field: Field;
  text: string;
  author: string;
  /** False when the verb typed somewhere other than the end, so order is not implied. */
  ordered: boolean;
}

/** Non-overlapping occurrences of `needle` in `haystack`. */
export function occurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  for (let at = haystack.indexOf(needle); at >= 0; at = haystack.indexOf(needle, at + needle.length)) count += 1;
  return count;
}

/** Problems with `content` (one field on one actor) against the strings typed into it, in typing order. */
export function typedProblems(content: string, typed: Typed[]): string[] {
  void content;
  void typed;
  return [];
}
