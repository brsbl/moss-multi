// ported-from: packages/desktop/src/renderer/hooks/useNavigationHistory.ts @ 762abb777
import { useCallback, useEffect, useRef } from 'react';
import { useAtom, useAtomValue, useSetAtom, useStore } from 'jotai';
import {
  activeNoteIdAtom,
  navigationHistoryAtom,
  canGoBackAtom,
  canGoForwardAtom,
  activeFolderPathAtom,
  revealFolderPathAtom,
  noteEntityAtom,
  pendingScrollTargetAtom,
  type NavigationHistoryState
} from '@moss/shared';

const MAX_NAVIGATION_HISTORY = 50;

export interface UseNavigationHistoryResult {
  canGoBack: boolean;
  canGoForward: boolean;
  goBack: () => void;
  goForward: () => void;
  navigateToNote: (noteId: string, heading?: string | null) => void;
}

/**
 * Hook for managing browser-like back/forward navigation between notes.
 *
 * Navigation behavior:
 * - New navigations truncate forward history (like a browser)
 * - Back/forward moves through history without modifying it
 * - History is capped at MAX_NAVIGATION_HISTORY entries
 *
 * @param onNavigate - Optional callback invoked after back/forward navigation completes.
 *                     Not called for `navigateToNote` since callers handle their own side effects.
 *                     Useful for loading note-specific state like action tabs.
 */
export function useNavigationHistory(
  onNavigate?: (noteId: string) => void
): UseNavigationHistoryResult {
  const [history, setHistory] = useAtom(navigationHistoryAtom);
  const setActiveNoteId = useSetAtom(activeNoteIdAtom);
  const setActiveFolderPath = useSetAtom(activeFolderPathAtom);
  const revealFolderPath = useSetAtom(revealFolderPathAtom);
  const store = useStore();
  const activeNoteId = useAtomValue(activeNoteIdAtom);
  const canGoBack = useAtomValue(canGoBackAtom);
  const canGoForward = useAtomValue(canGoForwardAtom);
  const hasSeededRef = useRef(false);

  // Keep onNavigate in a ref so history callbacks stay stable while using the latest callback.
  const onNavigateRef = useRef(onNavigate);
  onNavigateRef.current = onNavigate;

  // Seed the history with the initial note when the app loads
  useEffect(() => {
    if (hasSeededRef.current || !activeNoteId || history.stack.length > 0) {
      return;
    }

    hasSeededRef.current = true;
    setHistory({
      stack: [activeNoteId],
      index: 0
    });
  }, [activeNoteId, history.stack.length, setHistory]);

  const selectHistoryTarget = useCallback((
    targetNoteId: string,
    targetHeading: string | null,
    restoreLocation: boolean
  ) => {
    if (restoreLocation) {
      store.set(pendingScrollTargetAtom, { noteId: targetNoteId, heading: targetHeading });
    }
    setActiveNoteId(targetNoteId);
    const targetNote = store.get(noteEntityAtom(targetNoteId));
    if (targetNote?.folderPath) {
      revealFolderPath(targetNote.folderPath);
    }
    onNavigateRef.current?.(targetNoteId);
  }, [setActiveNoteId, revealFolderPath, store]);

  const goBack = useCallback(() => {
    const currentHistory = store.get(navigationHistoryAtom);
    if (currentHistory.index <= 0) return;

    const newIndex = currentHistory.index - 1;
    const targetNoteId = currentHistory.stack[newIndex];
    if (!targetNoteId) return;

    setHistory({ ...currentHistory, index: newIndex });
    selectHistoryTarget(
      targetNoteId,
      currentHistory.headings?.[newIndex] ?? null,
      Boolean(currentHistory.headings)
    );
  }, [setHistory, selectHistoryTarget, store]);

  const goForward = useCallback(() => {
    const currentHistory = store.get(navigationHistoryAtom);
    if (currentHistory.index >= currentHistory.stack.length - 1) return;

    const newIndex = currentHistory.index + 1;
    const targetNoteId = currentHistory.stack[newIndex];
    if (!targetNoteId) return;

    setHistory({ ...currentHistory, index: newIndex });
    selectHistoryTarget(
      targetNoteId,
      currentHistory.headings?.[newIndex] ?? null,
      Boolean(currentHistory.headings)
    );
  }, [setHistory, selectHistoryTarget, store]);

  const navigateToNote = useCallback((noteId: string, heading: string | null = null) => {
    const normalizedHeading = heading?.trim() || null;
    setHistory((prev: NavigationHistoryState) => {
      const currentHeading = prev.headings?.[prev.index] ?? null;
      // If we're already at this exact note location, skip.
      if (
        prev.stack[prev.index] === noteId &&
        (!normalizedHeading || currentHeading === normalizedHeading)
      ) {
        return prev;
      }

      // Truncate forward history when navigating to a new note
      const newStack = prev.index >= 0
        ? [...prev.stack.slice(0, prev.index + 1), noteId]
        : [noteId];
      const newHeadings = prev.headings || normalizedHeading
        ? [
            ...(prev.headings ?? prev.stack.map(() => null)).slice(0, prev.index + 1),
            normalizedHeading
          ]
        : undefined;

      // Cap history size
      const cappedStack = newStack.length > MAX_NAVIGATION_HISTORY
        ? newStack.slice(-MAX_NAVIGATION_HISTORY)
        : newStack;
      const cappedHeadings = newHeadings && newHeadings.length > MAX_NAVIGATION_HISTORY
        ? newHeadings.slice(-MAX_NAVIGATION_HISTORY)
        : newHeadings;

      return {
        stack: cappedStack,
        ...(cappedHeadings ? { headings: cappedHeadings } : {}),
        index: cappedStack.length - 1
      };
    });

    if (normalizedHeading) {
      store.set(pendingScrollTargetAtom, { noteId, heading: normalizedHeading });
    }

    setActiveNoteId(noteId);

    // Update active folder to match the target note (consistent with goBack/goForward)
    const targetNote = store.get(noteEntityAtom(noteId));
    if (targetNote?.folderPath) {
      setActiveFolderPath(targetNote.folderPath);
    }
  }, [setHistory, setActiveNoteId, setActiveFolderPath, store]);

  return {
    canGoBack,
    canGoForward,
    goBack,
    goForward,
    navigateToNote
  };
}
