// Commenting from a read-only body (a commenter, or anyone while the body cannot take edits). moss's selection
// toolbar and Cmd+Shift+A live in the editable editor's key handling, which Lexical skips when the root is not
// editable, so this offers the same entry points: a one-button selection bar over a non-empty selection, and
// Cmd+Shift+A, both opening moss's own composer on a selection minted at open (comments.md §4). A terminal note offers
// neither, and closes the editable editor's composer in place (A§10.6).
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { commentInputStateAtom } from '@moss-desktop/renderer/editor/plugins/CommentPlugin';
import { CommentInputPopover } from '@moss-desktop/renderer/editor/components/CommentInputPopover';
import {
  SELECTION_TOOLBAR_BUTTON_BASE_CLASS, SELECTION_TOOLBAR_BUTTON_IDLE_CLASS, SelectionToolbarInner, SelectionToolbarShell,
} from '@moss-desktop/renderer/editor/components/SelectionToolbarPrimitives';
import { FLOATING_TOOLBAR_ATTR } from '@moss-multi/protocol/dom-contract';
import { useStore } from 'jotai';
import { StickyNote } from 'lucide-react';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useTerminal } from '../collab/terminal.ts';
import { createFromCommand, stashCommentSelection, useCanComment } from './adapter.ts';

type Rect = { x: number; y: number; width: number; height: number };
const SELECTION = 'comment-selection';

/** The non-empty DOM selection inside `root`, if any. */
function selectionIn(root: HTMLElement | null): Range | null {
  const selection = typeof window === 'undefined' ? null : window.getSelection();
  if (!root || !selection || selection.rangeCount === 0 || selection.isCollapsed) return null;
  const range = selection.getRangeAt(0);
  return root.contains(range.commonAncestorContainer) && range.toString().trim() ? range : null;
}

const rectOf = (range: Range): Rect => {
  const { x, y, width, height } = range.getBoundingClientRect();
  return { x, y, width, height };
};

export function CommentOnlyTools({ noteId }: { noteId: string }): ReactNode {
  const [editor] = useLexicalComposerContext();
  const store = useStore();
  const allowed = useCanComment(noteId);
  const terminal = useTerminal(noteId) !== null;
  const [bar, setBar] = useState<Rect | null>(null);
  const [composer, setComposer] = useState<Rect | null>(null);

  // A note that went terminal under an open composer: moss's (the editable editor's) and this one both close.
  useEffect(() => {
    if (!terminal) return;
    store.set(commentInputStateAtom(noteId), { open: false, anchorRect: null });
    if (typeof CSS !== 'undefined') CSS.highlights?.delete(SELECTION);
    setComposer(null);
    setBar(null);
  }, [noteId, store, terminal]);

  const open = useCallback(() => {
    const range = selectionIn(editor.getRootElement());
    if (!range) return;
    stashCommentSelection(editor);
    if (typeof CSS !== 'undefined' && CSS.highlights) CSS.highlights.set(SELECTION, new Highlight(range.cloneRange()));
    setBar(null);
    setComposer(rectOf(range));
  }, [editor]);

  const close = useCallback((next: boolean) => {
    if (next) return;
    if (typeof CSS !== 'undefined') CSS.highlights?.delete(SELECTION);
    setComposer(null);
  }, []);

  useEffect(() => {
    if (!allowed) return;
    const onSelection = () => {
      const range = selectionIn(editor.getRootElement());
      setBar(range ? rectOf(range) : null);
    };
    const onKey = (event: KeyboardEvent) => {
      const primary = /Mac|iPhone|iPad/.test(navigator.platform) ? event.metaKey : event.ctrlKey;
      if (!primary || !event.shiftKey || event.altKey || event.key.toLowerCase() !== 'a') return;
      if (!selectionIn(editor.getRootElement())) return;
      event.preventDefault();
      open();
    };
    document.addEventListener('selectionchange', onSelection);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('selectionchange', onSelection);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [allowed, editor, open]);

  if (!allowed || typeof document === 'undefined') return null;
  return createPortal(
    <>
      {bar && !composer ? (
        <SelectionToolbarShell
          {...{ [FLOATING_TOOLBAR_ATTR]: 'true' }}
          style={{ position: 'fixed', left: bar.x + bar.width / 2, top: Math.max(bar.y - 48, 48), transform: 'translateX(-50%)', zIndex: 50 }}
        >
          <SelectionToolbarInner>
            <button
              type="button"
              aria-label="Add comment"
              title="Comment (⌘⇧A)"
              onMouseDown={(event) => event.preventDefault()}
              onClick={open}
              className={`${SELECTION_TOOLBAR_BUTTON_BASE_CLASS} ${SELECTION_TOOLBAR_BUTTON_IDLE_CLASS}`}
            >
              <StickyNote aria-hidden className="h-4 w-4" />
            </button>
          </SelectionToolbarInner>
        </SelectionToolbarShell>
      ) : null}
      <CommentInputPopover
        open={composer !== null}
        onOpenChange={close}
        anchorRect={composer}
        onCreate={(text: string) => createFromCommand(editor, { text }) === true}
        noteId={noteId}
        collisionBoundary={editor.getRootElement()?.closest('.canvas-scroll') ?? null}
      />
    </>,
    document.body,
  );
}
