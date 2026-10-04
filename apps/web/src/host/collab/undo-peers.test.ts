// Two editors wired as the vendored collaboration plugin wires them (A§10.2): Cmd+Z undoes only this client's edits
// and never deletes a peer's text, and a deleted block's register payload leaves the shared state.
import { createBinding, syncLexicalUpdateToYjs, syncYjsChangesToLexical, type Provider } from '@lexical/yjs';
import { $createParagraphNode, $createTextNode, $getRoot, type ElementNode, type TextNode } from 'lexical';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { $importNoteBody, createConverterEditor, exportMarkdown } from '@moss-multi/sync/converter';
import { excludedPropertiesFor } from '@moss-multi/sync/excluded-properties';
import { bindRegisters } from '@moss-multi/sync/registers';
import { isOwnOrigin, syncUnderOrigin } from './origins.ts';
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
      expect([...server.getMap('registers').keys()], 'no register outlives its block').toEqual([]);
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
