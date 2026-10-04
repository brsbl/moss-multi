import { useCallback, useSyncExternalStore } from 'react';
import { $getEditor, type LexicalEditor } from 'lexical';

export const isBoundEditor = (editor: LexicalEditor): boolean => !!editor.getRootElement()?.closest('[data-editor-pane]');
export const $isBoundEditor = (): boolean => isBoundEditor($getEditor());

export interface NodeViewState { result?: string; stale?: boolean; noteTitle?: string; resolutionState?: string }
const values = new Map<string, NodeViewState>();
const listeners = new Map<string, Set<() => void>>();
export function setNodeView(key: string, patch: NodeViewState): void {
  const before = values.get(key);
  if (before && Object.entries(patch).every(([name, value]) => before[name as keyof NodeViewState] === value)) return;
  values.set(key, { ...before, ...patch });
  queueMicrotask(() => listeners.get(key)?.forEach(listener => listener()));
}
export function useNodeView(key: string): NodeViewState | undefined {
  return useSyncExternalStore(useCallback((listener: () => void) => {
    const set = listeners.get(key) ?? new Set();
    listeners.set(key, set); set.add(listener);
    return () => { set.delete(listener); if (!set.size) { listeners.delete(key); values.delete(key); } };
  }, [key]), () => values.get(key), () => undefined);
}
