// The DocDO core in the Node harness (BUILDPLAN T0.7; A§5.1): replay, chunking, compaction identity, the seed,
// admission, the write classifier with loud refusal, acks, limits and the RPC guard.
import { $createParagraphNode, $createTextNode, $getRoot, $isElementNode } from 'lexical';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { base64ToBytes, CLOSE } from '@moss-multi/protocol/sync';
import { exportMarkdown, importMarkdown } from '../../src/converter/index.ts';
import { DocDO } from '../../src/doc-do.ts';
import { readFrontmatter, writeFrontmatterKey } from '@moss-multi/core/frontmatter';
import { serverWrite } from '../../src/server-doc.ts';
import { Backing, bindLexical, blockTypes, connect, counts, openDoc, start, wake, type Opened, type TestClient } from './do-harness.ts';

const CHUNK = 1.5 * 1024 * 1024;

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

async function editorOn(opened: Opened): Promise<TestClient> {
  const client = await connect(opened, { role: 'editor' });
  await client.hello();
  return client;
}

async function typeTitle(client: TestClient, text: string, at = client.doc.getText('title').length): Promise<void> {
  client.doc.getText('title').insert(at, text);
  await client.flush();
}

describe('seed', () => {
  it('seeds one empty paragraph once, and never title text', async () => {
    const first = await start(openDoc());
    expect(blockTypes(first.dobj.document)).toEqual(['paragraph']);
    expect(first.dobj.document.getText('title').toString()).toBe('');
    expect(readFrontmatter(first.dobj.document)).toBeNull();
    const stored = counts(first.backing);
    expect(stored.updates + stored.state, 'the seed is persisted').toBeGreaterThan(0);

    const second = await start(wake(first));
    expect(blockTypes(second.dobj.document)).toEqual(['paragraph']);
    expect(counts(second.backing), 'a wake replays the seed and writes nothing').toEqual(stored);

    await second.dobj.create({ folderId: 'folder-1', ownerId: 'user-1' });
    await second.dobj.create({ folderId: 'folder-1', ownerId: 'user-1' });
    expect(blockTypes(second.dobj.document)).toEqual(['paragraph']);
    expect(second.dobj.document.getText('title').length).toBe(0);
    expect(counts(second.backing)).toEqual(stored);
  });

  it('binds as one empty paragraph in a client editor', async () => {
    const opened = await start(openDoc());
    const client = await connect(opened, { role: 'editor' });
    const lexical = bindLexical(client.doc);
    await client.hello();
    expect(lexical.blocks()).toEqual(['paragraph']);
    expect(lexical.text()).toBe('');
  });
});

describe('server writes', () => {
  it('exports current dependent formula results after an author edits the source and after wake', async () => {
    const opened = await start(openDoc(new Backing('1d0c7f3b-5b65-4eb7-b510-8c3b2e170caa')));
    const noteId = opened.state.id.name;
    const priceId = '7bea9c0f-317a-48a1-83a7-9a1e4e7b36aa';
    const doubleId = 'd787ef71-6050-45e0-8a24-dbb8190880dc';
    await opened.dobj.create({ folderId: 'folder', ownerId: 'owner', markdown:
      `{{2|2|id=${priceId};name=price}} and {{@(price#${noteId}#${priceId})*2|4|id=${doubleId};name=double}}` });
    expect(await opened.dobj.exportMarkdown()).toContain(`)*2|4|id=${doubleId};name=double}}`);
    serverWrite(opened.dobj.document, 'author-edit', () => {
      const formula = $getRoot().getChildren().flatMap(node => $isElementNode(node) ? node.getChildren() : []).find(node => node.getType() === 'formula');
      if (!formula) throw new Error('missing price formula');
      const price = formula as typeof formula & { setFormula(value: string): void; setResult(value: string): void };
      price.setFormula('3');
      price.setResult('3');
    });
    const before = Y.encodeStateAsUpdate(opened.dobj.document);
    expect(await opened.dobj.exportMarkdown()).toContain(`)*2|6|id=${doubleId};name=double}}`);
    expect(Y.encodeStateAsUpdate(opened.dobj.document)).toEqual(before);
    const reopened = await start(wake(opened));
    expect(await reopened.dobj.exportMarkdown()).toContain(`)*2|6|id=${doubleId};name=double}}`);
  });

  const MARKDOWN = '## Plan\n\nA *first* paragraph with a [link](https://example.invalid).\n\n- one\n- two\n';

  it('hydrates the persisted tree before a server write without normalizing its formatting', () => {
    const doc = new Y.Doc();
    const lexical = bindLexical(doc);
    lexical.editor.update(() => {
      $getRoot().append($createParagraphNode().append($createTextNode(' padded ').toggleFormat('bold')));
    }, { discrete: true });
    const before = Y.encodeStateAsUpdate(doc);
    let hydrated: { text: string; bold: boolean }[] = [];
    serverWrite(doc, 'probe', () => {
      hydrated = $getRoot().getAllTextNodes().map((node) => ({ text: node.getTextContent(), bold: node.hasFormat('bold') }));
    });
    expect(hydrated).toEqual([{ text: ' padded ', bold: true }]);
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    doc.destroy();
  });

  it('imports a created body through the one converter, once', async () => {
    const opened = await start(openDoc());
    await opened.dobj.create({ folderId: 'folder-1', ownerId: 'user-1', markdown: MARKDOWN });
    const reference = importMarkdown(MARKDOWN);
    expect(await opened.dobj.exportMarkdown()).toBe(exportMarkdown(reference));

    const client = await connect(opened, { role: 'viewer' });
    const lexical = bindLexical(client.doc);
    await client.hello();
    expect(lexical.blocks()).toEqual(reference.getEditorState().read(() => $getRoot().getChildren().map((node) => node.getType())));

    const stored = counts(opened.backing);
    await opened.dobj.create({ folderId: 'folder-1', ownerId: 'user-1', markdown: 'Something else' });
    expect(counts(opened.backing), 'a repeated create writes nothing').toEqual(stored);
    expect(await opened.dobj.exportMarkdown()).toBe(exportMarkdown(reference));
  });

  it('imports canonical frontmatter separately and keeps the leading H1 in the body', async () => {
    const opened = await start(openDoc());
    const frontmatter = '---\r\ntag: "keep these quotes"\r\n---\r\n';
    await opened.dobj.create({ folderId: 'folder', ownerId: 'owner', title: 'File name', markdown: `${frontmatter}# Body heading\n\nText` });
    expect(opened.dobj.document.getText('title').toString()).toBe('File name');
    expect(readFrontmatter(opened.dobj.document)).toEqual({ tag: 'keep these quotes' });
    expect(blockTypes(opened.dobj.document)).toEqual(['heading', 'paragraph']);
    expect(await opened.dobj.exportMarkdown()).toBe('---\ntag: keep these quotes\n---\n# Body heading\n\nText');
  });

  it('duplicates a snapshot without a markdown round trip, keeps anchors, persists and remains independent', async () => {
    const source = await start(openDoc());
    await source.dobj.create({ folderId: 'source', ownerId: 'owner', title: 'Original', markdown: MARKDOWN });
    writeFrontmatterKey(source.dobj.document, 'tag', 'keep', 'test');
    const root = source.dobj.document.get('root', Y.XmlText);
    const anchor = Y.createRelativePositionFromTypeIndex(root, 1);
    source.dobj.document.getMap('comments').set('anchor', Y.encodeRelativePosition(anchor));
    const snapshot = await source.dobj.snapshotForDuplicate();
    const target = await start(openDoc());
    await target.dobj.createFromSnapshot({ folderId: 'target', ownerId: 'other', title: 'Original copy' }, snapshot.state);
    expect(await target.dobj.exportMarkdown()).toBe(await source.dobj.exportMarkdown());
    expect(blockTypes(target.dobj.document)).toEqual(blockTypes(source.dobj.document));
    expect(Y.createAbsolutePositionFromRelativePosition(anchor, target.dobj.document)?.index).toBe(1);
    expect(target.dobj.document.getMap('comments').get('anchor')).toEqual(Y.encodeRelativePosition(anchor));
    expect(source.dobj.document.getText('title').toString()).toBe('Original');
    expect(target.dobj.document.getText('title').toString()).toBe('Original copy');
    await target.dobj.createFromSnapshot({ folderId: 'target', ownerId: 'other' }, snapshot.state);
    const woken = await start(wake(target));
    expect(await woken.dobj.exportMarkdown()).toBe(await source.dobj.exportMarkdown());
    writeFrontmatterKey(woken.dobj.document, 'tag', 'independent', 'test');
    expect(readFrontmatter(source.dobj.document)).toEqual({ tag: 'keep' });
  });

  it('replays legacy YAML into the map, persists its upgrade, and exports after a second wake', async () => {
    const legacy = await start(openDoc());
    await legacy.dobj.create({ folderId: 'folder', ownerId: 'owner', title: 'Old note', markdown: MARKDOWN });
    // The pre-map server's persisted wire shape, including its fenced YAML and CRLFs.
    legacy.dobj.document.getText('frontmatter').insert(0, '---\r\nstatus: draft\r\ntags: [keep, both]\r\n---\r\n');
    await legacy.dobj.onSave();
    const restored = await start(wake(legacy));
    expect(readFrontmatter(restored.dobj.document)).toEqual({ status: 'draft', tags: ['keep', 'both'] });
    writeFrontmatterKey(restored.dobj.document, 'status', undefined, 'test');
    await restored.dobj.onSave();
    const again = await start(wake(restored));
    expect(readFrontmatter(again.dobj.document)).toEqual({ tags: ['keep', 'both'] });
    expect(await again.dobj.exportMarkdown()).toBe(`---\ntags:\n  - keep\n  - both\n---\n${exportMarkdown(importMarkdown(MARKDOWN))}`);
    expect(again.dobj.document.getText('title').toString()).toBe('Old note');
  });

  it('refuses an import past the state cap and keeps the seed', async () => {
    class SmallDoc extends DocDO {
      static override limits = { ...DocDO.limits, stateCapBytes: 4 * 1024 };
    }
    const opened = await start(openDoc(new Backing(), SmallDoc as never));
    await expect(opened.dobj.create({ folderId: 'folder-1', ownerId: 'user-1', markdown: 'word '.repeat(4_000) })).rejects.toThrow('doc-cap');
    expect(blockTypes(opened.dobj.document)).toEqual(['paragraph']);
    expect((await opened.dobj.exportMarkdown()).trim()).toBe('');
  });

  it('counts imported frontmatter in admission and refuses the entire file together', async () => {
    class SmallDoc extends DocDO {
      static override limits = { ...DocDO.limits, stateCapBytes: 4 * 1024 };
    }
    const opened = await start(openDoc(new Backing(), SmallDoc as never));
    const before = Y.encodeStateAsUpdate(opened.dobj.document);
    const markdown = `---\nlarge: ${'x'.repeat(5_000)}\n---\n\nSmall body`;
    await expect(opened.dobj.create({ folderId: 'folder', ownerId: 'owner', markdown })).rejects.toThrow('doc-cap');
    expect(Y.encodeStateAsUpdate(opened.dobj.document)).toEqual(before);
  });
});

describe('persistence', () => {
  it('chunks compacted state at 1.5 MB', async () => {
    const opened = openDoc();
    const editor = await editorOn(opened);
    await typeTitle(editor, 'a'.repeat(3_300_000));
    const chunks = opened.backing.query<{ idx: number; n: number }>('SELECT idx, length(data) AS n FROM ystate ORDER BY idx');
    const state = Y.encodeStateAsUpdate(opened.dobj.document).byteLength;
    expect(chunks.length).toBe(Math.ceil(state / CHUNK));
    expect(chunks.slice(0, -1).every((c) => c.n === CHUNK)).toBe(true);
    expect(chunks.reduce((sum, c) => sum + c.n, 0)).toBe(state);
    expect(chunks.map((c) => c.idx)).toEqual(chunks.map((_, i) => i));
  });

  it('replays the state chunks, then the update log in order, before it answers any frame', async () => {
    const opened = openDoc();
    const editor = await editorOn(opened);
    await typeTitle(editor, 'b'.repeat(3_300_000));
    await typeTitle(editor, ' tail-1');
    await typeTitle(editor, ' tail-2');
    const stored = counts(opened.backing);
    expect(stored.state, 'compacted state spans several chunks').toBeGreaterThan(1);
    expect(stored.updates, 'later writes stay in the log').toBe(2);
    const sv = Y.encodeStateVector(opened.dobj.document);
    const text = opened.dobj.document.getText('title').toString();

    const woken = wake(opened);
    const fresh = await connect(woken, { role: 'viewer' });
    await fresh.hello();
    expect(fresh.doc.getText('title').toString(), 'the first frame after a wake sees the whole doc').toBe(text);
    expect(Y.encodeStateVector(woken.dobj.document)).toEqual(sv);
    expect(counts(woken.backing), 'replay re-persists nothing').toEqual(stored);
  });

  it('keeps RelativePositions valid through compaction and a wake', async () => {
    const opened = openDoc();
    const editor = await editorOn(opened);
    await typeTitle(editor, 'hello world');
    const title = editor.doc.getText('title');
    const anchor = Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(title, 6));
    for (let i = 0; i < 520; i += 1) {
      await typeTitle(editor, 'x', 0);
      vi.advanceTimersByTime(20);
    }
    await typeTitle(editor, '!');
    const stored = counts(opened.backing);
    expect(stored.state, 'compaction ran').toBeGreaterThan(0);
    expect(stored.updates).toBeLessThan(520);

    const woken = await start(wake(opened));
    const live = woken.dobj.document.getText('title');
    const position = Y.createAbsolutePositionFromRelativePosition(Y.decodeRelativePosition(anchor), woken.dobj.document);
    expect(position?.type).toBe(live);
    expect(position?.index).toBe(526);
    expect(live.toString().slice(position?.index)).toBe('world!');
  });
});

describe('admission and the write classifier', () => {
  async function sharedDoc() {
    const opened = openDoc();
    const editor = await editorOn(opened);
    await typeTitle(editor, 'shared');
    const viewer = await connect(opened, { role: 'viewer' });
    await viewer.hello();
    return { opened, editor, viewer };
  }

  it("accepts a viewer's connect and post-wake step 2 frames silently", async () => {
    const { opened, editor, viewer } = await sharedDoc();
    expect(viewer.doc.getText('title').toString()).toBe('shared');
    expect(viewer.closed).toBeNull();
    expect(viewer.events).toEqual([]);
    const stored = counts(opened.backing);
    const sv = Y.encodeStateVector(opened.dobj.document);

    const woken = wake(opened);
    viewer.opened = woken;
    editor.opened = woken;
    // The viewer's periodic step 1 wakes the DO, which replays and sends every socket a step 1; the viewer's
    // provider answers with a step 2.
    await viewer.hello();
    expect(viewer.closed).toBeNull();
    expect(viewer.events).toEqual([]);
    expect(Y.encodeStateVector(woken.dobj.document)).toEqual(sv);
    expect(counts(woken.backing)).toEqual(stored);
  });

  it('refuses a viewer frame that would change the doc, out loud, and closes 4403', async () => {
    const { opened, viewer } = await sharedDoc();
    const stored = counts(opened.backing);
    await typeTitle(viewer, 'sneaky ', 0);
    expect(viewer.events).toEqual([{ t: 'write-refused', reason: 'role' }]);
    expect(viewer.closed?.code).toBe(CLOSE.revoked);
    expect(opened.dobj.document.getText('title').toString()).toBe('shared');
    expect(counts(opened.backing)).toEqual(stored);
  });

  it('refuses a viewer frame that only deletes', async () => {
    const { opened, viewer } = await sharedDoc();
    viewer.doc.getText('title').delete(0, 1);
    await viewer.flush();
    expect(viewer.events).toEqual([{ t: 'write-refused', reason: 'role' }]);
    expect(viewer.closed?.code).toBe(CLOSE.revoked);
    expect(opened.dobj.document.getText('title').toString()).toBe('shared');
  });

  it("lands an editor's writes and acks them once per 250 ms", async () => {
    const { opened, editor } = await sharedDoc();
    const before = counts(opened.backing).updates;
    await typeTitle(editor, ' one');
    await typeTitle(editor, ' two');
    expect(opened.dobj.document.getText('title').toString()).toBe('shared one two');
    expect(counts(opened.backing).updates).toBe(before + 2);
    expect(editor.events.filter((e) => e.t === 'ack')).toEqual([]);
    vi.advanceTimersByTime(250);
    await editor.pump();
    const acks = editor.events.filter((e) => e.t === 'ack');
    expect(acks).toHaveLength(1);
    const acked = Y.decodeStateVector(base64ToBytes(acks[0].t === 'ack' ? acks[0].sv : ''));
    for (const [client, clock] of Y.decodeStateVector(Y.encodeStateVector(editor.doc))) {
      expect(acked.get(client) ?? 0).toBeGreaterThanOrEqual(clock);
    }
  });

  it("acks a reconnecting editor's step 2 even when the doc already holds it, so an ack lost with its socket comes back", async () => {
    const { opened, editor } = await sharedDoc();
    vi.advanceTimersByTime(250);
    await typeTitle(editor, ' lost');
    // The socket drops inside the ack window: the DocDO holds the edit, and the drop cancels its ack.
    await editor.drop();
    vi.advanceTimersByTime(250);
    expect(opened.dobj.document.getText('title').toString()).toBe('shared lost');
    const stored = counts(opened.backing);

    // The provider reconnects with the same Y.Doc; its step 2 brings nothing the doc lacks.
    const again = await connect(opened, { role: 'editor' }, editor.doc);
    await again.hello();
    vi.advanceTimersByTime(250);
    await again.pump();
    const acks = again.events.filter((e) => e.t === 'ack');
    expect(acks, 'the reconnect is acked').toHaveLength(1);
    const acked = Y.decodeStateVector(base64ToBytes(acks[0]?.t === 'ack' ? acks[0].sv : ''));
    for (const [client, clock] of Y.decodeStateVector(Y.encodeStateVector(editor.doc))) {
      expect(acked.get(client) ?? 0, 'the ack covers the edit whose ack was lost').toBeGreaterThanOrEqual(clock);
    }
    expect(counts(opened.backing), 'an inert step 2 writes nothing').toEqual(stored);
  });

  it('names the deletes it applied in the ack, so a delete never reads as synced before it lands', async () => {
    const { opened, editor } = await sharedDoc();
    vi.advanceTimersByTime(250);
    await editor.pump();
    const local: Uint8Array[] = [];
    editor.doc.on('update', (update: Uint8Array, origin: unknown) => {
      if (typeof origin !== 'symbol') local.push(update);
    });
    editor.doc.getText('title').delete(0, 2);
    const deletion = Y.mergeUpdates(local);
    const before = editor.events.filter((e) => e.t === 'ack');
    const earlier = before[before.length - 1];
    if (earlier?.t !== 'ack') throw new Error('no earlier ack');
    // The state vector cannot tell: the earlier ack already "covers" a delete the server has not seen.
    expect(Y.snapshotContainsUpdate(Y.createSnapshot(Y.createDeleteSet(), Y.decodeStateVector(base64ToBytes(earlier.sv))), deletion)).toBe(false);

    await editor.flush();
    expect(opened.dobj.document.getText('title').toString()).toBe('ared');
    vi.advanceTimersByTime(250);
    await editor.pump();
    const acks = editor.events.filter((e) => e.t === 'ack');
    const ack = acks[acks.length - 1];
    expect(acks.length, 'the delete is acked').toBe(before.length + 1);
    if (ack?.t !== 'ack') throw new Error('no ack');
    expect(ack.ds, 'the ack carries the deletes').toEqual(expect.any(String));
    const deleted = Y.decodeSnapshot(base64ToBytes(ack.ds ?? '')).ds;
    expect(Y.snapshotContainsUpdate(Y.createSnapshot(deleted, Y.decodeStateVector(base64ToBytes(ack.sv))), deletion), 'the ack covers the delete').toBe(true);
  });

  it("keeps a socket's ack when a stale socket with the same connection id closes", async () => {
    const opened = await start(openDoc());
    const stale = await connect(opened, { role: 'editor' }, undefined, 'reused-pk');
    await stale.hello();
    const fresh = await connect(opened, { role: 'editor' }, undefined, 'reused-pk');
    await fresh.hello();
    await typeTitle(fresh, 'kept');
    // The stale socket's close finally lands inside the fresh socket's ack window.
    await stale.drop();
    vi.advanceTimersByTime(250);
    await fresh.pump();
    expect(fresh.events.filter((e) => e.t === 'ack'), "the stale close never cancels the fresh socket's ack").toHaveLength(1);
    expect(stale.events.filter((e) => e.t === 'ack'), 'the ack goes to the socket that wrote').toHaveLength(0);
  });

  it('counts the write rate per socket, not per reused connection id', async () => {
    const opened = await start(openDoc());
    const stale = await connect(opened, { role: 'editor' }, undefined, 'reused-rate');
    await stale.hello();
    for (let i = 0; i < 300; i += 1) await typeTitle(stale, 'a');
    expect(stale.closed).toBeNull();
    const fresh = await connect(opened, { role: 'editor' }, undefined, 'reused-rate');
    await fresh.hello();
    await typeTitle(fresh, 'Z');
    expect(fresh.closed, "another socket's writes never count against this one").toBeNull();
    expect(opened.dobj.document.getText('title').toString()).toBe(`${'a'.repeat(300)}Z`);
  });

  it("never acks a viewer's inert step 2", async () => {
    const { viewer } = await sharedDoc();
    await viewer.hello();
    vi.advanceTimersByTime(250);
    await viewer.pump();
    expect(viewer.events).toEqual([]);
  });

  it('closes 4420 past 300 writes in 5 s and does not apply the overflow frame', async () => {
    const opened = openDoc();
    const editor = await editorOn(opened);
    for (let i = 0; i < 300; i += 1) await typeTitle(editor, 'a');
    expect(editor.closed).toBeNull();
    await typeTitle(editor, 'Z');
    expect(editor.closed?.code).toBe(CLOSE.writeRate);
    expect(opened.dobj.document.getText('title').toString()).toBe('a'.repeat(300));
  });

  it('refuses a write past the state cap with doc-cap and closes 4409', async () => {
    class SmallDoc extends DocDO {
      static override limits = { ...DocDO.limits, stateCapBytes: 64 * 1024 };
    }
    const opened = openDoc(new Backing(), SmallDoc as never);
    const editor = await editorOn(opened);
    await typeTitle(editor, 'a'.repeat(32 * 1024));
    expect(editor.closed).toBeNull();
    await typeTitle(editor, 'b'.repeat(40 * 1024));
    expect(editor.events).toContainEqual({ t: 'write-refused', reason: 'doc-cap' });
    expect(editor.closed?.code).toBe(CLOSE.writeRefused);
    expect(opened.dobj.document.getText('title').toString()).toBe('a'.repeat(32 * 1024));
  });

  it('closes 4401 without a principal and 4429 for a 51st connection', async () => {
    const opened = await start(openDoc());
    const anonymous = await connect(opened, { id: null });
    expect(anonymous.closed?.code).toBe(CLOSE.noPrincipal);
    const held: TestClient[] = [];
    for (let i = 0; i < 50; i += 1) held.push(await connect(opened));
    expect(held.every((c) => c.closed === null)).toBe(true);
    const extra = await connect(opened);
    expect(extra.closed?.code).toBe(CLOSE.connectionLimit);
  });

  it('closes 4402 for an ended session, 4403 for a revoked principal or token, 4410 for a deleted doc', async () => {
    const opened = await start(openDoc());
    const at = Date.now();
    opened.backing.query('INSERT INTO revocations (kind, id, at) VALUES (?, ?, ?)', 'session', 'session-ended', at);
    opened.backing.query('INSERT INTO revocations (kind, id, at) VALUES (?, ?, ?)', 'principal', 'user-revoked', at);
    opened.backing.query('INSERT INTO revocations (kind, id, at) VALUES (?, ?, ?)', 'token', 'token-revoked', at);
    const woken = await start(wake(opened));
    expect((await connect(woken, { session: 'session-ended' })).closed?.code).toBe(CLOSE.sessionEnded);
    expect((await connect(woken, { id: 'user-revoked' })).closed?.code).toBe(CLOSE.revoked);
    const anonymous = { kind: 'anonymous', id: 'anonymous', role: 'viewer', session: null, share: 'token-revoked' } as const;
    expect((await connect(woken, anonymous)).closed?.code).toBe(CLOSE.revoked);
    expect((await connect(woken)).closed).toBeNull();

    woken.backing.query("INSERT OR REPLACE INTO meta (key, value) VALUES ('deleted', '1')");
    const deleted = await start(wake(woken));
    expect((await connect(deleted)).closed?.code).toBe(CLOSE.deleted);
  });
});

describe('RPC', () => {
  it('replays before an RPC reads, while probeInstance runs no onStart', async () => {
    const opened = openDoc();
    const client = await connect(opened, { role: 'editor' });
    const lexical = bindLexical(client.doc);
    await client.hello();
    lexical.type('Persisted body');
    await client.flush();
    const firstProbe = opened.dobj.probeInstance();

    const cold = wake(opened);
    const probe = cold.dobj.probeInstance();
    expect(probe.instanceId).not.toBe(firstProbe.instanceId);
    expect(probe.constructedAt).toBeGreaterThanOrEqual(firstProbe.constructedAt);
    expect(cold.dobj.document.get('root', Y.XmlText).length, 'the probe loads nothing').toBe(0);
    expect((await cold.dobj.exportMarkdown()).trim()).toBe('Persisted body');

    client.opened = cold;
    lexical.type(' and more');
    await client.flush();
    expect((await cold.dobj.exportMarkdown()).trim()).toBe('Persisted body and more');
  });

  it('trash() persists the deleted flag, tells every socket the doc is gone, closes them 4410 and refuses new ones after a wake', async () => {
    const opened = await start(openDoc());
    const editor = await editorOn(opened);
    const viewer = await connect(opened, { role: 'viewer' });
    await viewer.hello();
    await opened.dobj.trash();
    await editor.pump();
    await viewer.pump();
    for (const client of [editor, viewer]) {
      expect(client.events).toContainEqual({ t: 'doc-deleted' });
      expect(client.closed?.code).toBe(CLOSE.deleted);
    }
    await opened.dobj.trash();
    const woken = await start(wake(opened));
    expect((await connect(woken, { role: 'editor' })).closed?.code, 'a woken doc remembers').toBe(CLOSE.deleted);
  });
});
