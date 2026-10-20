// Suggestion records applied to a mirror (docs/design/suggestions.md §4): the accept gates that need only Yjs, the
// projection a reviewer is shown, and its hash. Shared by the client preview and the DocDO accept. The Lexical part
// (the headless bind check, G7) is passed in by the caller, so this module stays Lexical-free.
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
  /** Set on a record merged into another (`suggest-merge`); it is closed and its ops and parts moved there. */
  mergedInto?: string;
  outdated?: GateReason[];
  broken?: GateReason;
  /**
   * Set at accept when it kept a block or payload the record changed only in item identity (`landing`): the author's
   * fork, which holds the record's copies there, no longer reads as the body and rebuilds.
   */
  kept?: true;
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

/** `record[key]` only when the record holds `key` itself: a name from a record never reads Object.prototype. */
export const ownValue = <T>(record: Readonly<Record<string, T>>, key: string): T | undefined => (Object.hasOwn(record, key) ? record[key] : undefined);

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
  /**
   * G7: binds a headless editor to the doc after the record; false when Lexical cannot take the tree. `deleted` is
   * every body item the record's transaction removed, so a block it only deleted from is checked too.
   */
  bindCheck?: (doc: Y.Doc, inserted: Inserted, deleted: readonly IdSpan[]) => boolean;
  /** Required when a record has payload ops. */
  payloads?: PayloadMirrors;
}

export type ApplyResult =
  | {
    ok: true; hydrated: Uint8Array; inserted: Inserted; payloads: Map<string, Uint8Array>;
    /** Every item the record's transactions deleted, per doc (`BODY_DOC` or a payload id). */
    removed: Map<string, IdSpan[]>;
  }
  | { ok: false; reason: GateReason };

export const itemKey = (id: Y.ID): string => `${id.client}:${id.clock}`;

/** The constructor `live` typed a root with, so a copy types it the same before any struct integrates. */
function rootType(type: Y.AbstractType<unknown>): (new () => Y.AbstractType<unknown>) | null {
  if (type instanceof Y.XmlText) return Y.XmlText as never;
  if (type instanceof Y.Text) return Y.Text as never;
  if (type instanceof Y.XmlFragment) return Y.XmlFragment as never;
  if (type instanceof Y.Map) return Y.Map as never;
  if (type instanceof Y.Array) return Y.Array as never;
  return null;
}

/**
 * A gc-free copy of `live`, so a record's own deletes stay readable while the gates run. Its roots are typed as
 * `live`'s before the state is applied: a root typed afterwards loses what integration set on it (a Y.Text's
 * formatting flag), so the copy would skip a cleanup `live` runs.
 */
export function hydrate(live: Y.Doc): Y.Doc {
  const mirror = new Y.Doc({ gc: false });
  for (const [name, type] of live.share) {
    const ctor = rootType(type as Y.AbstractType<unknown>);
    if (ctor) mirror.get(name, ctor as never);
  }
  Y.applyUpdate(mirror, Y.encodeStateAsUpdate(live));
  return mirror;
}

/** A delete-only V1 update naming exactly `spans`. */
export function deleteUpdate(spans: readonly IdSpan[]): Uint8Array {
  const encoder = new Y.UpdateEncoderV1();
  encoding.writeVarUint(encoder.restEncoder, 0);
  writeDeletes(encoder, spans);
  return encoder.toUint8Array();
}

/** A V1 update's delete set naming exactly `spans`. */
function writeDeletes(encoder: Y.UpdateEncoderV1, spans: readonly IdSpan[]): void {
  const rest = encoder.restEncoder;
  const writeVarUint = encoding.writeVarUint;
  const byClient = new Map<number, IdSpan[]>();
  for (const span of spans) {
    const list = byClient.get(span.client);
    if (list) list.push(span);
    else byClient.set(span.client, [span]);
  }
  writeVarUint(rest, byClient.size);
  for (const [client, list] of byClient) {
    writeVarUint(rest, client);
    writeVarUint(rest, list.length);
    for (const span of [...list].sort((a, b) => a.clock - b.clock)) {
      writeVarUint(rest, span.clock);
      writeVarUint(rest, span.len);
    }
  }
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
  /** Each authoring step's removals: an op's delete set, or a delete part's targets (`part`). */
  groups: { spans: IdSpan[]; part: boolean }[];
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
    into.groups.push({ spans, part: false });
    for (const span of spans) into.ownDeletes.push(span);
  }
  for (const part of record.parts) {
    if (!Array.isArray(part.targets) || !part.targets.every(validSpan)) return fail('unresolvable');
    body.groups.push({ spans: part.targets, part: true });
  }

  // G5 (a) and (b) read each doc as it was before the record, so they run first and report after G1–G4.
  const outdated = [...targets.values()].some((t) => !removesLiveRuns(t.doc.store, t.groups, t.state));

  // Applied as a remote update, as accept lands it on the live doc, so Yjs's follow-on transactions (a Y.Text's
  // formatting cleanup) run here too; every transaction's deletes are collected, the follow-ons' included.
  try {
    for (const t of targets.values()) {
      const deleted: IdSpan[] = [];
      const collect = (transaction: Y.Transaction) => {
        for (const span of spansOf(transaction.deleteSet as never)) deleted.push(span);
      };
      t.doc.on('afterTransaction', collect);
      try {
        Y.transact(t.doc, () => {
          for (const op of t.ops) Y.applyUpdate(t.doc, op);
          if (t === body) for (const part of record.parts) Y.applyUpdate(t.doc, deleteUpdate(part.targets));
        }, APPLY, false);
      } finally {
        t.doc.off('afterTransaction', collect);
      }
      t.deleted = deleted;
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
  // left to G5 (c). The spans are merged first, so each struct is placed once however often the record names it.
  for (const t of targets.values()) {
    const spans = new SpanIndex([...[...t.inserted].map(([client, [from, to]]) => ({ client, clock: from, len: to - from })), ...t.groups.flatMap((group) => group.spans), ...t.deleted]);
    for (const [client, from, to] of spans.ranges()) {
      const end = Math.min(to, Y.getState(t.doc.store, client));
      for (const struct of structsIn(t.doc.store, client, from, end)) {
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
  if (options.bindCheck && !options.bindCheck(mirror, body.inserted, body.deleted)) return fail('broken');

  const payloads = new Map<string, Uint8Array>();
  for (const [id, t] of targets) if (t !== body) payloads.set(id, t.hydrated);
  const removed = new Map<string, IdSpan[]>([...targets].map(([id, t]) => [id, t.deleted]));
  return { ok: true, hydrated: body.hydrated, inserted: body.inserted, payloads, removed };
}

/**
 * What accept lands from `doc` (a mirror the record was applied to, at state vector `sv` before it), and whether it
 * keeps anything: every struct the record wrote and every item it removed (`removed`), except where `kept` holds (a
 * block or payload that reads as it did, so the preview shows no hunk for it; suggestions.md §4.7). There the items it
 * removed stay and the ones it added land removed, so the originals, the comments anchored on them and their authors
 * stay: accept applies nothing the preview hides (I3). So too for each copy in `restored`, which the preview reads as
 * its original: the original stays and the copy lands removed. A key it overwrote in a live map stays overwritten,
 * with the same value, as the preview read it. Null (accept refuses) where the record wrote anything
 * beneath an original or an item it removed that stays, or removed or overwrote anything beneath a restored copy.
 */
export function landing(doc: Y.Doc, sv: Uint8Array, removed: readonly IdSpan[], kept: (item: Y.Item) => boolean, restored?: Restored): { update: Uint8Array; kept: boolean } | null {
  const before = Y.decodeStateVector(sv);
  const state = (client: number) => before.get(client) ?? 0;
  const current = (item: Y.Item) => item.parentSub === null || (item.parent as Y.AbstractType<unknown>)._map.get(item.parentSub) === item;
  // Restored copies (restoredCopies) read as their originals, so those stay with all they hold and the copies land
  // removed, unit by unit, in a block the record otherwise changes too.
  const inOriginal = (item: Y.Item) => {
    for (let holder = (item.parent as Y.AbstractType<unknown>)._item; holder; holder = (holder.parent as Y.AbstractType<unknown>)._item) {
      if (restored?.originals.has(itemKey(holder.id))) return true;
    }
    return false;
  };
  const units = (struct: Y.Item, lo: number, hi: number, has: (key: string) => boolean, into: IdSpan[]) => {
    for (let clock = lo; clock < hi; clock += 1) {
      if (!has(`${struct.id.client}:${clock}`)) continue;
      const last = into.at(-1);
      if (last && last.client === struct.id.client && last.clock + last.len === clock) last.len += 1;
      else into.push({ client: struct.id.client, clock, len: 1 });
    }
  };
  const stays: IdSpan[] = [];
  for (const span of new SpanIndex(removed).ranges()) {
    const [client, from, to] = span;
    const end = Math.min(to, state(client));
    for (const struct of structsIn(doc.store, client, from, end)) {
      if (!(struct instanceof Y.Item) || !current(struct)) continue;
      const lo = Math.max(from, struct.id.clock);
      const hi = Math.min(end, struct.id.clock + struct.length);
      if (kept(struct) || (restored?.originals.size && inOriginal(struct))) stays.push({ client, clock: lo, len: hi - lo });
      else if (restored?.originals.size) units(struct, lo, hi, (key) => restored!.originals.has(key), stays);
    }
  }
  // The preview reads a restored copy as its original, and a kept item as it was, so it shows nothing the record
  // wrote beneath either. Beneath an original or a kept item a write would land on the item that stays (a map key
  // overwrites as it lands), so any is refused. A copy lands removed with all it holds, so what an undo restored
  // into it lands inert; a struct removed or overwritten beneath it is no restore, and is refused too.
  const keep = new SpanIndex(stays);
  const NONE = 0;
  const COPY = 1;
  const STAYS = 2;
  /** Each parent type to what it lies beneath, the strongest of its holders. */
  const beneath = new Map<Y.AbstractType<unknown>, number>();
  const levelOf = (start: Y.AbstractType<unknown>): number => {
    const walked: Y.AbstractType<unknown>[] = [];
    let level = NONE;
    for (let type: Y.AbstractType<unknown> | null = start; type; type = (type._item?.parent ?? null) as Y.AbstractType<unknown> | null) {
      const seen = beneath.get(type);
      if (seen !== undefined) {
        level = seen;
        break;
      }
      walked.push(type);
    }
    // From the outermost walked type in, each takes its holder's level over what holds it.
    for (let i = walked.length - 1; i >= 0; i -= 1) {
      const holder = walked[i]._item;
      if (holder) {
        const key = itemKey(holder.id);
        if (restored?.originals.has(key) || keep.covers(holder.id.client, holder.id.clock, holder.id.clock + 1)) level = STAYS;
        else if (restored?.copies.has(key)) level = Math.max(level, COPY);
      }
      beneath.set(walked[i], level);
    }
    return level;
  };
  const buried: IdSpan[] = [];
  for (const client of doc.store.clients.keys()) {
    const from = state(client);
    for (const struct of structsIn(doc.store, client, from, Y.getState(doc.store, client))) {
      if (struct instanceof Y.Item) {
        const level = levelOf(struct.parent as Y.AbstractType<unknown>);
        if (level === STAYS || (level === COPY && struct.deleted)) return null;
      }
      if (!(struct instanceof Y.Item) || struct.deleted || struct.parentSub !== null) continue;
      const lo = Math.max(from, struct.id.clock);
      if (kept(struct)) buried.push({ client, clock: lo, len: struct.id.clock + struct.length - lo });
      else if (restored?.clients.has(client)) units(struct, lo, struct.id.clock + struct.length, (key) => restored!.copies.has(key), buried);
    }
  }
  if (!stays.length && !buried.length) return { update: Y.encodeStateAsUpdate(doc, sv), kept: false };
  const deletes: IdSpan[] = [...buried];
  for (const [client, from, to] of new SpanIndex(removed).ranges()) {
    for (const [lo, hi, covered] of keep.runs(client, from, to)) if (!covered) deletes.push({ client, clock: lo, len: hi - lo });
  }
  const encoder = new Y.UpdateEncoderV1();
  writeStructsSince(encoder, doc, before);
  writeDeletes(encoder, deletes);
  return { update: encoder.toUint8Array(), kept: true };
}

/** Every struct of `doc` past `sv`, as Yjs writes an update's structs (encodeStateAsUpdate). */
function writeStructsSince(encoder: Y.UpdateEncoderV1, doc: Y.Doc, sv: Map<number, number>): void {
  const rest = encoder.restEncoder;
  const from = new Map<number, number>();
  for (const client of doc.store.clients.keys()) {
    const clock = sv.get(client) ?? 0;
    if (Y.getState(doc.store, client) > clock) from.set(client, clock);
  }
  encoding.writeVarUint(rest, from.size);
  for (const [client, clock] of [...from].sort((a, b) => b[0] - a[0])) {
    const structs = doc.store.clients.get(client) as (Y.Item | Y.GC)[];
    const start = Math.max(clock, structs[0]!.id.clock);
    const index = Y.findIndexSS(structs as never, start);
    encoding.writeVarUint(rest, structs.length - index);
    encoder.writeClient(client);
    encoding.writeVarUint(rest, start);
    structs[index]!.write(encoder, start - structs[index]!.id.clock);
    for (let i = index + 1; i < structs.length; i += 1) structs[i]!.write(encoder, 0);
  }
}

const APPLY = 'suggest-apply';

const validSpan = (span: IdSpan): boolean =>
  !!span && [span.client, span.clock, span.len].every((n) => Number.isSafeInteger(n) && n >= 0) && span.len > 0;

/** Spans per client, sorted and merged, so a range splits into covered and uncovered runs by binary search. */
class SpanIndex {
  readonly #by = new Map<number, { from: number; to: number }[]>();

  constructor(spans: readonly IdSpan[]) {
    const raw = new Map<number, { from: number; to: number }[]>();
    for (const span of spans) {
      const list = raw.get(span.client);
      const range = { from: span.clock, to: span.clock + span.len };
      if (list) list.push(range);
      else raw.set(span.client, [range]);
    }
    for (const [client, list] of raw) {
      list.sort((a, b) => a.from - b.from);
      const merged: { from: number; to: number }[] = [];
      for (const range of list) {
        const last = merged[merged.length - 1];
        if (last && range.from <= last.to) last.to = Math.max(last.to, range.to);
        else merged.push({ ...range });
      }
      this.#by.set(client, merged);
    }
  }

  /** [from, to) of `client` as runs in order: [start, end, covered]. */
  *runs(client: number, from: number, to: number): Generator<[number, number, boolean]> {
    const list = this.#by.get(client) ?? [];
    let lo = 0;
    let hi = list.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (list[mid].to <= from) lo = mid + 1;
      else hi = mid;
    }
    let at = from;
    for (let i = lo; i < list.length && at < to; i++) {
      const range = list[i];
      if (range.from >= to) break;
      if (range.from > at) {
        yield [at, range.from, false];
        at = range.from;
      }
      const end = Math.min(range.to, to);
      yield [at, end, true];
      at = end;
    }
    if (at < to) yield [at, to, false];
  }

  /** Every merged range, as [client, from, to). */
  *ranges(): Generator<[number, number, number]> {
    for (const [client, list] of this.#by) for (const range of list) yield [client, range.from, range.to];
  }

  covers(client: number, from: number, to: number): boolean {
    for (const [, , covered] of this.runs(client, from, to)) if (!covered) return false;
    return true;
  }
}

/** The structs of `client` overlapping [clock, end), in order. */
function* structsIn(store: Y.Doc['store'], client: number, clock: number, end: number): Generator<Y.Item | Y.GC> {
  const structs = store.clients.get(client) as (Y.Item | Y.GC)[] | undefined;
  if (!structs || clock >= end) return;
  for (let i = Y.findIndexSS(structs as never, clock); i < structs.length && structs[i].id.clock < end; i++) yield structs[i];
}

/**
 * G5 (a) and (b) for each authoring step: every body item it removes is live, and within each parent sequence no live
 * item it does not remove sits between two it does. The record's own items do not exist yet, so every item seen here
 * is someone else's. Each parent is indexed once (each item's character offset and the live characters before it), so
 * a step costs its own items, not its parents' length; a step naming the same items as another is checked once.
 */
function removesLiveRuns(store: Y.Doc['store'], groups: readonly { spans: IdSpan[]; part: boolean }[], state: (client: number) => number): boolean {
  const indexes = new Map<Y.AbstractType<unknown>, Map<Y.Item, { start: number; live: number }>>();
  const indexOf = (parent: Y.AbstractType<unknown>) => {
    let index = indexes.get(parent);
    if (!index) {
      index = new Map();
      let start = 0;
      let live = 0;
      for (let item = parent._start; item; item = item.right) {
        index.set(item, { start, live });
        start += item.length;
        if (!item.deleted) live += item.length;
      }
      indexes.set(parent, index);
    }
    return index;
  };
  const steps: { ranges: [number, number, number][]; part: boolean }[] = [];
  const seen = new Set<string>();
  for (const { spans, part } of groups) {
    const clipped: IdSpan[] = [];
    for (const span of spans) {
      const end = Math.min(span.clock + span.len, state(span.client));
      if (span.clock < end) clipped.push({ client: span.client, clock: span.clock, len: end - span.clock });
    }
    const ranges = [...new SpanIndex(clipped).ranges()];
    const key = ranges.map(([client, from, to]) => `${client}:${from}:${to}`).join(',');
    if (seen.has(key)) continue;
    seen.add(key);
    steps.push({ ranges, part });
  }
  // A fork deletes an item in one transaction only, and strikes it with one part only, so ops' runs are disjoint, as
  // are parts'. An op may still delete what a part struck (the struck item stays live in the fork, and a native join
  // removes it with its block). So the steps visit each struct at most twice, plus once per run.
  for (const part of [false, true]) {
    const all = steps.filter((step) => step.part === part).flatMap((step) => step.ranges).sort((x, y) => x[0] - y[0] || x[1] - y[1]);
    for (let i = 1; i < all.length; i++) if (all[i][0] === all[i - 1][0] && all[i][1] < all[i - 1][2]) return false;
  }
  for (const { ranges } of steps) {
    // Per parent: the first and last removed character's offsets, the live characters before each, and how many it removes.
    const extents = new Map<Y.AbstractType<unknown>, { lo: number; hi: number; liveLo: number; liveHi: number; count: number }>();
    for (const [client, from, to] of ranges) {
      for (const struct of structsIn(store, client, from, to)) {
        if (!(struct instanceof Y.Item) || struct.deleted) return false;
        if (struct.parentSub !== null) continue;
        const parent = struct.parent as Y.AbstractType<unknown>;
        const at = indexOf(parent).get(struct);
        if (!at) return false;
        const skip = Math.max(from, struct.id.clock) - struct.id.clock;
        const take = Math.min(to, struct.id.clock + struct.length) - struct.id.clock;
        const lo = at.start + skip;
        const hi = at.start + take;
        const extent = extents.get(parent);
        if (!extent) extents.set(parent, { lo, hi, liveLo: at.live + skip, liveHi: at.live + take, count: take - skip });
        else {
          if (lo < extent.lo) [extent.lo, extent.liveLo] = [lo, at.live + skip];
          if (hi > extent.hi) [extent.hi, extent.liveHi] = [hi, at.live + take];
          extent.count += take - skip;
        }
      }
    }
    for (const extent of extents.values()) if (extent.liveHi - extent.liveLo !== extent.count) return false;
  }
  return true;
}

/** G5 (c). */
function insertedLive(store: Y.Doc['store'], inserted: Inserted, ownDeletes: readonly IdSpan[]): boolean {
  const own = new SpanIndex(ownDeletes);
  for (const [client, [from, to]] of inserted) {
    for (const struct of structsIn(store, client, from, to)) {
      if (struct instanceof Y.Item && !struct.deleted) continue;
      if (!own.covers(client, Math.max(struct.id.clock, from), Math.min(struct.id.clock + struct.length, to))) return false;
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

/** Stable JSON: object keys sorted. Values come through `jsonSafe`; a stray BigInt or -0 still reads as its tag. */
export function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (typeof v === 'bigint' || Object.is(v, -0)) return jsonSafe(v);
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

/** A type's live attributes, read from its map: `getAttributes` builds a plain object, which drops a `__proto__` key. */
function attrsOf(type: { _map: Map<string, Y.Item> }): [string, unknown][] {
  return [...type._map]
    .filter(([, item]) => !item.deleted)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, item]) => [k, yValue(item.content.getContent()[item.length - 1])]);
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
  /** Each block and payload as it reads, item identity aside (`readsAs`): one that reads the same has no hunk. */
  reads?: Map<string, string>;
}

/**
 * How a projection names items: by Yjs id (`true`), not at all (`false`, a block as it reads), or by id with each
 * restored copy named as the body unit it restores (`Restored`).
 */
export type Identity = boolean | Restored;

/**
 * A type's live sequence as the preview shows it, each entry with the Yjs id it starts at, so a reviewer's rows align
 * text by item identity: runs of characters with consecutive ids as `{ id, s }`, every other item as `{ id, ...value }`.
 */
function seqValue(doc: DocKind, root: string, type: Y.AbstractType<unknown>, ids: Identity = true): Record<string, unknown>[] {
  const restored = typeof ids === 'object' ? ids : null;
  const seq: Record<string, unknown>[] = [];
  let next: { client: number; clock: number } | null = null;
  const chars = (s: string, client: number, clock: number) => {
    const last = seq.at(-1);
    // Without identity, adjacent characters are one run whoever wrote them.
    if (last && typeof last.s === 'string' && (!ids || (next && next.client === client && next.clock === clock))) last.s += s;
    else seq.push(ids ? { id: `${client}:${clock}`, s } : { s });
    next = { client, clock: clock + s.length };
  };
  for (let item = type._start; item; item = item.right) {
    if (item.deleted) continue;
    const value = contentValue(doc, root, item.content, ids);
    const { client, clock } = item.id;
    if (typeof value === 'string') {
      if (!restored?.clients.has(client)) {
        chars(value, client, clock);
        continue;
      }
      for (let i = 0; i < value.length; i += 1) {
        const was = restored.copies.get(`${client}:${clock + i}`);
        chars(value[i]!, was ? was.client : client, was ? was.clock : clock + i);
      }
    } else {
      const was = restored?.copies.get(itemKey(item.id));
      seq.push(ids ? { id: itemKey(was ?? item.id), ...(value as Record<string, unknown>) } : { v: value });
      next = null;
    }
  }
  return seq;
}

/** A type's live keys as the preview shows them, sorted, as [key, value] pairs. */
function keysValue(doc: DocKind, root: string, type: Y.AbstractType<unknown>, ids: Identity = true): [string, unknown][] {
  return [...type._map]
    .filter(([, item]) => !item.deleted)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, item]) => [key, contentValue(doc, root, item.content, ids)]);
}

/**
 * A type as the preview shows it: exactly the channels the table lists for its kind (§4.4), recursively. Nothing else
 * is rendered, because G3 refuses every struct a record would write or remove anywhere else.
 */
export function channelValue(doc: DocKind, root: string, type: Y.AbstractType<unknown>, kind: TypeKind, ids: Identity = true): unknown {
  const rows = CHANNELS.filter((c) => c.doc === doc && c.root === root && c.parent === kind);
  return {
    type: kind,
    ...(type instanceof Y.XmlElement ? { name: type.nodeName } : {}),
    ...(rows.some((c) => c.sub === 'seq') ? { seq: seqValue(doc, root, type, ids) } : {}),
    ...(rows.some((c) => c.sub === 'key') ? { keys: keysValue(doc, root, type, ids) } : {}),
  };
}

/** One item's content: characters as a string, a type by its channels, anything else tagged by its content kind. */
function contentValue(doc: DocKind, root: string, content: Y.Item['content'], ids: Identity = true): unknown {
  if (content instanceof Y.ContentString) return content.str;
  if (content instanceof Y.ContentType) {
    const kind = typeKind(content.type);
    return kind === null ? { type: null } : channelValue(doc, root, content.type as Y.AbstractType<unknown>, kind, ids);
  }
  if (content instanceof Y.ContentFormat) return { Format: [content.key, jsonSafe(content.value)] };
  if (content instanceof Y.ContentDoc) return { Doc: { guid: content.doc.guid, opts: jsonSafe(content.opts) } };
  if (content instanceof Y.ContentBinary) return { Binary: Array.from(content.content) };
  return { [contentKind(content) ?? 'Unknown']: content.getContent().map(jsonSafe) };
}

/**
 * A stored value as JSON carries it, so the preview can be sent, one to one: what JSON cannot hold (a BigInt,
 * undefined, NaN, an infinity or -0, bytes: an `Any` can hold each) is a tagged object `{$: kind, v}`, and an object's
 * own key starting with `$` gains another, so no stored object reads as a tag or as another object.
 */
function jsonSafe(value: unknown): unknown {
  if (typeof value === 'bigint') return { $: 'bigint', v: value.toString() };
  if (value === undefined) return { $: 'undefined' };
  if (typeof value === 'number' && (!Number.isFinite(value) || Object.is(value, -0))) return { $: 'number', v: Object.is(value, -0) ? '-0' : String(value) };
  if (value instanceof Uint8Array) return { $: 'bytes', v: Array.from(value) };
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k.startsWith('$') ? `$${k}` : k, jsonSafe(v)]));
  }
  return value;
}

/** A payload doc as a reviewer is shown it: its text, the id each run of it starts at, and its compound fields. */
export function payloadValueOf(doc: Y.Doc): unknown {
  const seq = seqValue('payload', 'payload', doc.getText('payload') as unknown as Y.AbstractType<unknown>);
  const strings = seq.every((entry) => typeof entry.s === 'string');
  const text = strings ? seq.map((entry) => entry.s).join('') : seq.map((entry) => (typeof entry.s === 'string' ? entry.s : entry));
  const ids = seq.map((entry) => [entry.id, typeof entry.s === 'string' ? entry.s.length : 1]);
  return { text, ids, map: keysValue('payload', 'payload-map', doc.getMap('payload-map') as unknown as Y.AbstractType<unknown>) };
}

/** A payload doc as it reads, item identity aside. */
function payloadReads(doc: Y.Doc): string {
  return canonical({
    seq: seqValue('payload', 'payload', doc.getText('payload') as unknown as Y.AbstractType<unknown>, false),
    map: keysValue('payload', 'payload-map', doc.getMap('payload-map') as unknown as Y.AbstractType<unknown>, false),
  });
}

/**
 * A top-level block as it reads, item identity aside: its channels, each run of characters joined whoever wrote it.
 * The undo of a split restores the split rest as new copies (yjs redoItem), so the block reads as it did.
 */
export function readsAs(content: Y.Item['content']): string {
  return canonical(contentValue('body', 'root', content, false));
}

/**
 * Whether the top-level block holding item `id` of `doc` (F or C) reads as that block does in `body`, identity aside:
 * what records wrote or removed there changes nothing a reader sees, so nothing is painted in it. Each block is read
 * once per predicate.
 */
export function readsAsBody(doc: Y.Doc, body: Y.Doc): (id: Y.ID) => boolean {
  const root = doc.get('root', Y.XmlText) as unknown as Y.AbstractType<unknown>;
  const seen = new Map<Y.Item, boolean>();
  return (id) => {
    if (id.clock >= Y.getState(doc.store, id.client)) return false;
    const found: Y.Item | Y.GC = Y.getItem(doc.store, id);
    if (!(found instanceof Y.Item)) return false;
    let top: Y.Item = found;
    while (top.parent !== root) {
      const holder: Y.Item | null = (top.parent as Y.AbstractType<unknown> | null)?._item ?? null;
      if (!holder) return false;
      top = holder;
    }
    const known = seen.get(top);
    if (known !== undefined) return known;
    let same = false;
    if (!top.deleted && top.id.clock < Y.getState(body.store, top.id.client)) {
      const was = Y.getItem(body.store, top.id);
      same = was instanceof Y.Item && !was.deleted && readsAs(was.content) === readsAs(top.content);
    }
    seen.set(top, same);
    return same;
  };
}

/**
 * The restored copies in `doc` (F, C or a review mirror): the undo of a split or a join brings the text a structural op
 * removed back as new copies (yjs redoItem), with new ids. `copies` maps each copy unit (a character or another item,
 * by id key) to the body unit it restores; `originals` holds those body units' keys; `clients` the copies' clients.
 */
export interface Restored {
  copies: Map<string, Y.ID>;
  originals: Set<string>;
  clients: Set<number>;
}

/**
 * Finds the restored copies in `doc` against `body`, the state before the records (suggestions.md §4.7). Yjs redoes a
 * deleted item as a copy of its content inserted just before it, so the copy's right origin is the original's id and
 * its units line up with the original's from there (a copy split by typing keeps that right origin in every part). A
 * new unit restores a body unit when the original is live in `body`, removed in `doc`, in the same parent, reads the
 * same, and, for text, sits under the same text node (its property map, or the copy of it). Text a record rewrites
 * (a restyle, a replaced word) sits under a new map or reads differently, so it is not taken for a copy. An undo, a
 * redo and a second undo restore a copy of the first copy, which restores the same body unit.
 *
 * A copy counts only where accept can keep its original in its place (orderPlan), so what reads as the body is what
 * lands as the body.
 *
 * Linear in the doc whatever client ids writers chose, and without recursion: each new unit's link (the unit it
 * restores) is read from its struct, a chain of copies is followed once with every link memoized, each item's property
 * map is found once, and each parent holding copies is read once. `steps`, if given, counts that work.
 */
export function restoredCopies(doc: Y.Doc, body: Y.Doc, steps?: { count: number }): Restored {
  const tick = () => {
    if (steps) steps.count += 1;
  };
  const out: Restored = { copies: new Map(), originals: new Set(), clients: new Set() };
  const root = doc.get('root', Y.XmlText) as unknown as Y.AbstractType<unknown>;
  const isMap = (item: Y.Item) => item.content instanceof Y.ContentType && item.content.type instanceof Y.Map;
  const isText = (item: Y.Item) => item.content instanceof Y.ContentString;
  const itemIn = (store: Y.Doc['store'], id: Y.ID): Y.Item | null => {
    if (id.clock >= Y.getState(store, id.client)) return null;
    const item = Y.getItem(store, id);
    return item instanceof Y.Item ? item : null;
  };
  const liveIn = (store: Y.Doc['store'], id: Y.ID): Y.Item | null => {
    const item = itemIn(store, id);
    return item && !item.deleted ? item : null;
  };
  const removedIn = (id: Y.ID): Y.Item | null => {
    const item = itemIn(doc.store, id);
    return item?.deleted ? item : null;
  };
  /** The nearest live property map left of an item, each item's found once (`known`). */
  const mapLeftOf = (known: Map<Y.Item, Y.Item | null>) => (item: Y.Item): Y.Item | null => {
    const walked = [item];
    let found: Y.Item | null = null;
    for (let left = item.left; left; left = left.left) {
      tick();
      if (!left.deleted && isMap(left)) {
        found = left;
        break;
      }
      const seen = known.get(left);
      if (seen !== undefined) {
        found = seen;
        break;
      }
      walked.push(left);
    }
    for (const each of walked) known.set(each, found);
    return found;
  };
  const docMap = mapLeftOf(new Map());
  const bodyMap = mapLeftOf(new Map());
  const reads = (content: Y.Item['content']) => canonical(contentValue('body', 'root', content, false));
  /**
   * Each new struct that may hold copies, to the clock its run starts at: a copy split by typing keeps its right
   * origin in every part, and its units line up with the original's from the run's start. A top-level block is shown
   * by its own id (projectDoc), so a block's copy never reads as its original.
   */
  const runs = new Map<Y.Item, number>();
  for (const [client, structs] of doc.store.clients) {
    const known = Y.getState(body.store, client);
    let start = 0;
    let right: Y.ID | null = null;
    for (const struct of structs) {
      tick();
      if (!(struct instanceof Y.Item)) {
        right = null;
        continue;
      }
      const origin = struct.rightOrigin;
      if (!right || !origin || origin.client !== right.client || origin.clock !== right.clock) start = struct.id.clock;
      right = origin;
      if (struct.id.clock < known || !origin || struct.parentSub !== null || struct.parent === root) continue;
      runs.set(struct, start);
    }
  }
  type Link = { struct: Y.Item; at: number; restores: Y.ID };
  /** The unit new unit `id` would restore, and its struct, or null when it is no candidate. */
  const linkOf = (id: Y.ID): Link | null => {
    const struct = itemIn(doc.store, id);
    const start = struct ? runs.get(struct) : undefined;
    if (!struct || start === undefined) return null;
    const origin = struct.rightOrigin!;
    const at = id.clock - struct.id.clock;
    return { struct, at, restores: Y.createID(origin.client, origin.clock + struct.id.clock - start + at) };
  };
  /** Every new unit resolved so far, removed copies too, to the body unit it restores (null: none, or in progress). */
  const resolved = new Map<string, Y.ID | null>();
  /** Whether the copy linked as `link` restores body unit `original` (null: none). It resolves nothing itself. */
  const check = (link: Link, original: Y.ID | null): Y.ID | null => {
    if (!original) return null;
    const { struct, at, restores } = link;
    const gone = removedIn(restores);
    if (!gone || gone.parent !== struct.parent) return null;
    const was = liveIn(body.store, original);
    if (!was || !removedIn(original)) return null;
    if (isText(struct)) {
      const offset = original.clock - was.id.clock;
      if (!(was.content instanceof Y.ContentString) || was.content.str[offset] !== (struct.content as Y.ContentString).str[at]) return null;
      const under = bodyMap(was);
      const map = docMap(struct);
      // Property maps are resolved in the first pass; one that restores nothing counts as itself.
      const mapKey = map && itemKey(resolved.get(itemKey(map.id)) ?? map.id);
      if ((under && itemKey(under.id)) !== mapKey) return null;
    } else if (reads(was.content) !== reads(struct.content)) return null;
    return original;
  };
  /**
   * The body unit new unit `id` restores. An undo after a redo restores the copy an earlier undo made: a copy of a copy
   * restores that copy's original, so the chain is followed to a unit live in `body`, then checked back link by link.
   * A chain restores nothing where it changes kind (text or not), so it is followed only through units of kind `text`.
   * Each key is memoized as in progress (null) when it joins the path, so a cycle or a re-entry ends at once.
   */
  const resolve = (id: Y.ID, text: boolean): Y.ID | null => {
    const path: { key: string; link: Link }[] = [];
    let original: Y.ID | null = null;
    for (let at = id; ;) {
      tick();
      const key = itemKey(at);
      const known = resolved.get(key);
      if (known !== undefined) {
        original = known;
        break;
      }
      const link = linkOf(at);
      if (!link || isText(link.struct) !== text) break;
      path.push({ key, link });
      resolved.set(key, null);
      // The last link restores a body unit itself.
      if (liveIn(body.store, link.restores)) {
        original = link.restores;
        break;
      }
      at = link.restores;
    }
    for (let i = path.length - 1; i >= 0; i -= 1) {
      tick();
      original = check(path[i].link, original);
      resolved.set(path[i].key, original);
    }
    return original;
  };
  // Every live copy, by parent: other items (property maps) first, so text reads their result from the memo.
  const byParent = new Map<Y.AbstractType<unknown>, Map<string, Y.ID>>();
  for (const text of [false, true]) {
    for (const [struct] of runs) {
      // A removed copy (a redo took it back) is only a link to its original for a later copy of it.
      if (struct.deleted || isText(struct) !== text) continue;
      for (let i = 0; i < struct.length; i += 1) {
        tick();
        const copy = Y.createID(struct.id.client, struct.id.clock + i);
        const original = resolve(copy, text);
        if (!original) continue;
        const parent = struct.parent as Y.AbstractType<unknown>;
        const here = byParent.get(parent) ?? new Map<string, Y.ID>();
        byParent.set(parent, here);
        here.set(itemKey(copy), original);
      }
    }
  }
  // A copy reads as its original only where accept can land the original in its place (orderPlan); elsewhere it is
  // new text like any other, shown, painted and applied as such.
  const isNew = (id: Y.ID) => id.clock >= Y.getState(body.store, id.client);
  for (const [parent, copies] of byParent) {
    if (!orderPlan(parent, copies, isNew, tick).ok) continue;
    for (const [copy, original] of copies) {
      out.copies.set(copy, original);
      out.originals.add(itemKey(original));
      out.clients.add(Number(copy.slice(0, copy.indexOf(':'))));
    }
  }
  return out;
}

/** One unit of a parent's sequence: an item and the offset in it, keyed as the preview names it. */
interface Unit {
  key: string;
  item: Y.Item;
  at: number;
  /** New (the record wrote it) and no copy: accept may write it afresh in its place. */
  moves: boolean;
}

/**
 * How accept lands `parent` of a doc whose live `copies` (copy key to the body unit it restores) read as their
 * originals: the originals stay where they are and the copies land removed, so each run of new units (`isNew`) a
 * record wrote between copies sits elsewhere than the preview shows it. Each such run is in `moves`, with the unit it
 * follows in the preview (`after`, null at the start), to be written afresh there (`relocated`). `ok` is false where
 * that cannot reproduce the preview: an original named twice, units that are not new out of order, a run that is not
 * plain characters and property maps, or a sequence holding items that take no index.
 */
export function orderPlan(
  parent: Y.AbstractType<unknown>, copies: ReadonlyMap<string, Y.ID>, isNew: (id: Y.ID) => boolean, tick: () => void = () => {},
): { ok: boolean; moves: { after: string | null; units: Unit[] }[] } {
  const refused = { ok: false, moves: [] };
  const originals = new Set<string>();
  for (const original of copies.values()) originals.add(itemKey(original));
  /** As the preview reads the sequence: each copy named as its original. */
  const shown: Unit[] = [];
  /** As accept lands it before any run is written afresh: copies removed, originals kept. */
  const landed: Unit[] = [];
  const named = new Set<string>();
  let countable = true;
  for (let item = parent._start; item; item = item.right) {
    for (let at = 0; at < item.length; at += 1) {
      tick();
      const id = Y.createID(item.id.client, item.id.clock + at);
      const key = itemKey(id);
      if (item.deleted) {
        if (originals.has(key)) landed.push({ key, item, at, moves: false });
        continue;
      }
      if (!item.countable) countable = false;
      const was = copies.get(key);
      if (was) {
        const name = itemKey(was);
        if (named.has(name)) return refused;
        named.add(name);
        shown.push({ key: name, item, at, moves: false });
        continue;
      }
      const unit = { key, item, at, moves: isNew(id) };
      shown.push(unit);
      landed.push(unit);
    }
  }
  const fixed = (list: Unit[]) => list.filter((unit) => !unit.moves).map((unit) => unit.key).join(',');
  if (fixed(shown) !== fixed(landed)) return refused;
  /** Each fixed unit's key ('' for the start) to the run of new units right after it. */
  const runsOf = (list: Unit[]) => {
    const out = new Map<string, Unit[]>();
    let after = '';
    for (const unit of list) {
      if (!unit.moves) after = unit.key;
      else (out.get(after) ?? out.set(after, []).get(after)!).push(unit);
    }
    return out;
  };
  const have = runsOf(landed);
  const moves: { after: string | null; units: Unit[] }[] = [];
  for (const [after, units] of runsOf(shown)) {
    const there = have.get(after) ?? [];
    if (there.length === units.length && there.every((unit, i) => unit.key === units[i]!.key)) continue;
    if (!countable || !rewritable(parent) || !units.every(({ item }) => item.content instanceof Y.ContentString || plainMap(item))) return refused;
    moves.push({ after: after || null, units });
  }
  return { ok: true, moves };
}

/** A property map of plain values, which a fresh map reproduces. */
const plainMap = (item: Y.Item): boolean =>
  item.content instanceof Y.ContentType && item.content.type instanceof Y.Map && item.content.type._start === null &&
  [...item.content.type._map.values()].every((entry) => entry.deleted || entry.content instanceof Y.ContentAny);

/** A holder runs can be written afresh into (orderPlan and relocated share it): a live text node's sequence. */
const rewritable = (type: unknown): type is Y.XmlText => type instanceof Y.XmlText && type._item !== null && !type._item.deleted;

/** The item at `id` in `doc`, or null where `doc` has none. */
function itemAt(doc: Y.Doc, id: Y.ID): Y.Item | null {
  if (id.clock >= Y.getState(doc.store, id.client)) return null;
  const item = Y.getItem(doc.store, id);
  return item instanceof Y.Item ? item : null;
}

/**
 * `update`, what accept lands on `live` from `mirror` (`landing`), with each run of new units a record wrote between
 * restored copies put where the preview showed it (orderPlan): landed, the copies are removed and the originals kept,
 * so such a run would sit before the originals instead of among them. It is removed and written afresh in its place.
 * Null (accept refuses) where a plan, its holder or an anchor cannot be resolved: never a guessed place or a skip.
 */
export function relocated(live: Y.Doc, update: Uint8Array, mirror: Y.Doc, restored: Restored): Uint8Array | null {
  const byParent = new Map<Y.AbstractType<unknown>, Map<string, Y.ID>>();
  for (const [copy, original] of restored.copies) {
    const [client, clock] = copy.split(':').map(Number) as [number, number];
    const item = itemAt(mirror, Y.createID(client, clock));
    if (!item) return null;
    const parent = item.parent as Y.AbstractType<unknown>;
    (byParent.get(parent) ?? byParent.set(parent, new Map()).get(parent)!).set(copy, original);
  }
  const isNew = (id: Y.ID) => id.clock >= Y.getState(live.store, id.client);
  const plans: { parent: Y.ID; moves: { after: string | null; units: Unit[] }[] }[] = [];
  for (const [parent, copies] of byParent) {
    const plan = orderPlan(parent, copies, isNew);
    if (!plan.ok) return null;
    // orderPlan admits moves only into a rewritable holder, so it has an item.
    if (plan.moves.length) plans.push({ parent: parent._item!.id, moves: plan.moves });
  }
  if (!plans.length) return update;
  const scratch = hydrate(live);
  let refused = false;
  const refuse = () => {
    refused = true;
  };
  try {
    const sv = Y.encodeStateVector(scratch);
    Y.applyUpdate(scratch, update);
    scratch.transact(() => {
      for (const { parent, moves } of plans) {
        // The same holder check as orderPlan's, on the doc as accept lands it.
        const holder = itemAt(scratch, parent);
        const type = holder?.content instanceof Y.ContentType ? holder.content.type : null;
        if (!rewritable(type)) return refuse();
        /** Each live unit's key to the index just past it. */
        const past = () => {
          const out = new Map<string, number>();
          let index = 0;
          for (let item = type._start; item; item = item.right) {
            if (item.deleted) continue;
            for (let at = 0; at < item.length; at += 1) out.set(`${item.id.client}:${item.id.clock + at}`, (index += 1));
          }
          return out;
        };
        const moving = new Set(moves.flatMap(({ units }) => units.map((unit) => unit.key)));
        const gone = [...past()].filter(([key]) => moving.has(key)).map(([, end]) => end - 1).sort((a, b) => b - a);
        if (gone.length !== moving.size) return refuse();
        // Adjacent indexes as one range, last range first: one removal per range keeps a long run linear.
        for (let i = 0; i < gone.length; ) {
          const end = gone[i]!;
          let start = end;
          for (i += 1; i < gone.length && gone[i] === start - 1; i += 1) start -= 1;
          type.delete(start, end - start + 1);
        }
        const index = past();
        const placed: { at: number; units: Unit[] }[] = [];
        for (const { after, units } of moves) {
          const at = after === null ? 0 : index.get(after);
          if (at === undefined) return refuse();
          placed.push({ at, units });
        }
        // The last place first, so writing a run moves no place still to be written.
        for (const { at, units } of placed.sort((a, b) => b.at - a.at)) {
          // Characters in one string, so a surrogate pair is written whole.
          let next = at;
          let chars = '';
          const flush = () => {
            if (chars) type.insert(next, chars);
            next += chars.length;
            chars = '';
          };
          for (const { item, at: offset } of units) {
            if (item.content instanceof Y.ContentString) {
              chars += item.content.str[offset]!;
              continue;
            }
            flush();
            // Entry by entry from the map itself: toJSON would drop a key such as __proto__ the preview reads.
            const fresh = new Y.Map<unknown>();
            for (const [key, entry] of (item.content as Y.ContentType).type._map) {
              if (!entry.deleted) fresh.set(key, (entry.content as Y.ContentAny).getContent()[entry.length - 1]);
            }
            type.insertEmbed(next, fresh);
            next += 1;
          }
          flush();
        }
      }
    });
    return refused ? null : Y.encodeStateAsUpdate(scratch, sv);
  } finally {
    scratch.destroy();
  }
}

/**
 * Projects `doc`: each top-level block by its Yjs item id, rendered by the channel table, which is the whole of what a
 * record may write. `payload` resolves the payload docs live elements name, plus each id in `also` (the payloads a
 * record writes, named or not); each is projected in full.
 */
export function projectDoc(doc: Y.Doc, payload?: (id: string) => Y.Doc | undefined, also: Iterable<string> = [], restored?: Restored): Projection {
  const blocks = new Map<string, unknown>();
  const reads = new Map<string, string>();
  const order: string[] = [];
  const root = doc.get('root', Y.XmlText);
  for (let item = root._start; item; item = item.right) {
    if (item.deleted) continue;
    const key = itemKey(item.id);
    blocks.set(key, contentValue('body', 'root', item.content, restored ?? true));
    reads.set(`block:${key}`, readsAs(item.content));
    order.push(key);
  }
  const payloads = new Map<string, unknown>();
  for (const id of new Set([...regRefs(doc).keys(), ...also])) {
    const held = payload?.(id);
    payloads.set(id, held ? payloadValueOf(held) : null);
    if (held) reads.set(`payload:${id}`, payloadReads(held));
  }
  return { note: keysValue('body', 'root', root as unknown as Y.AbstractType<unknown>), blocks, order, payloads, reads };
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

/**
 * The blocks (`block:<id>`) and payloads (`payload:<id>`) that read after as they did before, item identity aside:
 * projectionDiff shows no hunk for them, so accept keeps them as they are (`landing`).
 */
export function unchangedReads(before: Projection, after: Projection): Set<string> {
  const out = new Set<string>();
  for (const [key, reads] of after.reads ?? []) if (before.reads?.get(key) === reads) out.add(key);
  return out;
}

/** The top-level block holding `item` of `doc`, by item id key; null for the root's own keys and sequence items. */
export function blockKeyOf(doc: Y.Doc, item: Y.Item): string | null {
  const root = doc.get('root', Y.XmlText) as unknown as Y.AbstractType<unknown>;
  let top = item;
  while (top.parent !== root) {
    const holder: Y.Item | null = (top.parent as Y.AbstractType<unknown> | null)?._item ?? null;
    if (!holder) return null;
    top = holder;
  }
  return top.parentSub === null && top.content instanceof Y.ContentType ? itemKey(top.id) : null;
}

export function projectionDiff(before: Projection, after: Projection): Hunk[] {
  const hunks: Hunk[] = [];
  // Changed only in item identity (a split and its undo): nothing a reader sees, so no hunk (suggestions.md §4.7).
  const reads = (key: string) => {
    const was = before.reads?.get(key);
    return was !== undefined && was === after.reads?.get(key);
  };
  if (canonical(before.note) !== canonical(after.note)) hunks.push({ kind: 'note', id: 'root', op: 'changed', before: before.note, after: after.note });
  const blockIds = [...new Set([...before.blocks.keys(), ...after.blocks.keys()])];
  const previous = new Map(after.order.map((id, index) => [id, index > 0 ? after.order[index - 1] : null]));
  for (const id of blockIds) {
    const b = before.blocks.get(id);
    const a = after.blocks.get(id);
    if (b === undefined) {
      hunks.push({ kind: 'block', id, op: 'added', after: a, at: previous.get(id) ?? null });
    } else if (a === undefined) hunks.push({ kind: 'block', id, op: 'removed', before: b });
    else if (canonical(a) !== canonical(b) && !reads(`block:${id}`)) hunks.push({ kind: 'block', id, op: 'changed', before: b, after: a });
  }
  const payloadIds = [...new Set([...before.payloads.keys(), ...after.payloads.keys()])];
  for (const id of payloadIds) {
    const b = before.payloads.get(id);
    const a = after.payloads.get(id);
    if (b === undefined) hunks.push({ kind: 'payload', id, op: 'added', after: a });
    else if (a === undefined) hunks.push({ kind: 'payload', id, op: 'removed', before: b });
    else if (canonical(a) !== canonical(b) && !reads(`payload:${id}`)) hunks.push({ kind: 'payload', id, op: 'changed', before: b, after: a });
  }
  return hunks.sort((x, y) => (x.kind !== y.kind ? (x.kind < y.kind ? -1 : 1) : x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
}

export const hex = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

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
      const list = typeof key === 'string' ? refs.get(key) : undefined;
      if (list) list.push(type);
      else if (typeof key === 'string') refs.set(key, [type]);
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
