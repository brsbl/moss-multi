// The order the DocDO runs comments in around one client frame (docs/design/comments.md §2, §4): gate 2b, apply,
// the pending purge, then the anchor changes collected pre-GC, flushed through writeComments in the same turn.
// T4.1 and T4.2 move these steps into the DocDO; the spike tests drive this class directly.
import * as Y from 'yjs';
import { AnchorEngine, type Anchor } from '@moss-multi/core/anchor-frame';
import { COMMENT_ORIGIN, CommentsWriter, newCommentsClient, type GuardRefusal } from './comments-guard.ts';

/** Origins the engine never reads: replay from storage, the seed, and comments writes themselves. */
const SKIPPED: ReadonlySet<unknown> = new Set(['persistence', 'server-seed', COMMENT_ORIGIN]);
export const CLIENT_FRAME = 'client-frame';

export type FrameVerdict = { refused: GuardRefusal | 'unresolved' } | { refused: null; changed: string[] };

export class CommentsHost {
  readonly writer: CommentsWriter;
  readonly engine: AnchorEngine;
  #pending = new Map<string, Anchor>();

  constructor(
    readonly doc: Y.Doc,
    client = newCommentsClient(doc),
  ) {
    this.writer = new CommentsWriter(doc, client);
    this.engine = new AnchorEngine(doc);
    this.engine.load(this.records());
    doc.on('afterTransaction', (txn: Y.Transaction) => {
      if (SKIPPED.has(txn.origin)) return;
      for (const [id, anchor] of this.engine.frame(txn)) this.#pending.set(id, anchor);
    });
  }

  *records(): Generator<[string, Anchor]> {
    for (const [key, value] of this.doc.getMap<Anchor>('comments')) if (key.startsWith('a:')) yield [key.slice(2), value];
  }

  anchor(id: string): Anchor | undefined {
    return this.doc.getMap<Anchor>('comments').get(`a:${id}`);
  }

  /** One client sync frame. A refusal leaves nothing applied or parked; the DocDO answers it with 4409. */
  receive(update: Uint8Array, origin: unknown = CLIENT_FRAME): FrameVerdict {
    const refused = this.writer.check(update);
    if (refused) return { refused };
    let threw = false;
    try {
      Y.applyUpdate(this.doc, update, origin);
    } catch {
      // A malformed frame (a self-parented struct, say) can make Yjs throw mid-apply; it is refused like a parked one.
      threw = true;
    }
    const store = this.doc.store;
    const parked = threw || store.pendingStructs !== null || store.pendingDs !== null;
    store.pendingStructs = null;
    store.pendingDs = null;
    const changed = this.flush();
    return parked ? { refused: 'unresolved' } : { refused: null, changed };
  }

  /** Writes the anchor changes collected since the last flush. */
  flush(): string[] {
    const changes = [...this.#pending];
    this.#pending.clear();
    if (!changes.length) return [];
    this.writer.write((comments) => {
      for (const [id, anchor] of changes) comments.set(`a:${id}`, anchor);
    });
    for (const [id, anchor] of changes) this.engine.set(id, anchor);
    return changes.map(([id]) => id);
  }

  create(id: string, anchor: Anchor): void {
    this.writer.write((comments) => comments.set(`a:${id}`, anchor));
    this.engine.set(id, anchor);
  }
}
