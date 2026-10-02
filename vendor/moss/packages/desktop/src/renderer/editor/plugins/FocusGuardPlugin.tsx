// ported-from: packages/desktop/src/renderer/editor/plugins/FocusGuardPlugin.tsx @ 762abb777
import { useEffect } from 'react';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { isExternalEditorFocusLocked } from '../../utils/external-editor-focus-lock';

function isInputLike(el: Element): boolean {
  const tag = el.tagName;
  return (
    tag === 'TEXTAREA' ||
    tag === 'INPUT' ||
    tag === 'SELECT' ||
    (el as HTMLElement).isContentEditable
  );
}

/**
 * Prevents Lexical from stealing focus from portaled inputs.
 *
 * Lexical's $commitPendingUpdates calls rootElement.focus() whenever
 * activeElement is outside the editor tree. This overrides .focus()
 * on the root element to be a no-op when an external input has focus,
 * preventing focus loss entirely.
 *
 * Note: editor.focus() calls (e.g. after closing a link popover) also
 * pass through this guard. The guard keeps blocking while the last
 * external input remains mounted, then clears once focus returns to
 * the editor, the input disconnects, or the user clicks back into the root.
 */
export function FocusGuardPlugin(): null {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    let nativeFocus: typeof HTMLElement.prototype.focus | null = null;
    let currentRoot: HTMLElement | null = null;
    let lastExternalInput: HTMLElement | null = null;
    let rootMouseDownCleanup: (() => void) | null = null;

    const clearRememberedExternalInput = () => {
      lastExternalInput = null;
    };

    const handleDocumentFocusIn = (event: FocusEvent) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) {
        return;
      }

      const root = currentRoot;
      if (!root) {
        return;
      }

      if (root.contains(target)) {
        clearRememberedExternalInput();
        return;
      }

      if (isInputLike(target)) {
        lastExternalInput = target;
      }
    };

    document.addEventListener('focusin', handleDocumentFocusIn, true);

    const removeRootListener = editor.registerRootListener(
      (root, prevRoot) => {
        if (prevRoot && nativeFocus) {
          prevRoot.focus = nativeFocus;
          nativeFocus = null;
        }
        if (rootMouseDownCleanup) {
          rootMouseDownCleanup();
          rootMouseDownCleanup = null;
        }

        currentRoot = root;
        if (!root) return;

        nativeFocus = root.focus;

        // When the user clicks the editor root, they explicitly want focus —
        // bypass all guards. The flag is cleared in a microtask so it only
        // covers the synchronous Lexical updates triggered by the mousedown.
        let rootMouseDownActive = false;
        const handleRootMouseDown = () => {
          clearRememberedExternalInput();
          rootMouseDownActive = true;
          queueMicrotask(() => { rootMouseDownActive = false; });
        };
        root.addEventListener('mousedown', handleRootMouseDown, true);
        rootMouseDownCleanup = () => {
          root.removeEventListener('mousedown', handleRootMouseDown, true);
        };

        root.focus = function (options?: FocusOptions) {
          // User clicked the editor — skip guards, they want focus here
          if (rootMouseDownActive) {
            nativeFocus!.call(root, options);
            return;
          }

          // Primary guard: synchronous DOM attribute check (race-free).
          // PromptInput/MentionInput set data-focus-guard="active" on their
          // wrapper divs via onFocusCapture/onBlurCapture — no async timing gap.
          if (document.querySelector('[data-focus-guard="active"]')) {
            return;
          }

          const active = document.activeElement;
          const activeElement = active instanceof HTMLElement ? active : null;

          // Secondary guard: reference-counted lock (used by comment popovers)
          if (isExternalEditorFocusLocked() && (!activeElement || !root.contains(activeElement))) {
            return;
          }

          if (activeElement && !root.contains(activeElement) && isInputLike(activeElement)) {
            return;
          }

          const rememberedExternalInputStillPresent = !!(
            lastExternalInput &&
            lastExternalInput.isConnected &&
            !root.contains(lastExternalInput)
          );
          const activeOutsideRoot = !activeElement || !root.contains(activeElement);
          if (
            rememberedExternalInputStillPresent &&
            activeOutsideRoot
          ) {
            return;
          }

          nativeFocus!.call(root, options);
        };
      },
    );

    return () => {
      document.removeEventListener('focusin', handleDocumentFocusIn, true);
      removeRootListener();
      if (rootMouseDownCleanup) {
        rootMouseDownCleanup();
      }
      if (currentRoot && nativeFocus) {
        currentRoot.focus = nativeFocus;
      }
    };
  }, [editor]);

  return null;
}
