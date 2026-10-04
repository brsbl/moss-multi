// T1.R spike (docs/design/registers.md): the decorator payload lifecycle under delete, move, undo, join, offline peers
// and restarts. A prototype keeps each payload in its own Y.Doc, addressed by the block's stable id, beside the note's
// doc. A V1 move (delete + recreate of the element) never touches it. Nobody ever deletes payload text on anyone's
// behalf: the server withholds a payload that no live element names (it stores the payload's updates privately and
// neither fans them out nor answers for it) and serves it again, with every original item id, when an element names it.
// The "M1 map" cases at the end characterize the current model for comparison.
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
const has = (bytes: Uint8Array[], text: string) => bytes.some((frame) => Buffer.from(frame).includes(Buffer.from(text)));
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

// ---------------------------------------------------------------- the wire

/** One frame on a doc socket: the note's own sync, a payload's sync (its own message type), or a payload step 1. */
type Frame =
  | { kind: 'root'; update: Uint8Array }
  | { kind: 'payload'; id: string; update: Uint8Array }
  | { kind: 'step1'; id: string; sv: Uint8Array };
const REMOTE = 'remote';

// ---------------------------------------------------------------- the naming index (server; Yjs-level, no Lexical)

/**
 * id → the live elements that name it, kept from each transaction's own structs: the elements it integrated and the
 * ones it deleted, including every element inside a moved or deleted paragraph or container (Yjs deletes a subtree
 * item by item, and V1 recreates one the same way). Work is proportional to the transaction. `take()` returns the ids
 * whose elements changed since the last call, each with whether it was named before.
 */
function nameIndex(doc: Y.Doc, ignore: unknown) {
  const live = new Map<string, Set<Y.XmlElement>>();
  const ids = new WeakMap<Y.XmlElement, string>();
  let changed = new Map<string, boolean>();
  const mark = (item: Y.Item, alive: boolean, record: boolean) => {
    if (!(item.content instanceof Y.ContentType) || !(item.content.type instanceof Y.XmlElement)) return;
    const element = item.content.type;
    const attr: unknown = element.getAttribute('__blockId');
    const id = alive ? (PAYLOAD_TYPES.has(String(element.getAttribute('__type'))) && typeof attr === 'string' ? attr : undefined) : ids.get(element);
    if (!id) return;
    let set = live.get(id);
    if (!set) live.set(id, set = new Set());
    if (alive === set.has(element)) return;
    if (record && !changed.has(id)) changed.set(id, set.size > 0);
    if (alive) { set.add(element); ids.set(element, id); } else set.delete(element);
  };
  doc.on('afterTransaction', (transaction: Y.Transaction) => {
    const record = transaction.origin !== ignore;
    transaction.afterState.forEach((after, client) => {
      const before = transaction.beforeState.get(client) ?? 0;
      if (after === before) return;
      const structs = doc.store.clients.get(client) ?? [];
      for (let i = Y.findIndexSS(structs, before); i < structs.length; i++) {
        const struct = structs[i];
        if (struct instanceof Y.Item && !struct.deleted) mark(struct, true, record);
      }
    });
    Y.iterateDeletedStructs(transaction, transaction.deleteSet, (struct) => { if (struct instanceof Y.Item) mark(struct, false, record); });
  });
  return {
    live,
    named: (id: string) => (live.get(id)?.size ?? 0) > 0,
    take: () => { const out = changed; changed = new Map(); return out; },
  };
}

// ---------------------------------------------------------------- the client: create, edit, undo; never delete

const PAYLOAD_LOCAL = Symbol('payload-local');
const MINT = Symbol('payload-mint');

/**
 * One Cmd+Z stack over the body's manager and each payload's manager (a payload is its own Y.Doc, and a Y.UndoManager
 * spans one doc). Every new tracked edit records which manager took it; undo and redo replay that order.
 */
function undoStack() {
  const managers: Y.UndoManager[] = [];
  const undone: Y.UndoManager[] = [];
  const redone: Y.UndoManager[] = [];
  let replaying = false;
  const step = (from: Y.UndoManager[], to: Y.UndoManager[], run: (manager: Y.UndoManager) => unknown) => {
    replaying = true;
    try {
      while (from.length) {
        const manager = from.pop()!;
        if (run(manager) !== null) { to.push(manager); return; }
      }
    } finally { replaying = false; }
  };
  return {
    track: (manager: Y.UndoManager) => {
      managers.push(manager);
      manager.on('stack-item-added', ({ type }: { type: 'undo' | 'redo' }) => {
        if (replaying || type !== 'undo') return;
        undone.push(manager);
        redone.length = 0;
        // A new edit ends every redo chain, as one manager's would; each manager clears its own already.
        for (const other of managers) if (other !== manager && other.redoStack.length) other.clear(false, true);
      });
    },
    undo: () => step(undone, redone, (manager) => manager.undo()),
    redo: () => step(redone, undone, (manager) => manager.redo()),
    destroy: () => { for (const manager of managers) manager.destroy(); },
  };
}

let connections = 0;

function payloadClient(state: Uint8Array) {
  const cid = ++connections;
  const doc = new Y.Doc();
  const errors: unknown[] = [];
  const editor = createHeadlessEditor({ nodes: [SpikeBlock, SpikeInline, SpikeBox], onError: (error) => { errors.push(error); } });
  const binding = createBinding(editor, provider, 'root', doc, new Map([['root', doc]]), new Map());
  const root = binding.root.getSharedType();
  // What this client sends: one frame per local transaction, as the provider does while connected.
  const outbox: Frame[] = [];
  doc.on('update', (update: Uint8Array, origin: unknown) => { if (origin !== REMOTE) outbox.push({ kind: 'root', update }); });
  const stack = undoStack();
  stack.track(new Y.UndoManager(root, { trackedOrigins: new Set<unknown>([binding]), captureTimeout: 0 }));

  // The payload docs this client holds, by id. A held doc is never written except by local edits and by its minter.
  const payloads = new Map<string, Y.Doc>();
  const hold = (id: string): Y.Doc => {
    let payload = payloads.get(id);
    if (!payload) {
      payloads.set(id, payload = new Y.Doc({ guid: id }));
      payload.on('update', (update: Uint8Array, origin: unknown) => { if (origin !== REMOTE) outbox.push({ kind: 'payload', id, update }); });
      stack.track(new Y.UndoManager(payload.getText('t'), { trackedOrigins: new Set<unknown>([PAYLOAD_LOCAL]), captureTimeout: 0 }));
    }
    return payload;
  };

  // Rule 2: only the client that minted an id writes its payload's first text, in the update that creates its
  // element. Minting drives this, not dirty leaves, so a payload inside a new container or paragraph is covered. The
  // first text is outside every undo manager: undoing the creation removes the element, which withholds the payload.
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
          const payload = hold(node.__blockId);
          if (text) payload.transact(() => payload.getText('t').insert(0, text), MINT);
          minted.delete(key);
        }
      });
    }, binding);
  });

  const observer: Parameters<Y.XmlText['observeDeep']>[0] = (events, transaction) => {
    if (transaction.origin !== binding) syncYjsChangesToLexical(binding, provider, events as never, false, noop);
  };
  root.observeDeep(observer);

  Y.applyUpdate(doc, state, REMOTE);
  editor.update(noop, { discrete: true });

  const flush = () => {
    editor.update(noop, { discrete: true });
    if (errors.length) throw errors[0];
  };
  const read = <T>(fn: () => T): T => { flush(); return editor.getEditorState().read(fn); };
  const walk = (node: LexicalNode): SpikeBlock[] => isPayloadNode(node) ? [node] : $isElementNode(node) ? node.getChildren().flatMap(walk) : [];
  const payloadKeys = () => read(() => walk($getRoot()).map((node) => node.getKey()));
  const idOf = (key: NodeKey) => read(() => ($getNodeByKey(key) as SpikeBlock).__blockId);
  const textOf = (index: number) => {
    const payload = payloads.get(idOf(payloadKeys()[index]));
    if (!payload) throw new Error('no payload');
    return payload.getText('t');
  };
  const update = (fn: () => void) => editor.update(fn, { discrete: true });
  return {
    cid, doc, editor, binding, errors, outbox, payloads, undo: stack,
    receive: (frame: Frame) => {
      if (frame.kind === 'root') Y.applyUpdate(doc, frame.update, REMOTE);
      else if (frame.kind === 'payload') Y.applyUpdate(hold(frame.id), frame.update, REMOTE);
    },
    /** A step 1 for every payload this client's tree names (on connect, and on reconnect). */
    requestPayloads: () => {
      for (const key of payloadKeys()) {
        const id = idOf(key);
        outbox.push({ kind: 'step1', id, sv: Y.encodeStateVector(hold(id)) });
      }
    },
    idAt: (index: number) => idOf(payloadKeys()[index]),
    /** Each payload node's text, in document order (containers and paragraphs included). */
    texts: () => payloadKeys().map((key) => payloads.get(idOf(key))?.getText('t').toString() ?? '<none>'),
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
    /** Types into payload `index` at `at`: minimal ops under the local origin. */
    type: (index: number, at: number, text: string) => {
      const payload = textOf(index);
      payload.doc!.transact(() => payload.insert(Math.min(at, payload.length), text), PAYLOAD_LOCAL);
    },
    erase: (index: number, at: number, length: number) => {
      const payload = textOf(index);
      payload.doc!.transact(() => payload.delete(at, length), PAYLOAD_LOCAL);
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
    dispose: () => {
      stopUpdates(); root.unobserveDeep(observer); stack.destroy(); doc.destroy();
      for (const payload of payloads.values()) payload.destroy();
    },
  };
}
type PayloadClient = ReturnType<typeof payloadClient>;

// ---------------------------------------------------------------- the server: the DocDO (gc on, no undo manager)

const JANITOR = Symbol('janitor');
const LOAD = Symbol('load');
/** What the DocDO keeps in SQLite: the note's state, and each payload's updates in a private table. */
type Persisted = { root: Uint8Array; payloads?: [string, Uint8Array][] };

function payloadServer(persisted?: Persisted) {
  const doc = new Y.Doc();
  const names = nameIndex(doc, JANITOR);
  const payloads = new Map<string, Y.Doc>();
  const inboxes = new Map<number, Frame[]>();
  /** Every byte the server persists for the note (yupdates) or sends on any socket. Private payload rows are not in it. */
  const wire: Uint8Array[] = [];
  const stats = { evaluated: 0, revealed: 0, withheld: 0, deduped: 0, compared: 0 };

  const fanOut = (frame: Frame, bytes: Uint8Array) => {
    wire.push(bytes);
    for (const inbox of inboxes.values()) inbox.push(frame);
  };
  /** A payload's private store. Its updates fan out only while an element names it (decided per update, before send). */
  const payload = (id: string): Y.Doc => {
    let held = payloads.get(id);
    if (!held) {
      payloads.set(id, held = new Y.Doc({ guid: id }));
      held.on('update', (update: Uint8Array, origin: unknown) => {
        if (origin === LOAD) return;
        if (names.named(id)) fanOut({ kind: 'payload', id, update }, update); else stats.withheld++;
      });
    }
    return held;
  };

  if (persisted) {
    Y.applyUpdate(doc, persisted.root, LOAD);
    for (const [id, state] of persisted.payloads ?? []) Y.applyUpdate(payload(id), state, LOAD);
    names.take();
    // M1 docs keep payloads in Y.Map('registers'): move each into its own payload doc (the server is the only writer;
    // clients older than this design are refused), then delete the entry, so the note's state no longer carries it.
    const registers = doc.getMap<Y.Text>('registers');
    if (registers.size) {
      for (const [id, text] of registers) {
        const held = payload(id);
        held.transact(() => held.getText('t').insert(0, text.toString()), LOAD);
      }
      doc.transact(() => { for (const id of [...registers.keys()]) registers.delete(id); }, JANITOR);
    }
  }
  // The DocDO's persistence and y-partyserver's fan-out both listen here, synchronously inside applyUpdate.
  doc.on('update', (update: Uint8Array) => fanOut({ kind: 'root', update }, update));

  /** After each applied note update: serve a payload whose id became named again; keep one element per id. */
  const settle = () => {
    for (const [id, wasNamed] of names.take()) {
      stats.evaluated++;
      const live = names.live.get(id);
      if (!live?.size) continue;
      const held = payloads.get(id);
      if (!wasNamed && held) {
        const state = Y.encodeStateAsUpdate(held);
        fanOut({ kind: 'payload', id, update: state }, state);
        stats.revealed++;
      }
      if (live.size > 1) {
        // Concurrent moves, or an undo racing a move, left two elements for one id. Keep one by item id: O(copies).
        stats.compared += live.size;
        const [, ...extra] = [...live].sort((a, b) => a._item!.id.client - b._item!.id.client || a._item!.id.clock - b._item!.id.clock);
        doc.transact((transaction) => {
          for (const element of extra) {
            element._item!.delete(transaction);
            const parent = element.parent as Y.XmlText;
            if (parent._searchMarker) parent._searchMarker.length = 0;
            stats.deduped++;
          }
        }, JANITOR);
      }
    }
  };

  return {
    doc, stats, wire, names, payloads,
    connect: (cid: number) => { inboxes.set(cid, []); },
    disconnect: (cid: number) => { inboxes.delete(cid); },
    inbox: (cid: number) => inboxes.get(cid) ?? [],
    receive: (from: number | null, frame: Frame) => {
      if (frame.kind === 'root') {
        Y.applyUpdate(doc, frame.update, from);
        settle();
      } else if (frame.kind === 'payload') {
        Y.applyUpdate(payload(frame.id), frame.update, from);
      } else if (names.named(frame.id) && from !== null) {
        // A step 1 is answered only for a payload an element names; a withheld one answers nothing.
        const update = Y.encodeStateAsUpdate(payload(frame.id), frame.sv);
        wire.push(update);
        inboxes.get(from)?.push({ kind: 'payload', id: frame.id, update });
      }
    },
    /** What a duplicate, a version or an export reads: the note and the payloads its elements name. */
    snapshot: (): Uint8Array[] => [Y.encodeStateAsUpdate(doc), ...[...payloads].filter(([id]) => names.named(id)).map(([, held]) => Y.encodeStateAsUpdate(held))],
  };
}
type PayloadServer = ReturnType<typeof payloadServer>;
/** Hibernation or eviction: a fresh instance from what SQLite holds. Every socket is gone. */
const restart = (server: PayloadServer): PayloadServer => payloadServer({
  root: Y.encodeStateAsUpdate(server.doc),
  payloads: [...server.payloads].map(([id, held]): [string, Uint8Array] => [id, Y.encodeStateAsUpdate(held)]),
});

const up = (server: PayloadServer, client: PayloadClient) => { for (const frame of client.outbox.splice(0)) server.receive(client.cid, frame); };
const down = (server: PayloadServer, client: PayloadClient) => { for (const frame of server.inbox(client.cid).splice(0)) client.receive(frame); };
const sync = (server: PayloadServer, ...clients: PayloadClient[]) => {
  for (const client of clients) up(server, client);
  for (const client of clients) down(server, client);
};
/**
 * A reconnect (or a wake): a fresh socket whose queued frames are gone. Both sides exchange y-protocols step 2s, which
 * carry an update and its full delete set and nothing else; the client sends each payload it holds the same way and
 * asks for the ones its tree names.
 */
const reconnect = (server: PayloadServer, client: PayloadClient) => {
  client.outbox.length = 0;
  server.connect(client.cid);
  server.receive(client.cid, { kind: 'root', update: Y.encodeStateAsUpdate(client.doc, Y.encodeStateVector(server.doc)) });
  client.receive({ kind: 'root', update: Y.encodeStateAsUpdate(server.doc, Y.encodeStateVector(client.doc)) });
  for (const [id, held] of client.payloads) server.receive(client.cid, { kind: 'payload', id, update: Y.encodeStateAsUpdate(held) });
  client.requestPayloads();
  up(server, client);
  down(server, client);
};
const join = (server: PayloadServer) => {
  const client = payloadClient(Y.encodeStateAsUpdate(server.doc));
  server.connect(client.cid);
  client.requestPayloads();
  up(server, client);
  down(server, client);
  return client;
};

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
  try { return late.texts(); } finally { server.disconnect(late.cid); late.dispose(); }
}
/** True when any frame the server persisted for the note or sent on a socket carries `text`. */
const onWire = (server: PayloadServer, text: string) => has(server.wire, text);

describe('T1.R spike: payload docs withheld while no element names them @p:col-1 @p:col-3', () => {
  it('a deleted block\'s text is never served to late readers, duplicates or the note\'s state, and stays private', () => {
    const server = seededServer();
    const ada = join(server);
    try {
      ada.insertBlock('SECRET-alpha');
      sync(server, ada);
      expect(lateReader(server), 'positive control').toEqual(['SECRET-alpha']);
      ada.remove(0);
      sync(server, ada);
      expect(lateReader(server)).toEqual([]);
      expect(has(server.snapshot(), 'SECRET-alpha')).toBe(false);
      expect(contains(server.doc, 'SECRET-alpha'), "the note's state never carried it").toBe(false);
      const id = [...server.payloads.keys()][0];
      expect(server.payloads.get(id)!.getText('t').toString(), 'kept privately for undo').toBe('SECRET-alpha');
    } finally { ada.dispose(); }
  });

  it('the deleter\'s undo brings back block and text, a peer\'s characters included, with their original ids', () => {
    const server = seededServer();
    const ada = join(server);
    const ben = join(server);
    try {
      ada.insertBlock('const kept = 1;');
      sync(server, ada, ben);
      ben.type(0, 0, '/*ben*/');
      sync(server, ada, ben);
      const before = Y.encodeStateVector(server.payloads.get(ada.idAt(0))!);
      ada.remove(0);
      sync(server, ada, ben);
      expect(ben.texts()).toEqual([]);
      ada.undo.undo();
      sync(server, ada, ben);
      for (const peer of [ada, ben]) expect(peer.texts()).toEqual(['/*ben*/const kept = 1;']);
      expect(Y.encodeStateVector(server.payloads.get(ada.idAt(0))!), 'nothing was rewritten').toEqual(before);
      expect(lateReader(server)).toEqual(['/*ben*/const kept = 1;']);
      ben.undo.undo();
      sync(server, ada, ben);
      for (const peer of [ada, ben]) expect(peer.texts(), "the peer's own undo still works").toEqual(['const kept = 1;']);
    } finally { ada.dispose(); ben.dispose(); }
  });

  it.each(['mover first', 'typist first'])('typing that races a move is kept, however long the typist was offline (%s)', (order) => {
    const server = seededServer();
    const ada = join(server);
    const ben = join(server);
    try {
      ada.insertBlock('base');
      sync(server, ada, ben);
      server.stats.withheld = 0;
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
      expect(server.stats.withheld, 'a move never withholds').toBe(0);
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
      server.stats.withheld = 0;
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
      expect(server.stats.withheld).toBe(0);
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
      sync(server, ada, ben, cat);
      for (const peer of [ada, ben, cat]) expect(peer.texts(), "the deleter's undo restores nothing twice").toEqual(['race(); // ada']);
      cat.type(0, 99, ' // cat');
      sync(server, ada, ben, cat);
      ada.undo.undo();
      ada.undo.undo();
      sync(server, ada, ben, cat);
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

  it('undoing a creation after an undone delete hides the block and a peer\'s typing; redo restores both', () => {
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
      expect(lateReader(server)).toEqual([]);
      expect(has(server.snapshot(), ' ben') || has(server.snapshot(), 'seed')).toBe(false);
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
      expect(has(server.snapshot(), '+b')).toBe(false);
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
      ada.insertBlock('const ');
      for (const chunk of ['ada', ' = 1;']) ada.type(0, 99, chunk);
      const frames = ada.outbox.splice(0);
      expect(frames.map((frame) => frame.kind), 'the first text can reach the server before its element').toEqual(['payload', 'root', 'payload', 'payload']);
      const drafter = ada.payloads.get(ada.idAt(0))!.clientID;
      for (let prefix = 0; prefix <= frames.length; prefix++) {
        const server = payloadServer({ root: Y.encodeStateAsUpdate(seed.doc) });
        for (const frame of frames.slice(0, prefix)) server.receive(null, frame);
        const ben = join(server);
        try {
          if (ben.texts().length) ben.touch(0);
          up(server, ben);
          for (const frame of frames.slice(prefix)) server.receive(null, frame);
          down(server, ben);
          expect(lateReader(server), `ben joined after ${prefix} of ${frames.length} frames`).toEqual(['const ada = 1;']);
          expect(ben.texts(), 'and ben sees it').toEqual(['const ada = 1;']);
          const [held] = server.payloads.values();
          expect([...held.store.clients.keys()], 'only the drafter ever writes the payload').toEqual([drafter]);
        } finally { ben.dispose(); server.doc.destroy(); }
      }
    } finally { ada.dispose(); }
  });

  it('offline typing into a block someone deleted stays private, and the deleter\'s undo brings it back', () => {
    const server = seededServer();
    const ada = join(server);
    const ben = join(server);
    try {
      ada.insertBlock('shared');
      sync(server, ada, ben);
      server.stats.withheld = 0;
      ben.type(0, 6, ' OFFLINE-ben');
      ada.remove(0);
      sync(server, ada, ben);
      for (const peer of [ada, ben]) expect(peer.texts()).toEqual([]);
      expect(onWire(server, 'OFFLINE-ben')).toBe(false);
      expect(server.stats.withheld).toBe(1);
      ada.undo.undo();
      sync(server, ada, ben);
      for (const peer of [ada, ben]) expect(peer.texts()).toEqual(['shared OFFLINE-ben']);
    } finally { ada.dispose(); ben.dispose(); }
  });

  it.each([
    ['before the delete, incrementally', 'before'],
    ['after the delete, incrementally', 'after-delete'],
    ['after the restore, incrementally', 'after-restore'],
    ['after the restore, through a reconnect', 'reconnect'],
  ] as const)('a peer\'s erase inside a deleted block lands exactly and its undo restores it once (%s)', (_label, when) => {
    const server = seededServer();
    const ada = join(server);
    const ben = join(server);
    try {
      ada.insertBlock('keep-xy-keep');
      sync(server, ada, ben);
      ada.erase(0, 5, 2);
      if (when === 'before') up(server, ada);
      ben.remove(0);
      sync(server, ben);
      if (when === 'after-delete') up(server, ada);
      ben.undo.undo();
      sync(server, ben);
      if (when === 'reconnect') reconnect(server, ada); else sync(server, ada, ben);
      sync(server, ada, ben);
      for (const peer of [ada, ben]) expect(peer.texts()).toEqual(['keep--keep']);
      ada.undo.undo();
      sync(server, ada, ben);
      for (const peer of [ada, ben]) expect(peer.texts()).toEqual(['keep-xy-keep']);
    } finally { ada.dispose(); ben.dispose(); }
  });

  it('a restart between the delete and the undo loses nothing and serves nothing early', () => {
    const first = seededServer();
    const ada = join(first);
    const ben = join(first);
    try {
      ada.insertBlock('survives-wake');
      sync(first, ada, ben);
      ada.remove(0);
      sync(first, ada, ben);
      const server = restart(first);
      reconnect(server, ada);
      reconnect(server, ben);
      expect(lateReader(server)).toEqual([]);
      expect(onWire(server, 'survives-wake')).toBe(false);
      ada.undo.undo();
      sync(server, ada, ben);
      for (const peer of [ada, ben]) expect(peer.texts()).toEqual(['survives-wake']);
      expect(lateReader(server)).toEqual(['survives-wake']);
    } finally { ada.dispose(); ben.dispose(); }
  });

  it('loading an M1 doc moves its register entries into payload docs; an orphan is never served', () => {
    const seed = seededServer();
    const ada = join(seed);
    try {
      ada.insertBlock('');
      sync(seed, ada);
      const m1 = new Y.Doc();
      Y.applyUpdate(m1, Y.encodeStateAsUpdate(seed.doc));
      m1.getMap<Y.Text>('registers').set(ada.idAt(0), new Y.Text('live();'));
      m1.getMap<Y.Text>('registers').set('orphan', new Y.Text('ORPHAN-gamma'));
      const loaded = payloadServer({ root: Y.encodeStateAsUpdate(m1) });
      expect(contains(loaded.doc, 'ORPHAN-gamma') || contains(loaded.doc, 'live();')).toBe(false);
      expect(lateReader(loaded)).toEqual(['live();']);
      expect(onWire(loaded, 'ORPHAN-gamma')).toBe(false);
    } finally { ada.dispose(); }
  });

  it('the server\'s work is the ids an update touched: an edit costs none, a delete or move the elements V1 rewrote', () => {
    const server = seededServer();
    const ada = join(server);
    const ben = join(server);
    try {
      ada.insertBlocks(200);
      sync(server, ada, ben);
      const reset = () => Object.assign(server.stats, { evaluated: 0, revealed: 0, withheld: 0, deduped: 0, compared: 0 });
      reset();
      ben.type(57, 0, 'x');
      sync(server, ada, ben);
      expect(server.stats.evaluated, 'an edit never touches the note').toBe(0);
      expect(ada.texts()[57]).toBe('xblock 57;');
      // V1 rewrites more than the moved node (a move recreates every later sibling), so the server's work is the
      // elements V1 actually rewrote, never the note.
      for (const step of [() => ada.remove(3), () => ada.moveToEnd(120)]) {
        const before = ada.elements();
        reset();
        step();
        sync(server, ada, ben);
        const after = new Set(ada.elements());
        expect(server.stats.evaluated).toBe(before.filter((element) => !after.has(element)).length);
        expect([server.stats.revealed, server.stats.compared]).toEqual([0, 0]);
      }
      expect(ada.texts()).toHaveLength(199);
    } finally { ada.dispose(); ben.dispose(); }
  });

  it('two concurrent moves in a long note: one element per payload block survives, each duplicate costing only its copies', () => {
    const server = seededServer();
    const ada = join(server);
    const ben = join(server);
    try {
      ada.insertBlocks(40);
      sync(server, ada, ben);
      const expected = ada.texts();
      Object.assign(server.stats, { deduped: 0, compared: 0 });
      ada.moveToEnd(10);
      ben.moveToStart(20);
      sync(server, ada, ben);
      sync(server, ada, ben);
      expect(server.stats.deduped, 'V1 rewrote overlapping siblings on both sides').toBeGreaterThan(0);
      expect(server.stats.compared, 'each duplicated id cost its two copies').toBe(2 * server.stats.deduped);
      for (const peer of [ada, ben]) expect([...peer.texts()].sort()).toEqual([...expected].sort());
      expect.soft(ada.paragraphs(), 'characterization: V1 paragraphs rewritten by both moves').toEqual(['Intro.', 'Outro.']);
    } finally { ada.dispose(); ben.dispose(); }
  });
});

// The independent checker's findings against attempt 2 (the janitor that deleted and revived payload text). Red on
// that prototype in the tests-first run; unchanged here.
describe('T1.R regressions: the attempt-2 checker findings @p:col-1 @p:col-3', () => {
  it('P1-1: a real sync step 2 after a reclaim (no state vector) leaves the deleter\'s undo its text', () => {
    const server = seededServer();
    const ada = join(server);
    const ben = join(server);
    try {
      ada.insertBlock('kept-after-wake');
      sync(server, ada, ben);
      ben.remove(0);
      sync(server, ada, ben);
      reconnect(server, ada);
      ben.undo.undo();
      sync(server, ada, ben);
      for (const peer of [ada, ben]) expect(peer.texts()).toEqual(['kept-after-wake']);
    } finally { ada.dispose(); ben.dispose(); }
  });

  it('P1-2: an erase that arrives after the block was restored is applied, and its author\'s undo restores it once', () => {
    const server = seededServer();
    const ada = join(server);
    const ben = join(server);
    try {
      ada.insertBlock('keep-xy-keep');
      sync(server, ada, ben);
      ada.erase(0, 5, 2);
      // Ada is briefly offline: her erase waits while Ben deletes the block and undoes the delete.
      ben.remove(0);
      sync(server, ben);
      ben.undo.undo();
      sync(server, ben);
      expect(ben.texts()).toEqual(['keep-xy-keep']);
      sync(server, ada, ben);
      for (const peer of [ada, ben]) expect(peer.texts(), "Ada's erase is kept").toEqual(['keep--keep']);
      ada.undo.undo();
      sync(server, ada, ben);
      for (const peer of [ada, ben]) expect(peer.texts(), 'her undo restores the characters once').toEqual(['keep-xy-keep']);
    } finally { ada.dispose(); ben.dispose(); }
  });

  it('P1-3: offline typing into a deleted block never reaches a persisted or fanned-out frame', () => {
    const server = seededServer();
    const ada = join(server);
    const ben = join(server);
    try {
      ada.insertBlock('shared');
      sync(server, ada, ben);
      expect(onWire(server, 'shared'), 'positive control').toBe(true);
      ben.type(0, 6, ' OFFLINE-ben');
      ada.remove(0);
      sync(server, ada);
      sync(server, ben);
      expect(onWire(server, 'OFFLINE-ben')).toBe(false);
      expect(lateReader(server)).toEqual([]);
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
  // Red on the M1 map (an `it.fails` until T1.F2 moved payloads out of the note's doc).
  it('M1 map, fixed by T1.F2: a deleted block\'s payload is no longer served to later readers and duplicates (privacy P1)', () => {
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
