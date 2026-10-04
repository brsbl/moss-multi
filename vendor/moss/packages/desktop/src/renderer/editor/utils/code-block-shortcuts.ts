// ported-from: packages/desktop/src/renderer/editor/utils/code-block-shortcuts.ts @ 762abb777
// Standard editing shortcuts that should act on the focused code-block textarea
// rather than the surrounding Lexical editor: select-all, copy, paste, cut,
// undo, redo.
const EDITING_SHORTCUT_KEYS = new Set(['a', 'c', 'v', 'x', 'z', 'y']);

/**
 * Keep standard editing shortcuts and clipboard events scoped to the code-block
 * textarea so the surrounding Lexical editor root never intercepts them.
 *
 * Lexical registers `keydown`/`copy`/`cut`/`paste` listeners on the editor root
 * element, which is an ancestor of the decorator textarea. On Cmd/Ctrl+A its
 * keydown handler calls `event.preventDefault()` and dispatches
 * `SELECT_ALL_COMMAND`, selecting the whole note instead of the code. React's
 * synthetic `stopPropagation` fires at the React root container (also an
 * ancestor of the editor root), so it runs *after* Lexical's listener and is
 * too late to stop it. Attaching native target-phase listeners directly on the
 * textarea lets us stop propagation before the event reaches the editor root,
 * while leaving the native textarea behaviour (and its default action) intact.
 *
 * Cmd/Ctrl+S is intentionally left to propagate so the app save still runs.
 *
 * @returns a cleanup function that removes the listeners.
 */
export function scopeEditingShortcutsToTextarea(
  textarea: HTMLTextAreaElement
): () => void {
  const handleKeyDown = (event: KeyboardEvent): void => {
    if (!(event.metaKey || event.ctrlKey)) {
      return;
    }
    if (EDITING_SHORTCUT_KEYS.has(event.key.toLowerCase())) {
      event.stopPropagation();
    }
  };

  const stopClipboardEvent = (event: Event): void => {
    event.stopPropagation();
  };

  textarea.addEventListener('keydown', handleKeyDown);
  textarea.addEventListener('copy', stopClipboardEvent);
  textarea.addEventListener('cut', stopClipboardEvent);
  textarea.addEventListener('paste', stopClipboardEvent);

  return () => {
    textarea.removeEventListener('keydown', handleKeyDown);
    textarea.removeEventListener('copy', stopClipboardEvent);
    textarea.removeEventListener('cut', stopClipboardEvent);
    textarea.removeEventListener('paste', stopClipboardEvent);
  };
}
