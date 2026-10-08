// Which lazy node families (lazy-views.ts) a note body may hold, by the markdown that imports them.

const FAMILIES: [type: string, pattern: RegExp][] = [
  ['chart', /`{3,}\s*moss-chart/],
  ['sketch', /`{3,}\s*moss-(?:canvas|sketch)/],
  ['html-block', /`{3,}\s*moss-html|<blockquote|&lt;blockquote/i],
];

/**
 * The lazy families `body` may hold: a ```moss-chart fence, a ```moss-canvas (or legacy ```moss-sketch) fence, and
 * a ```moss-html fence or an HTML blockquote. A superset is harmless; it only loads a chunk early.
 */
export function lazyFamilies(body: string): string[] {
  return FAMILIES.filter(([, pattern]) => pattern.test(body)).map(([type]) => type);
}
