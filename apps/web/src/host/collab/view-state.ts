import { useCallback, useSyncExternalStore } from 'react';
import { $getEditor, type LexicalEditor } from 'lexical';

export const isBoundEditor = (editor: LexicalEditor): boolean => !!editor.getRootElement()?.closest('[data-editor-pane]');
export const $isBoundEditor = (): boolean => isBoundEditor($getEditor());

export interface NodeViewState { result?: string; stale?: boolean; noteTitle?: string; resolutionState?: string; noteId?: string | null; isResolved?: boolean }
const values = new Map<string, NodeViewState>();
const listeners = new Map<string, Set<() => void>>();
export function setNodeView(key: string, patch: NodeViewState): void {
  const before = values.get(key);
  if (before && Object.entries(patch).every(([name, value]) => before[name as keyof NodeViewState] === value)) return;
  values.set(key, { ...before, ...patch });
  queueMicrotask(() => listeners.get(key)?.forEach(listener => listener()));
}
/** A node's local view outside React: link activation and preview follow this viewer's resolution. */
export const nodeView = (key: string): NodeViewState | undefined => values.get(key);
export function useNodeView(key: string): NodeViewState | undefined {
  return useSyncExternalStore(useCallback((listener: () => void) => {
    const set = listeners.get(key) ?? new Set();
    listeners.set(key, set); set.add(listener);
    return () => { set.delete(listener); if (!set.size) { listeners.delete(key); values.delete(key); } };
  }, [key]), () => values.get(key), () => undefined);
}
