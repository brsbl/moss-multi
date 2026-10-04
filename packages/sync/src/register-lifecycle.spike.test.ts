// T1.R spike (docs/design/registers.md): the decorator payload lifecycle under delete, move, undo, join and offline
// peers. A prototype keeps each payload where M1 keeps it, a Y.Text in Y.Map('registers') under the block's stable id,
// so a V1 move (delete + recreate of the element) never touches it. Clients only create payloads (the creator, in the
// element's own transaction) and edit them. The server's janitor alone deletes and restores payload text: it reclaims
// text no live element names into a private trash, revives it when an element names it again, and keeps one element
// per id. The "M1 map" cases at the end characterize the current model for comparison.
import { createHeadlessEditor } from '@lexical/headless';
import { createBinding, syncLexicalUpdateToYjs, syncYjsChangesToLexical, type Binding, type Provider } from '@lexical/yjs';
import {
  $createParagraphNode, $createTextNode, $getNodeByKey, $getRoot, $isElementNode, $isParagraphNode, $isTextNode,
  DecoratorNode, ElementNode, type LexicalNode, type NodeKey, type SerializedLexicalNode,
} from 'lexical';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { createConverterEditor, exportMarkdown } from './converter/index.ts';
import { excludedPropertiesFor } from './excluded-properties.ts';
import { bindRegisters } from './registers.ts';
import { exportDocMarkdown, importBody } from './server-doc.ts';

const noop = () => {};
const provider = {
  awareness: { getLocalState: () => null, getStates: () => new Map(), on: noop, off: noop, setLocalState: noop, setLocalStateField: noop },
  connect: noop, disconnect: noop, on: noop, off: noop,
} as unknown as Provider;
const contains = (doc: Y.Doc, text: string) => Buffer.from(Y.encodeStateAsUpdate(doc)).includes(Buffer.from(text));
/** Sends what `to` lacks from `from`, as one sync step 2. */
const send = (from: Y.Doc, to: Y.Doc) => Y.applyUpdate(to, Y.encodeStateAsUpdate(from, Y.encodeStateVector(to)), 'remote');

// ---------------------------------------------------------------- nodes: a block payload, an inline one, a container

type SerializedBlock = SerializedLexicalNode & { blockId: string };
class SpikeBlock extends DecoratorNode<null> {
  __blockId: string;
  static getType(): string { return 'spike-block'; }
  static clone(node: SpikeBlock): SpikeBlock { return new SpikeBlock(node.__blockId, node.__key); }
  static importJSON(): SpikeBlock { return new SpikeBlock(crypto.randomUUID()); }
  constructor(blockId = '', key?: NodeKey) { super(key); this.__blockId = blockId; }
  exportJSON(): SerializedBlock { return { ...super.exportJSON(), blockId: this.__blockId }; }
  createDOM(): never { throw new Error('headless'); }
  updateDOM(): false { return false; }
  decorate(): null { return null; }
  isInline(): boolean { return false; }
}
/** A formula: an inline payload inside a paragraph. */
class SpikeInline extends SpikeBlock {
  static getType(): string { return 'spike-inline'; }
  static clone(node: SpikeInline): SpikeInline { return new SpikeInline(node.__blockId, node.__key); }
  static importJSON(): SpikeInline { return new SpikeInline(crypto.randomUUID()); }
  isInline(): boolean { return true; }
}
/** A container (a list item, callout or table cell) holding a block payload. */
class SpikeBox extends ElementNode {
  static getType(): string { return 'spike-box'; }
  static clone(node: SpikeBox): SpikeBox { return new SpikeBox(node.__key); }
  static importJSON(): SpikeBox { return new SpikeBox(); }
  createDOM(): never { throw new Error('headless'); }
  updateDOM(): false { return false; }
}
const PAYLOAD_TYPES = new Set(['spike-block', 'spike-inline']);
const isPayloadNode = (node: LexicalNode | null | undefined): node is SpikeBlock => node instanceof SpikeBlock;

// ---------------------------------------------------------------- the client: create, edit, undo; never delete

const PAYLOAD_LOCAL = Symbol('payload-local');

function payloadClient(state: Uint8Array) {
  const doc = new Y.Doc();
  const errors: unknown[] = [];
  const editor = createHeadlessEditor({ nodes: [SpikeBlock, SpikeInline, SpikeBox], onError: (error) => { errors.push(error); } });
  const binding = createBinding(editor, provider, 'root', doc, new Map([['root', doc]]), new Map());
  const root = binding.root.getSharedType();
  const registers = doc.getMap<Y.Text>('registers');
  // What this client sends: one incremental update per local transaction, as the provider does while connected.
  const outbox: Uint8Array[] = [];
  const queue = (update: Uint8Array, origin: unknown) => { if (origin !== 'remote') outbox.push(update); };
  doc.on('update', queue);

  // Rule 2: a payload is created only by the client that minted its id, inside the transaction that creates its
  // element, so a peer never sees one without the other and never creates a second. Minting drives this, not dirty
  // leaves, so a payload inside a new container or paragraph is covered.
  const minted = new Map<NodeKey, string>();
  const mint = <T extends SpikeBlock>(node: T, text: string): T => { minted.set(node.getKey(), text); return node; };
  const stopUpdates = editor.registerUpdateListener(({ prevEditorState, editorState, dirtyElements, dirtyLeaves, normalizedNodes, tags }) => {
    doc.transact(() => {
      syncLexicalUpdateToYjs(binding, provider, prevEditorState, editorState, dirtyElements, dirtyLeaves, normalizedNodes, tags);
      if (!minted.size) return;
      editorState.read(() => {
        for (const [key, text] of minted) {
          const node = $getNodeByKey(key);
          if (!isPayloadNode(node) || !node.isAttached()) continue;
          if (!registers.has(node.__blockId)) registers.set(node.__blockId, new Y.Text(text));
          minted.delete(key);
        }
      });
    }, binding);
  });

  // Payload edits are events on `registers`, never on the V1 root, so the official observer is untouched.
  const observer: Parameters<Y.XmlText['observeDeep']>[0] = (events, transaction) => {
    if (transaction.origin !== binding) syncYjsChangesToLexical(binding, provider, events as never, false, noop);
  };
  root.observeDeep(observer);

  // Rule 5: an undo never deletes a payload entry. Undoing a creation removes the element (and the undoer's own
  // characters); the server reclaims the rest, and redo brings the element back for the server to revive.
  const undo = new Y.UndoManager([root, registers], {
    trackedOrigins: new Set<unknown>([binding, PAYLOAD_LOCAL]), captureTimeout: 0, deleteFilter: (item) => item.parent !== registers,
  });

  Y.applyUpdate(doc, state, 'remote');
  editor.update(noop, { discrete: true });

  const flush = () => {
    editor.update(noop, { discrete: true });
    if (errors.length) throw errors[0];
  };
  const read = <T>(fn: () => T): T => { flush(); return editor.getEditorState().read(fn); };
  const walk = (node: LexicalNode): SpikeBlock[] => isPayloadNode(node) ? [node] : $isElementNode(node) ? node.getChildren().flatMap(walk) : [];
  const payloadKeys = () => read(() => walk($getRoot()).map((node) => node.getKey()));
  const idOf = (key: NodeKey) => read(() => ($getNodeByKey(key) as SpikeBlock).__blockId);
  const payloadOf = (index: number) => {
    const text = registers.get(idOf(payloadKeys()[index]));
    if (!text) throw new Error('no payload');
    return text;
  };
  const update = (fn: () => void) => editor.update(fn, { discrete: true });
  return {
    doc, editor, binding, undo, errors, outbox,
    /** Each payload node's text, in document order (containers and paragraphs included). */
    texts: () => payloadKeys().map((key) => registers.get(idOf(key))?.toString() ?? '<none>'),
    /** The Yjs element ids behind the payload nodes: a V1 move gives a node a new element. */
    elements: () => payloadKeys().map((key) => {
      const element = (binding.collabNodeMap.get(key) as { _xmlElem?: Y.XmlElement } | undefined)?._xmlElem;
      return element?._item ? `${element._item.id.client}:${element._item.id.clock}` : '?';
    }),
    paragraphs: () => read(() => $getRoot().getChildren().filter($isParagraphNode).map((node) => node.getTextContent())),
    insertBlock: (text: string) => update(() => { $getRoot().getFirstChildOrThrow().insertAfter(mint(new SpikeBlock(crypto.randomUUID()), text)); }),
    insertInline: (text: string) => update(() => {
      $getRoot().getFirstChildOrThrow().insertAfter($createParagraphNode().append($createTextNode('Formula: '), mint(new SpikeInline(crypto.randomUUID()), text)));
    }),
    insertBoxed: (text: string) => update(() => { $getRoot().getFirstChildOrThrow().insertAfter(new SpikeBox().append(mint(new SpikeBlock(crypto.randomUUID()), text))); }),
    insertBlocks: (count: number) => update(() => {
      for (let i = 0; i < count; i++) $getRoot().getLastChildOrThrow().insertBefore(mint(new SpikeBlock(crypto.randomUUID()), `block ${i};`));
    }),
    insertParagraph: (text: string) => update(() => { $getRoot().getFirstChildOrThrow().insertAfter($createParagraphNode().append($createTextNode(text))); }),
    /** Appends to the paragraph whose text starts with `prefix` (ordinary V1 text, for the paragraph controls). */
    appendToParagraph: (prefix: string, text: string) => update(() => {
      const paragraph = $getRoot().getChildren().find((node) => $isParagraphNode(node) && node.getTextContent().startsWith(prefix));
      const last = $isElementNode(paragraph) ? paragraph.getLastChild() : null;
      if (!$isTextNode(last)) throw new Error(`no paragraph ${prefix}`);
      last.spliceText(last.getTextContentSize(), 0, text);
    }),
    /** Types into payload `index` at `at` (a register write: minimal ops under the local origin). */
    type: (index: number, at: number, text: string) => {
      const payload = payloadOf(index);
      doc.transact(() => payload.insert(Math.min(at, payload.length), text), PAYLOAD_LOCAL);
    },
    erase: (index: number, at: number, length: number) => {
      const payload = payloadOf(index);
      doc.transact(() => payload.delete(at, length), PAYLOAD_LOCAL);
    },
    remove: (index: number) => { const key = payloadKeys()[index]; update(() => { $getNodeByKey(key)!.remove(); }); },
    /** Moves the top-level block holding payload `index` to the end (V1 deletes its subtree and recreates it). */
    moveToEnd: (index: number) => {
      const key = payloadKeys()[index];
      update(() => { $getRoot().getLastChildOrThrow().insertAfter($getNodeByKey(key)!.getTopLevelElementOrThrow()); });
    },
    moveToStart: (index: number) => {
      const key = payloadKeys()[index];
      update(() => { $getRoot().getFirstChildOrThrow().insertBefore($getNodeByKey(key)!.getTopLevelElementOrThrow()); });
    },
    /** A local edit that touches the node without its payload (as a language change does). */
    touch: (index: number) => { const key = payloadKeys()[index]; update(() => { $getNodeByKey(key)!.getWritable(); }); },
    dispose: () => { stopUpdates(); root.unobserveDeep(observer); doc.off('update', queue); undo.destroy(); doc.destroy(); },
  };
}
type PayloadClient = ReturnType<typeof payloadClient>;

// ---------------------------------------------------------------- the server: the DocDO's doc (gc on, no undo) + janitor

const JANITOR = Symbol('janitor');
/** A run of payload text the janitor deleted, by the ids of its original characters. */
type Piece = { client: number; clock: number; text: string; seen: { client: number; clock: number } };

function payloadServer(state?: Uint8Array, { honorDeletes = true } = {}) {
  const doc = new Y.Doc();
  const root = doc.get('root', Y.XmlText);
  const registers = doc.getMap<Y.Text>('registers');
  const marker = doc.getMap<number>('janitor');
  const named = new Map<string, Set<Y.XmlElement>>();
  const ids = new WeakMap<Y.XmlElement, string>();
  const trash = new Map<string, Piece[]>();
  const touched = new Set<string>();
  const stats = { evaluated: 0, reclaimed: 0, revived: 0, deduped: 0 };

  // The index of live elements by id, kept from each transaction's own structs: the elements it integrated and the
  // ones it deleted, including every element inside a moved or deleted paragraph or container (Yjs deletes a subtree
  // item by item, and V1 recreates one the same way). Work is proportional to the transaction.
  const index = (item: Y.Item, live: boolean, janitor: boolean) => {
    if (!(item.content instanceof Y.ContentType) || !(item.content.type instanceof Y.XmlElement)) return;
    const element = item.content.type;
    const attr = element.getAttribute('__blockId') as unknown;
    const id = live ? (PAYLOAD_TYPES.has(String(element.getAttribute('__type'))) && typeof attr === 'string' ? attr : undefined) : ids.get(element);
    if (!id) return;
    let set = named.get(id);
    if (!set) named.set(id, set = new Set());
    const changed = live ? !set.has(element) : set.has(element);
    if (live) { set.add(element); ids.set(element, id); } else set.delete(element);
    if (changed && !janitor) touched.add(id);
  };
  doc.on('afterTransaction', (transaction: Y.Transaction) => {
    const janitor = transaction.origin === JANITOR;
    transaction.afterState.forEach((after, client) => {
      const before = transaction.beforeState.get(client) ?? 0;
      if (after === before) return;
      const structs = doc.store.clients.get(client) ?? [];
      for (let i = Y.findIndexSS(structs, before); i < structs.length; i++) {
        const struct = structs[i];
        if (struct instanceof Y.Item && !struct.deleted) index(struct, true, janitor);
      }
    });
    Y.iterateDeletedStructs(transaction, transaction.deleteSet, (struct) => { if (struct instanceof Y.Item) index(struct, false, janitor); });
  });
  registers.observeDeep((events, transaction) => {
    if (transaction.origin === JANITOR) return;
    for (const event of events) {
      if (event.target === registers) for (const id of (event as Y.YMapEvent<Y.Text>).keysChanged) touched.add(id);
      else if (typeof event.target._item?.parentSub === 'string') touched.add(event.target._item.parentSub);
    }
  });

  const order = (type: { _start: Y.Item | null }, out: Y.XmlElement[]): Y.XmlElement[] => {
    for (let item = type._start; item; item = item.right) {
      if (item.deleted || !(item.content instanceof Y.ContentType)) continue;
      const child: unknown = item.content.type;
      if (child instanceof Y.XmlElement) out.push(child);
      order(child as { _start: Y.Item | null }, out);
    }
    return out;
  };

  /** J1: no live element names the payload, so its text leaves the served state now and waits in private trash. */
  const reclaim = (id: string, payload: Y.Text) => {
    const pieces: Omit<Piece, 'seen'>[] = [];
    for (let item = payload._start; item; item = item.right) {
      if (!item.deleted && item.content instanceof Y.ContentString) pieces.push({ client: item.id.client, clock: item.id.clock, text: item.content.str });
    }
    if (!pieces.length) return;
    // A marker advances the server's clock, so a later sync step 2 shows whether its sender had seen this reclaim.
    marker.set('reclaims', (marker.get('reclaims') ?? 0) + 1);
    const seen = { client: doc.clientID, clock: Y.getState(doc.store, doc.clientID) };
    payload.delete(0, payload.length);
    trash.set(id, [...(trash.get(id) ?? []), ...pieces.map((piece) => ({ ...piece, seen }))]);
    stats.reclaimed++;
  };

  /** J2: an element names the payload again (an undo, a raced move): each run returns just before its own tombstone. */
  const revive = (transaction: Y.Transaction, id: string, payload: Y.Text) => {
    const pieces = trash.get(id);
    if (!pieces) return;
    trash.delete(id);
    pieces.sort((a, b) => a.client - b.client || a.clock - b.clock);
    for (let item = payload._start; item; item = item.right) {
      if (!item.deleted) continue;
      for (const piece of pieces) {
        if (piece.client !== item.id.client) continue;
        const from = Math.max(piece.clock, item.id.clock);
        const to = Math.min(piece.clock + piece.text.length, item.id.clock + item.length);
        if (from >= to) continue;
        // Split the tombstone where this piece starts, so a peer's later insert next to any character stays next to it.
        if (from > item.id.clock) item = Y.getItemCleanStart(transaction, Y.createID(item.id.client, from));
        const left: Y.Item | null = item.left;
        new Y.Item(Y.createID(doc.clientID, Y.getState(doc.store, doc.clientID)), left, left?.lastId ?? null, item, item.id, payload, null,
          new Y.ContentString(piece.text.slice(from - piece.clock, to - piece.clock))).integrate(transaction, 0);
      }
    }
    if (payload._searchMarker) payload._searchMarker.length = 0;
    stats.revived++;
  };

  /** J4: a peer's own deletion of characters the janitor had reclaimed is honored, so a revive never doubles them. */
  const honor = (ds: ReturnType<typeof Y.createDeleteSet>, senderState?: Map<number, number>) => {
    for (const [id, pieces] of trash) {
      const kept: Piece[] = [];
      for (const piece of pieces) {
        // A sync step 2 carries every deletion its sender knows, including the reclaim itself once it has seen it.
        if (senderState && (senderState.get(piece.seen.client) ?? 0) >= piece.seen.clock) { kept.push(piece); continue; }
        let start = -1;
        for (let i = 0; i <= piece.text.length; i++) {
          const keep = i < piece.text.length && !Y.isDeleted(ds, Y.createID(piece.client, piece.clock + i));
          if (keep && start < 0) start = i;
          if (!keep && start >= 0) { kept.push({ ...piece, clock: piece.clock + start, text: piece.text.slice(start, i) }); start = -1; }
        }
      }
      if (kept.length) trash.set(id, kept); else trash.delete(id);
    }
  };

  const run = () => {
    if (!touched.size) return;
    const work = [...touched];
    touched.clear();
    doc.transact((transaction) => {
      for (const id of work) {
        stats.evaluated++;
        const payload = registers.get(id);
        if (!(payload instanceof Y.Text)) continue;
        const live = named.get(id);
        if (!live?.size) { reclaim(id, payload); continue; }
        revive(transaction, id, payload);
        // J3: concurrent moves or restores left two elements for one id; keep the first in document order.
        if (live.size > 1) {
          for (const element of order(root, []).filter((element) => live.has(element)).slice(1)) {
            element._item!.delete(transaction);
            const parent = element.parent as Y.XmlText;
            if (parent._searchMarker) parent._searchMarker.length = 0;
            stats.deduped++;
          }
        }
      }
    }, JANITOR);
  };

  // J5: the load pass indexes the doc once and reclaims what no element names (M1 docs hold such orphans).
  if (state) {
    Y.applyUpdate(doc, state, 'load');
    for (const id of registers.keys()) touched.add(id);
    run();
  }
  return {
    doc, stats, trash,
    /** One client message: an incremental update, or a sync step 2 with its sender's state vector. */
    receive: (update: Uint8Array, senderState?: Map<number, number>) => {
      Y.applyUpdate(doc, update, 'client');
      if (honorDeletes) honor(Y.decodeUpdate(update).ds, senderState);
      run();
    },
  };
}
type PayloadServer = ReturnType<typeof payloadServer>;

const up = (server: PayloadServer, client: PayloadClient) => { for (const update of client.outbox.splice(0)) server.receive(update); };
const down = (server: PayloadServer, client: PayloadClient) => send(server.doc, client.doc);
const sync = (server: PayloadServer, ...clients: PayloadClient[]) => {
  for (const client of clients) up(server, client);
  for (const client of clients) down(server, client);
};
/** A reconnecting client: it sends a sync step 2 (all it has, every deletion it knows) instead of its queued updates. */
const reconnect = (server: PayloadServer, client: PayloadClient) => {
  client.outbox.length = 0;
  server.receive(Y.encodeStateAsUpdate(client.doc, Y.encodeStateVector(server.doc)), Y.decodeStateVector(Y.encodeStateVector(client.doc)));
  down(server, client);
};
const join = (server: PayloadServer) => payloadClient(Y.encodeStateAsUpdate(server.doc));

/** A server seeded with "Intro." and "Outro." paragraphs. */
function seededServer(): PayloadServer {
  const server = payloadServer();
  const seeder = payloadClient(Y.encodeStateAsUpdate(server.doc));
  seeder.editor.update(() => {
    $getRoot().append($createParagraphNode().append($createTextNode('Intro.')), $createParagraphNode().append($createTextNode('Outro.')));
  }, { discrete: true });
  up(server, seeder);
  seeder.dispose();
  return server;
}
function lateReader(server: PayloadServer): string[] {
  const late = join(server);
  try { return late.texts(); } finally { late.dispose(); }
}

describe('T1.R spike: payloads keyed by block id, deleted and restored only by the server @p:col-1 @p:col-3', () => {
  it('a deleted block\'s text leaves the served state, late readers and duplicates at once', () => {
    const server = seededServer();
    const ada = join(server);
    try {
      ada.insertBlock('SECRET-alpha');
      sync(server, ada);
      expect(contains(server.doc, 'SECRET-alpha'), 'positive control').toBe(true);
      ada.remove(0);
      sync(server, ada);
      expect(contains(server.doc, 'SECRET-alpha')).toBe(false);
      expect(lateReader(server)).toEqual([]);
      const duplicate = new Y.Doc();
      Y.applyUpdate(duplicate, Y.encodeStateAsUpdate(server.doc));
      expect(contains(duplicate, 'SECRET-alpha')).toBe(false);
      duplicate.destroy();
    } finally { ada.dispose(); }
  });

  it('the deleter\'s undo brings back block and text, a peer\'s characters included, after the server reclaimed them', () => {
    const server = seededServer();
    const ada = join(server);
    const ben = join(server);
    try {
      ada.insertBlock('const kept = 1;');
      sync(server, ada, ben);
      ben.type(0, 0, '/*ben*/');
      sync(server, ada, ben);
      ada.remove(0);
      sync(server, ada, ben);
      expect(ben.texts()).toEqual([]);
      expect(contains(server.doc, 'const kept')).toBe(false);
      ada.undo.undo();
      sync(server, ada, ben);
      for (const peer of [ada, ben]) expect(peer.texts()).toEqual(['/*ben*/const kept = 1;']);
      expect(lateReader(server)).toEqual(['/*ben*/const kept = 1;']);
    } finally { ada.dispose(); ben.dispose(); }
  });

  it.each(['mover first', 'typist first'])('typing that races a move is kept, however long the typist was offline (%s)', (order) => {
    const server = seededServer();
    const ada = join(server);
    const ben = join(server);
    try {
      ada.insertBlock('base');
      sync(server, ada, ben);
      const before = ada.elements();
      ben.type(0, 4, ' RACED-ben');
      ada.moveToEnd(0);
      ben.type(0, 99, ' still-offline');
      ada.type(0, 0, 'A:');
      if (order === 'mover first') sync(server, ada, ben); else sync(server, ben, ada);
      expect(ada.elements(), 'the move recreated the element').not.toEqual(before);
      for (const peer of [ada, ben]) expect(peer.texts()).toEqual(['A:base RACED-ben still-offline']);
      expect(ada.paragraphs()).toEqual(['Intro.', 'Outro.']);
      expect(lateReader(server)).toEqual(['A:base RACED-ben still-offline']);
    } finally { ada.dispose(); ben.dispose(); }
  });

  it('a payload inside a moved paragraph or container keeps its text and a racing peer\'s typing', () => {
    const server = seededServer();
    const ada = join(server);
    const ben = join(server);
    try {
      ada.insertBoxed('boxed();');
      ada.insertInline('f=1');
      sync(server, ada, ben);
      expect(ada.texts()).toEqual(['f=1', 'boxed();']);
      const before = ada.elements();
      ben.type(0, 3, '+ben');
      ben.type(1, 8, ' // ben');
      ada.moveToEnd(0);
      ada.moveToEnd(0);
      sync(server, ada, ben);
      const after = ada.elements();
      expect(after.every((element) => !before.includes(element)), 'both payload elements were recreated').toBe(true);
      for (const peer of [ada, ben]) expect(peer.texts()).toEqual(['f=1+ben', 'boxed(); // ben']);
      expect(lateReader(server)).toEqual(['f=1+ben', 'boxed(); // ben']);
      expect(server.stats.reclaimed).toBe(0);
    } finally { ada.dispose(); ben.dispose(); }
  });

  it.each(['deleter first', 'mover first'])('a delete racing a move keeps one block with the text once (%s); every undo keeps one', (order) => {
    const server = seededServer();
    const ada = join(server);
    const ben = join(server);
    const cat = join(server);
    try {
      ada.insertBlock('race();');
      sync(server, ada, ben, cat);
      ben.remove(0);
      ada.moveToEnd(0);
      ada.type(0, 99, ' // ada');
      if (order === 'deleter first') sync(server, ben, ada, cat); else sync(server, ada, ben, cat);
      sync(server, ada, ben, cat);
      for (const peer of [ada, ben, cat]) expect(peer.texts(), 'the move wins, as it does for a V1 paragraph').toEqual(['race(); // ada']);
      ben.undo.undo();
      sync(server, ada, ben, cat);
      for (const peer of [ada, ben, cat]) expect(peer.texts(), "the deleter's undo restores nothing twice").toEqual(['race(); // ada']);
      cat.type(0, 99, ' // cat');
      sync(server, ada, ben, cat);
      ada.undo.undo();
      ada.undo.undo();
      sync(server, ada, ben, cat);
      for (const peer of [ada, ben, cat]) expect(peer.texts(), "the mover's undo keeps the third peer's edit").toEqual(['race(); // cat']);
      expect(lateReader(server)).toEqual(['race(); // cat']);
    } finally { ada.dispose(); ben.dispose(); cat.dispose(); }
  });

  it.each(['ada first', 'ben first'])('two concurrent moves, then two concurrent undos, leave exactly one block (%s)', (order) => {
    const server = seededServer();
    const ada = join(server);
    const ben = join(server);
    try {
      ada.insertBlock('twin');
      sync(server, ada, ben);
      ada.moveToEnd(0);
      ben.moveToStart(0);
      if (order === 'ada first') sync(server, ada, ben); else sync(server, ben, ada);
      sync(server, ada, ben);
      for (const peer of [ada, ben]) expect(peer.texts()).toEqual(['twin']);
      ada.undo.undo();
      ben.undo.undo();
      if (order === 'ada first') sync(server, ada, ben); else sync(server, ben, ada);
      sync(server, ada, ben);
      for (const peer of [ada, ben]) expect(peer.texts()).toEqual(['twin']);
      expect(lateReader(server)).toEqual(['twin']);
    } finally { ada.dispose(); ben.dispose(); }
  });

  it('undoing a creation after an undone delete removes the block without destroying a peer\'s typing; redo restores it', () => {
    const server = seededServer();
    const ada = join(server);
    const ben = join(server);
    try {
      ada.insertBlock('seed');
      sync(server, ada, ben);
      ada.remove(0);
      sync(server, ada, ben);
      ada.undo.undo();
      sync(server, ada, ben);
      ben.type(0, 4, ' ben');
      sync(server, ada, ben);
      for (const peer of [ada, ben]) expect(peer.texts()).toEqual(['seed ben']);
      ada.undo.undo();
      sync(server, ada, ben);
      for (const peer of [ada, ben]) expect(peer.texts(), 'undoing a creation removes the block, as for a paragraph').toEqual([]);
      expect(contains(server.doc, ' ben') || contains(server.doc, 'seed')).toBe(false);
      ada.undo.redo();
      sync(server, ada, ben);
      for (const peer of [ada, ben]) expect(peer.texts()).toEqual(['seed ben']);
      expect(lateReader(server)).toEqual(['seed ben']);
    } finally { ada.dispose(); ben.dispose(); }
  });

  it('undoing the creation of a paragraph holding a formula a peer edited hides both; redo restores every character', () => {
    const server = seededServer();
    const ada = join(server);
    const ben = join(server);
    try {
      ada.insertInline('f=1');
      sync(server, ada, ben);
      ben.type(0, 3, '+b');
      sync(server, ada, ben);
      ada.undo.undo();
      sync(server, ada, ben);
      for (const peer of [ada, ben]) expect(peer.texts()).toEqual([]);
      expect(contains(server.doc, '+b')).toBe(false);
      ada.undo.redo();
      sync(server, ada, ben);
      for (const peer of [ada, ben]) expect(peer.texts()).toEqual(['f=1+b']);
      expect(ben.paragraphs()).toEqual(['Intro.', 'Formula: ', 'Outro.']);
      expect(lateReader(server)).toEqual(['f=1+b']);
    } finally { ada.dispose(); ben.dispose(); }
  });

  it('control: V1 already removes a peer\'s text in a paragraph whose creation is undone, and redo does not restore it', () => {
    const server = seededServer();
    const ada = join(server);
    const ben = join(server);
    try {
      ada.insertParagraph('Ada para');
      sync(server, ada, ben);
      ben.appendToParagraph('Ada para', ' ben');
      sync(server, ada, ben);
      ada.undo.undo();
      sync(server, ada, ben);
      expect(ben.paragraphs()).toEqual(['Intro.', 'Outro.']);
      ada.undo.redo();
      sync(server, ada, ben);
      expect(ben.paragraphs(), "the peer's characters are gone for good (an m1 gap for every text block)").toEqual(['Intro.', 'Ada para', 'Outro.']);
    } finally { ada.dispose(); ben.dispose(); }
  });

  it('a peer that joins at any point of a new block\'s drafting, and touches the block, never costs the drafter a character', () => {
    const seed = seededServer();
    const ada = join(seed);
    try {
      ada.insertBlock('');
      for (const chunk of ['const ', 'ada', ' = 1;']) ada.type(0, 99, chunk);
      const updates = ada.outbox.splice(0);
      for (let prefix = 0; prefix <= updates.length; prefix++) {
        const server = payloadServer(Y.encodeStateAsUpdate(seed.doc));
        for (const update of updates.slice(0, prefix)) server.receive(update);
        const ben = join(server);
        try {
          if (ben.texts().length) ben.touch(0);
          up(server, ben);
          for (const update of updates.slice(prefix)) server.receive(update);
          expect(lateReader(server), `ben joined after ${prefix} of ${updates.length} updates`).toEqual(['const ada = 1;']);
          expect(server.stats.reclaimed, 'a new block is never mistaken for an orphan').toBe(0);
          const entry = server.doc.getMap('registers')._map.values().next().value;
          expect(entry?.id.client, 'only the drafter ever creates the payload').toBe(ada.doc.clientID);
        } finally { ben.dispose(); server.doc.destroy(); }
      }
    } finally { ada.dispose(); }
  });

  it('offline typing into a block someone deleted is never served, and the deleter\'s undo brings it back', () => {
    const server = seededServer();
    const ada = join(server);
    const ben = join(server);
    try {
      ada.insertBlock('shared');
      sync(server, ada, ben);
      ben.type(0, 6, ' OFFLINE-ben');
      ada.remove(0);
      sync(server, ada, ben);
      for (const peer of [ada, ben]) expect(peer.texts()).toEqual([]);
      expect(contains(server.doc, 'OFFLINE-ben')).toBe(false);
      ada.undo.undo();
      sync(server, ada, ben);
      for (const peer of [ada, ben]) expect(peer.texts()).toEqual(['shared OFFLINE-ben']);
    } finally { ada.dispose(); ben.dispose(); }
  });

  it.each([
    ['an incremental update', false, true],
    ['a reconnect (sync step 2)', true, true],
    ['no honoring (control)', false, false],
  ] as const)('a peer\'s concurrent deletion inside a reclaimed block is honored, so its undo never doubles (%s)', (_label, viaReconnect, honorDeletes) => {
    const server = seededServer();
    const restart = payloadServer(Y.encodeStateAsUpdate(server.doc), { honorDeletes });
    const ada = join(restart);
    const ben = join(restart);
    try {
      ada.insertBlock('keep-xy-keep');
      sync(restart, ada, ben);
      ada.erase(0, 5, 2);
      ben.remove(0);
      up(restart, ben);
      if (viaReconnect) reconnect(restart, ada); else up(restart, ada);
      sync(restart, ada, ben);
      ben.undo.undo();
      sync(restart, ada, ben);
      if (honorDeletes) for (const peer of [ada, ben]) expect(peer.texts()).toEqual(['keep--keep']);
      ada.undo.undo();
      sync(restart, ada, ben);
      const text = ada.texts()[0];
      if (honorDeletes) expect(text).toBe('keep-xy-keep'); else expect(text.split('xy').length - 1, 'the doubling the rule prevents').toBe(2);
    } finally { ada.dispose(); ben.dispose(); }
  });

  it('a reconnecting peer that had seen a reclaim does not cancel it', () => {
    const server = seededServer();
    const ada = join(server);
    const ben = join(server);
    try {
      ada.insertBlock('kept');
      sync(server, ada, ben);
      ben.remove(0);
      sync(server, ada, ben);
      reconnect(server, ada);
      ben.undo.undo();
      sync(server, ada, ben);
      for (const peer of [ada, ben]) expect(peer.texts()).toEqual(['kept']);
    } finally { ada.dispose(); ben.dispose(); }
  });

  it('the load pass reclaims a payload no element names (the orphans M1 has already stored)', () => {
    const seed = seededServer();
    const ada = join(seed);
    try {
      ada.insertBlock('live();');
      sync(seed, ada);
      seed.doc.getMap<Y.Text>('registers').set('orphan', new Y.Text('ORPHAN-gamma'));
      const loaded = payloadServer(Y.encodeStateAsUpdate(seed.doc));
      expect(contains(loaded.doc, 'ORPHAN-gamma')).toBe(false);
      expect(lateReader(loaded)).toEqual(['live();']);
    } finally { ada.dispose(); }
  });

  it('the janitor evaluates only the ids an update touched', () => {
    const server = seededServer();
    const ada = join(server);
    const ben = join(server);
    try {
      ada.insertBlocks(200);
      sync(server, ada, ben);
      server.stats.evaluated = 0;
      ben.type(57, 0, 'x');
      sync(server, ada, ben);
      expect(server.stats.evaluated, 'an edit').toBe(1);
      // V1 rewrites more than the moved node (a move recreates every later sibling), so the janitor's work is the
      // elements V1 actually rewrote, never the note.
      for (const [step, reclaimed] of [[() => ada.remove(3), 1], [() => ada.moveToEnd(120), 0]] as const) {
        const before = ada.elements();
        Object.assign(server.stats, { evaluated: 0, reclaimed: 0, revived: 0 });
        step();
        sync(server, ada, ben);
        const after = new Set(ada.elements());
        expect(server.stats.evaluated).toBe(before.filter((element) => !after.has(element)).length);
        expect([server.stats.reclaimed, server.stats.revived]).toEqual([reclaimed, 0]);
      }
      expect(ada.texts()).toHaveLength(199);
    } finally { ada.dispose(); ben.dispose(); }
  });
});

// ---------------------------------------------------------------- the M1 model: Y.Map('registers') keyed by __regId

function mapClient(state: Uint8Array) {
  const doc = new Y.Doc(); const editor = createConverterEditor();
  const binding: Binding = createBinding(editor, provider, 'root', doc, new Map([['root', doc]]), excludedPropertiesFor(editor));
  const stopRegisters = bindRegisters(editor, doc);
  const stop = editor.registerUpdateListener(({ prevEditorState, editorState, dirtyElements, dirtyLeaves, normalizedNodes, tags }) => {
    syncLexicalUpdateToYjs(binding, provider, prevEditorState, editorState, dirtyElements, dirtyLeaves, normalizedNodes, tags);
  });
  const root = binding.root.getSharedType();
  const observer: Parameters<typeof root.observeDeep>[0] = (events, transaction) => {
    if (transaction.origin !== binding) syncYjsChangesToLexical(binding, provider, events as never, false, noop);
  };
  root.observeDeep(observer);
  Y.applyUpdate(doc, state);
  editor.update(noop, { discrete: true });
  return { doc, editor, dispose: () => { stop(); stopRegisters(); root.unobserveDeep(observer); doc.destroy(); } };
}
function codeBlocks(): (LexicalNode & { getCode(): string; setCode(code: string): void })[] {
  const walk = (node: LexicalNode): LexicalNode[] => node.getType() === 'code-block' ? [node] : $isElementNode(node) ? node.getChildren().flatMap(walk) : [];
  return walk($getRoot()) as never;
}

describe('T1.R spike: the M1 register map, for comparison @p:col-1', () => {
  // Red on purpose until T1.F2 lands the element-owned payload; then this becomes a plain `it`.
  it.fails('M1 map: a deleted block\'s payload is still served to later readers and duplicates (privacy P1)', () => {
    const server = new Y.Doc();
    importBody(server, 'Intro.\n\n```js\nSECRET-beta\n```');
    const ada = mapClient(Y.encodeStateAsUpdate(server));
    try {
      ada.editor.update(() => { codeBlocks()[0].remove(); }, { discrete: true });
      send(ada.doc, server);
      expect(exportDocMarkdown(server)).not.toContain('SECRET-beta');
      expect(contains(server, 'SECRET-beta')).toBe(false);
    } finally { ada.dispose(); server.destroy(); }
  });

  it('M1 map: a peer joining at any point of a new code block\'s drafting does not lose it in the binding', () => {
    const server = new Y.Doc();
    importBody(server, 'Intro.');
    const ada = mapClient(Y.encodeStateAsUpdate(server));
    const updates: Uint8Array[] = [];
    const record = (update: Uint8Array) => { updates.push(update); };
    ada.doc.on('update', record);
    try {
      ada.editor.update(() => {
        const klass = ada.editor._nodes.get('code-block')!.klass as unknown as new (code: string) => LexicalNode;
        $getRoot().getFirstChildOrThrow().insertAfter(new klass(''));
      }, { discrete: true });
      for (const text of ['const ', 'const ada', 'const ada = 1;']) {
        ada.editor.update(() => { codeBlocks()[0].setCode(text); }, { discrete: true });
      }
      ada.doc.off('update', record);
      const kinds = updates.map((update) => {
        const probe = new Y.Doc(); Y.applyUpdate(probe, Y.encodeStateAsUpdate(server)); Y.applyUpdate(probe, update);
        const kind = probe.getMap('registers').size > 0 ? 'register' : 'tree'; probe.destroy(); return kind;
      });
      expect(kinds[0], "a new block's register is created before its element reaches the wire").toBe('register');
      for (let prefix = 0; prefix <= updates.length; prefix++) {
        const partial = new Y.Doc();
        Y.applyUpdate(partial, Y.encodeStateAsUpdate(server));
        for (const update of updates.slice(0, prefix)) Y.applyUpdate(partial, update);
        const ben = mapClient(Y.encodeStateAsUpdate(partial));
        partial.destroy();
        try {
          ben.editor.update(() => {
            for (const block of codeBlocks()) (block.getWritable() as unknown as { __language: string }).__language = 'rust';
          }, { discrete: true });
          send(ada.doc, ben.doc); send(ben.doc, ada.doc);
          const merged = new Y.Doc(); send(ada.doc, merged);
          expect(exportDocMarkdown(merged), `ben joined after ${prefix} of ${updates.length} updates`).toContain('const ada = 1;');
          merged.destroy();
        } finally { ben.dispose(); }
      }
      expect(exportMarkdown(ada.editor)).toContain('const ada = 1;');
    } finally { ada.dispose(); server.destroy(); }
  });

  it('M1 map: a whole-value write of a field snapshot that missed a peer\'s edit deletes those characters', () => {
    const server = new Y.Doc();
    importBody(server, '```js\nseed\n```');
    const ada = mapClient(Y.encodeStateAsUpdate(server));
    const ben = mapClient(Y.encodeStateAsUpdate(server));
    try {
      ada.editor.update(() => { codeBlocks()[0].setCode('seed // ada'); }, { discrete: true });
      send(ada.doc, ben.doc);
      // Ben's field still holds "seed" plus his keystroke when a whole-value path (commit, double Enter) writes it.
      ben.editor.update(() => { codeBlocks()[0].setCode('seed!'); }, { discrete: true });
      send(ben.doc, ada.doc);
      ada.editor.update(noop, { discrete: true });
      expect(ada.editor.getEditorState().read(() => codeBlocks()[0].getCode())).toBe('seed!');
    } finally { ada.dispose(); ben.dispose(); server.destroy(); }
  });
});
