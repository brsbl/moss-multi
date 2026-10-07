// Adversarial notes for the converter: runs of an opener with no closer, and one paragraph of many matches.
// scripts/measure-converter.mjs holds their import and export in workerd to the SP2 budget and to linear growth; L3
// holds their output to pristine moss.

export interface ConverterCase {
  /** Repeated to the note's size. */
  run: string;
  /** Before the run; a word by default, so the run sits inside a paragraph. */
  before?: string;
  /** After the run. */
  after?: string;
  /** Repeated after `after`; the run and the tail then share the note's size. */
  tail?: string;
  /**
   * Sizes L3 compares with moss (default 40 and 3,000 bytes). Smaller for cases whose matching is inherently
   * quadratic in moss (nesting), or that take more work per byte than markdown/linear-import.ts allows a line
   * (dense short matches, tabs): the import keeps longer lines of them literally.
   */
  parityBytes?: number[];
}

export const CONVERTER_CASES: Record<string, ConverterCase> = {
  'brackets [': { run: '[' },
  'wiki openers [[': { run: '[[' },
  'tag openers <': { run: '<' },
  'comment openers <!--': { run: '<!--' },
  'image openers ![': { run: '![' },
  'link tails ](': { run: '](' },
  'asterisks *': { run: '*' },
  'underscores _': { run: '_' },
  'backticks `': { run: '`' },
  'tildes ~~': { run: '~~' },
  'dollars $': { run: '$' },
  'highlights ==': { run: '==' },
  'comment markers %%': { run: '%%' },
  'pill openers ?[': { run: '?[' },
  'labels [a': { run: '[a' },
  'empty links [](': { run: '[](' },
  'wiki openers [[a|': { run: '[[a|' },
  'URL labels [http://': { run: '[http://' },
  'image lines ![a](': { run: '![a](', before: '' },
  'indent before a word': { run: ' ', before: '', after: 'x' },
  // Lexical's export split each text node with /^(\s*)(.*?)(\s*)$/s, quadratic on a whitespace run inside it.
  'whitespace between words': { run: ' ', after: 'x' },
  tabs: { run: '\t', after: 'x', parityBytes: [40, 50] },
  'divider then whitespace': { run: ' ', before: '|-|-', after: 'x' },
  'pill openers ?[ before one destination': { run: '?[', after: '](', tail: 'a' },
  'formatted pill openers *?[ before one destination': { run: '*?[', after: '](', tail: 'a' },
  'URL labels [http:// before one destination': { run: '[http://', after: '](', tail: 'a' },
  'URL labels [http://a before one destination': { run: '[http://a', after: '](', tail: 'a' },
  'raw URLs': { run: 'http://a ', parityBytes: [40, 1_500] },
  'embeddable URLs': { run: 'https://example.com ' },
  'escaped backticks before URLs': { run: '\\` https://example.com ' },
  'URL with closing brackets': { run: ')', before: 'quokka http://a' },
  'emphasis spans': { run: '*a* ', parityBytes: [40, 300] },
  'code spans': { run: '`a` ', parityBytes: [40, 300] },
  links: { run: '[a](b) ', parityBytes: [40, 300] },
  'wiki links': { run: '[[a]] ', parityBytes: [40, 300] },
  colors: { run: '#ff0000 ' },
  'nested emphasis': { run: '*x _x ', after: 'y', tail: ' x_ x*', parityBytes: [40, 120] },
  // Openers moss's import normalization rescanned from (markdown/normalize.ts).
  'escaped blockquote openers': { run: '&lt;blockquote ' },
  'formatted wiki-link openers': { run: '*[[a', parityBytes: [40, 300] },
  'isolated asterisks after a URL': { run: ' *a', before: 'quokka https://example.com', parityBytes: [40, 300] },
};

/** The case's markdown, `bytes` long or just over. */
export function converterBody(c: ConverterCase, bytes: number): string {
  const before = c.before ?? 'quokka ';
  const after = c.after ?? '';
  const room = bytes - before.length - after.length;
  const runBytes = c.tail ? room / 2 : room;
  const tail = c.tail ? c.tail.repeat(Math.max(1, Math.ceil(runBytes / c.tail.length))) : '';
  return `${before}${c.run.repeat(Math.max(1, Math.ceil(runBytes / c.run.length)))}${after}${tail}`;
}

// Ordinary notes that moss converts in full: the import's work budget must never cut them, and L3 holds each to
// moss byte for byte. (The 2 MB note of mixed content is the scale note, fixtures.ts.)
const range = (n: number) => Array.from({ length: n }, (_, i) => i);
const hex = (i: number) => `#${((Math.imul(i + 1, 2654435761) >>> 8) & 0xffffff).toString(16).padStart(6, '0')}`;
const palette = (n: number) => `Palette: ${range(n).map(hex).join(' ')}`;

export const ORDINARY_NOTES: Record<string, () => string> = {
  'a paragraph of 2,000 links, each followed by bold': () => `${range(2_000).map((i) => `[p${i}](https://e.com/${i}) **x${i}**`).join(' ')}\n\nAfter para.`,
  'a palette paragraph of 250 colors': () => palette(250),
  'a palette paragraph of 2,000 colors': () => palette(2_000),
  'a palette paragraph of 500 colors after a link and a code span': () => `See [the guide](https://e.com/guide) and \`tokens\`: ${range(500).map(hex).join(' ')}`,
  'a palette paragraph of 2,000 named hex, rgb and hsl colors': () =>
    range(2_000).map((i) => (i % 3 === 0 ? `${hex(i)} shade ${i},` : i % 3 === 1 ? `rgb(${i % 256}, 40, 80) tone,` : `hsl(${i % 360}, 50%, 50%) hue,`)).join(' '),
  'a paragraph of 1,000 wiki links': () => `See ${range(1_000).map((i) => `[[Note ${i}]]`).join(', ')}.`,
  'a paragraph of 600 links whose URLs hold underscores and parentheses': () =>
    `Sources: ${range(600).map((i) => `[Python ${i}](https://en.wikipedia.org/wiki/Python_(programming_language)_${i})`).join(' ')}`,
  'a paragraph of 1,000 sentences of italic, bold, code and strikethrough': () =>
    range(1_000).map((i) => `Some *italic ${i}* and **bold** text with \`code ${i}\` and ~~struck~~ words.`).join(' '),
  'a paragraph of 1,000 raw URLs': () => `Links: ${range(1_000).map((i) => `https://example.com/page/${i}`).join(' and ')}`,
  'a paragraph of 500 serif spans': () => `x ${range(500).map((i) => `<span style="font-family: serif">a${i}</span>`).join(' ')}`,
  'a table of 2,000 rows': () =>
    ['| Item | Link | Color | Note |', '| --- | --- | --- | --- |', ...range(2_000).map((i) => `| **i${i}** | [l${i}](https://e.com/${i}) | ${hex(i)} | \`c${i}\` and *n${i}* |`)].join('\n'),
};

// Ordinary notes of 2 MB (or `size`) in short paragraphs, which moss converts in linear time: no budget may cut
// them, however many matches they hold in all. L3 leaves them out (moss takes minutes on 2 MB in jsdom); the golden
// test holds them to Lexical's own import, and measure-converter.mjs holds them to linear growth in workerd.
const paragraphs = (paragraph: (i: number) => string, size: number) => {
  const out: string[] = [];
  for (let i = 0, bytes = 0; bytes < size; i += 1) {
    out.push(paragraph(i));
    bytes += out[i].length + 2;
  }
  return out.join('\n\n');
};

// 2 MB (or `size`) of the densest ordinary text, a palette paragraph of 2,000 colors (8 bytes and three nodes a
// color), each line close to markdown/linear-import.ts's work per byte: every line converts, and the note is held to
// SP2's budget as LARGE_ORDINARY_NOTES are.
export const NEAR_BUDGET_NOTES: Record<string, (size?: number) => string> = {
  '2 MB of palette paragraphs of 2,000 colors': (size = 2 * 1024 * 1024) => paragraphs(() => palette(2_000), size),
};

export const LARGE_ORDINARY_NOTES: Record<string, (size?: number) => string> = {
  '2 MB of paragraphs of ten links, each followed by bold': (size = 2 * 1024 * 1024) =>
    paragraphs((p) => range(10).map((i) => `[p${p}.${i}](https://e.com/${p}/${i}) **x${i}**`).join(' '), size),
  '2 MB of paragraphs of ten wiki links and colors': (size = 2 * 1024 * 1024) =>
    paragraphs((p) => range(10).map((i) => `[[Note ${p}.${i}]] ${hex(p * 10 + i)}`).join(', '), size),
};
