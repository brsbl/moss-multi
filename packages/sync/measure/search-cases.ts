// Adversarial bodies for the search index: runs of an opener with no closer. Every scan over them in scripts/measure-
// converter.mjs must stay within the per-request CPU budget and grow linearly with the run.

/** Each case is one opener repeated to the run's length, after a word the search can hit. */
export const SEARCH_CASES: Record<string, string> = {
  'open brackets [': '[',
  'wiki openers [[a|': '[[a|',
  'tag openers <': '<',
  'comment openers <!--': '<!--',
  'link openers [](': '[](',
  'link tails ](': '](',
};

export const searchBody = (opener: string, chars: number): string => `quokka ${opener.repeat(Math.ceil(chars / opener.length))}`;
