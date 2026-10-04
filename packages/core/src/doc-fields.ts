// Title text and the canonical YAML boundary for structured properties (A§10.4).
import * as Y from 'yjs';
import { diffText } from './text-diff.ts';
import { frontmatterYaml, importFrontmatter, observeFrontmatter } from './frontmatter.ts';

export type DocField = 'title' | 'frontmatter';

/** A change as its observer saw it: the Yjs delta against the text before it, and the transaction origin. */
export interface FieldChange {
  delta: Y.YTextEvent['delta'];
  origin: unknown;
}

export const fieldText = (doc: Y.Doc, field: DocField): Y.Text => doc.getText(field);

export const readField = (doc: Y.Doc, field: DocField): string => field === 'frontmatter' ? frontmatterYaml(doc) : fieldText(doc, field).toString();

/** Writes `next` into the field in one transaction under `origin`, diffed within `budget` cells; false when nothing changed. */
export function writeField(doc: Y.Doc, field: DocField, next: string, origin: unknown, budget?: number): boolean {
  if (field === 'frontmatter') return importFrontmatter(doc, next, origin);
  const text = fieldText(doc, field);
  const current = text.toString();
  if (current === next) return false;
  doc.transact(() => text.applyDelta(diffText(current, next, budget)), origin);
  return true;
}

/** Calls `listener` with the text after every change; returns the unsubscriber. */
export function observeField(doc: Y.Doc, field: DocField, listener: (text: string, change: FieldChange) => void): () => void {
  if (field === 'frontmatter') {
    let previous = frontmatterYaml(doc);
    return observeFrontmatter(doc, (_data, origin) => {
      const text = frontmatterYaml(doc);
      const delta = diffText(previous, text);
      previous = text;
      listener(text, { delta, origin });
    });
  }
  const text = fieldText(doc, field);
  const handler = (event: Y.YTextEvent, transaction: Y.Transaction) => {
    listener(text.toString(), { delta: event.delta, origin: transaction.origin });
  };
  text.observe(handler);
  return () => text.unobserve(handler);
}

/**
 * Where a caret at `offset` belongs after the change `delta`, read from the change itself: a diff of the two texts
 * cannot tell "aa" -> "aaa" at the start from the same edit at the end. Text inserted before the caret moves it
 * right, text deleted before it moves it left (a cut spanning it leaves it at the cut), and an insert exactly at
 * the caret leaves it in front, so a peer typing at your caret never drags it along.
 */
export function remapCaret(offset: number, delta: FieldChange['delta']): number {
  let at = 0;
  let shift = 0;
  for (const op of delta) {
    if (at >= offset) break;
    if (op.retain !== undefined) at += op.retain;
    else if (op.insert !== undefined) shift += typeof op.insert === 'string' ? op.insert.length : 1;
    else if (op.delete !== undefined) {
      shift -= Math.min(op.delete, offset - at);
      at += op.delete;
    }
  }
  return Math.max(0, offset + shift);
}
