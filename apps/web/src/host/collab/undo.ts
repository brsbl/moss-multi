// Seam (a) of the vendored plugin (A§10.2, A§10.8): the body's undo manager tracks only this client's binding, so
// Cmd+Z never undoes a peer's or the server's writes, and one typing burst is one step.
import { UNDO_COMMAND, REDO_COMMAND, type LexicalEditor } from 'lexical';
import type { Binding } from '@lexical/yjs';
import {
  ContentString, ContentType, Item, Map as YMap, UndoManager, XmlText, findIndexSS, isDeleted, type AbstractType, type Transaction,
} from 'yjs';

import { REGISTER_LOCAL_ORIGIN } from '@moss-multi/sync/registers';
export { REGISTER_LOCAL_ORIGIN };

export const UNDO_CAPTURE_TIMEOUT_MS = 1_000;
type StackItem = UndoManager['undoStack'][number];

/**
 * Undo deletes only this client's items, but deleting a container deletes everything in it, and peers type into
 * containers this client created: a paragraph (Y.XmlText), and a text node's property map, which in @lexical/yjs owns
 * the characters after it up to the next embed (deleting the map left them dangling, and the binding then deleted
 * them for everyone). So undo keeps a container while it holds a peer's live characters, together with the
 * properties it was created with; only this client's own characters go. Undoing a delete restores the deleted items
 * as copies under this client's id (yjs redoItem), so a copy keeps the author of the item it restores.
 */
export function createBindingUndoManager(binding: Binding): UndoManager {
  const { doc } = binding;
  const trackedOrigins = new Set<unknown>([binding, REGISTER_LOCAL_ORIGIN]);
  // This client's ids: the doc's own, plus a draft doc's merged in under a tracked origin (register-input.ts).
  const own = new Set([doc.clientID]);
  const noteOwn = (transaction: Transaction) => {
    if (!trackedOrigins.has(transaction.origin)) return;
    transaction.afterState.forEach((clock, client) => { if ((transaction.beforeState.get(client) ?? 0) < clock) own.add(client); });
  };
  // Restored copies: id ranges of this client's items whose characters another client wrote.
  const copies = new Map<number, { clock: number; len: number; author: number }[]>();
  const authorsOf = (client: number, clock: number, len: number) => {
    const known = copies.get(client);
    if (!known) return [{ clock, len, author: client }];
    const found: { clock: number; len: number; author: number }[] = [];
    let at = clock;
    for (const copy of known) {
      const from = Math.max(at, copy.clock); const to = Math.min(clock + len, copy.clock + copy.len);
      if (from >= to) continue;
      if (from > at) found.push({ clock: at, len: from - at, author: client });
      found.push({ clock: from, len: to - from, author: copy.author });
      at = to;
    }
    if (at < clock + len) found.push({ clock: at, len: clock + len - at, author: client });
    return found;
  };
  const byPeer = (item: Item) => authorsOf(item.id.client, item.id.clock, item.length).some(({ author }) => !own.has(author));
  const isPeers = (item: Item) => !item.deleted && byPeer(item);
  // After an undo or redo, each deleted item it restored points (`redone`) at its copy.
  const rememberCopies = (steps: StackItem[]) => {
    const found: [number, { clock: number; len: number; author: number }][] = [];
    for (const step of steps) step.deletions.clients.forEach((ranges, client) => {
      const structs = doc.store.clients.get(client);
      if (!structs) return;
      const end = structs.at(-1)!.id.clock + structs.at(-1)!.length;
      for (const { clock, len } of ranges) {
        if (clock >= end) continue;
        for (let i = findIndexSS(structs, clock); i < structs.length && structs[i]!.id.clock < clock + len; i++) {
          const original = structs[i]!;
          if (!(original instanceof Item) || !original.redone) continue;
          const { redone } = original;
          for (const part of authorsOf(client, original.id.clock, original.length)) {
            if (part.author !== redone.client) found.push([redone.client, { ...part, clock: redone.clock + part.clock - original.id.clock }]);
          }
        }
      }
    });
    for (const [client, copy] of found) copies.set(client, [...copies.get(client) ?? [], copy].sort((a, b) => a.clock - b.clock));
  };
  const holdsNested = (item: Item | null): boolean =>
    !!item && !item.deleted && item.content instanceof ContentType && holdsPeers(item.content.type as AbstractType<unknown>);
  // A peer's live item in the sequence, or in a nested type at any depth (a property value is not content).
  const holdsPeers = (type: AbstractType<unknown>): boolean => {
    for (let item = type._start; item; item = item.right) if (isPeers(item) || holdsNested(item)) return true;
    for (const item of type._map.values()) if (holdsNested(item)) return true;
    return false;
  };
  // Only a container this client made is kept; redoing its delete of a peer's restored container still deletes it.
  const keeps = (item: Item): boolean => {
    if (item.deleted || !(item.content instanceof ContentType) || byPeer(item)) return false;
    const type = item.content.type as AbstractType<unknown>;
    if (item.parent instanceof XmlText && item.parentSub === null && type instanceof YMap) {
      for (let next = item.right; next; next = next.right) {
        if (next.deleted) continue;
        if (!(next.content instanceof ContentString)) return false;
        if (isPeers(next)) return true;
      }
      return false;
    }
    return holdsPeers(type);
  };
  // The step being undone or redone. One undo() pops past steps that change nothing, so this follows the stack.
  let stack: StackItem[] | null = null;
  let popped: StackItem[] = [];
  const deleteFilter = (item: Item): boolean => {
    if (item.parentSub === null) return !keeps(item);
    const owner = (item.parent as AbstractType<unknown>)._item;
    const step = stack ? popped[stack.length] : undefined;
    return !(owner && step && isDeleted(step.insertions, owner.id) && keeps(owner));
  };
  const undo = new UndoManager([binding.root.getSharedType(), doc.getMap('registers')], {
    trackedOrigins,
    captureTimeout: UNDO_CAPTURE_TIMEOUT_MS,
    deleteFilter,
  });
  const following = (read: () => StackItem[], run: () => StackItem | null) => () => {
    stack = read(); popped = stack.slice();
    try { return run(); } finally { rememberCopies(popped.slice(stack.length)); stack = null; popped = []; }
  };
  undo.undo = following(() => undo.undoStack, undo.undo.bind(undo));
  undo.redo = following(() => undo.redoStack, undo.redo.bind(undo));
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
