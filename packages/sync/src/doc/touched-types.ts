// SP7 (A§13): which root shared types a sync frame would touch, decided before it is applied. The DocDO refuses a
// client frame that touches a root outside the client allowlist (comments and suggestions are written only by the DO).
import * as Y from 'yjs';

export interface TouchedTypes {
  /** Root names (doc.share keys) the frame inserts into or deletes from. */
  roots: Set<string>;
  /**
   * The frame depends on an item the doc lacks. Yjs would park it and integrate it once that item arrives, which can
   * be a later server write (its client id and clock are predictable), so the frame must be refused, not deferred.
   */
  unresolved: boolean;
  /**
   * The frame cannot be classified by its encoding: its parent links form a cycle, or a struct the doc partly holds
   * would integrate its tail beside an item under a different parent than the encoding names. Refused.
   */
  malformed: boolean;
}

/** An item lands nowhere (garbage-collected parent or neighbour), in a named root, or cannot be placed yet. */
type Landing = string | null | typeof UNRESOLVED;
type SharedType = Y.Doc['share'] extends Map<string, infer T> ? T : never;
const UNRESOLVED = Symbol('unresolved');

/**
 * Classifies `update` against `doc` without applying it: an inserted item belongs to the root its parent chain ends
 * in, read from the item's parent (a root name or a parent item) or, when the encoding omits it, from its left or
 * right origin; a delete belongs to the root of each live item it removes. Structs and deletes the doc already holds
 * are inert and count for nothing.
 */
export function touchedTypes(doc: Y.Doc, update: Uint8Array): TouchedTypes {
  const { structs, ds } = Y.decodeUpdate(update);
  const store = doc.store;
  const names = new Map<SharedType, string>();
  for (const [name, type] of doc.share) names.set(type, name);

  // GC structs too: a client's update carries the children of a type it deleted as GC, and they land nowhere.
  const incoming = new Map<number, (Y.Item | Y.GC)[]>();
  for (const struct of structs) {
    if (struct instanceof Y.Skip) continue;
    const list = incoming.get(struct.id.client) ?? [];
    list.push(struct as Y.Item | Y.GC);
    incoming.set(struct.id.client, list);
  }
  const findIncoming = (id: Y.ID): Y.Item | Y.GC | undefined => {
    const list = incoming.get(id.client);
    if (!list) return undefined;
    let low = 0;
    let high = list.length - 1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      const item = list[mid];
      if (id.clock < item.id.clock) high = mid - 1;
      else if (id.clock >= item.id.clock + item.length) low = mid + 1;
      else return item;
    }
    return undefined;
  };
  const findStored = (id: Y.ID): Y.Item | Y.GC | undefined => {
    if (id.clock >= Y.getState(store, id.client)) return undefined;
    const list = store.clients.get(id.client);
    return list ? (list[Y.findIndexSS(list, id.clock)] as Y.Item | Y.GC) : undefined;
  };

  const rootOfType = (start: SharedType): Landing => {
    let type = start;
    while (type._item !== null) {
      const parent = type._item.parent;
      if (!(parent instanceof Y.AbstractType)) return null;
      type = parent;
    }
    return names.get(type) ?? UNRESOLVED;
  };
  /** Where an existing struct sits; a deleted type's children are GC structs and land nowhere. */
  const rootOfStored = (struct: Y.Item | Y.GC): Landing =>
    struct instanceof Y.Item && struct.parent instanceof Y.AbstractType ? rootOfType(struct.parent) : null;

  let malformed = false;
  const memo = new Map<Y.Item, Landing>();
  const rootOfIncoming = (item: Y.Item): Landing => {
    const chain = new Set<Y.Item>();
    let current = item;
    let landing: Landing;
    for (;;) {
      const known = memo.get(current);
      if (known !== undefined) {
        landing = known;
        break;
      }
      if (chain.has(current)) {
        // A parent or origin cycle: Yjs would park it forever; the walk must not.
        malformed = true;
        landing = null;
        break;
      }
      chain.add(current);
      const parent = current.parent as unknown;
      if (typeof parent === 'string') {
        landing = parent;
        break;
      }
      if (parent instanceof Y.ID) {
        // The parent item holds the type this item is inserted into.
        const stored = findStored(parent);
        if (stored) {
          landing = stored instanceof Y.Item && stored.content instanceof Y.ContentType ? rootOfType(stored.content.type) : null;
          break;
        }
        const pending = findIncoming(parent);
        if (!pending) {
          landing = UNRESOLVED;
          break;
        }
        if (!(pending instanceof Y.Item) || !(pending.content instanceof Y.ContentType)) {
          landing = null;
          break;
        }
        current = pending;
        continue;
      }
      // No parent in the encoding: the item shares its origin's (or right origin's) parent.
      const neighbour = current.origin ?? current.rightOrigin;
      if (!neighbour) {
        landing = UNRESOLVED;
        break;
      }
      const stored = findStored(neighbour);
      if (stored) {
        landing = rootOfStored(stored);
        break;
      }
      const pending = findIncoming(neighbour);
      if (!pending) {
        landing = UNRESOLVED;
        break;
      }
      if (!(pending instanceof Y.Item)) {
        landing = null;
        break;
      }
      current = pending;
    }
    for (const visited of chain) memo.set(visited, landing);
    return landing;
  };

  /** The (type, key) an incoming item's encoding places it in, when that is a type the doc already holds. */
  const placeOf = (item: Y.Item): { parent: unknown; sub: string | null } | null => {
    const parent = item.parent as unknown;
    if (typeof parent === 'string') return { parent: doc.share.get(parent), sub: item.parentSub };
    if (parent instanceof Y.ID) {
      const stored = findStored(parent);
      return stored instanceof Y.Item && stored.content instanceof Y.ContentType ? { parent: stored.content.type, sub: item.parentSub } : null;
    }
    const neighbour = item.origin ?? item.rightOrigin;
    const stored = neighbour ? findStored(neighbour) : undefined;
    return stored instanceof Y.Item ? { parent: stored.parent, sub: stored.parentSub } : null;
  };

  const roots = new Set<string>();
  let unresolved = false;
  const count = (landing: Landing) => {
    if (landing === UNRESOLVED) unresolved = true;
    else if (landing !== null) roots.add(landing);
  };

  // Each client's new structs must start at the doc's state and run without gaps; Yjs parks anything past a gap until
  // the gap fills, which for the server's client id is a later server write.
  const next = new Map<number, number>();
  for (const struct of structs) {
    const { client, clock } = struct.id;
    const state = Y.getState(store, client);
    const end = clock + struct.length;
    if (end <= state) continue;
    const expected = Math.max(next.get(client) ?? state, state);
    if (struct instanceof Y.Skip || clock > expected) unresolved = true;
    next.set(client, Math.max(expected, end));
  }

  for (const struct of structs) {
    if (!(struct instanceof Y.Item)) continue;
    const state = Y.getState(store, struct.id.client);
    // Already held: Yjs skips it.
    if (struct.id.clock + struct.length <= state) continue;
    if (struct.id.clock < state) {
      // Partly held: Yjs integrates the tail right of the held item (client, state - 1), whatever the encoding says,
      // so the encoding is trusted only when it names that item's own parent and key.
      const held = findStored(Y.createID(struct.id.client, state - 1));
      const place = placeOf(struct);
      if (!(held instanceof Y.Item) || !place || place.parent !== held.parent || place.sub !== held.parentSub) malformed = true;
      if (held) count(rootOfStored(held));
    }
    count(rootOfIncoming(struct));
  }

  for (const [client, ranges] of ds.clients) {
    const state = Y.getState(store, client);
    const list = store.clients.get(client) ?? [];
    for (const { clock, len } of ranges) {
      const end = clock + len;
      if (len <= 0) continue;
      if (clock < state) {
        for (let i = Y.findIndexSS(list, clock); i < list.length && list[i].id.clock < Math.min(end, state); i += 1) {
          const stored = list[i] as Y.Item | Y.GC;
          if (stored instanceof Y.Item && !stored.deleted) count(rootOfStored(stored));
        }
      }
      // Deletes of items this same frame inserts; anything else past the doc's state is a parked delete.
      for (let at = Math.max(clock, state); at < end;) {
        const own = findIncoming(Y.createID(client, at));
        if (!own) {
          unresolved = true;
          break;
        }
        if (own instanceof Y.Item) count(rootOfIncoming(own));
        at = own.id.clock + own.length;
      }
    }
  }
  return { roots, unresolved, malformed };
}
