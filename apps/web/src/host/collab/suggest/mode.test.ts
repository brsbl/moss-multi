import { describe, expect, it } from 'vitest';
import { dismissUnsaved, modeFor, offerUnsaved, pausedMode, requestMode, reviewReturn, setOpenSuggestions, showMode, unsavedOf } from './mode.ts';

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

describe('T9.33 Done returns to the mode Review paused @p:mean-2 @p:R17', () => {
  it('an editor who was suggesting goes back to Suggest, by Done and by the last decision', () => {
    setOpenSuggestions('doc-h', 1);
    requestMode('doc-h', 'suggest');
    showMode('doc-h', 'suggest');
    requestMode('doc-h', 'review');
    showMode('doc-h', 'review');
    expect(pausedMode('doc-h', 'editor')).toBe('suggest');
    expect(reviewReturn('doc-h', 'editor')).toBe('suggest');
    setOpenSuggestions('doc-h', 0);
    expect(modeFor('doc-h', 'editor')).toBe('suggest');
  });

  it('an editor who was editing goes back to Edit; a suggester always to Suggest; a reader to the plain note', () => {
    setOpenSuggestions('doc-i', 1);
    showMode('doc-i', 'edit');
    requestMode('doc-i', 'review');
    expect(pausedMode('doc-i', 'editor')).toBe('edit');
    expect(reviewReturn('doc-i', 'owner')).toBe('edit');
    expect(reviewReturn('doc-i', 'suggester')).toBe('suggest');
    expect(pausedMode('doc-i', 'suggester')).toBe('suggest');
    expect(reviewReturn('doc-i', 'viewer')).toBe('edit');
    expect(reviewReturn('doc-i', 'commenter')).toBe('edit');
    expect(pausedMode('doc-i', 'viewer')).toBe(null);
  });

  it('a lowered role recomputes the return from the current role, not the remembered one', () => {
    setOpenSuggestions('doc-j', 1);
    showMode('doc-j', 'suggest');
    requestMode('doc-j', 'suggest');
    requestMode('doc-j', 'review');
    expect(reviewReturn('doc-j', 'commenter')).toBe('edit');
    expect(pausedMode('doc-j', 'commenter')).toBe(null);
  });
});

describe('T9.41 each closed suggestion\'s unsaved text is its own payload', () => {
  it('dismissing one leaves the other byte for byte, and nothing else clears them', () => {
    const first = ['Line one\n  indented', 'Second block'];
    const second = ['Another fork’s text\twith a tab'];
    offerUnsaved('doc-unsaved', first);
    offerUnsaved('doc-unsaved', second);
    const held = unsavedOf('doc-unsaved');
    expect(held.map((payload) => payload.blocks)).toEqual([first, second]);
    expect(new Set(held.map((payload) => payload.id)).size).toBe(2);
    dismissUnsaved('doc-unsaved', held[0].id);
    expect(unsavedOf('doc-unsaved').map((payload) => payload.blocks)).toEqual([second]);
    expect(unsavedOf('doc-unsaved')[0].blocks.join('\n\n')).toBe('Another fork’s text\twith a tab');
    dismissUnsaved('doc-unsaved', held[1].id);
    expect(unsavedOf('doc-unsaved')).toEqual([]);
  });
});
