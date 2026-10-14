// The formula popover's merge of a peer's change to a stored formula into an open draft (A§10.10, T3.B15). A stored
// formula names each reference as a token, `@(name#noteId#formulaId)`, and the popover shows only its name.
import { applyOps, diffText, mapOffset, rebaseOps, type Delta, type TextOp } from '@moss-multi/core/text-diff';

export type { Delta };

/** Shown when a peer's change and the open draft both changed a formula too crowded to merge by reference. */
export const FORMULA_REPLACED = 'Someone changed this formula while you were editing it. It now shows their version.';

const TOKEN = /@\(([a-zA-Z][a-zA-Z0-9_-]*)#([0-9a-fA-F-]{36})#([0-9a-fA-F-]{36})\)/g;

/** A reference's range in the humanized expression (`start`/`end`) and its token's range in the stored one. */
export interface TokenSpan {
  start: number;
  end: number;
  rawStart: number;
  rawEnd: number;
}

const isHigh = (unit: number) => unit >= 0xd800 && unit <= 0xdbff;
const isLow = (unit: number) => unit >= 0xdc00 && unit <= 0xdfff;
const BMP_UNITS = 0x10000;
const ASTRAL_POINTS = 0x100000;

interface TokenCodec {
  encode(raw: string): { text: string; spans: TokenSpan[] };
  decode(text: string): { raw: string; spans: TokenSpan[] };
}

/** The tokens of `raw` and their spans, with each token left as it is. */
export function referenceSpans(raw: string): TokenSpan[] {
  const spans: TokenSpan[] = [];
  let shift = 0;
  for (const match of raw.matchAll(TOKEN)) {
    const start = match.index - shift;
    spans.push({ start, end: start + match[1].length, rawStart: match.index, rawEnd: match.index + match[0].length });
    shift += match[0].length - match[1].length;
  }
  return spans;
}

/**
 * Stored expressions with each distinct reference token as one character no source uses, so a text merge keeps or
 * drops a token whole and never splices one token's ids into another's. A token takes a free UTF-16 unit (the private
 * use area first, never a surrogate); once those run out, a free astral code point, which the diff aligns as one
 * element, so the merge is over a sequence in which each token is one item. Each assigned character is reserved, and
 * the search visits each candidate once. Null when every code point is taken (a source of over a million distinct
 * characters, past the note cap): the caller merges the stored text as it is.
 */
export function createTokenCodec(sources: readonly string[]): TokenCodec | null {
  const usedUnits = new Uint8Array(BMP_UNITS);
  const usedPoints = new Set<number>();
  for (const source of sources) {
    for (let i = 0; i < source.length; i += 1) {
      const unit = source.charCodeAt(i);
      usedUnits[unit] = 1;
      const low = source.charCodeAt(i + 1);
      if (isHigh(unit) && isLow(low)) usedPoints.add(((unit - 0xd800) << 10) + (low - 0xdc00) + 0x10000);
    }
  }
  const toChar = new Map<string, string>();
  const toToken = new Map<string, string>();
  let unitCursor = 0;
  let pointCursor = 0;
  const allocate = (): string | null => {
    while (unitCursor < BMP_UNITS) {
      const unit = (0xe000 + unitCursor++) % BMP_UNITS;
      if (unit >= 0xd800 && unit <= 0xdfff) continue;
      if (!usedUnits[unit]) { usedUnits[unit] = 1; return String.fromCharCode(unit); }
    }
    while (pointCursor < ASTRAL_POINTS) {
      // Supplementary private use planes (15 and 16) first.
      const point = 0x10000 + ((0xe0000 + pointCursor++) % ASTRAL_POINTS);
      if (!usedPoints.has(point)) { usedPoints.add(point); return String.fromCodePoint(point); }
    }
    return null;
  };
  for (const source of sources) {
    for (const match of source.matchAll(TOKEN)) {
      if (toChar.has(match[0])) continue;
      const char = allocate();
      if (char === null) return null;
      toChar.set(match[0], char);
      toToken.set(char, match[0]);
    }
  }
  /** The token at `i` of encoded `text` and its width, or undefined. Read per UTF-16 unit, as encoding writes. */
  const tokenAt = (text: string, i: number): [string, number] | undefined => {
    if (isHigh(text.charCodeAt(i)) && isLow(text.charCodeAt(i + 1))) {
      const token = toToken.get(text.slice(i, i + 2));
      return token === undefined ? undefined : [token, 2];
    }
    const token = toToken.get(text[i]);
    return token === undefined ? undefined : [token, 1];
  };
  const spansOf = (text: string): TokenSpan[] => {
    const spans: TokenSpan[] = [];
    let humanized = 0;
    for (let i = 0; i < text.length; i += 1) {
      const found = tokenAt(text, i);
      if (!found) { humanized += 1; continue; }
      const name = found[0].slice(2, found[0].indexOf('#'));
      spans.push({ start: humanized, end: humanized + name.length, rawStart: i, rawEnd: i + found[1] });
      humanized += name.length;
      i += found[1] - 1;
    }
    return spans;
  };
  return {
    encode: (raw) => {
      const text = raw.replace(TOKEN, (token) => toChar.get(token) ?? token);
      return { text, spans: spansOf(text) };
    },
    decode: (text) => {
      let raw = '';
      for (let i = 0; i < text.length; i += 1) {
        const found = tokenAt(text, i);
        if (!found) { raw += text[i]; continue; }
        raw += found[0];
        i += found[1] - 1;
      }
      return { raw, spans: spansOf(text) };
    },
  };
}

/** The stored text itself, for a merge past every free character. */
const identity: TokenCodec = {
  encode: (raw) => ({ text: raw, spans: referenceSpans(raw) }),
  decode: (text) => ({ raw: text, spans: referenceSpans(text) }),
};

/** A humanized offset in stored form; one inside a reference goes to its token's start. */
const toStoredOffset = (offset: number, spans: readonly TokenSpan[]): number => {
  let shift = 0;
  for (const span of spans) {
    if (offset <= span.start) break;
    if (offset < span.end) return span.rawStart;
    shift = span.rawEnd - span.end;
  }
  return offset + shift;
};

/** A stored offset in humanized form; one inside a token goes to its name's end. */
const toHumanizedOffset = (offset: number, spans: readonly TokenSpan[]): number => {
  let shift = 0;
  for (const span of spans) {
    if (offset <= span.rawStart) break;
    if (offset < span.rawEnd) return span.end;
    shift = span.end - span.rawEnd;
  }
  return offset + shift;
};

/** Where the unit at `at` is after `ops`, or -1 when they delete it. */
function follow(at: number, ops: readonly TextOp[]): number {
  let from = 0;
  let to = 0;
  for (const op of ops) {
    if ('retain' in op) {
      if (at < from + op.retain) return to + at - from;
      from += op.retain;
      to += op.retain;
    } else if ('delete' in op) {
      if (at < from + op.delete) return -1;
      from += op.delete;
    } else {
      to += op.insert.length;
    }
  }
  return to + at - from;
}

/**
 * A Y.Text change as an edit of `before`, checked to turn it into `after`: the change itself, so an edit inside a run
 * of equal characters stays where it was made. Undefined when it does not (an embed, or a stale base).
 */
export function deltaOps(delta: Delta | undefined, before: string, after: string): TextOp[] | undefined {
  if (!delta) return undefined;
  const ops: TextOp[] = [];
  for (const op of delta) {
    if (op.retain !== undefined) ops.push({ retain: op.retain });
    else if (op.delete !== undefined) ops.push({ delete: op.delete });
    else if (typeof op.insert === 'string') ops.push({ insert: op.insert });
    else return undefined;
  }
  return applyOps(before, ops) === after ? ops : undefined;
}

/** `ops`, an edit of raw `before`, in `codec`'s encoding of it; undefined when it splits a token. */
function encodeOps(ops: readonly TextOp[], before: string, codec: TokenCodec, base: string, target: string): TextOp[] | undefined {
  const out: TextOp[] = [];
  let at = 0;
  for (const op of ops) {
    if ('insert' in op) { out.push({ insert: codec.encode(op.insert).text }); continue; }
    const length = 'retain' in op ? op.retain : op.delete;
    const encoded = codec.encode(before.slice(at, at + length)).text.length;
    at += length;
    out.push('retain' in op ? { retain: encoded } : { delete: encoded });
  }
  return applyOps(base, out) === target ? out : undefined;
}

/**
 * A peer's change to the stored formula, `before` to `after` (`delta` when the change is known), merged into the
 * draft `ours` (stored form, tokens included) in stored form, so each reference token keeps its note and formula
 * through the edit itself. `selection` holds humanized offsets in `ours`; an offset inside a reference keeps its place
 * in the name while that token survives, and goes to where the token stood once it is removed or replaced. Returns the
 * merged stored text and the selection's humanized offsets in it.
 */
export function mergeStoredFormula(
  before: string, after: string, ours: string, selection: readonly number[], delta?: Delta,
): { raw: string; selection: number[] } {
  const codec = createTokenCodec([before, after, ours]) ?? identity;
  const base = codec.encode(before).text;
  const target = codec.encode(after).text;
  const mine = codec.encode(ours);
  const raw = deltaOps(delta, before, after);
  const peer = (raw && encodeOps(raw, before, codec, base, target)) ?? diffText(base, target);
  const ops = rebaseOps(base, peer, mine.text);
  const result = codec.decode(applyOps(mine.text, ops));
  const place = (at: number): number => {
    const span = mine.spans.find((candidate) => candidate.start < at && at < candidate.end);
    if (!span) return toHumanizedOffset(mapOffset(toStoredOffset(at, mine.spans), ops), result.spans);
    const moved = follow(span.rawStart, ops);
    const kept = moved < 0 ? undefined : result.spans.find((candidate) => candidate.rawStart === moved);
    return kept ? kept.start + at - span.start : toHumanizedOffset(mapOffset(span.rawStart, ops), result.spans);
  };
  return { raw: result.raw, selection: selection.map(place) };
}

/**
 * Where a caret at `caret` in the field's text `shown` is in the stored text it writes, `raw` (`shown` with names bound
 * to their tokens) trimmed, so the write knows where its edit ended. A token the field shows as its name maps a caret
 * inside that name to the token's start; a raw token pasted into the field keeps its own width.
 */
export function storedCaret(raw: string, caret: number | undefined, shown: string): number | undefined {
  if (caret === undefined) return undefined;
  let field = 0;
  let stored = 0;
  let mapped: number | undefined;
  for (const match of raw.matchAll(TOKEN)) {
    const gap = match.index - stored;
    if (caret <= field + gap) { mapped = stored + caret - field; break; }
    field += gap;
    stored = match.index;
    const verbatim = shown.startsWith(match[0], field);
    const width = verbatim ? match[0].length : match[1].length;
    if (caret < field + width) { mapped = verbatim ? stored + caret - field : stored; break; }
    field += width;
    stored += match[0].length;
  }
  mapped ??= stored + caret - field;
  const lead = raw.length - raw.trimStart().length;
  return Math.min(Math.max(mapped - lead, 0), raw.trim().length);
}
