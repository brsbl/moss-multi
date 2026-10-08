// moss's interchange patterns as linear scans (docs/METHOD.md): the leading `# Title` line and the `%%m:` comment
// markers, matched as moss's regexes match them, golden-tested against those regexes in title-line.test.ts.

/** `[^\S\r\n]`: whitespace other than CR and LF (U+2028 and U+2029 included, as in the regex). */
const isInlineSpace = (char: string | undefined): boolean => char !== undefined && char !== '\r' && char !== '\n' && /\s/.test(char);
/** What `.` refuses. */
const isLineEnd = (char: string | undefined): boolean => char === '\n' || char === '\r' || char === '\u2028' || char === '\u2029';

/** Where `(?:\r?\n|$)` ends at `at`, or -1. */
function lineBreakEnd(text: string, at: number): number {
  if (at === text.length) return at;
  if (text[at] === '\n') return at + 1;
  return text[at] === '\r' && text[at + 1] === '\n' ? at + 2 : -1;
}

/**
 * What `/^#(?!#)[^\S\r\n]+(.*?)(?:[^\S\r\n]+#+)?[^\S\r\n]*(?:\r?\n|$)/` (moss's LEADING_H1_RE, anchored) matches in
 * `text`: the line's raw text and the match's length, or null. The regex retries every split of a run of spaces;
 * every split of one run ends the same way, so each run is tried once.
 */
export function matchTitleLine(text: string): { line: string; length: number } | null {
  if (text[0] !== '#' || text[1] === '#' || !isInlineSpace(text[1])) return null;
  let start = 1;
  while (isInlineSpace(text[start])) start += 1;
  let lineEnd = start;
  while (lineEnd < text.length && !isLineEnd(text[lineEnd])) lineEnd += 1;
  let at = start;
  while (at <= lineEnd) {
    let spaces = at;
    while (isInlineSpace(text[spaces])) spaces += 1;
    let end = -1;
    if (spaces > at && text[spaces] === '#') {
      let close = spaces;
      while (text[close] === '#') close += 1;
      while (isInlineSpace(text[close])) close += 1;
      end = lineBreakEnd(text, close);
    }
    if (end === -1) end = lineBreakEnd(text, spaces);
    if (end !== -1) return { line: text.slice(start, at), length: end };
    at = spaces > at ? spaces : at + 1;
  }
  return null;
}

/**
 * Each moss comment marker in `text` (common/comment-markers.ts), as `/%%m:\s*[A-Za-z0-9_,\-\s]+?\s*:(?:start|end)%%/g`
 * finds it: `%%m:`, one or more id characters or spaces, then `:start%%` or `:end%%`.
 */
export function* markerMatches(text: string): Generator<{ index: number; token: string }> {
  for (let at = text.indexOf('%%m:'); at !== -1; ) {
    let ids = at + 4;
    while (ids < text.length && /[\w,\-\s]/.test(text[ids]!)) ids += 1;
    const tail = text.startsWith(':start%%', ids) ? 8 : text.startsWith(':end%%', ids) ? 6 : 0;
    if (ids > at + 4 && tail > 0) {
      yield { index: at, token: text.slice(at, ids + tail) };
      at = text.indexOf('%%m:', ids + tail);
    } else {
      at = text.indexOf('%%m:', at + 1);
    }
  }
}
