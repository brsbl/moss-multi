import { describe, expect, it } from 'vitest';
import { buildFtsMatch, extractWikiLinks, makeSnippet, parseHeadings, scoreEntry, wikiKey } from './search-core.ts';

describe('search core (A§5.3)', () => {
  it('extracts wiki keys by title slug, never from an embed or a same-note heading', () => {
    expect(extractWikiLinks('See [[Launch Plan]], [[Launch Plan#Risks]], [[launch-plan|n1]] and [[Café Notes]].')).toEqual(['launch-plan', 'café-notes']);
    expect(extractWikiLinks('![[ref.png|100x200]] and [[#Comments]]')).toEqual([]);
    expect(wikiKey('  Launch: Plan! ')).toBe('launch-plan');
  });

  it('quotes every token so a query is never FTS syntax', () => {
    expect(buildFtsMatch('foo OR "bar" NEAR(x)')).toBe('"foo"* "or"* "bar"* "near"* "x"*');
    expect(buildFtsMatch('  -- ')).toBeNull();
  });

  it('snippets text around the match, as moss does, with no markers', () => {
    const body = `# Heading\n\n${'lead '.repeat(10)}a **quokka** grazing [by the river](https://x.example) at dusk.`;
    const snippet = makeSnippet(body, 'quokka');
    expect(snippet.startsWith('...')).toBe(true);
    expect(snippet).toContain('**quokka** grazing by the river at dusk.');
    expect(snippet).not.toMatch(/[«»#]|object Object/);
    expect(makeSnippet('short body', 'absent')).toBe('short body');
  });

  it('ranks title hits over body hits and needs every token', () => {
    expect(scoreEntry('Quokka', 'none', ['quokka'])).toBeGreaterThan(scoreEntry('Other', 'quokka quokka', ['quokka']));
    expect(scoreEntry('Quokka', 'x', ['quokka', 'absent'])).toBe(0);
  });

  it('reads h1–h4 headings outside code, links stripped', () => {
    expect(parseHeadings('# One\n```\n# not\n```\n## Two [[Launch Plan]]\n##### five')).toEqual([
      { level: 1, text: 'One' }, { level: 2, text: 'Two Launch Plan' },
    ]);
  });
});
