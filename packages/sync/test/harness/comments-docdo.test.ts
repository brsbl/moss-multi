// T4.1 comment data plane against the real DocDO (BUILDPLAN T4.1; docs/design/comments.md §3, §4, §13): gate 2b on
// every sync frame, the pending purge before compaction, R persisted across restarts, records written through
// writeComments in the frame's or import's turn, marker import, clean export and the create RPC.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { $createMarkNode } from '@lexical/mark';
import fc from 'fast-check';
import { $createParagraphNode, $createTextNode, $getRoot } from 'lexical';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import * as Y from 'yjs';
import { anchorText, encodePosition, liveUnits, type Anchor } from '@moss-multi/core/anchor-frame';
import { BLOCK_CHAR } from '@moss-multi/core/tree-anchor';
import { CLOSE } from '@moss-multi/protocol/sync';
import { DocDO } from '../../src/doc-do.ts';
import { COMMENT_STATE_SHARE, MAX_IMPORT_SEARCHES } from '../../src/doc/comments.ts';
import { COMPACT_MAX_ROWS, STATE_CHUNK_BYTES } from '../../src/doc/persistence.ts';
import { bindLexical, connect, counts, openDoc, start, syncFrame, wake, type Opened, type TestClient } from './do-harness.ts';
import { forged, gcStruct, raw, skipStruct } from './raw-frames.ts';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

const fixtures = join(dirname(fileURLToPath(import.meta.url)), '../../src/converter/fixtures');
const fixture = (name: string) => readFileSync(join(fixtures, name), 'utf8');

const SEED = 'The %%m:c1:start%%quick brown%%m:c1:end%% fox jumps over the %%m:c2:start%%lazy dog%%m:c2:end%%.';
const SIDECAR = {
  c1: { text: 'first', createdAt: 1_700_000_000, updatedAt: 1_700_000_000, source: 'user' },
  c2: { text: 'second', createdAt: 1_700_000_001, updatedAt: 1_700_000_001, source: 'user' },
};

const json = (opened: Opened) => opened.dobj.document.getMap('comments').toJSON();
const anchorOf = (opened: Opened, id: string) => opened.dobj.document.getMap<Anchor>('comments').get(`a:${id}`);
const metaR = (opened: Opened) => Number(opened.backing.query<{ value: string }>("SELECT value FROM meta WHERE key = 'commentsClient'")[0]?.value);
const recordItem = (doc: Y.Doc, key: string) => doc.getMap('comments')._map.get(key)!;
const rootStart = (doc: Y.Doc) => doc.get('root', Y.XmlText)._start!.id;
const copyOf = (doc: Y.Doc) => {
  const copy = new Y.Doc();
  Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc));
  return copy;
};
const diff = (from: Y.Doc, to: Y.Doc) => Y.encodeStateAsUpdate(from, Y.encodeStateVector(to));
const paragraphOf = (doc: Y.Doc, n = 0) => (doc.get('root', Y.XmlText).toDelta() as { insert: unknown }[])[n].insert as Y.XmlText;

/** The XmlText index of `needle`, counting each embed (a text node's property map) as one. */
function indexIn(paragraph: Y.XmlText, needle: string): number {
  let at = 0;
  for (const op of paragraph.toDelta() as { insert: unknown }[]) {
    if (typeof op.insert !== 'string') {
      at += 1;
      continue;
    }
    const found = op.insert.indexOf(needle);
    if (found >= 0) return at + found;
    at += op.insert.length;
  }
  throw new Error(`"${needle}" is not in ${paragraph.toString()}`);
}

/** A doc imported with two marker comments, so R has live records: c1 on "quick brown", c2 on "lazy dog". */
async function seeded(): Promise<{ opened: Opened; r: number }> {
  const opened = await start(openDoc());
  await opened.dobj.create({ folderId: 'folder', ownerId: 'owner', author: 'importer', markdown: SEED, comments: SIDECAR } as never);
  expect(anchorOf(opened, 'c1')?.status, 'the seed imports its comments').toBe('anchored');
  return { opened, r: metaR(opened) };
}

async function editorOn(opened: Opened, role = 'editor', doc?: Y.Doc): Promise<TestClient> {
  const client = await connect(opened, { role }, doc);
  await client.hello();
  return client;
}

/** The frame is refused 4409 with `reason`, and the comments map is unchanged. */
async function expectRefused(opened: Opened, frame: Uint8Array, reason: string, options: { role?: string; step?: number } = {}): Promise<void> {
  const before = json(opened);
  const client = await editorOn(opened, options.role);
  await client.deliver(syncFrame(options.step ?? 2, frame));
  await client.pump();
  expect(client.events).toContainEqual({ t: 'write-refused', reason });
  expect(client.closed?.code).toBe(CLOSE.writeRefused);
  expect(opened.dobj.document.store.pendingStructs).toBeNull();
  expect(opened.dobj.document.store.pendingDs).toBeNull();
  expect(json(opened)).toEqual(before);
}

/** A later frame that supplies what a purged frame was waiting on: it applies, and comments stay as they were. */
async function release(opened: Opened, frame: Uint8Array): Promise<void> {
  const before = json(opened);
  const client = await editorOn(opened);
  await client.deliver(syncFrame(2, frame));
  await client.pump();
  expect(opened.dobj.document.store.pendingStructs).toBeNull();
  expect(opened.dobj.document.store.pendingDs).toBeNull();
  expect(json(opened)).toEqual(before);
}

/** The server's next write lands exactly, and every item under comments is still R's (I1). */
async function expectServerWriteIsolated(opened: Opened, r: number): Promise<void> {
  const before = json(opened);
  expect(await opened.dobj.createComment({ author: 'ada', id: 'after', text: 'server', parentId: 'c1' })).toMatchObject({ ok: true });
  expect(Object.keys(json(opened)).sort()).toEqual([...Object.keys(before), 'c:after'].sort());
  const doc = opened.dobj.document;
  const comments = doc.getMap('comments');
  for (const list of doc.store.clients.values()) {
    for (const struct of list) {
      if (!(struct instanceof Y.Item)) continue;
      let type = struct.parent as Y.AbstractType<unknown> | null;
      while (type && type._item && type._item.parent instanceof Y.AbstractType) type = type._item.parent as Y.AbstractType<unknown>;
      if (type === comments) expect(struct.id.client).toBe(r);
    }
  }
}

/** An editor's one-character edit after the comment writes: the doc still has room to type (A§5.1 Limits). */
async function expectTypeable(opened: Opened): Promise<void> {
  const client = await editorOn(opened);
  const paragraph = paragraphOf(client.doc);
  client.doc.transact(() => paragraph.insert(paragraph.length, '!'));
  await client.flush();
  expect(client.closed, 'the next body edit is admitted').toBeNull();
  expect(client.events).not.toContainEqual(expect.objectContaining({ t: 'write-refused' }));
}

/** Changes DocDO.limits for the rest of the test. */
function withLimits(change: Partial<typeof DocDO.limits>): void {
  const limits = DocDO.limits;
  DocDO.limits = { ...limits, ...change } as typeof limits;
  onTestFinished(() => {
    DocDO.limits = limits;
  });
}

type Fixture = [name: string, make: (doc: Y.Doc, r: number) => Uint8Array];

const GUARD: Fixture[] = [
  ['an Item of client R', (doc, r) => {
    const forger = copyOf(doc);
    forger.clientID = r;
    forger.getText('title').insert(0, 'x');
    return diff(forger, doc);
  }],
  ['a GC struct of client R', (doc, r) => raw([gcStruct(Y.createID(r, Y.getState(doc.store, r)))])],
  ['a Skip struct of client R', (doc, r) => raw([skipStruct(Y.createID(r, Y.getState(doc.store, r)))])],
  ['an item whose origin is an R record', (doc) => raw([forged(Y.createID(777, 0), { origin: recordItem(doc, 'c:c2').id }, new Y.ContentAny(['x']))])],
  ['an item whose right origin is an R record', (doc) => raw([forged(Y.createID(777, 0), { origin: rootStart(doc), right: recordItem(doc, 'c:c2').id }, new Y.ContentString('x'))])],
  ['an item whose parent is an R item', (doc) => raw([forged(Y.createID(777, 0), { parent: recordItem(doc, 'c:c2').id, sub: 'k' }, new Y.ContentAny(['x']))])],
  ['a comments string parent', () => raw([forged(Y.createID(777, 0), { parent: 'comments', sub: 'c:forged' }, new Y.ContentAny([{ text: 'mine' }]))])],
  ['an unknown string parent', () => raw([forged(Y.createID(777, 0), { parent: 'evil', sub: 'k' }, new Y.ContentAny([1]))])],
  ['an honest-looking new comments record', (doc) => {
    const writer = copyOf(doc);
    writer.getMap('comments').set('c:forged', { text: 'mine' });
    return diff(writer, doc);
  }],
  ['an overwrite of an R record', (doc) => {
    const writer = copyOf(doc);
    writer.getMap('comments').set('c:c1', { text: 'replaced' });
    return diff(writer, doc);
  }],
  ['a delete of a live R record', (doc) => {
    const eraser = copyOf(doc);
    eraser.getMap('comments').delete('c:c2');
    return diff(eraser, doc);
  }],
];

describe('T4.1 gate 2b in the DocDO: no client frame lands a write in comments @p:tech-3', () => {
  it.each(GUARD)('refuses %s with protected-type and 4409', async (_name, make) => {
    const { opened, r } = await seeded();
    await expectRefused(opened, make(opened.dobj.document, r), 'protected-type');
  });

  it('refuses an inert step 2 carrying an R struct, from an editor and from a viewer', async () => {
    const { opened } = await seeded();
    const inert = Y.encodeStateAsUpdate(copyOf(opened.dobj.document));
    await expectRefused(opened, inert, 'protected-type', { step: 1 });
    await expectRefused(opened, inert, 'protected-type', { step: 1, role: 'viewer' });
  });

  it("admits an honest step 2 whose delete set names R's deleted items", async () => {
    const { opened, r } = await seeded();
    const trimmer = await editorOn(opened);
    const trimmed = paragraphOf(trimmer.doc);
    trimmer.doc.transact(() => trimmed.delete(indexIn(trimmed, 'quick'), 'quick '.length));
    await trimmer.flush();
    expect(opened.dobj.document.store.clients.get(r)?.some((struct) => struct.deleted), 'the shrink rewrote a:c1, leaving an R tombstone').toBe(true);
    const client = await editorOn(opened);
    const edited = copyOf(client.doc);
    const paragraph = paragraphOf(edited);
    paragraph.insert(indexIn(paragraph, 'The'), 'Very ');
    const step2 = Y.encodeStateAsUpdate(edited, Y.encodeStateVector(opened.dobj.document));
    expect(Y.decodeUpdate(step2).ds.clients.has(r), 'the step 2 carries R tombstones').toBe(true);
    await client.deliver(syncFrame(1, step2));
    await client.pump();
    expect(client.closed).toBeNull();
    expect(opened.dobj.document.get('root', Y.XmlText).toString()).toContain('Very');
  });

  it('refuses a frame Yjs parks or throws on (a self-parented struct) as unresolved', async () => {
    const { opened } = await seeded();
    await expectRefused(opened, raw([forged(Y.createID(777, 0), { parent: Y.createID(777, 0) }, new Y.ContentType(new Y.Map()))]), 'unresolved');
  });

  it("history fixtures: tail splices at R's and the DocDO's latest clocks", async () => {
    const { opened, r } = await seeded();
    const doc = opened.dobj.document;
    const rState = Y.getState(doc.store, r);
    await expectRefused(opened, raw([forged(Y.createID(r, rState - 1), { origin: rootStart(doc) }, new Y.ContentAny([{ text: 'plain' }, { text: 'FORGED' }]))]), 'protected-type');
    // The server's latest non-comment write (the import's) is never a comment: the tail lands beside it, outside comments.
    const s = rootStart(doc).client;
    const sState = Y.getState(doc.store, s);
    expect(s).not.toBe(r);
    expect(sState, 'the import wrote the body').toBeGreaterThan(0);
    const before = json(opened);
    const client = await editorOn(opened);
    await client.deliver(syncFrame(2, raw([forged(Y.createID(s, sState - 1), { parent: 'frontmatter', sub: 'k' }, new Y.ContentAny(['e', 'x']))])));
    await client.pump();
    expect(client.events).not.toContainEqual({ t: 'write-refused', reason: 'protected-type' });
    expect(json(opened)).toEqual(before);
    await expectServerWriteIsolated(opened, r);
  });

  it('history fixtures: a fully held struct with a forged missing origin parks the tail and is purged', async () => {
    const { opened, r } = await seeded();
    const doc = opened.dobj.document;
    const s = rootStart(doc).client;
    const sState = Y.getState(doc.store, s);
    expect(sState, 'the import wrote the body').toBeGreaterThan(0);
    await expectRefused(opened, raw([
      forged(Y.createID(s, sState - 1), { origin: Y.createID(5150, 0) }, new Y.ContentString('e')),
      forged(Y.createID(s, sState), { origin: rootStart(doc) }, new Y.ContentAny(['tail'])),
    ]), 'unresolved');
    await release(opened, raw([forged(Y.createID(5150, 0), { parent: 'frontmatter', sub: 'z' }, new Y.ContentAny(['z']))]));
    expect(doc.store.clients.get(s)?.some((struct) => struct.id.clock >= sState && struct instanceof Y.Item && struct.content instanceof Y.ContentAny), 'the parked tail never integrates').toBe(false);
    await expectServerWriteIsolated(opened, r);
  });

  it('history fixtures: a missing right origin beside a held left origin', async () => {
    const { opened, r } = await seeded();
    const doc = opened.dobj.document;
    await expectRefused(opened, raw([forged(Y.createID(777, 0), { origin: rootStart(doc), right: Y.createID(r, Y.getState(doc.store, r)) }, new Y.ContentString('x'))]), 'protected-type');
    await expectRefused(opened, raw([forged(Y.createID(778, 0), { origin: rootStart(doc), right: Y.createID(6160, 0) }, new Y.ContentString('x'))]), 'unresolved');
    await release(opened, raw([forged(Y.createID(6160, 0), { parent: 'frontmatter', sub: 'y' }, new Y.ContentAny(['y']))]));
    expect(doc.store.clients.has(778), 'the parked struct never integrates').toBe(false);
    await expectServerWriteIsolated(opened, r);
  });

  it('history fixtures: parent cycles and right origins that name each other are purged', async () => {
    const { opened, r } = await seeded();
    const doc = opened.dobj.document;
    await expectRefused(opened, raw([forged(Y.createID(777, 0), { parent: Y.createID(777, 0) }, new Y.ContentType(new Y.Map()))]), 'unresolved');
    await expectRefused(opened, raw([
      forged(Y.createID(778, 0), { parent: Y.createID(778, 1) }, new Y.ContentType(new Y.Map())),
      forged(Y.createID(778, 1), { parent: Y.createID(778, 0) }, new Y.ContentType(new Y.Map())),
    ]), 'unresolved');
    await expectRefused(opened, raw([
      forged(Y.createID(779, 0), { origin: rootStart(doc), right: Y.createID(780, 0) }, new Y.ContentString('a')),
      forged(Y.createID(780, 0), { origin: rootStart(doc), right: Y.createID(779, 0) }, new Y.ContentString('b')),
    ]), 'unresolved');
    for (const client of [777, 778, 779, 780]) expect(doc.store.clients.has(client), `client ${client} never integrates`).toBe(false);
    await expectServerWriteIsolated(opened, r);
  });

  it('keeps R across a restart, and the DocDO never writes as R', async () => {
    const { opened, r } = await seeded();
    expect(Number.isInteger(r) && r > 0).toBe(true);
    expect(opened.dobj.document.clientID).not.toBe(r);
    for (const struct of opened.dobj.document.store.clients.get(r) ?? []) {
      if (!(struct instanceof Y.Item)) continue;
      let type = struct.parent as Y.AbstractType<unknown> | null;
      while (type?._item) type = type._item.parent as Y.AbstractType<unknown>;
      expect(type, 'every R struct is in comments').toBe(opened.dobj.document.getMap('comments'));
    }
    const woken = await start(wake(opened));
    expect(metaR(woken)).toBe(r);
    expect(woken.dobj.document.clientID).not.toBe(r);
    await expectRefused(woken, GUARD[0][1](woken.dobj.document, r), 'protected-type');
  });

  it('fast-check: whatever raw frame an editor sends, every item in the comments subtree has client R', async () => {
    const ref = fc.record({ client: fc.nat(3), clock: fc.nat(12) });
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            client: fc.nat(3),
            skip: fc.nat(2),
            origin: fc.option(ref, { nil: undefined }),
            right: fc.option(ref, { nil: undefined }),
            parent: fc.option(fc.oneof(fc.constantFrom('root', 'title', 'comments', 'frontmatter', 'evil'), ref), { nil: undefined }),
            sub: fc.option(fc.constantFrom('c:c1', 'a:c1', 'k'), { nil: undefined }),
            kind: fc.constantFrom('string', 'any', 'map'),
          }),
          { minLength: 1, maxLength: 6 },
        ),
        fc.array(fc.tuple(fc.nat(3), fc.nat(12), fc.integer({ min: 1, max: 3 })), { maxLength: 3 }),
        fc.constantFrom(1, 2),
        async (specs, deletes, step) => {
          const { opened, r } = await seeded();
          const doc = opened.dobj.document;
          const before = doc.getMap('comments').get('c:c1');
          // Symbolic writers: two strangers, R, and the DocDO's own client.
          const clients = [777, 778, r, doc.clientID];
          const next = new Map<number, number>();
          const id = (at: { client: number; clock: number } | undefined) => (at ? Y.createID(clients[at.client], at.clock) : undefined);
          const structs = specs.map((spec) => {
            const client = clients[spec.client];
            const clock = next.get(client) ?? Y.getState(doc.store, client) + spec.skip;
            const content = spec.kind === 'string' ? new Y.ContentString('x') : spec.kind === 'any' ? new Y.ContentAny(['x']) : new Y.ContentType(new Y.Map());
            next.set(client, clock + content.getLength());
            // An item with neither origin nor right origin must carry a parent to be encodable.
            const parent = typeof spec.parent === 'string' ? spec.parent : id(spec.parent) ?? (spec.origin || spec.right ? undefined : 'root');
            return forged(Y.createID(client, clock), { origin: id(spec.origin), right: id(spec.right), parent, sub: spec.sub }, content);
          });
          // Structs of one client in clock order, as an encoder writes them.
          structs.sort((a, b) => a.id.client - b.id.client || a.id.clock - b.id.clock);
          const client = await editorOn(opened);
          await client.deliver(syncFrame(step, raw(structs, deletes.map(([who, clock, len]): [number, number, number] => [clients[who], clock, len]))));
          await client.pump();
          expect(doc.store.pendingStructs).toBeNull();
          expect(doc.store.pendingDs).toBeNull();
          const comments = doc.getMap('comments');
          for (const list of doc.store.clients.values()) {
            for (const struct of list) {
              if (!(struct instanceof Y.Item)) continue;
              let type = struct.parent as Y.AbstractType<unknown> | null;
              while (type && type._item && type._item.parent instanceof Y.AbstractType) type = type._item.parent as Y.AbstractType<unknown>;
              if (type === comments) expect(struct.id.client).toBe(r);
            }
          }
          expect(comments.get('c:c1')).toEqual(before);
        },
      ),
      { numRuns: 60 },
    );
  });
});

describe('T4.1 pending purge before compaction in the DocDO @p:tech-3', () => {
  /** One frame: a frontmatter edit that integrates, a struct whose parent never arrived, and a delete of an unknown client. */
  const mixed = (value: unknown) => raw(
    [
      forged(Y.createID(777, 0), { parent: 'frontmatter', sub: 'kept' }, new Y.ContentAny([value])),
      forged(Y.createID(778, 0), { parent: Y.createID(888, 0) }, new Y.ContentAny(['parked'])),
    ],
    [[999, 3, 1]],
  );
  const release = raw([
    forged(Y.createID(888, 0), { parent: 'frontmatter', sub: 'held' }, new Y.ContentType(new Y.Map())),
    forged(Y.createID(999, 0), { parent: 'frontmatter', sub: 'deleted' }, new Y.ContentAny([1, 2, 3, 4])),
  ]);

  async function afterRestart(opened: Opened, kept: unknown): Promise<void> {
    const woken = await start(wake(opened));
    const doc = woken.dobj.document;
    expect(doc.getMap('frontmatter').get('kept'), 'the integrated edit survives').toEqual(kept);
    expect(doc.store.pendingStructs).toBeNull();
    expect(doc.store.pendingDs).toBeNull();
    const late = await editorOn(woken);
    await late.deliver(syncFrame(2, release));
    await late.pump();
    expect(doc.store.clients.has(778), 'the parked struct never integrates').toBe(false);
    expect(doc.getMap('frontmatter').get('deleted'), 'the parked delete never applies').toBe(4);
  }

  it('mixed-pending-frame-compacts-only-after-purge: the frame that crosses COMPACT_MAX_ROWS', async () => {
    const opened = await start(openDoc());
    const title = opened.dobj.document.getText('title');
    while (counts(opened.backing).updates < COMPACT_MAX_ROWS) opened.dobj.document.transact(() => title.insert(0, 'x'), 'fill');
    expect(counts(opened.backing).updates).toBe(COMPACT_MAX_ROWS);
    const editor = await editorOn(opened);
    await editor.deliver(syncFrame(2, mixed('v')));
    await editor.pump();
    expect(editor.events).toContainEqual({ t: 'write-refused', reason: 'unresolved' });
    expect(counts(opened.backing).updates, 'the frame compacted the log').toBe(0);
    await afterRestart(opened, 'v');
  });

  it('mixed-pending-frame-compacts-only-after-purge: an integrated update larger than STATE_CHUNK_BYTES', async () => {
    const opened = await start(openDoc());
    const big = 'x'.repeat(STATE_CHUNK_BYTES + 1024);
    const editor = await editorOn(opened);
    await editor.deliver(syncFrame(2, mixed(big)));
    await editor.pump();
    expect(editor.events).toContainEqual({ t: 'write-refused', reason: 'unresolved' });
    expect(counts(opened.backing).state, 'the oversized update compacted').toBeGreaterThan(1);
    await afterRestart(opened, big);
  });
});

describe('T4.1 anchors persist in the frame turn and indexes rebuild at onStart @p:tech-3 @p:R18', () => {
  it('restart between a deletion and its undo: the comment still reattaches', async () => {
    const { opened } = await seeded();
    const client = await editorOn(opened);
    const paragraph = paragraphOf(client.doc);
    const history = new Y.UndoManager(client.doc.get('root', Y.XmlText), { trackedOrigins: new Set(['local']), captureTimeout: 0 });
    client.doc.transact(() => paragraph.delete(indexIn(paragraph, 'quick brown'), 'quick brown'.length), 'local');
    await client.flush();
    expect(anchorOf(opened, 'c1')?.status).toBe('orphaned');

    const woken = await start(wake(opened));
    expect(anchorOf(woken, 'c1')?.status, 'the loss was persisted in its frame').toBe('orphaned');
    const again = await editorOn(woken, 'editor', client.doc);
    history.undo();
    await again.flush();
    const anchor = anchorOf(woken, 'c1')!;
    expect(anchor.status).toBe('anchored');
    expect(anchorText(woken.dobj.document, anchor)).toBe('quick brown');
    history.destroy();
  });
});

describe('T4.1 marker import and clean export @p:tech-3 @p:mean-1', () => {
  it('the onboarding note plus sidecar imports as 4 anchored threads', async () => {
    const opened = await start(openDoc());
    const sidecar = JSON.parse(fixture('onboarding-getting-started.comments.json')) as Record<string, { text: string; source: string }>;
    await opened.dobj.create({ folderId: 'folder', ownerId: 'owner', author: 'importer', markdown: fixture('onboarding-getting-started.md'), comments: sidecar } as never);
    const doc = opened.dobj.document;
    const comments = doc.getMap<unknown>('comments');
    const roots = [...comments.keys()].filter((key) => key.startsWith('c:')).sort();
    expect(roots).toEqual(Object.keys(sidecar).map((id) => `c:${id}`).sort());
    for (const id of Object.keys(sidecar)) {
      expect(comments.get(`c:${id}`)).toMatchObject({ author: 'importer', text: sidecar[id].text, source: sidecar[id].source });
      expect((comments.get(`a:${id}`) as Anchor | undefined)?.status, id).toBe('anchored');
    }
    const text = (id: string) => anchorText(doc, comments.get(`a:${id}`) as Anchor);
    expect(text('onboarding-user-comment')).toBe('Your own comments stay editable, so you can leave yourself a review note and revise it later.');
    expect(text('onboarding-moss-comment')).toBe('Moss comments are labeled Moss when the in-app agent leaves feedback.');
    expect(text('onboarding-external-comment')).toBe('External coding-agent comments are labeled External agent when a connected agent writes review notes back into Moss.');
    expect((comments.get('a:onboarding-block-chart-comment') as Anchor).kind).toBe('block');
    expect(text('onboarding-block-chart-comment')).toBe(BLOCK_CHAR);
    expect(liveUnits(doc).text).not.toContain('%%m:');

    const exported = await opened.dobj.exportMarkdown();
    expect(exported).toContain('Your own comments stay editable');
    expect(exported).not.toContain('%%m:');
    expect(exported).not.toContain('{%c:');

    const woken = await start(wake(opened));
    expect(anchorOf(woken, 'onboarding-user-comment')?.status, 'the records persisted in the import turn').toBe('anchored');
  });

  it('export contains zero %%m: or {%c: even when a client planted a mark in the tree', async () => {
    const opened = await start(openDoc());
    const client = await connect(opened, { role: 'editor' });
    const lexical = bindLexical(client.doc);
    await client.hello();
    lexical.editor.update(() => {
      const paragraph = $createParagraphNode();
      const mark = $createMarkNode(['planted']);
      mark.append($createTextNode('marked text'));
      paragraph.append(mark);
      $getRoot().append(paragraph);
    }, { discrete: true });
    lexical.flush();
    await client.flush();
    expect(client.closed).toBeNull();
    const exported = await opened.dobj.exportMarkdown();
    expect(exported).toContain('marked text');
    expect(exported).not.toContain('%%m:');
    expect(exported).not.toContain('{%c:');
  });

  it('import-search-is-bounded: a large body with many failing sidecar quotes costs one projection and a capped number of searches', async () => {
    vi.useRealTimers();
    const sentence = 'The quick brown fox jumps over the lazy dog. ';
    const paragraphs = Array.from({ length: 220 }, () => sentence.repeat(20).trim());
    const markdown = `${paragraphs.join('\n\n')}\n\nA unique closing sentence ends the note.`;
    const sidecar: Record<string, unknown> = {
      honest: { text: 'found', createdAt: 0, updatedAt: 0, source: 'user', quote: 'unique closing sentence' },
    };
    for (let i = 1; i <= 1_000; i += 1) sidecar[`miss${i}`] = { text: 't', createdAt: i, updatedAt: i, source: 'user', quote: 'e' };
    sidecar.late = { text: 'late', createdAt: 5_000, updatedAt: 5_000, source: 'user', quote: 'ends the note' };

    const plain = await start(openDoc());
    let began = performance.now();
    await plain.dobj.create({ folderId: 'folder', ownerId: 'owner', markdown } as never);
    const base = performance.now() - began;
    const opened = await start(openDoc());
    began = performance.now();
    await opened.dobj.create({ folderId: 'folder', ownerId: 'owner', author: 'importer', markdown, comments: sidecar } as never);
    const extra = performance.now() - began - base;

    expect(anchorText(opened.dobj.document, anchorOf(opened, 'honest')!)).toBe('unique closing sentence');
    expect(anchorOf(opened, 'miss1')).toBeUndefined();
    expect(anchorOf(opened, 'late'), `searches stop at ${MAX_IMPORT_SEARCHES} per import`).toBeUndefined();
    expect(extra, `1,000 failing quotes added ${Math.round(extra)} ms to a ${Math.round(base)} ms import`).toBeLessThan(1_500);
  });

  it('import admits quote bytes: 32 long overlapping comments stop at the comment room and the doc stays typeable', async () => {
    const cap = 100_000;
    withLimits({ stateCapBytes: cap });
    const ids = Array.from({ length: 32 }, (_, i) => `k${i}`);
    const text = 'abcdefghij'.repeat(500);
    const markdown = `${ids.map((id) => `%%m:${id}:start%%`).join('')}${text}${ids.map((id) => `%%m:${id}:end%%`).reverse().join('')}`;
    const sidecar = Object.fromEntries(ids.map((id, i) => [id, { text: 't', createdAt: i, updatedAt: i, source: 'user' }]));
    const opened = await start(openDoc());
    await opened.dobj.create({ folderId: 'folder', ownerId: 'owner', author: 'importer', markdown, comments: sidecar } as never);
    const anchored = ids.filter((id) => anchorOf(opened, id)?.status === 'anchored');
    expect(anchored.length, 'some fit').toBeGreaterThan(0);
    expect(anchored.length, 'not all 32 quotes fit').toBeLessThan(32);
    expect(anchored, 'earliest first').toEqual(ids.slice(0, anchored.length));
    expect(Y.encodeStateAsUpdate(opened.dobj.document).byteLength).toBeLessThanOrEqual(cap * COMMENT_STATE_SHARE);
    await expectTypeable(opened);
  });
});

describe('T4.1 createComment RPC @p:tech-3', () => {
  async function body(markdown = 'The quick brown fox jumps over the lazy dog.\n\nSecond paragraph, a fox too.') {
    const opened = await start(openDoc());
    await opened.dobj.create({ folderId: 'folder', ownerId: 'owner', markdown });
    return opened;
  }
  const positions = (doc: Y.Doc, quote: string, nth = 0) => {
    const { text, units } = liveUnits(doc);
    let at = -1;
    for (let i = 0; i <= nth; i += 1) at = text.indexOf(quote, at + 1);
    return { start: encodePosition(units[at], 0), end: encodePosition(units[at + quote.length - 1], -1) };
  };

  it('creates a positioned comment with a server-computed quote and the server principal as author', async () => {
    const opened = await body();
    const result = await opened.dobj.createComment({ author: 'ada', id: 'c1', text: 'hello', anchor: { kind: 'text', ...positions(opened.dobj.document, 'brown fox'), quote: 'client says' } });
    expect(result).toEqual({ ok: true, id: 'c1', quote: 'brown fox' });
    expect(json(opened)['c:c1']).toMatchObject({ author: 'ada', text: 'hello', reactions: {} });
    expect(anchorText(opened.dobj.document, anchorOf(opened, 'c1')!)).toBe('brown fox');
    const reply = await opened.dobj.createComment({ author: 'ben', id: 'r1', text: 'reply', parentId: 'c1' });
    expect(reply).toMatchObject({ ok: true });
    expect(json(opened)['c:r1']).toMatchObject({ author: 'ben', parentId: 'c1' });
    expect(anchorOf(opened, 'r1')).toBeUndefined();
    expect(await opened.dobj.createComment({ author: 'ben', id: 'r2', text: 'reply', parentId: 'missing' })).toMatchObject({ ok: false, status: 409, error: 'parent-missing' });
    expect(await opened.dobj.createComment({ author: 'ada', id: 'c1', text: 'again', parentId: 'c1' })).toMatchObject({ ok: false, status: 409, error: 'exists' });
    const woken = await start(wake(opened));
    expect(anchorText(woken.dobj.document, anchorOf(woken, 'c1')!), 'persisted in the RPC turn').toBe('brown fox');
  });

  it('answers anchor-pending for an item the server lacks and anchor-gone for a deleted or reversed range', async () => {
    const opened = await body();
    const doc = opened.dobj.document;
    const ahead = copyOf(doc);
    const paragraph = paragraphOf(ahead);
    paragraph.insert(paragraph.length, ' More words here.');
    expect(await opened.dobj.createComment({ author: 'ada', id: 'p', text: 't', anchor: positions(ahead, 'More words') })).toMatchObject({ ok: false, status: 409, error: 'anchor-pending' });
    const fox = positions(doc, 'brown fox');
    const lazy = positions(doc, 'lazy dog');
    expect(await opened.dobj.createComment({ author: 'ada', id: 'g', text: 't', anchor: { start: lazy.start, end: fox.end } })).toMatchObject({ ok: false, status: 409, error: 'anchor-gone' });
    const client = await editorOn(opened);
    const live = paragraphOf(client.doc);
    client.doc.transact(() => live.delete(indexIn(live, 'The'), 'The quick brown fox'.length));
    await client.flush();
    expect(await opened.dobj.createComment({ author: 'ada', id: 'g', text: 't', anchor: fox })).toMatchObject({ ok: false, status: 409, error: 'anchor-gone' });
    expect(await opened.dobj.createComment({ author: 'ada', id: 'b', text: 't', anchor: { start: '', end: '' } })).toMatchObject({ ok: false, status: 400 });
    expect(await opened.dobj.createComment({ author: 'ada', id: 'b', text: 't', anchor: {} })).toMatchObject({ ok: false, status: 400 });
  });

  it('refuses a 33rd comment covering one character, a quote over 10,000 characters and a doc past its record cap', async () => {
    const opened = await body();
    for (let i = 0; i < 32; i += 1) {
      expect(await opened.dobj.createComment({ author: 'ada', id: `o${i}`, text: 't', anchor: positions(opened.dobj.document, i % 2 ? 'brown' : 'quick brown fox') })).toMatchObject({ ok: true });
    }
    expect(await opened.dobj.createComment({ author: 'ada', id: 'o32', text: 't', anchor: positions(opened.dobj.document, 'own') })).toMatchObject({ ok: false, status: 409, error: 'too-many-overlapping' });
    expect(await opened.dobj.createComment({ author: 'ada', id: 'o33', text: 't', anchor: positions(opened.dobj.document, 'lazy dog') })).toMatchObject({ ok: true });

    const long = await body(`${'word '.repeat(2_001)}end`);
    const all = liveUnits(long.dobj.document);
    const whole = { start: encodePosition(all.units[0], 0), end: encodePosition(all.units.at(-1)!, -1) };
    expect(await long.dobj.createComment({ author: 'ada', id: 'q', text: 't', anchor: whole })).toMatchObject({ ok: false, status: 413, error: 'quote-too-long' });
    expect(await long.dobj.createComment({ author: 'ada', id: 'big', text: 'x'.repeat(10_001), anchor: positions(long.dobj.document, 'end') })).toMatchObject({ ok: false, status: 413, error: 'text-too-long' });

    const limits = DocDO.limits;
    DocDO.limits = { ...limits, maxComments: 2 } as typeof limits;
    onTestFinished(() => {
      DocDO.limits = limits;
    });
    const capped = await body();
    expect(await capped.dobj.createComment({ author: 'ada', id: 'a', text: 't', anchor: positions(capped.dobj.document, 'quick') })).toMatchObject({ ok: true });
    expect(await capped.dobj.createComment({ author: 'ada', id: 'b', text: 't', parentId: 'a' })).toMatchObject({ ok: true });
    expect(await capped.dobj.createComment({ author: 'ada', id: 'c', text: 't', anchor: positions(capped.dobj.document, 'lazy') })).toMatchObject({ ok: false, status: 409, error: 'comment-cap' });
  });

  it('create admits quote bytes: long overlapping comments are refused doc-cap before the cap and the doc stays typeable', async () => {
    const cap = 120_000;
    withLimits({ stateCapBytes: cap });
    const whole = 'abcdefghij'.repeat(900);
    const opened = await body(whole);
    let refused: unknown = null;
    let made = 0;
    for (let i = 0; i < 32 && !refused; i += 1) {
      const result = await opened.dobj.createComment({ author: 'ben', id: `long${i}`, text: 't', anchor: positions(opened.dobj.document, whole) });
      if (result.ok) made += 1;
      else refused = result;
    }
    expect(made).toBeGreaterThan(0);
    expect(refused).toEqual({ ok: false, status: 413, error: 'doc-cap' });
    expect(Y.encodeStateAsUpdate(opened.dobj.document).byteLength).toBeLessThanOrEqual(cap * COMMENT_STATE_SHARE);
    const reply = await opened.dobj.createComment({ author: 'ben', id: 'reply', text: 'x'.repeat(10_000), parentId: 'long0' });
    expect(reply, 'a reply counts its bytes too').toMatchObject({ ok: false, status: 413, error: 'doc-cap' });
    await expectTypeable(opened);
  });

  it('a trash hold refuses a comment that reaches the DocDO after the trash began', async () => {
    const opened = await body();
    await opened.dobj.trash('hold-1');
    expect(await opened.dobj.createComment({ author: 'ada', id: 'late', text: 't', anchor: positions(opened.dobj.document, 'quick') })).toEqual({ ok: false, status: 404, error: 'trashed' });
    expect(json(opened)).toEqual({});
  });

  it('runs one quote search for a position-less anchor: a unique match, an ambiguous one, and none', async () => {
    const opened = await body();
    expect(await opened.dobj.createComment({ author: 'ada', id: 'q1', text: 't', anchor: { quote: 'jumps over the lazy' } })).toEqual({ ok: true, id: 'q1', quote: 'jumps over the lazy' });
    expect(anchorText(opened.dobj.document, anchorOf(opened, 'q1')!)).toBe('jumps over the lazy');
    expect(await opened.dobj.createComment({ author: 'ada', id: 'q3', text: 't', anchor: { quote: 'fox' } })).toMatchObject({ ok: false, status: 409, error: 'quote-ambiguous' });
    expect(await opened.dobj.createComment({ author: 'ada', id: 'q4', text: 't', anchor: { quote: 'zebra crossing' } })).toMatchObject({ ok: false, status: 409, error: 'quote-not-found' });
  });

  it('quote-search-is-bounded: a one-character quote with 2,000-character context answers quickly', async () => {
    vi.useRealTimers();
    const opened = await start(openDoc());
    await opened.dobj.create({ folderId: 'folder', ownerId: 'owner', markdown: fixture('onboarding-getting-started.md') });
    const tries = [
      { exact: 'e', prefix: 'z'.repeat(1_999), suffix: '' },
      { exact: 'e', prefix: '', suffix: 'z'.repeat(1_999) },
      { exact: 'Moss', prefix: 'z'.repeat(5_000), suffix: 'y'.repeat(5_000) },
    ];
    for (const [n, quote] of tries.entries()) {
      const began = performance.now();
      const result = await opened.dobj.createComment({ author: 'ben', id: `slow${n}`, text: 't', anchor: { quote } });
      const took = performance.now() - began;
      expect(result).toMatchObject({ ok: false, status: 409 });
      expect(took, `quote ${n} took ${Math.round(took)} ms`).toBeLessThan(750);
    }
  });

  it('a duplicate carries no comments and keeps R isolation for the copied tombstones', async () => {
    const { opened: source } = await seeded();
    const snapshot = await source.dobj.snapshotForDuplicate();
    const target = await start(openDoc());
    await target.dobj.createFromSnapshot({ folderId: 'target', ownerId: 'other', title: 'Copy' }, snapshot.state);
    expect(json(target)).toEqual({});
    expect(metaR(target), "the copy's records were written by the source's R, which the copy adopts").toBe(metaR(source));
    expect(target.dobj.document.clientID).not.toBe(metaR(target));
    const tomb = target.dobj.document.getMap('comments')._map.get('c:c1')!;
    await expectRefused(target, raw([forged(Y.createID(777, 0), { origin: tomb.id }, new Y.ContentAny([{ text: 'revived' }]))]), 'protected-type');
  });
});
