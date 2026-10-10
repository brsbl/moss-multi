// Commenting from a read-only body (a commenter, or anyone while the body cannot take edits). moss's selection
// toolbar and Cmd+Shift+A live in the editable editor's key handling, which Lexical skips when the root is not
// editable, so this offers the same entry points: a one-button selection bar over a non-empty selection, and
// Cmd+Shift+A, both opening moss's own composer on a selection minted at open (comments.md §4). A block header's Add
// comment opens the same composer on that block. A terminal note offers none of them, and closes the editable
// editor's composer in place (A§10.6).
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { commentInputStateAtom, OPEN_BLOCK_COMMENT_COMMAND } from '@moss-desktop/renderer/editor/plugins/CommentPlugin';
import { CommentInputPopover } from '@moss-desktop/renderer/editor/components/CommentInputPopover';
import {
  SELECTION_TOOLBAR_BUTTON_BASE_CLASS, SELECTION_TOOLBAR_BUTTON_IDLE_CLASS, SelectionToolbarInner, SelectionToolbarShell,
} from '@moss-desktop/renderer/editor/components/SelectionToolbarPrimitives';
import { FLOATING_TOOLBAR_ATTR } from '@moss-multi/protocol/dom-contract';
import { useStore } from 'jotai';
import { COMMAND_PRIORITY_HIGH } from 'lexical';
import { StickyNote } from 'lucide-react';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useTerminal } from '../collab/terminal.ts';
import { createFromCommand, stashCommentSelection, useCanComment } from './adapter.ts';

type Rect = { x: number; y: number; width: number; height: number };
/** The open composer: where it anchors, and the block it comments on (none for a text selection). */
type Composer = { rect: Rect; nodeKey?: string };
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
  const [composer, setComposer] = useState<Composer | null>(null);

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
    setComposer({ rect: rectOf(range) });
  }, [editor]);

  const close = useCallback((next: boolean) => {
    if (next) return;
    if (typeof CSS !== 'undefined') CSS.highlights?.delete(SELECTION);
    setComposer(null);
  }, []);

  // A block header's Add comment (moss's editable editor handles it in FloatingSelectionTools, unmounted here).
  useEffect(() => {
    if (!allowed) return;
    return editor.registerCommand(OPEN_BLOCK_COMMENT_COMMAND, ({ nodeKey }) => {
      const block = editor.getRootElement()?.querySelector(`[data-block-decorator-key="${CSS.escape(nodeKey)}"]`);
      if (!block) return false;
      const rect = block.getBoundingClientRect();
      setBar(null);
      setComposer({ rect: { x: rect.right, y: rect.top, width: 0, height: 0 }, nodeKey });
      return true;
    }, COMMAND_PRIORITY_HIGH);
  }, [allowed, editor]);

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
  const nodeKey = composer?.nodeKey;
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
        anchorRect={composer?.rect ?? null}
        anchorSide={nodeKey ? 'top' : 'bottom'}
        anchorAlign={nodeKey ? 'end' : 'start'}
        // A block comment mints from the editor state, so it reads it; a text one was minted at open.
        onCreate={(text: string) => (nodeKey ? editor.read(() => createFromCommand(editor, { text, nodeKey })) : createFromCommand(editor, { text })) === true}
        noteId={noteId}
        collisionBoundary={editor.getRootElement()?.closest('.canvas-scroll') ?? null}
      />
    </>,
    document.body,
  );
}
