// SP11 spike (T5.0, docs/design/suggestions.md §4): vets a suggest-mode sync frame without applying it, by Yjs
// identity rather than by text offsets. Inserts anywhere in the body land and are registered as the author's parts;
// deletes land only on the author's own items, and attribute writes only on the author's own containers; a split that
// moves original text is proven on the state after the frame; every other write is refused. The same rules run on the
// server against the live doc (vetSuggestFrame) and on the client in afterTransaction (vetTransaction).
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

export interface VetOptions {
  /** The author's insert ids (ownSpans). */
  own: readonly IdSpan[];
  /** Original text the author's splits moved: never theirs, even inside their own blocks. */
  moved?: readonly IdSpan[];
  /** Yjs client ids this connection already wrote under; a fresh client id (no state yet) is claimed by the frame. */
  clients: ReadonlySet<number>;
}

type DeleteSet = Y.Transaction['deleteSet'];

const BODY = 'root';
const REGISTERS = 'registers';

class Refusal extends Error {
  constructor(readonly reason: VetReason) {
    super(reason);
  }
}

/**
 * What the vetter reads: the doc before the frame (`state`, `get`, `liveBefore`, `before`) and after it (`after`).
 * The server reads the live doc before the frame applies and builds a mirror only when a split needs the after state;
 * the client reads its doc in afterTransaction, where the transaction's structs are integrated and its deletes marked
 * but not yet collected, so the before state is the store minus the transaction.
 */
interface View {
  state(client: number): number;
  get(id: Y.ID): Y.Item | Y.GC;
  liveBefore(item: Y.Item): boolean;
  /** A block's content before the frame. */
  before(block: Y.Item): Elem[];
  /** A block's content after the frame, plus the fresh blocks right after it when `siblings`; null if deleted. */
  after(block: Y.Item, siblings: boolean, isFresh: (id: Y.ID) => boolean): Elem[] | null;
  /** The registers map (after the frame on the client, before it on the server). */
  registers(): Y.Map<unknown> | undefined;
  dispose(): void;
}

export function vetSuggestFrame(doc: Y.Doc, update: Uint8Array, options: VetOptions): Verdict {
  // Yjs integrates only what the doc lacks: an overlapping struct from its first unseen clock, with its origin then
  // the struct before it. diffUpdate clips the frame exactly so; the delete set is kept whole.
  const { structs, ds } = Y.decodeUpdate(Y.diffUpdate(update, Y.encodeStateVector(doc)));
  return judge(serverView(doc, update), structs, ds, options);
}

/** The client self-check: the same rules on a local transaction, from afterTransaction. */
export function vetTransaction(transaction: Y.Transaction, options: VetOptions): Verdict {
  const doc = transaction.doc;
  const { structs } = Y.decodeUpdate(Y.encodeStateAsUpdate(doc, Y.encodeStateVector(transaction.beforeState)));
  return judge(clientView(transaction), structs, transaction.deleteSet, options);
}

function judge(view: View, structs: (Y.Item | Y.GC | Y.Skip)[], ds: DeleteSet, options: VetOptions): Verdict {
  try {
    return { ok: true, ...vet(view, structs, ds, options) };
  } catch (error) {
    if (error instanceof Refusal) return { ok: false, reason: error.reason };
    throw error;
  } finally {
    view.dispose();
  }
}

function vet(view: View, structs: (Y.Item | Y.GC | Y.Skip)[], ds: DeleteSet, options: VetOptions): { inserts: IdSpan[]; moved: IdSpan[] } {
  const own = options.own;
  const movedBefore = options.moved ?? [];

  // Never parked: each client's structs start at the doc's state and are contiguous, so Yjs integrates all of them
  // now. A client id the doc already holds must be one this connection wrote under, or the frame could take a peer's
  // next clocks.
  const fresh = new Map<number, (Y.Item | Y.GC)[]>();
  for (const struct of structs) {
    if (struct instanceof Y.Skip) throw new Refusal('unresolvable');
    const list = fresh.get(struct.id.client) ?? [];
    list.push(struct);
    fresh.set(struct.id.client, list);
  }
  for (const [client, list] of fresh) {
    const state = view.state(client);
    if (state > 0 && !options.clients.has(client)) throw new Refusal('foreign-client');
    let next = state;
    for (const struct of list.sort((a, b) => a.id.clock - b.id.clock)) {
      if (struct.id.clock !== next) throw new Refusal('unresolvable');
      next += struct.length;
    }
  }

  const inFrame = (id: Y.ID): Y.Item | Y.GC | null => {
    for (const struct of fresh.get(id.client) ?? []) {
      if (struct.id.clock <= id.clock && id.clock < struct.id.clock + struct.length) return struct;
    }
    return null;
  };
  const isFreshId = (id: Y.ID) => inFrame(id) !== null;
  /** The struct holding `id`, from the frame or the doc (item null when collected); refuses an unknown id. */
  const lookup = (id: Y.ID): { item: Y.Item | null; fresh: boolean; end: number } => {
    const inside = inFrame(id);
    const found = inside ?? (id.clock < view.state(id.client) ? view.get(id) : null);
    if (!found) throw new Refusal('unresolvable');
    return { item: found instanceof Y.Item ? found : null, fresh: inside !== null, end: found.id.clock + found.length };
  };
  const covered = (client: number, from: number, to: number) => coveredBy(own, client, from, to);
  /** Fresh copies of original text a split moved, and the fresh text maps governing them (filled by the proof). */
  const copies = new Set<string>();
  const isMoved = (client: number, from: number, to: number): boolean => {
    if (movedBefore.some((span) => span.client === client && span.clock < to && from < span.clock + span.len)) return true;
    for (let clock = from; clock < to && copies.size > 0; clock++) if (copies.has(`${client}:${clock}`)) return true;
    return false;
  };
  /** The author's own item: new in this frame, or in their insert parts and not moved text. */
  const isOwnId = (id: Y.ID) => !isMoved(id.client, id.clock, id.clock + 1) && (isFreshId(id) || covered(id.client, id.clock, id.clock + 1));

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
    } else if (item.parent instanceof Y.ID) {
      const holder = lookup(item.parent).item;
      result = holder ? { typeItem: holder, rootKey: null, sub: item.parentSub, dead: false } : DEAD;
    } else {
      // The encoder omits parent info when an origin implies it: Yjs places the item beside its origin.
      const neighbour = item.origin ?? item.rightOrigin;
      if (!neighbour) throw new Refusal('unresolvable');
      const found = lookup(neighbour);
      result = found.item ? place(found.item, found.fresh) : DEAD;
    }
    placeCache.set(item, result);
    return result;
  };
  const isFresh = (item: Y.Item) => inFrame(item.id) === item;
  /** The root-level type an item lives under, or null when it lands in collected content. */
  const rootOf = (item: Y.Item): string | null => {
    let at = place(item, isFresh(item));
    for (let depth = 0; at.typeItem; depth++) {
      if (depth > 1000) throw new Refusal('unresolvable');
      at = place(at.typeItem, isFresh(at.typeItem));
    }
    return at.dead ? null : at.rootKey;
  };

  /** Original blocks whose text the frame removed or re-governed: proven against the after state below. */
  const affected = new Set<Y.Item>();
  const touchBlock = (typeItem: Y.Item | null): void => {
    if (!typeItem || !(typeItem.content instanceof Y.ContentType) || !(typeItem.content.type instanceof Y.XmlText)) {
      throw new Refusal('delete-original');
    }
    if (rootOf(typeItem) !== BODY) throw new Refusal('delete-original');
    affected.add(typeItem);
  };
  /** Own containers the frame writes attributes on: checked for moved content once the splits are known. */
  const attributed = new Set<Y.Item>();

  // Inserts: sequence inserts anywhere in the body; attribute and map writes only on the author's own containers.
  const candidates: Y.Item[] = [];
  for (const items of fresh.values()) {
    for (const item of items) {
      if (!(item instanceof Y.Item)) continue;
      // Every reference must resolve now, so Yjs cannot park the item.
      for (const ref of [item.origin, item.rightOrigin, item.parent instanceof Y.ID ? item.parent : null]) if (ref) lookup(ref);
      if (item.content instanceof Y.ContentDeleted) continue;
      const at = place(item, true);
      if (at.dead) continue;
      const root = at.typeItem ? rootOf(at.typeItem) : at.rootKey;
      if (root === null) continue;
      if (at.sub === null) {
        if (root === BODY) {
          candidates.push(item);
          // An embed landing before original text takes that text over (V1 text runs follow their map): check it.
          const right = item.rightOrigin ? lookup(item.rightOrigin) : null;
          if (!(item.content instanceof Y.ContentString) && right?.item && !right.fresh && right.item.content instanceof Y.ContentString) {
            touchBlock(at.typeItem);
          }
          continue;
        }
        if (root === REGISTERS && at.typeItem && isOwnId(at.typeItem.id)) {
          candidates.push(item);
          continue;
        }
        throw new Refusal(root === REGISTERS ? 'mutate-original' : 'outside-body');
      }
      if (at.typeItem) {
        if ((root === BODY || root === REGISTERS) && isOwnId(at.typeItem.id)) {
          attributed.add(at.typeItem);
          candidates.push(item);
          continue;
        }
        throw new Refusal(root === BODY || root === REGISTERS ? 'mutate-original' : 'outside-body');
      }
      // A new key in the registers map belongs to a new decorator; overwriting a live one mutates the original.
      if (at.rootKey === REGISTERS && !keyLiveBefore(view, item, isFreshId)) {
        candidates.push(item);
        continue;
      }
      throw new Refusal(at.rootKey === REGISTERS || at.rootKey === BODY ? 'mutate-original' : 'outside-body');
    }
  }

  // Deletes: a sequence item only when it is the author's own; an attribute value only on the author's own container.
  // Original text removed from a block is allowed only as half of a split, proven below.
  for (const [client, ranges] of ds.clients) {
    for (const { clock, len } of ranges) {
      for (let at = clock; at < clock + len;) {
        const found = lookup(Y.createID(client, at));
        const stop = Math.min(clock + len, found.end);
        const item = found.item;
        if (item && !found.fresh && view.liveBefore(item)) {
          const holder = place(item, false);
          if (holder.sub !== null) {
            if (holder.typeItem ? !isOwnId(holder.typeItem.id) : !isOwnId(item.id)) throw new Refusal('mutate-original');
            if (holder.typeItem) attributed.add(holder.typeItem);
          } else if (isMoved(client, at, stop) || !covered(client, at, stop)) {
            if (!(item.content instanceof Y.ContentString)) throw new Refusal('delete-original');
            touchBlock(holder.typeItem);
          }
        }
        at = Math.max(stop, at + 1);
      }
    }
  }

  // Splits: @lexical/yjs moves the tail of a split text node into a new node, and Enter moves it into a new block, by
  // deleting the original characters and inserting copies. After the frame, every element of an affected block that
  // is not the author's must survive in order, by identity or as a fresh copy with the same character and text
  // properties, in the block or the fresh blocks right after it. Copies, and the fresh text maps governing them, stay
  // original: they are never the author's inserts.
  for (const block of affected) {
    const pre = view.before(block);
    const post = view.after(block, true, isFreshId);
    if (!post) throw new Refusal('delete-original');
    const matched = align(pre, post, isFreshId, (o, p) => o.char !== null && p.char === o.char && p.props === o.props);
    for (const o of pre) {
      if (isOwnId(Y.createID(o.client, o.clock))) continue;
      const p = matched.get(keyOf(o));
      if (!p) throw new Refusal('delete-original');
      if (p.props !== o.props) throw new Refusal('mutate-original');
      if (keyOf(p) !== keyOf(o)) {
        copies.add(keyOf(p));
        if (p.gov && isFreshId(idOf(p.gov))) copies.add(p.gov);
      }
    }
  }

  // An attribute write on an own container is still a change to original content when the container is moved text's
  // map, or a block that holds moved text. A block new in this frame carries its initial attributes: they are part of
  // the author's insert, which reject removes, and the moved text's own properties were proven above.
  for (const container of attributed) {
    if (isFreshId(container.id)) continue;
    if (isMoved(container.id.client, container.id.clock, container.id.clock + 1)) throw new Refusal('mutate-original');
    const content = container.content instanceof Y.ContentType ? container.content.type : null;
    if (content instanceof Y.XmlText) {
      const children = view.after(container, false, isFreshId);
      if (children?.some((e) => isMoved(e.client, e.clock, e.clock + 1))) throw new Refusal('mutate-original');
    }
  }

  const inserts: IdSpan[] = [];
  for (const item of candidates) {
    for (let i = 0; i < item.length; i++) {
      const clock = item.id.clock + i;
      if (!copies.has(`${item.id.client}:${clock}`)) register(inserts, item.id.client, clock);
    }
  }
  return { inserts, moved: spansOf(copies) };
}

/**
 * Identity carry: a frame from any writer (an editor's Enter or bold, another suggester's split, a review, an undo)
 * that deletes characters of `spans` and re-inserts copies gives those copies new ids. The DocDO runs this on the live
 * doc before applying each frame that deletes a tracked id, and writes the result into the record in the same
 * transaction, so a suggestion's text keeps its paint, its reject target and its clean-export exclusion.
 */
export function carryIdentity(doc: Y.Doc, update: Uint8Array, spans: readonly IdSpan[]): IdSpan[] {
  const { structs, ds } = Y.decodeUpdate(Y.diffUpdate(update, Y.encodeStateVector(doc)));
  const freshKeys = new Set<string>();
  for (const struct of structs) {
    if (struct instanceof Y.Skip) continue;
    for (let i = 0; i < struct.length; i++) freshKeys.add(`${struct.id.client}:${struct.id.clock + i}`);
  }
  const isFreshId = (id: Y.ID) => freshKeys.has(`${id.client}:${id.clock}`);
  const tracked = (client: number, clock: number) => coveredBy(spans, client, clock, clock + 1);
  const blocks = new Set<Y.Item>();
  for (const [client, ranges] of ds.clients) {
    for (const { clock, len } of ranges) {
      for (let at = clock; at < clock + len; at++) {
        if (!tracked(client, at) || at >= Y.getState(doc.store, client)) continue;
        const item = Y.getItem(doc.store, Y.createID(client, at));
        if (!(item instanceof Y.Item) || item.deleted || item.parentSub !== null) continue;
        const parent = (item.parent as Y.AbstractType<unknown>)._item;
        if (parent) blocks.add(parent);
      }
    }
  }
  const out = spans.map((span) => ({ ...span }));
  if (blocks.size === 0) return out;
  const view = serverView(doc, update);
  try {
    const added = new Set<string>();
    for (const block of blocks) {
      const pre = view.before(block);
      const post = view.after(block, true, isFreshId);
      if (!post) continue;
      // Characters only: an editor's bold re-inserts the run with new text properties, and it is still the same text.
      const matched = align(pre, post, isFreshId, (o, p) => o.char !== null && p.char === o.char);
      for (const o of pre) {
        const p = matched.get(keyOf(o));
        if (!p || keyOf(p) === keyOf(o) || !tracked(o.client, o.clock)) continue;
        added.add(keyOf(p));
        if (p.gov && isFreshId(idOf(p.gov))) added.add(p.gov);
      }
    }
    for (const span of spansOf(added)) out.push(span);
    return out;
  } finally {
    view.dispose();
  }
}

/**
 * Seconds an accepted record's ids stay the author's after the accept while the author's client has not yet
 * acknowledged seeing it: a frame typed before the client saw the accept is concurrent with it, not a violation.
 */
export const SEEN_GRACE_SECONDS = 30;

/** The ownership fields of a suggestion record (docs/design/suggestions.md §2). */
export interface OwnedRecord {
  author: string;
  status: 'open' | 'accepted' | 'rejected' | 'withdrawn';
  /** The DocDO's review counter when the record left `open`. */
  resolvedRev?: number;
  resolvedAt?: number;
  inserts: IdSpan[];
  moved: IdSpan[];
}

/**
 * The author's own ids as their client last saw them: open records, plus records accepted after the review counter
 * the connection last acknowledged (`seenRev`), within the grace window.
 */
export function ownSpans(records: readonly OwnedRecord[], author: string, basis: { seenRev: number; now: number }): { own: IdSpan[]; moved: IdSpan[] } {
  const own: IdSpan[] = [];
  const moved: IdSpan[] = [];
  for (const record of records) {
    if (record.author !== author) continue;
    const unseen = record.status === 'accepted' && (record.resolvedRev ?? 0) > basis.seenRev && basis.now - (record.resolvedAt ?? 0) <= SEEN_GRACE_SECONDS;
    if (record.status === 'open' || unseen) own.push(...record.inserts);
    if (record.status === 'open') moved.push(...record.moved);
  }
  return { own, moved };
}

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
const DEAD: Place = { typeItem: null, rootKey: null, sub: null, dead: true };

interface Elem {
  client: number;
  clock: number;
  /** Null for an embed: a text node's map, a line break, a decorator or a nested block. */
  char: string | null;
  /** A character's text properties: its governing text map, as stable JSON. */
  props: string | null;
  /** The key of a character's governing text map. */
  gov: string | null;
}
const keyOf = (e: { client: number; clock: number }) => `${e.client}:${e.clock}`;
const idOf = (key: string) => {
  const [client, clock] = key.split(':').map(Number);
  return Y.createID(client, clock);
};

/** A V1 block's content in order, counting only `include`d items: each character with the text map before it. */
function sequence(type: Y.AbstractType<unknown>, include: (item: Y.Item) => boolean, out: Elem[] = []): Elem[] {
  let props: string | null = null;
  let gov: string | null = null;
  for (let item = type._start; item; item = item.right) {
    if (!include(item)) continue;
    const content = item.content;
    if (content instanceof Y.ContentString) {
      for (let i = 0; i < content.str.length; i++) {
        out.push({ client: item.id.client, clock: item.id.clock + i, char: content.str[i], props, gov });
      }
    } else if (!(content instanceof Y.ContentFormat)) {
      const embedded = content instanceof Y.ContentType ? content.type : null;
      const isTextMap = embedded instanceof Y.Map && mapJson(embedded, include).__type === 'text';
      props = isTextMap ? stableJson(mapJson(embedded as Y.Map<unknown>, include)) : null;
      gov = isTextMap ? keyOf(item.id) : null;
      out.push({ client: item.id.client, clock: item.id.clock, char: null, props: null, gov: null });
    }
  }
  return out;
}

/** A map's entries as of the `include`d items: an entry overwritten in the frame reads its previous value. */
function mapJson(map: Y.Map<unknown>, include: (item: Y.Item) => boolean): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, last] of map._map) {
    let item: Y.Item | null = last;
    while (item && !include(item)) item = item.left;
    if (item && !(item.content instanceof Y.ContentDeleted)) {
      const values = item.content.getContent();
      out[key] = values[values.length - 1];
    }
  }
  return out;
}

const stableJson = (value: Record<string, unknown>) =>
  JSON.stringify(Object.keys(value).sort().map((key) => [key, value[key]]));

/**
 * Pairs each element before the frame with the same element after it, or with the fresh element that `same` accepts
 * as its copy. Elements that existed before keep their relative order in a Yjs sequence, so a scan that meets an older
 * element first knows the one it seeks is gone.
 */
function align(pre: Elem[], post: Elem[], isFreshId: (id: Y.ID) => boolean, same: (o: Elem, p: Elem) => boolean): Map<string, Elem> {
  const live = new Set(post.map(keyOf));
  const matched = new Map<string, Elem>();
  let j = 0;
  for (const o of pre) {
    const kept = live.has(keyOf(o));
    for (let k = j; k < post.length; k++) {
      const p = post[k];
      if (keyOf(p) === keyOf(o)) {
        matched.set(keyOf(o), p);
        j = k + 1;
        break;
      }
      if (!isFreshId(Y.createID(p.client, p.clock))) break;
      if (!kept && same(o, p)) {
        matched.set(keyOf(o), p);
        j = k + 1;
        break;
      }
    }
  }
  return matched;
}

/** Whether the registers key `item` writes held a live value before the frame. */
function keyLiveBefore(view: View, item: Y.Item, isFreshId: (id: Y.ID) => boolean): boolean {
  if (item.parentSub === null) return false;
  let entry: Y.Item | null | undefined = view.registers()?._map.get(item.parentSub);
  while (entry && isFreshId(entry.id)) entry = entry.left;
  return !!entry && view.liveBefore(entry);
}

function serverView(doc: Y.Doc, update: Uint8Array): View {
  let mirror: Y.Doc | null = null;
  const live = (item: Y.Item) => !item.deleted;
  return {
    state: (client) => Y.getState(doc.store, client),
    get: (id) => Y.getItem(doc.store, id),
    liveBefore: live,
    before: (block) => sequence((block.content as Y.ContentType).type, live),
    after: (block, siblings, isFreshId) => {
      if (!mirror) {
        mirror = new Y.Doc();
        Y.applyUpdate(mirror, Y.encodeStateAsUpdate(doc));
        Y.applyUpdate(mirror, update);
      }
      return afterIn(mirror, block, siblings, isFreshId);
    },
    registers: () => doc.share.get(REGISTERS) as Y.Map<unknown> | undefined,
    dispose: () => mirror?.destroy(),
  };
}

function clientView(transaction: Y.Transaction): View {
  const doc = transaction.doc;
  const state = (client: number) => transaction.beforeState.get(client) ?? 0;
  const liveBefore = (item: Y.Item) => !item.deleted || Y.isDeleted(transaction.deleteSet, item.id);
  const existedLive = (item: Y.Item) => item.id.clock < state(item.id.client) && liveBefore(item);
  return {
    state,
    get: (id) => Y.getItem(doc.store, id),
    liveBefore,
    before: (block) => sequence((block.content as Y.ContentType).type, existedLive),
    after: (block, siblings, isFreshId) => afterIn(doc, block, siblings, isFreshId),
    registers: () => doc.share.get(REGISTERS) as Y.Map<unknown> | undefined,
    dispose: () => {},
  };
}

function afterIn(doc: Y.Doc, block: Y.Item, siblings: boolean, isFreshId: (id: Y.ID) => boolean): Elem[] | null {
  const live = (item: Y.Item) => !item.deleted;
  const after = Y.getItem(doc.store, block.id);
  if (!(after instanceof Y.Item) || after.deleted) return null;
  const out = sequence((after.content as Y.ContentType).type, live);
  if (siblings) {
    for (let sibling = after.right; sibling && isFreshId(sibling.id); sibling = sibling.right) {
      if (!sibling.deleted && sibling.content instanceof Y.ContentType) sequence(sibling.content.type, live, out);
    }
  }
  return out;
}

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

function spansOf(keys: ReadonlySet<string>): IdSpan[] {
  const out: IdSpan[] = [];
  for (const [client, clock] of [...keys].map((k) => k.split(':').map(Number)).sort((a, b) => a[0] - b[0] || a[1] - b[1])) {
    register(out, client, clock);
  }
  return out;
}
