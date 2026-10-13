// The formula popover's merge of a peer's change to a stored formula into an open draft (A§10.10, T3.B15). A stored
// formula names each reference as a token, `@(name#noteId#formulaId)`, and the popover shows only its name.
import { applyOps, diffText, mapOffset, rebaseOps, type Delta, type TextOp } from '@moss-multi/core/text-diff';

export type { Delta };

const TOKEN = /@\(([a-zA-Z][a-zA-Z0-9_-]*)#([0-9a-fA-F-]{36})#([0-9a-fA-F-]{36})\)/g;

/** A reference's range in the humanized expression (`start`/`end`) and its token's range in the stored one. */
export interface TokenSpan {
  start: number;
  end: number;
  rawStart: number;
  rawEnd: number;
}

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

export function createTokenCodec(sources: readonly string[]): TokenCodec | null {
  const toUnit = new Map<string, string>();
  const toToken = new Map<string, string>();
  const used = new Set(sources.join(''));
  let next = 0xe000;
  const unitFor = (token: string): string => {
    let unit = toUnit.get(token);
    if (unit === undefined) {
      while (used.has(String.fromCharCode(next))) next += 1;
      unit = String.fromCharCode(next++);
      toUnit.set(token, unit);
      toToken.set(unit, token);
    }
    return unit;
  };
  const spansOf = (text: string): TokenSpan[] => {
    const spans: TokenSpan[] = [];
    let humanized = 0;
    for (let i = 0; i < text.length; i += 1) {
      const token = toToken.get(text[i]);
      if (token === undefined) { humanized += 1; continue; }
      const name = token.slice(2, token.indexOf('#'));
      spans.push({ start: humanized, end: humanized + name.length, rawStart: i, rawEnd: i + 1 });
      humanized += name.length;
    }
    return spans;
  };
  return {
    encode: (raw: string) => {
      const text = raw.replace(TOKEN, unitFor);
      return { text, spans: spansOf(text) };
    },
    decode: (text: string) => {
      let raw = '';
      for (const unit of text) raw += toToken.get(unit) ?? unit;
      return { raw, spans: spansOf(text) };
    }
  };
}

const toStoredOffset = (offset: number, spans: readonly TokenSpan[]): number => {
  let shift = 0;
  for (const span of spans) {
    if (offset <= span.start) break;
    if (offset < span.end) return span.rawEnd;
    shift = span.rawEnd - span.end;
  }
  return offset + shift;
};
const toHumanizedOffset = (offset: number, spans: readonly TokenSpan[]): number => {
  let shift = 0;
  for (const span of spans) {
    if (offset <= span.rawStart) break;
    if (offset < span.rawEnd) return span.end;
    shift = span.end - span.rawEnd;
  }
  return offset + shift;
};

export function deltaOps(_delta: Delta | undefined, _before: string, _after: string): TextOp[] | undefined {
  return undefined;
}

export function mergeStoredFormula(
  before: string, after: string, ours: string, selection: readonly number[], _delta?: Delta,
): { raw: string; selection: number[] } {
  const codec = createTokenCodec([before, after, ours])!;
  const base = codec.encode(before).text;
  const mine = codec.encode(ours);
  const ops = rebaseOps(base, diffText(base, codec.encode(after).text), mine.text);
  const result = codec.decode(applyOps(mine.text, ops));
  return { raw: result.raw, selection: selection.map((at) => toHumanizedOffset(mapOffset(toStoredOffset(at, mine.spans), ops), result.spans)) };
}

export function storedCaret(_raw: string, _caret: number | undefined): number | undefined {
  return undefined;
}
