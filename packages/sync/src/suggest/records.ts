// Suggestion records in `Y.Map('suggestions')` (docs/design/suggestions.md §1). Only the DocDO writes them, under
// SUGGESTIONS_ORIGIN; a record's ops are stored and never applied to the body except by accept.
import * as Y from 'yjs';
import type { DeletePart, RecordMeta, SuggestionRecord } from '@moss-multi/core/suggest/apply';

export const SUGGESTIONS = 'suggestions';
export const SUGGESTIONS_ORIGIN = 'server-suggestions';
export const SUGGEST_ACCEPT = 'suggest-accept';

const recordMap = (doc: Y.Doc, id: string): Y.Map<unknown> | null => {
  const value = doc.getMap(SUGGESTIONS).get(id);
  return value instanceof Y.Map ? value : null;
};

export function readMeta(doc: Y.Doc, id: string): RecordMeta | null {
  const meta = recordMap(doc, id)?.get('meta');
  return typeof meta === 'string' ? (JSON.parse(meta) as RecordMeta) : null;
}

export function readRecord(doc: Y.Doc, id: string): SuggestionRecord | null {
  const map = recordMap(doc, id);
  const meta = readMeta(doc, id);
  if (!map || !meta) return null;
  const ops = map.get('ops');
  const parts = map.get('parts');
  return {
    meta,
    ops: ops instanceof Y.Array ? (ops.toArray() as Uint8Array[]) : [],
    parts: parts instanceof Y.Array ? (parts.toArray() as DeletePart[]) : [],
  };
}

export function recordIds(doc: Y.Doc): string[] {
  return [...doc.getMap(SUGGESTIONS).keys()];
}

/** Call inside a SUGGESTIONS_ORIGIN transaction. */
export function createRecord(doc: Y.Doc, meta: RecordMeta): void {
  const map = new Y.Map<unknown>();
  doc.getMap(SUGGESTIONS).set(meta.id, map);
  map.set('meta', JSON.stringify(meta));
  map.set('ops', new Y.Array<Uint8Array>());
  map.set('parts', new Y.Array<DeletePart>());
}

/** Call inside a SUGGESTIONS_ORIGIN transaction. */
export function patchMeta(doc: Y.Doc, id: string, patch: Partial<RecordMeta>): RecordMeta {
  const map = recordMap(doc, id);
  const meta = readMeta(doc, id);
  if (!map || !meta) throw new Error(`no suggestion ${id}`);
  const next = { ...meta, ...patch };
  map.set('meta', JSON.stringify(next));
  return next;
}

export function opsOf(doc: Y.Doc, id: string): Y.Array<Uint8Array> {
  return recordMap(doc, id)!.get('ops') as Y.Array<Uint8Array>;
}

export function partsOf(doc: Y.Doc, id: string): Y.Array<DeletePart> {
  return recordMap(doc, id)!.get('parts') as Y.Array<DeletePart>;
}

/** Closes a record: the status, who and when, and its ops and parts cleared, in one server transaction. */
export function closeRecord(doc: Y.Doc, id: string, patch: Partial<RecordMeta>): void {
  doc.transact(() => {
    patchMeta(doc, id, patch);
    const ops = opsOf(doc, id);
    const parts = partsOf(doc, id);
    ops.delete(0, ops.length);
    parts.delete(0, parts.length);
  }, SUGGESTIONS_ORIGIN);
}
