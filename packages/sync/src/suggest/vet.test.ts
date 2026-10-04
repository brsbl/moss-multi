// SP11 census (T5.0, docs/design/suggestions.md §4): real user operations, made by a headless moss editor bound V1 to
// a Y.Doc, vetted as suggest-mode frames against the server's copy without applying them. The table below is the
// design's evidence for which operations a suggester's client may send as-is and which it must turn into proposals.
import { createBinding, syncLexicalUpdateToYjs, syncYjsChangesToLexical, type Provider } from '@lexical/yjs';
import { $insertTableRowAtNode, $isTableCellNode, type TableCellNode } from '@lexical/table';
import { $createListItemNode, $isListItemNode, type ListItemNode } from '@lexical/list';
import {
  $copyNode, $createParagraphNode, type ParagraphNode, $createRangeSelection, $getRoot, $getSelection, $isElementNode, $isRangeSelection, $isTextNode, $setSelection,
  type LexicalNode, type TextNode,
} from 'lexical';
import * as encoding from 'lib0/encoding';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { createConverterEditor } from '../converter/index.ts';
import { excludedPropertiesFor } from '../excluded-properties.ts';
import { bindRegisters } from '../registers.ts';
import { importBody } from '../server-doc.ts';
import {
  carryIdentity, ownSpans, SEEN_GRACE_SECONDS, vetSuggestFrame, vetTransaction, type IdSpan, type OwnedRecord, type Verdict,
} from './vet.ts';

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
  /** Applies a peer's update the way the provider does, and commits it to Lexical before the next local edit. */
  const receive = (update: Uint8Array) => { Y.applyUpdate(doc, update); editor.update(noop, { discrete: true }); };
  const sent: Uint8Array[] = [];
  doc.on('update', (update: Uint8Array) => sent.push(update));
  /** Everything the client would put on the wire for `fn`, as one frame. */
  const frame = (fn: () => void): Uint8Array => {
    sent.length = 0;
    editor.update(fn, { discrete: true });
    return Y.mergeUpdates(sent);
  };
  // The binding's UndoManager (seam (a)): every local editor change is its own step here.
  const history = new Y.UndoManager(root, { trackedOrigins: new Set([binding]), captureTimeout: 0 });
  /** Cmd+Z: the frame that the UndoManager's transaction and Lexical's reconcile of it put on the wire. */
  const undo = (): Uint8Array => {
    sent.length = 0;
    history.undo();
    editor.update(noop, { discrete: true });
    return Y.mergeUpdates(sent);
  };
  return {
    doc, editor, frame, receive, undo,
    dispose: () => { history.destroy(); stop(); stopRegisters(); root.unobserveDeep(observer); doc.destroy(); },
  };
}

function seeded(): Y.Doc {
  const server = new Y.Doc();
  importBody(server, SEED);
  return server;
}

/** The author's view the DocDO keeps per connection: own inserts, moved text, and the Yjs client ids it claimed. */
function session(server: Y.Doc, doc: Y.Doc) {
  const own: IdSpan[] = [];
  const moved: IdSpan[] = [];
  const clients = new Set([doc.clientID]);
  const vet = (update: Uint8Array): Verdict => vetSuggestFrame(server, update, { own, moved, clients });
  const land = (update: Uint8Array) => {
    const result = vet(update);
    if (!result.ok) throw new Error(`refused: ${result.reason} ${summarize(update)}`);
    own.push(...result.inserts);
    moved.push(...result.moved);
    Y.applyUpdate(server, update);
    return result;
  };
  return { own, moved, clients, vet, land };
}

/** A frame's structs, for a refusal message. */
const summarize = (update: Uint8Array) => JSON.stringify(Y.decodeUpdate(update).structs.map((struct) => struct instanceof Y.Item
  ? [struct.id.clock, struct.length, struct.parentSub, struct.content.constructor.name, JSON.stringify(struct.content.getContent().map((v) => (v instanceof Y.AbstractType ? v.constructor.name : v))).slice(0, 40),
    struct.origin && `o${struct.origin.client === struct.id.client ? '' : struct.origin.client}:${struct.origin.clock}`,
    struct.rightOrigin && `r${struct.rightOrigin.client === struct.id.client ? '' : struct.rightOrigin.client}:${struct.rightOrigin.clock}`,
    typeof (struct.parent as unknown) === 'string' ? `p${String(struct.parent)}` : struct.parent instanceof Y.ID ? `p${struct.parent.client}:${struct.parent.clock}` : null]
  : [struct.id.client, struct.id.clock, struct.length]));

const all = (node: LexicalNode = $getRoot()): LexicalNode[] =>
  [node, ...($isElementNode(node) ? node.getChildren().flatMap((child) => all(child)) : [])];
const texts = (): TextNode[] => all().filter((node): node is TextNode => $isTextNode(node));
const listItem = (text: string): ListItemNode =>
  all().find((node): node is ListItemNode => $isListItemNode(node) && node.getTextContent() === text)!;
const codeBlocks = () => all().filter((node) => node.getType() === 'code-block') as unknown as (LexicalNode & { setCode(code: string): void })[];
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
  { name: 'a new paragraph right after an original code block', op: () => { codeBlocks()[0].insertAfter($createParagraphNode()); }, verdict: 'allowed' },
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
      const result = vetSuggestFrame(server, update, { own: [], clients: new Set([suggester.doc.clientID]) });
      if (verdict === 'allowed' || verdict === 'split') {
        if (!result.ok) throw new Error(`refused: ${result.reason} ${summarize(update)}`);
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
      const s = session(server, suggester.doc);
      s.land(suggester.frame(() => select(24).insertText(' It sat.')));
      expect(s.own.length).toBeGreaterThan(0);
      s.land(suggester.frame(() => select(31, 32).removeText()));
      s.land(suggester.frame(() => select(25, 31).formatText('bold')));
      expect(s.vet(suggester.frame(() => select(0, 5).removeText()))).toEqual({ ok: false, reason: 'delete-original' });
    } finally { suggester.dispose(); server.destroy(); }
  });

  it('text a split moved stays original: the author cannot delete it', () => {
    const server = seeded();
    const suggester = client(server);
    try {
      const s = session(server, suggester.doc);
      s.land(suggester.frame(() => select(5).insertParagraph()));
      expect(s.moved.length).toBeGreaterThan(0);
      expect(s.vet(suggester.frame(() => select(1, 6, 1).removeText()))).toEqual({ ok: false, reason: 'delete-original' });
    } finally { suggester.dispose(); server.destroy(); }
  });

  it('owning the block a split made does not let the author reformat the moved text in it', () => {
    const server = seeded();
    const suggester = client(server);
    try {
      const s = session(server, suggester.doc);
      s.land(suggester.frame(() => select(5).insertParagraph()));
      const bold = suggester.frame(() => { select(0, texts()[1].getTextContentSize(), 1).formatText('bold'); });
      expect(bold.byteLength, 'the operation must reach the wire').toBeGreaterThan(2);
      expect(s.vet(bold)).toEqual({ ok: false, reason: 'mutate-original' });
    } finally { suggester.dispose(); server.destroy(); }
  });

  it("owning a block does not own a peer's text typed inside it", () => {
    const server = seeded();
    const suggester = client(server);
    let peer: ReturnType<typeof client> | null = null;
    const nodeWith = (text: string) => texts().findIndex((node) => node.getTextContent() === text);
    try {
      const s = session(server, suggester.doc);
      s.land(suggester.frame(() => {
        select(24).insertParagraph();
        const selection = $getSelection();
        if ($isRangeSelection(selection)) selection.insertText('mine');
      }));
      peer = client(server);
      const typed = peer.frame(() => { select(4, 4, nodeWith('mine')).insertText(' theirs'); });
      Y.applyUpdate(server, typed);
      suggester.receive(typed);
      expect(s.vet(suggester.frame(() => { select(4, 11, nodeWith('mine theirs')).removeText(); })))
        .toEqual({ ok: false, reason: 'delete-original' });
      // Their own word in the same block stays theirs to delete (the refused frame stayed local to this client).
      expect(s.vet(suggester.frame(() => { select(0, 4, nodeWith('mine')).removeText(); }))).toMatchObject({ ok: true });
    } finally { peer?.dispose(); suggester.dispose(); server.destroy(); }
  });

  it("a new decorator's register stays the author's in later frames", () => {
    const server = seeded();
    const suggester = client(server);
    try {
      const s = session(server, suggester.doc);
      s.land(suggester.frame(() => {
        const original = codeBlocks()[0];
        const copy = $copyNode(original) as unknown as LexicalNode & { __regId: string };
        copy.__regId = '';
        original.insertAfter(copy);
      }));
      const edit = suggester.frame(() => { codeBlocks()[1].setCode('mine'); });
      expect(edit.byteLength, 'the register edit must reach the wire').toBeGreaterThan(2);
      s.land(edit);
      expect(s.vet(suggester.frame(() => { codeBlocks()[0].setCode('theirs'); }))).toEqual({ ok: false, reason: 'mutate-original' });
    } finally { suggester.dispose(); server.destroy(); }
  });

  it('a new list item of its own can be checked; writes outside the body are refused', () => {
    const server = seeded();
    const suggester = client(server);
    try {
      const s = session(server, suggester.doc);
      s.land(suggester.frame(() => { listItem('task two').insertAfter($createListItemNode(false)); }));
      expect(s.vet(suggester.frame(() => { (listItem('task two').getNextSibling() as ListItemNode).setChecked(true); })))
        .toMatchObject({ ok: true });

      const outside = (write: (doc: Y.Doc) => void) => {
        const forger = new Y.Doc();
        Y.applyUpdate(forger, Y.encodeStateAsUpdate(server));
        const sv = Y.encodeStateVector(forger);
        write(forger);
        const update = Y.encodeStateAsUpdate(forger, sv);
        forger.destroy();
        return vetSuggestFrame(server, update, { own: s.own, clients: new Set() });
      };
      expect(outside((doc) => doc.getText('title').insert(0, 'Renamed'))).toEqual({ ok: false, reason: 'outside-body' });
      expect(outside((doc) => doc.getMap('suggestions').set('forged', { status: 'accepted' }))).toEqual({ ok: false, reason: 'outside-body' });
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
      expect(vetSuggestFrame(server, Y.encodeStateAsUpdate(forger, sv), { own: [], clients: new Set() }))
        .toEqual({ ok: false, reason: 'mutate-original' });
    } finally { forger.destroy(); server.destroy(); }
  });
});

/** The first original text item of the first paragraph ("Hello world and the cat."). */
function helloItem(doc: Y.Doc): Y.Item {
  const paragraph = doc.get('root', Y.XmlText)._start!.content as Y.ContentType;
  for (let item = paragraph.type._start; item; item = item.right) if (item.content instanceof Y.ContentString) return item;
  throw new Error('no text');
}

/** A raw V1 update: one GC struct per entry, then a delete set of one range per entry. */
function rawUpdate(gcs: IdSpan[], deletes: IdSpan[]): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, gcs.length);
  for (const gc of gcs) {
    encoding.writeVarUint(encoder, 1);
    encoding.writeVarUint(encoder, gc.client);
    encoding.writeVarUint(encoder, gc.clock);
    encoding.writeUint8(encoder, 0);
    encoding.writeVarUint(encoder, gc.len);
  }
  encoding.writeVarUint(encoder, deletes.length);
  for (const range of deletes) {
    encoding.writeVarUint(encoder, range.client);
    encoding.writeVarUint(encoder, 1);
    encoding.writeVarUint(encoder, range.clock);
    encoding.writeVarUint(encoder, range.len);
  }
  return encoding.toUint8Array(encoder);
}

describe('SP11 forged and out-of-order frames @p:mean-2', () => {
  it('a GC overlapping known clocks cannot hide a delete of original text', () => {
    const server = seeded();
    const copy = new Y.Doc();
    try {
      const hello = helloItem(server);
      const S = hello.id.client;
      const forged = rawUpdate([{ client: S, clock: 0, len: Y.getState(server.store, S) + 1 }], [{ client: S, clock: hello.id.clock, len: 5 }]);
      Y.applyUpdate(copy, Y.encodeStateAsUpdate(server));
      Y.applyUpdate(copy, forged);
      expect((Y.getItem(copy.store, hello.id) as Y.Item).deleted, 'Yjs applies the hidden delete').toBe(true);
      expect(vetSuggestFrame(server, forged, { own: [], clients: new Set([S]) })).toEqual({ ok: false, reason: 'delete-original' });
      expect(vetSuggestFrame(server, forged, { own: [], clients: new Set() })).toEqual({ ok: false, reason: 'foreign-client' });
    } finally { copy.destroy(); server.destroy(); }
  });

  it("a forged overwrite of an original decorator's register is refused", () => {
    const server = seeded();
    const forger = new Y.Doc();
    try {
      Y.applyUpdate(forger, Y.encodeStateAsUpdate(server));
      const sv = Y.encodeStateVector(forger);
      const registers = forger.getMap<Y.Text>('registers');
      const [key] = [...registers.keys()];
      registers.set(key, new Y.Text('forged'));
      expect(vetSuggestFrame(server, Y.encodeStateAsUpdate(forger, sv), { own: [], clients: new Set() }))
        .toEqual({ ok: false, reason: 'mutate-original' });
    } finally { forger.destroy(); server.destroy(); }
  });

  it('a frame with a clock gap is refused, never parked', () => {
    const server = seeded();
    const forger = new Y.Doc();
    try {
      expect(vetSuggestFrame(server, rawUpdate([{ client: 424242, clock: 5, len: 1 }], []), { own: [], clients: new Set() }))
        .toEqual({ ok: false, reason: 'unresolvable' });
      Y.applyUpdate(forger, Y.encodeStateAsUpdate(server));
      forger.getMap('scratch').set('first', 1);
      const sv = Y.encodeStateVector(forger);
      const paragraph = (forger.get('root', Y.XmlText).toDelta() as { insert: unknown }[])[0].insert as Y.XmlText;
      paragraph.insert(3, 'x');
      expect(vetSuggestFrame(server, Y.encodeStateAsUpdate(forger, sv), { own: [], clients: new Set() }))
        .toEqual({ ok: false, reason: 'unresolvable' });
    } finally { forger.destroy(); server.destroy(); }
  });

  it("a frame writing under another writer's Yjs client id is refused", () => {
    const server = seeded();
    const forger = new Y.Doc();
    try {
      Y.applyUpdate(forger, Y.encodeStateAsUpdate(server));
      forger.clientID = helloItem(server).id.client;
      const sv = Y.encodeStateVector(forger);
      const paragraph = (forger.get('root', Y.XmlText).toDelta() as { insert: unknown }[])[0].insert as Y.XmlText;
      paragraph.insert(3, 'x');
      expect(vetSuggestFrame(server, Y.encodeStateAsUpdate(forger, sv), { own: [], clients: new Set() }))
        .toEqual({ ok: false, reason: 'foreign-client' });
    } finally { forger.destroy(); server.destroy(); }
  });
});

describe('SP11 the client self-check @p:mean-2', () => {
  /** The verdicts of the vetter run in afterTransaction on each local transaction an operation makes. */
  function selfCheck(op: () => void): Verdict[] {
    const server = seeded();
    const suggester = client(server);
    const verdicts: Verdict[] = [];
    const options = { own: [], clients: new Set([suggester.doc.clientID]) };
    const onTransaction = (transaction: Y.Transaction) => {
      if (transaction.local) verdicts.push(vetTransaction(transaction, options));
    };
    suggester.doc.on('afterTransaction', onTransaction);
    try {
      suggester.frame(op);
      return verdicts;
    } finally { suggester.doc.off('afterTransaction', onTransaction); suggester.dispose(); server.destroy(); }
  }

  it('refuses a delete of original text, judged from the state before the transaction', () => {
    expect(selfCheck(() => select(4, 5).removeText())).toContainEqual({ ok: false, reason: 'delete-original' });
  });

  it('passes a split and keeps its moved text original', () => {
    const verdicts = selfCheck(() => select(5).insertParagraph());
    expect(verdicts.length).toBeGreaterThan(0);
    expect(verdicts.every((verdict) => verdict.ok)).toBe(true);
    expect(verdicts.some((verdict) => verdict.ok && verdict.moved.length > 0)).toBe(true);
  });

  it('covers register-origin transactions', () => {
    expect(selfCheck(() => { codeBlocks()[0].setCode('seed!'); })).toContainEqual({ ok: false, reason: 'mutate-original' });
  });
});

/** The live characters of `spans`, in document order. */
function visible(doc: Y.Doc, spans: readonly IdSpan[]): string {
  let out = '';
  const walk = (type: Y.AbstractType<unknown>) => {
    for (let item = type._start; item; item = item.right) {
      if (item.deleted) continue;
      const { content, id } = item;
      if (content instanceof Y.ContentString) {
        for (let i = 0; i < content.str.length; i++) {
          const clock = id.clock + i;
          if (spans.some((s) => s.client === id.client && s.clock <= clock && clock < s.clock + s.len)) out += content.str[i];
        }
      } else if (content instanceof Y.ContentType) walk(content.type);
    }
  };
  walk(doc.get('root', Y.XmlText) as unknown as Y.AbstractType<unknown>);
  return out;
}

describe('SP11 identity across other writers @p:mean-2', () => {
  it("an editor's Enter and bold inside pending suggested text keep it the suggestion's", () => {
    const server = seeded();
    const author = client(server);
    let editor: ReturnType<typeof client> | null = null;
    try {
      const s = session(server, author.doc);
      s.land(author.frame(() => select(24).insertText(' It sat.')));
      expect(visible(server, s.own)).toBe(' It sat.');
      editor = client(server);
      const enter = editor.frame(() => select(27).insertParagraph());
      const afterEnter = carryIdentity(server, enter, s.own);
      Y.applyUpdate(server, enter);
      expect(visible(server, afterEnter)).toBe(' It sat.');
      const bold = editor.frame(() => select(1, 4, 1).formatText('bold'));
      const afterBold = carryIdentity(server, bold, afterEnter);
      Y.applyUpdate(server, bold);
      expect(visible(server, afterBold)).toBe(' It sat.');
    } finally { editor?.dispose(); author.dispose(); server.destroy(); }
  });

  it('a delete racing an accept the author has not seen yet lands, with the typing after it', () => {
    const server = seeded();
    const author = client(server);
    try {
      const s = session(server, author.doc);
      const typed = s.land(author.frame(() => select(24).insertText(' It sat.')));
      if (!typed.ok) throw new Error('refused');
      const accepted: OwnedRecord = { author: 'a', status: 'accepted', resolvedRev: 4, resolvedAt: 1000, inserts: typed.inserts, moved: [] };
      const race = author.frame(() => {
        select(28, 32).removeText();
        const selection = $getSelection();
        if ($isRangeSelection(selection)) selection.insertText('stood.');
      });
      const vet = (seenRev: number, now: number) => vetSuggestFrame(server, race, { ...ownSpans([accepted], 'a', { seenRev, now }), clients: s.clients });
      expect(vet(3, 1005)).toMatchObject({ ok: true });
      expect(vet(4, 1005)).toEqual({ ok: false, reason: 'delete-original' });
      expect(vet(3, 1000 + SEEN_GRACE_SECONDS + 1)).toEqual({ ok: false, reason: 'delete-original' });
    } finally { author.dispose(); server.destroy(); }
  });
});

/** A V1 update holding one forged item of `content`, placed only by its origin, with an empty delete set. */
function placedByOrigin(client: number, origin: Y.ID, content: Y.ContentDeleted): Uint8Array {
  const encoder = new Y.UpdateEncoderV1();
  encoding.writeVarUint(encoder.restEncoder, 1);
  encoding.writeVarUint(encoder.restEncoder, 1);
  encoder.writeClient(client);
  encoding.writeVarUint(encoder.restEncoder, 0);
  new Y.Item(Y.createID(client, 0), null, origin, null, null, null, null, content).write(encoder, 0);
  encoding.writeVarUint(encoder.restEncoder, 0);
  return encoder.toUint8Array();
}

/** The live text of the nth live top-level block. */
function blockText(doc: Y.Doc, nth: number): string {
  let block = doc.get('root', Y.XmlText)._start;
  for (let i = 0; block; block = block.right) if (!block.deleted && i++ === nth) break;
  let out = '';
  const walk = (type: Y.AbstractType<unknown>) => {
    for (let item = type._start; item; item = item.right) {
      if (item.deleted) continue;
      if (item.content instanceof Y.ContentString) out += item.content.str;
      else if (item.content instanceof Y.ContentType) walk(item.content.type);
    }
  };
  if (block?.content instanceof Y.ContentType) walk(block.content.type);
  return out;
}

/** The live top-level blocks a Yjs client created, in order. */
function blocksOf(doc: Y.Doc, client: number): Y.Item[] {
  const out: Y.Item[] = [];
  for (let item = doc.get('root', Y.XmlText)._start; item; item = item.right) {
    if (!item.deleted && item.id.client === client && item.content instanceof Y.ContentType) out.push(item);
  }
  return out;
}

/** The suggester's own new paragraph "mine" after the first block, landed. */
function withOwnParagraph() {
  const server = seeded();
  const suggester = client(server);
  const s = session(server, suggester.doc);
  s.land(suggester.frame(() => {
    select(24).insertParagraph();
    const selection = $getSelection();
    if ($isRangeSelection(selection)) selection.insertText('mine');
  }));
  return { server, suggester, s };
}

/** withOwnParagraph, plus a peer's " theirs" typed into the same text node. */
function peerInsideOwn() {
  const { server, suggester, s } = withOwnParagraph();
  const peer = client(server);
  const typed = peer.frame(() => { select(4, 4, texts().findIndex((node) => node.getTextContent() === 'mine')).insertText(' theirs'); });
  Y.applyUpdate(server, typed);
  suggester.receive(typed);
  const nth = () => texts().findIndex((node) => node.getTextContent() === 'mine theirs');
  return { server, suggester, s, nth, dispose: () => { peer.dispose(); suggester.dispose(); server.destroy(); } };
}

describe('SP11 implicit deletes and governed text @p:mean-2', () => {
  it('a forged tombstone placed after an original map value cannot delete it', () => {
    const server = seeded();
    const check = (origin: Y.ID, gone: (doc: Y.Doc) => boolean) => {
      const forged = placedByOrigin(424243, origin, new Y.ContentDeleted(1));
      const copy = new Y.Doc();
      Y.applyUpdate(copy, Y.encodeStateAsUpdate(server));
      Y.applyUpdate(copy, forged);
      expect(gone(copy), 'Yjs deletes the original value').toBe(true);
      copy.destroy();
      expect(vetSuggestFrame(server, forged, { own: [], clients: new Set() })).toEqual({ ok: false, reason: 'mutate-original' });
    };
    try {
      const registers = server.getMap('registers');
      const [key] = [...registers.keys()];
      check(registers._map.get(key)!.lastId, (doc) => !doc.getMap('registers').has(key));
      const paragraph = (server.get('root', Y.XmlText)._start!.content as Y.ContentType).type;
      check(paragraph._map.get('__type')!.lastId, (doc) => {
        const block = (doc.get('root', Y.XmlText)._start!.content as Y.ContentType).type as Y.XmlText;
        return block.getAttribute('__type') === undefined;
      });
    } finally { server.destroy(); }
  });

  it('a forged formatting mark in the body is refused', () => {
    const server = seeded();
    const forger = new Y.Doc();
    try {
      Y.applyUpdate(forger, Y.encodeStateAsUpdate(server));
      const sv = Y.encodeStateVector(forger);
      const paragraph = (forger.get('root', Y.XmlText).toDelta() as { insert: unknown }[])[0].insert as Y.XmlText;
      paragraph.insert(3, 'x', { bold: true });
      expect(vetSuggestFrame(server, Y.encodeStateAsUpdate(forger, sv), { own: [], clients: new Set() }))
        .toEqual({ ok: false, reason: 'mutate-original' });
    } finally { forger.destroy(); server.destroy(); }
  });

  it('deleting an own block cannot take the moved text inside it', () => {
    const server = seeded();
    const suggester = client(server);
    const copy = new Y.Doc();
    try {
      const s = session(server, suggester.doc);
      s.land(suggester.frame(() => select(5).insertParagraph()));
      const [block] = blocksOf(server, suggester.doc.clientID);
      const forged = rawUpdate([], [{ client: block.id.client, clock: block.id.clock, len: 1 }]);
      Y.applyUpdate(copy, Y.encodeStateAsUpdate(server));
      Y.applyUpdate(copy, forged);
      expect(blockText(copy, 1), 'Yjs deletes the moved text with its block').not.toContain('world');
      expect(s.vet(forged)).toEqual({ ok: false, reason: 'delete-original' });
    } finally { copy.destroy(); suggester.dispose(); server.destroy(); }
  });

  it("deleting an own block cannot take a peer's text inside it; a wholly own block can go", () => {
    const setup = peerInsideOwn();
    try {
      const [block] = blocksOf(setup.server, setup.suggester.doc.clientID);
      expect(setup.s.vet(rawUpdate([], [{ client: block.id.client, clock: block.id.clock, len: 1 }])))
        .toEqual({ ok: false, reason: 'delete-original' });
      const removed = setup.suggester.frame(() => { texts()[setup.nth()].getParentOrThrow().remove(); });
      expect(setup.s.vet(removed)).toEqual({ ok: false, reason: 'delete-original' });
    } finally { setup.dispose(); }
    const { server, suggester, s } = withOwnParagraph();
    try {
      expect(s.vet(suggester.frame(() => { texts()[1].getParentOrThrow().remove(); }))).toMatchObject({ ok: true });
    } finally { suggester.dispose(); server.destroy(); }
  });

  it("formatting an own text node or block cannot change a peer's text governed by it", () => {
    const own = withOwnParagraph();
    try {
      // A wholly own node and block: each lands (land throws on a refusal).
      own.s.land(own.suggester.frame(() => { select(0, 4, 1).formatText('bold'); }));
      own.s.land(own.suggester.frame(() => { texts()[1].getParentOrThrow<ParagraphNode>().setFormat('center'); }));
    } finally { own.suggester.dispose(); own.server.destroy(); }
    const setup = peerInsideOwn();
    try {
      const bold = setup.suggester.frame(() => { select(0, 11, setup.nth()).formatText('bold'); });
      expect(bold.byteLength).toBeGreaterThan(2);
      expect(setup.s.vet(bold)).toEqual({ ok: false, reason: 'mutate-original' });
      const centred = setup.suggester.frame(() => { texts()[setup.nth()].getParentOrThrow<ParagraphNode>().setFormat('center'); });
      expect(centred.byteLength).toBeGreaterThan(2);
      expect(setup.s.vet(centred)).toEqual({ ok: false, reason: 'mutate-original' });
    } finally { setup.dispose(); }
  });

  it("an editor's Backspace join keeps suggested text the suggestion's", () => {
    const server = seeded();
    const author = client(server);
    let editor: ReturnType<typeof client> | null = null;
    try {
      const s = session(server, author.doc);
      s.land(author.frame(() => {
        select(24).insertParagraph();
        const selection = $getSelection();
        if ($isRangeSelection(selection)) selection.insertText('New line');
      }));
      expect(visible(server, s.own)).toBe('New line');
      editor = client(server);
      const join = editor.frame(() => { select(0, 0, 1).deleteCharacter(true); });
      const carried = carryIdentity(server, join, s.own);
      Y.applyUpdate(server, join);
      expect(blockText(server, 0)).toBe('Hello world and the cat.New line');
      expect(visible(server, carried)).toBe('New line');
    } finally { editor?.dispose(); author.dispose(); server.destroy(); }
  });

  it('undoing a split is vetted like any split: allowed on the server and in the self-check', () => {
    const server = seeded();
    const suggester = client(server);
    try {
      const s = session(server, suggester.doc);
      s.land(suggester.frame(() => select(5).insertParagraph()));
      expect(blockText(server, 1)).toBe(' world and the cat.');
      const verdicts: Verdict[] = [];
      const onTransaction = (transaction: Y.Transaction) => {
        if (transaction.local) verdicts.push(vetTransaction(transaction, { own: s.own, moved: s.moved, clients: s.clients }));
      };
      suggester.doc.on('afterTransaction', onTransaction);
      const undone = suggester.undo();
      suggester.doc.off('afterTransaction', onTransaction);
      expect(verdicts.length, 'the undo is a local transaction').toBeGreaterThan(0);
      for (const verdict of verdicts) if (!verdict.ok) throw new Error(`self-check refused the undo: ${verdict.reason}`);
      const landed = s.land(undone);
      expect(landed.ok && landed.moved.length, 'the re-inserted tail stays original').toBeGreaterThan(0);
      expect(blockText(server, 0)).toBe('Hello world and the cat.');
    } finally { suggester.dispose(); server.destroy(); }
  });
});
