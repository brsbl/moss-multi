// T3.B32: a large paste cut short by a limit is rolled back. A refused session stores each paste it was still
// sending here, keyed by doc, client id and the paste's first clock, and the session that binds the server's copy
// next settles it (rolls it back, or sends the deletes of one that landed whole); the entry stays until that is acked,
// so reopening the note in this browser profile resumes an interrupted rollback.
import { isPasteRecord, type PasteRecord } from '@moss-multi/sync/paste-rollback';

export const PASTE_ROLLED_BACK = "The paste didn't fit, so nothing was pasted.";

const PREFIX = 'moss-multi:paste-rollback:';

/** A stored paste, with where the pane was scrolled when it began. */
export type StoredPaste = PasteRecord & { scrollTop?: number };

export const rollbackKey = (docId: string, client: number, from: number): string => `${PREFIX}${docId}:${client}:${from}`;

/** Records this tab could not store, so its next binding still settles them. */
const unstored = new Map<string, StoredPaste>();

/** Stores `record` under `key`, replacing what was there. */
export function saveRollback(key: string, record: StoredPaste): void {
  try {
    localStorage.setItem(key, JSON.stringify(record));
    unstored.delete(key);
  } catch {
    // no local store, or it is full: the rollback still runs in this tab's next binding
    unstored.set(key, record);
  }
}

/** Stores a paste of `docId` under its own key; returns the key. */
export function storeRollback(docId: string, record: StoredPaste): string {
  const key = rollbackKey(docId, record.note.client, record.note.from);
  saveRollback(key, record);
  return key;
}

/** The stored rollbacks of `docId`, by key. */
export function storedRollbacks(docId: string): Map<string, StoredPaste> {
  const found = new Map<string, StoredPaste>();
  const prefix = `${PREFIX}${docId}:`;
  for (const [key, record] of unstored) if (key.startsWith(prefix)) found.set(key, record);
  try {
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (!key?.startsWith(prefix) || found.has(key)) continue;
      let record: unknown = null;
      try {
        record = JSON.parse(localStorage.getItem(key) ?? 'null');
      } catch {
        // unreadable: dropped below
      }
      if (isPasteRecord(record)) found.set(key, record);
      else {
        localStorage.removeItem(key);
        i -= 1;
      }
    }
  } catch {
    // no local store
  }
  return found;
}

export function dropRollback(key: string): void {
  unstored.delete(key);
  try {
    localStorage.removeItem(key);
  } catch {
    // no local store
  }
}
