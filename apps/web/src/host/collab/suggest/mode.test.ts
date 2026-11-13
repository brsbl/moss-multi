import { describe, expect, it } from 'vitest';
import { modeFor, requestMode } from './mode.ts';

describe('T5.1 each role opens in its mode (PRODUCT ruling 17) @p:mean-2 @p:R17', () => {
  it('viewers and commenters open in Review; suggesters in Suggest; editors and owners in Edit', () => {
    expect(modeFor('doc-a', 'viewer')).toBe('review');
    expect(modeFor('doc-a', 'commenter')).toBe('review');
    expect(modeFor('doc-a', 'suggester')).toBe('suggest');
    expect(modeFor('doc-a', 'editor')).toBe('edit');
    expect(modeFor('doc-a', 'owner')).toBe('edit');
  });

  it('a viewer may leave Review for the plain body, and any role may choose Review', () => {
    requestMode('doc-b', 'edit');
    expect(modeFor('doc-b', 'viewer')).toBe('edit');
    requestMode('doc-c', 'review');
    expect(modeFor('doc-c', 'editor')).toBe('review');
    expect(modeFor('doc-c', 'suggester')).toBe('review');
  });
});
