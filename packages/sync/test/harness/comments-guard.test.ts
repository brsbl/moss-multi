// T4.0 write isolation (docs/design/comments.md §2, I1-I2): raw client frames against the reserved-writer guard,
// the pending purge, and a fast-check that every item in the comments subtree has client R. The history's
// tail-splice, fully-held, missing-right-origin and cycle fixtures are re-pointed here.
import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { CLOSE } from '@moss-multi/protocol/sync';
import { CommentsHost } from '../../src/doc/comments-host.ts';
import { connect, counts, openDoc, start, syncFrame, wake } from './do-harness.ts';
import { forged, gcStruct, raw, skipStruct } from './raw-frames.ts';

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

const copyOf = (doc: Y.Doc) => {
  const copy = new Y.Doc();
  Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc));
  return copy;
};
const diff = (from: Y.Doc, to: Y.Doc) => Y.encodeStateAsUpdate(from, Y.encodeStateVector(to));
const rootStart = (doc: Y.Doc) => doc.get('root', Y.XmlText)._start!.id;
const recordItem = (doc: Y.Doc, key: string) => doc.getMap('comments')._map.get(key)!;
const json = (doc: Y.Doc) => doc.getMap('comments').toJSON();

/**
 * The frame is refused (or, for a frame the guard admits but Yjs would park, purged as `unresolved`), and the
 * comments map is unchanged after it, after the server's next write, and after a frame that releases its dependency.
 */
function expectIsolated(host: CommentsHost, frame: Uint8Array, refusal: string, release?: Uint8Array): void {
  const doc = host.doc;
  const before = json(doc);
  expect(host.receive(frame).refused).toBe(refusal);
  expect(doc.store.pendingStructs).toBeNull();
  expect(doc.store.pendingDs).toBeNull();
  expect(json(doc)).toEqual(before);
  host.writer.write((comments) => comments.set('c:next', { text: 'server' }));
  const written = { ...before, 'c:next': { text: 'server' } };
  expect(json(doc)).toEqual(written);
  if (release) {
    host.receive(release);
    expect(json(doc)).toEqual(written);
  }
}

describe('T4.0 reserved-writer guard: no client frame lands a write in comments @p:tech-3', () => {
  it('refuses any struct of client R: an Item, a GC and a Skip', () => {
    const { doc, host, r } = server();
    const forger = copyOf(doc);
    forger.clientID = r;
    forger.getText('title').insert(0, 'x');
    expectIsolated(host, diff(forger, doc), 'r-struct');
    const next = Y.getState(doc.store, r);
    expectIsolated(host, raw([gcStruct(Y.createID(r, next + 1))]), 'r-struct');
    expectIsolated(host, raw([skipStruct(Y.createID(r, next + 1))]), 'r-struct');
  });

  it('refuses an item that names R as its origin, right origin or parent', () => {
    const { doc, host } = server();
    const held = recordItem(doc, 'c:c2').id;
    expectIsolated(host, raw([forged(Y.createID(777, 0), { origin: held }, new Y.ContentAny(['x']))]), 'r-reference');
    expectIsolated(host, raw([forged(Y.createID(777, 0), { origin: rootStart(doc), right: held }, new Y.ContentString('x'))]), 'r-reference');
    expectIsolated(host, raw([forged(Y.createID(777, 0), { parent: held, sub: 'k' }, new Y.ContentAny(['x']))]), 'r-reference');
  });

  it('refuses a comments or unknown string parent, including an honest-looking map write', () => {
    const { doc, host } = server();
    expectIsolated(host, raw([forged(Y.createID(777, 0), { parent: 'comments', sub: 'c:forged' }, new Y.ContentAny([{ text: 'mine' }]))]), 'protected-root');
    expectIsolated(host, raw([forged(Y.createID(777, 0), { parent: 'evil', sub: 'k' }, new Y.ContentAny([1]))]), 'protected-root');
    const writer = copyOf(doc);
    writer.getMap('comments').set('c:forged', { text: 'mine' });
    expectIsolated(host, diff(writer, doc), 'protected-root');
    const overwrite = copyOf(doc);
    overwrite.getMap('comments').set('c:c1', { text: 'replaced' });
    expectIsolated(host, diff(overwrite, doc), 'r-reference');
  });

  it('refuses deleting a live R item', () => {
    const { doc, host } = server();
    const eraser = copyOf(doc);
    eraser.getMap('comments').delete('c:c2');
    expectIsolated(host, diff(eraser, doc), 'r-delete');
  });

  it("admits an honest step 2 whose delete set names R's deleted items", () => {
    const { doc, host } = server();
    host.writer.write((comments) => comments.set('c:c1', { text: 'edited' }));
    const client = copyOf(doc);
    (client.get('root', Y.XmlText).toDelta()[0].insert as Y.XmlText).insert(5, 'very ');
    const step2 = diff(client, doc);
    expect(Y.decodeUpdate(step2).ds.clients.has(host.writer.client), 'the step 2 carries R tombstones').toBe(true);
    expect(host.receive(step2).refused).toBeNull();
    expect(doc.get('root', Y.XmlText).toString()).toContain('very');
  });

  it("history fixtures: tail splices at R's and the DocDO's latest clocks", () => {
    const { doc, host, r, s } = server();
    const rState = Y.getState(doc.store, r);
    expectIsolated(host, raw([forged(Y.createID(r, rState - 1), { origin: rootStart(doc) }, new Y.ContentAny([{ text: 'plain' }, { text: 'FORGED' }]))]), 'r-struct');
    // The DocDO's own latest write is the title, never a comment: the tail lands beside it, outside comments.
    const sState = Y.getState(doc.store, s);
    const before = json(doc);
    const splice = raw([forged(Y.createID(s, sState - 1), { parent: 'frontmatter', sub: 'k' }, new Y.ContentAny(['e', 'x']))]);
    expect(host.writer.check(splice), 'no R involved: the guard admits it').toBeNull();
    try {
      host.receive(splice);
    } catch {
      // Yjs may reject the splice outright; either way nothing reaches comments.
    }
    expect(json(doc)).toEqual(before);
  });

  it('history fixtures: a fully held struct with a forged missing origin parks the tail and is purged', () => {
    const { doc, host, s } = server();
    const sState = Y.getState(doc.store, s);
    const frame = raw([
      forged(Y.createID(s, sState - 1), { origin: Y.createID(5150, 0) }, new Y.ContentString('e')),
      forged(Y.createID(s, sState), { origin: rootStart(doc) }, new Y.ContentAny(['tail'])),
    ]);
    const release = raw([forged(Y.createID(5150, 0), { parent: 'frontmatter', sub: 'z' }, new Y.ContentAny(['z']))]);
    expectIsolated(host, frame, 'unresolved', release);
    expect(doc.store.clients.get(s)?.some((struct) => struct.id.clock >= sState && struct instanceof Y.Item && struct.content instanceof Y.ContentAny)).toBe(false);
  });

  it('history fixtures: a missing right origin beside a held left origin', () => {
    const { doc, host, r } = server();
    expectIsolated(host, raw([forged(Y.createID(777, 0), { origin: rootStart(doc), right: Y.createID(r, Y.getState(doc.store, r)) }, new Y.ContentString('x'))]), 'r-reference');
    const release = raw([forged(Y.createID(6160, 0), { parent: 'frontmatter', sub: 'y' }, new Y.ContentAny(['y']))]);
    expectIsolated(host, raw([forged(Y.createID(778, 0), { origin: rootStart(doc), right: Y.createID(6160, 0) }, new Y.ContentString('x'))]), 'unresolved', release);
  });

  it('history fixtures: parent cycles and right origins that name each other are purged', () => {
    const { doc, host } = server();
    expectIsolated(host, raw([forged(Y.createID(777, 0), { parent: Y.createID(777, 0) }, new Y.ContentType(new Y.Map()))]), 'unresolved');
    expectIsolated(host, raw([
      forged(Y.createID(778, 0), { parent: Y.createID(778, 1) }, new Y.ContentType(new Y.Map())),
      forged(Y.createID(778, 1), { parent: Y.createID(778, 0) }, new Y.ContentType(new Y.Map())),
    ]), 'unresolved');
    expectIsolated(host, raw([
      forged(Y.createID(779, 0), { origin: rootStart(doc), right: Y.createID(780, 0) }, new Y.ContentString('a')),
      forged(Y.createID(780, 0), { origin: rootStart(doc), right: Y.createID(779, 0) }, new Y.ContentString('b')),
    ]), 'unresolved');
  });

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

  it('a frame that parks is closed 4409; a forced compaction and a restart leave nothing parked', async () => {
    const opened = await start(openDoc());
    const editor = await connect(opened, { role: 'editor' });
    await editor.hello();
    const other = await connect(opened, { role: 'editor' });
    await other.hello();
    const parks = raw([forged(Y.createID(777, 0), { parent: Y.createID(888, 0) }, new Y.ContentAny(['parked']))], [[999, 3, 1]]);
    await editor.deliver(syncFrame(2, parks));
    await editor.pump();
    expect(editor.closed?.code).toBe(CLOSE.writeRefused);
    expect(editor.events).toContainEqual({ t: 'write-refused', reason: 'unresolved' });
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
