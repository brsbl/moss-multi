// SP11 spike (T5.0, docs/design/suggestions.md §4): vets a suggest-mode sync frame against the live doc without
// applying it, by Yjs identity rather than by text offsets. Inserts anywhere in the body land and are registered as
// the author's parts; deletes and attribute writes land only on the author's own pending content (or content created
// in the same frame); every other write is refused. The same decode answers SP7 (which shared types a frame touches).
import * as Y from 'yjs';

/** A run of one client's consecutive items: the author's pending insert, by Yjs identity. */
export interface IdSpan {
  client: number;
  clock: number;
  len: number;
}

export type VetReason = 'delete-original' | 'mutate-original' | 'outside-body' | 'unresolvable';
export type Verdict = { ok: true; inserts: IdSpan[] } | { ok: false; reason: VetReason };

const BODY = 'root';
const REGISTERS = 'registers';

/** Where an item sits: its parent type (a nested type's item, or a root-level type by name) and its map key. */
interface Place {
  /** The item holding the parent type, or null for a root-level type. */
  typeItem: Y.Item | null;
  /** The root-level type's name when typeItem is null. */
  rootKey: string | null;
  sub: string | null;
  /** The parent was garbage collected: the write has no visible effect. */
  dead: boolean;
}

class Refusal extends Error {
  constructor(readonly reason: VetReason) {
    super(reason);
  }
}

const isId = (value: unknown): value is Y.ID => value instanceof Y.ID;
const isLive = (item: Y.Item | undefined): boolean => item !== undefined && !item.deleted;

export function vetSuggestFrame(doc: Y.Doc, update: Uint8Array, own: readonly IdSpan[]): Verdict {
  try {
    return { ok: true, inserts: vet(doc, update, own) };
  } catch (error) {
    if (error instanceof Refusal) return { ok: false, reason: error.reason };
    throw error;
  }
}

function vet(doc: Y.Doc, update: Uint8Array, own: readonly IdSpan[]): IdSpan[] {
  const store = doc.store;
  const { structs, ds } = Y.decodeUpdate(update);
  /** The frame's new structs by client, in clock order. A GC is content created and collected inside the frame. */
  const fresh = new Map<number, (Y.Item | Y.GC)[]>();
  for (const struct of structs) {
    if (struct instanceof Y.Skip) continue;
    if (struct.id.clock + struct.length <= Y.getState(store, struct.id.client)) continue;
    const list = fresh.get(struct.id.client) ?? [];
    list.push(struct);
    fresh.set(struct.id.client, list);
  }

  const inFrame = (id: Y.ID): Y.Item | Y.GC | null => {
    for (const struct of fresh.get(id.client) ?? []) {
      if (struct.id.clock <= id.clock && id.clock < struct.id.clock + struct.length) return struct;
    }
    return null;
  };
  /** The struct holding `id`, from the frame or the doc (item null when collected); throws for an unknown id. */
  const lookup = (id: Y.ID): { item: Y.Item | null; fresh: boolean; end: number } => {
    const found = inFrame(id) ?? (id.clock < Y.getState(store, id.client) ? (Y.getItem(store, id) as Y.Item | Y.GC) : null);
    if (!found) throw new Refusal('unresolvable');
    return { item: found instanceof Y.Item ? found : null, fresh: inFrame(id) !== null, end: found.id.clock + found.length };
  };
  const isOwnId = (id: Y.ID): boolean =>
    inFrame(id) !== null || own.some((span) => span.client === id.client && span.clock <= id.clock && id.clock < span.clock + span.len);

  const placeCache = new Map<Y.Item, Place>();
  const place = (item: Y.Item, fromFrame: boolean): Place => {
    const cached = placeCache.get(item);
    if (cached) return cached;
    let result: Place;
    if (!fromFrame) {
      const parent = item.parent as Y.AbstractType<unknown>;
      result = parent._item
        ? { typeItem: parent._item, rootKey: null, sub: item.parentSub, dead: false }
        : { typeItem: null, rootKey: Y.findRootTypeKey(parent), sub: item.parentSub, dead: false };
    } else if (typeof (item.parent as unknown) === 'string') {
      result = { typeItem: null, rootKey: item.parent as unknown as string, sub: item.parentSub, dead: false };
    } else if (isId(item.parent)) {
      const holder = lookup(item.parent).item;
      result = holder ? { typeItem: holder, rootKey: null, sub: item.parentSub, dead: false } : { typeItem: null, rootKey: null, sub: null, dead: true };
    } else {
      // The encoder omits parent info when an origin implies it: the neighbour's place is this item's place.
      const neighbour = item.origin ?? item.rightOrigin;
      if (!neighbour) throw new Refusal('unresolvable');
      const found = lookup(neighbour);
      result = found.item ? place(found.item, found.fresh) : { typeItem: null, rootKey: null, sub: null, dead: true };
    }
    placeCache.set(item, result);
    return result;
  };
  const isFresh = (item: Y.Item) => inFrame(item.id) === item;
  /** The root-level type an item lives under. */
  const rootOf = (item: Y.Item): string | null => {
    let at = place(item, isFresh(item));
    for (let depth = 0; at.typeItem; depth++) {
      if (depth > 1000) throw new Refusal('unresolvable');
      at = place(at.typeItem, isFresh(at.typeItem));
    }
    return at.dead ? null : at.rootKey;
  };
  /** True when the item, or any type holding it, is the author's own pending content or new in this frame. */
  const ownDeep = (item: Y.Item | null): boolean => {
    for (let at = item, depth = 0; at; depth++) {
      if (depth > 1000) throw new Refusal('unresolvable');
      if (isOwnId(at.id)) return true;
      at = place(at, isFresh(at)).typeItem;
    }
    return false;
  };

  // Inserts: sequence inserts anywhere in the body; attribute and map writes only on own content.
  const inserts: IdSpan[] = [];
  for (const items of fresh.values()) {
    for (const item of items) {
      if (!(item instanceof Y.Item) || item.content instanceof Y.ContentDeleted) continue;
      const at = place(item, true);
      if (at.dead) continue;
      const root = at.typeItem ? rootOf(at.typeItem) : at.rootKey;
      if (root === null) continue;
      if (at.sub === null) {
        if (root === BODY) {
          if (!ownDeep(at.typeItem)) register(inserts, item);
          continue;
        }
        if (root === REGISTERS && at.typeItem && ownDeep(at.typeItem)) continue;
        throw new Refusal(root === REGISTERS ? 'mutate-original' : 'outside-body');
      }
      if (at.typeItem) {
        if (ownDeep(at.typeItem)) continue;
        throw new Refusal(root === BODY || root === REGISTERS ? 'mutate-original' : 'outside-body');
      }
      // A new key in the registers map belongs to a new decorator; overwriting a live one mutates the original.
      if (at.rootKey === REGISTERS && !isLive(doc.share.get(REGISTERS)?._map.get(at.sub))) continue;
      throw new Refusal(at.rootKey === REGISTERS ? 'mutate-original' : 'outside-body');
    }
  }

  // Deletes: only of items new in this frame, or inside the author's own pending content. The store may merge an
  // editor's earlier text with the same client's suggestions, so ownership is checked per deleted clock range.
  const covered = (client: number, from: number, to: number): boolean => {
    let at = from;
    for (const span of [...own].filter((s) => s.client === client).sort((a, b) => a.clock - b.clock)) {
      if (span.clock > at) break;
      at = Math.max(at, span.clock + span.len);
      if (at >= to) return true;
    }
    return at >= to;
  };
  for (const [client, ranges] of ds.clients) {
    for (const { clock, len } of ranges) {
      for (let at = clock; at < clock + len;) {
        const found = lookup(Y.createID(client, at));
        const stop = Math.min(clock + len, found.end);
        const item = found.item;
        // Attribute values replaced on own nodes are owned through their parent; everything else is original.
        if (item && !found.fresh && !item.deleted && !covered(client, at, stop) && !ownDeep(place(item, false).typeItem)) {
          throw new Refusal('delete-original');
        }
        at = Math.max(stop, at + 1);
      }
    }
  }
  return inserts;
}

/** Extends the previous span when the item continues it in clock and in place; otherwise starts a new one. */
function register(spans: IdSpan[], item: Y.Item): void {
  const last = spans[spans.length - 1];
  if (last && last.client === item.id.client && last.clock + last.len === item.id.clock && item.origin
    && item.origin.client === last.client && item.origin.clock === last.clock + last.len - 1) {
    last.len += item.length;
    return;
  }
  spans.push({ client: item.id.client, clock: item.id.clock, len: item.length });
}
