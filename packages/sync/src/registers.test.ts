import { $copyNode, $getRoot, $isElementNode, COLLABORATION_TAG, type LexicalNode } from 'lexical';
import { describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { exportDocMarkdown, importBody, seedEmptyParagraph, serverWrite } from './server-doc.ts';
import { $importNoteBody, exportMarkdown, importMarkdown } from './converter/index.ts';
import { EXCLUDED_FIELDS } from './excluded-properties.ts';
import { createBinding, syncLexicalUpdateToYjs, syncYjsChangesToLexical, type Provider } from '@lexical/yjs';
import { createConverterEditor } from './converter/index.ts';
import { excludedPropertiesFor } from './excluded-properties.ts';
import { $assignRegisterIds, bindRegisters, migrateRegisters, REGISTER_LOCAL_ORIGIN } from './registers.ts';

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
});

describe('register refresh cost @p:col-1 @p:tech-8', () => {
  const blocks = 200;
  const lines = 400;
  // 200 distinct code blocks of about 10 KB each: a 2 MB note.
  const body = (i: number) => Array.from({ length: lines }, (_, line) => `const v${i}_${line} = ${line};`).join('\n');
  const markdown = `para\n\n${Array.from({ length: blocks }, (_, i) => `\`\`\`js\n${body(i)}\n\`\`\``).join('\n\n')}`;
  const blockBytes = body(0).length;
  /** Register bytes stringified while `run` runs; the shared tree's XmlText is not a register. */
  async function stringified(run: () => Promise<void> | void): Promise<number> {
    const original = Y.Text.prototype.toString;
    let bytes = 0;
    const spy = vi.spyOn(Y.Text.prototype as { toString(): string }, 'toString').mockImplementation(function (this: unknown) {
      const value = original.call(this as Y.Text);
      if (!(this instanceof Y.XmlText)) bytes += value.length;
      return value;
    });
    try { await run(); } finally { spy.mockRestore(); }
    return bytes;
  }

  it('a burst of small edits touches only the edited register, on the editing and the receiving client', async () => {
    const seed = new Y.Doc(); importBody(seed, markdown);
    const a = client(seed); const b = client(seed);
    const settle = () => new Promise(resolve => setTimeout(resolve, 0));
    const forward = (update: Uint8Array, origin: unknown) => { if (origin !== 'remote') Y.applyUpdate(b.doc, update, 'remote'); };
    a.doc.on('update', forward);
    const edits = 40;
    try {
      await settle();
      const started = performance.now();
      const paragraph = await stringified(async () => {
        for (let i = 0; i < edits; i++) {
          a.editor.update(() => {
            const text = $getRoot().getFirstDescendant() as LexicalNode & { setTextContent(text: string): void };
            text.setTextContent(`${text.getTextContent()}!`);
          }, { discrete: true });
          await settle();
        }
      });
      const register = await stringified(async () => {
        for (let i = 0; i < edits; i++) {
          a.editor.update(() => {
            const block = findAll('code-block')[blocks / 2] as unknown as { getCode(): string; setCode(code: string): void };
            block.setCode(`${block.getCode()}x`);
          }, { discrete: true });
          await settle();
        }
      });
      const elapsed = performance.now() - started;
      // The old refresh stringified every register on both peers per edit: 2 x 2 MB each time.
      expect(paragraph, 'paragraph typing reads no register').toBeLessThanOrEqual(blockBytes);
      expect(register, 'register typing reads only the edited register').toBeLessThanOrEqual(edits * 8 * (blockBytes + edits));
      expect(elapsed, 'the burst stays interactive').toBeLessThan(10_000);
      for (const peer of [a, b]) {
        expect(exportMarkdown(peer.editor)).toContain(`para${'!'.repeat(edits)}`);
        expect(exportMarkdown(peer.editor)).toContain(`${body(blocks / 2)}${'x'.repeat(edits)}`);
        peer.editor.read(() => {
          const cached = (findAll('code-block')[blocks / 2] as unknown as { __code: string }).__code;
          expect(cached, 'the render cache follows the register').toBe(`${body(blocks / 2)}${'x'.repeat(edits)}`);
        });
      }
      while (a.undo.canUndo()) a.undo.undo();
      await settle();
      for (const peer of [a, b]) {
        expect(exportMarkdown(peer.editor), 'undo restores the register').toContain(`${body(blocks / 2)}\n\`\`\``);
        expect(exportMarkdown(peer.editor)).not.toContain('para!');
      }
    } finally { a.doc.off('update', forward); a.dispose(); b.dispose(); seed.destroy(); }
  }, 120_000);

  it('a burst of root-level commits and same-node state replacements re-indexes and refreshes no payload', async () => {
    const seed = new Y.Doc(); importBody(seed, markdown);
    const a = client(seed);
    const settle = () => new Promise(resolve => setTimeout(resolve, 0));
    // Every register refresh is an editor.update tagged as one, whether or not it changes a node.
    let refreshes = 0;
    const update = a.editor.update.bind(a.editor);
    const spy = vi.spyOn(a.editor, 'update').mockImplementation((fn, options) => {
      const tags = options?.tag === undefined ? [] : [options.tag].flat();
      if (tags.includes('moss-multi:register-refresh')) refreshes++;
      return update(fn, options);
    });
    try {
      await settle();
      refreshes = 0;
      const bytes = await stringified(async () => {
        for (let i = 0; i < 40; i++) {
          // A root-only commit, then setEditorState with the same nodes: neither touches a payload node.
          a.editor.update(() => { $getRoot().setFormat(i % 2 ? 'center' : 'left'); }, { discrete: true });
          a.editor.setEditorState(a.editor.getEditorState().clone());
          await settle();
        }
      });
      expect(refreshes, 'no register refresh runs').toBe(0);
      expect(bytes, 'no payload is read').toBe(0);
      expect(exportMarkdown(a.editor)).toContain(body(blocks - 1));
    } finally { spy.mockRestore(); a.dispose(); seed.destroy(); }
  }, 120_000);

  it('the DocDO mirror stringifies each register a bounded number of times per server write', async () => {
    const live = new Y.Doc();
    try {
      importBody(live, markdown);
      const total = [...live.getMap<Y.Text>('registers').values()].reduce((sum, text) => sum + text.length, 0);
      const writes = 10;
      const started = performance.now();
      const bytes = await stringified(async () => {
        for (let i = 0; i < writes; i++) {
          serverWrite(live, 'burst', () => {
            const text = $getRoot().getFirstDescendant() as LexicalNode & { setTextContent(text: string): void };
            text.setTextContent(`${text.getTextContent()}!`);
          });
          await new Promise(resolve => setTimeout(resolve, 0));
        }
      });
      expect(bytes, 'one hydration pass per write').toBeLessThanOrEqual(writes * 2 * total);
      expect(performance.now() - started).toBeLessThan(30_000);
      expect(exportDocMarkdown(live)).toContain(`para${'!'.repeat(writes)}`);
    } finally { live.destroy(); }
  }, 120_000);

  it('assigns import identities to many identical blocks in linear time', () => {
    const count = 30_000;
    const editor = importMarkdown('```js\nsame\n```');
    editor.update(() => {
      const block = findAll('code-block')[0];
      for (let i = 1; i < count; i++) $getRoot().append($copyNode(block));
    }, { discrete: true });
    const started = performance.now();
    editor.update(() => $assignRegisterIds(), { discrete: true });
    const elapsed = performance.now() - started;
    const ids = editor.read(() => findAll('code-block').map(node => (node as unknown as { __regId: string }).__regId));
    expect(new Set(ids).size).toBe(count);
    expect(ids[0]).toMatch(/:0$/);
    expect(ids[count - 1]).toMatch(new RegExp(`:${count - 1}$`));
    expect(elapsed, 'quadratic ordinal probing takes tens of seconds here').toBeLessThan(3_000);
  }, 180_000);
});
