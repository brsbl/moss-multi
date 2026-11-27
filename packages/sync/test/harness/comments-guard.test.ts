// T4.0 write isolation (docs/design/comments.md §3, I1-I2): a fast-check that every item in the comments subtree has
// client R whatever raw structs a client sends, and the pending purge. The deterministic guard fixtures and the
// history's tail-splice, fully-held, missing-right-origin and cycle fixtures run against the real DocDO in
// comments-docdo.test.ts ('T4.1 gate 2b in the DocDO').
import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { CLOSE } from '@moss-multi/protocol/sync';
import { CommentsHost } from '../../src/doc/comments-host.ts';
import { connect, counts, openDoc, start, syncFrame, wake } from './do-harness.ts';
import { forged, raw } from './raw-frames.ts';

/** A server doc in V1's shape with two comment records written by R. */
function server() {
  const doc = new Y.Doc();
  doc.transact(() => {
    const paragraph = new Y.XmlText();
    doc.get('root', Y.XmlText).insertEmbed(0, paragraph);
    paragraph.insertEmbed(0, new Y.Map());
    paragraph.insert(1, 'The quick brown fox');
    doc.getText('title').insert(0, 'Title');
  });
  const host = new CommentsHost(doc);
  host.writer.write((comments) => {
    comments.set('c:c1', { text: 'first' });
    comments.set('c:c2', { text: 'plain' });
  });
  const r = host.writer.client;
  const s = doc.clientID;
  return { doc, host, r, s };
}

describe('T4.0 reserved-writer guard: no client frame lands a write in comments @p:tech-3', () => {
  it('fast-check: whatever raw structs a client sends, every item in the comments subtree has client R', () => {
    const { doc: base, r, s } = server();
    const seed = Y.encodeStateAsUpdate(base);
    const clients = [777, 778, r, s];
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            client: fc.constantFrom(...clients),
            skip: fc.nat(2),
            origin: fc.option(fc.record({ client: fc.constantFrom(...clients), clock: fc.nat(12) }), { nil: undefined }),
            right: fc.option(fc.record({ client: fc.constantFrom(...clients), clock: fc.nat(12) }), { nil: undefined }),
            parent: fc.option(fc.oneof(fc.constantFrom('root', 'title', 'comments', 'frontmatter', 'evil'), fc.record({ client: fc.constantFrom(...clients), clock: fc.nat(12) })), { nil: undefined }),
            sub: fc.option(fc.constantFrom('c:c1', 'c:c2', 'k'), { nil: undefined }),
            kind: fc.constantFrom('string', 'any', 'map'),
          }),
          { minLength: 1, maxLength: 6 },
        ),
        fc.array(fc.tuple(fc.constantFrom(...clients), fc.nat(12), fc.integer({ min: 1, max: 3 })), { maxLength: 3 }),
        (specs, deletes) => {
          const doc = new Y.Doc();
          Y.applyUpdate(doc, seed);
          const host = new CommentsHost(doc, r);
          const next = new Map<number, number>();
          const structs = specs.map((spec) => {
            const clock = next.get(spec.client) ?? Y.getState(doc.store, spec.client) + spec.skip;
            const content = spec.kind === 'string' ? new Y.ContentString('x') : spec.kind === 'any' ? new Y.ContentAny(['x']) : new Y.ContentType(new Y.Map());
            next.set(spec.client, clock + content.getLength());
            const id = (ref: { client: number; clock: number } | undefined) => (ref ? Y.createID(ref.client, ref.clock) : undefined);
            const parent = typeof spec.parent === 'string' ? spec.parent : id(spec.parent);
            return forged(Y.createID(spec.client, clock), { origin: id(spec.origin), right: id(spec.right), parent, sub: spec.sub }, content);
          });
          // Structs of one client in clock order, as an encoder writes them.
          structs.sort((a, b) => a.id.client - b.id.client || a.id.clock - b.id.clock);
          try {
            host.receive(raw(structs, deletes));
          } catch {
            // Yjs may throw on a malformed frame; whatever it integrated must still satisfy I1.
          }
          doc.store.pendingStructs = null;
          doc.store.pendingDs = null;
          host.writer.write((comments) => comments.set('c:after', { text: 'server' }));
          const comments = doc.getMap('comments');
          for (const list of doc.store.clients.values()) {
            for (const struct of list) {
              if (!(struct instanceof Y.Item)) continue;
              let type = struct.parent as Y.AbstractType<unknown> | null;
              while (type && type._item && type._item.parent instanceof Y.AbstractType) type = type._item.parent as Y.AbstractType<unknown>;
              if (type === comments) expect(struct.id.client).toBe(r);
            }
          }
          doc.destroy();
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe('T4.0 pending purge: nothing parked integrates late or persists @p:tech-3', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('a frame with a missing dependency is closed 4420 before apply; a forced compaction and a restart leave nothing parked', async () => {
    const opened = await start(openDoc());
    const editor = await connect(opened, { role: 'editor' });
    await editor.hello();
    const other = await connect(opened, { role: 'editor' });
    await other.hello();
    const parks = raw([forged(Y.createID(777, 0), { parent: Y.createID(888, 0) }, new Y.ContentAny(['parked']))], [[999, 3, 1]]);
    await editor.deliver(syncFrame(2, parks));
    await editor.pump();
    // Transient (comments.md §3): an honest client resyncs; 4409 is kept for guard violations.
    expect(editor.closed?.code).toBe(CLOSE.writeRate);
    expect(editor.events.filter((event) => event.t === 'write-refused')).toEqual([]);
    expect(opened.dobj.document.store.pendingStructs).toBeNull();
    expect(opened.dobj.document.store.pendingDs).toBeNull();

    other.doc.getText('title').insert(0, 'kept');
    await other.flush();
    await opened.dobj.onSave();
    expect(counts(opened.backing).state, 'compaction ran').toBeGreaterThan(0);

    const woken = await start(wake(opened));
    const doc = woken.dobj.document;
    expect(doc.getText('title').toString()).toBe('kept');
    expect(doc.store.pendingStructs).toBeNull();
    expect(doc.store.pendingDs).toBeNull();
    const late = await connect(woken, { role: 'editor' });
    await late.hello();
    const release = raw([
      forged(Y.createID(888, 0), { parent: 'frontmatter', sub: 'held' }, new Y.ContentType(new Y.Map())),
      forged(Y.createID(999, 0), { parent: 'frontmatter', sub: 'deleted' }, new Y.ContentAny([1, 2, 3, 4])),
    ]);
    await late.deliver(syncFrame(2, release));
    await late.pump();
    expect(doc.store.clients.has(777), 'the parked struct never integrates').toBe(false);
    expect(doc.getMap('frontmatter').get('deleted'), 'the parked delete never applies').toBe(4);
  });
});
