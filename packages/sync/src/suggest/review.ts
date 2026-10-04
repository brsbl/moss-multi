// Preview, accept, reject and withdraw of a suggestion record (docs/design/suggestions.md §4), on the DocDO's live
// doc. Accept applies the record to a hydrated mirror, runs the gates, and lands the mirror's diff only when every
// gate passes; reject and withdraw write only the record.
import type { Binding } from '@lexical/yjs';
import { $getNodeByKey, $getRoot, $isElementNode, type LexicalNode } from 'lexical';
import * as Y from 'yjs';
import { STATE_CAP_BYTES } from '@moss-multi/protocol/limits';
import { roleAtLeast } from '@moss-multi/protocol/roles';
import {
  applyRecord, canonical, hydrate, itemKey, previewHash, projectDoc, projectionDiff, recordDigest, yValue, type GateReason, type Hunk,
  type Inserted, type Projection,
} from '@moss-multi/core/suggest/apply';
import { createConverterEditor } from '../converter/index.ts';
import { mirrorOf } from '../server-doc.ts';
import { closeRecord, patchMeta, readRecord, SUGGEST_ACCEPT, SUGGESTIONS_ORIGIN } from './records.ts';

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
 * created and its parent. Lexical refusing the tree (a throw) or normalizing it into something else (the body's
 * shared content changes) means a reader would not see what the reviewer was shown. Same-value writes back are not
 * changes.
 */
export function bindCheck(doc: Y.Doc, inserted: Inserted): boolean {
  let mirror: ReturnType<typeof mirrorOf> | null = null;
  try {
    mirror = mirrorOf(doc);
    const bound = mirror;
    const body = () => canonical([yValue(bound.doc.get('root', Y.XmlText)), yValue(bound.doc.getMap('registers'))]);
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

function serialize(node: LexicalNode): unknown {
  const json = node.exportJSON() as unknown as Record<string, unknown>;
  if ($isElementNode(node)) json.children = node.getChildren().map(serialize);
  return json;
}

/** Each top-level block's recursive exportJSON, by its Yjs item id; register-backed fields read through getters. */
export function lexicalBlocks(doc: Y.Doc): Map<string, unknown> {
  const mirror = mirrorOf(doc);
  try {
    const blocks = new Map<string, unknown>();
    mirror.editor.read(() => {
      for (const node of $getRoot().getChildren()) {
        const collab = mirror.binding.collabNodeMap.get(node.getKey());
        const item = collab && sharedOf(collab)._item;
        if (item) blocks.set(itemKey(item.id), serialize(node));
      }
    });
    return blocks;
  } finally {
    mirror.dispose();
  }
}

const project = (doc: Y.Doc): Projection => projectDoc(doc, lexicalBlocks(doc));

type Applied = { ok: true; mirror: Y.Doc; hydrated: Uint8Array; hunks: Hunk[] } | { ok: false; reason: GateReason | 'missing' };

/** The record applied to a fresh mirror of `live`, with the hunks a reviewer is shown. */
function apply(live: Y.Doc, id: string): Applied {
  const record = readRecord(live, id);
  if (!record) return { ok: false, reason: 'missing' };
  if (record.meta.status !== 'open') return { ok: false, reason: 'not-open' };
  const mirror = hydrate(live);
  const before = project(mirror);
  const result = applyRecord(mirror, record, { bindCheck });
  if (!result.ok) {
    mirror.destroy();
    return result;
  }
  return { ok: true, mirror, hydrated: result.hydrated, hunks: projectionDiff(before, project(mirror)) };
}

export function previewRecord(live: Y.Doc, id: string): Preview {
  const record = readRecord(live, id);
  const applied = apply(live, id);
  if (!applied.ok) return applied;
  applied.mirror.destroy();
  return { ok: true, hunks: applied.hunks, hash: previewHash(applied.hunks), digest: recordDigest(record!) };
}

/** Outdated and broken records are badged on the record, so every reader sees why accept refused. */
function badge(live: Y.Doc, id: string, reason: GateReason): void {
  if (reason !== 'outdated' && reason !== 'broken') return;
  live.transact(() => {
    patchMeta(live, id, reason === 'outdated' ? { outdated: ['outdated'] } : { broken: 'broken' });
  }, SUGGESTIONS_ORIGIN);
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
  const { mirror, hydrated, hunks } = applied;
  try {
    if (previewHash(hunks) !== input.previewHash) return { ok: false, status: 409, reason: 'changed' };
    if (Y.encodeStateAsUpdate(mirror).byteLength > (options.stateCap ?? STATE_CAP_BYTES)) return { ok: false, status: 409, reason: 'doc-cap' };
    Y.applyUpdate(live, Y.encodeStateAsUpdate(mirror, hydrated), SUGGEST_ACCEPT);
    closeRecord(live, id, { status: 'accepted', resolvedBy: reviewer.id, resolvedAt: options.now ?? Date.now() });
    return { ok: true };
  } finally {
    mirror.destroy();
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
