// What a version holds and how it comes back (A§14): the body as its markdown export and Lexical JSON, the title,
// the frontmatter, every payload the body names and the comments map; restore is a server write through T6.1's
// reconcile that keeps the Yjs identity of what is unchanged and is refused unless its export equals the version's.
import { $getRoot, $isElementNode, type LexicalNode, type SerializedEditorState, type SerializedLexicalNode } from 'lexical';
import * as Y from 'yjs';
import type { Anchor } from '@moss-multi/core/anchor-frame';
import { idKey, ordinalsOf, unitText } from '@moss-multi/core/comment-units';
import { readField } from '@moss-multi/core/doc-fields';
import { importFrontmatter } from '@moss-multi/core/frontmatter';
import { decodeRelPos } from '@moss-multi/core/tree-anchor';
import { isPayloadType, payloadMap, payloadText } from '../payload-docs.ts';
import { reconcileBody, ReconcileRefused } from '../reconcile.ts';
import { registerPayloads } from '../registers.ts';
import { keepsInserts, namedPayloads, shownAfter, StaleBase, stateAt, type DecodedBase } from '../restore-base.ts';
import { exportMirror, mirrorOf, payloadSourceOf, type Admit, type MirrorBase } from '../server-doc.ts';
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

type Serialized = SerializedLexicalNode & { __regId?: string; children?: Serialized[] };

/** A node as a version stores it: its JSON, each payload node with its payload id. */
function $serialize(node: LexicalNode): Serialized {
  const json = node.exportJSON() as Serialized;
  const id = (node as { __regId?: unknown }).__regId;
  if (isPayloadType(node.getType()) && typeof id === 'string' && id) json.__regId = id;
  if ($isElementNode(node)) json.children = node.getChildren().map($serialize);
  return json;
}

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
 * Restores `target` as one server write under `origin` through the identity-preserving reconcile (A§14, T6.1), run
 * from `base`, the state the restorer saw: the body and each payload keep the Yjs items of everything the version
 * shares with that state, the title and frontmatter take minimal diffs, and whatever anyone inserted after the base
 * merges in where it was typed. Throws ReconcileRefused (409) when the reconciled base would not export as the
 * version's body, the title would differ, or the result would lose an insert made after the base, with nothing
 * written; StaleBase when the base is not a state of the doc. `admit` runs once that is verified, before anything is
 * written, and throws to refuse: the state cap, or a restore point that could not be stored.
 */
export function restoreContent(live: Y.Doc, origin: unknown, target: VersionContent, admit: Admit, base: DecodedBase): boolean {
  // A version names each payload node's payload id, which the reconcile pairs by type instead.
  const state = JSON.parse(target.lexical, (key, value: unknown) => (key === '__regId' ? undefined : value)) as SerializedEditorState;
  const source = payloadSourceOf(live);
  const note = Y.encodeStateAsUpdate(live);
  const from: MirrorBase = {
    state: stateAt(note, base.note),
    payload: (id) => {
      const now = source.read(id);
      const sv = base.payloads.get(id);
      if (now && !sv) throw new StaleBase('the base leaves out a payload');
      return now && sv ? stateAt(now, sv) : now;
    },
  };
  // Every payload the note named at the base needs its base: without it, what was typed in it since is unknown.
  for (const id of namedPayloads(from.state)) if (!base.payloads.has(id) && source.read(id)) throw new StaleBase('the base leaves out a payload');
  const keeping: Admit = (diff, payloads) => {
    if (!keepsInserts(note, diff, base.note, false)) throw new ReconcileRefused('mismatch', 'the restore would remove what was inserted after its base');
    const written = new Map(payloads);
    let named: Set<string> | null = null;
    for (const [id, sv] of base.payloads) {
      const now = source.read(id);
      if (!now) continue;
      const update = written.get(id);
      if (update && !keepsInserts(now, update, sv, true)) throw new ReconcileRefused('mismatch', 'the restore would remove what was inserted after its base');
      // A payload typed in since the base must stay named, or the restore would take the block, and the typing, away.
      if (!shownAfter(now, sv)) continue;
      if (!named) {
        const merged = new Y.Doc();
        Y.applyUpdate(merged, note);
        Y.applyUpdate(merged, diff);
        named = namedPayloads(Y.encodeStateAsUpdate(merged));
        merged.destroy();
      }
      if (!named.has(id)) throw new ReconcileRefused('mismatch', 'the restore would remove a block typed in after its base');
    }
    admit(diff, payloads);
  };
  return reconcileBody(live, state, origin, keeping, {
    mutate(doc) {
      writeTitle(doc, target.title, origin);
      importFrontmatter(doc, target.frontmatter, origin);
    },
    verify(mirror) {
      if (mirror.doc.getText('title').toString() !== target.title) throw new ReconcileRefused('mismatch', 'the restored title differs from the version');
    },
  }, from);
}
