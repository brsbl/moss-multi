import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type RefObject } from 'react';
import { COLLABORATION_TAG, REDO_COMMAND, UNDO_COMMAND, type Klass, type LexicalEditor, type LexicalNode } from 'lexical';
import * as Y from 'yjs';
import { onRegisterChange, payloadTextOf, registerDoc, registerState, REGISTER_LOCAL_ORIGIN, writeRegisterEdit } from '@moss-multi/sync/registers';
import { payloadText } from '@moss-multi/sync/payload-docs';
import { diffText } from '@moss-multi/core/text-diff';
import { remapCaret } from '@moss-multi/core/doc-fields';
import { refuseInput } from '../refusal.ts';

type Input = HTMLInputElement | HTMLTextAreaElement;
/** The payload text behind a node: its own payload doc's (A§10.10), held now. */
export function nodeRegister(editor: LexicalEditor, key: string): Y.Text | undefined {
  return payloadTextOf(editor, key);
}

/** Shown when a peer removes the block whose field is open (or a server dedupe drops its copy). */
export const FIELD_REMOVED = 'The block you were editing was removed.';

interface OpenField { start: number; end: number; claimed: boolean }
/** The open field of each payload, so a field survives its node being recreated (a V1 move). */
const openFields = new WeakMap<LexicalEditor, Map<string, OpenField>>();
/** Selections a recreated node's field restores, by node key. */
const resumed = new WeakMap<LexicalEditor, Map<string, OpenField>>();

/**
 * Whether node `key` opens its field at mount: the field on its payload was open when the node holding it was
 * recreated, as a peer's move does. Called once from the view's initial state.
 */
export function resumeField(editor: LexicalEditor, key: string): boolean {
  const id = registerState(editor, key)?.id;
  const open = id ? openFields.get(editor)?.get(id) : undefined;
  if (!open || open.claimed) return false;
  open.claimed = true;
  let byKey = resumed.get(editor);
  if (!byKey) resumed.set(editor, (byKey = new Map()));
  byKey.set(key, open);
  return true;
}

function useRegisterState(editor: LexicalEditor, key: string): { id: string | undefined; ready: boolean } {
  const subscribe = useCallback((notify: () => void) => {
    const stopUpdates = editor.registerUpdateListener(notify);
    const stopChanges = onRegisterChange(editor, notify);
    return () => { stopUpdates(); stopChanges(); };
  }, [editor]);
  const read = () => {
    const state = registerState(editor, key);
    return state ? `${state.ready ? 1 : 0}${state.id}` : '';
  };
  const snapshot = useSyncExternalStore(subscribe, read, read);
  return { id: snapshot.slice(1) || undefined, ready: snapshot.startsWith('1') };
}

/** Whether node `key`'s field may take input: always off a bound note, else once its payload has arrived. */
export function useRegisterWritable(editor: LexicalEditor, key: string): boolean {
  const { ready } = useRegisterState(editor, key);
  return !registerDoc(editor) || ready;
}

/**
 * Moss keeps its field and keyboard behavior; on a bound note the field edits its node's payload, resolved by id on
 * every write and every change of id. Each input is written as the edit it made against the payload as it is now
 * (`writeRegisterEdit`), never as the field's whole value. Returns the text to show, the writer, and whether the field
 * may take input: until its payload has arrived it shows the node's render cache, read-only.
 */
export function useRegisterDraft(
  editor: LexicalEditor, key: string, initial: string,
  element: RefObject<HTMLTextAreaElement | null>, editing: boolean,
): [string, (text: string) => void, boolean] {
  const [value, display] = useState(initial);
  const bound = !!registerDoc(editor);
  const { id, ready } = useRegisterState(editor, key);
  const live = bound && ready && !!id;
  // The text the field shows: the payload's as of its last change, or the cache while it is not live.
  const painted = useRef(initial);
  const composing = useRef<{ doc: Y.Doc; base: Uint8Array } | null>(null);
  const write = useCallback((next: string) => {
    if (!registerDoc(editor)) { display(next); return; }
    if (!editor.isEditable()) return;
    const draft = composing.current;
    if (draft) {
      const text = payloadText(draft.doc);
      draft.doc.transact(() => text.applyDelta(diffText(text.toString(), next)), REGISTER_LOCAL_ORIGIN);
      display(next);
      return;
    }
    const input = element.current;
    const focused = !!input && input.value === next && input.ownerDocument.activeElement === input;
    const caret = focused ? input.selectionEnd ?? undefined : undefined;
    const result = writeRegisterEdit(editor, key, painted.current, next, caret);
    if (result === null) {
      // Not live: the field keeps what it showed.
      if (input && input.value !== painted.current) repaint(input, painted.current, null);
      return;
    }
    painted.current = result;
    if (input && input.value !== result) repaint(input, result, diffText(input.value, result));
    display(result);
  }, [editor, key, element]);
  useLayoutEffect(() => {
    if (!bound) return;
    const input = element.current;
    if (!live) {
      painted.current = initial;
      if (input && input.value !== initial) repaint(input, initial, null);
      display(initial);
      return;
    }
    const text = nodeRegister(editor, key);
    if (!text) return;
    const show = (delta: Y.YTextEvent['delta'] | null) => {
      const next = text.toString();
      painted.current = next;
      const field = element.current;
      if (field && field.value !== next) repaint(field, next, delta ?? diffText(field.value, next));
      display(next);
    };
    show(null);
    const changed = (event: Y.YTextEvent, transaction: Y.Transaction) => {
      if (composing.current) return;
      // A local edit is already in the field; a rebased one is repainted by its difference.
      show(transaction.origin === REGISTER_LOCAL_ORIGIN ? null : event.delta);
    };
    text.observe(changed);
    return () => { text.unobserve(changed); };
    // The cache shows only while the field is not live, so a cache change matters only then.
  }, [editor, key, element, bound, live, id, live ? '' : initial]);
  useLayoutEffect(() => {
    const input = element.current;
    const text = live ? nodeRegister(editor, key) : undefined;
    const doc = text?.doc;
    if (!editing || !input || !doc || !text) return;
    const keyboard = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase();
      if (!(event.metaKey || event.ctrlKey) || event.altKey || (key !== 'z' && key !== 'y')) return;
      event.preventDefault(); event.stopImmediatePropagation();
      if (editor.isEditable() && !composing.current) editor.dispatchCommand(event.shiftKey || key === 'y' ? REDO_COMMAND : UNDO_COMMAND, undefined);
    };
    const start = () => {
      if (!editor.isEditable()) return;
      const draft = new Y.Doc(); Y.applyUpdate(draft, Y.encodeStateAsUpdate(doc));
      composing.current = { doc: draft, base: Y.encodeStateVector(draft) };
    };
    const end = () => {
      const draft = composing.current;
      if (!draft) return;
      write(input.value);
      if (editor.isEditable()) Y.applyUpdate(doc, Y.encodeStateAsUpdate(draft.doc, draft.base), REGISTER_LOCAL_ORIGIN);
      composing.current = null;
      draft.doc.destroy();
      const next = text.toString(); painted.current = next; repaint(input, next, diffText(input.value, next)); display(next);
    };
    input.addEventListener('keydown', keyboard, true);
    input.addEventListener('compositionstart', start);
    input.addEventListener('compositionend', end);
    return () => {
      input.removeEventListener('keydown', keyboard, true);
      input.removeEventListener('compositionstart', start);
      input.removeEventListener('compositionend', end);
      composing.current?.doc.destroy(); composing.current = null;
    };
  }, [editor, key, element, editing, write, live]);
  useOpenField(editor, key, id, element, editing && bound);
  return [value, write, !bound || live];
}

/**
 * Remembers an open field by payload id. A recreated node with the same id (a peer's move) reopens it with its
 * selection; a node removed with nothing recreating its id closes it with a notice.
 */
function useOpenField(editor: LexicalEditor, key: string, id: string | undefined, element: RefObject<HTMLTextAreaElement | null>, open: boolean): void {
  useEffect(() => {
    const input = element.current;
    if (!open || !id || !input) return;
    let fields = openFields.get(editor);
    if (!fields) openFields.set(editor, (fields = new Map()));
    const restore = resumed.get(editor)?.get(key);
    resumed.get(editor)?.delete(key);
    const field: OpenField = { start: restore?.start ?? input.selectionStart, end: restore?.end ?? input.selectionEnd, claimed: false };
    fields.set(id, field);
    // After the view's own focus effect, which puts the caret at the end.
    if (restore) queueMicrotask(() => { input.focus(); input.setSelectionRange(field.start, field.end); });
    const track = () => { field.start = input.selectionStart; field.end = input.selectionEnd; };
    const events = ['select', 'input', 'keyup', 'mouseup'] as const;
    for (const name of events) input.addEventListener(name, track);
    // Whether the update that removed the node was a peer's; the user's own removal (an undo) needs no notice. Mutation
    // listeners run before the decorator re-render that unmounts this field.
    let byPeer = false;
    const klass = editor.getEditorState()._nodeMap.get(key)?.constructor as Klass<LexicalNode> | undefined;
    const stopUpdates = klass ? editor.registerMutationListener(klass, (mutations, { updateTags }) => {
      if (mutations.get(key) === 'destroyed') byPeer = updateTags.has(COLLABORATION_TAG);
    }, { skipInitialization: true }) : () => {};
    return () => {
      stopUpdates();
      for (const name of events) input.removeEventListener(name, track);
      const removed = editor.getRootElement() !== null && !editor.getEditorState()._nodeMap.has(key);
      if (!removed || field.claimed || !byPeer) {
        if (fields.get(id) === field && !field.claimed) fields.delete(id);
        return;
      }
      // The node is gone; a node recreated with this id in the same commit has claimed the field already.
      setTimeout(() => {
        if (fields.get(id) !== field || field.claimed) return;
        fields.delete(id);
        refuseInput(FIELD_REMOVED);
      }, 0);
    };
  }, [editor, key, id, element, open]);
}

export function repaint(input: Input, next: string, delta: Y.YTextEvent['delta'] | null): void {
  const start = input.selectionStart ?? 0; const end = input.selectionEnd ?? start;
  input.value = next;
  if (input.ownerDocument.activeElement === input) {
    input.setSelectionRange(delta ? remapCaret(start, delta) : start, delta ? remapCaret(end, delta) : end);
  }
}
