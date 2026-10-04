// Comment anchors on the V1 tree (A§13; docs/design/comments.md). An anchor is two RelativePositions into the
// XmlText that holds the text (start sticks right, end sticks left) plus a quote over one projection of the tree that
// every client and the DocDO compute from Y types alone, so no Lexical editor is needed to resolve or re-anchor.
import * as Y from 'yjs';
import { diffText } from './text-diff.ts';

/** Characters of context kept either side of a quote. */
export const QUOTE_CONTEXT = 32;
/** A resolved range still counts as the commented text at this similarity to its quote (glyphdown). */
export const REANCHOR_THRESHOLD = 0.5;
/** Below this length a quote is ambiguous, so a re-anchor also needs its prefix and suffix to match. */
export const MIN_ANCHOR_CHARS = 8;
export const CONTEXT_THRESHOLD = 0.8;
/** A decorator (a V1 XmlElement embed) is one character of the projection. */
export const BLOCK_CHAR = '￼';

export interface TextQuote {
  exact: string;
  prefix: string;
  suffix: string;
}

export interface TreeAnchor {
  /** base64 Y.RelativePosition, assoc 0 (sticks to the first commented character). */
  start: string;
  /** base64 Y.RelativePosition, assoc -1 (sticks to the last commented character). */
  end: string;
  quote: TextQuote;
  /** The range's last known start in the projection, a tie-breaker for re-anchoring. */
  hint: number;
  status: 'anchored' | 'orphaned';
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
  byType: Map<Y.XmlText, Run[]>;
  starts: Map<Y.XmlText, number>;
}

/**
 * The tree as plain text: text nodes as written, a decorator as BLOCK_CHAR, a linebreak as '\n', and one '\n'
 * between blocks (emitted lazily, so empty blocks add nothing). V1 text-node property maps contribute nothing.
 */
export function project(doc: Y.Doc): Projection {
  const root = doc.get('root', Y.XmlText);
  const runs: Run[] = [];
  const byType = new Map<Y.XmlText, Run[]>();
  const starts = new Map<Y.XmlText, number>();
  let text = '';
  let pendingBreak = false;
  const open = () => {
    if (pendingBreak && text.length > 0 && !text.endsWith('\n')) text += '\n';
    pendingBreak = false;
  };
  const push = (run: Run) => {
    runs.push(run);
    const list = byType.get(run.type) ?? [];
    list.push(run);
    byType.set(run.type, list);
  };
  const visit = (type: Y.XmlText) => {
    starts.set(type, text.length);
    let index = 0;
    for (const { insert } of type.toDelta() as { insert: unknown }[]) {
      if (typeof insert === 'string') {
        open();
        push({ type, index, flat: text.length, length: insert.length });
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
        push({ type, index, flat: text.length, length: 1 });
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
  return { text, runs, byType, starts };
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function toBase64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const [a, b, c] = [bytes[i], bytes[i + 1], bytes[i + 2]];
    out += B64[a >> 2] + B64[((a & 3) << 4) | ((b ?? 0) >> 4)];
    out += b === undefined ? '=' : B64[((b & 15) << 2) | ((c ?? 0) >> 6)];
    out += c === undefined ? '=' : B64[c & 63];
  }
  return out;
}

function fromBase64(value: string): Uint8Array {
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

/** The tree position of a projection offset: a start prefers the run it opens, an end the run it closes. */
function positionAt(projection: Projection, flat: number, assoc: 0 | -1): Y.RelativePosition | null {
  const fits = (run: Run) => (assoc < 0 ? flat > run.flat : flat < run.flat + run.length);
  let best: Run | undefined;
  for (const run of projection.runs) {
    if (flat < run.flat || flat > run.flat + run.length) continue;
    if (!best || (!fits(best) && fits(run))) best = run;
  }
  return best ? Y.createRelativePositionFromTypeIndex(best.type, best.index + (flat - best.flat), assoc) : null;
}

/** The projection offset of an index inside an XmlText; an index between runs maps to the next run's start. */
function flatOf(projection: Projection, type: Y.XmlText, index: number): number | null {
  const runs = projection.byType.get(type);
  if (!runs) return projection.starts.get(type) ?? null;
  let after: number | null = null;
  for (const run of runs) {
    if (index >= run.index && index <= run.index + run.length) return run.flat + (index - run.index);
    if (run.index > index) return run.flat;
    after = run.flat + run.length;
  }
  return after;
}

export function captureQuote(text: string, start: number, end: number): TextQuote {
  return {
    exact: text.slice(start, end),
    prefix: text.slice(Math.max(0, start - QUOTE_CONTEXT), start),
    suffix: text.slice(end, end + QUOTE_CONTEXT),
  };
}

/** Mints an anchor over projection offsets [start, end); a side that lands on no run is left empty. */
export function mintAnchor(doc: Y.Doc, start: number, end: number, projection = project(doc)): TreeAnchor {
  const from = positionAt(projection, start, 0);
  const to = positionAt(projection, end, -1);
  return {
    start: from ? encodeRelPos(from) : '',
    end: to ? encodeRelPos(to) : '',
    quote: captureQuote(projection.text, start, end),
    hint: start,
    status: 'anchored',
  };
}

/**
 * The anchor's range from its RelativePositions alone, or null when a side no longer resolves into the tree or the
 * range inverted. Undone deletions are not followed, so every replica and the DocDO agree (yjs#638).
 */
export function resolveAnchor(doc: Y.Doc, anchor: TreeAnchor, projection = project(doc)): Range | null {
  if (!anchor.start || !anchor.end) return null;
  const side = (value: string) => {
    const position = Y.createAbsolutePositionFromRelativePosition(decodeRelPos(value), doc, false);
    return position && position.type instanceof Y.XmlText ? flatOf(projection, position.type, position.index) : null;
  };
  const start = side(anchor.start);
  const end = side(anchor.end);
  if (start === null || end === null || end < start) return null;
  return { start, end };
}

/** Shared characters over total length, 0..1, from the same edit script the title binding uses. */
export function similarity(a: string, b: string): number {
  if (a === b) return 1;
  if (!a.length || !b.length) return 0;
  let equal = 0;
  for (const op of diffText(a, b)) if ('retain' in op) equal += op.retain;
  return (2 * equal) / (a.length + b.length);
}

const contextMatch = (actual: string, expected: string) => (expected.length === 0 && actual.length === 0 ? 1 : similarity(actual, expected));

/** Where a quote now lives: the exact occurrence with the best context, nearest the hint on ties. */
export function findQuote(text: string, quote: TextQuote, hint: number): Range | null {
  const { exact } = quote;
  if (!exact.length) return null;
  let best: { start: number; prefix: number; suffix: number } | null = null;
  for (let at = text.indexOf(exact); at !== -1; at = text.indexOf(exact, at + 1)) {
    const prefix = contextMatch(text.slice(Math.max(0, at - quote.prefix.length), at), quote.prefix);
    const suffix = contextMatch(text.slice(at + exact.length, at + exact.length + quote.suffix.length), quote.suffix);
    const score = prefix + suffix;
    const bestScore = best ? best.prefix + best.suffix : -1;
    if (!best || score > bestScore || (score === bestScore && Math.abs(at - hint) < Math.abs(best.start - hint))) best = { start: at, prefix, suffix };
  }
  if (!best) return null;
  if (exact.length < MIN_ANCHOR_CHARS && (best.prefix < CONTEXT_THRESHOLD || best.suffix < CONTEXT_THRESHOLD)) return null;
  return { start: best.start, end: best.start + exact.length };
}

/**
 * Keeps an anchor whose range still matches its quote; otherwise re-anchors by quote and re-mints its positions;
 * otherwise orphans it. Pure: the caller decides whether to persist a changed anchor.
 */
export function validateAnchor(doc: Y.Doc, anchor: TreeAnchor): { anchor: TreeAnchor; range: Range | null; reanchored: boolean } {
  const projection = project(doc);
  const range = resolveAnchor(doc, anchor, projection);
  if (range && (anchor.quote.exact.length === 0 || similarity(projection.text.slice(range.start, range.end), anchor.quote.exact) >= REANCHOR_THRESHOLD)) {
    return { anchor: { ...anchor, hint: range.start, status: 'anchored' }, range, reanchored: false };
  }
  const found = findQuote(projection.text, anchor.quote, range?.start ?? anchor.hint);
  if (found) return { anchor: mintAnchor(doc, found.start, found.end, projection), range: found, reanchored: true };
  return { anchor: { ...anchor, status: 'orphaned' }, range: null, reanchored: false };
}
