// Routed deletes in Suggest mode (docs/design/suggestions.md §5): an explicit delete over body text (Backspace,
// Delete, word or line delete, Cut, typing, Enter or paste over a selection) proposes a delete part with the exact
// ids instead of removing the text, which stays in F painted struck; the caret moves past it. Deleting the author's
// own pending text is native, and so is everything else (a join at a block edge included), recorded verbatim.
import { $getClipboardDataFromSelection, setLexicalClipboardDataTransfer } from '@lexical/clipboard';
import type { SuggestFork } from '@moss-multi/sync/suggest/client';
import {
  $getSelection, $isRangeSelection, $isTextNode, COMMAND_PRIORITY_CRITICAL, CONTROLLED_TEXT_INSERTION_COMMAND, CUT_COMMAND,
  DELETE_CHARACTER_COMMAND, DELETE_LINE_COMMAND, DELETE_WORD_COMMAND, INSERT_LINE_BREAK_COMMAND, INSERT_PARAGRAPH_COMMAND,
  mergeRegister, PASTE_COMMAND, type LexicalEditor, type TextNode,
} from 'lexical';
import type * as Y from 'yjs';
import { bindingOf } from '../binding-registry.ts';
import { textIds, toSpans } from './chars.ts';

type Routed = 'none' | 'struck' | 'own' | 'skip';

export function registerSuggestRouting(editor: LexicalEditor, fork: SuggestFork): () => void {
  /**
   * A non-collapsed selection: body characters in it become one delete part and the caret goes to its end. `own`:
   * only the author's own text, which deletes natively. `skip`: nothing left to strike; the caret still moves.
   */
  const $routeRange = (): Routed => {
    const selection = $getSelection();
    const binding = bindingOf(editor);
    if (!$isRangeSelection(selection) || selection.isCollapsed() || !binding) return 'none';
    const own = fork.ownClients();
    const [start, end] = selection.isBackward() ? [selection.focus, selection.anchor] : [selection.anchor, selection.focus];
    const body: Y.ID[] = [];
    let owned = 0;
    for (const node of selection.getNodes()) {
      if (!$isTextNode(node)) continue;
      const ids = textIds(binding, node.getKey());
      if (!ids) continue;
      const from = start.type === 'text' && start.key === node.getKey() ? start.offset : 0;
      const to = end.type === 'text' && end.key === node.getKey() ? end.offset : ids.length;
      for (let i = from; i < to; i += 1) {
        const id = ids[i];
        if (own.has(id.client)) owned += 1;
        else if (!fork.isStruck(id)) body.push(id);
      }
    }
    if (body.length === 0 && owned > 0) return 'own';
    if (body.length > 0 && !fork.proposeDelete(toSpans(body))) return 'skip';
    const { key, offset, type } = end;
    selection.anchor.set(key, offset, type);
    selection.focus.set(key, offset, type);
    return body.length > 0 ? 'struck' : 'skip';
  };

  /** Backspace or Delete at a collapsed caret: past struck text to the next character, struck or deleted. */
  const $routeChar = (backward: boolean): boolean => {
    const selection = $getSelection();
    const binding = bindingOf(editor);
    if (!$isRangeSelection(selection) || !selection.isCollapsed() || selection.anchor.type !== 'text' || !binding) return false;
    const own = fork.ownClients();
    let node = selection.anchor.getNode() as TextNode;
    let offset = selection.anchor.offset;
    for (;;) {
      const ids = textIds(binding, node.getKey());
      if (!ids) return false;
      const at = backward ? offset - 1 : offset;
      if (at < 0 || at >= ids.length) {
        const next = backward ? node.getPreviousSibling() : node.getNextSibling();
        if ($isTextNode(next)) {
          node = next;
          offset = backward ? next.getTextContentSize() : 0;
          continue;
        }
        // A block edge or an inline node: native, from past the struck text.
        node.select(offset, offset);
        return false;
      }
      const id = ids[at];
      if (fork.isStruck(id)) {
        offset = backward ? at : at + 1;
        continue;
      }
      if (own.has(id.client)) {
        const caret = backward ? at + 1 : at;
        node.select(caret, caret);
        return false;
      }
      fork.proposeDelete(toSpans([id]));
      const caret = backward ? at : at + 1;
      node.select(caret, caret);
      return true;
    }
  };

  const $extended = (backward: boolean, granularity: 'word' | 'lineboundary'): boolean => {
    const selection = $getSelection();
    if (!$isRangeSelection(selection)) return false;
    if (selection.isCollapsed()) selection.modify('extend', backward, granularity);
    const routed = $routeRange();
    return routed === 'struck' || routed === 'skip';
  };

  const P = COMMAND_PRIORITY_CRITICAL;
  return mergeRegister(
    editor.registerCommand(DELETE_CHARACTER_COMMAND, (backward) => {
      const routed = $routeRange();
      return routed === 'none' ? $routeChar(backward) : routed !== 'own';
    }, P),
    editor.registerCommand(DELETE_WORD_COMMAND, (backward) => $extended(backward, 'word'), P),
    editor.registerCommand(DELETE_LINE_COMMAND, (backward) => $extended(backward, 'lineboundary'), P),
    editor.registerCommand(CONTROLLED_TEXT_INSERTION_COMMAND, (payload) => {
      const routed = $routeRange();
      if (routed !== 'struck' && routed !== 'skip') return false;
      const text = typeof payload === 'string' ? payload : (payload.data ?? payload.dataTransfer?.getData('text/plain') ?? '');
      const selection = $getSelection();
      if ($isRangeSelection(selection) && text) selection.insertText(text);
      return true;
    }, P),
    // Enter, Shift+Enter and paste over a selection: strike it, then insert natively at its end.
    editor.registerCommand(INSERT_PARAGRAPH_COMMAND, () => {
      $routeRange();
      return false;
    }, P),
    editor.registerCommand(INSERT_LINE_BREAK_COMMAND, () => {
      $routeRange();
      return false;
    }, P),
    editor.registerCommand(PASTE_COMMAND, () => {
      $routeRange();
      return false;
    }, P),
    editor.registerCommand(CUT_COMMAND, (event) => {
      const selection = $getSelection();
      if (!$isRangeSelection(selection) || selection.isCollapsed()) return false;
      const clipboard = event instanceof ClipboardEvent ? event.clipboardData : null;
      if (clipboard) {
        setLexicalClipboardDataTransfer(clipboard, $getClipboardDataFromSelection(selection));
        event?.preventDefault();
      }
      const routed = $routeRange();
      if (routed === 'own') selection.removeText();
      return true;
    }, P),
    editor.registerUpdateListener(({ editorState }) => {
      editorState.read(() => {
        const selection = $getSelection();
        const top = $isRangeSelection(selection) ? selection.anchor.getNode().getTopLevelElement() : null;
        fork.caret(top ? top.getIndexWithinParent() : -1);
      });
    }),
  );
}
