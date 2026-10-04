// Seam (a) of the vendored plugin (A§10.2, A§10.8): the body's undo manager tracks only this client's binding, so
// Cmd+Z never undoes a peer's or the server's writes, and one typing burst is one step.
import { UNDO_COMMAND, REDO_COMMAND, type LexicalEditor } from 'lexical';
import type { Binding } from '@lexical/yjs';
import {
  ContentString, ContentType, Text as YText, UndoManager, XmlElement, XmlText, isDeleted,
  type Item, type Transaction,
} from 'yjs';

import { REGISTER_LOCAL_ORIGIN, namesRegister } from '@moss-multi/sync/registers';
export { REGISTER_LOCAL_ORIGIN };

export const UNDO_CAPTURE_TIMEOUT_MS = 1_000;
type StackItem = UndoManager['undoStack'][number];

export function createBindingUndoManager(binding: Binding): UndoManager {
  const { doc } = binding;
  const registers = doc.getMap('registers');
  const root = binding.root.getSharedType();
  const trackedOrigins = new Set<unknown>([binding, REGISTER_LOCAL_ORIGIN]);
  // Clients whose items this manager may remove: this doc, plus any draft doc merged in under a tracked origin.
  const own = new Set([doc.clientID]);
  const noteOwn = (transaction: Transaction) => {
    if (!trackedOrigins.has(transaction.origin)) return;
    transaction.afterState.forEach((clock, client) => { if ((transaction.beforeState.get(client) ?? 0) < clock) own.add(client); });
  };
  const foreign = (item: Item) => !item.deleted && !own.has(item.id.client);
  const holdsForeign = (type: { _start: Item | null }): boolean => {
    for (let item = type._start; item; item = item.right) {
      if (foreign(item)) return true;
      if (!item.deleted && item.content instanceof ContentType && holdsForeign(item.content.type)) return true;
    }
    // A shared payload is this container's alone unless another live block names it (a move's other copy).
    const regId = type instanceof XmlText || type instanceof XmlElement ? type.getAttribute('__regId') : undefined;
    if (typeof regId !== 'string' || namesRegister(root, regId, type)) return false;
    const payload = registers.get(regId);
    return payload instanceof YText && holdsForeign(payload);
  };
  /**
   * Undo removes only this client's content. A container it would delete is kept while it holds a peer's live
   * text: a paragraph or block, or a text node's property map, which in @lexical/yjs owns the characters after it.
   * Deleting that map left the peer's characters dangling, and the binding then deleted them for everyone.
   */
  const keeps = (item: Item): boolean => {
    if (item.deleted || !(item.content instanceof ContentType)) return false;
    const type = item.content.type;
    if (item.parent instanceof XmlText && !(type instanceof XmlText || type instanceof XmlElement)) {
      for (let next = item.right; next; next = next.right) {
        if (next.deleted) continue;
        if (!(next.content instanceof ContentString)) return false;
        if (foreign(next)) return true;
      }
      return false;
    }
    return holdsForeign(type);
  };
  // The step Yjs is undoing or redoing, so a kept container also keeps the properties it was created with. One
  // undo() pops past steps that change nothing, so this follows the stack rather than its top at the call.
  let step: () => StackItem | undefined = () => undefined;
  const deleteFilter = (item: Item): boolean => {
    const owner = item.parentSub === null ? null : (item.parent as { _item: Item | null })._item;
    if (!owner) return !keeps(item);
    const current = step();
    return !(current && isDeleted(current.insertions, owner.id) && keeps(owner));
  };
  const undo = new UndoManager([root, registers], {
    trackedOrigins,
    captureTimeout: UNDO_CAPTURE_TIMEOUT_MS,
    deleteFilter,
  });
  const during = (stack: () => StackItem[], run: () => StackItem | null) => () => {
    const items = stack().slice();
    step = () => items[stack().length];
    try { return run(); } finally { step = () => undefined; }
  };
  undo.undo = during(() => undo.undoStack, undo.undo.bind(undo));
  undo.redo = during(() => undo.redoStack, undo.redo.bind(undo));
  doc.on('afterTransaction', noteOwn);
  const destroy = undo.destroy.bind(undo);
  undo.destroy = () => { doc.off('afterTransaction', noteOwn); destroy(); };
  return undo;
}

let focusedBody: LexicalEditor | null = null;
export function trackUndoFocus(editor: LexicalEditor): () => void {
  const focus = () => { focusedBody = editor; };
  const stop = editor.registerRootListener((root, previous) => {
    previous?.removeEventListener('focusin', focus);
    root?.addEventListener('focusin', focus);
  });
  return () => { stop(); if (focusedBody === editor) focusedBody = null; };
}
export function undoFromEmptyPrompt(event: { key: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; preventDefault(): void; stopPropagation(): void }): void {
  if (!(event.metaKey || event.ctrlKey) || event.altKey || event.key.toLowerCase() !== 'z' || !focusedBody?.isEditable()) return;
  event.preventDefault(); event.stopPropagation();
  focusedBody.dispatchCommand(event.shiftKey ? REDO_COMMAND : UNDO_COMMAND, undefined);
}
