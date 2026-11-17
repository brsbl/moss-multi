// A paste that cannot finish leaves nothing behind (T3.B32): the pasting tab records the items a large paste makes,
// as a client id and a clock range per doc, and when a frame of the paste is refused for a limit it deletes the part
// that landed. A rollback is delete-only updates, so the DocDO admits it at any limit (A§5.1); each deletes at most
// ROLLBACK_STRUCTS of the paste's structs, from the paste's end back, so a cut falls between structs and a batch's
// deletions merge with the deleted tail after it.
import * as Y from 'yjs';

/** The items one paste made in one doc: `client`'s clocks from `from` up to `to`. */
export interface PasteSpan {
  client: number;
  from: number;
  to: number;
}

/** A paste's items in the note and in each payload doc it made (by payload id). */
export interface PasteRecord {
  note: PasteSpan;
  payloads: Record<string, PasteSpan>;
}

/** The structs one rollback update deletes at most. */
export const ROLLBACK_STRUCTS = 10_000;

const varUint = (n: number, out: number[]): void => {
  for (; n > 0x7f; n = Math.floor(n / 0x80)) out.push(0x80 | (n % 0x80));
  out.push(n);
};

/** An update (format v1) that only deletes `client`'s clocks `[clock, clock + length)`. */
export function deleteUpdate(client: number, clock: number, length: number): Uint8Array {
  const out: number[] = [0, 1];
  varUint(client, out);
  out.push(1);
  varUint(clock, out);
  varUint(length, out);
  return Uint8Array.from(out);
}

/** The part of `span` that `doc` holds: a client's clocks always arrive in order, so it is a prefix of the span. */
export function landedPart(doc: Y.Doc, span: PasteSpan): PasteSpan | null {
  const to = Math.min(span.to, Y.getState(doc.store, span.client));
  return to > span.from ? { client: span.client, from: span.from, to } : null;
}

/** Whether `doc` holds all of `span`. */
export const landedWhole = (doc: Y.Doc, span: PasteSpan): boolean => Y.getState(doc.store, span.client) >= span.to;

/**
 * The delete-only updates that remove the landed part of `span` from `doc`, last items first, each covering at most
 * `maxStructs` of `doc`'s structs. Cut points are read before any is applied.
 */
export function rollbackUpdates(doc: Y.Doc, span: PasteSpan, maxStructs = ROLLBACK_STRUCTS): Uint8Array[] {
  const part = landedPart(doc, span);
  if (!part) return [];
  const structs = doc.store.clients.get(part.client) ?? [];
  const updates: Uint8Array[] = [];
  let hi = part.to;
  let n = 0;
  for (let i = structs.length - 1; i >= 0; i -= 1) {
    const struct = structs[i];
    if (struct.id.clock >= part.to) continue;
    if (struct.id.clock + struct.length <= part.from) break;
    n += 1;
    const lo = Math.max(struct.id.clock, part.from);
    if (n >= maxStructs && lo > part.from) {
      updates.push(deleteUpdate(part.client, lo, hi - lo));
      hi = lo;
      n = 0;
    }
  }
  if (hi > part.from) updates.push(deleteUpdate(part.client, part.from, hi - part.from));
  return updates;
}

/** Deletes the landed part of `span` from `doc` under `origin`, one transaction per rollback update; returns their count. */
export function rollBack(doc: Y.Doc, span: PasteSpan, origin: unknown, maxStructs = ROLLBACK_STRUCTS): number {
  const updates = rollbackUpdates(doc, span, maxStructs);
  for (const update of updates) Y.applyUpdate(doc, update, origin);
  return updates.length;
}

/** Whether `value` reads as a stored PasteRecord. */
export function isPasteRecord(value: unknown): value is PasteRecord {
  const span = (each: unknown): boolean => {
    const s = each as PasteSpan | null;
    return typeof s === 'object' && s !== null && [s.client, s.from, s.to].every((n) => Number.isSafeInteger(n) && n >= 0);
  };
  const record = value as PasteRecord | null;
  return typeof record === 'object' && record !== null && span(record.note) && typeof record.payloads === 'object' && record.payloads !== null
    && Object.values(record.payloads).every(span);
}
