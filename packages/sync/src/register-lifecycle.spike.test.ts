// T1.R spike (docs/design/registers.md): the decorator payload lifecycle under delete, move, undo, join and offline
// peers. A prototype keeps each payload as a Y.Text attribute of its block's own V1 XmlElement (the way @lexical/yjs
// keeps `__state` and `__slots`); the "map" cases characterize the M1 `Y.Map('registers')` model for comparison.
import { createHeadlessEditor } from '@lexical/headless';
import { createBinding, syncLexicalUpdateToYjs, syncYjsChangesToLexical, type Binding, type Provider } from '@lexical/yjs';
import {
  $createParagraphNode, $createTextNode, $getNodeByKey, $getRoot, $isElementNode, COLLABORATION_TAG, DecoratorNode, HISTORIC_TAG,
  type LexicalEditor, type LexicalNode, type NodeKey, type SerializedLexicalNode,
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

// ---------------------------------------------------------------- prototype: the payload lives in its block's element

type SerializedBlock = SerializedLexicalNode & { code: string };
class SpikeBlock extends DecoratorNode<null> {
  __code: string;
  __blockId: string;
  static getType(): string { return 'spike-block'; }
  static clone(node: SpikeBlock): SpikeBlock { return new SpikeBlock(node.__code, node.__blockId, node.__key); }
  static importJSON(json: SerializedBlock): SpikeBlock { return new SpikeBlock(json.code, crypto.randomUUID()); }
  constructor(code = '', blockId = '', key?: NodeKey) { super(key); this.__code = code; this.__blockId = blockId; }
  exportJSON(): SerializedBlock { return { ...super.exportJSON(), code: this.__code }; }
  createDOM(): never { throw new Error('headless'); }
  updateDOM(): false { return false; }
  decorate(): null { return null; }
}
const isBlock = (node: LexicalNode | null | undefined): node is SpikeBlock => node instanceof SpikeBlock;

const PAYLOAD = '__code';
const PAYLOAD_LOCAL = Symbol('payload-local');
const DEDUPE = Symbol('dedupe');
type CollabLike = { _xmlElem?: Y.XmlElement; _key?: NodeKey };

function isPayload(type: Y.AbstractType<unknown>): type is Y.Text {
  return type instanceof Y.Text && !(type instanceof Y.XmlText) && type._item?.parentSub === PAYLOAD;
}

function liveBlocks(root: Y.XmlText): { element: Y.XmlElement; index: number }[] {
  const out: { element: Y.XmlElement; index: number }[] = [];
  let index = 0;
  for (const op of root.toDelta() as { insert: unknown }[]) {
    if (op.insert instanceof Y.XmlElement && op.insert.getAttribute('__type') === 'spike-block') out.push({ element: op.insert, index });
    index += typeof op.insert === 'string' ? op.insert.length : 1;
  }
  return out;
}

function payloadClient(state: Uint8Array, { filterPayloadEvents = true, dedupeUndo = true } = {}) {
  const doc = new Y.Doc();
  const errors: unknown[] = [];
  const editor = createHeadlessEditor({ nodes: [SpikeBlock], onError: (error) => { errors.push(error); } });
  const binding = createBinding(editor, provider, 'root', doc, new Map([['root', doc]]), new Map([[SpikeBlock, new Set([PAYLOAD])]]));
  const root = binding.root.getSharedType();
  const elementOf = (key: NodeKey) => (binding.collabNodeMap.get(key) as CollabLike | undefined)?._xmlElem;
  const payloadOf = (key: NodeKey) => {
    const value = elementOf(key)?.getAttribute(PAYLOAD) as unknown;
    return value instanceof Y.Text ? value : undefined;
  };
  const payloadEvents: string[] = [];

  // The creator attaches a payload, in the binding's own transaction, to each block element it just created; a move
  // (delete + recreate in V1) copies the live payload as it stood before the sync. Nobody else ever creates one.
  const stopUpdates = editor.registerUpdateListener(({ prevEditorState, editorState, dirtyElements, dirtyLeaves, normalizedNodes, tags }) => {
    const authored = !tags.has(COLLABORATION_TAG) && !tags.has(HISTORIC_TAG);
    const before = new Map<NodeKey, string>();
    if (authored) for (const key of dirtyLeaves) { const text = payloadOf(key); if (text) before.set(key, text.toString()); }
    doc.transact((transaction) => {
      syncLexicalUpdateToYjs(binding, provider, prevEditorState, editorState, dirtyElements, dirtyLeaves, normalizedNodes, tags);
      if (!authored) return;
      const clock = transaction.beforeState.get(doc.clientID) ?? 0;
      editorState.read(() => {
        for (const key of dirtyLeaves) {
          const node = $getNodeByKey(key);
          const element = elementOf(key);
          const item = element?._item;
          if (!isBlock(node) || !element || !item || item.id.client !== doc.clientID || item.id.clock < clock) continue;
          if (!(element.getAttribute(PAYLOAD) as unknown instanceof Y.Text)) {
            element.setAttribute(PAYLOAD, new Y.Text(before.get(key) ?? node.__code) as never);
          }
        }
      });
    }, binding);
  });

  // Payload edits are not tree events; @lexical/yjs's V1 observer only knows text, element and decorator events.
  const observer: Parameters<Y.XmlText['observeDeep']>[0] = (events, transaction) => {
    if (transaction.origin === binding) return;
    const tree = filterPayloadEvents ? events.filter((event) => !isPayload(event.target)) : events;
    for (const event of events) {
      if (isPayload(event.target)) payloadEvents.push(((event.target.parent as unknown as { _collabNode?: CollabLike })._collabNode?._key) ?? '?');
    }
    if (tree.length) syncYjsChangesToLexical(binding, provider, tree as never, transaction.origin instanceof Y.UndoManager, noop);
  };
  root.observeDeep(observer);

  const undo = new Y.UndoManager([root], { trackedOrigins: new Set<unknown>([binding, PAYLOAD_LOCAL]), captureTimeout: 0 });
  // An undo may restore a block that a peer has meanwhile moved (V1 recreated it under the same block id). Only the
  // undoing client checks, only blocks its own undo just created, so a peer's live block is never touched.
  const afterUndo = (transaction: Y.Transaction) => {
    if (!dedupeUndo || !(transaction.origin instanceof Y.UndoManager)) return;
    const clock = transaction.beforeState.get(doc.clientID) ?? 0;
    const blocks = liveBlocks(root);
    const restored = blocks.filter(({ element }) => element._item!.id.client === doc.clientID && element._item!.id.clock >= clock);
    const doomed = restored.filter(({ element }) => blocks.some((other) => other.element !== element
      && !restored.includes(other) && other.element.getAttribute('__blockId') === element.getAttribute('__blockId')));
    if (doomed.length) doc.transact(() => { for (const { index } of doomed.reverse()) root.delete(index, 1); }, DEDUPE);
  };
  doc.on('afterTransaction', afterUndo);

  Y.applyUpdate(doc, state, 'remote');
  editor.update(noop, { discrete: true });

  const flush = () => editor.update(noop, { discrete: true });
  const read = <T>(fn: () => T): T => { flush(); return editor.getEditorState().read(fn); };
  const blockKeys = () => read(() => $getRoot().getChildren().filter(isBlock).map((node) => node.getKey()));
  return {
    doc, editor, binding, undo, errors, payloadEvents,
    /** Each block's payload text, in document order. */
    texts: () => blockKeys().map((key) => payloadOf(key)?.toString() ?? '<no payload>'),
    paragraphs: () => read(() => $getRoot().getChildren().filter((node) => !isBlock(node)).map((node) => node.getTextContent())),
    insertBlock: (code: string) => editor.update(() => {
      const block = new SpikeBlock(code, crypto.randomUUID());
      $getRoot().getFirstChildOrThrow().insertAfter(block);
    }, { discrete: true }),
    /** Types into block `index`'s payload at `at` (a register write: diff ops under the local origin). */
    type: (index: number, at: number, text: string) => {
      const payload = payloadOf(blockKeys()[index]);
      if (!payload) throw new Error('no payload');
      doc.transact(() => payload.insert(Math.min(at, payload.length), text), PAYLOAD_LOCAL);
    },
    remove: (index: number) => editor.update(() => { $getNodeByKey(blockKeys()[index])!.remove(); }, { discrete: true }),
    /** Moves block `index` to the end of the root: V1 deletes its element and creates a new one. */
    moveToEnd: (index: number) => editor.update(() => { $getRoot().getLastChildOrThrow().insertAfter($getNodeByKey(blockKeys()[index])!); }, { discrete: true }),
    /** A local edit that touches the block without its payload (as a language or theme change does). */
    touch: (index: number) => editor.update(() => { $getNodeByKey(blockKeys()[index])!.getWritable(); }, { discrete: true }),
    dispose: () => { stopUpdates(); root.unobserveDeep(observer); doc.off('afterTransaction', afterUndo); undo.destroy(); doc.destroy(); },
  };
}
type PayloadClient = ReturnType<typeof payloadClient>;

/** A server doc seeded with "Intro." and "Outro." paragraphs, as the DocDO would hold it (gc on, no undo manager). */
function seededServer(): Y.Doc {
  const server = new Y.Doc();
  const seeder = payloadClient(Y.encodeStateAsUpdate(server));
  seeder.editor.update(() => {
    $getRoot().append($createParagraphNode().append($createTextNode('Intro.')), $createParagraphNode().append($createTextNode('Outro.')));
  }, { discrete: true });
  send(seeder.doc, server);
  seeder.dispose();
  return server;
}
const roundTrip = (server: Y.Doc, ...clients: PayloadClient[]) => {
  for (const client of clients) send(client.doc, server);
  for (const client of clients) send(server, client.doc);
};
const reader = (server: Y.Doc) => payloadClient(Y.encodeStateAsUpdate(server));

describe('T1.R spike: element-owned decorator payloads @p:col-1 @p:col-3', () => {
  it('a deleted block takes its payload text out of the state served to later readers and duplicates', () => {
    const server = seededServer();
    const ada = payloadClient(Y.encodeStateAsUpdate(server));
    try {
      ada.insertBlock('SECRET-alpha');
      roundTrip(server, ada);
      expect(contains(server, 'SECRET-alpha'), 'positive control').toBe(true);
      ada.remove(0);
      roundTrip(server, ada);
      expect(contains(server, 'SECRET-alpha')).toBe(false);
      const duplicate = new Y.Doc();
      Y.applyUpdate(duplicate, Y.encodeStateAsUpdate(server));
      expect(contains(duplicate, 'SECRET-alpha')).toBe(false);
      duplicate.destroy();
    } finally { ada.dispose(); }
  });

  it('the deleter undoes block and payload in one step after the server collected them; peers and readers see it', () => {
    const server = seededServer();
    const ada = payloadClient(Y.encodeStateAsUpdate(server));
    const ben = payloadClient(Y.encodeStateAsUpdate(server));
    try {
      ada.insertBlock('const kept = 1;');
      roundTrip(server, ada, ben);
      ben.undo.stopCapturing(); ben.type(0, 0, '/*ben*/'); roundTrip(server, ada, ben);
      ada.undo.stopCapturing(); ada.remove(0); roundTrip(server, ada, ben);
      expect(ben.texts()).toEqual([]);
      expect(contains(server, 'const kept')).toBe(false);
      ada.undo.undo();
      roundTrip(server, ada, ben);
      for (const peer of [ada, ben]) expect(peer.texts()).toEqual(['/*ben*/const kept = 1;']);
      const late = reader(server);
      expect(late.texts()).toEqual(['/*ben*/const kept = 1;']);
      late.dispose();
    } finally { ada.dispose(); ben.dispose(); }
  });

  it('a move carries one payload with every character, for peers and after reload', () => {
    const server = seededServer();
    const ada = payloadClient(Y.encodeStateAsUpdate(server));
    const ben = payloadClient(Y.encodeStateAsUpdate(server));
    try {
      ada.insertBlock('moved();');
      roundTrip(server, ada, ben);
      ben.type(0, 8, ' // ben'); roundTrip(server, ada, ben);
      ada.moveToEnd(0);
      roundTrip(server, ada, ben);
      for (const peer of [ada, ben]) expect(peer.texts()).toEqual(['moved(); // ben']);
      expect(ada.paragraphs()).toEqual(['Intro.', 'Outro.']);
      ada.type(0, 0, 'A'); roundTrip(server, ada, ben);
      expect(ben.texts()).toEqual(['Amoved(); // ben']);
      const late = reader(server);
      expect(late.texts()).toEqual(['Amoved(); // ben']);
      late.dispose();
    } finally { ada.dispose(); ben.dispose(); }
  });

  it.each(['deleter first', 'mover first'])('a delete racing a move keeps one block with the text once (%s); either undo keeps one', (order) => {
    const server = seededServer();
    const ada = payloadClient(Y.encodeStateAsUpdate(server));
    const ben = payloadClient(Y.encodeStateAsUpdate(server));
    const cat = payloadClient(Y.encodeStateAsUpdate(server));
    try {
      ada.insertBlock('race();');
      roundTrip(server, ada, ben, cat);
      for (const peer of [ada, ben]) peer.undo.stopCapturing();
      ben.remove(0);
      ada.moveToEnd(0);
      if (order === 'deleter first') roundTrip(server, ben, ada, cat); else roundTrip(server, ada, ben, cat);
      roundTrip(server, ada, ben, cat);
      for (const peer of [ada, ben, cat]) expect(peer.texts()).toEqual(['race();']);
      ben.undo.undo();
      roundTrip(server, ada, ben, cat);
      for (const peer of [ada, ben, cat]) expect(peer.texts(), "the deleter's undo restores nothing the move kept").toEqual(['race();']);
      cat.type(0, 7, ' // cat'); roundTrip(server, ada, ben, cat);
      ada.undo.undo();
      roundTrip(server, ada, ben, cat);
      for (const peer of [ada, ben, cat]) expect(peer.texts(), "the mover's undo puts it back, with the third peer's edit").toEqual(['race(); // cat']);
      const late = reader(server);
      expect(late.texts()).toEqual(['race(); // cat']);
      late.dispose();
    } finally { ada.dispose(); ben.dispose(); cat.dispose(); }
  });

  it('without the undo check, the deleter\'s undo after a raced move doubles the block (the V1 move limit)', () => {
    const server = seededServer();
    const ada = payloadClient(Y.encodeStateAsUpdate(server));
    const ben = payloadClient(Y.encodeStateAsUpdate(server), { dedupeUndo: false });
    try {
      ada.insertBlock('race();');
      roundTrip(server, ada, ben);
      ben.undo.stopCapturing(); ben.remove(0); ada.moveToEnd(0);
      roundTrip(server, ada, ben); roundTrip(server, ada, ben);
      ben.undo.undo();
      roundTrip(server, ada, ben);
      expect(ada.texts()).toEqual(['race();', 'race();']);
    } finally { ada.dispose(); ben.dispose(); }
  });

  it('two people typing in one payload merge, and undo removes only the undoer\'s text', () => {
    const server = seededServer();
    const ada = payloadClient(Y.encodeStateAsUpdate(server));
    const ben = payloadClient(Y.encodeStateAsUpdate(server));
    try {
      ada.insertBlock('seed');
      roundTrip(server, ada, ben);
      ada.undo.stopCapturing();
      ada.type(0, 0, 'Ada '); ben.type(0, 4, ' Ben');
      roundTrip(server, ada, ben);
      for (const peer of [ada, ben]) expect(peer.texts()).toEqual(['Ada seed Ben']);
      ada.undo.undo();
      roundTrip(server, ada, ben);
      for (const peer of [ada, ben]) expect(peer.texts()).toEqual(['seed Ben']);
      expect(ben.payloadEvents.length, 'a remote payload edit names its block directly').toBeGreaterThan(0);
      expect(new Set(ben.payloadEvents).size).toBe(1);
    } finally { ada.dispose(); ben.dispose(); }
  });

  it('a peer that joins at any point of a new block\'s drafting, and touches the block, never costs the drafter a character', () => {
    const server = seededServer();
    const ada = payloadClient(Y.encodeStateAsUpdate(server));
    const updates: Uint8Array[] = [];
    const record = (update: Uint8Array) => { updates.push(update); };
    ada.doc.on('update', record);
    try {
      ada.insertBlock('');
      for (const chunk of ['const ', 'ada', ' = 1;']) ada.type(0, 99, chunk);
      ada.doc.off('update', record);
      for (let prefix = 0; prefix <= updates.length; prefix++) {
        const partial = new Y.Doc();
        Y.applyUpdate(partial, Y.encodeStateAsUpdate(server));
        for (const update of updates.slice(0, prefix)) Y.applyUpdate(partial, update);
        const ben = payloadClient(Y.encodeStateAsUpdate(partial));
        partial.destroy();
        try {
          if (ben.texts().length) { ben.touch(0); ben.moveToEnd(0); }
          send(ada.doc, ben.doc); send(ben.doc, ada.doc);
          const merged = new Y.Doc(); send(ada.doc, merged);
          const late = payloadClient(Y.encodeStateAsUpdate(merged));
          expect(late.texts(), `ben joined after ${prefix} of ${updates.length} updates`).toEqual(['const ada = 1;']);
          late.dispose(); merged.destroy();
        } finally { ben.dispose(); }
      }
    } finally { ada.dispose(); }
  });

  it('an offline edit to a block another peer deleted stays deleted and is never served', () => {
    const server = seededServer();
    const ada = payloadClient(Y.encodeStateAsUpdate(server));
    const ben = payloadClient(Y.encodeStateAsUpdate(server));
    try {
      ada.insertBlock('shared');
      roundTrip(server, ada, ben);
      ben.type(0, 6, ' OFFLINE-ben');
      ada.remove(0);
      roundTrip(server, ada, ben);
      for (const peer of [ada, ben]) expect(peer.texts()).toEqual([]);
      expect(contains(server, 'OFFLINE-ben')).toBe(false);
    } finally { ada.dispose(); ben.dispose(); }
  });

  it('@lexical/yjs V1 cannot take a payload event, so the observer must route them (the seam is required)', () => {
    const server = seededServer();
    const ada = payloadClient(Y.encodeStateAsUpdate(server));
    const ben = payloadClient(Y.encodeStateAsUpdate(server), { filterPayloadEvents: false });
    try {
      ada.insertBlock('x');
      roundTrip(server, ada, ben);
      expect(ben.errors).toEqual([]);
      ada.type(0, 1, 'y');
      try { roundTrip(server, ada, ben); ben.texts(); } catch (error) { ben.errors.push(error); }
      expect(ben.errors.length).toBeGreaterThan(0);
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
function codeBlocks(editor: LexicalEditor): (LexicalNode & { getCode(): string; setCode(code: string): void })[] {
  const walk = (node: LexicalNode): LexicalNode[] => node.getType() === 'code-block' ? [node] : $isElementNode(node) ? node.getChildren().flatMap(walk) : [];
  return walk($getRoot()) as never;
}

describe('T1.R spike: the M1 register map, for comparison @p:col-1', () => {
  it('M1 map: a deleted block\'s payload is still served to later readers and duplicates (privacy P1)', () => {
    const server = new Y.Doc();
    importBody(server, 'Intro.\n\n```js\nSECRET-beta\n```');
    const ada = mapClient(Y.encodeStateAsUpdate(server));
    try {
      ada.editor.update(() => { codeBlocks(ada.editor)[0].remove(); }, { discrete: true });
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
        ada.editor.update(() => { codeBlocks(ada.editor)[0].setCode(text); }, { discrete: true });
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
            for (const block of codeBlocks(ben.editor)) (block.getWritable() as unknown as { __language: string }).__language = 'rust';
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
      ada.editor.update(() => { codeBlocks(ada.editor)[0].setCode('seed // ada'); }, { discrete: true });
      send(ada.doc, ben.doc);
      // Ben's field still holds "seed" plus his keystroke when a whole-value path (commit, double Enter) writes it.
      ben.editor.update(() => { codeBlocks(ben.editor)[0].setCode('seed!'); }, { discrete: true });
      send(ben.doc, ada.doc);
      ada.editor.update(noop, { discrete: true });
      expect(ada.editor.getEditorState().read(() => codeBlocks(ada.editor)[0].getCode())).toBe('seed!');
    } finally { ada.dispose(); ben.dispose(); server.destroy(); }
  });
});
