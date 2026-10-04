// SP11 spike (T5.0, docs/design/suggestions.md §4): vets a suggest-mode sync frame against the live doc without
// applying it, by Yjs identity rather than by text offsets. Inserts anywhere in the body land and are registered as
// the author's parts; deletes and attribute writes land only on the author's own pending content (or content created
// in the same frame); a text-node split is proven on a mirror; every other write is refused. The same decode answers
// SP7 (which shared types a frame touches).
import * as Y from 'yjs';

/** A run of one client's consecutive clocks: an id set, by Yjs identity. */
export interface IdSpan {
  client: number;
  clock: number;
  len: number;
}

export type VetReason = 'delete-original' | 'mutate-original' | 'outside-body' | 'unresolvable' | 'foreign-client';
/** `inserts` are the author's new content; `moved` are copies of original text a split moved, still original. */
export type Verdict = { ok: true; inserts: IdSpan[]; moved: IdSpan[] } | { ok: false; reason: VetReason };

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

/**
 * `own` are the author's open insert parts; `moved` are original text a split of theirs moved (never theirs to delete).
 * Both come from the author's open suggestion records.
 */
export interface VetOptions {
  own: readonly IdSpan[];
  moved?: readonly IdSpan[];
  clients: ReadonlySet<number>;
}

export function vetSuggestFrame(doc: Y.Doc, update: Uint8Array, options: VetOptions): Verdict {
  const { own, moved = [] } = options;
  try {
    return { ok: true, ...vet(doc, update, own, moved) };
  } catch (error) {
    if (error instanceof Refusal) return { ok: false, reason: error.reason };
    throw error;
  }
}

function vet(doc: Y.Doc, update: Uint8Array, own: readonly IdSpan[], moved: readonly IdSpan[]): { inserts: IdSpan[]; moved: IdSpan[] } {
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
  const covered = (client: number, from: number, to: number): boolean => coveredBy(own, client, from, to);
  const touchesMoved = (client: number, from: number, to: number): boolean =>
    moved.some((span) => span.client === client && span.clock < to && from < span.clock + span.len);
  const isOwnId = (id: Y.ID): boolean => inFrame(id) !== null || covered(id.client, id.clock, id.clock + 1);

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

  /** Original blocks whose text a frame removed or re-governed: checked for text-node splits on a mirror below. */
  const affected = new Set<Y.Item>();
  const touchBlock = (typeItem: Y.Item | null): void => {
    if (!typeItem || !(typeItem.content instanceof Y.ContentType) || !(typeItem.content.type instanceof Y.XmlText)) {
      throw new Refusal('delete-original');
    }
    if (rootOf(typeItem) !== BODY) throw new Refusal('delete-original');
    affected.add(typeItem);
  };

  // Inserts: sequence inserts anywhere in the body; attribute and map writes only on own content.
  const candidates: Y.Item[] = [];
  for (const items of fresh.values()) {
    for (const item of items) {
      if (!(item instanceof Y.Item) || item.content instanceof Y.ContentDeleted) continue;
      const at = place(item, true);
      if (at.dead) continue;
      const root = at.typeItem ? rootOf(at.typeItem) : at.rootKey;
      if (root === null) continue;
      if (at.sub === null) {
        if (root === BODY) {
          if (ownDeep(at.typeItem)) continue;
          candidates.push(item);
          // An embed landing before original text takes that text over (V1 text runs follow their map): check it.
          const right = item.rightOrigin ? lookup(item.rightOrigin) : null;
          if (!(item.content instanceof Y.ContentString) && right?.item && !right.fresh && right.item.content instanceof Y.ContentString) {
            touchBlock(at.typeItem);
          }
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
  // Original text removed from a block is allowed only as half of a text-node split, proven below.
  for (const [client, ranges] of ds.clients) {
    for (const { clock, len } of ranges) {
      for (let at = clock; at < clock + len;) {
        const found = lookup(Y.createID(client, at));
        const stop = Math.min(clock + len, found.end);
        const item = found.item;
        if (item && !found.fresh && !item.deleted && !covered(client, at, stop)) {
          // Attribute values replaced on own nodes are owned through their parent; everything else is original.
          const holder = place(item, false);
          if (!ownDeep(holder.typeItem) || touchesMoved(client, at, stop)) {
            if (holder.sub !== null || !(item.content instanceof Y.ContentString)) throw new Refusal('delete-original');
            touchBlock(holder.typeItem);
          }
        }
        at = Math.max(stop, at + 1);
      }
    }
  }

  // Splits: @lexical/yjs moves the tail of a split text node into a new node, and Enter moves it into a new block,
  // by deleting the original characters and inserting copies. On a mirror, every original element of an affected
  // block must survive in order, by identity or as a fresh copy with the same character and text properties, in the
  // block or the fresh blocks right after it. Copies stay original content: they are never the author's inserts.
  const copies = new Set<string>();
  if (affected.size > 0) {
    const mirror = new Y.Doc();
    try {
      Y.applyUpdate(mirror, Y.encodeStateAsUpdate(doc));
      Y.applyUpdate(mirror, update);
      const isFreshElem = (e: Elem) => inFrame(Y.createID(e.client, e.clock)) !== null;
      for (const block of affected) {
        // Inside the author's own new block everything is theirs except text a split moved there.
        const blockOwn = ownDeep(block);
        const isOwnElem = (e: Elem) => !touchesMoved(e.client, e.clock, e.clock + 1) && (blockOwn || covered(e.client, e.clock, e.clock + 1));
        const pre = sequence((block.content as Y.ContentType).type).filter((e) => !isOwnElem(e));
        const after = Y.getItem(mirror.store, block.id) as Y.Item;
        if (after.deleted) throw new Refusal('delete-original');
        const post = sequence((after.content as Y.ContentType).type);
        for (let sibling = after.right; sibling && inFrame(sibling.id); sibling = sibling.right) {
          if (!sibling.deleted && sibling.content instanceof Y.ContentType) sequence(sibling.content.type, post);
        }
        const live = new Set(post.map(keyOf));
        let j = 0;
        for (const o of pre) {
          const kept = live.has(keyOf(o));
          let matched = false;
          while (!matched && j < post.length) {
            const p = post[j++];
            if (keyOf(p) === keyOf(o)) {
              if (p.props !== o.props) throw new Refusal('mutate-original');
              matched = true;
            } else if (!kept && isFreshElem(p) && o.char !== null && p.char === o.char && p.props === o.props) {
              copies.add(keyOf(p));
              matched = true;
            } else if (!isFreshElem(p) && !isOwnElem(p)) {
              break;
            }
          }
          if (!matched) throw new Refusal('delete-original');
        }
      }
    } finally {
      mirror.destroy();
    }
  }

  const inserts: IdSpan[] = [];
  for (const item of candidates) {
    for (let i = 0; i < item.length; i++) {
      const clock = item.id.clock + i;
      if (!copies.has(`${item.id.client}:${clock}`)) register(inserts, item.id.client, clock);
    }
  }
  const movedNow: IdSpan[] = [];
  for (const key of [...copies].map((k) => k.split(':').map(Number)).sort((a, b) => a[0] - b[0] || a[1] - b[1])) {
    register(movedNow, key[0], key[1]);
  }
  return { inserts, moved: movedNow };
}

interface Elem {
  client: number;
  clock: number;
  /** Null for an embed: a text node's map, a line break, a decorator or a nested block. */
  char: string | null;
  /** A character's text properties: its governing text map, as stable JSON. */
  props: string | null;
}
const keyOf = (e: Elem) => `${e.client}:${e.clock}`;

/** A V1 block's live content in order: each character with the properties of the text map before it. */
function sequence(type: Y.AbstractType<unknown>, out: Elem[] = []): Elem[] {
  let props: string | null = null;
  for (let item = type._start; item; item = item.right) {
    if (item.deleted) continue;
    const content = item.content;
    if (content instanceof Y.ContentString) {
      for (let i = 0; i < content.str.length; i++) out.push({ client: item.id.client, clock: item.id.clock + i, char: content.str[i], props });
    } else if (!(content instanceof Y.ContentFormat)) {
      const embedded = content instanceof Y.ContentType ? content.type : null;
      props = embedded instanceof Y.Map && embedded.get('__type') === 'text' ? stableJson(embedded.toJSON()) : null;
      out.push({ client: item.id.client, clock: item.id.clock, char: null, props: null });
    }
  }
  return out;
}

const stableJson = (value: Record<string, unknown>) =>
  JSON.stringify(Object.keys(value).sort().map((key) => [key, value[key]]));

function coveredBy(spans: readonly IdSpan[], client: number, from: number, to: number): boolean {
  let at = from;
  for (const span of spans.filter((s) => s.client === client).sort((a, b) => a.clock - b.clock)) {
    if (span.clock > at) break;
    at = Math.max(at, span.clock + span.len);
    if (at >= to) return true;
  }
  return at >= to;
}

/** Adds one item id to the id set, extending the last span when the clock continues it. */
function register(spans: IdSpan[], client: number, clock: number): void {
  const last = spans[spans.length - 1];
  if (last && last.client === client && last.clock + last.len === clock) last.len += 1;
  else spans.push({ client, clock, len: 1 });
}

/** Red-run stub: vets the transaction's update against the doc after it applied. */
export function vetTransaction(transaction: Y.Transaction, options: VetOptions): Verdict {
  return vetSuggestFrame(transaction.doc, Y.encodeStateAsUpdate(transaction.doc, Y.encodeStateVector(transaction.beforeState)), options);
}

/** Red-run stub. */
export function carryIdentity(_doc: Y.Doc, _update: Uint8Array, spans: readonly IdSpan[]): IdSpan[] {
  return [...spans];
}

export const SEEN_GRACE_SECONDS = 30;
export interface OwnedRecord {
  author: string;
  status: 'open' | 'accepted' | 'rejected' | 'withdrawn';
  resolvedRev?: number;
  resolvedAt?: number;
  inserts: IdSpan[];
  moved: IdSpan[];
}
/** Red-run stub: open records only. */
export function ownSpans(records: readonly OwnedRecord[], author: string, _basis: { seenRev: number; now: number }): { own: IdSpan[]; moved: IdSpan[] } {
  const mine = records.filter((r) => r.author === author && r.status === 'open');
  return { own: mine.flatMap((r) => r.inserts), moved: mine.flatMap((r) => r.moved) };
}
