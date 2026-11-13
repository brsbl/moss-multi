import { describe, expect, it } from 'vitest';
import { modeFor, requestMode, setOpenSuggestions } from './mode.ts';

describe('T5.1 each role opens in its mode (PRODUCT ruling 17) @p:mean-2 @p:R17', () => {
  it('viewers and commenters open in Review; suggesters in Suggest; editors and owners in Edit', () => {
    expect(modeFor('doc-a', 'viewer')).toBe('review');
    expect(modeFor('doc-a', 'commenter')).toBe('review');
    expect(modeFor('doc-a', 'suggester')).toBe('suggest');
    expect(modeFor('doc-a', 'editor')).toBe('edit');
    expect(modeFor('doc-a', 'owner')).toBe('edit');
  });

  it('a viewer may leave Review for the plain body, and any role may choose Review while a suggestion is open', () => {
    requestMode('doc-b', 'edit');
    expect(modeFor('doc-b', 'viewer')).toBe('edit');
    setOpenSuggestions('doc-c', 1);
    requestMode('doc-c', 'review');
    expect(modeFor('doc-c', 'editor')).toBe('review');
    expect(modeFor('doc-c', 'suggester')).toBe('review');
  });
});

describe('T9.1 Review needs an open suggestion for those who can edit or suggest @p:mean-2 @p:R17', () => {
  it('with no open suggestion, asking for Review leaves an owner, editor or suggester in their own mode', () => {
    setOpenSuggestions('doc-d', 0);
    requestMode('doc-d', 'review');
    expect(modeFor('doc-d', 'owner')).toBe('edit');
    expect(modeFor('doc-d', 'editor')).toBe('edit');
    expect(modeFor('doc-d', 'suggester')).toBe('suggest');
    // Nor before the note has said how many are open.
    requestMode('doc-unsynced', 'review');
    expect(modeFor('doc-unsynced', 'editor')).toBe('edit');
  });

  it('the last open suggestion decided clears the choice, so the next one does not bring Review back', () => {
    setOpenSuggestions('doc-e', 1);
    requestMode('doc-e', 'review');
    expect(modeFor('doc-e', 'editor')).toBe('review');
    setOpenSuggestions('doc-e', 0);
    expect(modeFor('doc-e', 'editor')).toBe('edit');
    expect(modeFor('doc-e', 'suggester')).toBe('suggest');
    setOpenSuggestions('doc-e', 1);
    expect(modeFor('doc-e', 'editor')).toBe('edit');
  });

  it("a viewer's and commenter's mode does not follow the count", () => {
    for (const count of [0, 2, 0]) {
      setOpenSuggestions('doc-f', count);
      expect(modeFor('doc-f', 'viewer')).toBe('review');
      expect(modeFor('doc-f', 'commenter')).toBe('review');
    }
    setOpenSuggestions('doc-g', 1);
    requestMode('doc-g', 'edit');
    setOpenSuggestions('doc-g', 0);
    expect(modeFor('doc-g', 'viewer')).toBe('edit');
  });
});
