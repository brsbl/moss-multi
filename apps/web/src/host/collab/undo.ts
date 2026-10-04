// Seam (a) of the vendored plugin (A§10.2, A§10.8): the body's one Cmd+Z stack over the note's UndoManager, which
// tracks only this client's binding, and one UndoManager per held payload doc, which tracks this client's field
// edits (A§10.10). Cmd+Z never undoes a peer's or the server's writes, and one typing burst is one step.
import { UNDO_COMMAND, REDO_COMMAND, type LexicalEditor } from 'lexical';
import type { Binding } from '@lexical/yjs';
import { UndoManager } from 'yjs';
import { BodyUndo, lexicalAction, payloadDocsFor } from '@moss-multi/sync/payload-docs';

import { REGISTER_LOCAL_ORIGIN } from '@moss-multi/sync/registers';
export { REGISTER_LOCAL_ORIGIN };

export const UNDO_CAPTURE_TIMEOUT_MS = 1_000;

/** The plugin drives it as it would the root UndoManager: undo, redo, clear, the stacks' lengths and their events. */
export function createBindingUndoManager(binding: Binding): UndoManager {
  // A setter and an attribute written in one Lexical update undo together.
  const stack = new BodyUndo(new UndoManager(binding.root.getSharedType(), {
    trackedOrigins: new Set([binding]),
    captureTimeout: UNDO_CAPTURE_TIMEOUT_MS,
  }), binding.editor ? lexicalAction(binding.editor) : undefined);
  const payloads = payloadDocsFor(binding.doc);
  for (const doc of payloads.docs.values()) stack.trackPayload(doc, REGISTER_LOCAL_ORIGIN, UNDO_CAPTURE_TIMEOUT_MS);
  payloads.onHold((_id, doc) => { stack.trackPayload(doc, REGISTER_LOCAL_ORIGIN, UNDO_CAPTURE_TIMEOUT_MS); });
  return stack as unknown as UndoManager;
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
