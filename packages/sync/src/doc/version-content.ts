// What a version holds and how it comes back (A§14): the body as its markdown export and Lexical JSON, the title,
// the frontmatter, every payload the body names and the comments map; restore is a server write that keeps every
// unchanged block's Yjs identity and is refused unless its export equals the version's.
import { $getRoot, $isElementNode, $parseSerializedNode, type LexicalNode, type SerializedLexicalNode } from 'lexical';
import * as Y from 'yjs';
import type { Anchor } from '@moss-multi/core/anchor-frame';
import { idKey, ordinalsOf, unitText } from '@moss-multi/core/comment-units';
import { readField } from '@moss-multi/core/doc-fields';
import { importFrontmatter } from '@moss-multi/core/frontmatter';
import { diffText, SERVER_CELL_BUDGET } from '@moss-multi/core/text-diff';
import { decodeRelPos } from '@moss-multi/core/tree-anchor';
import { sameValue } from '../map-codecs.ts';
import { isPayloadType, payloadMap, payloadText } from '../payload-docs.ts';
import { registerPayloads } from '../registers.ts';
import { exportMirror, mirrorOf, payloadSourceOf, type Admit } from '../server-doc.ts';
import { writeTitle } from '../server-title.ts';

/** One payload's value: a text payload's text, or a compound payload's keys. */
export type PayloadValue = { text: string } | { map: Record<string, unknown> };

export interface VersionContent {
  title: string;
  frontmatter: string;
  markdown: string;
  /** The body as `{root}`: each node's JSON, payload nodes with their payload id. */
  lexical: string;
  /** Each payload the body names, by id, as JSON. */
  payloads: string;
  /** Y.Map('comments') as JSON. */
  comments: string;
  /** Each anchored comment's units in the body, as JSON AnchorSpans: what restore re-anchors a detached comment on. */
  anchors: string;
}

/** A comment's span in the body's text-mode units: first and last ordinal, its kind, and the units' text. */
export type AnchorSpans = Record<string, [first: number, last: number, kind: Anchor['kind'], text: string]>;

/** Where each anchored comment sits in `live`'s units, read in one walk. */
function anchorSpans(live: Y.Doc): AnchorSpans {
  const ends: [string, Anchor['kind'], Y.ID, Y.ID][] = [];
  for (const [key, value] of live.getMap<Anchor>('comments')) {
    if (!key.startsWith('a:') || value?.status !== 'anchored') continue;
    try {
      const start = decodeRelPos(value.start).item;
      const end = decodeRelPos(value.end).item;
      if (start && end) ends.push([key.slice(2), value.kind, start, end]);
    } catch {
      // A record whose positions do not decode is not restored.
    }
  }
  if (ends.length === 0) return {};
  const ordinals = ordinalsOf(live, ends.flatMap(([, , start, end]) => [start, end]));
  const text = unitText(live);
  const spans: AnchorSpans = {};
  for (const [id, kind, start, end] of ends) {
    const first = ordinals.get(idKey(start));
    const last = ordinals.get(idKey(end));
    if (first !== undefined && last !== undefined && first <= last) spans[id] = [first, last, kind, text.slice(first, last + 1)];
  }
  return spans;
}

/** Top-level blocks the reconcile aligns pairwise; past it, only the common prefix and suffix are kept. */
const ALIGN_CELL_BUDGET = 4_000_000;

/** A payload node's serialized fields that hold its payload's value, or a result derived from it. */
const PAYLOAD_FIELDS = new Set(['code', 'rawHtml', 'formula', 'config', 'grid', 'result', 'stale']);

type Serialized = SerializedLexicalNode & { __regId?: string; children?: Serialized[] };

/** A node as a version stores it: its JSON, each payload node with its payload id. */
function $serialize(node: LexicalNode): Serialized {
  const json = node.exportJSON() as Serialized;
  const id = (node as { __regId?: unknown }).__regId;
  if (isPayloadType(node.getType()) && typeof id === 'string' && id) json.__regId = id;
  if ($isElementNode(node)) json.children = node.getChildren().map($serialize);
  return json;
}

/** What two blocks are compared by: everything but their payloads' values, which restore diffs into the payload. */
const blockKey = (node: Serialized): string =>
  JSON.stringify(node, function strip(this: unknown, key: string, value: unknown) {
    const owner = this as { type?: unknown } | null;
    return typeof owner?.type === 'string' && isPayloadType(owner.type) && PAYLOAD_FIELDS.has(key) ? undefined : value;
  });

function payloadIds(node: Serialized, into: Set<string>): Set<string> {
  if (isPayloadType(node.type) && node.__regId) into.add(node.__regId);
  for (const child of node.children ?? []) payloadIds(child, into);
  return into;
}

/** The doc as a version holds it. Synchronous, so it is one consistent state. */
export function captureContent(live: Y.Doc, noteId: string): VersionContent {
  const mirror = mirrorOf(live);
  try {
    const root = mirror.editor.read(() => $serialize($getRoot()));
    const host = registerPayloads(mirror.editor);
    const payloads: Record<string, PayloadValue> = {};
    for (const id of payloadIds(root, new Set())) {
      const held = host?.hold(id);
      if (!held) continue;
      const map = payloadMap(held);
      payloads[id] = map.size ? { map: map.toJSON() } : { text: payloadText(held).toString() };
    }
    return {
      title: live.getText('title').toString(),
      frontmatter: readField(live, 'frontmatter'),
      lexical: JSON.stringify({ root }),
      payloads: JSON.stringify(payloads),
      comments: JSON.stringify(live.getMap('comments').toJSON()),
      anchors: JSON.stringify(anchorSpans(live)),
      markdown: exportMirror(mirror, noteId),
    };
  } finally {
    mirror.dispose();
  }
}

/**
 * Which of `current` each of `target` keeps, by equal block key: the common prefix and suffix, and the longest common
 * subsequence of the middle while it fits the budget. -1 for a block that is created from the version.
 */
function align(current: string[], target: string[]): number[] {
  const kept = new Array<number>(target.length).fill(-1);
  let start = 0;
  while (start < current.length && start < target.length && current[start] === target[start]) {
    kept[start] = start;
    start += 1;
  }
  let end = 0;
  while (end < current.length - start && end < target.length - start && current[current.length - 1 - end] === target[target.length - 1 - end]) {
    kept[target.length - 1 - end] = current.length - 1 - end;
    end += 1;
  }
  const a = current.length - start - end;
  const b = target.length - start - end;
  if (a === 0 || b === 0 || (a + 1) * (b + 1) > ALIGN_CELL_BUDGET) return kept;
  const table = new Uint32Array((a + 1) * (b + 1));
  const at = (i: number, j: number) => i * (b + 1) + j;
  for (let i = a - 1; i >= 0; i -= 1) {
    for (let j = b - 1; j >= 0; j -= 1) {
      table[at(i, j)] = current[start + i] === target[start + j] ? table[at(i + 1, j + 1)] + 1 : Math.max(table[at(i + 1, j)], table[at(i, j + 1)]);
    }
  }
  for (let i = 0, j = 0; i < a && j < b;) {
    if (current[start + i] === target[start + j]) {
      kept[start + j] = start + i;
      i += 1;
      j += 1;
    } else if (table[at(i + 1, j)] >= table[at(i, j + 1)]) i += 1;
    else j += 1;
  }
  return kept;
}

/** The body becomes `target`'s blocks: blocks equal to the version's stay as they are, the rest are removed or created. */
function $reconcileBlocks(target: Serialized[]): void {
  const root = $getRoot();
  const current = root.getChildren();
  const kept = align(current.map((node) => blockKey($serialize(node))), target.map(blockKey));
  const keep = new Set(kept.filter((index) => index >= 0));
  current.forEach((node, index) => {
    if (!keep.has(index)) node.remove();
  });
  let previous: LexicalNode | null = null;
  target.forEach((json, index) => {
    const reused = kept[index] >= 0;
    const node = reused ? current[kept[index]] : $parseSerializedNode(json);
    if (!reused) {
      if (previous) previous.insertAfter(node);
      else {
        const first = root.getFirstChild();
        if (first) first.insertBefore(node);
        else root.append(node);
      }
    }
    previous = node;
  });
}

function writePayload(doc: Y.Doc, value: PayloadValue): void {
  doc.transact(() => {
    if ('text' in value) {
      const text = payloadText(doc);
      const current = text.toString();
      if (current !== value.text) text.applyDelta(diffText(current, value.text, SERVER_CELL_BUDGET));
      return;
    }
    const map = payloadMap(doc);
    for (const [key, entry] of Object.entries(value.map)) if (!map.has(key) || !sameValue(map.get(key), entry)) map.set(key, entry);
    for (const key of [...map.keys()]) if (!Object.hasOwn(value.map, key)) map.delete(key);
  });
}

/**
 * Restores `target` as a server write under `origin`, on a hydrated mirror: the body keeps every block equal to the
 * version's and recreates the rest, each kept payload takes the version's value by minimal diff, and the title and
 * frontmatter take minimal diffs. The mirror's export must equal the version's markdown, else nothing is written and
 * this returns false. `admit` runs once the export is verified and throws to refuse the write: the state cap, or a
 * restore point that could not be stored.
 */
export function restoreContent(live: Y.Doc, origin: unknown, target: VersionContent, noteId: string, admit: Admit): boolean {
  const state = JSON.parse(target.lexical) as { root: Serialized };
  const payloads = JSON.parse(target.payloads) as Record<string, PayloadValue>;
  const mirror = mirrorOf(live);
  try {
    const hydrated = Y.encodeStateVector(mirror.doc);
    mirror.editor.update(() => $reconcileBlocks(state.root.children ?? []), { discrete: true });
    // A recreated payload block minted its own payload from its JSON.
    const host = registerPayloads(mirror.editor);
    const named = payloadIds(mirror.editor.read(() => $serialize($getRoot())), new Set());
    for (const [id, value] of Object.entries(payloads)) if (host && named.has(id)) writePayload(host.hold(id), value);
    writeTitle(mirror.doc, target.title, origin);
    importFrontmatter(mirror.doc, target.frontmatter, origin);
    const diff = Y.encodeStateAsUpdate(mirror.doc, hydrated);
    const written = mirror.written();
    if (exportMirror(mirror, noteId) !== target.markdown || mirror.doc.getText('title').toString() !== target.title) return false;
    admit(diff, written);
    const source = payloadSourceOf(live);
    for (const [id, update] of written) source.write(id, update);
    Y.applyUpdate(live, diff, origin);
    return true;
  } finally {
    mirror.dispose();
  }
}
