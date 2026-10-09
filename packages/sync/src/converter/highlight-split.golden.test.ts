// moss's import normalization moves rich-text delimiters out of a highlight by repeating the highlight's whole opener
// around every formatted and plain run (normalize.ts, splitFormattingFromHighlightContent). The opener's style
// attribute is unbounded, so wrapper length times run count grew the line without bound before any import budget saw
// it. The split now stops before a wrapper would take the output past its bound and keeps that highlight as written;
// every highlight under the bound normalizes exactly as moss does at the pin.
import { escapeHtmlEntities, normalizeMarkdownForImport, normalizeRichTextInsideHighlightsForImport } from '@moss-desktop/renderer/editor/markdown/normalize';
import { describe, expect, it } from 'vitest';
import { CONVERTER_CASES, converterBody } from '../../measure/converter-cases.ts';
import { FIXTURES } from './fixtures.ts';

// moss at the pin (normalize.ts), the reference for highlights under the bound.
const pinSplit = (content: string, wrapSegment: (text: string) => string): string | null => {
  const delimRe = /(\*\*|~~|\*)((?:(?!\1)[^\n])+?)\1/g;
  if (!delimRe.test(content)) return null;
  delimRe.lastIndex = 0;
  let result = '';
  let lastIndex = 0;
  let match;
  while ((match = delimRe.exec(content)) !== null) {
    const [full, delimiter, innerText] = match;
    const before = content.slice(lastIndex, match.index);
    if (before) result += wrapSegment(before);
    result += wrapSegment(`${delimiter}${innerText}${delimiter}`);
    lastIndex = match.index + full.length;
  }
  const after = content.slice(lastIndex);
  if (after) result += wrapSegment(after);
  return result;
};

// Its per-segment pass; on text without backticks moss runs it on the whole text.
const pinNormalize = (segment: string): string => {
  if (!segment.includes('<mark') && !segment.includes('==')) return segment;
  let normalized = segment;
  normalized = normalized.replace(/<mark data-color="(\w+)"((?:\s+style="[^"]*")?)>([^<\n]+)<\/mark>/g,
    (fullMatch, colorName: string, styleAttribute: string, content: string) =>
      pinSplit(content, (t) => `<mark data-color="${colorName}"${styleAttribute}>${t}</mark>`) ?? fullMatch);
  normalized = normalized.replace(
    /(\{%c:[^%]+%\}|%%m:[^%]+:start%%)<mark data-color="(\w+)"((?:\s+style="[^"]*")?)>([^<\n]+)<\/mark>(\{%\/c%\}|%%m:[^%]+:end%%)/g,
    (fullMatch, openComment: string, colorName: string, styleAttribute: string, content: string, closeComment: string) => {
      const split = pinSplit(content, (t) => `<mark data-color="${colorName}"${styleAttribute}>${t}</mark>`);
      if (!split) return fullMatch;
      return split.replace(/(<mark data-color="\w+"(?:\s+style="[^"]*")?>)/, `${openComment}$1`).replace(/(<\/mark>)(?!.*<\/mark>)/, `$1${closeComment}`);
    });
  normalized = normalized.replace(/==([^=\n]+)==/g, (fullMatch, content: string) => pinSplit(content, (t) => `==${t}==`) ?? fullMatch);
  normalized = normalized.replace(/(\{%c:[^%]+%\}|%%m:[^%]+:start%%)==([^=\n]+)==(\{%\/c%\}|%%m:[^%]+:end%%)/g,
    (fullMatch, openComment: string, content: string, closeComment: string) => {
      const split = pinSplit(content, (t) => `==${t}==`);
      if (!split) return fullMatch;
      return split.replace(/(==)/, `${openComment}$1`).replace(/(==)(?!.*==)/, `$1${closeComment}`);
    });
  return normalized;
};

const TOKENS = [
  '<mark data-color="yellow">', '<mark data-color="red" style="font-family: Georgia, serif">', '<mark data-color="x" style="  ">',
  '</mark>', '==', '=', '**', '*', '~~', '~', 'a', 'b c', ' ', '\n', '<', '{%c:1%}', '{%/c%}', '%%m:1:start%%', '%%m:1:end%%',
  '[[a]]', 'https://x.y',
];

function* fuzz(count: number, seed: number): Generator<string> {
  let state = seed >>> 0;
  const next = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state;
  };
  for (let i = 0; i < count; i += 1) {
    const length = next() % 30;
    let text = '';
    for (let j = 0; j < length; j += 1) text += TOKENS[next() % TOKENS.length];
    yield text;
  }
}

const words = (n: number, word: (i: number) => string) => Array.from({ length: n }, (_, i) => word(i)).join(' ');
const HAND = [
  '<mark data-color="yellow">**bold** rest</mark>',
  '<mark data-color="yellow">**all bold**</mark>',
  '<mark data-color="red" style="font-family: Georgia, serif">*it* and ~~gone~~ and **b**</mark> tail',
  '{%c:abc%}<mark data-color="yellow">**a** b</mark>{%/c%} after',
  '%%m:id:start%%==**a** b==%%m:id:end%% after',
  '==**bold** plain *it*== and ==plain==',
  `<mark data-color="yellow">${words(40, (i) => (i % 2 ? `**w${i}**` : `w${i}`))}</mark>`,
  `==${words(60, (i) => (i % 3 ? `*w${i}*` : `w${i}`))}==`,
];

const texts = [
  ...HAND,
  ...FIXTURES.flatMap((f) => [f.markdown, ...f.markdown.split('\n')]),
  ...Object.values(CONVERTER_CASES).map((c) => converterBody(c, 2_000)),
  ...fuzz(30_000, 11),
].filter((text) => !text.includes('`'));

/** One highlight of `runs` italic runs whose style attribute is `style` characters long. */
const highlightLine = (style: number, runs: number) => `<mark data-color="yellow" style="${' '.repeat(style)}">${'*x* '.repeat(runs)}</mark>`;
/** The same as an Obsidian highlight inside a comment anchor, whose wrapper is fixed. */
const obsidianLine = (runs: number) => `%%m:id:start%%==${'*x* '.repeat(runs)}==%%m:id:end%%`;

describe('highlight normalization is bounded @p:tech-4', () => {
  it('normalizes every highlight under the bound exactly as moss does', () => {
    const differing = texts.filter((text) => normalizeRichTextInsideHighlightsForImport(text) !== pinNormalize(text)).slice(0, 5);
    expect(differing).toEqual([]);
    // The hand cases do split (the comparison is not vacuous).
    expect(normalizeRichTextInsideHighlightsForImport(HAND[0])).toBe('<mark data-color="yellow">**bold**</mark><mark data-color="yellow"> rest</mark>');
  });

  // Wrapper length and run count scaled independently, each up to 32 times: the normalized line stays within a fixed
  // multiple of the line, where moss's grew with their product.
  const cases: [string, string][] = [
    ...[256, 1_024, 4_096, 8_192].map((style): [string, string] => [`style ${style}, 1,024 runs`, highlightLine(style, 1_024)]),
    ...[256, 1_024, 4_096, 8_192].map((runs): [string, string] => [`style 1,024, ${runs} runs`, highlightLine(1_024, runs)]),
    [`comment-anchored Obsidian highlight, 1,024 runs`, obsidianLine(1_024)],
  ];
  it.each(cases)('keeps the normalized line bounded: %s', (_name, line) => {
    const started = performance.now();
    const out = escapeHtmlEntities(normalizeMarkdownForImport(line));
    expect(out.length, `${line.length} chars normalized to ${out.length}`).toBeLessThanOrEqual(9 * line.length + 1_024);
    expect(performance.now() - started).toBeLessThan(2_000);
  }, 60_000);

  it('keeps an over-budget highlight as written', () => {
    const line = highlightLine(4_096, 4_096);
    expect(normalizeRichTextInsideHighlightsForImport(line)).toBe(line);
  });

  // Past 2^20 added characters the import's own budget (perImport over NORMALIZED) leaves every further line literal,
  // so a note's highlights together add no more than that.
  it('bounds what a note of many highlights adds as a whole', () => {
    const note = Array.from({ length: 40_000 }, () => '<mark data-color="yellow">**a** b</mark>').join('\n\n');
    const out = normalizeRichTextInsideHighlightsForImport(note);
    expect(out.length - note.length).toBeLessThanOrEqual(1 << 20);
    expect(out.startsWith('<mark data-color="yellow">**a**</mark><mark data-color="yellow"> b</mark>')).toBe(true);
    expect(out.endsWith('<mark data-color="yellow">**a** b</mark>')).toBe(true);
  });
});
