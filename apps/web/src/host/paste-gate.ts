// T3.S6: a large paste goes into a bound note batch by batch (large-paste.ts), each batch once the server has acked
// the last, so the unacked writes a resync or reconnect resends stay one batch. The doc session installs the wait; an
// unbound editor (the viewer, the embeddable editor) waits for nothing.
import type { LexicalEditor } from 'lexical';

type Gate = (editor: LexicalEditor) => Promise<unknown>;

let gate: Gate = () => Promise.resolve();

export function setPasteGate(next: Gate): void {
  gate = next;
}

/** Resolves once `editor`'s doc may take the next batch of a paste. */
export const pasteGate = (editor: LexicalEditor): Promise<unknown> => gate(editor);
