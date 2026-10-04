/** Workspace events carry identifiers only; document content travels through its Y.Doc. */
export type WorkspaceEvent =
  | { type: 'meta'; docIds: string[]; folderIds: string[] }
  | { type: 'vaults' }
  | { type: 'notifications' }
  | { type: 'session-ended'; sessionId: string };

export function parseWorkspaceEvent(value: unknown): WorkspaceEvent | null {
  if (!value || typeof value !== 'object') return null;
  const event = value as Record<string, unknown>;
  if (event.type === 'vaults' || event.type === 'notifications') return { type: event.type };
  if (event.type === 'session-ended' && typeof event.sessionId === 'string') return { type: event.type, sessionId: event.sessionId };
  if (event.type === 'meta' && Array.isArray(event.docIds) && Array.isArray(event.folderIds) &&
    event.docIds.every((id) => typeof id === 'string') && event.folderIds.every((id) => typeof id === 'string')) {
    return { type: 'meta', docIds: event.docIds, folderIds: event.folderIds };
  }
  return null;
}
