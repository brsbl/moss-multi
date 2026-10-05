// Routed deletes in Suggest mode (docs/design/suggestions.md §5): an explicit delete over body items (Backspace,
// Delete, word or line delete, Cut, typing, Enter or paste over a selection) proposes a delete part with the exact
// ids instead of removing them; the text stays in F painted struck and the caret moves past it. The author's own
// pending text in the same selection deletes natively. Undo and redo take a strike back and put it again, in order
// with the binding's own undo steps. Everything else is native and recorded verbatim (a join at a block edge too).
import { $getClipboardDataFromSelection, setLexicalClipboardDataTransfer } from '@lexical/clipboard';
import type { IdSpan } from '@moss-multi/protocol/suggest';
import type { SuggestFork } from '@moss-multi/sync/suggest/client';
import {
  $getNodeByKey, $getSelection, $isElementNode, $isRangeSelection, $isTextNode, COMMAND_PRIORITY_CRITICAL,
  CONTROLLED_TEXT_INSERTION_COMMAND, CUT_COMMAND, DELETE_CHARACTER_COMMAND, DELETE_LINE_COMMAND, DELETE_WORD_COMMAND,
  INSERT_LINE_BREAK_COMMAND, INSERT_PARAGRAPH_COMMAND, mergeRegister, PASTE_COMMAND, REDO_COMMAND, UNDO_COMMAND,
  type LexicalEditor, type LexicalNode, type TextNode,
} from 'lexical';
import type * as Y from 'yjs';
import { bindingOf } from '../binding-registry.ts';
import { charAround, sharedItem, textIds, toSpans } from './chars.ts';

type Routed = 'none' | 'struck' | 'own' | 'skip';

const UNDO_MANAGER = Symbol.for('@lexical/yjs/UndoManager');

/** The leaf beside `node` inside its block, entering inline elements such as links; null at the block's edge. */
function $besideLeaf(node: LexicalNode, backward: boolean): LexicalNode | null {
  let current: LexicalNode = node;
  for (;;) {
    const sibling = backward ? current.getPreviousSibling() : current.getNextSibling();
    if (sibling) {
      let leaf: LexicalNode = sibling;
      for (;;) {
        if (!$isElementNode(leaf) || !leaf.isInline()) return leaf;
        const child: LexicalNode | null = backward ? leaf.getLastChild() : leaf.getFirstChild();
        if (!child) return leaf;
        leaf = child;
      }
    }
    const parent = current.getParent();
    if (!parent || !parent.isInline()) return null;
    current = parent;
  }
}

/** A strike as an undo step: `depth` is the binding's undo stack before it; `native` when own text went with it. */
interface Strike {
  part: string;
  targets: IdSpan[];
  depth: number;
  native: boolean;
}

export function registerSuggestRouting(editor: LexicalEditor, fork: SuggestFork): () => void {
  const manager = (): Y.UndoManager | null => (editor as unknown as Record<symbol, Y.UndoManager | undefined>)[UNDO_MANAGER] ?? null;
  const undone: Strike[] = [];
  const redone: Strike[] = [];
  let watched: Y.UndoManager | null = null;
  // Any new edit of his own ends the redo history, strikes included.
  const onStack = (event: { type: 'undo' | 'redo' }) => {
    if (event.type === 'undo' && watched && !watched.undoing && !watched.redoing) redone.length = 0;
  };
  const watch = (undo: Y.UndoManager | null) => {
    if (undo === watched) return;
    watched?.off('stack-item-added', onStack);
    watched?.off('stack-item-updated', onStack);
    watched = undo;
    undo?.on('stack-item-added', onStack);
    undo?.on('stack-item-updated', onStack);
  };
  /** A strike joins the undo history as its own step; `native` when the next binding step belongs to it. */
  const remember = (part: string, targets: IdSpan[], native: boolean) => {
    const undo = manager();
    watch(undo);
    undo?.stopCapturing();
    undone.push({ part, targets, depth: undo?.undoStack.length ?? 0, native });
    redone.length = 0;
    if (native) setTimeout(() => manager()?.stopCapturing(), 0);
  };
  const strike = (ids: readonly Y.ID[], native = false): string | null => {
    const targets = toSpans(ids);
    const part = fork.proposeDelete(targets);
    if (part) remember(part, targets, native);
    return part;
  };

  /**
   * A non-collapsed selection: body items in it become one delete part, the author's own text in it is removed
   * natively, and the caret goes to its end. `own`: only the author's own text, which deletes natively. `skip`:
   * nothing left to strike; the caret still moves.
   */
  const $routeRange = (): Routed => {
    const selection = $getSelection();
    const binding = bindingOf(editor);
    if (!$isRangeSelection(selection) || selection.isCollapsed() || !binding) return 'none';
    const own = fork.ownClients();
    const [start, end] = selection.isBackward() ? [selection.focus, selection.anchor] : [selection.anchor, selection.focus];
    const body: Y.ID[] = [];
    const mine: { node: TextNode; from: number; to: number }[] = [];
    const mineLeaves: LexicalNode[] = [];
    for (const node of selection.getNodes()) {
      if ($isTextNode(node)) {
        const ids = textIds(binding, node.getKey());
        if (!ids) continue;
        const from = start.type === 'text' && start.key === node.getKey() ? start.offset : 0;
        const to = end.type === 'text' && end.key === node.getKey() ? end.offset : ids.length;
        let run = -1;
        for (let i = from; i < to; i += 1) {
          const id = ids[i];
          if (own.has(id.client)) {
            if (run < 0) run = i;
            continue;
          }
          if (run >= 0) mine.push({ node, from: run, to: i });
          run = -1;
          if (!fork.isStruck(id)) body.push(id);
        }
        if (run >= 0) mine.push({ node, from: run, to });
        continue;
      }
      if ($isElementNode(node)) continue;
      // A line break or a decorator inside the selection.
      const item = sharedItem(binding, node.getKey());
      if (!item) continue;
      if (own.has(item.id.client)) mineLeaves.push(node);
      else if (!fork.isStruck(item.id)) body.push(item.id);
    }
    const owned = mine.length + mineLeaves.length;
    if (body.length === 0 && owned > 0) return 'own';
    if (body.length > 0 && !strike(body, owned > 0)) return 'skip';
    const caret = { key: end.key, offset: end.offset, type: end.type };
    // His own characters go natively, last first so earlier offsets hold.
    for (const { node, from, to } of mine.reverse()) {
      if (caret.type === 'text' && node.getKey() === caret.key) caret.offset -= to - from;
      node.spliceText(from, to - from, '', false);
    }
    for (const leaf of mineLeaves) leaf.remove();
    const target = $getNodeByKey(caret.key);
    if (target?.isAttached()) {
      selection.anchor.set(caret.key, Math.max(0, caret.offset), caret.type);
      selection.focus.set(caret.key, Math.max(0, caret.offset), caret.type);
    } else {
      const anchor = selection.anchor.getNode();
      if (anchor.isAttached() && $isTextNode(anchor)) anchor.select(selection.anchor.offset, selection.anchor.offset);
    }
    return body.length > 0 ? 'struck' : 'skip';
  };

  /**
   * Backspace or Delete at a collapsed caret: past struck items to the next character or inline leaf (a link's
   * text, a line break, an inline formula), struck or, if his own, deleted natively. A block edge is native (a join).
   */
  const $routeChar = (backward: boolean): boolean => {
    const selection = $getSelection();
    const binding = bindingOf(editor);
    if (!$isRangeSelection(selection) || !selection.isCollapsed() || selection.anchor.type !== 'text' || !binding) return false;
    const own = fork.ownClients();
    let node: LexicalNode = selection.anchor.getNode();
    let offset = selection.anchor.offset;
    const step = (from: LexicalNode): boolean => {
      const next = $besideLeaf(from, backward);
      if (!next) return false;
      node = next;
      offset = $isTextNode(next) ? (backward ? next.getTextContentSize() : 0) : 0;
      return true;
    };
    for (let guard = 0; guard < 100_000; guard += 1) {
      if ($isTextNode(node)) {
        const text: TextNode = node;
        const ids = textIds(binding, text.getKey());
        if (!ids) return false;
        const at = backward ? offset - 1 : offset;
        if (at >= 0 && at < ids.length) {
          // A whole character: both halves of a surrogate pair, and a grapheme's combining marks.
          const content = text.getTextContent();
          const [from, to] = content.length === ids.length ? charAround(content, at) : [at, at + 1];
          const id = ids[at];
          if (fork.isStruck(id)) {
            offset = backward ? from : to;
            continue;
          }
          if (own.has(id.client)) {
            const caret = backward ? to : from;
            text.select(caret, caret);
            return false;
          }
          const body = ids.slice(from, to).filter((unit) => !own.has(unit.client) && !fork.isStruck(unit));
          strike(body);
          const caret = backward ? from : to;
          text.select(caret, caret);
          return true;
        }
        if (!step(text)) {
          // A block edge: native, from past the struck text.
          text.select(offset, offset);
          return false;
        }
        continue;
      }
      // A line break, an inline decorator or an empty inline element.
      const leaf: LexicalNode = node;
      const item = sharedItem(binding, leaf.getKey());
      if (!item) return false;
      if (own.has(item.id.client)) {
        if (backward) leaf.selectNext(0, 0);
        else leaf.selectPrevious();
        return false;
      }
      if (!fork.isStruck(item.id)) {
        strike([item.id]);
        if (backward) leaf.selectPrevious();
        else leaf.selectNext(0, 0);
        return true;
      }
      if (!step(leaf)) {
        if (backward) leaf.selectPrevious();
        else leaf.selectNext(0, 0);
        return false;
      }
    }
    return false;
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
    () => watch(null),
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
    // Undo takes back the latest strike when no later step of his came after it; with own text it removed, the
    // binding's undo of that removal runs in the same keystroke.
    editor.registerCommand(UNDO_COMMAND, () => {
      const undo = manager();
      const last = undone.at(-1);
      if (!last || !undo) return false;
      const expected = last.depth + (last.native ? 1 : 0);
      const length = undo.undoStack.length;
      if (length > expected) return false;
      undone.pop();
      fork.withdrawPart(last.part);
      const native = last.native && length === expected;
      redone.push({ ...last, depth: undo.redoStack.length, native });
      return !native;
    }, P),
    editor.registerCommand(REDO_COMMAND, () => {
      const undo = manager();
      const last = redone.at(-1);
      if (!last || !undo) return false;
      const expected = last.depth + (last.native ? 1 : 0);
      const length = undo.redoStack.length;
      if (length > expected) return false;
      redone.pop();
      const native = last.native && length === expected;
      const part = fork.proposeDelete(last.targets);
      if (part) {
        undo.stopCapturing();
        undone.push({ part, targets: last.targets, depth: undo.undoStack.length, native });
      }
      return !native;
    }, P),
    fork.on((event) => {
      // A closed record's steps leave the binding's stacks (pane.tsx dropUndo); its strikes go with them.
      if (event.type === 'closed') {
        undone.length = 0;
        redone.length = 0;
      }
    }),
    editor.registerUpdateListener(({ editorState }) => {
      editorState.read(() => {
        const selection = $getSelection();
        const top = $isRangeSelection(selection) ? selection.anchor.getNode().getTopLevelElement() : null;
        fork.caret(top ? top.getIndexWithinParent() : -1);
      });
    }),
  );
}
