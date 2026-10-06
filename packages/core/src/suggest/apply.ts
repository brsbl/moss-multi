// Suggestion records applied to a mirror (docs/design/suggestions.md §4): the accept gates that need only Yjs, the
// projection a reviewer is shown, and its hash. Shared by the client preview and the DocDO accept. The Lexical parts
// (the headless bind check, G7, and each block's exportJSON) are passed in by the caller, so this module stays
// Lexical-free.
import * as encoding from 'lib0/encoding';
import { digest } from 'lib0/hash/sha256';
import { encodeUtf8 } from 'lib0/string';
import * as Y from 'yjs';

export interface IdSpan {
  client: number;
  clock: number;
  len: number;
}

/** Body items proposed for deletion, by exact Yjs id. The quote is for display only. */
export interface DeletePart {
  id: string;
  kind: 'delete';
  targets: IdSpan[];
  quote: string;
}

export type RecordStatus = 'open' | 'accepted' | 'rejected' | 'withdrawn';

export type GateReason =
  | 'not-open'
  | 'unresolvable'
  | 'foreign-client'
  | 'outside-body'
  | 'payload-alias'
  | 'outdated'
  | 'changed'
  | 'broken'
  | 'doc-cap';

export interface RecordMeta {
  v: 2;
  id: string;
  author: string;
  authorName: string;
  source: 'live' | 'cli';
  note?: string;
  createdAt: number;
  updatedAt: number;
  status: RecordStatus;
  resolvedBy?: string;
  resolvedAt?: number;
  /** The leased Yjs client ids this record's ops are written under. */
  clients: number[];
  continues?: string;
  continuedBy?: string;
  outdated?: GateReason[];
  broken?: GateReason;
}

/** The doc an op writes: the note's body, or a payload doc by its id (docs/design/registers.md). */
export const BODY_DOC = 'body';

/** One fork transaction's V1 update, exactly as the author's fork produced it, and the doc it was made in. */
export interface RecordOp {
  doc: string;
  update: Uint8Array;
}

export interface SuggestionRecord {
  meta: RecordMeta;
  ops: RecordOp[];
  parts: DeletePart[];
}

export type DocKind = 'body' | 'payload';

export type TypeKind = 'XmlText' | 'XmlElement' | 'XmlFragment' | 'XmlHook' | 'Text' | 'Map' | 'Array';

export type ContentKind = 'String' | 'Any' | 'JSON' | 'Binary' | 'Embed' | 'Format' | 'Doc' | 'Deleted' | `Type:${TypeKind}`;

/** A place a struct can sit: under a parent type of some kind in a root, in its sequence or at a map key. */
export interface Channel {
  doc: DocKind;
  root: string;
  parent: TypeKind;
  sub: 'seq' | 'key';
  content: readonly ContentKind[];
}

/**
 * The channel table (docs/design/suggestions.md §4.4), default-deny: a record may insert or remove a struct only in
 * these channels, ingest and accept refuse every other struct, and the preview renders exactly these channels. A new
 * channel is added here and rendered by `channelValue` together, or it is refused.
 */
export const CHANNELS: readonly Channel[] = [
  // Lexical's V1 binding. An element is an XmlText: its sequence holds text, text-node and line-break maps, child
  // elements and decorators; its keys are the node's properties (the root's are root properties such as `__dir`) and
  // `__state`, a Map.
  { doc: 'body', root: 'root', parent: 'XmlText', sub: 'seq', content: ['String', 'Type:XmlText', 'Type:XmlElement', 'Type:Map', 'Deleted'] },
  { doc: 'body', root: 'root', parent: 'XmlText', sub: 'key', content: ['Any', 'Type:Map', 'Deleted'] },
  // A decorator: an XmlElement with properties only.
  { doc: 'body', root: 'root', parent: 'XmlElement', sub: 'key', content: ['Any', 'Type:Map', 'Deleted'] },
  // A text node's or line break's properties, and a node's `__state`.
  { doc: 'body', root: 'root', parent: 'Map', sub: 'key', content: ['Any', 'Type:Map', 'Deleted'] },
  // Payload docs (packages/sync payload-docs.ts): a text payload's characters, and a compound payload's JSON fields.
  { doc: 'payload', root: 'payload', parent: 'Text', sub: 'seq', content: ['String', 'Deleted'] },
  { doc: 'payload', root: 'payload-map', parent: 'Map', sub: 'key', content: ['Any', 'Deleted'] },
];

/** The table's roots and the type each is read as. */
export const ROOT_KINDS: Readonly<Record<DocKind, ReadonlyMap<string, TypeKind>>> = {
  body: new Map([['root', 'XmlText']]),
  payload: new Map([['payload', 'Text'], ['payload-map', 'Map']]),
};

/** The roots a record may change in the body. The retired `registers` map is not one: payloads are their own docs. */
export const BODY_ROOTS: ReadonlySet<string> = new Set(ROOT_KINDS.body.keys());

/** Types nest at most this deep under a root; deeper is refused, so rendering never recurses without bound. */
export const MAX_DEPTH = 256;

export function typeKind(type: unknown): TypeKind | null {
  if (type instanceof Y.XmlText) return 'XmlText';
  if (type instanceof Y.Text) return 'Text';
  if (type instanceof Y.XmlHook) return 'XmlHook';
  if (type instanceof Y.Map) return 'Map';
  if (type instanceof Y.XmlElement) return 'XmlElement';
  if (type instanceof Y.XmlFragment) return 'XmlFragment';
  if (type instanceof Y.Array) return 'Array';
  return null;
}

export function contentKind(content: Y.Item['content']): ContentKind | null {
  if (content instanceof Y.ContentString) return 'String';
  if (content instanceof Y.ContentAny) return 'Any';
  if (content instanceof Y.ContentDeleted) return 'Deleted';
  if (content instanceof Y.ContentType) {
    const kind = typeKind(content.type);
    return kind === null ? null : `Type:${kind}`;
  }
  if (content instanceof Y.ContentFormat) return 'Format';
  if (content instanceof Y.ContentEmbed) return 'Embed';
  if (content instanceof Y.ContentBinary) return 'Binary';
  if (content instanceof Y.ContentJSON) return 'JSON';
  if (content instanceof Y.ContentDoc) return 'Doc';
  return null;
}

/**
 * Where a struct sits, and for a type, the type's own kind. `parent` is null under a root outside the table. `path` is
 * true when every item enclosing the struct sits in a table channel, so a struct is shown only if its whole ancestor
 * path is. `gone` marks a deleted item whose content was collected (a tombstone: no type, no value).
 */
export interface Placement {
  root: string;
  parent: TypeKind | null;
  sub: string | null;
  type: TypeKind | null;
  depth: number;
  path: boolean;
  gone: boolean;
}

export function channelAllows(doc: DocKind, at: Placement, content: ContentKind | null): boolean {
  if (!at.path || at.parent === null || content === null || at.depth > MAX_DEPTH) return false;
  const sub = at.sub === null ? 'seq' : 'key';
  return CHANNELS.some((c) => c.doc === doc && c.root === at.root && c.parent === at.parent && c.sub === sub && c.content.includes(content));
}

/** The placement of a child of the type held by the item placed at `holder`. */
function childOf(doc: DocKind, holder: Placement, sub: string | null, content: Y.Item['content']): Placement {
  const path = channelAllows(doc, holder, holder.type === null ? null : `Type:${holder.type}`);
  return { root: holder.root, parent: holder.type, sub, type: typeOf(content), depth: holder.depth + 1, path, gone: content instanceof Y.ContentDeleted };
}

const typeOf = (content: Y.Item['content']): TypeKind | null => (content instanceof Y.ContentType ? typeKind(content.type) : null);

/** An integrated item's placement, every enclosing edge checked against the table (O(depth)), or null when its parent is gone. */
export function placementOf(kind: DocKind, doc: Y.Doc, item: Y.Item): Placement | null {
  if (!(item.parent instanceof Y.AbstractType)) return null;
  const chain: Y.Item[] = [];
  let top = item.parent as Y.AbstractType<unknown>;
  while (top._item !== null) {
    const up = top._item.parent;
    if (!(up instanceof Y.AbstractType) || chain.length >= MAX_DEPTH) {
      return { root: '', parent: null, sub: item.parentSub, type: typeOf(item.content), depth: MAX_DEPTH + 1, path: false, gone: false };
    }
    chain.push(top._item);
    top = up as Y.AbstractType<unknown>;
  }
  let root = '';
  for (const [name, shared] of doc.share) if (shared === top) root = name;
  const rootKind = ROOT_KINDS[kind].get(root) ?? null;
  // The type at the root, as the item holding it would be placed; then each enclosing item, top down.
  let at: Placement = { root, parent: null, sub: null, type: rootKind, depth: -1, path: true, gone: false };
  const holderAt = (sub: string | null, content: Y.Item['content']): Placement =>
    at.depth < 0 ? { root, parent: rootKind, sub, type: typeOf(content), depth: 0, path: rootKind !== null, gone: content instanceof Y.ContentDeleted } : childOf(kind, at, sub, content);
  for (let i = chain.length - 1; i >= 0; i--) at = holderAt(chain[i].parentSub, chain[i].content);
  return holderAt(item.parentSub, item.content);
}

/** A delete set's ranges per client, sorted and merged, so coverage is a binary search. */
function coverage(ds: { clients: Map<number, { clock: number; len: number }[]> }): (id: Y.ID, len: number) => boolean {
  const merged = new Map<number, { clock: number; len: number }[]>();
  for (const [client, ranges] of ds.clients) {
    const out: { clock: number; len: number }[] = [];
    for (const range of [...ranges].sort((a, b) => a.clock - b.clock)) {
      const last = out[out.length - 1];
      if (last && range.clock <= last.clock + last.len) last.len = Math.max(last.len, range.clock + range.len - last.clock);
      else out.push({ clock: range.clock, len: range.len });
    }
    merged.set(client, out);
  }
  return (id, len) => {
    const list = merged.get(id.client) ?? [];
    let lo = 0;
    let hi = list.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (id.clock < list[mid].clock) hi = mid - 1;
      else if (id.clock >= list[mid].clock + list[mid].len) lo = mid + 1;
      else return id.clock + len <= list[mid].clock + list[mid].len;
    }
    return false;
  };
}

/**
 * The struct-level check of one op's update (G3 at ingest; the shape half of G3 at accept). Every struct must be an
 * Item in a table channel, or a GC struct or deleted content that the op's own delete set covers (an insert and
 * delete in one transaction). A Skip is never sent by an honest client. `lookup` places an id outside this update
 * (the live doc, or the record's earlier ops); null leaves the struct to accept, where an unplaceable item parks (G1)
 * or integrates as GC (G5 c). Returns the placement of each struct it placed, or null when a struct is refused.
 */
export function checkStructs(
  kind: DocKind,
  decoded: { structs: (Y.Item | Y.GC | Y.Skip)[]; ds: { clients: Map<number, { clock: number; len: number }[]> } },
  lookup: (id: Y.ID) => Placement | null,
): { struct: Y.Item; at: Placement }[] | null {
  const byClient = new Map<number, (Y.Item | Y.GC | Y.Skip)[]>();
  for (const struct of decoded.structs) {
    const list = byClient.get(struct.id.client);
    if (list) list.push(struct);
    else byClient.set(struct.id.client, [struct]);
  }
  const find = (id: Y.ID) => {
    const list = byClient.get(id.client);
    if (!list) return undefined;
    let lo = 0;
    let hi = list.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const struct = list[mid];
      if (id.clock < struct.id.clock) hi = mid - 1;
      else if (id.clock >= struct.id.clock + struct.length) lo = mid + 1;
      else return struct;
    }
    return undefined;
  };
  // false: refused; null: not placeable here.
  const memo = new Map<Y.Item, Placement | null | false>();
  // Through an origin a struct sits beside the origin; through its parent, in the parent item's type. A tombstoned
  // parent (an editor deleted it, and its type was collected) is left to accept, where the struct integrates as GC.
  const derive = (item: Y.Item, base: Placement | null | false, viaParent: boolean): Placement | null | false => {
    if (!base) return base;
    if (!viaParent) return { ...base, type: typeOf(item.content), gone: item.content instanceof Y.ContentDeleted };
    if (base.gone) return null;
    if (base.type === null) return false;
    return childOf(kind, base, item.parentSub, item.content);
  };
  const place = (start: Y.Item): Placement | null | false => {
    const stack = [start];
    const onStack = new Set<Y.Item>(stack);
    while (stack.length > 0) {
      const item = stack[stack.length - 1];
      if (memo.has(item)) {
        stack.pop();
        continue;
      }
      // A decoded item's parent is a root's name, the id of the item holding its parent type, or null (from origins).
      const parent = item.parent as unknown;
      let result: Placement | null | false;
      if (typeof parent === 'string') {
        const rootKind = ROOT_KINDS[kind].get(parent) ?? null;
        result = { root: parent, parent: rootKind, sub: item.parentSub, type: typeOf(item.content), depth: 0, path: rootKind !== null, gone: item.content instanceof Y.ContentDeleted };
      } else {
        const viaParent = parent instanceof Y.ID;
        const ref = parent instanceof Y.ID ? parent : (item.origin ?? item.rightOrigin);
        if (!ref) result = false;
        else {
          const dep = find(ref);
          if (dep === undefined) result = derive(item, lookup(ref), viaParent);
          else if (!(dep instanceof Y.Item)) result = null;
          else if (memo.has(dep)) result = derive(item, memo.get(dep)!, viaParent);
          else if (onStack.has(dep)) result = false;
          else {
            stack.push(dep);
            onStack.add(dep);
            continue;
          }
        }
      }
      memo.set(item, result);
      stack.pop();
    }
    return memo.get(start)!;
  };
  const covered = coverage(decoded.ds);
  const placed: { struct: Y.Item; at: Placement }[] = [];
  for (const struct of decoded.structs) {
    if (struct instanceof Y.Skip) return null;
    if (struct instanceof Y.GC) {
      if (!covered(struct.id, struct.length)) return null;
      continue;
    }
    if (struct.content instanceof Y.ContentDeleted && !covered(struct.id, struct.length)) return null;
    const at = place(struct);
    if (at === false) return null;
    if (at === null) continue;
    if (!channelAllows(kind, at, contentKind(struct.content))) return null;
    placed.push({ struct, at });
  }
  return placed;
}

/** A payload id an op may name. */
export const PAYLOAD_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** What the record inserted, per client: [from, to) clocks. */
export type Inserted = ReadonlyMap<number, readonly [number, number]>;

/**
 * The payload docs the record's ops write, as the caller holds them for this accept. `doc` returns one gc-free mirror
 * per id, the same one on every call: the payload's state before the record for an id the note knows, and an empty
 * doc for a new one. `known` is true for every id the note knows, served or withheld.
 */
export interface PayloadMirrors {
  known(id: string): boolean;
  doc(id: string): Y.Doc;
}

export interface ApplyOptions {
  /** G7: binds a headless editor to the doc after the record; false when Lexical cannot take the tree. */
  bindCheck?: (doc: Y.Doc, inserted: Inserted) => boolean;
  /** Required when a record has payload ops. */
  payloads?: PayloadMirrors;
}

export type ApplyResult =
  | { ok: true; hydrated: Uint8Array; inserted: Inserted; payloads: Map<string, Uint8Array> }
  | { ok: false; reason: GateReason };

export const itemKey = (id: Y.ID): string => `${id.client}:${id.clock}`;

/** A gc-free copy of `live`, so a record's own deletes stay readable while the gates run. */
export function hydrate(live: Y.Doc): Y.Doc {
  const mirror = new Y.Doc({ gc: false });
  Y.applyUpdate(mirror, Y.encodeStateAsUpdate(live));
  return mirror;
}

/** A delete-only V1 update naming exactly `spans`. */
export function deleteUpdate(spans: readonly IdSpan[]): Uint8Array {
  const encoder = new Y.UpdateEncoderV1();
  const rest = encoder.restEncoder;
  const writeVarUint = encoding.writeVarUint;
  writeVarUint(rest, 0);
  const byClient = new Map<number, IdSpan[]>();
  for (const span of spans) byClient.set(span.client, [...(byClient.get(span.client) ?? []), span]);
  writeVarUint(rest, byClient.size);
  for (const [client, list] of byClient) {
    writeVarUint(rest, client);
    writeVarUint(rest, list.length);
    for (const span of [...list].sort((a, b) => a.clock - b.clock)) {
      writeVarUint(rest, span.clock);
      writeVarUint(rest, span.len);
    }
  }
  return encoder.toUint8Array();
}

const spansOf = (ds: { clients: Map<number, { clock: number; len: number }[]> }): IdSpan[] =>
  [...ds.clients].flatMap(([client, list]) => list.map(({ clock, len }) => ({ client, clock, len })));

/** One doc the record writes: the body, or a payload doc. */
interface Target {
  doc: Y.Doc;
  kind: DocKind;
  ops: Uint8Array[];
  hydrated: Uint8Array;
  state: (client: number) => number;
  /** Each authoring step's removals (an op's delete set, or a delete part's targets). */
  groups: IdSpan[][];
  ownDeletes: IdSpan[];
  inserted: Map<number, readonly [number, number]>;
  /** Every item the record's transaction deleted: the delete sets named, and what Yjs deletes with them (a type's
   * contents, a map key's overwritten value). */
  deleted: IdSpan[];
}

function target(doc: Y.Doc, kind: DocKind): Target {
  const hydrated = Y.encodeStateVector(doc);
  const before = Y.decodeStateVector(hydrated);
  return {
    doc, kind, ops: [], hydrated, state: (client) => before.get(client) ?? 0, groups: [], ownDeletes: [], inserted: new Map(), deleted: [],
  };
}

/**
 * Applies every op and delete part of `record` to `mirror` (the body) and to the payload mirrors its ops name, one
 * transaction per doc, and runs G1–G5 and G7 over all of them. On failure the mirrors are spoiled; callers hydrate
 * fresh ones. Nothing here touches the live doc or a live payload.
 */
export function applyRecord(mirror: Y.Doc, record: SuggestionRecord, options: ApplyOptions = {}): ApplyResult {
  const fail = (reason: GateReason): ApplyResult => ({ ok: false, reason });
  const clients = new Set(record.meta.clients);
  const body = target(mirror, 'body');
  const targets = new Map<string, Target>([[BODY_DOC, body]]);
  const refsBefore = regRefs(mirror);

  // Each authoring step (an op, or a delete part) removes its own run of items; the record's own deletes are the
  // union of its ops' delete sets.
  for (const op of record.ops) {
    if (!op || typeof op.doc !== 'string' || !(op.update instanceof Uint8Array)) return fail('unresolvable');
    let into = targets.get(op.doc);
    if (!into) {
      if (!PAYLOAD_ID.test(op.doc) || !options.payloads) return fail('unresolvable');
      // G4, first since nothing of it may even be loaded: a payload op edits only a payload a live element names
      // before the record, or writes a new one; never a withheld payload, whose text the author cannot see.
      if (options.payloads.known(op.doc) && !refsBefore.has(op.doc)) return fail('payload-alias');
      into = target(options.payloads.doc(op.doc), 'payload');
      targets.set(op.doc, into);
    }
    let decoded: ReturnType<typeof Y.decodeUpdate>;
    try {
      decoded = Y.decodeUpdate(op.update);
    } catch {
      return fail('unresolvable');
    }
    // A Skip is a gap an honest fork never sends; alone it would integrate as nothing (G1's class).
    if (decoded.structs.some((struct) => struct instanceof Y.Skip)) return fail('unresolvable');
    const spans = spansOf(decoded.ds);
    into.ops.push(op.update);
    into.groups.push(spans);
    into.ownDeletes.push(...spans);
  }
  for (const part of record.parts) {
    if (!Array.isArray(part.targets) || !part.targets.every(validSpan)) return fail('unresolvable');
    body.groups.push(part.targets);
  }

  // G5 (a) and (b) read each doc as it was before the record, so they run first and report after G1–G4.
  const outdated = [...targets.values()].some((t) => !t.groups.every((spans) => removesLiveRun(t.doc.store, spans, t.state)));

  try {
    for (const t of targets.values()) {
      let tr: Y.Transaction | null = null;
      t.doc.transact((transaction) => {
        tr = transaction;
        for (const op of t.ops) Y.applyUpdate(t.doc, op);
        if (t === body) for (const part of record.parts) Y.applyUpdate(t.doc, deleteUpdate(part.targets));
      }, APPLY);
      t.deleted = spansOf((tr as Y.Transaction | null)!.deleteSet as never);
    }
  } catch {
    return fail('unresolvable');
  }

  // G1: nothing parked, in any doc.
  for (const t of targets.values()) if (t.doc.store.pendingStructs !== null || t.doc.store.pendingDs !== null) return fail('unresolvable');

  // G2: only the record's leased clients advanced, in the body and in every payload doc.
  for (const t of targets.values()) {
    for (const [client, clock] of Y.decodeStateVector(Y.encodeStateVector(t.doc))) {
      if (clock <= t.state(client)) continue;
      if (!clients.has(client)) return fail('foreign-client');
      t.inserted.set(client, [t.state(client), clock]);
    }
  }

  // G3, default-deny: every item the record inserted and every item its transaction deleted lies in a channel of the
  // table, so the preview, which renders exactly those channels, shows each of them. The transaction's own delete set
  // also holds the implicit deletions: a deleted type's contents and a map key's overwritten value. GC structs are
  // left to G5 (c).
  for (const t of targets.values()) {
    const spans = [...[...t.inserted].map(([client, [from, to]]) => ({ client, clock: from, len: to - from })), ...t.groups.flat(), ...t.deleted];
    for (const span of spans) {
      const end = Math.min(span.clock + span.len, Y.getState(t.doc.store, span.client));
      for (const struct of structsIn(t.doc.store, span.client, span.clock, end)) {
        if (!(struct instanceof Y.Item)) continue;
        const at = placementOf(t.kind, t.doc, struct);
        if (at === null || !channelAllows(t.kind, at, contentKind(struct.content))) return fail('outside-body');
      }
    }
  }

  // G4: no payload is aliased.
  const known = (id: string) => options.payloads?.known(id) ?? false;
  if (!payloadsUnaliased(mirror, refsBefore, body.inserted, known)) return fail('payload-alias');

  // G5 (c): every struct the record inserted and did not itself delete integrated as a live item.
  if (outdated || [...targets.values()].some((t) => !insertedLive(t.doc.store, t.inserted, t.ownDeletes))) return fail('outdated');

  // G7: Lexical can bind the result.
  if (options.bindCheck && !options.bindCheck(mirror, body.inserted)) return fail('broken');

  const payloads = new Map<string, Uint8Array>();
  for (const [id, t] of targets) if (t !== body) payloads.set(id, t.hydrated);
  return { ok: true, hydrated: body.hydrated, inserted: body.inserted, payloads };
}

const APPLY = 'suggest-apply';

const validSpan = (span: IdSpan): boolean =>
  !!span && [span.client, span.clock, span.len].every((n) => Number.isSafeInteger(n) && n >= 0) && span.len > 0;

const covers = (spans: readonly IdSpan[], client: number, clock: number): boolean =>
  spans.some((span) => span.client === client && span.clock <= clock && clock < span.clock + span.len);

/** The structs of `client` overlapping [clock, end), in order. */
function* structsIn(store: Y.Doc['store'], client: number, clock: number, end: number): Generator<Y.Item | Y.GC> {
  const structs = store.clients.get(client) as (Y.Item | Y.GC)[] | undefined;
  if (!structs || clock >= end) return;
  for (let i = Y.findIndexSS(structs as never, clock); i < structs.length && structs[i].id.clock < end; i++) yield structs[i];
}

/**
 * G5 (a) and (b) for one authoring step: every body item it removes is live, and within each parent sequence no live
 * item it does not remove sits between two it does. The record's own items do not exist yet, so every item seen here
 * is someone else's.
 */
function removesLiveRun(store: Y.Doc['store'], spans: readonly IdSpan[], state: (client: number) => number): boolean {
  const parents = new Set<Y.AbstractType<unknown>>();
  const body: IdSpan[] = [];
  for (const span of spans) {
    const end = Math.min(span.clock + span.len, state(span.client));
    if (span.clock >= end) continue;
    body.push({ client: span.client, clock: span.clock, len: end - span.clock });
    for (const struct of structsIn(store, span.client, span.clock, end)) {
      if (!(struct instanceof Y.Item) || struct.deleted) return false;
      if (struct.parentSub === null) parents.add(struct.parent as Y.AbstractType<unknown>);
    }
  }
  for (const parent of parents) {
    let removedBefore = false;
    let foreign = false;
    for (let item = parent._start; item; item = item.right) {
      for (let offset = 0; offset < item.length; offset++) {
        if (covers(body, item.id.client, item.id.clock + offset)) {
          if (foreign) return false;
          removedBefore = true;
        } else if (!item.deleted && removedBefore) {
          foreign = true;
        }
      }
    }
  }
  return true;
}

/** G5 (c). */
function insertedLive(store: Y.Doc['store'], inserted: Inserted, ownDeletes: readonly IdSpan[]): boolean {
  for (const [client, [from, to]] of inserted) {
    for (const struct of structsIn(store, client, from, to)) {
      if (struct instanceof Y.Item && !struct.deleted) continue;
      const start = Math.max(struct.id.clock, from);
      const end = Math.min(struct.id.clock + struct.length, to);
      for (let clock = start; clock < end; clock++) if (!covers(ownDeletes, client, clock)) return false;
    }
  }
  return true;
}

const isInserted = (inserted: Inserted, id: Y.ID): boolean => {
  const range = inserted.get(id.client);
  return !!range && range[0] <= id.clock && id.clock < range[1];
};

/**
 * G4 `payload-alias`. A `__regId` the record writes sits on an element the record created, and that element is the
 * only live one naming the id. The id is one the note did not know (a payload created in this record), or the element
 * is a move of an existing one: the record removed every element that named the id (an Enter before an inline formula
 * re-creates the decorator, since @lexical/yjs moves a node by deleting it and inserting a copy). So a fresh decorator
 * never names an existing payload, served or withheld, and no element is re-pointed.
 */
function payloadsUnaliased(
  doc: Y.Doc,
  refsBefore: ReadonlyMap<string, Y.AbstractType<unknown>[]>,
  inserted: Inserted,
  known: (id: string) => boolean,
): boolean {
  const refs = regRefs(doc);
  for (const [client, [from, to]] of inserted) {
    for (const struct of structsIn(doc.store, client, from, to)) {
      if (!(struct instanceof Y.Item) || struct.deleted || struct.parentSub !== '__regId') continue;
      const holder = struct.parent as Y.AbstractType<unknown>;
      if (!holder._item || !isInserted(inserted, holder._item.id)) return false;
      const key = struct.content.getContent().at(-1);
      if (typeof key !== 'string') return false;
      // A deleted holder names nothing after the record; only a live one is checked for sharing.
      if (holder._item.deleted) continue;
      if (refs.get(key)?.length !== 1) return false;
      const namedBefore = refsBefore.get(key) ?? [];
      if (namedBefore.length === 0 && !known(key)) continue;
      if (namedBefore.length === 0 || !namedBefore.every((type) => type._item?.deleted)) return false;
    }
  }
  return true;
}

/** Stable JSON: object keys sorted. */
export function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      return Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
    }
    return v;
  });
}

/** A shared value as plain data, recursively, for G7's before-and-after comparison (not the preview). */
export function yValue(value: unknown): unknown {
  if (value instanceof Y.XmlText) {
    return { t: 'xmltext', attrs: attrsOf(value), delta: deltaOf(value) };
  }
  if (value instanceof Y.XmlElement) {
    return { t: 'xmlelement', name: value.nodeName, attrs: attrsOf(value), children: value.toArray().map(yValue) };
  }
  if (value instanceof Y.XmlFragment) return { t: 'xmlfragment', children: value.toArray().map(yValue) };
  if (value instanceof Y.Text) return { t: 'text', attrs: attrsOf(value), delta: deltaOf(value) };
  if (value instanceof Y.Map) {
    return { t: 'map', entries: [...value.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => [k, yValue(v)]) };
  }
  if (value instanceof Y.Array) return { t: 'array', items: value.toArray().map(yValue) };
  if (value instanceof Y.Doc) return { t: 'doc', guid: value.guid };
  if (value instanceof Uint8Array) return { t: 'binary', bytes: Array.from(value) };
  if (Array.isArray(value)) return value.map(yValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, yValue(v)]));
  }
  return value ?? null;
}

function attrsOf(type: { getAttributes(): unknown }): [string, unknown][] {
  return Object.entries(type.getAttributes() as Record<string, unknown>)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, v]) => [k, yValue(v)]);
}

function deltaOf(type: Y.Text): unknown[] {
  return (type.toDelta() as { insert: unknown; attributes?: Record<string, unknown> }[]).map((op) => ({
    insert: typeof op.insert === 'string' ? op.insert : yValue(op.insert),
    ...(op.attributes ? { attributes: yValue(op.attributes) } : {}),
  }));
}

/** What a reviewer is shown of a doc: each top-level block by its Yjs item id, and each register by key. */
export interface Projection {
  /** The root's own attributes (Lexical's root properties). */
  note: unknown;
  blocks: Map<string, unknown>;
  order: string[];
  /** Each payload a live element names, by id. */
  payloads: Map<string, unknown>;
}

/** A type's live sequence as the preview shows it: runs of characters as strings, every other item by its content. */
function seqValue(doc: DocKind, root: string, type: Y.AbstractType<unknown>): unknown[] {
  const seq: unknown[] = [];
  for (let item = type._start; item; item = item.right) {
    if (item.deleted) continue;
    const value = contentValue(doc, root, item.content);
    if (typeof value === 'string' && typeof seq.at(-1) === 'string') seq[seq.length - 1] += value;
    else seq.push(value);
  }
  return seq;
}

/** A type's live keys as the preview shows them, sorted, as [key, value] pairs. */
function keysValue(doc: DocKind, root: string, type: Y.AbstractType<unknown>): [string, unknown][] {
  return [...type._map]
    .filter(([, item]) => !item.deleted)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, item]) => [key, contentValue(doc, root, item.content)]);
}

/**
 * A type as the preview shows it: exactly the channels the table lists for its kind (§4.4), recursively. Nothing else
 * is rendered, because G3 refuses every struct a record would write or remove anywhere else.
 */
export function channelValue(doc: DocKind, root: string, type: Y.AbstractType<unknown>, kind: TypeKind): unknown {
  const rows = CHANNELS.filter((c) => c.doc === doc && c.root === root && c.parent === kind);
  return {
    type: kind,
    ...(type instanceof Y.XmlElement ? { name: type.nodeName } : {}),
    ...(rows.some((c) => c.sub === 'seq') ? { seq: seqValue(doc, root, type) } : {}),
    ...(rows.some((c) => c.sub === 'key') ? { keys: keysValue(doc, root, type) } : {}),
  };
}

/** One item's content: characters as a string, a type by its channels, anything else tagged by its content kind. */
function contentValue(doc: DocKind, root: string, content: Y.Item['content']): unknown {
  if (content instanceof Y.ContentString) return content.str;
  if (content instanceof Y.ContentType) {
    const kind = typeKind(content.type);
    return kind === null ? { type: null } : channelValue(doc, root, content.type as Y.AbstractType<unknown>, kind);
  }
  if (content instanceof Y.ContentFormat) return { Format: [content.key, content.value] };
  if (content instanceof Y.ContentDoc) return { Doc: { guid: content.doc.guid, opts: content.opts } };
  if (content instanceof Y.ContentBinary) return { Binary: Array.from(content.content) };
  return { [contentKind(content) ?? 'Unknown']: content.getContent() };
}

/** A payload doc as a reviewer is shown it: its text and its compound fields, by the table. */
export function payloadValueOf(doc: Y.Doc): unknown {
  const seq = seqValue('payload', 'payload', doc.getText('payload') as unknown as Y.AbstractType<unknown>);
  const text = seq.length === 0 ? '' : seq.length === 1 && typeof seq[0] === 'string' ? seq[0] : seq;
  return { text, map: keysValue('payload', 'payload-map', doc.getMap('payload-map') as unknown as Y.AbstractType<unknown>) };
}

/**
 * Projects `doc`. `lexical` gives each top-level block's recursive exportJSON by item id (the caller binds the
 * converter editor); the Yjs-level value, by the channel table, is always included, so the hash covers every channel.
 * `payload` resolves the payload docs live elements name, plus each id in `also` (the payloads a record writes, named
 * or not); each is projected in full.
 */
export function projectDoc(
  doc: Y.Doc,
  lexical?: ReadonlyMap<string, unknown>,
  payload?: (id: string) => Y.Doc | undefined,
  also: Iterable<string> = [],
): Projection {
  const blocks = new Map<string, unknown>();
  const order: string[] = [];
  const root = doc.get('root', Y.XmlText);
  for (let item = root._start; item; item = item.right) {
    if (item.deleted) continue;
    const key = itemKey(item.id);
    blocks.set(key, { y: contentValue('body', 'root', item.content), lexical: lexical?.get(key) ?? null });
    order.push(key);
  }
  const payloads = new Map<string, unknown>();
  for (const id of new Set([...regRefs(doc).keys(), ...also])) {
    const held = payload?.(id);
    payloads.set(id, held ? payloadValueOf(held) : null);
  }
  return { note: keysValue('body', 'root', root as unknown as Y.AbstractType<unknown>), blocks, order, payloads };
}

export interface Hunk {
  kind: 'block' | 'note' | 'payload';
  id: string;
  op: 'added' | 'removed' | 'changed';
  before?: unknown;
  after?: unknown;
  /** For an added block: the block it follows (null at the start). Positions are relative, never absolute. */
  at?: string | null;
}

export function projectionDiff(before: Projection, after: Projection): Hunk[] {
  const hunks: Hunk[] = [];
  if (canonical(before.note) !== canonical(after.note)) hunks.push({ kind: 'note', id: 'root', op: 'changed', before: before.note, after: after.note });
  const blockIds = [...new Set([...before.blocks.keys(), ...after.blocks.keys()])];
  for (const id of blockIds) {
    const b = before.blocks.get(id);
    const a = after.blocks.get(id);
    if (b === undefined) {
      const index = after.order.indexOf(id);
      hunks.push({ kind: 'block', id, op: 'added', after: a, at: index > 0 ? after.order[index - 1] : null });
    } else if (a === undefined) hunks.push({ kind: 'block', id, op: 'removed', before: b });
    else if (canonical(a) !== canonical(b)) hunks.push({ kind: 'block', id, op: 'changed', before: b, after: a });
  }
  const payloadIds = [...new Set([...before.payloads.keys(), ...after.payloads.keys()])];
  for (const id of payloadIds) {
    const b = before.payloads.get(id);
    const a = after.payloads.get(id);
    if (b === undefined) hunks.push({ kind: 'payload', id, op: 'added', after: a });
    else if (a === undefined) hunks.push({ kind: 'payload', id, op: 'removed', before: b });
    else if (canonical(a) !== canonical(b)) hunks.push({ kind: 'payload', id, op: 'changed', before: b, after: a });
  }
  return hunks.sort((x, y) => (x.kind !== y.kind ? (x.kind < y.kind ? -1 : 1) : x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
}

const hex = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

export function previewHash(hunks: readonly Hunk[]): string {
  return hex(digest(encodeUtf8(canonical(hunks))));
}

/** G0: binds an accept to the exact ops and parts the reviewer previewed. */
export function recordDigest(record: SuggestionRecord): string {
  const parts = encodeUtf8(canonical({ id: record.meta.id, parts: record.parts, clients: record.meta.clients }));
  const chunks = record.ops.flatMap((op) => [encodeUtf8(op.doc), op.update]);
  let size = parts.length;
  for (const chunk of chunks) size += chunk.length + 4;
  const all = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    new DataView(all.buffer).setUint32(at, chunk.length);
    all.set(chunk, at + 4);
    at += chunk.length + 4;
  }
  all.set(parts, at);
  return hex(digest(all));
}

/** The register keys named by live `__regId` attributes in the body, with the types naming them. */
export function regRefs(doc: Y.Doc): Map<string, Y.AbstractType<unknown>[]> {
  const refs = new Map<string, Y.AbstractType<unknown>[]>();
  const visit = (type: Y.AbstractType<unknown>) => {
    const named = type._map.get('__regId');
    if (named && !named.deleted) {
      const key = named.content.getContent().at(-1);
      if (typeof key === 'string') refs.set(key, [...(refs.get(key) ?? []), type]);
    }
    for (const item of type._map.values()) {
      if (!item.deleted && item.content instanceof Y.ContentType) visit(item.content.type);
    }
    for (let item = type._start; item; item = item.right) {
      if (!item.deleted && item.content instanceof Y.ContentType) visit(item.content.type);
    }
  };
  visit(doc.get('root', Y.XmlText) as unknown as Y.AbstractType<unknown>);
  return refs;
}

export { spansOf };
