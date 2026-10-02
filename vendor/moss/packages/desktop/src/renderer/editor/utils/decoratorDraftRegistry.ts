// ported-from: packages/desktop/src/renderer/editor/utils/decoratorDraftRegistry.ts @ 762abb777
const decoratorDraftFlushers = new Map<string, () => void>();

const scopedKey = (editorId: string, nodeKey: string): string => `${editorId}:${nodeKey}`;

export const registerDecoratorDraftFlusher = (editorId: string, nodeKey: string, flush: () => void): void => {
  decoratorDraftFlushers.set(scopedKey(editorId, nodeKey), flush);
};

export const unregisterDecoratorDraftFlusher = (editorId: string, nodeKey: string, flush: () => void): void => {
  const key = scopedKey(editorId, nodeKey);
  if (decoratorDraftFlushers.get(key) === flush) {
    decoratorDraftFlushers.delete(key);
  }
};

export const flushDecoratorDrafts = (editorId?: string): void => {
  for (const [key, flush] of decoratorDraftFlushers) {
    if (!editorId || key.startsWith(`${editorId}:`)) {
      flush();
    }
  }
};
