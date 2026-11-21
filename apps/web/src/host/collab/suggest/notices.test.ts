// T5.V: a suggestion or an accept refused for one of the note's limits says which (A§5.1 Limits), in the band and the
// Suggestions panel; a refusal for the state bytes keeps the room notice.
import { describe, expect, it } from 'vitest';
import { noRoomNotice, reviewRefusal } from './notices.ts';

describe('suggestion refusals name the limit @p:tech-3 @p:mean-2', () => {
  it('the band names the text or structure limit, and keeps the room notice for the bytes', () => {
    expect(noRoomNotice('text', false)).toBe(
      'This note has reached its size limit (1.02 million characters), so there is no room for more suggestions. An editor can still edit it.',
    );
    expect(noRoomNotice('structure', true)).toBe(
      'This note is too big to add to: it has too many separate lines, cells or past edits, so there is no room for more suggestions and your last changes were not saved. Continue in a new note.',
    );
    expect(noRoomNotice(null, true)).toBe('This note has no room for more suggestions, so your last changes were not saved. An editor can still edit it.');
    expect(noRoomNotice('state', false)).toBe('This note has no room for more suggestions. An editor can still edit it.');
  });

  it('an accept refused for a limit says which', () => {
    expect(reviewRefusal('doc-cap', 'text')).toBe('Accepting it would take the note past its size limit (1.02 million characters).');
    expect(reviewRefusal('doc-cap', 'structure')).toBe('Accepting it would make the note too big: it would have too many separate lines, cells or past edits.');
    expect(reviewRefusal('doc-cap')).toBe('Accepting it would make the note too large.');
    expect(reviewRefusal('doc-cap', 'bogus')).toBe('Accepting it would make the note too large.');
    expect(reviewRefusal('outdated', 'text')).toBe('The text it changes was edited since, so it can no longer be applied.');
  });
});
