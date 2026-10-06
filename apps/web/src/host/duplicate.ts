import { noteCan } from './capabilities.ts';
import { getBridge, WORKSPACE } from './bridge/index.ts';

/** App's duplicate seam: the server owns content; the bridge only returns listing metadata. */
export async function duplicateNote(id: string) {
  const bridge = getBridge();
  if (!bridge) throw new Error('The web bridge is not ready');
  return bridge[WORKSPACE].duplicate(id);
}

export const canDuplicateNote = (id: string) => noteCan(id, 'edit');
