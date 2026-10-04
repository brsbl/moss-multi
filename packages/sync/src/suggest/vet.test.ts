// SP11 census (T5.0, docs/design/suggestions.md §4): real user operations, made by a headless moss editor bound V1 to
// a Y.Doc, vetted as suggest-mode frames against the server's copy without applying them. The table below is the
// design's evidence for which operations a suggester's client may send as-is and which it must turn into proposals.
import { createBinding, syncLexicalUpdateToYjs, syncYjsChangesToLexical, type Provider } from '@lexical/yjs';
import { $insertTableRowAtNode, $isTableCellNode, type TableCellNode } from '@lexical/table';
import { $createListItemNode, $isListItemNode, type ListItemNode } from '@lexical/list';
import {
  $createRangeSelection, $getRoot, $isElementNode, $isTextNode, $setSelection, type LexicalNode, type TextNode,
} from 'lexical';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { createConverterEditor } from '../converter/index.ts';
import { excludedPropertiesFor } from '../excluded-properties.ts';
import { bindRegisters } from '../registers.ts';
import { importBody } from '../server-doc.ts';
import { vetSuggestFrame, type IdSpan } from './vet.ts';

const SEED = [
  'Hello world and the cat.',
  '',
  '- [ ] task one',
  '- [ ] task two',
  '',
  '- item a',
  '- item b',
  '',
  '| A | B |',
  '|---|---|',
  '| 1 | 2 |',
  '',
  '```js',
  'seed',
  '```',
].join('\n');

const noop = () => {};
const provider = {
  awareness: { getLocalState: () => null, getStates: () => new Map(), on: noop, off: noop, setLocalState: noop, setLocalStateField: noop },
  connect: noop, disconnect: noop, on: noop, off: noop,
} as unknown as Provider;

/** A suggester's client: moss's nodes bound V1 to its own Y.Doc, hydrated from the server's state. */
function client(server: Y.Doc) {
  const doc = new Y.Doc();
  const editor = createConverterEditor();
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
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(server));
  editor.update(noop, { discrete: true });
  const sent: Uint8Array[] = [];
  doc.on('update', (update: Uint8Array) => sent.push(update));
  /** Everything the client would put on the wire for `fn`, as one frame. */
  const frame = (fn: () => void): Uint8Array => {
    sent.length = 0;
    editor.update(fn, { discrete: true });
    return Y.mergeUpdates(sent);
  };
  return { doc, editor, frame, dispose: () => { stop(); stopRegisters(); root.unobserveDeep(observer); doc.destroy(); } };
}

function seeded(): Y.Doc {
  const server = new Y.Doc();
  importBody(server, SEED);
  return server;
}

const all = (node: LexicalNode = $getRoot()): LexicalNode[] =>
  [node, ...($isElementNode(node) ? node.getChildren().flatMap((child) => all(child)) : [])];
const texts = (): TextNode[] => all().filter((node): node is TextNode => $isTextNode(node));
const listItem = (text: string): ListItemNode =>
  all().find((node): node is ListItemNode => $isListItemNode(node) && node.getTextContent() === text)!;
const cell = (text: string): TableCellNode =>
  all().find((node): node is TableCellNode => $isTableCellNode(node) && node.getTextContent() === text)!;

/** A collapsed or ranged selection inside the nth text node (the first paragraph's by default). */
function select(anchor: number, focus = anchor, nth = 0) {
  const text = texts()[nth];
  const selection = $createRangeSelection();
  selection.anchor.set(text.getKey(), anchor, 'text');
  selection.focus.set(text.getKey(), focus, 'text');
  $setSelection(selection);
  return selection;
}

type Expect = 'allowed' | 'split' | 'delete-original' | 'mutate-original';
interface Case { name: string; op: () => void; verdict: Expect }

const cases: Case[] = [
  // Additive: lands as is and registers the author's insert parts.
  { name: 'typing inside an original word', op: () => select(6).insertText('big '), verdict: 'allowed' },
  { name: 'colliding prefix: "the " before "the cat"', op: () => select(16).insertText('the '), verdict: 'allowed' },
  { name: 'a sentence pasted before itself', op: () => select(0).insertText('Hello world and the cat. '), verdict: 'allowed' },
  { name: 'Enter at the end of a block', op: () => select(24).insertParagraph(), verdict: 'allowed' },
  { name: 'a new table row', op: () => { $insertTableRowAtNode(cell('1'), true); }, verdict: 'allowed' },
  // Splits: @lexical/yjs deletes the original tail and re-inserts a copy; the vetter proves the copy and keeps it original.
  { name: 'Enter mid-paragraph', op: () => select(5).insertParagraph(), verdict: 'split' },
  { name: 'a soft break mid-paragraph', op: () => select(5).insertLineBreak(), verdict: 'split' },
  {
    name: 'typing bold text mid-word',
    op: () => { const selection = select(8); selection.toggleFormat('bold'); selection.insertText('X'); },
    verdict: 'split',
  },
  // Everything else touches original content: the client must send these as proposals, never as tree edits.
  { name: 'deleting an original character', op: () => select(4, 5).removeText(), verdict: 'delete-original' },
  { name: 'deleting an original word', op: () => select(5, 11).removeText(), verdict: 'delete-original' },
  { name: 'bolding an original word', op: () => select(6, 11).formatText('bold'), verdict: 'delete-original' },
  { name: 'toggling an original checkbox', op: () => { listItem('task one').setChecked(true); }, verdict: 'mutate-original' },
  { name: 'indenting an original list item', op: () => { listItem('item b').setIndent(1); }, verdict: 'delete-original' },
  {
    name: 'editing an original code block register',
    op: () => { (all().find((node) => node.getType() === 'code-block') as unknown as { setCode(code: string): void }).setCode('seed!'); },
    verdict: 'mutate-original',
  },
];

describe('SP11 suggester vetting census @p:mean-2', () => {
  it('opening the doc writes nothing, so a suggester is never refused for loading it', () => {
    const server = seeded();
    const doc = new Y.Doc();
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(server));
    const before = Y.encodeStateVector(doc);
    const suggester = client(doc);
    try {
      expect(Y.encodeStateVector(suggester.doc)).toEqual(before);
    } finally { suggester.dispose(); doc.destroy(); server.destroy(); }
  });

  it.each(cases)('$name → $verdict', ({ op, verdict }) => {
    const server = seeded();
    const suggester = client(server);
    try {
      const update = suggester.frame(op);
      expect(update.byteLength, 'the operation must reach the wire').toBeGreaterThan(2);
      const result = vetSuggestFrame(server, update, []);
      if (verdict === 'allowed' || verdict === 'split') {
        if (!result.ok) throw new Error(`refused: ${result.reason}`);
        expect(result.inserts.length, 'an allowed insert registers a part').toBeGreaterThan(0);
        if (verdict === 'split') expect(result.moved.length, 'the moved tail stays original').toBeGreaterThan(0);
        else expect(result.moved).toEqual([]);
      } else {
        expect(result).toEqual({ ok: false, reason: verdict });
      }
    } finally { suggester.dispose(); server.destroy(); }
  });

  it("the author's own pending text can be retyped, deleted and formatted", () => {
    const server = seeded();
    const suggester = client(server);
    try {
      const own: IdSpan[] = [];
      const land = (update: Uint8Array) => {
        const result = vetSuggestFrame(server, update, own);
        if (!result.ok) throw new Error(`refused: ${result.reason}`);
        own.push(...result.inserts);
        Y.applyUpdate(server, update);
      };
      land(suggester.frame(() => select(24).insertText(' It sat.')));
      expect(own.length).toBeGreaterThan(0);
      land(suggester.frame(() => select(31, 32).removeText()));
      land(suggester.frame(() => select(25, 31).formatText('bold')));
      expect(vetSuggestFrame(server, suggester.frame(() => select(0, 5).removeText()), own))
        .toEqual({ ok: false, reason: 'delete-original' });
    } finally { suggester.dispose(); server.destroy(); }
  });

  it('text a split moved stays original: the author cannot delete it', () => {
    const server = seeded();
    const suggester = client(server);
    try {
      const split = suggester.frame(() => select(5).insertParagraph());
      const result = vetSuggestFrame(server, split, []);
      if (!result.ok) throw new Error(`refused: ${result.reason}`);
      Y.applyUpdate(server, split);
      const deleteMoved = suggester.frame(() => select(1, 6, 1).removeText());
      expect(vetSuggestFrame(server, deleteMoved, result.inserts, result.moved)).toEqual({ ok: false, reason: 'delete-original' });
    } finally { suggester.dispose(); server.destroy(); }
  });

  it('a new list item of its own can be checked; writes outside the body are refused', () => {
    const server = seeded();
    const suggester = client(server);
    try {
      const own: IdSpan[] = [];
      const added = suggester.frame(() => { listItem('task two').insertAfter($createListItemNode(false)); });
      const first = vetSuggestFrame(server, added, own);
      if (!first.ok) throw new Error(`refused: ${first.reason}`);
      own.push(...first.inserts);
      Y.applyUpdate(server, added);
      const check = suggester.frame(() => { (listItem('task two').getNextSibling() as ListItemNode).setChecked(true); });
      expect(vetSuggestFrame(server, check, own)).toMatchObject({ ok: true });

      const title = new Y.Doc();
      Y.applyUpdate(title, Y.encodeStateAsUpdate(server));
      const sv = Y.encodeStateVector(title);
      title.getText('title').insert(0, 'Renamed');
      expect(vetSuggestFrame(server, Y.encodeStateAsUpdate(title, sv), own)).toEqual({ ok: false, reason: 'outside-body' });
      const records = new Y.Doc();
      Y.applyUpdate(records, Y.encodeStateAsUpdate(server));
      const sv2 = Y.encodeStateVector(records);
      records.getMap('suggestions').set('forged', { status: 'accepted' });
      expect(vetSuggestFrame(server, Y.encodeStateAsUpdate(records, sv2), own)).toEqual({ ok: false, reason: 'outside-body' });
      title.destroy();
      records.destroy();
    } finally { suggester.dispose(); server.destroy(); }
  });

  it('a forged text map that re-formats original text without moving it is refused', () => {
    const server = seeded();
    const forger = new Y.Doc();
    try {
      Y.applyUpdate(forger, Y.encodeStateAsUpdate(server));
      const sv = Y.encodeStateVector(forger);
      const paragraph = (forger.get('root', Y.XmlText).toDelta() as { insert: unknown }[])[0].insert as Y.XmlText;
      const textMap = (paragraph.toDelta() as { insert: unknown }[])[0].insert as Y.Map<unknown>;
      paragraph.insertEmbed(7, new Y.Map(Object.entries({ ...textMap.toJSON(), __format: 1 })));
      expect(vetSuggestFrame(server, Y.encodeStateAsUpdate(forger, sv), [])).toEqual({ ok: false, reason: 'mutate-original' });
    } finally { forger.destroy(); server.destroy(); }
  });
});
