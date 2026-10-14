// The DocDO's title writes from outside its sockets (create, a REST rename), apart from server-doc.ts so the
// measurement Worker can time them without the converter.
import * as Y from 'yjs';
import { writeField } from '@moss-multi/core/doc-fields';
import { SERVER_CELL_BUDGET } from '@moss-multi/core/text-diff';

/**
 * A minimal diff of caller text into Y.Text('title') that every open client merges. The text is the caller's, so
 * it diffs within the server budget: a long or adversarial title degrades to a coarser edit, never a CPU spike.
 */
export function writeTitle(live: Y.Doc, text: string, origin: unknown): boolean {
  return writeField(live, 'title', text, origin, SERVER_CELL_BUDGET);
}

/**
 * The update writeTitle would make, made on a copy under the live doc's own client id so the state cap can admit it
 * before the live doc changes (A§5.1 Limits); null when the title is already `text`.
 */
export function titleDiff(live: Y.Doc, text: string): Uint8Array | null {
  if (live.getText('title').toString() === text) return null;
  const mirror = new Y.Doc({ gc: live.gc });
  mirror.clientID = live.clientID;
  try {
    Y.applyUpdate(mirror, Y.encodeStateAsUpdate(live));
    const before = Y.encodeStateVector(mirror);
    writeTitle(mirror, text, null);
    return Y.encodeStateAsUpdate(mirror, before);
  } finally {
    mirror.destroy();
  }
}
