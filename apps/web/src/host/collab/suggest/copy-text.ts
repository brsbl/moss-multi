// "Copy suggested text" (docs/design/suggestions.md §4.7): what an outdated or broken record proposes, as text.
import { BODY_DOC, type SuggestionRecord } from '@moss-multi/core/suggest/apply';
import * as Y from 'yjs';

/** The text a record would add, decoded from its own ops (§4.7 "Copy suggested text"). */
export function suggestedText(record: SuggestionRecord, _body?: Y.Doc | null): string {
  const parts: string[] = [];
  for (const op of record.ops) {
    try {
      for (const struct of Y.decodeUpdate(op.update).structs) {
        if (struct instanceof Y.Item && struct.content instanceof Y.ContentString) parts.push(struct.content.str);
      }
    } catch {
      // An undecodable op adds nothing to copy.
    }
    if (op.doc !== BODY_DOC) parts.push('\n');
  }
  return parts.join('').trim();
}
