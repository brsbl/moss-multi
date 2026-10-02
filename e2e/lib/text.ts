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
  const problems: string[] = [];
  for (const text of new Set(typed.map((entry) => entry.text))) {
    const expected = typed.filter((entry) => entry.text === text).length;
    const found = occurrences(content, text);
    if (found !== expected) problems.push(`"${text}" appears ${found} time(s), typed ${expected}`);
  }
  for (const author of new Set(typed.map((entry) => entry.author))) {
    const mine = typed.filter((entry) => entry.author === author && entry.ordered && occurrences(content, entry.text) === 1);
    for (let i = 1; i < mine.length; i += 1) {
      if (content.indexOf(mine[i].text) < content.indexOf(mine[i - 1].text)) {
        problems.push(`"${mine[i].text}" by ${author} comes before "${mine[i - 1].text}", typed earlier`);
      }
    }
  }
  return problems;
}
