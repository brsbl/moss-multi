// Stored media names (A§16): a stored name folds to itself, so a read finds exactly the file an upload named.
import { describe, expect, it } from 'vitest';
import { isDesktopDerived, mediaFilename, suffixedFilename } from './media.ts';

describe('stored media names', () => {
  it('keeps a collision suffix on a name already at the length cap, so a read of it never finds the first file', () => {
    const long = `${'a'.repeat(140)}.png`;
    const first = mediaFilename(long) ?? '';
    for (const n of [2, 10, 50]) {
      const next = suffixedFilename(first, n);
      expect(next, `suffix ${n}`).not.toBe(first);
      expect(mediaFilename(next), `suffix ${n} folds to itself`).toBe(next);
    }
  });

  it('folds a suffix whose truncated stem ends in a separator to itself', () => {
    const name = mediaFilename(`${'b'.repeat(98)}-c.png`) ?? '';
    expect(mediaFilename(suffixedFilename(name, 12))).toBe(suffixedFilename(name, 12));
  });

  it("names moss desktop's derived video thumbnails, which the web never has", () => {
    expect(isDesktopDerived('video-thumb-0123abcd.png')).toBe(true);
    expect(isDesktopDerived('thumb.png')).toBe(false);
  });
});
