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
  | 'register-alias'
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
}

export interface SuggestionRecord {
  meta: RecordMeta;
  /** V1 updates exactly as the author's fork produced them. */
  ops: Uint8Array[];
  parts: DeletePart[];
}

/** The roots a record may change. */
export const BODY_ROOTS: ReadonlySet<string> = new Set(['root', 'registers']);

/** What the record inserted, per client: [from, to) clocks. */
export type Inserted = ReadonlyMap<number, readonly [number, number]>;

export interface ApplyOptions {
  /** G7: binds a headless editor to the doc after the record; false when Lexical cannot take the tree. */
  bindCheck?: (doc: Y.Doc, inserted: Inserted) => boolean;
}

export type ApplyResult = { ok: true; hydrated: Uint8Array; inserted: Inserted } | { ok: false; reason: GateReason };

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

/**
 * Applies every op and delete part of `record` to `mirror` in one transaction and runs G1–G5 and G7. On failure the
 * mirror is spoiled; callers hydrate a fresh one. Nothing here touches the live doc.
 */
export function applyRecord(mirror: Y.Doc, record: SuggestionRecord, options: ApplyOptions = {}): ApplyResult {
  const fail = (reason: GateReason): ApplyResult => ({ ok: false, reason });
  const clients = new Set(record.meta.clients);
  const store = mirror.store;
  const hydrated = Y.encodeStateVector(mirror);
  const before = Y.decodeStateVector(hydrated);
  const state = (client: number) => before.get(client) ?? 0;

  // Each authoring step (an op, or a delete part) removes its own run of items; the record's own deletes are the
  // union of its ops' delete sets.
  const groups: IdSpan[][] = [];
  const ownDeletes: IdSpan[] = [];
  for (const op of record.ops) {
    let spans: IdSpan[];
    try {
      spans = spansOf(Y.decodeUpdate(op).ds);
    } catch {
      return fail('unresolvable');
    }
    groups.push(spans);
    ownDeletes.push(...spans);
  }
  for (const part of record.parts) {
    if (!Array.isArray(part.targets) || !part.targets.every(validSpan)) return fail('unresolvable');
    groups.push(part.targets);
  }

  // G5 (a) and (b) read the doc as it was before the record, so they run first and report after G1–G4.
  const outdated = !groups.every((spans) => removesLiveRun(store, spans, state));
  const registersBefore = liveEntries(mirror.getMap('registers'));
  const refsBefore = regRefs(mirror);

  let transaction: Y.Transaction | null = null;
  try {
    mirror.transact((tr) => {
      transaction = tr;
      for (const op of record.ops) Y.applyUpdate(mirror, op);
      for (const part of record.parts) Y.applyUpdate(mirror, deleteUpdate(part.targets));
    }, APPLY);
  } catch {
    return fail('unresolvable');
  }
  const tr = transaction as Y.Transaction | null;
  if (!tr) return fail('unresolvable');

  // G1: nothing parked.
  if (store.pendingStructs !== null || store.pendingDs !== null) return fail('unresolvable');

  // G2: only the record's leased clients advanced.
  const after = Y.decodeStateVector(Y.encodeStateVector(mirror));
  const inserted = new Map<number, readonly [number, number]>();
  for (const [client, clock] of after) {
    if (clock <= state(client)) continue;
    if (!clients.has(client)) return fail('foreign-client');
    inserted.set(client, [state(client), clock]);
  }

  // G3: every changed type, including each deleted item's parent, lives under root or registers.
  for (const type of tr.changed.keys()) {
    const name = rootName(mirror, type as unknown as Y.AbstractType<unknown>);
    if (name === null || !BODY_ROOTS.has(name)) return fail('outside-body');
  }

  // G4: registers are never aliased.
  if (!registersUnaliased(mirror, registersBefore, refsBefore, inserted)) return fail('register-alias');

  // G5 (c): every struct the record inserted and did not itself delete integrated as a live item.
  if (outdated || !insertedLive(store, inserted, ownDeletes)) return fail('outdated');

  // G7: Lexical can bind the result.
  if (options.bindCheck && !options.bindCheck(mirror, inserted)) return fail('broken');

  return { ok: true, hydrated, inserted };
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

function rootName(doc: Y.Doc, type: Y.AbstractType<unknown>): string | null {
  let top = type;
  while (top._item !== null) {
    const parent = top._item.parent;
    if (!(parent instanceof Y.AbstractType)) return null;
    top = parent;
  }
  for (const [name, shared] of doc.share) if (shared === top) return name;
  return null;
}

function liveEntries(map: Y.Map<unknown>): Map<string, Y.Item> {
  const entries = new Map<string, Y.Item>();
  for (const [key, item] of map._map) if (!item.deleted) entries.set(key, item);
  return entries;
}

const isInserted = (inserted: Inserted, id: Y.ID): boolean => {
  const range = inserted.get(id.client);
  return !!range && range[0] <= id.clock && id.clock < range[1];
};

/**
 * G4. A `__regId` written by the record sits on a type the record created. It names a registers entry the record
 * created, or moves an existing one: the record removed every type that named it, and the new type is the only one
 * naming it after (an Enter before an inline formula re-creates the decorator, since @lexical/yjs moves a node by
 * deleting it and inserting a copy). An entry that existed before is never replaced, and is deleted only once nothing
 * live names it. An entry the record created is named only by the record's own `__regId` writes. So no register is
 * ever shared, borrowed or re-pointed.
 */
function registersUnaliased(
  doc: Y.Doc,
  before: ReadonlyMap<string, Y.Item>,
  refsBefore: ReadonlyMap<string, Y.AbstractType<unknown>[]>,
  inserted: Inserted,
): boolean {
  const registers = doc.getMap('registers');
  const refs = regRefs(doc);
  for (const [key, item] of before) {
    const now = registers._map.get(key);
    if (now !== item) return false;
    if (item.deleted && refs.has(key)) return false;
  }
  for (const [client, [from, to]] of inserted) {
    for (const struct of structsIn(doc.store, client, from, to)) {
      if (!(struct instanceof Y.Item) || struct.deleted || struct.parentSub !== '__regId') continue;
      const holder = struct.parent as Y.AbstractType<unknown>;
      if (!holder._item || !isInserted(inserted, holder._item.id)) return false;
      const key = struct.content.getContent().at(-1);
      const entry = typeof key === 'string' ? registers._map.get(key) : undefined;
      if (!entry || entry.deleted || typeof key !== 'string') return false;
      if (isInserted(inserted, entry.id)) continue;
      const namedBefore = refsBefore.get(key) ?? [];
      const moved = namedBefore.length > 0 && namedBefore.every((type) => type._item?.deleted) && refs.get(key)?.length === 1;
      if (!moved) return false;
    }
  }
  for (const [key, item] of registers._map) {
    if (item.deleted || !isInserted(inserted, item.id)) continue;
    for (const type of refs.get(key) ?? []) {
      const named = type._map.get('__regId');
      if (!named || !isInserted(inserted, named.id)) return false;
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

/** A shared value as plain data, recursively: every attribute, character, format and nested type. */
export function yValue(value: unknown): unknown {
  if (value instanceof Y.XmlText) {
    return { t: 'xmltext', attrs: attrsOf(value), delta: deltaOf(value) };
  }
  if (value instanceof Y.XmlElement) {
    return { t: 'xmlelement', name: value.nodeName, attrs: attrsOf(value), children: value.toArray().map(yValue) };
  }
  if (value instanceof Y.XmlFragment) return { t: 'xmlfragment', children: value.toArray().map(yValue) };
  if (value instanceof Y.Text) return { t: 'text', delta: deltaOf(value) };
  if (value instanceof Y.Map) {
    return { t: 'map', entries: [...value.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => [k, yValue(v)]) };
  }
  if (value instanceof Y.Array) return { t: 'array', items: value.toArray().map(yValue) };
  if (value instanceof Uint8Array) return { t: 'binary', bytes: Array.from(value) };
  if (Array.isArray(value)) return value.map(yValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, yValue(v)]));
  }
  return value ?? null;
}

function attrsOf(type: Y.XmlText | Y.XmlElement): [string, unknown][] {
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
  blocks: Map<string, unknown>;
  order: string[];
  registers: Map<string, unknown>;
}

/**
 * Projects `doc`. `lexical` gives each top-level block's recursive exportJSON by item id (the caller binds the
 * converter editor); the Yjs-level value is always included, so the hash covers every attribute either way.
 */
export function projectDoc(doc: Y.Doc, lexical?: ReadonlyMap<string, unknown>): Projection {
  const blocks = new Map<string, unknown>();
  const order: string[] = [];
  for (let item = doc.get('root', Y.XmlText)._start; item; item = item.right) {
    if (item.deleted) continue;
    const key = itemKey(item.id);
    const content = item.content.getContent();
    const y = content.length === 1 ? yValue(content[0]) : content.map(yValue);
    blocks.set(key, { y, lexical: lexical?.get(key) ?? null });
    order.push(key);
  }
  const registers = new Map<string, unknown>();
  for (const [key, value] of doc.getMap('registers').entries()) registers.set(key, yValue(value));
  return { blocks, order, registers };
}

export interface Hunk {
  kind: 'block' | 'register';
  id: string;
  op: 'added' | 'removed' | 'changed';
  before?: unknown;
  after?: unknown;
  /** For an added block: the block it follows (null at the start). Positions are relative, never absolute. */
  at?: string | null;
}

export function projectionDiff(before: Projection, after: Projection): Hunk[] {
  const hunks: Hunk[] = [];
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
  const registerIds = [...new Set([...before.registers.keys(), ...after.registers.keys()])];
  for (const id of registerIds) {
    const b = before.registers.get(id);
    const a = after.registers.get(id);
    if (b === undefined) hunks.push({ kind: 'register', id, op: 'added', after: a });
    else if (a === undefined) hunks.push({ kind: 'register', id, op: 'removed', before: b });
    else if (canonical(a) !== canonical(b)) hunks.push({ kind: 'register', id, op: 'changed', before: b, after: a });
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
  let size = parts.length;
  for (const op of record.ops) size += op.length + 4;
  const all = new Uint8Array(size);
  let at = 0;
  for (const op of record.ops) {
    new DataView(all.buffer).setUint32(at, op.length);
    all.set(op, at + 4);
    at += op.length + 4;
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
