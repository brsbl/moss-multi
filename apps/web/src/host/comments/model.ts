// One doc's comments as the client sees them (docs/design/comments.md §2, §6): the `c:` and `a:` records the DocDO
// writes under R, read from `Y.Map('comments')`, plus two local layers that never reach the doc:
// - the frame engine's overlay: the same pure §5.2 engine the DocDO runs, read-only, on every applied transaction,
//   so an anchor follows a bold or an Enter in the same frame instead of waiting for the server's re-mint;
// - pending comments, keyed by the id the composer proposed, shown until the server's record arrives.
import { AnchorEngine, type Anchor } from '@moss-multi/core/anchor-frame';
import { fromBase64 } from '@moss-multi/core/tree-anchor';
import * as Y from 'yjs';

export type CommentSource = 'user' | 'agent' | 'external';

/** The `c:<id>` record (A§13). */
export interface CommentRecord {
  author: string;
  text: string;
  createdAt: number;
  updatedAt: number;
  /** The DocDO's write order, which orders records within one second. */
  seq?: number;
  source: CommentSource;
  parentId?: string;
  resolvedAt?: number;
  resolvedBy?: CommentSource;
  reactions?: Record<string, string[]>;
}

const itemOf = (value: string): Y.ID | null => {
  try {
    return value ? Y.decodeRelativePosition(fromBase64(value)).item : null;
  } catch {
    return null;
  }
};

/** The live item a position names, or null when the doc lacks it or it is deleted. */
export function liveItem(doc: Y.Doc, value: string): Y.Item | null {
  const id = itemOf(value);
  if (!id || id.clock >= Y.getState(doc.store, id.client)) return null;
  const item = Y.getItem(doc.store, id);
  return item instanceof Y.Item && !item.deleted ? item : null;
}

const isLive = (doc: Y.Doc, anchor: Anchor) => liveItem(doc, anchor.start) !== null && liveItem(doc, anchor.end) !== null;

export class CommentsModel {
  readonly #records = new Map<string, CommentRecord>();
  readonly #anchors = new Map<string, Anchor>();
  readonly #pending = new Map<string, { record: CommentRecord; anchor?: Anchor }>();
  readonly #listeners = new Set<() => void>();
  readonly #engine: AnchorEngine;
  readonly #map: Y.Map<unknown>;
  #version = 0;

  constructor(readonly doc: Y.Doc) {
    this.#map = doc.getMap('comments');
    this.#engine = new AnchorEngine(doc);
    for (const [key, value] of this.#map) this.#take(key, value, true);
    this.#map.observe(this.#onMap);
    doc.on('afterTransaction', this.#onTransaction);
    doc.on('destroy', () => this.dispose());
  }

  dispose(): void {
    this.#map.unobserve(this.#onMap);
    this.doc.off('afterTransaction', this.#onTransaction);
  }

  /** Bumped on every change, so a reader can tell a stale snapshot. */
  get version(): number {
    return this.#version;
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Every comment, the server's and the pending ones. */
  records(): Map<string, CommentRecord> {
    const all = new Map(this.#records);
    for (const [id, { record }] of this.#pending) if (!all.has(id)) all.set(id, record);
    return all;
  }

  record(id: string): CommentRecord | undefined {
    return this.#records.get(id) ?? this.#pending.get(id)?.record;
  }

  /** The anchor a root paints from: the overlay over the server's record, or the pending one. */
  anchor(id: string): Anchor | undefined {
    return this.#anchors.get(id) ?? this.#pending.get(id)?.anchor;
  }

  /** Roots that have an anchor record, anchored or detached. */
  anchoredRoots(): string[] {
    const ids = new Set(this.#anchors.keys());
    for (const [id, entry] of this.#pending) if (entry.anchor) ids.add(id);
    return [...ids];
  }

  addPending(id: string, record: CommentRecord, anchor?: Anchor): void {
    this.#pending.set(id, { record, ...(anchor ? { anchor } : {}) });
    this.#changed();
  }

  dropPending(id: string): void {
    if (this.#pending.delete(id)) this.#changed();
  }

  #take(key: string, value: unknown, loading = false): void {
    const id = key.slice(2);
    if (key.startsWith('c:')) {
      if (value && typeof value === 'object') {
        this.#records.set(id, value as CommentRecord);
        this.#pending.delete(id);
      } else {
        this.#records.delete(id);
      }
      return;
    }
    if (!key.startsWith('a:')) return;
    if (!value || typeof value !== 'object') {
      this.#anchors.delete(id);
      this.#engine.set(id, undefined);
      return;
    }
    const anchor = value as Anchor;
    const shown = this.#anchors.get(id);
    // A record for an older frame can arrive after this tab applied a newer one that moved the anchor again; the
    // overlay already holds the newer place, and the server's record for that frame follows.
    if (!loading && anchor.status === 'anchored' && !isLive(this.doc, anchor) && shown?.status === 'anchored' && isLive(this.doc, shown)) return;
    this.#anchors.set(id, anchor);
    this.#engine.set(id, anchor);
  }

  readonly #onMap = (event: Y.YMapEvent<unknown>): void => {
    for (const key of event.keysChanged) this.#take(key, this.#map.get(key));
    this.#changed();
  };

  readonly #onTransaction = (txn: Y.Transaction): void => {
    // The first sync builds the whole doc in one transaction; there is nothing to follow yet.
    if (txn.beforeState.size === 0 || this.#anchors.size === 0) return;
    let changes: Map<string, Anchor>;
    try {
      changes = this.#engine.frame(txn);
    } catch {
      // The server's record still arrives; the overlay only saves a frame.
      return;
    }
    if (changes.size === 0) return;
    for (const [id, anchor] of changes) {
      this.#anchors.set(id, anchor);
      this.#engine.set(id, anchor);
    }
    this.#changed();
  };

  #changed(): void {
    this.#version += 1;
    for (const listener of this.#listeners) listener();
  }
}

const models = new WeakMap<Y.Doc, CommentsModel>();

/** The one model of a doc in this tab, shared by every pane and painter of it. */
export function modelFor(doc: Y.Doc): CommentsModel {
  let model = models.get(doc);
  if (!model) {
    model = new CommentsModel(doc);
    models.set(doc, model);
  }
  return model;
}
