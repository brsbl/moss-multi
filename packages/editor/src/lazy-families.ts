// Which lazy node families (lazy-views.ts) a note body may hold, by the markdown that imports them. One pass over the
// body, so a long run of backticks in a hostile note costs linear time (a regex like /`{3,}\s*moss-chart/ backtracks
// quadratically on one).

/** The info strings after a fence of three or more backticks, by the family each imports. */
const FENCES: [info: string, type: string][] = [
  ['moss-chart', 'chart'],
  ['moss-canvas', 'sketch'],
  ['moss-sketch', 'sketch'],
];
const ORDER = ['chart', 'sketch', 'html-block'];
const SPACE = /\s/;

/**
 * The lazy families `body` may hold: a ```moss-chart fence, a ```moss-canvas (or legacy ```moss-sketch) fence, and
 * a ```moss-html fence or an HTML blockquote. A superset is harmless; it only loads a chunk early.
 */
export function lazyFamilies(body: string): string[] {
  const found = new Set<string>();
  for (let at = body.indexOf('```'); at >= 0; ) {
    // Past this run of backticks and the whitespace after it; neither is scanned again.
    let info = at + 3;
    while (body.charCodeAt(info) === 96) info += 1;
    while (info < body.length && SPACE.test(body[info])) info += 1;
    for (const [name, type] of FENCES) if (body.startsWith(name, info)) found.add(type);
    if (body.slice(info, info + 9).toLowerCase() === 'moss-html') found.add('html-block');
    at = body.indexOf('```', info);
  }
  if (!found.has('html-block')) {
    const lower = body.toLowerCase();
    if (lower.includes('<blockquote') || lower.includes('&lt;blockquote')) found.add('html-block');
  }
  return ORDER.filter((type) => found.has(type));
}
