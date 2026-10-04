// Two editors wired as the vendored collaboration plugin wires them (A§10.2): Cmd+Z undoes only this client's edits
// and never deletes a peer's text, and a deleted block's register payload leaves the shared state.
import { createBinding, syncLexicalUpdateToYjs, syncYjsChangesToLexical, type Provider } from '@lexical/yjs';
import { $createParagraphNode, $createTextNode, $getNodeByKey, $getRoot, type ElementNode, type TextNode } from 'lexical';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { $importNoteBody, createConverterEditor, exportMarkdown } from '@moss-multi/sync/converter';
import { excludedPropertiesFor } from '@moss-multi/sync/excluded-properties';
import { bindRegisters } from '@moss-multi/sync/registers';
import { isOwnOrigin, syncUnderOrigin } from './origins.ts';
import { nodeRegister } from './register-input.ts';
import { createBindingUndoManager } from './undo.ts';

const noop = () => {};
const provider = {
  awareness: { getLocalState: () => null, getStates: () => new Map(), on: noop, off: noop, setLocalState: noop, setLocalStateField: noop },
  connect: noop, disconnect: noop, on: noop, off: noop,
} as unknown as Provider;
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

function peer(seed?: Y.Doc) {
  const doc = new Y.Doc(); const editor = createConverterEditor();
  const binding = createBinding(editor, provider, 'root', doc, new Map([['root', doc]]), excludedPropertiesFor(editor));
  const stopRegisters = bindRegisters(editor, doc);
  const stop = editor.registerUpdateListener(({ prevEditorState, editorState, dirtyElements, dirtyLeaves, normalizedNodes, tags }) => {
    syncUnderOrigin(binding, tags, () => syncLexicalUpdateToYjs(binding, provider, prevEditorState, editorState, dirtyElements, dirtyLeaves, normalizedNodes, tags));
  });
  const root = binding.root.getSharedType();
  const observer: Parameters<typeof root.observeDeep>[0] = (events, transaction) => {
    if (!isOwnOrigin(transaction.origin, binding)) syncYjsChangesToLexical(binding, provider, events as never, transaction.origin instanceof Y.UndoManager, noop);
  };
  root.observeDeep(observer);
  if (seed) Y.applyUpdate(doc, Y.encodeStateAsUpdate(seed));
  editor.update(noop, { discrete: true });
  const undo = createBindingUndoManager(binding);
  const text = () => editor.getEditorState().read(() => $getRoot().getTextContent());
  return { doc, editor, undo, text, dispose: () => { undo.destroy(); stop(); stopRegisters(); root.unobserveDeep(observer); doc.destroy(); } };
}
type Peer = ReturnType<typeof peer>;

async function exchange(...peers: Peer[]) {
  for (let round = 0; round < 3; round++) {
    for (const from of peers) for (const to of peers) if (from !== to) Y.applyUpdate(to.doc, Y.encodeStateAsUpdate(from.doc, Y.encodeStateVector(to.doc)));
    await settle();
  }
}
function seeded(build: () => void): Peer {
  const seeder = peer();
  seeder.editor.update(build, { discrete: true });
  return seeder;
}
const lastText = () => ($getRoot().getLastChild() as ElementNode).getFirstChild() as TextNode;
const append = (actor: Peer, text: string) => actor.editor.update(() => {
  const node = lastText(); node.setTextContent(node.getTextContent() + text);
}, { discrete: true });

describe('undo never removes a peer\'s text @p:col-3', () => {
  it('undoing typing that created a text node keeps the peer\'s characters typed onto it', async () => {
    const seeder = seeded(() => $getRoot().append($createParagraphNode()));
    const ada = peer(seeder.doc); const ben = peer(seeder.doc);
    try {
      await settle();
      ada.editor.update(() => ($getRoot().getLastChild() as ElementNode).append($createTextNode('Alpha.')), { discrete: true });
      await exchange(ada, ben); ada.undo.stopCapturing();
      append(ben, ' Beta.');
      await exchange(ada, ben);
      for (const actor of [ada, ben]) expect(actor.text()).toBe('Alpha. Beta.');
      ada.undo.undo();
      await exchange(ada, ben);
      for (const actor of [ada, ben]) expect(actor.text(), 'Ada\'s Cmd+Z must leave Ben\'s text').toBe(' Beta.');
      const reopened = peer(ben.doc);
      try { await settle(); expect(reopened.text()).toBe(' Beta.'); } finally { reopened.dispose(); }
      ada.undo.redo();
      await exchange(ada, ben);
      for (const actor of [ada, ben]) expect(actor.text()).toBe('Alpha. Beta.');
    } finally { ada.dispose(); ben.dispose(); seeder.dispose(); }
  });

  it('undoing a paragraph the peer typed into keeps the paragraph and the peer\'s text', async () => {
    const seeder = seeded(() => $getRoot().append($createParagraphNode().append($createTextNode('Intro.'))));
    const ada = peer(seeder.doc); const ben = peer(seeder.doc);
    try {
      await settle();
      ada.editor.update(() => $getRoot().append($createParagraphNode().append($createTextNode('Ada line'))), { discrete: true });
      await exchange(ada, ben); ada.undo.stopCapturing();
      append(ben, ' Ben');
      await exchange(ada, ben);
      ada.undo.undo();
      await exchange(ada, ben);
      for (const actor of [ada, ben]) expect(actor.text()).toBe('Intro.\n\n Ben');
    } finally { ada.dispose(); ben.dispose(); seeder.dispose(); }
  });
  it('an undo that skips a fully kept step still keeps the peer\'s text in the older step', async () => {
    const seeder = seeded(() => $getRoot().append($createParagraphNode().append($createTextNode('Intro.'))));
    const ada = peer(seeder.doc); const ben = peer(seeder.doc);
    try {
      await settle();
      for (const step of [
        () => $getRoot().append($createParagraphNode()),
        () => ($getRoot().getLastChild() as ElementNode).append($createTextNode('One')),
        () => $getRoot().append($createParagraphNode()),
      ]) { ada.editor.update(step, { discrete: true }); ada.undo.stopCapturing(); }
      await exchange(ada, ben);
      ben.editor.update(() => {
        const one = ($getRoot().getChildAtIndex(1) as ElementNode).getFirstChild() as TextNode;
        one.setTextContent('One B1');
        ($getRoot().getLastChild() as ElementNode).append($createTextNode('B2'));
      }, { discrete: true });
      await exchange(ada, ben);
      for (const actor of [ada, ben]) expect(actor.text()).toBe('Intro.\n\nOne B1\n\nB2');
      // The newest step (the paragraph Ben typed B2 into) is kept whole, so Yjs moves on to Ada's 'One'.
      ada.undo.undo();
      await exchange(ada, ben);
      for (const actor of [ada, ben]) expect(actor.text(), 'Ada\'s Cmd+Z must leave Ben\'s text').toBe('Intro.\n\n B1\n\nB2');
      const reopened = peer(ben.doc);
      try { await settle(); expect(reopened.text()).toBe('Intro.\n\n B1\n\nB2'); } finally { reopened.dispose(); }
    } finally { ada.dispose(); ben.dispose(); seeder.dispose(); }
  });
});

const CODE_NOTE = 'Intro.\n\n```js\nconst kept = 1;\n```\n\nOutro.';
const types = (actor: Peer) => actor.editor.getEditorState().read(() => $getRoot().getChildren().map(node => node.getType()));
const codeBlock = () => $getRoot().getChildren().find(node => node.getType() === 'code-block')!;
const moveCodeFirst = () => $getRoot().getFirstChild()!.insertBefore(codeBlock());

describe('moving a register block', () => {
  it('undoing a move leaves one block', async () => {
    const seeder = seeded(() => $importNoteBody(CODE_NOTE));
    const ben = peer(seeder.doc);
    try {
      await settle();
      ben.editor.update(moveCodeFirst, { discrete: true });
      await settle();
      expect(types(ben)).toEqual(['code-block', 'paragraph', 'paragraph']);
      ben.undo.undo();
      await settle();
      expect(types(ben), 'undo must not keep both copies').toEqual(['paragraph', 'code-block', 'paragraph']);
      const reopened = peer(ben.doc);
      try { await settle(); expect(types(reopened)).toEqual(['paragraph', 'code-block', 'paragraph']); } finally { reopened.dispose(); }
    } finally { ben.dispose(); seeder.dispose(); }
  });

  it('a block one peer moves while another deletes it keeps its code', async () => {
    const seeder = seeded(() => $importNoteBody(CODE_NOTE));
    const ada = peer(seeder.doc); const ben = peer(seeder.doc);
    try {
      await settle();
      ada.editor.update(() => codeBlock().remove(), { discrete: true });
      ben.editor.update(moveCodeFirst, { discrete: true });
      await settle();
      await exchange(ada, ben);
      for (const actor of [ada, ben]) {
        expect(types(actor)).toEqual(['code-block', 'paragraph', 'paragraph']);
        expect(exportMarkdown(actor.editor), 'the surviving block keeps its payload').toContain('const kept = 1;');
      }
      const reopened = peer(ada.doc);
      try { await settle(); expect(exportMarkdown(reopened.editor)).toContain('const kept = 1;'); } finally { reopened.dispose(); }
    } finally { ada.dispose(); ben.dispose(); seeder.dispose(); }
  });
});

type CodeNode = { getKey(): string; getCode(): string; setCode(code: string): void };
const codeKey = (actor: Peer) => actor.editor.getEditorState().read(() => codeBlock().getKey());
const code = (actor: Peer) => actor.editor.getEditorState().read(() => (codeBlock() as unknown as CodeNode).getCode());
// What an open code view's setter does: it writes its draft, the bound register's text plus the keystroke.
const typeCode = (actor: Peer, key: string, next: string) => actor.editor.update(() => {
  ($getNodeByKey(key) as unknown as CodeNode).setCode(next);
}, { discrete: true });
const send = (from: Peer, to: Peer) => Y.applyUpdate(to.doc, Y.encodeStateAsUpdate(from.doc, Y.encodeStateVector(to.doc)));
const occurrences = (actor: Peer, text: string) => exportMarkdown(actor.editor).split(text).length - 1;

describe('a delete racing a move', () => {
  it('the mover\'s open view stays bound to the live payload', async () => {
    const seeder = seeded(() => $importNoteBody(CODE_NOTE));
    const ada = peer(seeder.doc); const ben = peer(seeder.doc);
    try {
      await settle();
      ada.editor.update(() => codeBlock().remove(), { discrete: true });
      ben.editor.update(moveCodeFirst, { discrete: true });
      await settle();
      const key = codeKey(ben);
      const bound = nodeRegister(ben.editor, key)!;
      await exchange(ada, ben);
      typeCode(ada, codeKey(ada), `${code(ada)} // ada`);
      await exchange(ada, ben);
      expect(bound.toString(), 'Ben\'s open view must receive Ada\'s edit').toBe('const kept = 1; // ada');
      typeCode(ben, key, `${bound.toString()}!`);
      await exchange(ada, ben);
      for (const actor of [ada, ben]) expect(code(actor), 'Ben\'s keystroke must keep Ada\'s text').toBe('const kept = 1; // ada!');
    } finally { ada.dispose(); ben.dispose(); seeder.dispose(); }
  });

  it('a third peer\'s concurrent edit to the payload survives', async () => {
    const seeder = seeded(() => $importNoteBody(CODE_NOTE));
    const ada = peer(seeder.doc); const ben = peer(seeder.doc); const carl = peer(seeder.doc);
    try {
      await settle();
      ada.editor.update(() => codeBlock().remove(), { discrete: true });
      ben.editor.update(moveCodeFirst, { discrete: true });
      typeCode(carl, codeKey(carl), `${code(carl)} // carl`);
      await settle();
      await exchange(ada, ben, carl);
      for (const actor of [ada, ben, carl]) {
        expect(types(actor)).toEqual(['code-block', 'paragraph', 'paragraph']);
        expect(code(actor), 'Carl\'s edit must survive').toBe('const kept = 1; // carl');
      }
    } finally { ada.dispose(); ben.dispose(); carl.dispose(); seeder.dispose(); }
  });

  it('a peer that saw the move first restores no second copy, and both keep typing', async () => {
    const seeder = seeded(() => $importNoteBody(CODE_NOTE));
    const ada = peer(seeder.doc); const ben = peer(seeder.doc); const dan = peer(seeder.doc);
    try {
      await settle();
      ada.editor.update(() => codeBlock().remove(), { discrete: true });
      ben.editor.update(moveCodeFirst, { discrete: true });
      await settle();
      send(ben, dan); await settle();
      send(ada, dan); send(ada, ben); await settle();
      typeCode(ben, codeKey(ben), `${code(ben)} B`);
      typeCode(dan, codeKey(dan), `${code(dan)} D`);
      await exchange(ada, ben, dan);
      for (const actor of [ada, ben, dan]) {
        expect(types(actor)).toEqual(['code-block', 'paragraph', 'paragraph']);
        expect(occurrences(actor, 'const kept = 1;'), 'one copy of the payload').toBe(1);
        expect(code(actor)).toContain(' B');
        expect(code(actor)).toContain(' D');
      }
      expect(code(ada)).toBe(code(ben)); expect(code(ben)).toBe(code(dan));
    } finally { ada.dispose(); ben.dispose(); dan.dispose(); seeder.dispose(); }
  });
});

describe('a deleted block\'s register payload leaves the shared state', () => {
  it('later readers never receive deleted code, and undo restores it', async () => {
    const seeder = seeded(() => $importNoteBody('Intro.\n\n```js\nconst KEY = "SECRET-123";\n```'));
    // The server applies client updates to its own doc, which keeps no undo history.
    const server = new Y.Doc(); Y.applyUpdate(server, Y.encodeStateAsUpdate(seeder.doc));
    const ada = peer(server);
    const toServer = () => Y.applyUpdate(server, Y.encodeStateAsUpdate(ada.doc, Y.encodeStateVector(server)));
    const leaked = () => new TextDecoder().decode(Y.encodeStateAsUpdate(server)).includes('SECRET-123');
    try {
      await settle();
      expect(leaked()).toBe(true);
      ada.editor.update(() => { for (const node of $getRoot().getChildren()) if (node.getType() === 'code-block') node.remove(); }, { discrete: true });
      await settle(); toServer();
      expect(exportMarkdown(ada.editor)).not.toContain('SECRET-123');
      expect([...server.getMap<Y.Text>('registers').values()].map(text => text.toString()), 'no payload outlives its block').toEqual(['']);
      expect(leaked(), 'a viewer shared in later must not receive deleted code').toBe(false);
      ada.undo.undo();
      await settle(); toServer();
      expect(exportMarkdown(ada.editor)).toContain('const KEY = "SECRET-123";');
      const reader = new Y.Doc(); Y.applyUpdate(reader, Y.encodeStateAsUpdate(server));
      expect([...reader.getMap<Y.Text>('registers').values()].map(text => text.toString())).toEqual(['const KEY = "SECRET-123";']);
      reader.destroy();
    } finally { ada.dispose(); seeder.dispose(); server.destroy(); }
  });
});
