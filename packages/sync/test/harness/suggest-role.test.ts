// T5.0 spike, test 1 (docs/design/suggestions.md I1): every forged frame from the six review rounds and the commit
// security reviews, sent as a suggester's body frame, is refused by role before Yjs applies it. Authorization reads
// the connection's role, never the frame, so the body's encoded state is byte-identical afterwards.
import * as encoding from 'lib0/encoding';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { CLOSE } from '@moss-multi/protocol/sync';
import { connect, openDoc, start, syncFrame } from './do-harness.ts';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

const SEED = ['Hello world and the cat.', '', 'abc', '', 'XYZ', '', '```js', 'seed', '```', '', 'Total {{1+1|2}} items.'].join('\n');

interface Span {
  client: number;
  clock: number;
  len: number;
}

const root = (doc: Y.Doc) => doc.get('root', Y.XmlText);
const firstBlock = (doc: Y.Doc): Y.XmlText => (root(doc)._start!.content as Y.ContentType).type as Y.XmlText;

/** The first original text item of the first paragraph. */
function helloItem(doc: Y.Doc): Y.Item {
  for (let item = firstBlock(doc)._start; item; item = item.right) if (item.content instanceof Y.ContentString) return item;
  throw new Error('no text');
}

function decorator(doc: Y.Doc, type: string): Y.XmlElement {
  const find = (parent: Y.XmlText): Y.XmlElement | null => {
    for (const op of parent.toDelta() as { insert: unknown }[]) {
      if (op.insert instanceof Y.XmlElement && op.insert.getAttribute('__type') === type) return op.insert;
      if (op.insert instanceof Y.XmlText) {
        const found = find(op.insert);
        if (found) return found;
      }
    }
    return null;
  };
  const found = find(root(doc));
  if (!found) throw new Error(`no ${type}`);
  return found;
}

/** A raw V1 update: one GC struct per entry, then a delete set of one range per entry. */
function rawUpdate(gcs: Span[], deletes: Span[]): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, gcs.length);
  for (const gc of gcs) {
    encoding.writeVarUint(encoder, 1);
    encoding.writeVarUint(encoder, gc.client);
    encoding.writeVarUint(encoder, gc.clock);
    encoding.writeUint8(encoder, 0);
    encoding.writeVarUint(encoder, gc.len);
  }
  encoding.writeVarUint(encoder, deletes.length);
  for (const range of deletes) {
    encoding.writeVarUint(encoder, range.client);
    encoding.writeVarUint(encoder, 1);
    encoding.writeVarUint(encoder, range.clock);
    encoding.writeVarUint(encoder, range.len);
  }
  return encoding.toUint8Array(encoder);
}

/** Re-encodes structs and a delete set as a V1 update, each client's structs from its first clock. */
function encodeFrame(structs: readonly Y.Item[], deletes: readonly Span[]): Uint8Array {
  const encoder = new Y.UpdateEncoderV1();
  const byClient = new Map<number, Y.Item[]>();
  for (const struct of structs) byClient.set(struct.id.client, [...(byClient.get(struct.id.client) ?? []), struct]);
  encoding.writeVarUint(encoder.restEncoder, byClient.size);
  for (const [client, list] of byClient) {
    encoding.writeVarUint(encoder.restEncoder, list.length);
    encoder.writeClient(client);
    encoding.writeVarUint(encoder.restEncoder, list[0].id.clock);
    for (const struct of list) struct.write(encoder, 0);
  }
  encoding.writeVarUint(encoder.restEncoder, deletes.length);
  for (const span of deletes) {
    encoding.writeVarUint(encoder.restEncoder, span.client);
    encoding.writeVarUint(encoder.restEncoder, 1);
    encoding.writeVarUint(encoder.restEncoder, span.clock);
    encoding.writeVarUint(encoder.restEncoder, span.len);
  }
  return encoder.toUint8Array();
}

/** What `write` does to a copy of the server's doc, as one update. */
function forge(server: Y.Doc, write: (doc: Y.Doc) => void, client?: number): Uint8Array {
  const doc = new Y.Doc({ gc: false });
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(server));
  if (client !== undefined) doc.clientID = client;
  const sv = Y.encodeStateVector(doc);
  write(doc);
  const update = Y.encodeStateAsUpdate(doc, sv);
  doc.destroy();
  return update;
}

const textMap = (format: number) => new Y.Map<unknown>(Object.entries({ __type: 'text', __format: format, __style: '', __mode: 0, __detail: 0 }));

const FORGED: [string, (server: Y.Doc) => Uint8Array][] = [
  ['a GC overlapping known clocks that hides a delete of original text', (server) => {
    const hello = helloItem(server);
    const S = hello.id.client;
    return rawUpdate([{ client: S, clock: 0, len: Y.getState(server.store, S) + 1 }], [{ client: S, clock: hello.id.clock, len: 5 }]);
  }],
  ['a clock gap that would park', (server) => {
    const doc = new Y.Doc();
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(server));
    doc.getMap('scratch').set('first', 1);
    const sv = Y.encodeStateVector(doc);
    firstBlock(doc).insert(3, 'x');
    return Y.encodeStateAsUpdate(doc, sv);
  }],
  ["a write under another writer's client id", (server) => forge(server, (doc) => firstBlock(doc).insert(3, 'x'), helloItem(server).id.client)],
  ['a tombstone placed after an original map value', (server) => {
    const map = firstBlock(server)._start!;
    const encoder = new Y.UpdateEncoderV1();
    encoding.writeVarUint(encoder.restEncoder, 1);
    encoding.writeVarUint(encoder.restEncoder, 1);
    encoder.writeClient(424243);
    encoding.writeVarUint(encoder.restEncoder, 0);
    const origin = (map.content as Y.ContentType).type._map.get('__format')!.id;
    new Y.Item(Y.createID(424243, 0), null, origin, null, null, null, null, new Y.ContentDeleted(1)).write(encoder, 0);
    encoding.writeVarUint(encoder.restEncoder, 0);
    return encoder.toUint8Array();
  }],
  ['a formatting mark in the body', (server) => forge(server, (doc) => firstBlock(doc).format(1, 5, { bold: true }))],
  ['a same-value attribute write', (server) => forge(server, (doc) => firstBlock(doc).setAttribute('__type', 'paragraph'))],
  ['a same-value write the frame also deletes', (server) => forge(server, (doc) => doc.transact(() => {
    firstBlock(doc).setAttribute('__type', 'paragraph');
    firstBlock(doc).removeAttribute('__type');
  }))],
  ['a same-value write ordered before the live value, deleting it', (server) => {
    const block = root(server)._start!;
    const live = (block.content as Y.ContentType).type._map.get('__type')!;
    const item = new Y.Item(Y.createID(1, 0), null, live.origin, null, null, live.origin ? null : block.id, live.origin ? null : '__type', new Y.ContentAny(['paragraph']));
    return encodeFrame([item], [{ client: live.id.client, clock: live.id.clock, len: 1 }]);
  }],
  ['a text map placed before original text', (server) => forge(server, (doc) => firstBlock(doc).insertEmbed(1, textMap(1)))],
  ['a new text map behind new characters', (server) => forge(server, (doc) => doc.transact(() => {
    firstBlock(doc).insert(8, 'X');
    firstBlock(doc).insertEmbed(8, textMap(1));
  }))],
  ['a recursive delete of a block', (server) => forge(server, (doc) => root(doc).delete(0, 1))],
  ["a register's Y.Text edited", (server) => forge(server, (doc) => {
    const key = String(decorator(doc, 'code-block').getAttribute('__regId'));
    (doc.getMap('registers').get(key) as Y.Text).insert(0, 'forged ');
  })],
  ['a Y.Map register leg written', (server) => forge(server, (doc) => {
    const map = new Y.Map<unknown>();
    doc.getMap('registers').set('forged', map);
    map.set('cell', 1);
  })],
  ['a decorator __regId retargeted', (server) => forge(server, (doc) => decorator(doc, 'code-block').setAttribute('__regId', 'elsewhere'))],
  ['a forged split moving original text past an untouched block', (server) => forge(server, (doc) => doc.transact(() => {
    const abc = (root(doc).toDelta() as { insert: Y.XmlText }[])[1].insert;
    abc.delete(abc.length - 2, 2);
    const copy = new Y.XmlText();
    copy.setAttribute('__type', 'paragraph');
    root(doc).insertEmbed(root(doc).length, copy);
    copy.insert(0, 'bc');
  }))],
  ['a title write', (server) => forge(server, (doc) => doc.getText('title').insert(0, 'Forged '))],
  ['a suggestions record write', (server) => forge(server, (doc) => doc.getMap('suggestions').set('forged', 'accepted'))],
];

describe('T5.0 a suggester body frame is refused by role @p:mean-2', () => {
  it.each(FORGED)('%s', async (_name, make) => {
    const opened = await start(openDoc());
    await opened.dobj.create({ folderId: 'folder-1', ownerId: 'owner-1', markdown: SEED });
    const before = Y.encodeStateAsUpdate(opened.dobj.document);
    const suggester = await connect(opened, { role: 'suggester' });
    await suggester.hello();
    const forged = make(opened.dobj.document);
    expect(forged.byteLength).toBeGreaterThan(2);
    await suggester.deliver(syncFrame(2, forged));
    await suggester.pump();
    expect(suggester.events).toContainEqual({ t: 'write-refused', reason: 'role' });
    expect(suggester.closed?.code).toBe(CLOSE.revoked);
    expect(Y.encodeStateAsUpdate(opened.dobj.document)).toEqual(before);
  });
});
