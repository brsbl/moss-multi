// A doc's filename is a projection of its title (R3; A§5.1): `<slug>.md`, unique among the live docs of a folder.

/** The title's letters and digits, lowercased and joined by hyphens, at most 80 characters. */
export function slug(title: string): string {
  return title
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|(?<!-)-+$/g, '')
    .slice(0, 80)
    .replace(/(?<!-)-+$/, '');
}

/** The stem for a title with no letters or digits. */
export const UNTITLED_STEM = 'untitled';

/** `<stem>.md`, else `<stem>-2.md`, `<stem>-3.md`…: collisions get a suffix, never a 409 (A§5.1). */
export function availableFilename(stem: string, taken: Set<string>): string {
  if (!taken.has(`${stem}.md`)) return `${stem}.md`;
  for (let n = 2; ; n += 1) if (!taken.has(`${stem}-${n}.md`)) return `${stem}-${n}.md`;
}

/** The filename a title projects to among `taken`. */
export const filenameFor = (title: string, taken: Set<string>): string => availableFilename(slug(title) || UNTITLED_STEM, taken);
