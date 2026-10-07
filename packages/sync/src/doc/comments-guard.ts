// Write isolation for Y.Map('comments') (docs/design/comments.md §3). Only the DocDO writes the map, always under a
// reserved Yjs client id R, through writeComments. A client frame is refused before it applies if it carries an R
// struct, names R as an origin, right origin or parent, uses a string parent outside CLIENT_ROOTS, or deletes a live
// R item. A non-R item can then never land in `comments` (I1, proved from Yjs's integrate in comments.md §2), and
// nothing here walks references, so the check costs O(frame · log).
import * as Y from 'yjs';

/** The roots a client frame may name as a string parent. */
export const CLIENT_ROOTS: ReadonlySet<string> = new Set(['root', 'title', 'frontmatter', 'frontmatterOrder', 'registers']);

/** The origin of every comments write; the anchor engine and the client UndoManagers skip it. */
export const COMMENT_ORIGIN = 'server-comments';

/** Origins the anchor engine never reads: replay from storage, the seed, and comments writes themselves. */
export const ENGINE_SKIPPED_ORIGINS: ReadonlySet<unknown> = new Set(['persistence', 'server-seed', COMMENT_ORIGIN]);

export type GuardRefusal = 'r-struct' | 'r-reference' | 'protected-root' | 'r-delete';

/** A fresh client id for R: not the doc's own, and not one any struct already uses. */
export function newCommentsClient(doc: Y.Doc): number {
  for (;;) {
    const id = Math.floor(Math.random() * 0xffffffff);
    if (id !== doc.clientID && !doc.store.clients.has(id)) return id;
  }
}

type Decoded = ReturnType<typeof Y.decodeUpdate>;

export class CommentsWriter {
  /** Clocks of R's live items, ascending, so check (d) is a binary search. */
  #live: number[] = [];

  constructor(
    readonly doc: Y.Doc,
    readonly client: number,
  ) {
    if (doc.clientID === client) throw new Error('the doc writes as R');
    for (const struct of doc.store.clients.get(client) ?? []) {
      if (struct instanceof Y.Item && !struct.deleted) for (let i = 0; i < struct.length; i += 1) this.#live.push(struct.id.clock + i);
    }
  }

  /**
   * The only code that touches `comments`. Never call it from an observer or afterTransaction: it runs after the
   * frame's applyUpdate returns, in the same synchronous turn.
   */
  write(fn: (comments: Y.Map<unknown>) => void): void {
    const own = this.doc.clientID;
    const before = Y.getState(this.doc.store, this.client);
    let deleted: Y.Transaction['deleteSet'] | null = null;
    const capture = (txn: Y.Transaction) => {
      if (txn.origin === COMMENT_ORIGIN) deleted = txn.deleteSet;
    };
    this.doc.on('afterTransaction', capture);
    this.doc.clientID = this.client;
    try {
      this.doc.transact(() => fn(this.doc.getMap('comments')), COMMENT_ORIGIN);
    } finally {
      this.doc.clientID = own;
      this.doc.off('afterTransaction', capture);
    }
    const after = Y.getState(this.doc.store, this.client);
    for (let clock = before; clock < after; clock += 1) this.#live.push(clock);
    const ranges = (deleted as Y.Transaction['deleteSet'] | null)?.clients.get(this.client) ?? [];
    if (ranges.length) {
      const gone = new Set<number>();
      for (const { clock, len } of ranges) for (let i = 0; i < len; i += 1) gone.add(clock + i);
      this.#live = this.#live.filter((clock) => !gone.has(clock));
    }
  }

  /** Gate 2b: null admits the frame. */
  check(update: Uint8Array): GuardRefusal | null {
    return this.checkDecoded(Y.decodeUpdate(update));
  }

  checkDecoded({ structs, ds }: Decoded): GuardRefusal | null {
    const r = this.client;
    for (const struct of structs) {
      if (struct.id.client === r) return 'r-struct';
      if (!(struct instanceof Y.Item)) continue;
      if (struct.origin?.client === r || struct.rightOrigin?.client === r) return 'r-reference';
      const parent = struct.parent as unknown;
      if (parent instanceof Y.ID && parent.client === r) return 'r-reference';
      if (typeof parent === 'string' && !CLIENT_ROOTS.has(parent)) return 'protected-root';
    }
    for (const { clock, len } of ds.clients.get(r) ?? []) if (this.#coversLive(clock, clock + len)) return 'r-delete';
    return null;
  }

  #coversLive(from: number, to: number): boolean {
    let lo = 0;
    let hi = this.#live.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.#live[mid] < from) lo = mid + 1;
      else hi = mid;
    }
    return lo < this.#live.length && this.#live[lo] < to;
  }
}
