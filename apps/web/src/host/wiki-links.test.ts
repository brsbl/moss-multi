import { afterEach, expect, it } from 'vitest';
import { resolveWikiTarget, setWikiCandidates } from './wiki-links.ts';

afterEach(() => setWikiCandidates(() => []));

it('resolves a wiki target by normalized title, then filename stem, and nothing else (A§15) @p:note-1 @p:R3', () => {
  setWikiCandidates(() => [
    { id: 'a', title: 'Launch Plan', filename: 'launch-plan.md' },
    { id: 'b', title: 'Launch Plan', filename: 'launch-plan-2.md' },
    { id: 'c', title: 'Q3: Goals!', filename: 'q3-goals.md' },
  ]);
  expect(resolveWikiTarget('launch plan')).toBe('a');
  expect(resolveWikiTarget('launch-plan-2')).toBe('b');
  expect(resolveWikiTarget('Q3 goals')).toBe('c');
  expect(resolveWikiTarget('Nowhere')).toBeNull();
  expect(resolveWikiTarget('  !! ')).toBeNull();
});

it('resolves within the source note’s vault: a doc surfaced from another vault never wins for an in-vault note (A§15)', () => {
  setWikiCandidates(() => [
    { id: 'away', title: 'Launch Plan', filename: 'launch-plan.md', surfaced: true },
    { id: 'src', title: 'Kickoff', filename: 'kickoff.md' },
    { id: 'home', title: 'Launch plan', filename: 'launch-plan-2.md' },
    { id: 'only-away', title: 'Elsewhere', filename: 'elsewhere.md', surfaced: true },
  ]);
  expect(resolveWikiTarget('launch plan', 'src')).toBe('home');
  expect(resolveWikiTarget('elsewhere', 'src')).toBeNull();
  expect(resolveWikiTarget('launch plan', 'away'), 'a surfaced source keeps the whole listing').toBe('away');
});
