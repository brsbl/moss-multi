// The pieces of comment anchoring that live outside the frame engine (docs/design/comments.md §4): one plain-text
// projection of the V1 tree computed from Y types alone, RelativePosition encoding, the client's minting arithmetic,
// and the quote search used once, at create or import, for an anchor that never had positions (I6).
import * as Y from 'yjs';
import { diffText } from './text-diff.ts';

/** Characters of context kept either side of a quote for the create-time search. */
export const QUOTE_CONTEXT = 32;
/** Below this length a quote is ambiguous, so a match also needs its prefix and suffix to match. */
export const MIN_ANCHOR_CHARS = 8;
export const CONTEXT_THRESHOLD = 0.8;
/** A decorator (a V1 XmlElement embed) is one character of the projection. */
export const BLOCK_CHAR = '￼';

export interface TextQuote {
  exact: string;
  prefix: string;
  suffix: string;
}

export interface Range {
  start: number;
  end: number;
}

/** A contiguous stretch of one XmlText's content in the projection: text, or one decorator. */
interface Run {
  type: Y.XmlText;
  /** Index of the run's first position inside `type` (embeds count one each). */
  index: number;
  /** Offset of the run's first character in the projection. */
  flat: number;
  length: number;
}

export interface Projection {
  text: string;
  runs: Run[];
}

/**
 * The tree as plain text: text nodes as written, a decorator as BLOCK_CHAR, a linebreak as '\n', and one '\n'
 * between blocks (emitted lazily, so empty blocks add nothing). V1 text-node property maps contribute nothing.
 */
export function project(doc: Y.Doc): Projection {
  const root = doc.get('root', Y.XmlText);
  const runs: Run[] = [];
  let text = '';
  let pendingBreak = false;
  const open = () => {
    if (pendingBreak && text.length > 0 && !text.endsWith('\n')) text += '\n';
    pendingBreak = false;
  };
  const visit = (type: Y.XmlText) => {
    let index = 0;
    for (const { insert } of type.toDelta() as { insert: unknown }[]) {
      if (typeof insert === 'string') {
        open();
        runs.push({ type, index, flat: text.length, length: insert.length });
        text += insert;
        index += insert.length;
        continue;
      }
      if (insert instanceof Y.XmlText) {
        pendingBreak = true;
        visit(insert);
        pendingBreak = true;
      } else if (insert instanceof Y.XmlElement) {
        if (type === root) pendingBreak = true;
        open();
        runs.push({ type, index, flat: text.length, length: 1 });
        text += BLOCK_CHAR;
        if (type === root) pendingBreak = true;
      } else if (insert instanceof Y.Map && insert.get('__type') === 'linebreak') {
        open();
        text += '\n';
      }
      index += 1;
    }
  };
  visit(root);
  return { text, runs };
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function toBase64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const [a, b, c] = [bytes[i], bytes[i + 1], bytes[i + 2]];
    out += B64[a >> 2] + B64[((a & 3) << 4) | ((b ?? 0) >> 4)];
    out += b === undefined ? '=' : B64[((b & 15) << 2) | ((c ?? 0) >> 6)];
    out += c === undefined ? '=' : B64[c & 63];
  }
  return out;
}

export function fromBase64(value: string): Uint8Array {
  const clean = value.replace(/=+$/, '');
  const bytes = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let at = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const n = [0, 1, 2, 3].map((k) => Math.max(0, B64.indexOf(clean[i + k] ?? 'A')));
    const chunk = (n[0] << 18) | (n[1] << 12) | (n[2] << 6) | n[3];
    const have = Math.min(4, clean.length - i);
    if (have > 1) bytes[at++] = (chunk >> 16) & 0xff;
    if (have > 2) bytes[at++] = (chunk >> 8) & 0xff;
    if (have > 3) bytes[at++] = chunk & 0xff;
  }
  return bytes;
}

export const encodeRelPos = (position: Y.RelativePosition): string => toBase64(Y.encodeRelativePosition(position));
export const decodeRelPos = (value: string): Y.RelativePosition => Y.decodeRelativePosition(fromBase64(value));

/**
 * The client's minting arithmetic: the tree position of a projection offset, a start on the run it opens (assoc 0,
 * the first commented unit), an end on the run it closes (assoc -1, the last one). The composer seam computes the
 * same bytes from a Lexical point through its binding (`getOffset() + 1 + offset` in the parent XmlText).
 */
export function positionAt(projection: Projection, flat: number, assoc: 0 | -1): Y.RelativePosition | null {
  const fits = (run: Run) => (assoc < 0 ? flat > run.flat : flat < run.flat + run.length);
  let best: Run | undefined;
  for (const run of projection.runs) {
    if (flat < run.flat || flat > run.flat + run.length) continue;
    if (!best || (!fits(best) && fits(run))) best = run;
  }
  return best ? Y.createRelativePositionFromTypeIndex(best.type, best.index + (flat - best.flat), assoc) : null;
}

export function captureQuote(text: string, start: number, end: number): TextQuote {
  return {
    exact: text.slice(start, end),
    prefix: text.slice(Math.max(0, start - QUOTE_CONTEXT), start),
    suffix: text.slice(end, end + QUOTE_CONTEXT),
  };
}

/** Shared characters over total length, 0..1, from the same edit script the title binding uses. */
export function similarity(a: string, b: string): number {
  if (a === b) return 1;
  if (!a.length || !b.length) return 0;
  // Every character of `a` is kept or deleted; the script leaves the common prefix and suffix as implicit retains.
  let equal = a.length;
  for (const op of diffText(a, b)) if ('delete' in op) equal -= op.delete;
  return (2 * equal) / (a.length + b.length);
}

const contextMatch = (actual: string, expected: string) => (expected.length === 0 && actual.length === 0 ? 1 : similarity(actual, expected));

/**
 * Create-time only (I6): where a never-positioned quote lives. It needs a unique best match: the exact occurrence
 * with the best context, and at under 8 characters a context match of at least 0.8 on both sides.
 */
export function findQuote(text: string, quote: TextQuote): { range: Range | null; ambiguous: boolean } {
  const { exact } = quote;
  if (!exact.length) return { range: null, ambiguous: false };
  const scored: { start: number; prefix: number; suffix: number }[] = [];
  for (let at = text.indexOf(exact); at !== -1; at = text.indexOf(exact, at + 1)) {
    const prefix = contextMatch(text.slice(Math.max(0, at - quote.prefix.length), at), quote.prefix);
    const suffix = contextMatch(text.slice(at + exact.length, at + exact.length + quote.suffix.length), quote.suffix);
    scored.push({ start: at, prefix, suffix });
  }
  if (!scored.length) return { range: null, ambiguous: false };
  const score = (s: (typeof scored)[number]) => s.prefix + s.suffix;
  const top = Math.max(...scored.map(score));
  const best = scored.filter((s) => score(s) === top);
  if (best.length > 1) return { range: null, ambiguous: true };
  const [only] = best;
  if (exact.length < MIN_ANCHOR_CHARS && (only.prefix < CONTEXT_THRESHOLD || only.suffix < CONTEXT_THRESHOLD)) return { range: null, ambiguous: false };
  return { range: { start: only.start, end: only.start + exact.length }, ambiguous: false };
}
