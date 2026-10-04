// SP11 spike (T5.0, docs/design/suggestions.md §4): vets a suggest-mode sync frame without applying it, by Yjs
// identity rather than by text offsets. Inserts anywhere in the body land and are registered as the author's parts;
// deletes land only on the author's own items (with everything Yjs deletes along with them), and attribute writes only
// on the author's own containers that govern no one else's text; text a split, join or undo moves is proven on the
// state after the frame; every other write is refused. The same rules run on the
// server against the live doc (vetSuggestFrame) and on the client in afterTransaction (vetTransaction).
import * as Y from 'yjs';

/** A run of one client's consecutive clocks: an id set, by Yjs identity. */
export interface IdSpan {
  client: number;
  clock: number;
  len: number;
}

export type VetReason = 'delete-original' | 'mutate-original' | 'outside-body' | 'unresolvable' | 'foreign-client' | 'too-large';
/** `inserts` are the author's new content; `moved` are copies of original text a split moved, still original. */
export type Verdict = { ok: true; inserts: IdSpan[]; moved: IdSpan[] } | { ok: false; reason: VetReason };

export interface VetOptions {
  /** The author's insert ids (ownSpans). */
  own: readonly IdSpan[];
  /** Original text the author's splits moved: never theirs, even inside their own blocks. */
  moved?: readonly IdSpan[];
  /** Yjs client ids this connection already wrote under; a fresh client id (no state yet) is claimed by the frame. */
  clients: ReadonlySet<number>;
  /** Per-frame cost caps. */
  limits?: VetLimits;
}

export interface VetLimits {
  structs: number;
  types: number;
}
export const VET_LIMITS: VetLimits = { structs: 20_000, types: 2_000 };

/** Stub for the red run: the vetter does not keep a mirror yet. */
export class SuggestMirror {
  constructor(private readonly live: Y.Doc) {}
  get doc(): Y.Doc {
    return this.live;
  }
  vet(update: Uint8Array, options: VetOptions): Verdict {
    return vetSuggestFrame(this.live, update, options);
  }
  destroy(): void {}
}

/** Stub for the red run: removes every inserted id. */
export function rejectPlan(doc: Y.Doc, inserts: readonly IdSpan[]): IdSpan[] {
  void doc;
  return inserts.map((span) => ({ ...span }));
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
 * What the vetter reads: the doc before the frame (`state`, `get`, `liveBefore`, `body(false)`) and after it
 * (`body(true)`). The server reads the live doc before the frame applies and builds a mirror only when the after state
 * is needed; the client reads its doc in afterTransaction, where the transaction's structs are integrated and its
 * deletes marked but not yet collected, so the before state is the store minus the transaction.
 */
interface View {
  state(client: number): number;
  get(id: Y.ID): Y.Item | Y.GC;
  liveBefore(item: Y.Item): boolean;
  /** The body's content in document order, nested blocks included, before or after the frame. */
  body(after: boolean): Elem[];
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
      // The encoder omits parent info, map key included, when an origin implies it: Yjs places the item beside its
      // origin, in the origin's map key. Read the key from the place, never from a decoded item's parentSub.
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

  /** Blocks whose text the frame removed or re-governed (by key): proven against the after state below. */
  const affected = new Set<string>();
  const touchBlock = (typeItem: Y.Item | null): void => {
    if (!typeItem || !(typeItem.content instanceof Y.ContentType) || !(typeItem.content.type instanceof Y.XmlText)) {
      throw new Refusal('delete-original');
    }
    if (rootOf(typeItem) !== BODY) throw new Refusal('delete-original');
    affected.add(keyOf(typeItem.id));
  };
  /** Own containers the frame writes attributes on: checked for text that is not the author's once splits are known. */
  const attributed = new Set<Y.Item>();
  /**
   * Lexical rewrites every property of a node it marks dirty whose value is not `===` the previous one, so inserting
   * beside an original decorator re-sets its object-valued properties to equal values. A write that keeps the value
   * changes nothing: it is allowed on any body container, with the delete of the value it replaces.
   */
  const unchanged = new Set<string>();
  const sameAsBefore = (container: Y.Item, sub: string, item: Y.Item): boolean => {
    if (!(container.content instanceof Y.ContentType) || item.content instanceof Y.ContentType || item.content instanceof Y.ContentDeleted) {
      return false;
    }
    let previous: Y.Item | null | undefined = container.content.type._map.get(sub);
    while (previous && isFreshId(previous.id)) previous = previous.left;
    if (!previous || !view.liveBefore(previous) || previous.content instanceof Y.ContentType || previous.content instanceof Y.ContentDeleted) {
      return false;
    }
    const last = (values: unknown[]) => JSON.stringify(values[values.length - 1]);
    return last(previous.content.getContent()) === last(item.content.getContent());
  };

  // Inserts: sequence inserts anywhere in the body; attribute and map writes only on the author's own containers. A
  // tombstone (ContentDeleted) is judged like any write: placed as a map's newest value, Yjs deletes the value before it.
  const candidates: Y.Item[] = [];
  for (const items of fresh.values()) {
    for (const item of items) {
      if (!(item instanceof Y.Item)) continue;
      // Every reference must resolve now, so Yjs cannot park the item.
      for (const ref of [item.origin, item.rightOrigin, item.parent instanceof Y.ID ? item.parent : null]) if (ref) lookup(ref);
      const tomb = item.content instanceof Y.ContentDeleted;
      const at = place(item, true);
      if (at.dead) continue;
      const root = at.typeItem ? rootOf(at.typeItem) : at.rootKey;
      if (root === null) continue;
      if (at.sub === null) {
        if (root === BODY) {
          // V1 never writes formatting marks; Yjs's format cleanup deletes marks around a new one.
          if (item.content instanceof Y.ContentFormat) throw new Refusal('mutate-original');
          if (tomb) continue;
          candidates.push(item);
          // An embed landing before original text takes that text over (V1 text runs follow their map): check it.
          const right = item.rightOrigin ? lookup(item.rightOrigin) : null;
          if (!(item.content instanceof Y.ContentString) && right?.item && !right.fresh && right.item.content instanceof Y.ContentString) {
            touchBlock(at.typeItem);
          }
          continue;
        }
        if (root === REGISTERS && at.typeItem && isOwnId(at.typeItem.id)) {
          if (!tomb) candidates.push(item);
          continue;
        }
        throw new Refusal(root === REGISTERS ? 'mutate-original' : 'outside-body');
      }
      if (at.typeItem) {
        if (root === BODY && sameAsBefore(at.typeItem, at.sub, item)) {
          unchanged.add(`${keyOf(at.typeItem.id)}|${at.sub}`);
          continue;
        }
        if ((root === BODY || root === REGISTERS) && isOwnId(at.typeItem.id)) {
          attributed.add(at.typeItem);
          if (!tomb) candidates.push(item);
          continue;
        }
        throw new Refusal(root === BODY || root === REGISTERS ? 'mutate-original' : 'outside-body');
      }
      // A new key in the registers map belongs to a new decorator; overwriting a live one mutates the original.
      if (at.rootKey === REGISTERS && !keyLiveBefore(view, at.sub, isFreshId)) {
        if (!tomb) candidates.push(item);
        continue;
      }
      throw new Refusal(at.rootKey === REGISTERS || at.rootKey === BODY ? 'mutate-original' : 'outside-body');
    }
  }

  // Deletes. Yjs deletes a container's live content with it, whatever the delete set names, so the frame's deletes are
  // closed over descendants before they are judged. A sequence item goes only when it is the author's own; original
  // text only as half of a split, proven below. A map value goes with its container, and otherwise only from the
  // author's own container.
  const gone: { item: Y.Item; from: number; to: number }[] = [];
  const goneContainers = new Set<Y.Item>();
  const descend = (item: Y.Item): void => {
    if (!(item.content instanceof Y.ContentType) || goneContainers.has(item)) return;
    goneContainers.add(item);
    const type = item.content.type;
    const children: Y.Item[] = [...type._map.values()];
    for (let child = type._start; child; child = child.right) children.push(child);
    for (const child of children) {
      if (isFreshId(child.id) || !view.liveBefore(child)) continue;
      gone.push({ item: child, from: child.id.clock, to: child.id.clock + child.length });
      descend(child);
    }
  };
  for (const [client, ranges] of ds.clients) {
    for (const { clock, len } of ranges) {
      for (let at = clock; at < clock + len;) {
        const found = lookup(Y.createID(client, at));
        const stop = Math.min(clock + len, found.end);
        const item = found.item;
        if (item && !found.fresh && view.liveBefore(item)) {
          gone.push({ item, from: at, to: stop });
          descend(item);
        }
        at = Math.max(stop, at + 1);
      }
    }
  }
  for (const { item, from, to } of gone) {
    const holder = place(item, false);
    if (holder.sub !== null) {
      if (holder.typeItem && goneContainers.has(holder.typeItem)) continue;
      const kept = holder.typeItem !== null && unchanged.has(`${keyOf(holder.typeItem.id)}|${holder.sub}`);
      if (!kept && (holder.typeItem ? !isOwnId(holder.typeItem.id) : !isOwnId(item.id))) throw new Refusal('mutate-original');
      if (holder.typeItem && !kept) attributed.add(holder.typeItem);
      continue;
    }
    const own = !isMoved(item.id.client, from, to) && covered(item.id.client, from, to);
    if (item.content instanceof Y.ContentString) {
      if (!own) touchBlock(holder.typeItem);
    } else if (isTextMap(item)) {
      // The characters it governed fall to the map before them: their properties are proven below.
      touchBlock(holder.typeItem);
    } else if (!own) {
      throw new Refusal('delete-original');
    }
  }

  // Splits, joins and undone splits: @lexical/yjs moves text by deleting the characters and inserting copies (the
  // tail of a split text node into a new node, Enter's tail into a new block, an undo's tail back into the block it
  // came from). After the frame, every character of an affected block that is not the author's must survive in
  // document order, by identity or as a fresh copy with the same character and text properties, wherever in the body
  // that is. Copies, and the fresh text maps governing them, stay original: they are never the author's inserts.
  let afterBody: Elem[] | null = null;
  const after = () => (afterBody ??= view.body(true));
  const isOwnElem = (e: Elem) => isOwnId(Y.createID(e.client, e.clock));
  if (affected.size > 0) {
    const pre = view.body(false);
    const wanted = (o: Elem) => o.char !== null && o.block !== null && affected.has(o.block) && !isOwnElem(o);
    const matched = align(pre, after(), isFreshId, wanted, (o, p) => p.char === o.char && p.props === o.props);
    for (const o of pre) {
      if (!wanted(o)) continue;
      const p = matched.get(keyOf(o));
      if (!p) throw new Refusal('delete-original');
      if (p.props !== o.props) throw new Refusal('mutate-original');
      if (keyOf(p) !== keyOf(o)) {
        copies.add(keyOf(p));
        if (p.gov && isFreshId(idOf(p.gov))) copies.add(p.gov);
      }
    }
  }

  // An attribute write on an own container still changes text that is not the author's when the container is moved
  // text's map, or governs (a text map) or holds (a block) a character the author does not own after the frame: moved
  // text, or a peer's typing. A container new in this frame carries its initial attributes: they are part of the
  // author's insert, which reject removes, and copied text's own properties were proven above.
  const pending = [...attributed].filter((container) => !isFreshId(container.id) && rootOf(container) === BODY);
  if (pending.length > 0) {
    const notOwn = new Set<string>();
    for (const e of after()) {
      if (e.char === null || isOwnElem(e)) continue;
      if (e.gov) notOwn.add(e.gov);
      for (const ancestor of e.ancestors) notOwn.add(ancestor);
    }
    for (const container of pending) {
      if (isMoved(container.id.client, container.id.clock, container.id.clock + 1)) throw new Refusal('mutate-original');
      if (notOwn.has(keyOf(container.id))) throw new Refusal('mutate-original');
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
  // Tracked characters the frame deletes, directly or with a block it deletes (a join deletes the joined block).
  const gone = new Set<string>();
  const visit = (item: Y.Item, from: number, to: number): void => {
    if (item.deleted) return;
    if (item.content instanceof Y.ContentString) {
      for (let clock = from; clock < to; clock++) if (tracked(item.id.client, clock)) gone.add(`${item.id.client}:${clock}`);
    } else if (item.content instanceof Y.ContentType) {
      for (let child = item.content.type._start; child; child = child.right) visit(child, child.id.clock, child.id.clock + child.length);
    }
  };
  for (const [client, ranges] of ds.clients) {
    for (const { clock, len } of ranges) {
      for (let at = clock; at < Math.min(clock + len, Y.getState(doc.store, client));) {
        const item = Y.getItem(doc.store, Y.createID(client, at));
        const stop = Math.min(clock + len, item.id.clock + item.length);
        if (item instanceof Y.Item) visit(item, at, stop);
        at = Math.max(stop, at + 1);
      }
    }
  }
  const out = spans.map((span) => ({ ...span }));
  if (gone.size === 0) return out;
  const view = serverView(doc, update);
  try {
    const added = new Set<string>();
    // The same document-order alignment as the vetter's proof, so a copy is found wherever the writer put it: the
    // block itself, a new block after it, or the block before it after a join. Characters only: an editor's bold
    // re-inserts the run with new text properties, and it is still the same text.
    const pre = view.body(false);
    const wanted = (o: Elem) => gone.has(keyOf(o));
    const matched = align(pre, view.body(true), isFreshId, wanted, (o, p) => p.char === o.char);
    for (const o of pre) {
      const p = wanted(o) ? matched.get(keyOf(o)) : undefined;
      if (!p) continue;
      added.add(keyOf(p));
      if (p.gov && isFreshId(idOf(p.gov))) added.add(p.gov);
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
  /** The key of the block (nested or top-level) the element sits in; null at the root. */
  block: string | null;
  /** The keys of every block the element sits in, outermost first. */
  ancestors: readonly string[];
}
const keyOf = (e: { client: number; clock: number }) => `${e.client}:${e.clock}`;
const idOf = (key: string) => {
  const [client, clock] = key.split(':').map(Number);
  return Y.createID(client, clock);
};

/** Whether an item is a V1 text node's map. */
function isTextMap(item: Y.Item): boolean {
  const type = item.content instanceof Y.ContentType ? item.content.type : null;
  if (!(type instanceof Y.Map)) return false;
  const entry = type._map.get('__type');
  if (!entry || entry.content instanceof Y.ContentDeleted) return false;
  const values = entry.content.getContent();
  return values[values.length - 1] === 'text';
}

/**
 * A V1 subtree's content in document order, counting only `include`d items: each character with the text map before
 * it, each embed, and the content of each nested block right after the block's own embed.
 */
function flatten(type: Y.AbstractType<unknown>, include: (item: Y.Item) => boolean, out: Elem[] = [], ancestors: readonly string[] = []): Elem[] {
  const block = ancestors.length > 0 ? ancestors[ancestors.length - 1] : null;
  let props: string | null = null;
  let gov: string | null = null;
  for (let item = type._start; item; item = item.right) {
    if (!include(item)) continue;
    const content = item.content;
    if (content instanceof Y.ContentString) {
      for (let i = 0; i < content.str.length; i++) {
        out.push({ client: item.id.client, clock: item.id.clock + i, char: content.str[i], props, gov, block, ancestors });
      }
    } else if (!(content instanceof Y.ContentFormat) && !(content instanceof Y.ContentDeleted)) {
      const embedded = content instanceof Y.ContentType ? content.type : null;
      const isText = embedded instanceof Y.Map && mapJson(embedded, include).__type === 'text';
      props = isText ? stableJson(mapJson(embedded as Y.Map<unknown>, include)) : null;
      gov = isText ? keyOf(item.id) : null;
      out.push({ client: item.id.client, clock: item.id.clock, char: null, props: null, gov: null, block, ancestors });
      if (embedded instanceof Y.XmlText) flatten(embedded as unknown as Y.AbstractType<unknown>, include, out, [...ancestors, keyOf(item.id)]);
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
 * Pairs each element before the frame with the same element after it, or, for a `wanted` element the frame deleted,
 * with the fresh element that `same` accepts as its copy. Elements that existed before keep their document order (Yjs
 * never moves an item), so a scan that meets an older element first knows the one it seeks is gone.
 */
function align(
  pre: Elem[], post: Elem[], isFreshId: (id: Y.ID) => boolean, wanted: (o: Elem) => boolean, same: (o: Elem, p: Elem) => boolean,
): Map<string, Elem> {
  const live = new Set(post.map(keyOf));
  const matched = new Map<string, Elem>();
  let j = 0;
  for (const o of pre) {
    const kept = live.has(keyOf(o));
    if (!kept && !wanted(o)) continue;
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

/** Whether a registers key held a live value before the frame. */
function keyLiveBefore(view: View, key: string, isFreshId: (id: Y.ID) => boolean): boolean {
  let entry: Y.Item | null | undefined = view.registers()?._map.get(key);
  while (entry && isFreshId(entry.id)) entry = entry.left;
  return !!entry && view.liveBefore(entry);
}

const alive = (item: Y.Item) => !item.deleted;
const bodyOf = (doc: Y.Doc) => doc.get(BODY, Y.XmlText) as unknown as Y.AbstractType<unknown>;

function serverView(doc: Y.Doc, update: Uint8Array): View {
  let mirror: Y.Doc | null = null;
  return {
    state: (client) => Y.getState(doc.store, client),
    get: (id) => Y.getItem(doc.store, id),
    liveBefore: alive,
    body: (after) => {
      if (!after) return flatten(bodyOf(doc), alive);
      if (!mirror) {
        mirror = new Y.Doc();
        Y.applyUpdate(mirror, Y.encodeStateAsUpdate(doc));
        Y.applyUpdate(mirror, update);
      }
      return flatten(bodyOf(mirror), alive);
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
    body: (after) => flatten(bodyOf(doc), after ? alive : existedLive),
    registers: () => doc.share.get(REGISTERS) as Y.Map<unknown> | undefined,
    dispose: () => {},
  };
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
