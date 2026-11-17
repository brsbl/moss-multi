// What Suggest mode and the Suggestions panel say when a suggestion is refused, naming the note limit it met
// (A§5.1 Limits) beside the room the state bytes leave.
import type { DocLimit } from '@moss-multi/protocol/sync';

/** The band's notice once the DocDO refused a suggestion for want of room; `unsaved`: changes were offered back. */
export function noRoomNotice(limit: DocLimit | null, unsaved: boolean): string {
  const lost = unsaved ? ' and your last changes were not saved' : '';
  if (limit === 'text') {
    return `This note has reached its size limit (1.02 million characters), so there is no room for more suggestions${lost}. An editor can still edit it.`;
  }
  if (limit === 'structure') {
    return `This note is too big to add to: it has too many separate lines, cells or past edits, so there is no room for more suggestions${lost}. Continue in a new note.`;
  }
  return `This note has no room for more suggestions${unsaved ? ', so your last changes were not saved' : ''}. An editor can still edit it.`;
}

const REASONS: Record<string, string> = {
  outdated: 'The text it changes was edited since, so it can no longer be applied.',
  broken: 'It cannot be shown in the note.',
  changed: 'It changed while you reviewed it. Look again before accepting.',
  'not-open': 'It was already reviewed.',
  'doc-cap': 'Accepting it would make the note too large.',
  'rate-limited': 'Too many reviews at once. Try again in a minute.',
  role: "You can't review this suggestion.",
  forbidden: "You can't review this suggestion.",
  unavailable: 'Its changes could not be loaded.',
};

const LIMITS: Record<string, string> = {
  text: 'Accepting it would take the note past its size limit (1.02 million characters).',
  structure: 'Accepting it would make the note too big: it would have too many separate lines, cells or past edits.',
};

/** Why a review action was refused, as the panel says it; `limit` is the note limit a `doc-cap` accept met. */
export function reviewRefusal(reason: string, limit?: unknown): string {
  if (reason === 'doc-cap' && typeof limit === 'string' && Object.hasOwn(LIMITS, limit)) return LIMITS[limit];
  return Object.hasOwn(REASONS, reason) ? REASONS[reason] : 'It could not be applied.';
}
