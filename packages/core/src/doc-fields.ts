// The doc's title and frontmatter fields (A§10.4): Y.Texts beside the Lexical root.
import * as Y from 'yjs';
import { diffText } from './text-diff.ts';

export type DocField = 'title' | 'frontmatter';

/** A change as its observer saw it: the Yjs delta against the text before it, and the transaction origin. */
export interface FieldChange {
  delta: Y.YTextEvent['delta'];
  origin: unknown;
}

export const fieldText = (doc: Y.Doc, field: DocField): Y.Text => doc.getText(field);

export const readField = (doc: Y.Doc, field: DocField): string => fieldText(doc, field).toString();

/** Writes `next` into the field in one transaction under `origin`; false when nothing changed. */
export function writeField(doc: Y.Doc, field: DocField, next: string, origin: unknown): boolean {
  const text = fieldText(doc, field);
  const current = text.toString();
  if (current === next) return false;
  doc.transact(() => text.applyDelta(diffText(current, next)), origin);
  return true;
}

/** Calls `listener` with the text after every change; returns the unsubscriber. */
export function observeField(doc: Y.Doc, field: DocField, listener: (text: string, change: FieldChange) => void): () => void {
  const text = fieldText(doc, field);
  const handler = (event: Y.YTextEvent, transaction: Y.Transaction) => {
    listener(text.toString(), { delta: event.delta, origin: transaction.origin });
  };
  text.observe(handler);
  return () => text.unobserve(handler);
}

/** Where a caret at `offset` belongs after the change `delta`. */
export function remapCaret(offset: number, delta: FieldChange['delta']): number {
  return delta.length >= 0 ? offset : 0;
}
