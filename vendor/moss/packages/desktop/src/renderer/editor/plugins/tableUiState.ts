// ported-from: packages/desktop/src/renderer/editor/plugins/tableUiState.ts @ 762abb777
const resizeHandleListenersByOwner = new Map<string, Set<() => void>>();
const ownersWithVisibleResizeHandles = new Set<string>();

export const getTableResizeHandlesVisible = (ownerId: string): boolean =>
  ownersWithVisibleResizeHandles.has(ownerId);

export const setTableResizeHandlesVisible = (
  ownerId: string,
  nextVisible: boolean
): void => {
  if (ownersWithVisibleResizeHandles.has(ownerId) === nextVisible) {
    return;
  }

  if (nextVisible) {
    ownersWithVisibleResizeHandles.add(ownerId);
  } else {
    ownersWithVisibleResizeHandles.delete(ownerId);
  }
  resizeHandleListenersByOwner.get(ownerId)?.forEach((listener) => listener());
};

export const subscribeTableResizeHandlesVisible = (
  ownerId: string,
  listener: () => void
): (() => void) => {
  const listeners = resizeHandleListenersByOwner.get(ownerId) ?? new Set<() => void>();
  listeners.add(listener);
  resizeHandleListenersByOwner.set(ownerId, listeners);

  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      resizeHandleListenersByOwner.delete(ownerId);
    }
  };
};

export const removeTableResizeHandlesVisibility = (ownerId: string): void => {
  if (!ownersWithVisibleResizeHandles.delete(ownerId)) {
    return;
  }
  resizeHandleListenersByOwner.get(ownerId)?.forEach((listener) => listener());
};
