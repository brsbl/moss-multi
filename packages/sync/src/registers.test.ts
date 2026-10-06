import { $copyNode, $getRoot, $isElementNode, COLLABORATION_TAG, type LexicalNode } from 'lexical';
import { describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { exportDocMarkdown, importBody, seedEmptyParagraph, serverWrite } from './server-doc.ts';
import { $importNoteBody, exportMarkdown, importMarkdown } from './converter/index.ts';
import { EXCLUDED_FIELDS } from './excluded-properties.ts';
import { createBinding, syncLexicalUpdateToYjs, syncYjsChangesToLexical, type Provider } from '@lexical/yjs';
import { createConverterEditor } from './converter/index.ts';
import { excludedPropertiesFor } from './excluded-properties.ts';
import { $assignRegisterIds, bindRegisters, payloadTextOf, REGISTER_LOCAL_ORIGIN } from './registers.ts';
import { BodyUndo, lexicalAction, payloadDocsFor, payloadText } from './payload-docs.ts';
import { migratePayloads } from './payloads.ts';

const noop = () => {};
const provider = {
  awareness: { getLocalState: () => null, getStates: () => new Map(), on: noop, off: noop, setLocalState: noop, setLocalStateField: noop },
  connect: noop, disconnect: noop, on: noop, off: noop,
} as unknown as Provider;
/** One direction of a network: the note's update and every payload's, as a client would receive them. */
function share(from: Y.Doc, to: Y.Doc) {
  Y.applyUpdate(to, Y.encodeStateAsUpdate(from, Y.encodeStateVector(to)), 'remote');
  const target = payloadDocsFor(to);
  for (const [id, doc] of payloadDocsFor(from).docs) {
    const held = target.hold(id);
    Y.applyUpdate(held, Y.encodeStateAsUpdate(doc, Y.encodeStateVector(held)), 'remote');
  }
}
/** Forwards every later local write of `from` (note and payloads) to `to`; returns the unlinker. */
function link(from: Y.Doc, to: Y.Doc): () => void {
  const stops: (() => void)[] = [];
  const forward = (target: () => Y.Doc) => (update: Uint8Array, origin: unknown) => { if (origin !== 'remote') Y.applyUpdate(target(), update, 'remote'); };
  const watch = (doc: Y.Doc, target: () => Y.Doc) => { const handler = forward(target); doc.on('update', handler); stops.push(() => doc.off('update', handler)); };
  watch(from, () => to);
  const host = payloadDocsFor(from);
  for (const [id, doc] of host.docs) watch(doc, () => payloadDocsFor(to).hold(id));
  stops.push(host.onHold((id, doc) => watch(doc, () => payloadDocsFor(to).hold(id))));
  return () => stops.forEach(stop => stop());
}
const payloadsOf = (doc: Y.Doc) => [...payloadDocsFor(doc).docs.values()].map(payload => payloadText(payload).toString());

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
  const undo = new BodyUndo(new Y.UndoManager(root, { trackedOrigins: new Set([binding]) }), lexicalAction(editor));
  const host = payloadDocsFor(doc);
  const stopHold = host.onHold((_id, payload) => { undo.trackPayload(payload, REGISTER_LOCAL_ORIGIN, 500); });
  share(seed, doc);
  editor.update(noop, { discrete: true });
  return { doc, editor, undo, dispose: () => { stopHold(); undo.destroy(); stop(); stopRegisters(); root.unobserveDeep(observer); host.destroy(); doc.destroy(); } };
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
      share(a.doc, b.doc);
      await settle();
      expect(read(a)).toBe(fixture.authored);
      expect(read(b), 'the companion attribute must reach the peer with the register edit').toBe(fixture.authored);
      const restored = client(a.doc);
      try { await settle(); expect(read(restored), 'persisted tree').toBe(fixture.authored); }
      finally { restored.dispose(); }
      a.undo.undo();
      await settle();
      share(a.doc, b.doc);
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
      const payload = [...payloadDocsFor(a.doc).docs.values()][0];
      payload.transact(() => payloadText(payload).insert(0, 'peer '), 'remote');
      commits.length = 0;
      // Like a background writer's microtask, this starts before the queued refresh commits.
      queueMicrotask(() => a.editor.update(() => {
        (find('code-block')!.getWritable() as unknown as { __language: string }).__language = 'rust';
      }, { tag: 'authored-follow-up' }));
      await settle();
      const authored = commits.find(tags => tags.has('authored-follow-up'));
      expect(authored).toBeDefined();
      expect(authored!.has(COLLABORATION_TAG), 'background writers must see the authored commit').toBe(false);
      share(a.doc, b.doc);
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
      share(b.doc, a.doc);
      share(a.doc, b.doc);
      for (const peer of [a, b]) {
        peer.editor.update(noop, { discrete: true });
        expect(exportMarkdown(peer.editor)).toContain(fixture.merged);
      }
      a.undo.undo();
      share(a.doc, b.doc);
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
      share(a, b);
      for (const [doc, value] of [[a, fixture.a], [b, fixture.b]] as const) {
        serverWrite(doc, 'local', () => {
          const node = find(fixture.type) as unknown as Record<string, (text: string) => void>;
          expect(node).toBeDefined();
          node[fixture.setter](value);
        });
      }
      share(b, a);
      share(a, b);
      expect(exportDocMarkdown(a)).toContain(fixture.merged);
      expect(exportDocMarkdown(b)).toBe(exportDocMarkdown(a));
      share(a, restored);
      expect(exportDocMarkdown(restored)).toBe(exportDocMarkdown(a));
      expect(payloadsOf(a)).toContain(fixture.merged);
    } finally { a.destroy(); b.destroy(); restored.destroy(); }
  });

  it.each(cases)('$type keeps export bytes and moves its payload off whole-value attributes', (fixture) => {
    const doc = new Y.Doc();
    try {
      importBody(doc, fixture.markdown);
      expect(exportDocMarkdown(doc)).toBe(exportMarkdown(importMarkdown(fixture.markdown)));
      expect(EXCLUDED_FIELDS[fixture.type]).toContain(fixture.field);
      expect(payloadsOf(doc)).toEqual([fixture.before]);
      expect(Buffer.from(Y.encodeStateAsUpdate(doc)).includes(fixture.before), "the note's own state carries no payload text").toBe(false);
    } finally { doc.destroy(); }
  });

  it.each(cases)('$type copied with $copyNode gets its own payload, seeded with the source text', async (fixture) => {
    const getter = { 'code-block': 'getCode', 'html-block': 'getRawHtml', formula: 'getFormula' }[fixture.type];
    const seed = new Y.Doc(); importBody(seed, fixture.markdown);
    const a = client(seed);
    const blocks = () => findAll(fixture.type) as unknown as (LexicalNode & Record<string, (text?: string) => string> & { __regId: string })[];
    try {
      a.editor.update(() => { const node = blocks()[0]; node.insertAfter($copyNode(node)); }, { discrete: true });
      const ids = a.editor.read(() => blocks().map(block => block.__regId));
      expect(new Set(ids).size, 'the copy mints its own id').toBe(2);
      expect(a.editor.read(() => blocks().map(block => block[getter]()))).toEqual([fixture.before, fixture.before]);
      await new Promise(resolve => setTimeout(resolve, 0));
      a.editor.update(() => { blocks()[1][fixture.setter](fixture.a); }, { discrete: true });
      expect(a.editor.read(() => blocks().map(block => block[getter]())), 'editing the copy leaves the source').toEqual([fixture.before, fixture.a]);
      expect(payloadsOf(a.doc).sort()).toEqual([fixture.a, fixture.before].sort());
    } finally { a.dispose(); seed.destroy(); }
  });

  it('a view that subscribes before a new block\'s first text is written receives it', async () => {
    const seed = new Y.Doc(); seedEmptyParagraph(seed);
    const a = client(seed);
    try {
      let key = '';
      a.editor.update(() => {
        const klass = a.editor._nodes.get('code-block')!.klass as unknown as new (code: string) => LexicalNode;
        const node = new klass('minted();');
        $getRoot().append(node);
        key = node.getKey();
      }, { discrete: true });
      const text = payloadTextOf(a.editor, key)!;
      const seen: string[] = [];
      text.observe(() => seen.push(text.toString()));
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(seen).toEqual(['minted();']);
      expect(a.editor.read(() => (findAll('code-block')[0] as unknown as { getCode(): string }).getCode())).toBe('minted();');
    } finally { a.dispose(); seed.destroy(); }
  });

  it('imports unguessable identities and gives duplicate blocks independent payloads', () => {
    const markdown = cases.map(item => `${item.markdown}\n\n${item.markdown}`).join('\n\n');
    const a = new Y.Doc(); const b = new Y.Doc();
    try {
      importBody(a, markdown); importBody(b, markdown);
      const ids = [...payloadDocsFor(a).docs.keys(), ...payloadDocsFor(b).docs.keys()];
      expect(new Set(ids).size, 'two imports of the same markdown share no id').toBe(12);
      for (const id of ids) expect(id, 'an id is 128 random bits').toMatch(/^[0-9a-f]{32}$/);
      const before = exportDocMarkdown(b);
      const payload = [...payloadDocsFor(a).docs.values()].find(value => payloadText(value).toString() === 'seed')!;
      payload.transact(() => payloadText(payload).insert(0, 'changed '), 'peer');
      expect(exportDocMarkdown(a).match(/changed seed/g)).toHaveLength(1);
      expect(exportDocMarkdown(b)).toBe(before);
    } finally { a.destroy(); b.destroy(); }
  });

  it.each(cases)('$type pasted concurrently into one empty note by two editors stays two independent registers', async (fixture) => {
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
      // A client writes its new blocks' first texts just after the commit.
      await new Promise(resolve => setTimeout(resolve, 0));
      share(b.doc, a.doc);
      share(a.doc, b.doc);
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
      share(a.doc, b.doc);
      b.editor.update(noop, { discrete: true });
      expect(texts(b), 'editing one block leaves the other').toEqual([`${fixture.a}!`, fixture.b].sort());
    } finally { a.dispose(); b.dispose(); seed.destroy(); }
  });

  it.each([
    {
      layout: 'a pre-register note (no __regId, empty registers map)',
      blocks: [{ __code: 'stored code' }] as Record<string, string>[], registers: {} as Record<string, string>,
      kept: ['stored code'], dropped: [] as string[],
    },
    {
      // M1's migrateRegisters set __regId and left the legacy attribute; the register later diverged from it.
      layout: 'a pre-register note migrated by M1 (id set, legacy attribute kept)',
      blocks: [{ __regId: 'code:1', __code: 'STALE-legacy' }, { __regId: 'code:2', __code: 'ATTR-only' }] as Record<string, string>[],
      registers: { 'code:1': 'edited in the register' },
      // An id with no register keeps its attribute text as its payload.
      kept: ['edited in the register', 'ATTR-only'], dropped: ['STALE-legacy'],
    },
  ])('$layout moves its payload text out of the note in place, keeping no legacy text', ({ blocks, registers, kept, dropped }) => {
    const legacy = new Y.Doc();
    const root = legacy.get('root', Y.XmlText);
    const identities: Y.ID[] = [];
    legacy.transact(() => {
      blocks.forEach((attrs, index) => {
        const block = new Y.XmlElement('code-block');
        root.insertEmbed(index, block);
        for (const [key, value] of Object.entries({ __type: 'code-block', __language: 'plaintext', __commentIds: [], ...attrs })) block.setAttribute(key, value as never);
        identities.push(block._item!.id);
      });
      for (const [id, text] of Object.entries(registers)) legacy.getMap<Y.Text>('registers').set(id, new Y.Text(text));
    });
    const texts = [...blocks.map(block => block.__code), ...Object.values(registers)];
    const restored = new Y.Doc();
    try {
      Y.applyUpdate(restored, Y.encodeStateAsUpdate(legacy));
      const host = payloadDocsFor(restored);
      const write = (id: string, text: string) => { const doc = host.hold(id); payloadText(doc).insert(0, text); };
      expect(migratePayloads(restored, write)).toBe(true);
      const nodes = restored.get('root', Y.XmlText).toDelta().map((op: { insert: Y.XmlElement }) => op.insert);
      expect(nodes.map(node => node._item!.id), 'no node is replaced').toEqual(identities);
      for (const node of nodes) expect(node.getAttribute('__code'), 'no legacy attribute survives').toBeUndefined();
      const bytes = Y.encodeStateAsUpdate(restored);
      for (const text of texts) expect(Buffer.from(bytes).includes(text), `the note keeps no payload text: ${text}`).toBe(false);
      const markdown = exportDocMarkdown(restored);
      for (const text of kept) expect(markdown).toContain(text);
      for (const text of dropped) expect(markdown).not.toContain(text);
      expect(migratePayloads(restored, write)).toBe(false);
      expect(Y.encodeStateAsUpdate(restored)).toEqual(bytes);
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
    const unlink = link(a.doc, b.doc);
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
    } finally { unlink(); a.dispose(); b.dispose(); seed.destroy(); }
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
      const total = payloadsOf(live).reduce((sum, text) => sum + text.length, 0);
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
    for (const id of [ids[0], ids[count - 1]]) expect(id).toMatch(/^[0-9a-f]{32}$/);
    expect(elapsed, 'linear in blocks').toBeLessThan(3_000);
  }, 180_000);
});
