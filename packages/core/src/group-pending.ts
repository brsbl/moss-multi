// The client frame discipline (docs/design/comments.md §5): on recovery or reconnect the client replays its pending
// local updates as separate frames, coalescing only runs of insert-only or of delete-only updates. An update that
// both inserts and deletes goes alone, so a deleting transaction is never merged with another one's inserts, and an
// honest delete and retype always reach the server in different frames.
import * as Y from 'yjs';

/** Stub (the red-first run of T4.0): everything pending as one frame. */
export function groupPending(updates: readonly Uint8Array[]): Uint8Array[] {
  return updates.length ? [Y.mergeUpdates([...updates])] : [];
}
