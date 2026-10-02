// ported-from: packages/desktop/src/renderer/editor/preview/useRemoteWebSurfaceSelection.ts @ 762abb777
import { useCallback, useEffect, useState } from 'react';

import { remoteWebSurfaceApi } from '../../api/electron';
import type { RemoteWebSurfaceSelectionRect } from '../../../common/remote-web-surface';

export interface BrowserSurfaceSelection {
  hasSelection: boolean;
  text: string;
  rect: RemoteWebSurfaceSelectionRect | null;
}

const EMPTY_SELECTION: BrowserSurfaceSelection = { hasSelection: false, text: '', rect: null };

/**
 * Subscribe to text-selection state for a single native browser surface and
 * expose a copy action.
 *
 * Selection happens inside the native WebContentsView, not the renderer DOM, so
 * the only signal we have is the scoped preload's push events (forwarded via
 * `onSelection`). The hook keeps local state synced from that external system —
 * the canonical "effects synchronize with external systems" case — and resets
 * whenever the surface id changes or the surface goes inactive so stale browser
 * selection never leaks into another tab's chrome.
 */
export function useRemoteWebSurfaceSelection(
  surfaceId: string,
  active: boolean,
  resetKey = ''
): BrowserSurfaceSelection & { copySelection: () => void } {
  const [selection, setSelection] = useState<BrowserSurfaceSelection>(EMPTY_SELECTION);

  useEffect(() => {
    // Reset on (re)subscribe and on deactivation so the toolbar never shows a
    // selection from a previous surface or while the surface is closed.
    setSelection(EMPTY_SELECTION);
    if (!active) {
      return undefined;
    }
    return remoteWebSurfaceApi.onSelection((state) => {
      if (state.id !== surfaceId) {
        return;
      }
      setSelection((prev) =>
        prev.hasSelection === state.hasSelection &&
          prev.text === state.text &&
          prev.rect?.x === state.rect?.x &&
          prev.rect?.y === state.rect?.y &&
          prev.rect?.width === state.rect?.width &&
          prev.rect?.height === state.rect?.height
          ? prev
          : { hasSelection: state.hasSelection, text: state.text, rect: state.rect }
      );
    });
  }, [active, resetKey, surfaceId]);

  const copySelection = useCallback(() => {
    void remoteWebSurfaceApi.copySelection.invoke({ id: surfaceId }).catch(() => undefined);
  }, [surfaceId]);

  return { hasSelection: selection.hasSelection, text: selection.text, rect: selection.rect, copySelection };
}
