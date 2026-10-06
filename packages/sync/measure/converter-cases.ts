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
   * quadratic in moss (nesting, callbacks that read the paragraph), which the import cuts off at a work budget.
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
  'divider then whitespace': { run: ' ', before: '|-|-', after: 'x' },
  'pill openers ?[ before one destination': { run: '?[', after: '](', tail: 'a' },
  'formatted pill openers *?[ before one destination': { run: '*?[', after: '](', tail: 'a' },
  'URL labels [http:// before one destination': { run: '[http://', after: '](', tail: 'a' },
  'URL labels [http://a before one destination': { run: '[http://a', after: '](', tail: 'a' },
  'raw URLs': { run: 'http://a ' },
  'embeddable URLs': { run: 'https://example.com ' },
  'escaped backticks before URLs': { run: '\\` https://example.com ' },
  'URL with closing brackets': { run: ')', before: 'quokka http://a' },
  'emphasis spans': { run: '*a* ' },
  'code spans': { run: '`a` ' },
  links: { run: '[a](b) ' },
  'wiki links': { run: '[[a]] ' },
  colors: { run: '#ff0000 ', parityBytes: [40, 600] },
  'nested emphasis': { run: '*x _x ', after: 'y', tail: ' x_ x*', parityBytes: [40, 400] },
  // Openers moss's import normalization rescanned from (markdown/normalize.ts).
  'escaped blockquote openers': { run: '&lt;blockquote ' },
  'formatted wiki-link openers': { run: '*[[a' },
  'isolated asterisks after a URL': { run: ' *a', before: 'quokka https://example.com' },
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
