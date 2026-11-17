// T3.B32: a large paste cut short by a limit is rolled back. A refused session stores the paste's items here, keyed
// by doc and client id, and the session that binds the server's copy next deletes the part that landed; the entry
// stays until those deletes are acked, so reopening the note in this browser profile resumes an interrupted rollback.
import { isPasteRecord, type PasteRecord } from '@moss-multi/sync/paste-rollback';

export const PASTE_ROLLED_BACK = "The paste didn't fit, so nothing was pasted.";

const PREFIX = 'moss-multi:paste-rollback:';

export const rollbackKey = (docId: string, client: number): string => `${PREFIX}${docId}:${client}`;

export function storeRollback(docId: string, record: PasteRecord): void {
  try {
    localStorage.setItem(rollbackKey(docId, record.note.client), JSON.stringify(record));
  } catch {
    // no local store: the rollback still runs in this tab's next binding
    unstored.set(rollbackKey(docId, record.note.client), record);
  }
}

/** Records this tab could not store, so its next binding still rolls them back. */
const unstored = new Map<string, PasteRecord>();

/** The stored rollbacks of `docId`, by key. */
export function storedRollbacks(docId: string): Map<string, PasteRecord> {
  const found = new Map<string, PasteRecord>();
  const prefix = `${PREFIX}${docId}:`;
  for (const [key, record] of unstored) if (key.startsWith(prefix)) found.set(key, record);
  try {
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (!key?.startsWith(prefix)) continue;
      let record: unknown = null;
      try {
        record = JSON.parse(localStorage.getItem(key) ?? 'null');
      } catch {
        // unreadable: dropped below
      }
      if (isPasteRecord(record)) found.set(key, record);
      else localStorage.removeItem(key);
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
