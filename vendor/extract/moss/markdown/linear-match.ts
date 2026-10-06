import type { Transformer } from '@lexical/markdown';

// Linear-time matching for the transformer regexes that backtrack super-linearly on runs of unclosed openers
// (`[`, `[[`, `?[`, `![`, leading whitespace before a table pipe): a 2 MB note of them took minutes of workerd CPU.
// Lexical runs `text.match(re)` and moss `re.test(text)`, so each one is wrapped in a RegExp whose exec finds the
// same match: a linear pre-scan yields only the starts where the regex matches, and the regex runs sticky at those
// (fully anchored ones without groups need no run). Everything else about the RegExp is unchanged. Each scan is held to
// its regex byte for byte by packages/sync/src/converter/linear-match.golden.test.ts.

type Starts = (text: string) => Iterable<number>;

class LinearRegExp extends RegExp {
  readonly #starts: Starts;
  readonly #sticky: RegExp;
  // A fully anchored regex without capture groups matches the whole text or nothing.
  readonly #whole: boolean;

  constructor(original: RegExp, starts: Starts, whole: boolean) {
    super(original.source, original.flags);
    this.#starts = starts;
    this.#sticky = new RegExp(original.source, `${original.flags}y`);
    this.#whole = whole;
  }

  // match, test, replace and search all go through exec; none of the known regexes is global or sticky.
  override exec(text: string): RegExpExecArray | null {
    const input = String(text);
    for (const start of this.#starts(input)) {
      if (this.#whole) return Object.assign([input], { index: 0, input, groups: undefined }) as RegExpExecArray;
      this.#sticky.lastIndex = start;
      const match = this.#sticky.exec(input);
      if (match) return match;
    }
    return null;
  }
}

// split() and matchAll() build plain copies.
Object.defineProperty(LinearRegExp, Symbol.species, { get: () => RegExp });

const isLineTerminator = (code: number) => code === 10 || code === 13 || code === 0x2028 || code === 0x2029;
const WHITESPACE = /\s/;
const isSpace = (text: string, index: number) => index < text.length && WHITESPACE.test(text[index]);

/** The first line terminator at or after `from`, or the text's length. */
function lineEnd(text: string, from: number): number {
  for (let i = from; i < text.length; i += 1) if (isLineTerminator(text.charCodeAt(i))) return i;
  return text.length;
}

/** Leading whitespace length and where the trailing whitespace starts. */
function trim(text: string): { lead: number; trail: number } {
  let lead = 0;
  while (isSpace(text, lead)) lead += 1;
  let trail = text.length;
  while (trail > lead && isSpace(text, trail - 1)) trail -= 1;
  return { lead, trail };
}

const hasLineTerminator = (text: string, from: number, to: number) => lineEnd(text, from) < to;

/** Tests a sticky tail regex at `at`, returning where it ends (-1 when it does not match). */
function tailEnd(tail: RegExp, text: string, at: number): number {
  tail.lastIndex = at;
  return tail.test(text) ? tail.lastIndex : -1;
}

// `(?:\\.|[^\]\\])*` from `from`: the body stops at an unescaped `]`, at a backslash before a line terminator or
// the end, or at the end. Every `?[` body starts on a token boundary of any earlier body's scan (it follows a `[`),
// so a body starting inside the last scan ends where that scan ended.
function escapedBodies(text: string): (from: number) => number {
  let start = -1;
  let end = -1;
  return (from) => {
    if (from >= start && from <= end) return end;
    let i = from;
    while (i < text.length) {
      const code = text.charCodeAt(i);
      if (code === 92) {
        if (i + 1 < text.length && !isLineTerminator(text.charCodeAt(i + 1))) i += 2;
        else break;
      } else if (code === 93) break;
      else i += 1;
    }
    start = from;
    end = i;
    return end;
  };
}

// `\(([^()\s]*(?:\([^()]*\)[^()\s]*)*)\)`, the destination of moss's pills.
// Its runs are split by parentheses, so it ends in one place or none; that end is kept per start, since many
// openers can share one destination.
const PILL_DESTINATION = /\(([^()\s]*(?:\([^()]*\)[^()\s]*)*)\)/y;
function destinationEnds(text: string): (at: number) => number {
  const ends = new Map<number, number>();
  return (at) => {
    let end = ends.get(at);
    if (end === undefined) {
      end = tailEnd(PILL_DESTINATION, text, at);
      ends.set(at, end);
    }
    return end;
  };
}

// The `$`-anchored forms (the typing shortcuts) must also end the text.
const endsAt = (end: number, text: string, anchored: boolean) => end >= 0 && (!anchored || end === text.length);

// Lexical's LINK: `[`, a lazy `.+?`, `]`, then its destination and optional title.
function* lexicalLinkStarts(text: string): Iterable<number> {
  const destination = /\((?:([^()\s]+)(?:\s"((?:[^"]*\\")*[^"]*)"\s*)?)\)/y;
  let good = -1;
  let scanned = 0;
  // text[clearFrom, clearTo) holds no line terminator; `terminator`, once found, is the first one at or after clearFrom.
  let clearFrom = 0;
  let clearTo = 0;
  let terminator = -1;
  const terminatorWithin = (from: number, to: number): boolean => {
    if (terminator >= from) return terminator <= to;
    if (terminator >= 0 || from > clearTo) {
      clearFrom = from;
      clearTo = from;
      terminator = -1;
    }
    for (; clearTo <= to && clearTo < text.length; clearTo += 1) {
      if (isLineTerminator(text.charCodeAt(clearTo))) {
        terminator = clearTo;
        return true;
      }
    }
    return false;
  };
  for (let i = text.indexOf('['); i >= 0; i = text.indexOf('[', i + 1)) {
    if (good < i + 2) {
      good = -1;
      for (let j = Math.max(scanned, i + 2); j < text.length; j += 1) {
        if (text.charCodeAt(j) === 93 && tailEnd(destination, text, j + 1) >= 0) {
          good = j;
          break;
        }
      }
      if (good < 0) return;
      scanned = good + 1;
    }
    // The label `.+?` cannot cross a line terminator, so one between the opener and the `]` rules the opener out.
    if (!terminatorWithin(i + 1, good)) yield i;
  }
}

// FILE_LINK: `[[`, then a body that cannot cross `]]`, then `]]`: it matches when the first `]]` after the opener
// leaves the body at least one character.
function wikiLinkStarts(anchored: boolean): Starts {
  return function* (text) {
    let close = -1;
    for (let i = text.indexOf('[['); i >= 0; i = text.indexOf('[[', i + 1)) {
      if (close < i + 2) {
        close = text.indexOf(']]', i + 2);
        if (close < 0) return;
      }
      if (close >= i + 3 && endsAt(close + 2, text, anchored)) yield i;
    }
  };
}

// EMBED_PILL: `?[`, an escaped body, `]`, the destination.
function pillStarts(anchored: boolean): Starts {
  return function* (text) {
    const bodyEnd = escapedBodies(text);
    const destinationEnd = destinationEnds(text);
    for (let i = text.indexOf('?['); i >= 0; i = text.indexOf('?[', i + 1)) {
      const end = bodyEnd(i + 2);
      if (text.charCodeAt(end) === 93 && endsAt(destinationEnd(end + 1), text, anchored)) yield i;
    }
  };
}

const EMPHASIS = ['~~***', '***~~', '~~**', '**~~', '~~*', '*~~', '***', '**', '~~', '*'];
const opensEmphasis = (text: string, at: number) => text.charCodeAt(at) === 42 || text.startsWith('~~', at);

// FORMATTED_EMBED_PILL: an emphasis run, then a pill or a raw http(s) URL, then an emphasis run. Anchored, the
// closing run is the rest of the text, and a URL runs to its first excluded character, as every closing run
// starts with one (`*` or `~`).
const URL_EXCLUDED = /[\s<>{}|\\^[\]`*~]/;
function formattedPillStarts(anchored: boolean): Starts {
  return function* (text) {
    const bodyEnd = escapedBodies(text);
    const destinationEnd = destinationEnds(text);
    const closes = (at: number) => (anchored ? text.length - at <= 5 && EMPHASIS.includes(text.slice(at)) : opensEmphasis(text, at));
    for (let i = 0; i < text.length; i += 1) {
      if (!opensEmphasis(text, i)) continue;
      const found = EMPHASIS.some((run) => {
        if (!text.startsWith(run, i)) return false;
        const at = i + run.length;
        const scheme = text.startsWith('https://', at) ? 8 : text.startsWith('http://', at) ? 7 : 0;
        if (scheme > 0) {
          if (!anchored) return true;
          let end = at + scheme;
          while (end < text.length && !URL_EXCLUDED.test(text[end])) end += 1;
          return end > at + scheme && closes(end);
        }
        if (!text.startsWith('?[', at)) return false;
        const end = bodyEnd(at + 2);
        if (text.charCodeAt(end) !== 93) return false;
        const after = destinationEnd(end + 1);
        return after >= 0 && closes(after);
      });
      if (found) yield i;
    }
  };
}

// The bracketed raw-URL pill: `[`, http(s)://, a run without `]` or whitespace, `]`, the destination.
function bracketedUrlStarts(anchored: boolean): Starts {
  return function* (text) {
    const destinationEnd = destinationEnds(text);
    let runStart = -1;
    let runEnd = -1;
    for (let i = text.indexOf('['); i >= 0; i = text.indexOf('[', i + 1)) {
      const scheme = text.startsWith('https://', i + 1) ? 8 : text.startsWith('http://', i + 1) ? 7 : 0;
      if (scheme === 0) continue;
      const from = i + 1 + scheme;
      if (from < runStart || from > runEnd) {
        let j = from;
        while (j < text.length && text.charCodeAt(j) !== 93 && !isSpace(text, j)) j += 1;
        runStart = from;
        runEnd = j;
      }
      if (runEnd > from && text.charCodeAt(runEnd) === 93 && endsAt(destinationEnd(runEnd + 1), text, anchored)) yield i;
    }
  };
}

// RAW_WEB_EMBED_URL_LIVE_RE, the raw-URL typing shortcut: a URL, then the one whitespace character that ends the
// text. The URL is http(s):// and a run without excluded characters, or a host (dot-separated labels, a 2-24
// character top-level label, an optional port) and an optional path. So only the text before that last character
// can be the URL, and the leftmost start whose rest is one is found by checking each run of host characters once.
const RAW_URL_EXCLUDED = /[\s<>{}|\\^[\]`]/;
const HOST_CHAR = /[a-zA-Z0-9.:-]/;
const ALNUM = /[a-zA-Z0-9]/;
const LETTER = /[a-zA-Z]/;
const DIGITS = /^[0-9]{1,5}$/;
const PATH_START = /[/?#]/;

function* rawUrlLiveStarts(text: string): Iterable<number> {
  const end = text.length - 1;
  if (end < 0 || !WHITESPACE.test(text[end])) return;
  let lastExcluded = end - 1;
  while (lastExcluded >= 0 && !RAW_URL_EXCLUDED.test(text[lastExcluded])) lastExcluded -= 1;
  const scheme = schemeUrlStart(text, end, lastExcluded);
  const host = hostUrlStart(text, end, lastExcluded, scheme < 0 ? end : scheme);
  const start = host >= 0 ? host : scheme;
  if (start >= 0) yield start;
}

// `https?:\/\/[^\s<>{}|\\^[\]`]+` up to `end`: after the last excluded character, with at least one more character.
function schemeUrlStart(text: string, end: number, lastExcluded: number): number {
  for (let i = text.indexOf('http', lastExcluded + 1); i >= 0 && i < end; i = text.indexOf('http', i + 1)) {
    const scheme = text.startsWith('https://', i) ? 8 : text.startsWith('http://', i) ? 7 : 0;
    if (scheme > 0 && i + scheme < end) return i;
  }
  return -1;
}

// The host form up to `end`, starting before `before`: the host is a run of host characters ending at `end` or at a
// path character after which nothing is excluded. One forward pass over the runs; each run's checks stay inside it.
function hostUrlStart(text: string, end: number, lastExcluded: number, before: number): number {
  let a = 0;
  while (a < end && a < before) {
    if (!HOST_CHAR.test(text[a])) {
      a += 1;
      continue;
    }
    // The run [a, b), with its last two colons, its last dot and its last dot before its last colon.
    let b = a;
    let colon = -1;
    let otherColon = -1;
    let dot = -1;
    let dotBeforeColon = -1;
    for (; b < end && HOST_CHAR.test(text[b]); b += 1) {
      if (text[b] === ':') {
        otherColon = colon;
        colon = b;
        dotBeforeColon = dot;
      } else if (text[b] === '.') {
        dot = b;
      }
    }
    if (b === end || (PATH_START.test(text[b]) && b > lastExcluded)) {
      const start = hostStart(text, a, b, colon, otherColon, dot, dotBeforeColon);
      if (start >= 0) return start < before ? start : -1;
    }
    a = b + 1;
  }
  return -1;
}

// The leftmost i in [a, b) where text[i, b) is labels, a top-level label and an optional `:` port, given the run's
// last colons and dots (-1 for none).
function hostStart(text: string, a: number, b: number, colon: number, otherColon: number, dot: number, dotBeforeColon: number): number {
  if (colon < 0) return domainStart(text, a, b, dot);
  const lo = Math.max(a, otherColon + 1);
  const withPort = DIGITS.test(text.slice(colon + 1, b)) ? domainStart(text, lo, colon, dotBeforeColon) : -1;
  return withPort >= 0 ? withPort : domainStart(text, colon + 1, b, dot > colon ? dot : -1);
}

// The leftmost i in [lo, end) where text[i, end), of letters, digits, `-` and `.`, is one or more labels each
// followed by a dot (alphanumeric at both ends), then a top-level label (a letter, then 1-23 of [a-zA-Z0-9-]).
// `lastDot` is the last dot before `end`, or -1.
function domainStart(text: string, lo: number, end: number, lastDot: number): number {
  if (lastDot < lo) return -1;
  const top = end - lastDot - 1;
  if (top < 2 || top > 24 || !LETTER.test(text[lastDot + 1])) return -1;
  // Every dot after the start needs an alphanumeric on each side.
  let from = lo;
  for (let p = lastDot; p >= lo; p -= 1) {
    if (text[p] === '.' && (p === lo || !ALNUM.test(text[p - 1]) || !ALNUM.test(text[p + 1]))) {
      from = p + 1;
      break;
    }
  }
  for (let i = from; i < lastDot; i += 1) if (ALNUM.test(text[i])) return i;
  return -1;
}

// `^!\[.*\]\(.*\)` followed by `$` (the text-match form) or `\s*$` (the element form): one line from `![` to its
// last `)`, holding a `](` with room for the `)`.
function imageLineStarts(trailingSpace: boolean): Starts {
  return function* (text) {
    if (!text.startsWith('![')) return;
    const close = trailingSpace ? trim(text).trail - 1 : text.length - 1;
    if (close < 0 || text.charCodeAt(close) !== 41 || hasLineTerminator(text, 0, close)) return;
    const middle = close >= 2 ? text.lastIndexOf('](', close - 2) : -1;
    if (middle >= 2) yield 0;
  };
}

// `^\s*\|.*\|?\s*$`: a pipe after the leading whitespace, and no line terminator before the trailing whitespace.
function pipeRow(text: string): boolean {
  const { lead, trail } = trim(text);
  return text.charCodeAt(lead) === 124 && lineEnd(text, lead + 1) >= trail;
}

// `^\s*(?:.*\s\|\s.*)\s*$`: a whitespace-pipe-whitespace triple reachable without crossing a line terminator
// from the end of the leading whitespace (or from inside it) and from which the trailing whitespace is reachable.
function spacedPipeRow(text: string): boolean {
  const { lead, trail } = trim(text);
  const afterLead = lineEnd(text, lead);
  let lastBeforeTrail = -1;
  for (let i = trail - 1; i >= 0; i -= 1) {
    if (isLineTerminator(text.charCodeAt(i))) {
      lastBeforeTrail = i;
      break;
    }
  }
  for (let p = text.indexOf('|', 1) - 1; p >= 0; p = text.indexOf('|', p + 2) - 1) {
    if (!isSpace(text, p) || !isSpace(text, p + 2)) continue;
    if ((p <= lead || afterLead >= p) && lastBeforeTrail < p + 3) return true;
  }
  return false;
}

// `^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)+\|?\s*$`, a divider row, parsed without backtracking.
function dividerRow(text: string): boolean {
  let i = 0;
  const spaces = () => {
    while (isSpace(text, i)) i += 1;
  };
  const cell = () => {
    if (text[i] === ':') i += 1;
    if (text[i] !== '-') return false;
    while (text[i] === '-') i += 1;
    if (text[i] === ':') i += 1;
    spaces();
    return true;
  };
  spaces();
  if (text[i] === '|') {
    i += 1;
    spaces();
  }
  if (!cell()) return false;
  let cells = 0;
  while (text[i] === '|') {
    i += 1;
    spaces();
    if (i === text.length) break;
    if (!cell()) return false;
    cells += 1;
  }
  return cells > 0 && i === text.length;
}

const LINEAR: { source: string; flags: string; starts: Starts; whole?: boolean }[] = [
  {
    source: String.raw`(?:\[(.+?)\])(?:\((?:([^()\s]+)(?:\s"((?:[^"]*\\")*[^"]*)"\s*)?)\))`,
    flags: '',
    starts: lexicalLinkStarts,
  },
  // Each pill and wiki-link regex, as the import form and as the `$`-anchored typing-shortcut form.
  ...[false, true].flatMap((anchored) => {
    const end = anchored ? '$' : '';
    return [
      { source: String.raw`\[\[((?:[^\]]|\](?!\]))+)\]\]` + end, flags: '', starts: wikiLinkStarts(anchored) },
      { source: String.raw`\?\[((?:\\.|[^\]\\])*)\]\(([^()\s]*(?:\([^()]*\)[^()\s]*)*)\)` + end, flags: '', starts: pillStarts(anchored) },
      {
        source:
          String.raw`(~~\*\*\*|\*\*\*~~|~~\*\*|\*\*~~|~~\*|\*~~|\*\*\*|\*\*|~~|\*)(?:(\?\[((?:\\.|[^\]\\])*)\]\(([^()\s]*(?:\([^()]*\)[^()\s]*)*)\))|(https?:\/\/[^\s<>{}|\\^[\]` +
          '`' +
          String.raw`*~]+))(~~\*\*\*|\*\*\*~~|~~\*\*|\*\*~~|~~\*|\*~~|\*\*\*|\*\*|~~|\*)` +
          end,
        flags: '',
        starts: formattedPillStarts(anchored),
      },
      { source: String.raw`\[((?:https?:\/\/[^\]\s]+))\]\(([^()\s]*(?:\([^()]*\)[^()\s]*)*)\)` + end, flags: '', starts: bracketedUrlStarts(anchored) },
    ];
  }),
  {
    source:
      String.raw`((?:https?:\/\/[^\s<>{}|\\^[\]` +
      '`' +
      String.raw`]+|(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?\.)+[a-zA-Z][a-zA-Z0-9-]{1,23}(?::\d{1,5})?(?:[/?#][^\s<>{}|\\^[\]` +
      '`' +
      String.raw`]*)?))(\s)$`,
    flags: '',
    starts: rawUrlLiveStarts,
  },
  { source: String.raw`^!\[.*\]\(.*\)$`, flags: '', starts: imageLineStarts(false), whole: true },
  { source: String.raw`^!\[.*\]\(.*\)\s*$`, flags: '', starts: imageLineStarts(true), whole: true },
  {
    source: String.raw`^\s*(?:\|.*\|?|.*\s\|\s.*)\s*$`,
    flags: '',
    starts: function* (text) {
      if (pipeRow(text) || spacedPipeRow(text)) yield 0;
    },
    whole: true,
  },
  // TABLE_DIVIDER_ROW_REG_EXP, which isTableDividerRow tests.
  {
    source: String.raw`^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)+\|?\s*$`,
    flags: '',
    starts: function* (text) {
      if (dividerRow(text)) yield 0;
    },
    whole: true,
  },
  {
    source: String.raw`(?:^\s*\|.*\|?\s*$|^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)+\|?\s*$)`,
    flags: '',
    starts: function* (text) {
      if (pipeRow(text) || dividerRow(text)) yield 0;
    },
    whole: true,
  },
];

/** The regex sources (with flags) this module matches in linear time. */
export const LINEAR_REGEXP_KEYS: readonly string[] = LINEAR.map(({ source, flags }) => `/${source}/${flags}`);

/** `original` with linear matching when it is one of the known regexes, else `original` itself. */
export function linearRegExp(original: RegExp): RegExp {
  const known = LINEAR.find(({ source, flags }) => source === original.source && flags === original.flags);
  return known ? new LinearRegExp(original, known.starts, known.whole ?? false) : original;
}

const FIELDS = ['importRegExp', 'regExp', 'regExpStart'] as const;

/** The transformers, with each known regex field matched in linear time (copies; the originals are untouched). */
export function withLinearRegExps(transformers: Transformer[]): Transformer[] {
  return transformers.map((transformer) => {
    const fields = transformer as unknown as Record<string, unknown>;
    let copy: Record<string, unknown> | null = null;
    for (const field of FIELDS) {
      const value = fields[field];
      if (!(value instanceof RegExp)) continue;
      const linear = linearRegExp(value);
      if (linear !== value) (copy ??= { ...fields })[field] = linear;
    }
    return (copy ?? transformer) as Transformer;
  });
}

// ---- moss's import normalization (markdown/normalize.ts), whose global regexes rescan to the end of the line or
// the text from every start that fails. Each helper gives the regex's own result (linear-match.golden.test.ts).

// ESCAPED_BLOCKQUOTE_BLOCK_RE, `&lt;blockquote\b[\s\S]*?&lt;\/blockquote&gt;` (gi), scans from each opener to the
// first closer after it. Every match ends by the last closer, and an opener after it scans to the end and fails, so
// the search can stop there; this is where it can end.
export function escapedBlockquoteSearchEnd(md: string): number {
  const closer = /&lt;\/blockquote&gt;/gi;
  let end = 0;
  for (let match = closer.exec(md); match; match = closer.exec(md)) end = closer.lastIndex;
  return end;
}

// stripFormattingAroundIsolatedWikiLinks: `segment.replace(/(\*{1,2}|~~)\[\[((?:[^\]]|\](?!\]))+)\]\]\1/g, '[[$2]]')`.
// The body runs to the first `]]` after the opener, which later openers share, so it is found once.
export function stripWikiLinkDelimiters(segment: string): string {
  let out = '';
  let copied = 0;
  let close = -1;
  for (let i = 0; i < segment.length; i += 1) {
    const char = segment[i];
    const delimiter = char === '*' ? (segment[i + 1] === '*' ? '**' : '*') : char === '~' && segment[i + 1] === '~' ? '~~' : '';
    if (!delimiter || !segment.startsWith('[[', i + delimiter.length)) continue;
    const body = i + delimiter.length + 2;
    if (close < body) {
      close = segment.indexOf(']]', body);
      if (close < 0) break;
    }
    if (close === body || !segment.startsWith(delimiter, close + 2)) continue;
    out += `${segment.slice(copied, i)}[[${segment.slice(body, close)}]]`;
    copied = close + 2 + delimiter.length;
    i = copied - 1;
  }
  return copied === 0 ? segment : out + segment.slice(copied);
}

// normalizeFormattingAroundEmbedPillTargets: `value.replace(regExp, replacer)` for a delimiter's regex,
// `<d>([^\n]*?(?:https?:\/\/|\?\[)[^\n]*?)<d>`, <d> the delimiter not touching another of its character. A match needs
// a URL or `?[` after its opener and a delimiter after that, on one line, and an opener without them rescans the rest
// of the line. So each line is matched only up to the first delimiter after its last such target (no match ends
// later, and no opener later matches); a line without one is left alone.
export function replaceFormattedTargets(
  value: string,
  delimiter: string,
  regExp: RegExp,
  replacer: (fullMatch: string, content: string) => string,
): string {
  const lines = value.split('\n');
  const mark = delimiter[0];
  for (let n = 0; n < lines.length; n += 1) {
    const line = lines[n];
    const isDelimiter = (q: number) => line.startsWith(delimiter, q) && line[q - 1] !== mark && line[q + delimiter.length] !== mark;
    let lastDelimiter = -1;
    for (let q = line.lastIndexOf(delimiter); q >= 0; q = q > 0 ? line.lastIndexOf(delimiter, q - 1) : -1) {
      if (isDelimiter(q)) {
        lastDelimiter = q;
        break;
      }
    }
    if (lastDelimiter < 0) continue;
    // The last target ending before the last delimiter.
    let target = -1;
    let targetEnd = -1;
    for (const token of ['http://', 'https://', '?[']) {
      for (let t = line.indexOf(token); t >= 0 && t + token.length <= lastDelimiter; t = line.indexOf(token, t + 1)) {
        if (t > target) {
          target = t;
          targetEnd = t + token.length;
        }
      }
    }
    if (target < 0) continue;
    let close = targetEnd;
    while (!isDelimiter(close)) close += 1;
    const end = Math.min(line.length, close + delimiter.length + 1);
    lines[n] = line.slice(0, end).replace(regExp, replacer) + line.slice(end);
  }
  return lines.join('\n');
}
