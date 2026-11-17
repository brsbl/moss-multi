// A paste that cannot finish leaves nothing behind (T3.B32). The pasting tab records the items a large paste makes,
// as a client id and a clock range per doc, and the deletes its writes make (the selection it replaced, the text a
// split moved). Those deletes go out only once every item of the paste has landed (`withoutDeletes` strips them from
// what is sent until then), so a paste cut short by a limit has deleted nothing on the server. Rolling it back is then
// deleting the part that landed: delete-only updates, which the DocDO admits at any limit (A§5.1), each deleting at
// most ROLLBACK_STRUCTS of the paste's structs, from the paste's end back, so a cut falls between structs and a
// batch's deletions merge with the deleted tail after it. A pasted container a peer has typed into stays, with the
// peer's characters, as undo keeps one (host/collab/undo.ts).
import * as encoding from 'lib0/encoding';
import * as Y from 'yjs';
import { encodeUpdate } from './update-pieces.ts';

/** The items one paste made in one doc: `client`'s clocks from `from` up to `to`. */
export interface PasteSpan {
  client: number;
  from: number;
  to: number;
}

/** Clock ranges, `[client, clock, length]`. */
export type Ranges = [number, number, number][];

/** A paste's items in the note and in each payload doc it made (by payload id), and the deletes it held back. */
export interface PasteRecord {
  note: PasteSpan;
  payloads: Record<string, PasteSpan>;
  /** The note deletes the paste's writes made, sent only once all its items landed. */
  deletes?: Ranges;
  /**
   * Settled once, by the first binding that read the server's copy, and kept with the record: deletes never lower a
   * clock, so a rollback half done would read as a paste that landed whole. `cut` deletes the landed part; `whole`
   * sends the held deletes, which completes the paste.
   */
  decided?: 'cut' | 'whole';
}

/** The structs one rollback update deletes at most. */
export const ROLLBACK_STRUCTS = 10_000;

/** An update (format v1) that only deletes `ranges`. */
export function deletesUpdate(ranges: Ranges): Uint8Array {
  const byClient = new Map<number, [number, number][]>();
  for (const [client, clock, length] of ranges) {
    if (length <= 0) continue;
    const list = byClient.get(client);
    if (list) list.push([clock, length]);
    else byClient.set(client, [[clock, length]]);
  }
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, 0);
  encoding.writeVarUint(encoder, byClient.size);
  for (const [client, list] of byClient) {
    encoding.writeVarUint(encoder, client);
    encoding.writeVarUint(encoder, list.length);
    for (const [clock, length] of list) {
      encoding.writeVarUint(encoder, clock);
      encoding.writeVarUint(encoder, length);
    }
  }
  return encoding.toUint8Array(encoder);
}

/** An update (format v1) that only deletes `client`'s clocks `[clock, clock + length)`. */
export const deleteUpdate = (client: number, clock: number, length: number): Uint8Array => deletesUpdate([[client, clock, length]]);

/** `ranges` sorted by client and clock, overlapping and touching ones merged. */
export function mergeRanges(ranges: Ranges): Ranges {
  const sorted = [...ranges].filter(([, , length]) => length > 0).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged: Ranges = [];
  for (const [client, clock, length] of sorted) {
    const last = merged.at(-1);
    if (last && last[0] === client && clock <= last[1] + last[2]) last[2] = Math.max(last[2], clock + length - last[1]);
    else merged.push([client, clock, length]);
  }
  return merged;
}

/** The part of `span` that `doc` holds: a client's clocks always arrive in order, so it is a prefix of the span. */
export function landedPart(doc: Y.Doc, span: PasteSpan): PasteSpan | null {
  const to = Math.min(span.to, Y.getState(doc.store, span.client));
  return to > span.from ? { client: span.client, from: span.from, to } : null;
}

/** Whether `doc` holds all of `span`. */
export const landedWhole = (doc: Y.Doc, span: PasteSpan): boolean => Y.getState(doc.store, span.client) >= span.to;

/**
 * The pasted containers that stay: a container (a paragraph's Y.XmlText, a list, a table, a text node's property map)
 * holding a live item a peer wrote, and the properties it was created with. Deleting it would delete the peer's
 * characters for everyone; only the paste's own characters go.
 */
function keeper(span: PasteSpan): (item: Y.Item) => boolean {
  const inSpan = (item: Y.Item) => item.id.client === span.client && item.id.clock >= span.from && item.id.clock < span.to;
  const isPeers = (item: Y.Item) => !item.deleted && !inSpan(item);
  const holdsNested = (item: Y.Item | null): boolean =>
    !!item && !item.deleted && item.content instanceof Y.ContentType && holdsPeers(item.content.type as Y.AbstractType<unknown>);
  // A peer's live item in the sequence, or in a nested type at any depth (a property value is not content).
  const holdsPeers = (type: Y.AbstractType<unknown>): boolean => {
    for (let item = type._start; item; item = item.right) if (isPeers(item) || holdsNested(item)) return true;
    for (const item of type._map.values()) if (holdsNested(item)) return true;
    return false;
  };
  const known = new Map<Y.Item, boolean>();
  const keeps = (item: Y.Item): boolean => {
    if (item.deleted || !(item.content instanceof Y.ContentType)) return false;
    let kept = known.get(item);
    if (kept !== undefined) return kept;
    const type = item.content.type as Y.AbstractType<unknown>;
    kept = false;
    if (item.parent instanceof Y.XmlText && item.parentSub === null && type instanceof Y.Map) {
      // In @lexical/yjs a text node's property map owns the characters after it, up to the next embed.
      for (let next = item.right; next; next = next.right) {
        if (next.deleted) continue;
        if (!(next.content instanceof Y.ContentString)) break;
        if (isPeers(next)) {
          kept = true;
          break;
        }
      }
    } else {
      kept = holdsPeers(type);
    }
    known.set(item, kept);
    return kept;
  };
  return (item) => {
    if (item.parentSub !== null) {
      // A property goes with the container the paste made. One it set on a block it did not make stays: setting it
      // replaced the old value on every copy, so deleting it would leave the property unset.
      const owner = (item.parent as Y.AbstractType<unknown>)._item;
      return !owner || !inSpan(owner) || keeps(owner);
    }
    return keeps(item);
  };
}

/**
 * The delete-only updates that remove the landed part of `span` from `doc`, last items first, each covering at most
 * `maxStructs` of `doc`'s structs, a pasted container that holds a peer's items left out. Read before any is applied.
 */
export function rollbackUpdates(doc: Y.Doc, span: PasteSpan, maxStructs = ROLLBACK_STRUCTS): Uint8Array[] {
  const part = landedPart(doc, span);
  if (!part) return [];
  const keeps = keeper(part);
  const structs = doc.store.clients.get(part.client) ?? [];
  const updates: Uint8Array[] = [];
  let ranges: Ranges = [];
  let hi: number | null = null;
  let lo = part.to;
  let n = 0;
  const close = () => {
    if (hi !== null && hi > lo) ranges.push([part.client, lo, hi - lo]);
    hi = null;
  };
  for (let i = structs.length - 1; i >= 0; i -= 1) {
    const struct = structs[i];
    if (struct.id.clock >= part.to) continue;
    if (struct.id.clock + struct.length <= part.from) break;
    const start = Math.max(struct.id.clock, part.from);
    const end = Math.min(struct.id.clock + struct.length, part.to);
    if (struct instanceof Y.Item && keeps(struct)) {
      close();
      continue;
    }
    hi ??= end;
    lo = start;
    n += 1;
    if (n >= maxStructs && start > part.from) {
      close();
      updates.push(deletesUpdate(ranges.reverse()));
      ranges = [];
      n = 0;
    }
  }
  close();
  if (ranges.length > 0) updates.push(deletesUpdate(ranges.reverse()));
  return updates;
}

/** Deletes the landed part of `span` from `doc` under `origin`, one transaction per rollback update; returns their count. */
export function rollBack(doc: Y.Doc, span: PasteSpan, origin: unknown, maxStructs = ROLLBACK_STRUCTS): number {
  const updates = rollbackUpdates(doc, span, maxStructs);
  for (const update of updates) Y.applyUpdate(doc, update, origin);
  return updates.length;
}

/** Applies `ranges`' deletes to `doc` under `origin`, in updates of at most ROLLBACK_STRUCTS ranges. */
export function applyDeletes(doc: Y.Doc, ranges: Ranges, origin: unknown): number {
  let count = 0;
  for (let at = 0; at < ranges.length; at += ROLLBACK_STRUCTS) {
    Y.applyUpdate(doc, deletesUpdate(ranges.slice(at, at + ROLLBACK_STRUCTS)), origin);
    count += 1;
  }
  return count;
}

/** Whether every clock of `ranges` is deleted in `doc`. */
export function deletedIn(doc: Y.Doc, ranges: Ranges): boolean {
  for (const [client, clock, length] of ranges) {
    if (Y.getState(doc.store, client) < clock + length) return false;
    const structs = doc.store.clients.get(client) ?? [];
    for (let i = Y.findIndexSS(structs, clock); i < structs.length && structs[i].id.clock < clock + length; i += 1) {
      if (!structs[i].deleted) return false;
    }
  }
  return true;
}

/**
 * The deletes a large paste's writes make, as it lands: every local transaction from the paste's first batch to its
 * last, but not its own items' clocks from `from` on. Its items are the doc's own client's clocks from `from` on.
 */
export class PasteWatch {
  readonly client: number;
  readonly from: number;
  #to: number | null = null;
  #deletes: Ranges = [];

  constructor(readonly doc: Y.Doc) {
    this.client = doc.clientID;
    this.from = Y.getState(doc.store, this.client);
    doc.on('afterTransaction', this.#seen);
  }

  readonly #seen = (transaction: Y.Transaction): void => {
    if (!transaction.local) return;
    transaction.deleteSet.clients.forEach((items, client) => {
      for (const { clock, len } of items) this.#deletes.push([client, clock, len]);
    });
    if (this.#deletes.length > 64) this.#deletes = mergeRanges(this.#deletes);
  };

  get finished(): boolean {
    return this.#to !== null;
  }

  /** The paste's last item is written. */
  finish(): void {
    if (this.#to !== null) return;
    this.#to = Y.getState(this.doc.store, this.client);
    this.doc.off('afterTransaction', this.#seen);
  }

  span(): PasteSpan {
    return { client: this.client, from: this.from, to: this.#to ?? Y.getState(this.doc.store, this.client) };
  }

  deletes(): Ranges {
    this.#deletes = mergeRanges(this.#deletes);
    return this.#deletes.map((range) => [...range] as [number, number, number]);
  }
}

/** `ranges` less `minus`, both merged. */
function subtract(ranges: Ranges, minus: Ranges): Ranges {
  const out: Ranges = [];
  for (const [client, clock, length] of ranges) {
    let pieces: [number, number][] = [[clock, clock + length]];
    for (const [other, at, len] of minus) {
      if (other !== client) continue;
      pieces = pieces.flatMap(([a, b]): [number, number][] => {
        if (at + len <= a || at >= b) return [[a, b]];
        return ([[a, Math.min(b, at)], [Math.max(a, at + len), b]] as [number, number][]).filter(([x, y]) => y > x);
      });
    }
    for (const [a, b] of pieces) out.push([client, a, b - a]);
  }
  return out;
}

/** `update` (Yjs v1) without the deletes of `held`; the same bytes when it deletes none of them. */
export function withoutDeletes(update: Uint8Array, held: Ranges): Uint8Array {
  if (held.length === 0) return update;
  const { structs, ds } = Y.decodeUpdate(update);
  const ranges: Ranges = [];
  ds.clients.forEach((items, client) => {
    for (const { clock, len } of items) ranges.push([client, clock, len]);
  });
  const kept = subtract(mergeRanges(ranges), held);
  const before = ranges.reduce((sum, [, , length]) => sum + length, 0);
  const after = kept.reduce((sum, [, , length]) => sum + length, 0);
  if (after === before) return update;
  const clients = new Map<number, { clock: number; len: number }[]>();
  for (const [client, clock, len] of kept) {
    const list = clients.get(client);
    if (list) list.push({ clock, len });
    else clients.set(client, [{ clock, len }]);
  }
  return encodeUpdate(structs, { clients });
}

/** Whether `value` reads as a stored PasteRecord. */
export function isPasteRecord(value: unknown): value is PasteRecord {
  const count = (n: unknown) => Number.isSafeInteger(n) && (n as number) >= 0;
  const span = (each: unknown): boolean => {
    const s = each as PasteSpan | null;
    return typeof s === 'object' && s !== null && [s.client, s.from, s.to].every(count);
  };
  const record = value as PasteRecord | null;
  if (typeof record !== 'object' || record === null || !span(record.note) || typeof record.payloads !== 'object' || record.payloads === null) return false;
  if (!Object.values(record.payloads).every(span)) return false;
  if (record.deletes !== undefined && !(Array.isArray(record.deletes) && record.deletes.every((range) => Array.isArray(range) && range.length === 3 && range.every(count)))) return false;
  return record.decided === undefined || record.decided === 'cut' || record.decided === 'whole';
}
