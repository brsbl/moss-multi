import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { $getNodeByKey, REDO_COMMAND, UNDO_COMMAND, type LexicalEditor } from 'lexical';
import * as Y from 'yjs';
import { registerDoc, REGISTER_LOCAL_ORIGIN } from '@moss-multi/sync/registers';
import { diffText } from '@moss-multi/core/text-diff';
import { remapCaret } from '@moss-multi/core/doc-fields';

type Input = HTMLInputElement | HTMLTextAreaElement;
export function nodeRegister(editor: LexicalEditor, key: string): Y.Text | undefined {
  const node = editor.getEditorState()._nodeMap.get(key) as unknown as { __regId?: string } | undefined;
  const text = node?.__regId && registerDoc(editor)?.getMap('registers').get(node.__regId);
  return text instanceof Y.Text ? text : undefined;
}

/** Moss keeps its field and keyboard behavior; shared text replaces its local-only draft. */
export function useRegisterDraft(
  editor: LexicalEditor, key: string, initial: string, setter: string,
  element: RefObject<HTMLTextAreaElement | null>, editing: boolean,
): [string, (text: string) => void] {
  const [value, display] = useState(initial);
  const composing = useRef<{ doc: Y.Doc; id: string } | null>(null);
  const write = useCallback((next: string) => {
    if (!registerDoc(editor)) { display(next); return; }
    if (!editor.isEditable()) return;
    display(next);
    const draft = composing.current;
    if (draft) {
      const text = draft.doc.getMap<Y.Text>('registers').get(draft.id)!;
      draft.doc.transact(() => text.applyDelta(diffText(text.toString(), next)), REGISTER_LOCAL_ORIGIN);
      return;
    }
    editor.update(() => {
      const node = $getNodeByKey(key) as unknown as Record<string, (text: string) => void> | null;
      node?.[setter](next);
    }, { discrete: true });
  }, [editor, key, setter]);
  useLayoutEffect(() => {
    const text = nodeRegister(editor, key);
    if (!text) return;
    display(text.toString());
    const changed = (event: Y.YTextEvent, transaction: Y.Transaction) => {
      if (composing.current) return;
      const next = text.toString();
      const input = element.current;
      if (input && input.value !== next) {
        repaint(input, next, transaction.origin === REGISTER_LOCAL_ORIGIN ? null : event.delta);
      }
      display(next);
    };
    text.observe(changed);
    return () => { text.unobserve(changed); };
  }, [editor, key, element]);
  useLayoutEffect(() => {
    const input = element.current;
    const doc = registerDoc(editor);
    const text = nodeRegister(editor, key);
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
      const id = (editor.getEditorState()._nodeMap.get(key) as unknown as { __regId: string }).__regId;
      composing.current = { doc: draft, id };
    };
    const end = () => {
      const draft = composing.current;
      if (!draft) return;
      write(input.value);
      if (editor.isEditable()) {
        // The composition merges with what arrived meanwhile, then lands as an edit under the bound doc's own client:
        // the draft's client is unleased in Suggest mode, where the bound doc is the fork.
        Y.applyUpdate(draft.doc, Y.encodeStateAsUpdate(doc, Y.encodeStateVector(draft.doc)));
        const merged = draft.doc.getMap<Y.Text>('registers').get(draft.id)?.toString();
        if (merged !== undefined && merged !== text.toString()) {
          doc.transact(() => text.applyDelta(diffText(text.toString(), merged)), REGISTER_LOCAL_ORIGIN);
        }
      }
      composing.current = null;
      draft.doc.destroy();
      const next = text.toString(); repaint(input, next, diffText(input.value, next)); display(next);
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
  }, [editor, key, element, editing, write]);
  return [value, write];
}

export function repaint(input: Input, next: string, delta: Y.YTextEvent['delta'] | null): void {
  const start = input.selectionStart ?? 0; const end = input.selectionEnd ?? start;
  input.value = next;
  if (input.ownerDocument.activeElement === input) {
    input.setSelectionRange(delta ? remapCaret(start, delta) : start, delta ? remapCaret(end, delta) : end);
  }
}
