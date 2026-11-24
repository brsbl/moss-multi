// What a Suggest pane does once a refusal has closed its input (docs/design/suggestions.md §5): rebuild F on a new
// socket and fork, or keep the note read-only.
import type { SuggestRefusal } from '@moss-multi/protocol/suggest';

/** Refusals that mean the note has no room for more suggestions (T5.S4): retrying in a new F would be refused too. */
export const NO_SUGGESTION_ROOM: ReadonlySet<SuggestRefusal> = new Set<SuggestRefusal>(['doc-cap', 'ops-cap']);

export interface AfterRefusal {
  /** F is rebuilt and remounted once the DocDO has answered everything in flight. */
  rebuild: boolean;
  /** The note has no room for more suggestions: input stays closed in the rebuilt F until the mode changes. */
  noRoom: boolean;
}

/**
 * `noRoom`: the pane met a no-room refusal before; `ready`: F had its first lease. A note with no room rebuilds nothing
 * once its F is refused again or was refused its first lease (F then fills read-only).
 */
export function afterRefusal(reason: SuggestRefusal, { noRoom, ready }: { noRoom: boolean; ready: boolean }): AfterRefusal {
  const full = NO_SUGGESTION_ROOM.has(reason);
  return { rebuild: !(full && (noRoom || !ready)), noRoom: noRoom || full };
}
