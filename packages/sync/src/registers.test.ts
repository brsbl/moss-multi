import { readFileSync } from 'node:fs';
import { $copyNode, $getRoot, $isElementNode, COLLABORATION_TAG, type LexicalNode } from 'lexical';
import { describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { exportDocMarkdown, importBody, seedEmptyParagraph, serverWrite } from './server-doc.ts';
import { $importNoteBody, exportMarkdown, importMarkdown } from './converter/index.ts';
import { EXCLUDED_FIELDS } from './excluded-properties.ts';
import { createBinding, syncLexicalUpdateToYjs, syncYjsChangesToLexical, type Provider } from '@lexical/yjs';
import { createConverterEditor } from './converter/index.ts';
import { excludedPropertiesFor } from './excluded-properties.ts';
import {
  $assignRegisterIds, bindRegisters, payloadTextOf, readMapEntries, rebaseMapEntries, REGISTER_LOCAL_ORIGIN, RegisterDraft,
} from './registers.ts';
import { BodyUndo, lexicalAction, payloadDocsFor, payloadMap, payloadText, seedPayload } from './payload-docs.ts';
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

  it('moves a pre-register attribute into a payload doc without replacing the node or changing export bytes', () => {
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
      const host = payloadDocsFor(restored);
      const write = (id: string, value: string | Map<string, unknown>) => seedPayload(host.hold(id), value, 'migration');
      expect(migratePayloads(restored, write)).toBe(true);
      expect(exportDocMarkdown(restored)).toContain('stored code');
      const node = restored.get('root', Y.XmlText).toDelta()[0].insert as Y.XmlElement;
      expect(node._item!.id).toEqual(identity);
      const bytes = Y.encodeStateAsUpdate(restored);
      expect(migratePayloads(restored, write)).toBe(false);
      expect(Y.encodeStateAsUpdate(restored)).toEqual(bytes);
      expect(node.getAttribute('__code'), 'the note keeps no payload text').toBeUndefined();
      expect(Buffer.from(bytes).includes('stored code')).toBe(false);
    } finally { legacy.destroy(); restored.destroy(); }
  });

  it('a pre-register note migrated by M1 (id set, legacy attribute kept) keeps no legacy text after this migration', () => {
    // M1's migrateRegisters set __regId and left the legacy attribute; the register later diverged from it.
    const m1 = new Y.Doc();
    const root = m1.get('root', Y.XmlText);
    const make = (index: number, attrs: Record<string, unknown>) => {
      const block = new Y.XmlElement('code-block');
      root.insertEmbed(index, block);
      for (const [key, value] of Object.entries({ __type: 'code-block', __language: 'plaintext', __commentIds: [], ...attrs })) block.setAttribute(key, value as never);
    };
    m1.transact(() => {
      make(0, { __regId: 'code:1', __code: 'STALE-legacy' });
      make(1, { __regId: 'code:2', __code: 'ATTR-only' });
      m1.getMap<Y.Text>('registers').set('code:1', new Y.Text('edited in the register'));
    });
    const restored = new Y.Doc();
    try {
      Y.applyUpdate(restored, Y.encodeStateAsUpdate(m1));
      const host = payloadDocsFor(restored);
      const write = (id: string, value: string | Map<string, unknown>) => seedPayload(host.hold(id), value, 'migration');
      expect(migratePayloads(restored, write)).toBe(true);
      const nodes = restored.get('root', Y.XmlText).toDelta().map((op: { insert: Y.XmlElement }) => op.insert);
      for (const node of nodes) expect(node.getAttribute('__code'), 'no legacy attribute survives').toBeUndefined();
      const bytes = Buffer.from(Y.encodeStateAsUpdate(restored));
      expect(bytes.includes('STALE-legacy') || bytes.includes('ATTR-only') || bytes.includes('edited in the register')).toBe(false);
      const markdown = exportDocMarkdown(restored);
      expect(markdown).toContain('edited in the register');
      expect(markdown, 'an id with no register keeps its attribute text as its payload').toContain('ATTR-only');
      expect(markdown).not.toContain('STALE-legacy');
      expect(migratePayloads(restored, write)).toBe(false);
    } finally { m1.destroy(); restored.destroy(); }
  });
});

// Chart and sketch payloads are per-key maps in their payload docs (A§10.10, SP8): concurrent edits to different keys
// both land, and a write derived from a stale value changes only what it changed.
type Fields = Record<string, unknown>;
type Peer = ReturnType<typeof client>;
const CHART = '```moss-chart\n{"type":"bar","title":"Seed","data":[{"label":"Mon","value":1}],"options":{"showLegend":true}}\n```';
const POINTS = '```moss-chart\n{"type":"bar","title":"Points","data":[{"label":"Mon","value":1},{"label":"Tue","value":2},{"label":"Wed","value":3}],"series":[{"name":"One","data":[{"label":"Mon","value":1},{"label":"Tue","value":2},{"label":"Wed","value":3}]},{"name":"Two","data":[{"label":"Mon","value":4}]}]}\n```';
const SKETCH = '```moss-canvas\n[moss:grid:v2]\n[moss:labels:[{"id":"seed","text":"Seed","col":1,"row":1}]]\n.##.\n```';
const call = (node: LexicalNode, method: string, ...args: unknown[]) =>
  (node as unknown as Record<string, (...values: unknown[]) => unknown>)[method](...args);
const chartOf = (peer: Peer) => peer.editor.read(() => call(find('chart')!, 'getConfig')) as Fields & { options?: Fields };
const gridOf = (peer: Peer) => peer.editor.read(() => call(find('sketch')!, 'getGrid')) as boolean[];
const labelsOf = (peer: Peer) => peer.editor.read(() => call(find('sketch')!, 'getLabels')) as { id: string; text: string }[];
const cells = (grid: boolean[]) => grid.flatMap((on, index) => (on ? [index] : []));
const exchange = (a: Peer, b: Peer) => {
  share(b.doc, a.doc);
  share(a.doc, b.doc);
  for (const peer of [a, b]) peer.editor.update(noop, { discrete: true });
};
/** One direction only, then the receiver commits. */
const send = (from: Peer, to: Peer) => {
  share(from.doc, to.doc);
  to.editor.update(noop, { discrete: true });
};
/** The note's one compound payload map, as `peer` holds it. */
const mapOf = (doc: Y.Doc) => [...payloadDocsFor(doc).docs.values()].map(payloadMap).find((map) => map.size)!;
type Point = { label: string; value: number };
const seriesOf = (peer: Peer) => ((chartOf(peer) as { series?: { name: string }[] }).series ?? []).map((entry) => entry.name);
const pointsOf = (peer: Peer) => (chartOf(peer) as { data: Point[] }).data.map((point) => [point.label, point.value]);
const withCells = (grid: boolean[], on: number[]) => grid.map((value, index) => value || on.includes(index));

describe('L4/A8 chart and sketch registers @p:col-1 @p:col-3 @p:note-2', () => {
  it('concurrent chart edits to different keys both survive, live, on the server and after persistence', () => {
    const seed = new Y.Doc(); importBody(seed, CHART);
    const a = client(seed); const b = client(seed);
    try {
      a.editor.update(() => call(find('chart')!, 'setConfig', { ...chartOf(a), title: 'Ada title' }), { discrete: true });
      b.editor.update(() => {
        const config = chartOf(b);
        call(find('chart')!, 'setConfig', { ...config, options: { ...config.options, palette: 'cool' } });
      }, { discrete: true });
      exchange(a, b);
      for (const peer of [a, b]) {
        expect(chartOf(peer).title, 'Ada keeps her title').toBe('Ada title');
        expect(chartOf(peer).options?.palette, 'Ben keeps his palette').toBe('cool');
        expect(chartOf(peer).options?.showLegend, 'untouched keys stay').toBe(true);
      }
      const markdown = exportDocMarkdown(a.doc);
      expect(markdown).toContain('"title": "Ada title"');
      expect(markdown).toContain('"palette": "cool"');
      expect(exportMarkdown(b.editor)).toBe(exportMarkdown(a.editor));
      const restored = client(a.doc);
      try { expect(chartOf(restored)).toEqual(chartOf(a)); } finally { restored.dispose(); }
      a.undo.undo();
      send(a, b);
      for (const peer of [a, b]) {
        expect(chartOf(peer).title, "Ada's undo reverts only her title").toBe('Seed');
        expect(chartOf(peer).options?.palette, "Ada's undo keeps Ben's palette").toBe('cool');
      }
    } finally { a.dispose(); b.dispose(); seed.destroy(); }
  });

  it('a chart write derived from a stale config changes only its own key', () => {
    const seed = new Y.Doc(); importBody(seed, CHART);
    const a = client(seed); const b = client(seed);
    try {
      const stale = chartOf(b);
      a.editor.update(() => call(find('chart')!, 'setConfig', { ...chartOf(a), type: 'line' }), { discrete: true });
      exchange(a, b);
      // Ben's chart header still holds the config it rendered before Ada's change arrived.
      b.editor.update(() => call(find('chart')!, 'setConfig', { ...stale, title: 'Ben title' }, stale), { discrete: true });
      exchange(a, b);
      for (const peer of [a, b]) expect(chartOf(peer)).toMatchObject({ type: 'line', title: 'Ben title' });
    } finally { a.dispose(); b.dispose(); seed.destroy(); }
  });

  it('concurrent edits to different chart data points and series both survive, and undo keeps the peer', () => {
    const seed = new Y.Doc(); importBody(seed, POINTS);
    const a = client(seed); const b = client(seed);
    try {
      const edit = (peer: Peer, mutate: (config: Fields & { data: { value: number }[]; series: { name: string }[] }) => void) =>
        peer.editor.update(() => {
          const base = chartOf(peer); const next = structuredClone(base) as Parameters<typeof mutate>[0];
          mutate(next);
          call(find('chart')!, 'setConfig', next, base);
        }, { discrete: true });
      edit(a, (config) => { config.data[0].value = 10; config.series[0].name = 'Ada series'; });
      edit(b, (config) => { config.data[1].value = 20; config.series[1].name = 'Ben series'; });
      exchange(a, b);
      for (const peer of [a, b]) {
        const config = chartOf(peer) as Fields & { data: { value: number }[]; series: { name: string }[] };
        expect(config.data.map((point) => point.value), 'both data points keep their edit').toEqual([10, 20, 3]);
        expect(config.series.map((series) => series.name), 'both series keep their edit').toEqual(['Ada series', 'Ben series']);
      }
      expect(exportDocMarkdown(a.doc)).toBe(exportMarkdown(a.editor));
      expect(exportMarkdown(b.editor)).toBe(exportMarkdown(a.editor));
      a.undo.undo();
      send(a, b);
      for (const peer of [a, b]) {
        expect((chartOf(peer) as { data: { value: number }[] }).data.map((point) => point.value), "Ada's undo keeps Ben's point").toEqual([1, 20, 3]);
      }
    } finally { a.dispose(); b.dispose(); seed.destroy(); }
  });

  it('a JSON draft opened before a peer saved keeps the peer\'s data point', () => {
    const seed = new Y.Doc(); importBody(seed, POINTS);
    const a = client(seed); const b = client(seed);
    try {
      const draft = chartOf(b) as Fields & { data: { value: number }[] };
      a.editor.update(() => {
        const base = chartOf(a) as Fields & { data: { value: number }[] };
        call(find('chart')!, 'setConfig', { ...base, data: base.data.map((point, index) => (index === 0 ? { ...point, value: 10 } : point)) }, base);
      }, { discrete: true });
      exchange(a, b);
      b.editor.update(() => call(find('chart')!, 'setConfig',
        { ...draft, data: draft.data.map((point, index) => (index === 1 ? { ...point, value: 20 } : point)) }, draft), { discrete: true });
      exchange(a, b);
      for (const peer of [a, b]) expect((chartOf(peer) as { data: { value: number }[] }).data.map((point) => point.value)).toEqual([10, 20, 3]);
    } finally { a.dispose(); b.dispose(); seed.destroy(); }
  });

  it('concurrent appends both land, and a deleted point never takes a peer\'s edit to another point', () => {
    const seed = new Y.Doc(); importBody(seed, POINTS);
    const a = client(seed); const b = client(seed);
    try {
      const write = (peer: Peer, next: (data: { label: string; value: number }[]) => { label: string; value: number }[]) =>
        peer.editor.update(() => {
          const base = chartOf(peer) as Fields & { data: { label: string; value: number }[] };
          call(find('chart')!, 'setConfig', { ...base, data: next(base.data) }, base);
        }, { discrete: true });
      write(a, (data) => [...data, { label: 'Ada', value: 7 }]);
      write(b, (data) => [...data, { label: 'Ben', value: 8 }]);
      exchange(a, b);
      const labels = (peer: Peer) => (chartOf(peer) as { data: { label: string }[] }).data.map((point) => point.label);
      expect(labels(a), 'both appended points stay').toEqual(expect.arrayContaining(['Mon', 'Tue', 'Wed', 'Ada', 'Ben']));
      expect(labels(a)).toHaveLength(5);
      expect(labels(b), 'both peers order them the same').toEqual(labels(a));
      write(a, (data) => data.slice(1));
      write(b, (data) => data.map((point) => (point.label === 'Tue' ? { ...point, value: 22 } : point)));
      exchange(a, b);
      for (const peer of [a, b]) {
        const data = (chartOf(peer) as { data: { label: string; value: number }[] }).data;
        expect(data.map((point) => point.label), "Ada's delete removes only Mon").toEqual(labels(a));
        expect(data.find((point) => point.label === 'Tue')?.value, "Ben's edit stays on Tue").toBe(22);
        expect(data.map((point) => point.label)).not.toContain('Mon');
      }
    } finally { a.dispose(); b.dispose(); seed.destroy(); }
  });

  it('one save that deletes a point and renames its neighbour keeps a peer\'s edit to that neighbour', () => {
    const seed = new Y.Doc(); importBody(seed, POINTS);
    const a = client(seed); const b = client(seed);
    try {
      const write = (peer: Peer, next: (data: Point[]) => Point[]) => peer.editor.update(() => {
        const base = chartOf(peer) as Fields & { data: Point[] };
        call(find('chart')!, 'setConfig', { ...base, data: next(structuredClone(base.data)) }, base);
      }, { discrete: true });
      write(a, (data) => data.slice(1).map((point) => (point.label === 'Tue' ? { ...point, label: 'Tuesday' } : point)));
      write(b, (data) => data.map((point) => (point.label === 'Tue' ? { ...point, value: 20 } : point)));
      exchange(a, b);
      for (const peer of [a, b]) {
        expect(pointsOf(peer), "Ada's rename and Ben's value both land on the point Ada kept").toEqual([['Tuesday', 20], ['Wed', 3]]);
      }
    } finally { a.dispose(); b.dispose(); seed.destroy(); }
  });

  it('a JSON draft keeps each point\'s identity through its text edits', () => {
    const seed = new Y.Doc(); importBody(seed, POINTS);
    const a = client(seed); const b = client(seed);
    try {
      const base = chartOf(a);
      const text = JSON.stringify(base, null, 2);
      const draft = new RegisterDraft(base, text);
      // Ada selects Mon's whole point and deletes it, types a new point in its place, then renames Tue.
      const mon = text.indexOf('{', text.indexOf('"data": ['));
      const tue = text.indexOf('{', mon + 1);
      let now = text.slice(0, mon) + text.slice(tue);
      draft.edit(now, mon);
      const typed = '{ "label": "Thu", "value": 1 },\n    ';
      for (let i = 1; i <= typed.length; i++) {
        now = now.slice(0, mon) + typed.slice(0, i) + now.slice(mon + i - 1);
        draft.edit(now, mon + i);
      }
      const label = now.indexOf('"Tue"') + 4;
      now = `${now.slice(0, label)}sday${now.slice(label)}`;
      draft.edit(now, label + 4);
      const next = JSON.parse(now) as Fields;
      draft.identify(next);
      // Meanwhile Ben sets Mon to 10 and Tue to 20.
      b.editor.update(() => {
        const config = chartOf(b) as Fields & { data: Point[] };
        call(find('chart')!, 'setConfig',
          { ...config, data: config.data.map((point) => ({ ...point, value: ({ Mon: 10, Tue: 20 } as Record<string, number>)[point.label] ?? point.value })) }, config);
      }, { discrete: true });
      a.editor.update(() => call(find('chart')!, 'setConfig', next, base), { discrete: true });
      exchange(a, b);
      for (const peer of [a, b]) {
        expect(pointsOf(peer), "Ada's typed point is new, and Ben's Tue edit stays on Tuesday").toEqual([['Thu', 1], ['Tuesday', 20], ['Wed', 3]]);
      }
    } finally { a.dispose(); b.dispose(); seed.destroy(); }
  });

  it('two people adding the same absent array both keep their records', () => {
    const seed = new Y.Doc(); importBody(seed, CHART);
    const a = client(seed); const b = client(seed);
    try {
      for (const [peer, name] of [[a, 'Ada'], [b, 'Ben']] as const) {
        peer.editor.update(() => {
          const base = chartOf(peer);
          call(find('chart')!, 'setConfig', { ...base, type: 'line', series: [{ name, data: [{ label: name, value: name.length }] }] }, base);
        }, { discrete: true });
      }
      exchange(a, b);
      for (const peer of [a, b]) {
        const series = (chartOf(peer) as { series: { name: string; data: Point[] }[] }).series;
        expect(series.map((entry) => [entry.name, entry.data.map((point) => point.label)]).sort(), 'both series, unmixed')
          .toEqual([['Ada', ['Ada']], ['Ben', ['Ben']]]);
      }
      expect(chartOf(b)).toEqual(chartOf(a));
    } finally { a.dispose(); b.dispose(); seed.destroy(); }
  });

  it('a point inserted between two concurrent appends lands between them', () => {
    for (let trial = 0; trial < 6; trial++) {
      const seed = new Y.Doc(); importBody(seed, POINTS);
      const a = client(seed); const b = client(seed);
      try {
        const write = (peer: Peer, next: (data: Point[]) => Point[]) => peer.editor.update(() => {
          const base = chartOf(peer) as Fields & { data: Point[] };
          call(find('chart')!, 'setConfig', { ...base, data: next(structuredClone(base.data)) }, base);
        }, { discrete: true });
        write(a, (data) => [...data, { label: 'Ada', value: 7 }]);
        write(b, (data) => [...data, { label: 'Ben', value: 8 }]);
        exchange(a, b);
        const [first, second] = pointsOf(a).slice(3).map(([name]) => name);
        write(a, (data) => [...data.slice(0, 4), { label: 'Mid', value: 5 }, ...data.slice(4)]);
        exchange(a, b);
        for (const peer of [a, b]) expect(pointsOf(peer).slice(3).map(([name]) => name)).toEqual([first, 'Mid', second]);
      } finally { a.dispose(); b.dispose(); seed.destroy(); }
    }
  });

  it('undoing your own new array keeps the elements a peer added to it later', () => {
    const seed = new Y.Doc(); importBody(seed, CHART);
    const a = client(seed); const b = client(seed);
    try {
      const write = (peer: Peer, next: (config: Fields & { series?: { name: string }[] }) => Fields) => peer.editor.update(() => {
        const base = chartOf(peer) as Fields & { series?: { name: string }[] };
        call(find('chart')!, 'setConfig', next(structuredClone(base)), base);
      }, { discrete: true });
      write(a, (config) => ({ ...config, type: 'line', series: [{ name: 'Ada' }] }));
      exchange(a, b);
      write(b, (config) => ({ ...config, series: [...config.series!, { name: 'Ben' }] }));
      exchange(a, b);
      for (const peer of [a, b]) expect(seriesOf(peer)).toEqual(['Ada', 'Ben']);
      a.undo.undo();
      exchange(a, b);
      for (const peer of [a, b]) {
        expect(seriesOf(peer), "Ada's undo removes only her series").toEqual(['Ben']);
        expect(chartOf(peer).type, "Ada's undo restores her type").toBe('bar');
      }
      const restored = client(a.doc);
      try { expect(chartOf(restored), 'after a reload').toEqual(chartOf(a)); } finally { restored.dispose(); }
      expect(exportDocMarkdown(a.doc)).toContain('"name": "Ben"');
      expect(exportDocMarkdown(a.doc)).toBe(exportMarkdown(a.editor));
      expect(exportMarkdown(b.editor)).toBe(exportMarkdown(a.editor));
      write(b, (config) => ({ ...config, series: [] }));
      exchange(a, b);
      for (const peer of [a, b]) expect(chartOf(peer).series, 'an emptied array stays an array').toEqual([]);
    } finally { a.dispose(); b.dispose(); seed.destroy(); }
  });

  it.each(['won', 'lost'] as const)('undoing one of two concurrent new arrays keeps the other (the write that %s the marker)', (outcome) => {
    const seed = new Y.Doc(); importBody(seed, CHART);
    const a = client(seed); const b = client(seed);
    try {
      for (const [peer, name] of [[a, 'Ada'], [b, 'Ben']] as const) {
        peer.editor.update(() => {
          const base = chartOf(peer);
          call(find('chart')!, 'setConfig', { ...base, series: [{ name }] }, base);
        }, { discrete: true });
      }
      exchange(a, b);
      for (const peer of [a, b]) expect(seriesOf(peer).sort()).toEqual(['Ada', 'Ben']);
      // Yjs keeps one of the two concurrent `#a/series` writes; undo the winner's write, or the loser's.
      const register = mapOf(a.doc);
      const adaWon = register._map.get('#a/series')!.id.client === register.doc!.clientID;
      const undoer = adaWon === (outcome === 'won') ? 'Ada' : 'Ben';
      (undoer === 'Ada' ? a : b).undo.undo();
      exchange(a, b);
      const other = undoer === 'Ada' ? 'Ben' : 'Ada';
      for (const peer of [a, b]) expect(seriesOf(peer), `${undoer}'s undo keeps ${other}'s series`).toEqual([other]);
      const restored = client(a.doc);
      try { expect(chartOf(restored), 'after a reload').toEqual(chartOf(a)); } finally { restored.dispose(); }
      expect(exportDocMarkdown(a.doc)).toContain(`"name": "${other}"`);
      expect(exportDocMarkdown(a.doc)).toBe(exportMarkdown(a.editor));
      expect(exportMarkdown(b.editor)).toBe(exportMarkdown(a.editor));
    } finally { a.dispose(); b.dispose(); seed.destroy(); }
  });

  it('a read-only editor writes nothing to a chart or sketch register', () => {
    const seed = new Y.Doc(); importBody(seed, `${CHART}\n\n${SKETCH}`);
    const a = client(seed);
    const vectors = () => [a.doc, ...payloadDocsFor(a.doc).docs.values()].map((doc) => Y.encodeStateVector(doc));
    try {
      const before = vectors();
      a.editor.setEditable(false);
      a.editor.update(() => {
        call(find('chart')!, 'setConfig', { ...chartOf(a), title: 'Viewer title' });
        call(find('sketch')!, 'setGrid', withCells(gridOf(a), [42]));
      }, { discrete: true });
      expect(vectors(), 'no Yjs update leaves a viewer').toEqual(before);
      expect(chartOf(a).title).toBe('Seed');
    } finally { a.dispose(); seed.destroy(); }
  });

  it('concurrent sketch strokes and labels union on both peers and the server, and undo keeps the peer', () => {
    const seed = new Y.Doc(); importBody(seed, SKETCH);
    const a = client(seed); const b = client(seed);
    try {
      const before = gridOf(a);
      const last = before.length - 1;
      a.editor.update(() => {
        call(find('sketch')!, 'setGrid', withCells(gridOf(a), [500, 501]));
        call(find('sketch')!, 'setLabels', [...labelsOf(a), { id: 'ada', text: 'Ada', col: 3, row: 3 }]);
      }, { discrete: true });
      b.editor.update(() => {
        call(find('sketch')!, 'setGrid', withCells(gridOf(b), [last]));
        call(find('sketch')!, 'setLabels', [...labelsOf(b), { id: 'ben', text: 'Ben', col: 5, row: 5 }]);
      }, { discrete: true });
      exchange(a, b);
      for (const peer of [a, b]) {
        expect(cells(gridOf(peer)), 'both strokes stay').toEqual([...cells(before), 500, 501, last].sort((x, y) => x - y));
        expect(labelsOf(peer).map((label) => label.id).sort(), 'both labels stay').toEqual(['ada', 'ben', 'seed']);
      }
      expect(exportMarkdown(b.editor)).toBe(exportMarkdown(a.editor));
      expect(exportDocMarkdown(a.doc)).toBe(exportMarkdown(a.editor));
      a.undo.undo();
      send(a, b);
      for (const peer of [a, b]) {
        expect(cells(gridOf(peer)), "Ada's undo removes only her stroke").toEqual([...cells(before), last]);
        expect(labelsOf(peer).map((label) => label.id).sort()).toEqual(['ben', 'seed']);
      }
    } finally { a.dispose(); b.dispose(); seed.destroy(); }
  });

  it('a stroke drawn from a stale grid keeps the strokes that arrived meanwhile', () => {
    const seed = new Y.Doc(); importBody(seed, SKETCH);
    const a = client(seed); const b = client(seed);
    try {
      const stale = gridOf(b);
      a.editor.update(() => call(find('sketch')!, 'setGrid', withCells(gridOf(a), [900])), { discrete: true });
      exchange(a, b);
      b.editor.update(() => call(find('sketch')!, 'setGrid', withCells(stale, [901]), stale), { discrete: true });
      exchange(a, b);
      for (const peer of [a, b]) expect(cells(gridOf(peer))).toEqual(expect.arrayContaining([900, 901]));
    } finally { a.dispose(); b.dispose(); seed.destroy(); }
  });

  // Both authors ink cell 301. Yjs keeps only one of two writes to one key, so neither undo may take the other's ink.
  it.each(['a', 'b'] as const)('overlapping concurrent strokes keep the other author\'s ink when %s undoes', (undoer) => {
    const seed = new Y.Doc(); importBody(seed, SKETCH);
    const a = client(seed); const b = client(seed);
    try {
      a.editor.update(() => call(find('sketch')!, 'setGrid', withCells(gridOf(a), [300, 301])), { discrete: true });
      b.editor.update(() => call(find('sketch')!, 'setGrid', withCells(gridOf(b), [301, 302])), { discrete: true });
      exchange(a, b);
      for (const peer of [a, b]) expect(cells(gridOf(peer))).toEqual(expect.arrayContaining([300, 301, 302]));
      (undoer === 'a' ? a : b).undo.undo();
      exchange(a, b);
      const [gone, kept] = undoer === 'a' ? [300, [301, 302]] : [302, [300, 301]];
      for (const peer of [a, b]) {
        expect(cells(gridOf(peer)), 'the shared cell and the other stroke stay').toEqual(expect.arrayContaining(kept));
        expect(cells(gridOf(peer))).not.toContain(gone);
      }
      const restored = client(a.doc);
      try { expect(cells(gridOf(restored))).toEqual(cells(gridOf(b))); } finally { restored.dispose(); }
    } finally { a.dispose(); b.dispose(); seed.destroy(); }
  });

  // The canvas's own Undo and Cancel write a local snapshot (an undo-stack entry, the edit baseline) that the view moves
  // by each peer change (sketch-sync.ts); a peer's ink on a cell the snapshot's author also inked must survive it.
  it('a canvas Undo or Cancel snapshot keeps a peer\'s ink on a cell both inked', () => {
    const seed = new Y.Doc(); importBody(seed, SKETCH);
    const a = client(seed); const b = client(seed);
    const entries = (peer: Peer) => peer.editor.read(() => readMapEntries(find('sketch')!))!;
    try {
      const preStroke = gridOf(a);
      a.editor.update(() => call(find('sketch')!, 'setGrid', withCells(preStroke, [300, 301]), preStroke), { discrete: true });
      const synced = entries(a);
      b.editor.update(() => call(find('sketch')!, 'setGrid', withCells(gridOf(b), [301, 302])), { discrete: true });
      exchange(a, b);
      const snapshot = rebaseMapEntries('sketch', { __grid: preStroke, __labels: [] }, synced, entries(a)).__grid as boolean[];
      expect(cells(snapshot), "the snapshot takes Ben's whole stroke").toEqual(expect.arrayContaining([301, 302]));
      const current = gridOf(a);
      a.editor.update(() => call(find('sketch')!, 'setGrid', snapshot, current), { discrete: true });
      exchange(a, b);
      for (const peer of [a, b]) {
        expect(cells(gridOf(peer)), "Ada's undo keeps Ben's whole stroke").toEqual(expect.arrayContaining([301, 302]));
        expect(cells(gridOf(peer))).not.toContain(300);
      }
      expect(exportDocMarkdown(a.doc)).toBe(exportMarkdown(b.editor));
    } finally { a.dispose(); b.dispose(); seed.destroy(); }
  });

  it.each([-1, 2.5, 7201, 2 ** 32, Number.NaN, '9'])('a sketch register with a hostile size (%s) decodes to the fixed grid, live and reloaded', (size) => {
    const seed = new Y.Doc(); importBody(seed, SKETCH);
    const a = client(seed);
    try {
      const expected = cells(gridOf(a));
      const register = [...payloadDocsFor(a.doc).docs.values()].map(payloadMap).find((map) => [...map.keys()].some((key) => key.startsWith('c')))!;
      register.doc!.transact(() => { register.set('#n', size); register.set('#l', 5); });
      a.editor.update(noop, { discrete: true });
      expect(gridOf(a)).toHaveLength(120 * 60);
      expect(cells(gridOf(a))).toEqual(expected);
      expect(exportDocMarkdown(a.doc)).toBe(exportMarkdown(a.editor));
      const restored = client(a.doc);
      try {
        expect(gridOf(restored)).toHaveLength(120 * 60);
        expect(cells(gridOf(restored))).toEqual(expected);
      } finally { restored.dispose(); }
    } finally { a.dispose(); seed.destroy(); }
  });

  it.each([
    { name: 'charts.md', type: 'chart', fields: ['__config'] },
    { name: 'canvas.md', type: 'sketch', fields: ['__grid', '__labels'] },
  ])('$type keeps export bytes and moves its payload into per-key payload maps', ({ name, type, fields }) => {
    const markdown = readFileSync(`${new URL('.', import.meta.url).pathname}converter/fixtures/${name}`, 'utf8');
    const doc = new Y.Doc();
    try {
      importBody(doc, markdown);
      expect(exportDocMarkdown(doc)).toBe(exportMarkdown(importMarkdown(markdown)));
      for (const field of fields) expect(EXCLUDED_FIELDS[type]).toContain(field);
      expect([...payloadDocsFor(doc).docs.values()].filter((payload) => payloadMap(payload).size).length).toBeGreaterThan(0);
      expect(Buffer.from(Y.encodeStateAsUpdate(doc)).includes('"label"'), "the note's own state carries no chart value").toBe(false);
    } finally { doc.destroy(); }
  });

  it('moves a persisted chart or sketch attribute, and an m3 register map, into payload maps without changing export', () => {
    const legacy = new Y.Doc();
    const root = legacy.get('root', Y.XmlText);
    const chart = new Y.XmlElement('chart'); root.insertEmbed(0, chart);
    chart.setAttribute('__type', 'chart'); chart.setAttribute('__config', { type: 'bar', title: 'Stored', data: [{ label: 'Mon', value: 1 }] } as never);
    chart.setAttribute('__commentIds', [] as never);
    // An m3 doc: the sketch's register is a Y.Map in `Y.Map('registers')`, named by its element.
    const sketch = new Y.XmlElement('sketch'); root.insertEmbed(1, sketch);
    legacy.transact(() => {
      sketch.setAttribute('__type', 'sketch'); sketch.setAttribute('__regId', 'import:sketch:1'); sketch.setAttribute('__commentIds', [] as never);
      legacy.getMap('registers').set('import:sketch:1', new Y.Map<unknown>([['c7.ab', true], ['#l', ['m3']], ['lm3', { id: 'm3', text: 'From m3', col: 2, row: 2 }]]));
    });
    const restored = new Y.Doc();
    try {
      Y.applyUpdate(restored, Y.encodeStateAsUpdate(legacy));
      const host = payloadDocsFor(restored);
      expect(migratePayloads(restored, (id, value) => seedPayload(host.hold(id), value, 'migration'))).toBe(true);
      const markdown = exportDocMarkdown(restored);
      expect(markdown).toContain('"title": "Stored"');
      expect(markdown).toContain('From m3');
      expect([...host.docs.values()].filter((payload) => payloadMap(payload).size)).toHaveLength(2);
      const migrated = restored.get('root', Y.XmlText).toDelta()[0].insert as Y.XmlElement;
      expect(migrated.getAttribute('__config'), 'the note keeps no chart value').toBeUndefined();
      expect(restored.getMap('registers').size).toBe(0);
      const bytes = Buffer.from(Y.encodeStateAsUpdate(restored));
      expect(bytes.includes('Stored') || bytes.includes('From m3')).toBe(false);
      expect(migratePayloads(restored, () => undefined)).toBe(false);
    } finally { legacy.destroy(); restored.destroy(); }
  });

  it.each([
    { type: 'chart', markdown: CHART, getter: 'getConfig', setter: 'setConfig', value: { type: 'line', data: [] } },
    { type: 'sketch', markdown: SKETCH, getter: 'getLabels', setter: 'setLabels', value: [{ id: 'copy', text: 'Copy only', col: 4, row: 4 }] },
  ])('copying a $type node through copyNode mints its own payload, seeded with the source value', async ({ type, markdown, getter, setter, value }) => {
    const seed = new Y.Doc(); importBody(seed, markdown);
    const a = client(seed);
    try {
      a.editor.update(() => { const original = find(type)!; original.insertAfter($copyNode(original)); }, { discrete: true });
      expect(a.editor.read(() => findAll(type).map((node) => JSON.stringify(call(node, getter)))).every((json, _, all) => json === all[0]), 'the copy shows the source').toBe(true);
      // A client writes its new blocks' first values just after the commit.
      await new Promise(resolve => setTimeout(resolve, 0));
      a.editor.update(() => call(findAll(type)[1], setter, value), { discrete: true });
      a.editor.update(noop, { discrete: true });
      const [original, copy] = a.editor.read(() =>
        findAll(type).map((node) => ({ id: (node as unknown as { __regId?: string }).__regId, value: call(node, getter) })));
      expect(copy.id, 'the copy mints a new identity').toBeTruthy();
      expect(copy.id, 'the copy mints a new identity').not.toBe(original.id);
      expect(copy.value).toEqual(value);
      expect(original.value, 'editing the copy leaves the original').not.toEqual(value);
    } finally { a.dispose(); seed.destroy(); }
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
