// j15-comments-guard (T4.1; docs/design/comments.md §3): gate 2b and the pending purge in the real DocDO in workerd.
// A note imported with marker comments gets raw sync frames over a real doc socket: an R struct, a comments write, an
// inert step 2 carrying R's structs, and a frame with a missing dependency. The guard violations are refused 4409; the
// missing dependency is closed 4420 before apply (transient). The comments map is unchanged, and nothing parks: the
// struct is never released by the later frame that supplies what it waited on. The Node harness's history fixtures
// (tail splices, a fully held struct, a missing right origin, parent cycles, a self-parent) each run on their own note,
// checked live and again after the DocDO is reset.
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import * as Y from 'yjs';
import { DOC_SOCKET_PATH } from '../../packages/protocol/src/dom-contract.ts';
import { CLOSE } from '../../packages/protocol/src/sync.ts';
import { forged, raw } from '../../packages/sync/test/harness/raw-frames.ts';
import { cookieHeader, openDocClient } from '../lib/doc-client.ts';
import { signIn } from '../lib/principals.ts';
import { expect, test } from '../lib/test.ts';

const SEED = 'The %%m:c1:start%%quick brown%%m:c1:end%% fox jumps over the %%m:c2:start%%lazy dog%%m:c2:end%%.';
const SIDECAR = {
  c1: { text: 'first', createdAt: 1_700_000_000, updatedAt: 1_700_000_000, source: 'user' },
  c2: { text: 'second', createdAt: 1_700_000_001, updatedAt: 1_700_000_001, source: 'user' },
};

const copyOf = (doc: Y.Doc) => {
  const copy = new Y.Doc();
  Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc));
  return copy;
};
const diff = (from: Y.Doc, to: Y.Doc) => Y.encodeStateAsUpdate(from, Y.encodeStateVector(to));

function varUint(n: number): number[] {
  const out: number[] = [];
  while (n > 0x7f) {
    out.push(0x80 | (n & 0x7f));
    n = Math.floor(n / 128);
  }
  out.push(n);
  return out;
}

/** A y-protocols sync message: kind 1 is a step 2, kind 2 an update. */
function syncMessage(kind: 1 | 2, update: Uint8Array): Uint8Array {
  return Uint8Array.from([0, kind, ...varUint(update.byteLength), ...update]);
}

/** Opens a doc socket, sends `frame` once the server has spoken, and resolves with the close code (null: still open after 3 s). */
function sendRaw(baseUrl: string, docId: string, cookie: string, frame: Uint8Array): Promise<number | null> {
  const url = `${baseUrl.replace(/^http/, 'ws')}${DOC_SOCKET_PATH}${encodeURIComponent(docId)}?_pk=raw-${randomUUID()}`;
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { headers: { origin: baseUrl, cookie } });
    let sent = false;
    let quiet: NodeJS.Timeout | null = null;
    const deadline = setTimeout(() => {
      socket.terminate();
      reject(new Error('the doc socket never spoke'));
    }, 15_000);
    socket.on('error', () => {});
    socket.on('message', () => {
      if (sent) return;
      sent = true;
      socket.send(frame);
      quiet = setTimeout(() => {
        clearTimeout(deadline);
        socket.close(1000);
        resolve(null);
      }, 3_000);
    });
    socket.on('close', (code) => {
      clearTimeout(deadline);
      if (quiet) clearTimeout(quiet);
      if (sent) resolve(code === 1000 ? null : code);
    });
  });
}

/** A copy of the doc as the server holds it now. */
async function snapshot(baseUrl: string, docId: string, cookie: string): Promise<Y.Doc> {
  const client = await openDocClient(baseUrl, docId, cookie);
  try {
    await client.synced;
    return copyOf(client.doc);
  } finally {
    client.close();
  }
}

/** A note imported with SEED's two threads: its id, a synced copy, its comments and the reserved writer R. */
async function seeded(baseUrl: string, cookie: string) {
  const response = await fetch(`${baseUrl}/api/docs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: baseUrl, cookie },
    body: JSON.stringify({ markdown: SEED, comments: SIDECAR }),
    signal: AbortSignal.timeout(15_000),
  });
  const created = await response.text();
  expect(response.status, `POST /api/docs: ${created.slice(0, 200)}`).toBe(201);
  const docId = (JSON.parse(created) as { doc: { id: string } }).doc.id;
  const doc = await snapshot(baseUrl, docId, cookie);
  const comments = doc.getMap('comments');
  const before = comments.toJSON();
  expect(Object.keys(before).sort(), 'the import wrote both threads').toEqual(['a:c1', 'a:c2', 'c:c1', 'c:c2']);
  return { docId, doc, before, r: comments._map.get('c:c1')!.id.client };
}

test('j15-comments-guard: no client frame lands a write in comments, and nothing parked survives, in workerd @p:tech-3', async ({ actors, stack }) => {
  actors.solo('one editor sends raw frames; the guard refuses by struct, never by who else is connected');
  const ada = await actors.principal('ada');
  const cookie = cookieHeader(await signIn(stack.baseUrl, ada));
  const { docId, doc, before, r } = await seeded(stack.baseUrl, cookie);

  const refused: [string, Uint8Array][] = [
    ['an Item of client R', (() => {
      const forger = copyOf(doc);
      forger.clientID = r;
      forger.getText('title').insert(0, 'x');
      return diff(forger, doc);
    })()],
    ['a new comments record', (() => {
      const writer = copyOf(doc);
      writer.getMap('comments').set('c:forged', { text: 'mine' });
      return diff(writer, doc);
    })()],
    ['an overwrite of an R record', (() => {
      const writer = copyOf(doc);
      writer.getMap('comments').set('c:c1', { text: 'replaced' });
      return diff(writer, doc);
    })()],
    ['a delete of a live R record', (() => {
      const eraser = copyOf(doc);
      eraser.getMap('comments').delete('c:c2');
      return diff(eraser, doc);
    })()],
  ];
  for (const [name, update] of refused) {
    expect.soft(await sendRaw(stack.baseUrl, docId, cookie, syncMessage(2, update)), name).toBe(CLOSE.writeRefused);
  }
  expect.soft(await sendRaw(stack.baseUrl, docId, cookie, syncMessage(1, Y.encodeStateAsUpdate(doc))), "an inert step 2 carrying R's structs").toBe(CLOSE.writeRefused);

  // A frame whose struct waits on an item the server lacks is closed 4420 before apply, so nothing parks; the frame
  // that later supplies the missing item lands alone.
  const held = copyOf(doc);
  held.getText('title').insert(0, 'a');
  const title = held.getText('title').toString();
  const later = copyOf(held);
  later.getText('title').insert(1, 'b');
  expect.soft(await sendRaw(stack.baseUrl, docId, cookie, syncMessage(2, diff(later, held))), 'a frame with a missing dependency').toBe(CLOSE.writeRate);
  expect.soft(await sendRaw(stack.baseUrl, docId, cookie, syncMessage(2, diff(held, doc))), 'the frame it waited on is admitted').toBeNull();

  const reopened = await openDocClient(stack.baseUrl, docId, cookie);
  try {
    await reopened.synced;
    expect(reopened.doc.getMap('comments').toJSON(), 'comments unchanged').toEqual(before);
    expect(reopened.doc.getText('title').toString(), 'the parked struct was never released').toBe(title);
    for (const item of reopened.doc.getMap('comments')._map.values()) expect(item.id.client, 'every record is R').toBe(r);
  } finally {
    reopened.close();
  }
});

const rootStart = (doc: Y.Doc) => doc.get('root', Y.XmlText)._start!.id;
const recordIds = (doc: Y.Doc) => new Map([...doc.getMap('comments')._map].map(([key, item]) => [key, `${item.id.client}:${item.id.clock}`]));

/** A raw-frame fixture: what it sends to a fresh copy of SEED and the close each frame gets (null: admitted; undefined: unchecked). */
interface Fixture {
  name: string;
  frames: (doc: Y.Doc, r: number) => [frame: Uint8Array, close: number | null | undefined, what: string][];
  /** Clients whose structs must never integrate. */
  never: number[];
}

// The Node harness's history fixtures (comments-docdo.test.ts), sent to the real DocDO in workerd.
const FIXTURES: Fixture[] = [
  {
    name: "tail splices at R's and the server's latest clocks",
    frames: (doc, r) => {
      const s = rootStart(doc).client;
      return [
        [raw([forged(Y.createID(r, Y.getState(doc.store, r) - 1), { origin: rootStart(doc) }, new Y.ContentAny([{ text: 'plain' }, { text: 'FORGED' }]))]), CLOSE.writeRefused, "a splice at R's tail"],
        // The server's latest body write is never a comment: whatever Yjs makes of the tail, it lands outside comments.
        [raw([forged(Y.createID(s, Y.getState(doc.store, s) - 1), { parent: 'frontmatter', sub: 'k' }, new Y.ContentAny(['e', 'x']))]), undefined, "a splice at the import's tail"],
      ];
    },
    never: [],
  },
  {
    name: 'a fully held struct with a forged missing origin',
    frames: (doc) => {
      const s = rootStart(doc).client;
      const at = Y.getState(doc.store, s);
      return [
        [raw([
          forged(Y.createID(s, at - 1), { origin: Y.createID(5150, 0) }, new Y.ContentString('e')),
          forged(Y.createID(s, at), { origin: rootStart(doc) }, new Y.ContentAny(['held tail'])),
        ]), CLOSE.writeRate, 'the held frame'],
        [raw([forged(Y.createID(5150, 0), { parent: 'frontmatter', sub: 'z' }, new Y.ContentAny(['z']))]), null, 'the frame it waited on'],
      ];
    },
    never: [],
  },
  {
    name: 'a missing right origin beside a held left origin',
    frames: (doc, r) => [
      [raw([forged(Y.createID(777, 0), { origin: rootStart(doc), right: Y.createID(r, Y.getState(doc.store, r)) }, new Y.ContentString('x'))]), CLOSE.writeRefused, "a right origin at R's next clock"],
      [raw([forged(Y.createID(778, 0), { origin: rootStart(doc), right: Y.createID(6160, 0) }, new Y.ContentString('x'))]), CLOSE.writeRate, 'a missing right origin'],
      [raw([forged(Y.createID(6160, 0), { parent: 'frontmatter', sub: 'y' }, new Y.ContentAny(['y']))]), null, 'the frame it waited on'],
    ],
    never: [777, 778],
  },
  {
    name: 'a self-parented struct, parent cycles and right origins that name each other',
    frames: (doc) => [
      [raw([forged(Y.createID(777, 0), { parent: Y.createID(777, 0) }, new Y.ContentType(new Y.Map()))]), CLOSE.writeRefused, 'a self-parented struct'],
      [raw([
        forged(Y.createID(778, 0), { parent: Y.createID(778, 1) }, new Y.ContentType(new Y.Map())),
        forged(Y.createID(778, 1), { parent: Y.createID(778, 0) }, new Y.ContentType(new Y.Map())),
      ]), CLOSE.writeRefused, 'a parent cycle'],
      [raw([
        forged(Y.createID(779, 0), { origin: rootStart(doc), right: Y.createID(780, 0) }, new Y.ContentString('a')),
        forged(Y.createID(780, 0), { origin: rootStart(doc), right: Y.createID(779, 0) }, new Y.ContentString('b')),
      ]), CLOSE.writeRefused, 'right origins that name each other'],
    ],
    never: [777, 778, 779, 780],
  },
];

for (const fixture of FIXTURES) {
  test(`j15-comments-guard: ${fixture.name} land nothing in comments, park nothing, and stay so after a DocDO reset @p:tech-3`, async ({ actors, stack }) => {
    actors.solo('one editor sends raw frames; the guard refuses by struct, never by who else is connected');
    const ada = await actors.principal('ada');
    const cookie = cookieHeader(await signIn(stack.baseUrl, ada));
    const { docId, doc, before, r } = await seeded(stack.baseUrl, cookie);
    const records = recordIds(doc);
    for (const [frame, close, what] of fixture.frames(doc, r)) {
      const code = await sendRaw(stack.baseUrl, docId, cookie, syncMessage(2, frame));
      if (close !== undefined) expect.soft(code, what).toBe(close);
    }
    const check = async (when: string) => {
      const now = await snapshot(stack.baseUrl, docId, cookie);
      expect(now.getMap('comments').toJSON(), `${when}: comments unchanged`).toEqual(before);
      expect(recordIds(now), `${when}: the same reserved-writer records`).toEqual(records);
      for (const item of now.getMap('comments')._map.values()) expect(item.id.client, `${when}: every record is R`).toBe(r);
      for (const client of fixture.never) expect(now.store.clients.has(client), `${when}: client ${client} never integrates`).toBe(false);
      const bytes = Buffer.from(Y.encodeStateAsUpdate(now));
      for (const marker of ['FORGED', 'held tail']) expect(bytes.includes(marker), `${when}: "${marker}" never lands or is released`).toBe(false);
      now.destroy();
    };
    await check('live');
    const base = await stack.docInstance(docId);
    await stack.resetDoc(docId);
    await check('after a reset');
    expect((await stack.docInstance(docId)).instanceId, 'a new DocDO instance served the reopen').not.toBe(base.instanceId);
  });
}
