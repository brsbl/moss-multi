// Per-viewer table and tab layout (A§10.9): identities, not ordinals, after the first save; bounded storage; no
// layout work or storage writes for edits that touch no table or tab group.
import { createBinding, syncLexicalUpdateToYjs, syncYjsChangesToLexical, type Provider } from '@lexical/yjs';
import { $createTableNodeWithDimensions, $isTableNode, TableNode } from '@lexical/table';
import { $getRoot, $isElementNode, type ElementNode, type LexicalNode, type TextNode } from 'lexical';
import { afterEach, beforeEach, expect, it, vi, type Mock } from 'vitest';
import * as Y from 'yjs';
import { $importNoteBody, createConverterEditor } from '@moss-multi/sync/converter';
import { excludedPropertiesFor } from '@moss-multi/sync/excluded-properties';
import { bindLocalLayout } from './layout-local.ts';

const noop = () => {};
const provider = {
  awareness: { getLocalState: () => null, getStates: () => new Map(), on: noop, off: noop, setLocalState: noop, setLocalStateField: noop },
  connect: noop, disconnect: noop, on: noop, off: noop,
} as unknown as Provider;
const settle = () => new Promise(resolve => setTimeout(resolve, 0));
/** Longer than any write coalescing window. */
const quiet = () => new Promise(resolve => setTimeout(resolve, 600));
const identities = (viewer: string) => `moss-multi:layout-identities:${viewer}`;
const ordinals = (viewer: string) => `moss-multi:layout:${viewer}`;

let store: Map<string, string>;
let setItem: Mock<(key: string, value: string) => void>;
beforeEach(() => {
  store = new Map();
  setItem = vi.fn((key: string, value: string) => { store.set(key, value); });
  vi.stubGlobal('localStorage', { getItem: (key: string) => store.get(key) ?? null, setItem, removeItem: (key: string) => store.delete(key) });
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const writes = (key?: string) => setItem.mock.calls.filter(([written]) => key === undefined || written === key).length;

interface Tabs extends LexicalNode { getTabWidths(): (number | null)[]; setTabWidths(widths: number[]): void; getActiveIndex(): number }
const isTabs = (node: LexicalNode): node is Tabs => node.getType() === 'tab-group';
const $layoutNodes = () => {
  const result: LexicalNode[] = [];
  const visit = (node: LexicalNode) => { if ($isTableNode(node) || isTabs(node)) result.push(node); if ($isElementNode(node)) node.getChildren().forEach(visit); };
  visit($getRoot());
  return result;
};

/** A viewer mounting the note: layout is bound before the first sync arrives, as the collaboration plugin does. */
function peer(viewer: string | null, seed?: Y.Doc) {
  const doc = new Y.Doc(); const editor = createConverterEditor();
  const binding = createBinding(editor, provider, viewer ?? 'seed', doc, new Map([[viewer ?? 'seed', doc]]), excludedPropertiesFor(editor));
  const stopSync = editor.registerUpdateListener(({ prevEditorState, editorState, dirtyElements, dirtyLeaves, normalizedNodes, tags }) => {
    syncLexicalUpdateToYjs(binding, provider, prevEditorState, editorState, dirtyElements, dirtyLeaves, normalizedNodes, tags);
  });
  const root = binding.root.getSharedType();
  const observer: Parameters<typeof root.observeDeep>[0] = (events, transaction) => {
    if (transaction.origin !== binding) syncYjsChangesToLexical(binding, provider, events as never, false, noop);
  };
  root.observeDeep(observer);
  let stopLayout = viewer === null ? noop : bindLocalLayout(editor, binding);
  if (seed) Y.applyUpdate(doc, Y.encodeStateAsUpdate(seed));
  const edit = (fn: () => void) => editor.update(fn, { discrete: true });
  const read = <T>(fn: () => T) => editor.getEditorState().read(fn);
  const tables = () => read(() => $layoutNodes().filter($isTableNode).map(node => ({ text: node.getTextContent(), widths: node.getColWidths() ?? [] })));
  const groups = () => read(() => $layoutNodes().filter(isTabs).map(node => ({ widths: node.getTabWidths(), active: node.getActiveIndex() })));
  return {
    doc, editor, edit, read, tables, groups,
    teardown: () => stopLayout(),
    rebind: () => { stopLayout(); stopLayout = viewer === null ? noop : bindLocalLayout(editor, binding); },
    dispose: () => { stopLayout(); stopSync(); root.unobserveDeep(observer); doc.destroy(); },
  };
}
type Peer = ReturnType<typeof peer>;
const send = (from: Peer, to: Peer) => Y.applyUpdate(to.doc, Y.encodeStateAsUpdate(from.doc, Y.encodeStateVector(to.doc)));

function seeded(markdown: string) {
  const seeder = peer(null);
  seeder.edit(() => $importNoteBody(markdown));
  return seeder;
}
const fixture = 'Shared paragraph.\n\n| Original | Value |\n| --- | --- |\n| cell | 1 |\n\n:::tabs\n=== First\nFirst panel\n=== Second\nSecond panel\n:::\n';
const $paragraph = () => $getRoot().getChildren().find(node => node.getTextContent().startsWith('Shared paragraph')) as ElementNode;
const $type = (text: string) => () => { const node = $paragraph().getFirstChild() as TextNode; node.spliceText(node.getTextContentSize(), 0, text); };
const $setWidths = (table: number[], tab: number[]) => () => {
  for (const node of $layoutNodes()) {
    if ($isTableNode(node)) node.setColWidths(table);
    else if (isTabs(node)) node.setTabWidths(tab);
  }
};
const legacyStore = (table: number[], tab: number[]) => JSON.stringify({
  version: 1, tableCount: 1, tables: [{ columnWidths: table }], tabGroupCount: 1, tabGroups: [{ panelLabels: ['First', 'Second'], tabWidths: tab }],
});

it('a legacy-only store migrates its ordinal widths and then records identities', async () => {
  const seeder = seeded(fixture);
  store.set(ordinals('ada'), legacyStore([210, 170], [180, 200]));
  const ada = peer('ada', seeder.doc);
  await settle(); await settle();
  expect(ada.tables()[0].widths).toEqual([210, 170]);
  expect(ada.groups()[0].widths).toEqual([180, 200]);
  ada.teardown();
  expect(Object.keys(JSON.parse(store.get(identities('ada')) ?? '{}'))).toHaveLength(2);
});

it('an identity store with stale same-count ordinals transfers no width to a replacing table', async () => {
  const seeder = seeded(fixture);
  const ada = peer('ada', seeder.doc);
  await settle();
  ada.edit($setWidths([210, 170], [180, 200]));
  await settle(); ada.teardown();
  // The table is replaced (deleted, a new one inserted): the ordinal store still has one table with widths.
  seeder.edit(() => { const table = $layoutNodes().find($isTableNode)!; table.replace($createTableNodeWithDimensions(2, 2, false)); });
  store.set(ordinals('ada'), legacyStore([210, 170], [180, 200]));
  const reloaded = peer('ada', seeder.doc);
  await settle(); await settle();
  expect(reloaded.tables()[0].widths).toEqual([]);
  expect(reloaded.groups()[0].widths).toEqual([180, 200]);
});

it('table create and delete cycles keep saved identities bounded across reloads', async () => {
  const seeder = seeded(fixture);
  let ada = peer('ada', seeder.doc);
  await settle();
  for (let cycle = 0; cycle < 3; cycle++) {
    for (let i = 0; i < 10; i++) {
      ada.edit(() => { const table = $createTableNodeWithDimensions(2, 2, false); $getRoot().append(table); table.setColWidths([90, 110]); });
      ada.edit(() => { $layoutNodes().filter($isTableNode).at(-1)!.remove(); });
    }
    ada.teardown();
    const next = peer('ada', ada.doc); await settle(); await settle();
    ada.dispose(); ada = next;
  }
  ada.teardown();
  expect(Object.keys(JSON.parse(store.get(identities('ada')) ?? '{}')).length).toBeLessThanOrEqual(2);
});

it('typing and unrelated peer edits on a large note write nothing and collect nothing after hydration', async () => {
  const blocks = Array.from({ length: 30 }, (_, i) => `Paragraph ${i}.\n\n| H${i} | V |\n| --- | --- |\n| c | ${i} |\n\n:::tabs\n=== A${i}\nPanel\n=== B${i}\nPanel\n:::\n`).join('\n');
  const seeder = seeded(`${fixture}\n${blocks}`);
  const ada = peer('ada', seeder.doc); const ben = peer('ben', seeder.doc);
  await settle();
  ada.edit($setWidths([210, 170], [180, 200]));
  await quiet();
  setItem.mockClear();
  const colWidths = vi.spyOn(TableNode.prototype, 'getColWidths');
  const tabGroup = ada.read(() => $layoutNodes().find(isTabs)!);
  const tabWidths = vi.spyOn(Object.getPrototypeOf(tabGroup) as Tabs, 'getTabWidths');
  for (let i = 0; i < 20; i++) {
    ada.edit($type('a'));
    ben.edit($type('b'));
    send(ben, ada); send(ada, ben);
    await settle();
  }
  await quiet();
  expect(ada.read(() => $paragraph().getTextContent())).toBe(ben.read(() => $paragraph().getTextContent()));
  expect(writes(), 'no storage write while typing or receiving a peer').toBe(0);
  expect(colWidths.mock.calls.length + tabWidths.mock.calls.length, 'no layout collection').toBe(0);
});

it('a column resize is one coalesced write and survives teardown and rebinding', async () => {
  const seeder = seeded(fixture);
  const ada = peer('ada', seeder.doc);
  await settle(); await quiet();
  setItem.mockClear();
  for (const width of [150, 160, 170, 180, 190]) ada.edit($setWidths([width, 120], [180, 200]));
  await quiet();
  expect(writes(identities('ada'))).toBe(1);
  ada.edit($setWidths([200, 130], [180, 200]));
  ada.rebind(); // the pending write is flushed on teardown
  const reloaded = peer('ada', ada.doc);
  await settle(); await settle();
  expect(reloaded.tables()[0].widths).toEqual([200, 130]);
  expect(reloaded.groups()[0].widths).toEqual([180, 200]);
});
