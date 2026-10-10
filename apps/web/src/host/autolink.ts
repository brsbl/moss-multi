// Moss's AutoLinkPlugin matchers in linear time. Moss's EMAIL_REGEX and SCHEMELESS_URL_REGEX (MarkdownEditor.tsx)
// retry from every start and backtrack to the end of the word each time, so a long word costs quadratic time on
// every keystroke and on every load of a note that holds one. These scans give exactly the regexes' matches
// (autolink.test.ts holds them to the regexes): each start that fails is skipped together with every later start
// that must fail the same way, so no character is scanned more than a few times.

const DOT = 0x2e;
const HYPHEN = 0x2d;
const AT = 0x40;
const QUOTE = 0x22;
const COLON = 0x3a;
const OPEN_BRACKET = 0x5b;
const CLOSE_BRACKET = 0x5d;

const isDigit = (c: number) => c >= 0x30 && c <= 0x39;
const isLetter = (c: number) => (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a);
/** `[a-zA-Z0-9]` */
const isAlnum = (c: number) => isDigit(c) || isLetter(c);
/** `[a-zA-Z0-9-]` */
const isHost = (c: number) => isAlnum(c) || c === HYPHEN;

const SPACE = /\s/;
/** `\s`, as the regex engine reads it (NaN past the end is not a space). */
const isSpace = (c: number) =>
  c < 0x80 ? c === 0x20 || (c >= 0x09 && c <= 0x0d) : SPACE.test(String.fromCharCode(c));
/** What `.` does not match without the `s` flag. */
const isLineTerminator = (c: number) => c === 0x0a || c === 0x0d || c === 0x2028 || c === 0x2029;

/** `[^\s<>{}|\\^[\]`]`, a URL path character. */
const PATH_EXCLUDED = new Set([...'<>{}|\\^[]`'].map((ch) => ch.charCodeAt(0)));
const isPathChar = (c: number) => !Number.isNaN(c) && !PATH_EXCLUDED.has(c) && !isSpace(c);

/** `[^<>()[\]\\.,;:\s@"]`, an email local-part character. */
const LOCAL_EXCLUDED = new Set([...'<>()[]\\.,;:@"'].map((ch) => ch.charCodeAt(0)));
const isLocalChar = (c: number) => !Number.isNaN(c) && !LOCAL_EXCLUDED.has(c) && !isSpace(c);

/** The end of the run of `test` characters starting at `from`. */
function runEnd(text: string, from: number, test: (c: number) => boolean): number {
  let i = from;
  while (i < text.length && test(text.charCodeAt(i))) i += 1;
  return i;
}

export interface AutolinkMatch {
  index: number;
  text: string;
}

// SCHEMELESS_URL_REGEX =
//   /(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?\.)+[a-zA-Z][a-zA-Z0-9-]{1,23}(?::\d{1,5})?(?:[/?#][^\s<>{}|\\^[\]`]*)?/g
// A label (`[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?\.`) starting at p is the whole run of host characters from p,
// so it exists only when that run starts and ends alphanumeric and a dot follows it. The labels from a start form
// one chain; the regex takes the most labels after which a top-level part (a letter, then a host character) starts,
// and everything after the top-level part is optional, so its quantifiers are simply greedy.

/** Where a top-level part may start: a letter followed by a host character. */
const tldAt = (text: string, p: number) => isLetter(text.charCodeAt(p)) && isHost(text.charCodeAt(p + 1));

/** The end of a schemeless URL whose top-level part starts at `t`. */
function schemelessEnd(text: string, t: number): number {
  const n = text.length;
  let j = t + 1;
  const tldLimit = Math.min(n, t + 24);
  while (j < tldLimit && isHost(text.charCodeAt(j))) j += 1;
  if (text.charCodeAt(j) === COLON && isDigit(text.charCodeAt(j + 1))) {
    const portLimit = Math.min(n, j + 6);
    j += 1;
    while (j < portLimit && isDigit(text.charCodeAt(j))) j += 1;
  }
  const c = text.charCodeAt(j);
  if (c === 0x2f || c === 0x3f || c === 0x23) j = runEnd(text, j + 1, isPathChar);
  return j;
}

/** The first SCHEMELESS_URL_REGEX match starting at or after `from`. */
function findSchemelessUrl(text: string, from: number): { index: number; end: number } | null {
  const n = text.length;
  let i = from;
  while (i < n) {
    if (!isHost(text.charCodeAt(i))) {
      i += 1;
      continue;
    }
    const end = runEnd(text, i, isHost);
    let start = i;
    while (start < end && text.charCodeAt(start) === HYPHEN) start += 1;
    // Every start in this run has the same run end, so none can open a label unless this one does.
    if (start === end || text.charCodeAt(end) !== DOT || text.charCodeAt(end - 1) === HYPHEN) {
      i = end;
      continue;
    }
    let p = end + 1;
    let tld = -1;
    for (;;) {
      if (tldAt(text, p)) tld = p;
      if (!isAlnum(text.charCodeAt(p))) break;
      const labelEnd = runEnd(text, p, isHost);
      if (text.charCodeAt(labelEnd) !== DOT || text.charCodeAt(labelEnd - 1) === HYPHEN) break;
      p = labelEnd + 1;
    }
    if (tld >= 0) return { index: start, end: schemelessEnd(text, tld) };
    // A later start inside this chain has a suffix of its labels, so it fails too; p opens no label.
    i = p;
  }
  return null;
}

/** `text.matchAll(SCHEMELESS_URL_REGEX)`, in linear time. */
export function* schemelessUrlMatches(text: string): Generator<AutolinkMatch> {
  if (!text.includes('.')) return;
  let from = 0;
  for (;;) {
    const match = findSchemelessUrl(text, from);
    if (!match) return;
    yield { index: match.index, text: text.slice(match.index, match.end) };
    from = match.end;
  }
}

// EMAIL_REGEX =
//   /(([^<>()[\]\\.,;:\s@"]+(\.[^<>()[\]\\.,;:\s@"]+)*)|(".+"))@((\[[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\])|(([a-zA-Z\-0-9]+\.)+[a-zA-Z]{2,}))/
// An unquoted local part is a chain of local runs joined by single dots; it can only be followed by `@` at the
// chain's end, and every start inside the chain reaches the same end. A quoted one runs from `"` to the last `"@`
// on the line after which a domain matches. A domain is a chain of host-character labels, each ending in a dot,
// taken as far as a top-level part of two or more letters follows one.

/** The end of the domain starting at `d`, or -1. */
function domainEnd(text: string, d: number): number {
  if (text.charCodeAt(d) === OPEN_BRACKET) {
    let j = d + 1;
    for (let group = 0; group < 4; group += 1) {
      const digits = runEnd(text, j, isDigit) - j;
      if (digits < 1 || digits > 3) return -1;
      j += digits;
      if (text.charCodeAt(j) !== (group < 3 ? DOT : CLOSE_BRACKET)) return -1;
      j += 1;
    }
    return j;
  }
  let p = d;
  let best = -1;
  for (;;) {
    const labelEnd = runEnd(text, p, isHost);
    if (labelEnd === p || text.charCodeAt(labelEnd) !== DOT) return best;
    p = labelEnd + 1;
    const letters = runEnd(text, p, isLetter) - p;
    if (letters >= 2) best = p + letters;
  }
}

/** `EMAIL_REGEX.exec(text)`'s index and match, in linear time. */
export function findEmail(text: string): AutolinkMatch | null {
  if (!text.includes('@')) return null;
  const n = text.length;
  // The quoted local part's search, per line: the last `"@` before lineEnd whose domain matches.
  let lineEnd = -1;
  let lastQuoted = -1;
  let lastQuotedEnd = -1;
  // The next `"@` not yet examined: it only moves forward, so finding them all is one pass over the text.
  let quoteAt = -2;
  let i = 0;
  while (i < n) {
    const c = text.charCodeAt(i);
    if (c === QUOTE) {
      if (i + 1 >= lineEnd) {
        lineEnd = runEnd(text, i + 1, (ch) => !isLineTerminator(ch));
        lastQuoted = -1;
        if (quoteAt !== -1 && quoteAt < i + 1) quoteAt = text.indexOf('"@', i + 1);
        for (; quoteAt >= 0 && quoteAt < lineEnd; quoteAt = text.indexOf('"@', quoteAt + 1)) {
          const end = domainEnd(text, quoteAt + 2);
          if (end >= 0) {
            lastQuoted = quoteAt;
            lastQuotedEnd = end;
          }
        }
      }
      if (lastQuoted >= i + 2) return { index: i, text: text.slice(i, lastQuotedEnd) };
      i += 1;
      continue;
    }
    if (!isLocalChar(c)) {
      i += 1;
      continue;
    }
    let end = runEnd(text, i, isLocalChar);
    while (text.charCodeAt(end) === DOT && isLocalChar(text.charCodeAt(end + 1))) end = runEnd(text, end + 1, isLocalChar);
    if (text.charCodeAt(end) === AT) {
      const matchEnd = domainEnd(text, end + 1);
      if (matchEnd >= 0) return { index: i, text: text.slice(i, matchEnd) };
    }
    i = end;
  }
  return null;
}
