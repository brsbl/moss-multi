// j15-comments-guard (T4.1; docs/design/comments.md §3): gate 2b and the pending purge in the real DocDO in workerd.
// A note imported with marker comments gets raw sync frames over a real doc socket: an R struct, a comments write, an
// inert step 2 carrying R's structs, and a frame Yjs parks. Each is refused 4409, the comments map is unchanged, and
// the parked struct is never released by the later frame that supplies what it waited on.
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import * as Y from 'yjs';
import { DOC_SOCKET_PATH } from '../../packages/protocol/src/dom-contract.ts';
import { CLOSE } from '../../packages/protocol/src/sync.ts';
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

test('j15-comments-guard: no client frame lands a write in comments, and nothing parked survives, in workerd @p:tech-3', async ({ actors, stack }) => {
  actors.solo('one editor sends raw frames; the guard refuses by struct, never by who else is connected');
  const ada = await actors.principal('ada');
  const cookie = cookieHeader(await signIn(stack.baseUrl, ada));
  const response = await fetch(`${stack.baseUrl}/api/docs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: stack.baseUrl, cookie },
    body: JSON.stringify({ markdown: SEED, comments: SIDECAR }),
    signal: AbortSignal.timeout(15_000),
  });
  const created = await response.text();
  expect(response.status, `POST /api/docs: ${created.slice(0, 200)}`).toBe(201);
  const docId = (JSON.parse(created) as { doc: { id: string } }).doc.id;

  const first = await openDocClient(stack.baseUrl, docId, cookie);
  const doc = await (async () => {
    try {
      await first.synced;
      return copyOf(first.doc);
    } finally {
      first.close();
    }
  })();
  const comments = doc.getMap('comments');
  const before = comments.toJSON();
  expect(Object.keys(before).sort(), 'the import wrote both threads').toEqual(['a:c1', 'a:c2', 'c:c1', 'c:c2']);
  const r = comments._map.get('c:c1')!.id.client;

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

  // A frame whose struct waits on an item the server lacks parks, is purged and refused; the frame that later
  // supplies the missing item lands alone.
  const held = copyOf(doc);
  held.getText('title').insert(0, 'a');
  const title = held.getText('title').toString();
  const later = copyOf(held);
  later.getText('title').insert(1, 'b');
  expect.soft(await sendRaw(stack.baseUrl, docId, cookie, syncMessage(2, diff(later, held))), 'a frame Yjs parks').toBe(CLOSE.writeRefused);
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
