import { $getRoot, $isElementNode, COLLABORATION_TAG, type LexicalNode } from 'lexical';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { exportDocMarkdown, importBody, seedEmptyParagraph, serverWrite } from './server-doc.ts';
import { $importNoteBody, exportMarkdown, importMarkdown } from './converter/index.ts';
import { EXCLUDED_FIELDS } from './excluded-properties.ts';
import { createBinding, syncLexicalUpdateToYjs, syncYjsChangesToLexical, type Provider } from '@lexical/yjs';
import { createConverterEditor } from './converter/index.ts';
import { excludedPropertiesFor } from './excluded-properties.ts';
import { bindRegisters, migrateRegisters, REGISTER_LOCAL_ORIGIN } from './registers.ts';

const noop = () => {};
const provider = {
  awareness: { getLocalState: () => null, getStates: () => new Map(), on: noop, off: noop, setLocalState: noop, setLocalStateField: noop },
  connect: noop, disconnect: noop, on: noop, off: noop,
} as unknown as Provider;
function client(seed: Y.Doc) {
  const doc = new Y.Doc(); const editor = createConverterEditor();
  const binding = createBinding(editor, provider, 'root', doc, new Map([['root', doc]]), excludedPropertiesFor(editor));
  const stopRegisters = bindRegisters(editor, doc);
  const stop = editor.registerUpdateListener(({ prevEditorState, editorState, dirtyElements, dirtyLeaves, normalizedNodes, tags }) => {
    syncLexicalUpdateToYjs(binding, provider, prevEditorState, editorState, dirtyElements, dirtyLeaves, normalizedNodes, tags);
  });
  const root = binding.root.getSharedType();
  const observer: Parameters<typeof root.observeDeep>[0] = (events, transaction) => {
    if (transaction.origin !== binding) syncYjsChangesToLexical(binding, provider, events as never, false, noop);
  };
  root.observeDeep(observer);
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(seed));
  editor.update(noop, { discrete: true });
  const undo = new Y.UndoManager([root, doc.getMap('registers')], { trackedOrigins: new Set([binding, REGISTER_LOCAL_ORIGIN]) });
  return { doc, editor, undo, dispose: () => { undo.destroy(); stop(); stopRegisters(); root.unobserveDeep(observer); doc.destroy(); } };
}

const cases = [
  { type: 'code-block', field: '__code', setter: 'setCode', markdown: '```js\nseed\n```', before: 'seed', a: 'Ada seed', b: 'seed Ben', merged: 'Ada seed Ben' },
  { type: 'html-block', field: '__rawHtml', setter: 'setRawHtml', markdown: '```moss-html\n<p>seed</p>\n```', before: '<p>seed</p>', a: '<p>Ada seed</p>', b: '<p>seed Ben</p>', merged: '<p>Ada seed Ben</p>' },
  { type: 'formula', field: '__formula', setter: 'setFormula', markdown: '{{2+3|5}}', before: '2+3', a: '1+2+3', b: '2+3+4', merged: '1+2+3+4' },
] as const;

function findAll(type: string, node: LexicalNode = $getRoot()): LexicalNode[] {
  if (node.getType() === type) return [node];
  return $isElementNode(node) ? node.getChildren().flatMap(child => findAll(type, child)) : [];
}
function find(type: string, node: LexicalNode = $getRoot()): LexicalNode | undefined {
  if (node.getType() === type) return node;
  if ($isElementNode(node)) for (const child of node.getChildren()) { const found = find(type, child); if (found) return found; }
}

describe('L4 decorator registers @p:col-1 @p:col-3 @p:tech-1', () => {
  it.each([
    { ...cases[0], attribute: '__language', original: 'javascript', authored: 'rust' },
    { ...cases[2], attribute: '__result', original: '5', authored: '6' },
  ])('$type keeps a non-discrete payload and authored attribute in sync and undo', async (fixture) => {
    const seed = new Y.Doc(); importBody(seed, fixture.markdown);
    const a = client(seed); const b = client(seed);
    const settle = () => new Promise(resolve => setTimeout(resolve, 0));
    const read = (peer: ReturnType<typeof client>) => peer.editor.getEditorState().read(() =>
      (find(fixture.type) as unknown as Record<string, unknown>)[fixture.attribute]);
    try {
      await settle();
      a.editor.update(() => {
        const node = find(fixture.type)!;
        (node as unknown as Record<string, (text: string) => void>)[fixture.setter](fixture.a);
        (node.getWritable() as unknown as Record<string, unknown>)[fixture.attribute] = fixture.authored;
      });
      await settle();
      Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(a.doc));
      await settle();
      expect(read(a)).toBe(fixture.authored);
      expect(read(b), 'the companion attribute must reach the peer with the register edit').toBe(fixture.authored);
      const restored = client(a.doc);
      try { await settle(); expect(read(restored), 'persisted tree').toBe(fixture.authored); }
      finally { restored.dispose(); }
      a.undo.undo();
      await settle();
      Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(a.doc));
      await settle();
      for (const peer of [a, b]) {
        expect(read(peer), 'one undo restores both authored fields').toBe(fixture.original);
        expect(exportMarkdown(peer.editor)).toContain(fixture.before);
      }
    } finally { a.dispose(); b.dispose(); seed.destroy(); }
  });

  it('keeps a follow-up authored update eligible for background conversion', async () => {
    const seed = new Y.Doc(); importBody(seed, cases[0].markdown);
    const a = client(seed); const b = client(seed);
    const settle = () => new Promise(resolve => setTimeout(resolve, 0));
    const commits: Set<string>[] = [];
    const stop = a.editor.registerUpdateListener(({ tags }) => { commits.push(new Set(tags)); });
    try {
      await settle();
      const text = [...a.doc.getMap<Y.Text>('registers').values()][0];
      a.doc.transact(() => text.insert(0, 'peer '), 'remote');
      commits.length = 0;
      // Like a background writer's microtask, this starts before the queued refresh commits.
      queueMicrotask(() => a.editor.update(() => {
        (find('code-block')!.getWritable() as unknown as { __language: string }).__language = 'rust';
      }, { tag: 'authored-follow-up' }));
      await settle();
      const authored = commits.find(tags => tags.has('authored-follow-up'));
      expect(authored).toBeDefined();
      expect(authored!.has(COLLABORATION_TAG), 'background writers must see the authored commit').toBe(false);
      Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(a.doc));
      await settle();
      expect(exportMarkdown(b.editor)).toContain('```rust');
    } finally { stop(); a.dispose(); b.dispose(); seed.destroy(); }
  });

  it.each(cases)('$type replicates between live V1 editors and undo preserves peer writes', (fixture) => {
    const seed = new Y.Doc(); importBody(seed, fixture.markdown);
    const a = client(seed); const b = client(seed);
    try {
      for (const [peer, value] of [[a, fixture.a], [b, fixture.b]] as const) peer.editor.update(() => {
        const node = find(fixture.type) as unknown as Record<string, (text: string) => void>;
        node[fixture.setter](value);
      }, { discrete: true });
      Y.applyUpdate(a.doc, Y.encodeStateAsUpdate(b.doc));
      Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(a.doc));
      for (const peer of [a, b]) {
        peer.editor.update(noop, { discrete: true });
        expect(exportMarkdown(peer.editor)).toContain(fixture.merged);
      }
      a.undo.undo();
      Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(a.doc));
      for (const peer of [a, b]) {
        peer.editor.update(noop, { discrete: true });
        expect(exportMarkdown(peer.editor)).toContain(fixture.b);
      }
      a.undo.redo();
      expect(exportDocMarkdown(a.doc)).toContain(fixture.merged);
    } finally { a.dispose(); b.dispose(); seed.destroy(); }
  });

  it.each(cases)('$type merges concurrent setter writes through the mirror and survives persistence', (fixture) => {
    const a = new Y.Doc(); const b = new Y.Doc(); const restored = new Y.Doc();
    try {
      importBody(a, fixture.markdown);
      Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
      for (const [doc, value] of [[a, fixture.a], [b, fixture.b]] as const) {
        serverWrite(doc, 'local', () => {
          const node = find(fixture.type) as unknown as Record<string, (text: string) => void>;
          expect(node).toBeDefined();
          node[fixture.setter](value);
        });
      }
      Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
      Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
      expect(exportDocMarkdown(a)).toContain(fixture.merged);
      expect(exportDocMarkdown(b)).toBe(exportDocMarkdown(a));
      Y.applyUpdate(restored, Y.encodeStateAsUpdate(a));
      expect(exportDocMarkdown(restored)).toBe(exportDocMarkdown(a));
      expect([...a.getMap('registers').values()].some((value) => value instanceof Y.Text && value.toString() === fixture.merged)).toBe(true);
    } finally { a.destroy(); b.destroy(); restored.destroy(); }
  });

  it.each(cases)('$type keeps export bytes and moves its payload off whole-value attributes', (fixture) => {
    const doc = new Y.Doc();
    try {
      importBody(doc, fixture.markdown);
      expect(exportDocMarkdown(doc)).toBe(exportMarkdown(importMarkdown(fixture.markdown)));
      expect(EXCLUDED_FIELDS[fixture.type]).toContain(fixture.field);
      const registers = [...doc.getMap('registers').values()];
      expect(registers).toHaveLength(1);
      expect(registers[0]).toBeInstanceOf(Y.Text);
      expect((registers[0] as Y.Text).toString()).toBe(fixture.before);
    } finally { doc.destroy(); }
  });

  it('imports stable register identities and gives duplicate blocks independent payloads', () => {
    const markdown = cases.map(item => `${item.markdown}\n\n${item.markdown}`).join('\n\n');
    const a = new Y.Doc(); const b = new Y.Doc();
    try {
      importBody(a, markdown); importBody(b, markdown);
      expect([...a.getMap('registers').keys()]).toEqual([...b.getMap('registers').keys()]);
      expect(a.getMap('registers').size).toBe(6);
      const before = exportDocMarkdown(b);
      const text = [...a.getMap<Y.Text>('registers').values()].find(value => value.toString() === 'seed')!;
      a.transact(() => text.insert(0, 'changed '), 'peer');
      expect(exportDocMarkdown(a).match(/changed seed/g)).toHaveLength(1);
      expect(exportDocMarkdown(b)).toBe(before);
    } finally { a.destroy(); b.destroy(); }
  });

  it.each(cases)('$type pasted concurrently into one empty note by two editors stays two independent registers', (fixture) => {
    const getter = { 'code-block': 'getCode', 'html-block': 'getRawHtml', formula: 'getFormula' }[fixture.type];
    const seed = new Y.Doc(); seedEmptyParagraph(seed);
    const a = client(seed); const b = client(seed);
    const blocks = () => findAll(fixture.type) as unknown as (Record<string, () => string> & { __regId: string })[];
    const texts = (peer: ReturnType<typeof client>) => peer.editor.read(() => blocks().map(block => block[getter]()).sort());
    try {
      // MarkdownEditor's whole-note paste seam imports into an empty note through the converter.
      for (const peer of [a, b]) peer.editor.update(() => $importNoteBody(fixture.markdown, { comments: {} }), { discrete: true });
      for (const [peer, value] of [[a, fixture.a], [b, fixture.b]] as const) peer.editor.update(() => {
        (find(fixture.type) as unknown as Record<string, (text: string) => void>)[fixture.setter](value);
      }, { discrete: true });
      Y.applyUpdate(a.doc, Y.encodeStateAsUpdate(b.doc));
      Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(a.doc));
      for (const peer of [a, b]) {
        peer.editor.update(noop, { discrete: true });
        const ids = peer.editor.read(() => blocks().map(block => block.__regId));
        expect(ids).toHaveLength(2);
        expect(ids[0], 'concurrent pastes must not share a register').not.toBe(ids[1]);
        expect(texts(peer), 'both authors keep their typing').toEqual([fixture.a, fixture.b].sort());
      }
      a.editor.update(() => {
        const node = blocks().find(block => block[getter]() === fixture.a) as unknown as Record<string, (text: string) => void>;
        node[fixture.setter](`${fixture.a}!`);
      }, { discrete: true });
      Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(a.doc));
      b.editor.update(noop, { discrete: true });
      expect(texts(b), 'editing one block leaves the other').toEqual([`${fixture.a}!`, fixture.b].sort());
    } finally { a.dispose(); b.dispose(); seed.destroy(); }
  });

  it('upgrades persisted attributes without replacing nodes or changing export bytes', () => {
    const legacy = new Y.Doc();
    const root = legacy.get('root', Y.XmlText);
    const block = new Y.XmlElement('code-block');
    root.insertEmbed(0, block);
    block.setAttribute('__type', 'code-block'); block.setAttribute('__code', 'stored code');
    block.setAttribute('__language', 'plaintext');
    block.setAttribute('__commentIds', [] as never);
    const identity = block._item!.id;
    const restored = new Y.Doc();
    try {
      Y.applyUpdate(restored, Y.encodeStateAsUpdate(legacy));
      migrateRegisters(restored);
      expect(exportDocMarkdown(restored)).toContain('stored code');
      const node = restored.get('root', Y.XmlText).toDelta()[0].insert as Y.XmlElement;
      expect(node._item!.id).toEqual(identity);
      const bytes = Y.encodeStateAsUpdate(restored);
      migrateRegisters(restored);
      expect(Y.encodeStateAsUpdate(restored)).toEqual(bytes);
      expect(node.getAttribute('__code')).toBe('stored code');
    } finally { legacy.destroy(); restored.destroy(); }
  });

  it('a server write that deletes register blocks deletes their payloads with them', () => {
    const live = new Y.Doc();
    try {
      importBody(live, 'Intro.\n\n```js\nconst KEY = "SECRET-123";\n```\n\n{{2+3|5}}');
      expect(live.getMap('registers').size).toBe(2);
      serverWrite(live, 'test-delete', () => { for (const node of $getRoot().getChildren()) if (node.getTextContent() !== 'Intro.') node.remove(); });
      expect([...live.getMap('registers').keys()]).toEqual([]);
      expect(new TextDecoder().decode(Y.encodeStateAsUpdate(live))).not.toContain('SECRET-123');
      importBody(live, 'Replaced.\n\n```js\nnext\n```');
      importBody(live, 'Replaced again.');
      expect(live.getMap('registers').size, 'a body replacement leaves no orphans').toBe(0);
    } finally { live.destroy(); }
  });
});
