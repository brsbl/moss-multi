// ported-from: packages/desktop/src/renderer/editor/plugins/tableUiOwner.ts @ 762abb777
import type { LexicalEditor } from 'lexical';

const tableUiOwners = new WeakMap<LexicalEditor, string>();
let nextTableUiOwnerId = 0;

export const getTableUiOwnerId = (editor: LexicalEditor): string => {
  const existingOwnerId = tableUiOwners.get(editor);
  if (existingOwnerId) {
    return existingOwnerId;
  }

  nextTableUiOwnerId += 1;
  const ownerId = `moss-table-ui-${nextTableUiOwnerId}`;
  tableUiOwners.set(editor, ownerId);
  return ownerId;
};
