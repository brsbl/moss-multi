// The DocDO's title writes from outside its sockets (create, a REST rename), apart from server-doc.ts so the
// measurement Worker can time them without the converter.
import type * as Y from 'yjs';
import { writeField } from '@moss-multi/core/doc-fields';

/** A minimal diff of caller text into Y.Text('title') that every open client merges. */
export function writeTitle(live: Y.Doc, text: string, origin: unknown): boolean {
  return writeField(live, 'title', text, origin);
}
