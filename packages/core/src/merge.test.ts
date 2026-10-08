// T7.2: the push's three-way text merge never consumes concurrent human work. A pushed hunk whose base region the
// human changed is returned as failed and the human's text stays; every failed hunk is reported, however long; and
// non-ASCII text never throws. @p:agt-1 @p:tech-5
import { describe, expect, it } from 'vitest';
import { computeMergedTarget } from './merge.ts';

describe('computeMergedTarget keeps concurrent human edits @p:agt-1', () => {
  it('refuses a deletion over text the human typed into, and keeps the human\'s text', () => {
    const base = 'The quick brown fox.\n\nThe rest stays.';
    const current = 'The quick red brown fox.\n\nThe rest stays.';
    const next = 'The fox.\n\nThe rest stays.';
    const merge = computeMergedTarget(current, base, next);
    expect(merge.target).toBe(current);
    expect(merge.failedHunks).toHaveLength(1);
  });

  it('refuses a rewrite of a sentence the human also rewrote, and lands the agent\'s other edit', () => {
    const base = 'We are planting beans peas and squash this spring.\n\nWater at dawn.\n\nHarvest in autumn.';
    const current = base.replace('planting beans peas and squash', 'sowing only tomatoes and basil!');
    const next = base.replace('We are planting beans peas and squash this spring.', 'This spring the plan is beans first.').replace('Harvest in autumn.', 'Harvest in late autumn.');
    const merge = computeMergedTarget(current, base, next);
    expect(merge.target).toContain('sowing only tomatoes and basil!');
    expect(merge.target).toContain('Harvest in late autumn.');
    expect(merge.target).toContain('Water at dawn.');
    expect(merge.failedHunks).toHaveLength(1);
  });

  it('never places a hunk in an untouched paragraph when the human rewrote the one it edits', () => {
    const base = 'Alpha paragraph one has some words.\n\nBeta paragraph two has other words too.';
    const current = 'ONE HAS SOME DIFFERENT WORDS ENTIRELY NOW.\n\nBeta paragraph two has other words too.';
    const next = 'Alpha paragraph one has some new words.\n\nBeta paragraph two has other words too.';
    const merge = computeMergedTarget(current, base, next);
    expect(merge.target).toBe(current);
    expect(merge.failedHunks.length).toBeGreaterThan(0);
  });

  it('reports a long failed hunk, and only that one, when another long hunk lands', () => {
    const first = 'This first sentence is long enough that its replacement spans far more than thirty two characters.';
    const second = 'The second sentence is also long, so that any patch over it is split into several internal pieces.';
    const base = `${first}\n\n${second}\n\nTail.`;
    const current = base.replace('also long', 'also very long indeed');
    const next = base
      .replace(first, 'A rewritten first sentence, which differs from the original in nearly every single word.')
      .replace(second, 'A rewritten second sentence, which a person was editing while the agent pushed this file.');
    const merge = computeMergedTarget(current, base, next);
    expect(merge.failedHunks).toHaveLength(1);
    expect(merge.failedHunks[0]).toContain('rewritten second sentence');
    expect(merge.target).toContain('A rewritten first sentence');
    expect(merge.target).toContain('also very long indeed');
  });

  it('merges non-overlapping edits in one paragraph and applies an edit both sides made once', () => {
    const base = 'Broad beans first, then peas, then squash.';
    const current = 'Broad beans first, then peas, then squash and basil.';
    const next = 'Fava beans first, then peas, then squash.';
    expect(computeMergedTarget(current, base, next)).toMatchObject({ target: 'Fava beans first, then peas, then squash and basil.', failedHunks: [] });
    expect(computeMergedTarget(next, base, next)).toMatchObject({ target: next, failedHunks: [] });
  });

  it('merges around accented and emoji text without throwing', () => {
    expect(computeMergedTarget('éabcdefghij', 'abcdefghij', 'abcdeFghij')).toMatchObject({ target: 'éabcdeFghij', failedHunks: [] });
    expect(computeMergedTarget('😀 café\n\nb', 'café\n\nb', 'café\n\nb 🌱')).toMatchObject({ target: '😀 café\n\nb 🌱', failedHunks: [] });
  });

  it('ignores a final newline the pushed file adds: typing at the end of the last paragraph stays in it', () => {
    const base = 'Water at dawn.\n\nHarvest in autumn.';
    const current = `${base} Pick squash`;
    expect(computeMergedTarget(current, base, 'Water at dawn.\n\nHarvest in late autumn.\n'))
      .toMatchObject({ target: 'Water at dawn.\n\nHarvest in late autumn. Pick squash', failedHunks: [] });
    expect(computeMergedTarget(current, base, 'Water at noon.\n\nHarvest in autumn.\n'))
      .toMatchObject({ target: 'Water at noon.\n\nHarvest in autumn. Pick squash', failedHunks: [] });
    expect(computeMergedTarget(base, base, `${base}\n`)).toMatchObject({ target: base, failedHunks: [], applied: 0 });
  });
});
