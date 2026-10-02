// ported-from: packages/desktop/src/renderer/components/DefaultEditorPrompt.tsx @ 762abb777
import { useCallback, useEffect, useState } from 'react';
import { useStore } from 'jotai';
import { ConfirmationDialog } from '@moss/shared';

import {
  ensureIsDefaultMdEditorLookupAtom,
  isDefaultMdEditorAtom,
  setIsDefaultMdEditorAtom
} from '../state/default-editor-atoms';

const PROMPT_DELAY_MS = 60_000; // ~1 minute
const SNAPSHOT_ATTR = 'data-moss-snapshot';

const isSnapshotModeActive = (): boolean =>
  typeof document !== 'undefined' &&
  document.documentElement.getAttribute(SNAPSHOT_ATTR) === 'true';

export function DefaultEditorPrompt() {
  const store = useStore();
  const [open, setOpen] = useState(false);

  const markPromptDismissed = useCallback(async () => {
    try {
      await window.electronAPI?.settings?.setDefaultEditorPromptDismissed(true);
    } catch {
      // Dismissal persistence is best-effort; don't block closing the prompt.
    }
  }, []);

  useEffect(() => {
    if (isSnapshotModeActive()) {
      return;
    }

    let cancelled = false;

    const timer = setTimeout(async () => {
      if (cancelled || isSnapshotModeActive()) return;
      try {
        const dismissed = await window.electronAPI?.settings?.getDefaultEditorPromptDismissed();
        if (cancelled || dismissed) return;

        // Reuse the shared cache so we don't run a second OS lookup when
        // Settings has already populated it.
        let isDefault = store.get(isDefaultMdEditorAtom);
        if (isDefault === null) {
          await store.set(ensureIsDefaultMdEditorLookupAtom);
          if (cancelled) return;
          isDefault = store.get(isDefaultMdEditorAtom);
        }

        // Lookup failed (atom still null) — preserve prior behavior of not opening on unknown.
        if (isDefault === null) return;

        if (isDefault) {
          await markPromptDismissed();
          return;
        }

        setOpen(true);
      } catch {
        // Silently fail — don't block the app
      }
    }, PROMPT_DELAY_MS);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [markPromptDismissed, store]);

  const handleConfirm = useCallback(async () => {
    try {
      const success = await window.electronAPI?.settings?.setDefaultMdEditor();
      if (success) {
        store.set(setIsDefaultMdEditorAtom, true);
      }
    } catch {
      // OS dialog was cancelled or failed
    }
    await markPromptDismissed();
  }, [markPromptDismissed, store]);

  const handleCancel = useCallback(async () => {
    await markPromptDismissed();
  }, [markPromptDismissed]);

  const handleOpenChange = useCallback((nextOpen: boolean) => {
    setOpen(nextOpen);
    if (!nextOpen) {
      void markPromptDismissed();
    }
  }, [markPromptDismissed]);

  return (
    <ConfirmationDialog
      open={open}
      onOpenChange={handleOpenChange}
      title="Default Markdown Editor"
      description={
        <span>
          Set Moss as your default editor for .md files?
          <br />
          <span className="mt-1 inline-block text-ink-faint">
            You can change this later in Settings.
          </span>
        </span>
      }
      confirmLabel="Set as Default"
      cancelLabel="Not Now"
      onConfirm={handleConfirm}
      onCancel={handleCancel}
    />
  );
}
