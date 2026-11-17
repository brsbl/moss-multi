// What Suggest mode and the Suggestions panel say when a suggestion is refused.
import type { DocLimit } from '@moss-multi/protocol/sync';

/** The band's notice once the DocDO refused a suggestion for want of room; `unsaved`: changes were offered back. */
export function noRoomNotice(_limit: DocLimit | null, unsaved: boolean): string {
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

/** Why a review action was refused, as the panel says it. */
export function reviewRefusal(reason: string, _limit?: unknown): string {
  return REASONS[reason] ?? 'It could not be applied.';
}
