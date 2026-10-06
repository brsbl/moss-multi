// Preview, accept, reject and withdraw of a suggestion record (docs/design/suggestions.md §4), on the DocDO's live
// doc and its payload docs. Accept applies the record to hydrated mirrors of the body and of each payload its ops
// write, runs the gates, and lands the mirrors' diffs only when every gate passes; reject and withdraw write only the
// record.
import type { Binding } from '@lexical/yjs';
import { $getNodeByKey } from 'lexical';
import * as Y from 'yjs';
import { STATE_CAP_BYTES } from '@moss-multi/protocol/limits';
import { roleAtLeast } from '@moss-multi/protocol/roles';
import {
  applyRecord, canonical, hydrate, itemKey, previewHash, projectDoc, projectionDiff, recordDigest, ROOT_KINDS, yValue, type GateReason, type Hunk, type IdSpan,
  type Inserted, type PayloadMirrors, type Projection, type SuggestionRecord,
} from '@moss-multi/core/suggest/apply';
import { createConverterEditor } from '../converter/index.ts';
import { attachPayloadSource, exportDocMarkdown, mirrorOf, payloadSourceOf } from '../server-doc.ts';
import { closeRecord, patchMeta, readMeta, readRecord, recordIds, SUGGEST_ACCEPT, writeSuggestions } from './records.ts';

export interface Reviewer {
  id: string;
  role: string;
}

export type Preview = { ok: true; hunks: Hunk[]; hash: string; digest: string } | { ok: false; reason: GateReason | 'missing' };

export type ReviewResult = { ok: true } | { ok: false; status: 403 | 404 | 409; reason: GateReason | 'role' | 'missing' };

export interface AcceptInput {
  previewHash: string;
  digest: string;
}

type CollabNode = Binding['collabNodeMap'] extends Map<string, infer V> ? V : never;

const sharedOf = (node: CollabNode): Y.AbstractType<unknown> => {
  const collab = node as unknown as { _xmlText?: Y.XmlText; _xmlElem?: Y.XmlElement; _map?: Y.Map<unknown> };
  return (collab._xmlText ?? collab._xmlElem ?? collab._map) as Y.AbstractType<unknown>;
};

const inRange = (inserted: Inserted, id: Y.ID) => {
  const range = inserted.get(id.client);
  return !!range && range[0] <= id.clock && id.clock < range[1];
};

/**
 * G7: binds moss's converter editor to a copy of `doc`, then reruns the node transforms on every node the record
 * created and its parent. Lexical refusing the tree (a throw), repairing it as it binds, or
 * normalizing it into something else (the body's shared content changes) means a reader would not see what the
 * reviewer was shown. Same-value writes back are not changes.
 */
export function bindCheck(doc: Y.Doc, inserted: Inserted, deleted: readonly IdSpan[] = []): boolean {
  let mirror: ReturnType<typeof mirrorOf> | null = null;
  try {
    // The baseline is read before hydration: each block the record wrote into or deleted from, and the root's own
    // keys and sequence when the record touched them, so a block the binding repairs while it hydrates (a legacy
    // decorator shape, a string whose text node's properties went) reads as changed.
    const touched = touchedBlocks(doc, inserted, deleted);
    const rootBefore = touched.root ? rootShape(doc) : null;
    mirror = mirrorOf(doc);
    const bound = mirror;
    for (const { id, value } of touched.blocks.values()) {
      const item = Y.getItem(bound.doc.store, id);
      if (!(item instanceof Y.Item) || item.deleted || !(item.content instanceof Y.ContentType) || canonical(yValue(item.content.type)) !== value) return false;
    }
    if (rootBefore !== null && rootShape(bound.doc) !== rootBefore) return false;
    // Hydration skips a node whose `__type` is gone, so it binds here; an editor already showing that node throws.
    const registered = bound.editor._nodes;
    const root = bound.doc.get('root', Y.XmlText);
    for (const { id } of touched.blocks.values()) {
      const item = Y.getItem(bound.doc.store, id) as Y.Item;
      if (!typedTree((item.content as Y.ContentType).type as Y.AbstractType<unknown>, registered)) return false;
    }
    for (let item = root._start; item; item = item.right) {
      if (!item.deleted && item.content instanceof Y.ContentType && inRange(inserted, item.id) && !typedTree(item.content.type as Y.AbstractType<unknown>, registered)) return false;
    }
    const body = () => canonical(yValue(bound.doc.get('root', Y.XmlText)));
    const before = body();
    bound.editor.update(
      () => {
        for (const [key, collab] of bound.binding.collabNodeMap) {
          const item = sharedOf(collab)._item;
          if (!item || !inRange(inserted, item.id)) continue;
          const node = $getNodeByKey(key);
          node?.markDirty();
          node?.getParent()?.markDirty();
        }
      },
      { discrete: true },
    );
    return body() === before;
  } catch {
    return false;
  } finally {
    mirror?.dispose();
  }
}

/** `type` and every live type in its sequence name a registered node in `__type`. */
function typedTree(type: Y.AbstractType<unknown>, registered: ReadonlyMap<string, unknown>): boolean {
  const named = type._map.get('__type');
  const name = named && !named.deleted ? named.content.getContent().at(-1) : undefined;
  if (typeof name !== 'string' || !registered.has(name)) return false;
  for (let item = type._start; item; item = item.right) {
    if (!item.deleted && item.content instanceof Y.ContentType && !typedTree(item.content.type as Y.AbstractType<unknown>, registered)) return false;
  }
  return true;
}

/** The root's own keys and live sequence: each block by its item id, each other item by its content. */
function rootShape(doc: Y.Doc): string {
  const root = doc.get('root', Y.XmlText);
  const seq: unknown[] = [];
  for (let item = root._start; item; item = item.right) {
    if (!item.deleted) seq.push(item.content instanceof Y.ContentType ? itemKey(item.id) : item.content.getContent());
  }
  const keys = [...root._map].filter(([, item]) => !item.deleted).map(([key, item]) => [key, item.content.getContent()]);
  return canonical({ keys, seq });
}

/**
 * Each live top-level block holding an item `inserted` or `deleted` names, with its value; `root` when one of those
 * items sits in the root itself or inside a block that is gone.
 */
function touchedBlocks(doc: Y.Doc, inserted: Inserted, deleted: readonly IdSpan[]): { blocks: Map<string, { id: Y.ID; value: string }>; root: boolean } {
  const root = doc.get('root', Y.XmlText);
  const seen = new Map<string, Y.Item>();
  let atRoot = false;
  const visit = (client: number, from: number, to: number) => {
    const structs = doc.store.clients.get(client) as (Y.Item | Y.GC)[] | undefined;
    if (!structs || from >= to || structs.length === 0) return;
    const last = structs[structs.length - 1];
    if (from >= last.id.clock + last.length) return;
    for (let i = Y.findIndexSS(structs as never, Math.max(from, structs[0].id.clock)); i < structs.length && structs[i].id.clock < to; i++) {
      if (!(structs[i] instanceof Y.Item)) continue;
      let item: Y.Item | null = structs[i] as Y.Item;
      if (item.parent === root) {
        atRoot = true;
        continue;
      }
      while (item && item.parent !== root) item = (item.parent as Y.AbstractType<unknown>)?._item ?? null;
      if (!item || item.deleted) atRoot = true;
      else if (item.content instanceof Y.ContentType) seen.set(itemKey(item.id), item);
    }
  };
  for (const [client, [from, to]] of inserted) visit(client, from, to);
  for (const span of deleted) visit(span.client, span.clock, span.clock + span.len);
  const blocks = new Map<string, { id: Y.ID; value: string }>();
  for (const [key, item] of seen) blocks.set(key, { id: item.id, value: canonical(yValue((item.content as Y.ContentType).type)) });
  return { blocks, root: atRoot };
}

/** Gc-free mirrors of `live`'s payloads, loaded on first use, which the body mirror's readers and the gates share. */
class Payloads implements PayloadMirrors {
  readonly docs = new Map<string, Y.Doc>();
  readonly #source: ReturnType<typeof payloadSourceOf>;

  constructor(live: Y.Doc) {
    this.#source = payloadSourceOf(live);
  }

  known(id: string): boolean {
    return this.#source.has(id);
  }

  /** The note's source, for what is stored beyond these mirrors. */
  get source(): ReturnType<typeof payloadSourceOf> {
    return this.#source;
  }

  doc(id: string): Y.Doc {
    let doc = this.docs.get(id);
    if (!doc) {
      doc = new Y.Doc({ gc: false, guid: id });
      // Typed before the state integrates, as the live payload doc is (see hydrate).
      for (const [name, kind] of ROOT_KINDS.payload) {
        if (kind === 'Text') doc.getText(name);
        else if (kind === 'Map') doc.getMap(name);
      }
      const state = this.#source.read(id);
      if (state) Y.applyUpdate(doc, state);
      this.docs.set(id, doc);
    }
    return doc;
  }

  destroy(): void {
    for (const doc of this.docs.values()) doc.destroy();
    this.docs.clear();
  }
}

/** A body mirror whose readers (the bind check, each block's exportJSON) resolve payloads from `payloads`. */
function mirrorWith(live: Y.Doc, payloads: Payloads): Y.Doc {
  const mirror = hydrate(live);
  attachPayloadSource(mirror, {
    read: (id) => (payloads.known(id) || payloads.docs.has(id) ? Y.encodeStateAsUpdate(payloads.doc(id)) : null),
    has: (id) => payloads.known(id) || payloads.docs.has(id),
    write: () => {
      throw new Error('a review mirror is read-only');
    },
    totalBytes: () => payloads.source.totalBytes(),
    bytesOf: (id) => payloads.source.bytesOf(id),
  });
  return mirror;
}

const project = (doc: Y.Doc, payloads: Payloads, also: Iterable<string>): Projection =>
  projectDoc(doc, (id) => payloads.doc(id), also);

type Applied =
  | { ok: true; mirror: Y.Doc; payloads: Payloads; hydrated: Uint8Array; touched: Map<string, Uint8Array>; hunks: Hunk[] }
  | { ok: false; reason: GateReason | 'missing' };

/** The record applied to fresh mirrors of `live` and its payloads, with the hunks a reviewer is shown. */
function apply(live: Y.Doc, id: string): Applied {
  const record = readRecord(live, id);
  if (!record) return { ok: false, reason: 'missing' };
  if (record.meta.status !== 'open') return { ok: false, reason: 'not-open' };
  const payloads = new Payloads(live);
  const mirror = mirrorWith(live, payloads);
  const before = project(mirror, payloads, []);
  const result = applyRecord(mirror, record, { bindCheck, payloads });
  if (!result.ok) {
    mirror.destroy();
    payloads.destroy();
    return result;
  }
  // Every payload the record writes is projected after it, named or not, so accept never lands a payload change the
  // preview did not show (I3). Before the record, G4 leaves only named payloads (already projected) and new ones.
  const hunks = projectionDiff(before, project(mirror, payloads, result.payloads.keys()));
  return { ok: true, mirror, payloads, hydrated: result.hydrated, touched: result.payloads, hunks };
}

export function previewRecord(live: Y.Doc, id: string): Preview {
  const record = readRecord(live, id);
  const applied = apply(live, id);
  if (!applied.ok) return applied;
  applied.mirror.destroy();
  applied.payloads.destroy();
  return { ok: true, hunks: applied.hunks, hash: previewHash(applied.hunks), digest: recordDigest(record!) };
}

/** Outdated and broken records are badged on the record, so every reader sees why accept refused. */
function badge(live: Y.Doc, id: string, reason: GateReason): void {
  if (reason !== 'outdated' && reason !== 'broken') return;
  const meta = readMeta(live, id);
  if (!meta || meta.status !== 'open' || (reason === 'outdated' ? meta.outdated?.length : meta.broken)) return;
  writeSuggestions(live, () => {
    patchMeta(live, id, reason === 'outdated' ? { outdated: ['outdated'] } : { broken: 'broken' });
  });
}

/**
 * One synchronous turn: G0, then G1–G5 and G7 on the mirror, G6 against the previewed hash and G8 against the state
 * cap. On any failure nothing reaches the live doc; on success the mirror's diff lands under `suggest-accept` and the
 * record closes.
 */
export function acceptRecord(live: Y.Doc, id: string, input: AcceptInput, reviewer: Reviewer, options: { stateCap?: number; now?: number } = {}): ReviewResult {
  if (!roleAtLeast(reviewer.role, 'editor')) return { ok: false, status: 403, reason: 'role' };
  const record = readRecord(live, id);
  if (!record) return { ok: false, status: 404, reason: 'missing' };
  if (record.meta.status !== 'open') return { ok: false, status: 409, reason: 'not-open' };
  if (recordDigest(record) !== input.digest) return { ok: false, status: 409, reason: 'changed' };
  const applied = apply(live, id);
  if (!applied.ok) {
    if (applied.reason !== 'missing') badge(live, id, applied.reason);
    return applied.reason === 'missing' ? { ok: false, status: 404, reason: 'missing' } : { ok: false, status: 409, reason: applied.reason };
  }
  const { mirror, payloads, hydrated, touched, hunks } = applied;
  try {
    if (previewHash(hunks) !== input.previewHash) return { ok: false, status: 409, reason: 'changed' };
    // G8 as A§10 and the DocDO count: the note plus every stored payload, withheld ones included, each payload the
    // record writes at its size after accept.
    const source = payloadSourceOf(live);
    let bytes = Y.encodeStateAsUpdate(mirror).byteLength + source.totalBytes();
    for (const payload of touched.keys()) bytes += Y.encodeStateAsUpdate(payloads.doc(payload)).byteLength - source.bytesOf(payload);
    if (bytes > (options.stateCap ?? STATE_CAP_BYTES)) return { ok: false, status: 409, reason: 'doc-cap' };
    // Payloads first, as serverWrite does, so the body's elements name payloads the note already holds.
    for (const [payload, sv] of touched) source.write(payload, Y.encodeStateAsUpdate(payloads.doc(payload), sv));
    Y.applyUpdate(live, Y.encodeStateAsUpdate(mirror, hydrated), SUGGEST_ACCEPT);
    closeRecord(live, id, { status: 'accepted', resolvedBy: reviewer.id, resolvedAt: options.now ?? Date.now() });
    return { ok: true };
  } finally {
    mirror.destroy();
    payloads.destroy();
  }
}

/** Status only: the body is never written (I4). */
export function rejectRecord(live: Y.Doc, id: string, reviewer: Reviewer, now = Date.now()): ReviewResult {
  if (!roleAtLeast(reviewer.role, 'editor')) return { ok: false, status: 403, reason: 'role' };
  const record = readRecord(live, id);
  if (!record) return { ok: false, status: 404, reason: 'missing' };
  if (record.meta.status !== 'open') return { ok: false, status: 409, reason: 'not-open' };
  closeRecord(live, id, { status: 'rejected', resolvedBy: reviewer.id, resolvedAt: now });
  return { ok: true };
}

/** The author, at any role from suggester up; status only (I4). */
export function withdrawRecord(live: Y.Doc, id: string, reviewer: Reviewer, now = Date.now()): ReviewResult {
  const record = readRecord(live, id);
  if (!record) return { ok: false, status: 404, reason: 'missing' };
  if (!roleAtLeast(reviewer.role, 'suggester') || record.meta.author !== reviewer.id) return { ok: false, status: 403, reason: 'role' };
  if (record.meta.status !== 'open') return { ok: false, status: 409, reason: 'not-open' };
  closeRecord(live, id, { status: 'withdrawn', resolvedBy: reviewer.id, resolvedAt: now });
  return { ok: true };
}

let registry: ReadonlySet<string> | null = null;
/** Registered node types of the converter editor, the ingest's `__type` registry. */
export function nodeRegistry(): ReadonlySet<string> {
  registry ??= new Set(createConverterEditor()._nodes.keys());
  return registry;
}

/** How long a record waits without an edit before an empty preview closes it: the author has moved on (§5 grouping). */
export const EMPTY_IDLE_MS = 30_000;

/**
 * The preview a reviewer is shown. An outdated or broken record is badged, so every reader sees why it cannot be
 * accepted; an idle record whose preview has no hunks (a split and its undo) is rejected by the system (§4.7).
 */
export function reviewPreview(live: Y.Doc, id: string, options: { now?: number } = {}): Preview & { closed?: boolean } {
  const preview = previewRecord(live, id);
  if (!preview.ok) {
    if (preview.reason !== 'missing') badge(live, id, preview.reason);
    return preview;
  }
  if (preview.hunks.length > 0) return preview;
  const meta = readMeta(live, id);
  const now = options.now ?? Date.now();
  if (!meta || meta.status !== 'open' || now - meta.updatedAt < EMPTY_IDLE_MS) return preview;
  closeRecord(live, id, { status: 'rejected', resolvedBy: 'system', resolvedAt: now });
  return { ...preview, closed: true };
}

/**
 * The working view (§4.7): the note with every valid open record applied, oldest first, through the same gates as
 * accept. A record that fails them is left out, and the records before it are reapplied to fresh mirrors.
 */
export function exportWorkingMarkdown(live: Y.Doc, noteId: string): string {
  const records = recordIds(live)
    .map((id) => readRecord(live, id))
    .filter((record): record is SuggestionRecord => record?.meta.status === 'open')
    .sort((a, b) => a.meta.createdAt - b.meta.createdAt || (a.meta.id < b.meta.id ? -1 : 1));
  let payloads = new Payloads(live);
  let mirror = mirrorWith(live, payloads);
  const applied: SuggestionRecord[] = [];
  try {
    for (const record of records) {
      if (applyRecord(mirror, record, { bindCheck, payloads }).ok) {
        applied.push(record);
        continue;
      }
      mirror.destroy();
      payloads.destroy();
      payloads = new Payloads(live);
      mirror = mirrorWith(live, payloads);
      for (const earlier of applied) applyRecord(mirror, earlier, { bindCheck, payloads });
    }
    return exportDocMarkdown(mirror, noteId);
  } finally {
    mirror.destroy();
    payloads.destroy();
  }
}
