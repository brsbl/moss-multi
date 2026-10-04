// Suggestion records applied to a mirror (docs/design/suggestions.md §4): the accept gates that need only Yjs, the
// projection a reviewer is shown, and its hash. Shared by the client preview and the DocDO accept. The Lexical parts
// (the headless bind check, G7, and each block's exportJSON) are passed in by the caller, so this module stays
// Lexical-free.
import * as encoding from 'lib0/encoding';
import { digest } from 'lib0/hash/sha256';
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
  void mirror;
  void record;
  void options;
  throw new Error('applyRecord: not implemented');
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
const utf8 = new TextEncoder();

export function previewHash(hunks: readonly Hunk[]): string {
  return hex(digest(utf8.encode(canonical(hunks))));
}

/** G0: binds an accept to the exact ops and parts the reviewer previewed. */
export function recordDigest(record: SuggestionRecord): string {
  const parts = utf8.encode(canonical({ id: record.meta.id, parts: record.parts, clients: record.meta.clients }));
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
  visit(doc.get('root', Y.XmlText));
  return refs;
}

export { spansOf };
