// ported-from: packages/desktop/src/renderer/editor/dialogs/useMediaSourceDialog.tsx @ 762abb777
/**
 * useMediaSourceDialog
 *
 * Hook that manages MediaSourceDialog state and provides a promise-based
 * imperative API for opening the dialog from non-React contexts (like slash commands).
 *
 * Usage:
 * 1. Call the hook in a component: const { dialogProps, open } = useMediaSourceDialog();
 * 2. Render the dialog: <MediaSourceDialog {...dialogProps} />
 * 3. Open from anywhere: const result = await open();
 */
import { useState, useCallback, useRef } from 'react';

import type { MediaSourceResult } from './MediaSourceDialog';

interface PendingPromise {
  resolve: (value: MediaSourceResult) => void;
}

export interface UseMediaSourceDialogReturn {
  /** Props to spread onto MediaSourceDialog */
  dialogProps: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onSelectFile: () => void;
    onSelectUrl: (url: string) => void;
  };
  /** Open the dialog and return a promise that resolves with the user's selection */
  open: () => Promise<MediaSourceResult>;
}

export function useMediaSourceDialog(): UseMediaSourceDialogReturn {
  const [isOpen, setIsOpen] = useState(false);
  const pendingRef = useRef<PendingPromise | null>(null);

  const handleOpenChange = useCallback((open: boolean) => {
    setIsOpen(open);
    // If dialog is closing without a selection, resolve with null
    if (!open && pendingRef.current) {
      pendingRef.current.resolve(null);
      pendingRef.current = null;
    }
  }, []);

  const handleSelectFile = useCallback(() => {
    if (pendingRef.current) {
      pendingRef.current.resolve({ type: 'file' });
      pendingRef.current = null;
    }
  }, []);

  const handleSelectUrl = useCallback((url: string) => {
    if (pendingRef.current) {
      pendingRef.current.resolve({ type: 'url', url });
      pendingRef.current = null;
    }
  }, []);

  const openDialog = useCallback((): Promise<MediaSourceResult> => {
    return new Promise((resolve) => {
      pendingRef.current?.resolve(null);
      pendingRef.current = { resolve };
      setIsOpen(true);
    });
  }, []);

  return {
    dialogProps: {
      open: isOpen,
      onOpenChange: handleOpenChange,
      onSelectFile: handleSelectFile,
      onSelectUrl: handleSelectUrl
    },
    open: openDialog
  };
}

// Global reference for slash command access
// NOTE: Single editor instance assumed. The module-level globalOpenDialog
// variable stores a reference to the most recently mounted editor's dialog
// opener. Multi-editor support would require a Map keyed by editor ID or
// lifting this state to a shared React context.
let globalOpenDialog: (() => Promise<MediaSourceResult>) | null = null;

/**
 * Set the global dialog opener function.
 * Called by the component that renders MediaSourceDialog.
 */
export function setGlobalMediaSourceDialogOpener(opener: (() => Promise<MediaSourceResult>) | null): void {
  globalOpenDialog = opener;
}

/**
 * Open the media source dialog from anywhere (e.g., slash commands).
 * Returns null if the dialog controller isn't mounted.
 */
export async function openMediaSourceDialog(): Promise<MediaSourceResult> {
  if (!globalOpenDialog) {
    console.warn('[useMediaSourceDialog] Dialog controller not mounted');
    return null;
  }
  return globalOpenDialog();
}
