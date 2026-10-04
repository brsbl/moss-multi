// The client frame discipline (docs/design/comments.md §6): on recovery or reconnect the client replays its pending
// local updates as separate frames, coalescing only runs of insert-only or of delete-only updates. An update that
// both inserts and deletes goes alone, so a deleting transaction is never merged with another one's inserts, and an
// honest delete and retype always reach the server in different frames.
import * as Y from 'yjs';

type Kind = 'insert' | 'delete' | 'mixed' | 'empty';

function kindOf(update: Uint8Array): Kind {
  const { structs, ds } = Y.decodeUpdate(update);
  const inserts = structs.some((struct) => !(struct instanceof Y.Skip));
  const deletes = [...ds.clients.values()].some((ranges) => ranges.some((range) => range.len > 0));
  if (inserts && deletes) return 'mixed';
  if (inserts) return 'insert';
  return deletes ? 'delete' : 'empty';
}

/** The frames to send for `updates`, in order. */
export function groupPending(updates: readonly Uint8Array[]): Uint8Array[] {
  const frames: Uint8Array[] = [];
  let run: Uint8Array[] = [];
  let runKind: Kind | null = null;
  const close = () => {
    if (run.length) frames.push(run.length === 1 ? run[0] : Y.mergeUpdates(run));
    run = [];
    runKind = null;
  };
  for (const update of updates) {
    const kind = kindOf(update);
    if (kind === 'empty') continue;
    if (kind === 'mixed' || kind !== runKind) close();
    run.push(update);
    runKind = kind === 'mixed' ? null : kind;
    if (kind === 'mixed') close();
  }
  close();
  return frames;
}
