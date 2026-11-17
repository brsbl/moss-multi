// A paste that cannot finish leaves nothing behind (T3.B32). The pasting tab records the items a large paste makes,
// as a client id and a clock range per doc, and the deletes its writes make (the selection it replaced, the text a
// split moved). Those deletes go out only once every item of the paste has landed (`withoutDeletes` strips them from
// what is sent until then), so a paste cut short by a limit has deleted nothing on the server. Rolling it back is then
// deleting the part that landed: delete-only updates, which the DocDO admits at any limit (A§5.1). The unit is a whole
// top-level block the paste made, never a part of one, so a peer's bound editor sees blocks removed as when a person
// deletes them. A pasted block another writer wrote into, or into its payload, stays whole, pasted content included.
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

/** A payload doc a paste made, and the deletes the pasting tab made in it (absent for none). */
export type PayloadSpan = PasteSpan & { deletes?: Ranges };

/** A paste's items in the note and in each payload doc it made (by payload id), and the deletes it held back. */
export interface PasteRecord {
  note: PasteSpan;
  payloads: Record<string, PayloadSpan>;
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
 * Whether another writer deleted some of `span`'s clocks in `struct`, a deleted struct: a delete leaves no item of the
 * writer who made it, so one the pasting tab did not make itself (`own`, its deletes) is another writer's edit.
 */
function deletedByOthers(struct: Y.Item | Y.GC, span: PasteSpan, own: Ranges): boolean {
  if (struct.id.client !== span.client) return false;
  const from = Math.max(struct.id.clock, span.from);
  const to = Math.min(struct.id.clock + struct.length, span.to);
  if (to <= from) return false;
  // `own` is merged, so one range covers the clocks or none does.
  let lo = 0;
  let hi = own.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const [client, clock] = own[mid];
    if (client < span.client || (client === span.client && clock <= from)) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  if (found < 0) return true;
  const [client, clock, length] = own[found];
  return client !== span.client || clock + length < to;
}

/** Whether `item` holds any of `span`'s clocks. */
const overlaps = (span: PasteSpan) => (item: Y.Item): boolean =>
  item.id.client === span.client && item.id.clock < span.to && item.id.clock + item.length > span.from;

/** The payload id an element item names, if it holds one. */
function payloadIdOf(item: Y.Item): string | null {
  if (!(item.content instanceof Y.ContentType) || !(item.content.type instanceof Y.XmlElement)) return null;
  const id: unknown = item.content.type.getAttribute('__regId');
  return typeof id === 'string' ? id : null;
}

/** `item` and what it holds: its live structs, and whether another writer wrote one, or into a payload in `pinned`. */
function survey(item: Y.Item, mine: (item: Y.Item) => boolean, pinned: ReadonlySet<string>): { structs: number; others: boolean } {
  let structs = 0;
  let others = false;
  const stack = [item];
  while (stack.length > 0) {
    const next = stack.pop()!;
    if (next.deleted) continue;
    structs += 1;
    if (!mine(next)) others = true;
    if (!(next.content instanceof Y.ContentType)) continue;
    const id = pinned.size > 0 ? payloadIdOf(next) : null;
    if (id !== null && pinned.has(id)) others = true;
    const type = next.content.type as Y.AbstractType<unknown>;
    for (let child = type._start; child; child = child.right) stack.push(child);
    for (const child of type._map.values()) stack.push(child);
  }
  return { structs, others };
}

/** What a rollback deletes, read before any of it is applied, and how many blocks it keeps. */
export interface RollbackPlan {
  updates: Uint8Array[];
  kept: number;
}

/**
 * The delete-only updates that roll back the landed part of `span` in `doc` (a note bound by @lexical/yjs). Each
 * top-level block the paste made is deleted whole (its own item, which takes its subtree with it), the last in the
 * document first, in batches of whole blocks of about `maxStructs` structs each. A run the paste inserted into a block
 * it did not make (a paste into the middle of a line) goes in one update for that block. A pasted block, or run,
 * holding another writer's live item, or an element naming a payload id in `pinned`, is kept whole. A property the
 * paste set on a node it did not make keeps the pasted value, since setting it replaced the old one on every copy.
 */
export function rollbackPlan(
  doc: Y.Doc, span: PasteSpan, maxStructs = ROLLBACK_STRUCTS, pinned: ReadonlySet<string> = new Set(), deletes: Ranges = [],
): RollbackPlan {
  const part = landedPart(doc, span);
  if (!part) return { updates: [], kept: 0 };
  const mine = overlaps(part);
  const own = mergeRanges(deletes);
  const range = (item: Y.Item): [number, number, number] => {
    const from = Math.max(item.id.clock, part.from);
    return [part.client, from, Math.min(item.id.clock + item.length, part.to) - from];
  };
  // Each type's top-level block: the item in a root type it is under, null for a root type itself.
  const tops = new Map<Y.AbstractType<unknown>, Y.Item | null>();
  const topOf = (type: Y.AbstractType<unknown>): Y.Item | null => {
    const path: Y.AbstractType<unknown>[] = [];
    let top: Y.Item | null | undefined;
    for (let at = type; top === undefined; ) {
      top = tops.get(at);
      if (top !== undefined) break;
      path.push(at);
      const item = at._item;
      if (item === null) top = null;
      else if ((item.parent as Y.AbstractType<unknown>)._item === null) top = item;
      else at = item.parent as Y.AbstractType<unknown>;
    }
    for (const each of path) tops.set(each, top);
    return top;
  };
  const blocks = new Set<Y.Item>();
  const runs = new Map<Y.Item, Y.Item[]>();
  // Blocks holding a pasted item another writer deleted (a whole block deleted is gone, and a rollback's own deletes
  // are whole blocks and whole runs, so a resumed one finds none in a block it still deletes).
  const touched = new Set<Y.Item>();
  const structs = doc.store.clients.get(part.client) ?? [];
  for (let i = Y.findIndexSS(structs, part.from); i < structs.length && structs[i].id.clock < part.to; i += 1) {
    const struct = structs[i];
    if (!(struct instanceof Y.Item)) continue;
    const parent = struct.parent as Y.AbstractType<unknown>;
    const top = topOf(parent);
    if (struct.deleted) {
      if (top !== null && deletedByOthers(struct, part, own)) touched.add(top);
      continue;
    }
    if (top === null) {
      if (struct.parentSub === null) blocks.add(struct);
    } else if (!mine(top) && struct.parentSub === null && !(parent._item && mine(parent._item))) {
      const run = runs.get(top);
      if (run) run.push(struct);
      else runs.set(top, [struct]);
    }
  }

  const updates: Uint8Array[] = [];
  let kept = 0;
  const ordered: Y.Item[] = [];
  for (const root of new Set([...blocks].map((block) => block.parent as Y.AbstractType<unknown>))) {
    for (let item = root._start; item; item = item.right) if (blocks.has(item)) ordered.push(item);
  }
  let batch: Ranges = [];
  let size = 0;
  for (let i = ordered.length - 1; i >= 0; i -= 1) {
    const { structs: count, others } = survey(ordered[i], mine, pinned);
    if (others || touched.has(ordered[i])) {
      kept += 1;
      continue;
    }
    batch.push(range(ordered[i]));
    size += count;
    if (size >= maxStructs) {
      updates.push(deletesUpdate(mergeRanges(batch)));
      batch = [];
      size = 0;
    }
  }
  if (batch.length > 0) updates.push(deletesUpdate(mergeRanges(batch)));

  for (const [top, run] of runs) {
    const inRun = new Set(run);
    let others = touched.has(top) || run.some((item) => survey(item, mine, pinned).others);
    // Another writer's text between the run's items, or right after a text node's property map it ends with (that
    // map owns the characters after it in @lexical/yjs), would go with the run or change node.
    for (const parent of new Set(run.map((item) => item.parent as Y.AbstractType<unknown>))) {
      let left = run.filter((item) => item.parent === parent).length;
      let last: Y.Item | null = null;
      for (let item = parent._start; item && !others; item = item.right) {
        if (inRun.has(item)) {
          left -= 1;
          last = item;
          continue;
        }
        if (item.deleted || last === null) continue;
        if (left > 0) others = !mine(item);
        else {
          others = last.content instanceof Y.ContentType && item.content instanceof Y.ContentString && !mine(item);
          break;
        }
      }
    }
    if (others) kept += 1;
    else updates.push(deletesUpdate(mergeRanges(run.map(range))));
  }
  return { updates, kept };
}

/** The delete-only updates rolling back the landed part of `span` (rollbackPlan). */
export const rollbackUpdates = (doc: Y.Doc, span: PasteSpan, maxStructs = ROLLBACK_STRUCTS, pinned: ReadonlySet<string> = new Set()): Uint8Array[] =>
  rollbackPlan(doc, span, maxStructs, pinned).updates;

/** Rolls back the landed part of `span` in `doc` under `origin`, one transaction per update; returns their count. */
export function rollBack(doc: Y.Doc, span: PasteSpan, origin: unknown, maxStructs = ROLLBACK_STRUCTS, pinned?: ReadonlySet<string>): number {
  const updates = rollbackUpdates(doc, span, maxStructs, pinned);
  for (const update of updates) Y.applyUpdate(doc, update, origin);
  return updates.length;
}

/**
 * Whether another writer wrote into a payload doc the paste made: a live item outside `span`, or an item of the
 * paste's deleted by a delete the pasting tab did not make (`deletes`).
 */
export function holdsOthers(doc: Y.Doc, span: PasteSpan, deletes: Ranges = []): boolean {
  const own = mergeRanges(deletes);
  for (const [client, structs] of doc.store.clients) {
    for (const struct of structs) {
      // A GC struct is deleted content too.
      if (struct.deleted) {
        if (deletedByOthers(struct, span, own)) return true;
        continue;
      }
      if (client !== span.client || struct.id.clock < span.from || struct.id.clock >= span.to) return true;
    }
  }
  return false;
}

/**
 * Rolls a paste back in its note. Its payload docs are never written: a pasted block whose payload another writer
 * wrote into is kept whole, and one deleted leaves its payload doc unnamed, withheld as any deleted block's is.
 * `deletes` are the note deletes the paste made itself, and a payload span's the payload's. Returns the count of
 * rollback updates and of blocks kept.
 */
export function rollBackPaste(
  note: Y.Doc, span: PasteSpan, payloads: [id: string, doc: Y.Doc, span: PayloadSpan][], origin: unknown, maxStructs = ROLLBACK_STRUCTS,
  deletes: Ranges = [],
): { updates: number; kept: number } {
  const pinned = new Set<string>();
  for (const [id, doc, payload] of payloads) if (holdsOthers(doc, payload, payload.deletes)) pinned.add(id);
  const { updates, kept } = rollbackPlan(note, span, maxStructs, pinned, deletes);
  for (const update of updates) Y.applyUpdate(note, update, origin);
  return { updates: updates.length, kept };
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
  const ranges = (each: unknown): boolean =>
    each === undefined || (Array.isArray(each) && each.every((range) => Array.isArray(range) && range.length === 3 && range.every(count)));
  if (!Object.values(record.payloads).every((each) => span(each) && ranges(each.deletes))) return false;
  if (!ranges(record.deletes)) return false;
  return record.decided === undefined || record.decided === 'cut' || record.decided === 'whole';
}
