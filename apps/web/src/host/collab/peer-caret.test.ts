// @vitest-environment jsdom
// A peer's Enter or block change keeps the waiting caret on its words (T9.47). Editors are wired as the vendored
// plugin wires them, each with an awareness that keeps its own state, so the binding really publishes the caret and
// reads it back on every remote transaction. A twin is the same scenario with the module not registered: "as today"
// is always the twin's caret, never a hand-written one.
import { $getAnchorAndFocusForUserState, createBinding, syncLexicalUpdateToYjs, syncYjsChangesToLexical, type Binding, type Provider, type UserState } from '@lexical/yjs';
import { $insertList, $isListItemNode, type ListType } from '@lexical/list';
import { $createHeadingNode, $createQuoteNode } from '@lexical/rich-text';
import { $setBlocksType } from '@lexical/selection';
import {
  $createParagraphNode, $createRangeSelection, $createTextNode, $getNodeByKey, $getRoot, $getSelection, $isElementNode,
  $isRangeSelection, $isTextNode, $setSelection, COLLABORATION_TAG, createEditor, SKIP_COLLAB_TAG, SKIP_DOM_SELECTION_TAG,
  type EditorState, type ElementNode, type LexicalEditor, type LexicalNode, type RangeSelection, type TextNode,
} from 'lexical';
import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { $importNoteBody, MARKDOWN_EDITOR_NODES } from '@moss-multi/sync/converter';
import { excludedPropertiesFor } from '@moss-multi/sync/excluded-properties';
import { bindRegisters } from '@moss-multi/sync/registers';
import { isOwnOrigin, syncUnderOrigin } from './origins.ts';
import { keepCaretThroughPeers, PEER_CARET_TAG, peerCaretWork } from './peer-caret.ts';
import { createBindingUndoManager, markUndoStep } from './undo.ts';

const noop = () => {};
const settle = () => new Promise(resolve => setTimeout(resolve, 0));
/** The origin of every update one peer receives from another. */
const REMOTE = Symbol('peer-caret:remote');
const CLIENTS = { seed: 1, ada: 2, ben: 3, cy: 4 } as const;
type Name = keyof typeof CLIENTS;

const PREV = 'Previous paragraph stays put.';
const LINE = 'Target paragraph where Ben waits.';
const NEXT = 'Next paragraph stays put.';
const LEFT = 'Target paragraph where Ben';
const RIGHT = ' waits.';
const TAIL = ' paragraph where Ben waits.';
const MID = LEFT.length;
const PLAIN = [PREV, '', LINE, '', NEXT].join('\n');

// ---- Lines, as the module reads them ----

const isLine = (node: LexicalNode | null): node is ElementNode => {
  if (!$isElementNode(node) || node.isInline() || node.getKey() === 'root') return false;
  const first = node.getFirstChild();
  return !($isElementNode(first) && !first.isInline());
};
function $lines(): ElementNode[] {
  const out: ElementNode[] = [];
  const stack: LexicalNode[] = $getRoot().getChildren().reverse();
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (isLine(node)) out.push(node);
    else if ($isElementNode(node) && !node.isInline()) stack.push(...node.getChildren().reverse());
  }
  return out;
}
function $leaves(parent: ElementNode, out: LexicalNode[] = []): LexicalNode[] {
  for (const child of parent.getChildren()) {
    if ($isElementNode(child)) $leaves(child, out);
    else out.push(child);
  }
  return out;
}
const $text = (line: ElementNode) => $leaves(line).map(leaf => leaf.getTextContent()).join('');
function $line(text: string, nth = 0): ElementNode {
  const line = $lines().filter(candidate => $text(candidate) === text)[nth];
  if (!line) throw new Error(`no line ${JSON.stringify(text)} (${nth}) in ${JSON.stringify($lines().map($text))}`);
  return line;
}
function $lineOf(node: LexicalNode): ElementNode | null {
  for (let at: LexicalNode | null = node; at; at = at.getParent()) if (isLine(at)) return at;
  return null;
}
function $offsetIn(line: ElementNode, node: LexicalNode, offset: number): number {
  let at = 0;
  if ($isTextNode(node)) {
    for (const leaf of $leaves(line)) {
      if (leaf.is(node)) return at + offset;
      at += leaf.getTextContentSize();
    }
    return at;
  }
  const child = $isElementNode(node) ? node.getChildAtIndex(offset) : null;
  for (const leaf of $leaves(line)) {
    if (child && (leaf.is(child) || ($isElementNode(child) && child.isParentOf(leaf)))) return at;
    at += leaf.getTextContentSize();
  }
  return at;
}
function $pointIn(line: ElementNode, offset: number): [string, number, 'text' | 'element'] {
  let rest = offset;
  for (const leaf of $leaves(line)) {
    const size = leaf.getTextContentSize();
    if ($isTextNode(leaf) && rest <= size) return [leaf.getKey(), rest, 'text'];
    rest -= size;
  }
  return [line.getKey(), offset === 0 ? 0 : line.getChildrenSize(), 'element'];
}
/** Selects from `from` to `to` (a caret when omitted) in `line`, or from there into `toLine`. */
function $select(line: ElementNode, from: number, to = from, toLine = line): RangeSelection {
  const selection = $createRangeSelection();
  selection.anchor.set(...$pointIn(line, from));
  selection.focus.set(...$pointIn(toLine, to));
  $setSelection(selection);
  return selection;
}
const $range = () => {
  const selection = $getSelection();
  if (!$isRangeSelection(selection)) throw new Error('no range selection');
  return selection;
};

// ---- Peers ----

function awareness(name: string) {
  let state: Record<string, unknown> | null = { anchorPos: null, focusPos: null, name, color: '#3366ff', focusing: true, awarenessData: {} };
  return {
    getLocalState: () => state,
    setLocalState: (next: Record<string, unknown> | null) => { state = next; },
    setLocalStateField: (field: string, value: unknown) => { state = state && { ...state, [field]: value }; },
    getStates: () => new Map(), on: noop, off: noop,
  };
}

interface Options {
  /** Registers keepCaretThroughPeers; false makes the twin. */
  module?: boolean;
  /** Mounts the editor on a jsdom root. */
  root?: boolean;
  /** An update listener registered before the module's. */
  before?: (editor: LexicalEditor) => () => void;
}
interface Commit { tags: Set<string>; dirty: number }

const opened: { dispose(): void }[] = [];
afterEach(() => { while (opened.length > 0) opened.pop()!.dispose(); });

function peer(name: Name, seed: Y.Doc | null, { module = true, root = false, before }: Options = {}) {
  const doc = new Y.Doc();
  doc.clientID = CLIENTS[name];
  const editor = createEditor({ namespace: `peer-caret-${name}`, nodes: MARKDOWN_EDITOR_NODES, onError: (error) => { throw error; } });
  const element = root ? document.body.appendChild(document.createElement('div')) : null;
  if (element) { element.contentEditable = 'true'; editor.setRootElement(element); }
  const aware = awareness(name);
  const provider = { awareness: aware, connect: noop, disconnect: noop, on: noop, off: noop } as unknown as Provider;
  const binding: Binding = createBinding(editor, provider, 'root', doc, new Map([['root', doc]]), excludedPropertiesFor(editor));
  const stopRegisters = bindRegisters(editor, doc);
  const stopSync = editor.registerUpdateListener(({ prevEditorState, editorState, dirtyElements, dirtyLeaves, normalizedNodes, tags }) => {
    if (tags.has(SKIP_COLLAB_TAG)) return;
    markUndoStep(binding, { prevEditorState, editorState, dirtyLeaves, dirtyElements, tags });
    syncUnderOrigin(binding, tags, () => syncLexicalUpdateToYjs(binding, provider, prevEditorState, editorState, dirtyElements, dirtyLeaves, normalizedNodes, tags));
  });
  const shared = binding.root.getSharedType();
  const observer: Parameters<typeof shared.observeDeep>[0] = (events, transaction) => {
    if (!isOwnOrigin(transaction.origin, binding)) syncYjsChangesToLexical(binding, provider, events as never, transaction.origin instanceof Y.UndoManager, noop);
  };
  shared.observeDeep(observer);
  const stopBefore = before ? before(editor) : noop;
  const stopCaret = module ? keepCaretThroughPeers(editor) : noop;
  const commits: Commit[] = [];
  const updates: unknown[] = [];
  const stopCommits = editor.registerUpdateListener(({ tags, dirtyLeaves, dirtyElements }) => { commits.push({ tags: new Set(tags), dirty: dirtyLeaves.size + dirtyElements.size }); });
  const onUpdate = (_update: Uint8Array, origin: unknown) => { if (origin !== REMOTE) updates.push(origin); };
  doc.on('update', onUpdate);
  if (seed) Y.applyUpdate(doc, Y.encodeStateAsUpdate(seed), REMOTE);
  editor.update(noop, { discrete: true });
  const undo = createBindingUndoManager(binding);
  const self = {
    name, doc, editor, binding, aware, undo, commits, updates, element,
    edit: (fn: () => void) => editor.update(fn, { discrete: true }),
    step: (fn: () => void) => { editor.update(fn, { discrete: true }); undo.stopCapturing(); },
    text: () => editor.getEditorState().read(() => $getRoot().getTextContent()),
    lines: () => editor.getEditorState().read(() => $lines().map(line => [line.getType(), $text(line)] as [string, string])),
    dispose: () => {
      undo.destroy(); stopCommits(); stopCaret(); stopBefore(); stopSync(); stopRegisters();
      doc.off('update', onUpdate); shared.unobserveDeep(observer);
      if (element) { editor.setRootElement(null); element.remove(); }
      doc.destroy();
    },
  };
  opened.push(self);
  return self;
}
type Peer = ReturnType<typeof peer>;

/** One update from `from` to `to`, with everything `to` lacks, applied and settled. */
async function deliver(from: Peer, to: Peer) {
  Y.applyUpdate(to.doc, Y.encodeStateAsUpdate(from.doc, Y.encodeStateVector(to.doc)), REMOTE);
  await settle();
}

/** A note seeded by a third client from markdown, opened by each named peer. */
async function note(markdown: string, names: Name[], options: Partial<Record<Name, Options>> = {}): Promise<Peer[]> {
  const seeder = peer('seed', null, { module: false });
  seeder.edit(() => $importNoteBody(markdown));
  const peers = names.map(name => peer(name, seeder.doc, options[name]));
  await settle();
  return peers;
}

interface Where { type: string; line: string; left: string; right: string; selected?: string; backward?: boolean; format: number; style: string }
/** The caret as (its line's type and text, the text on its left and on its right); a range also gives what it selects. */
function where(p: Peer): Where | null {
  return p.editor.getEditorState().read(() => {
    const selection = $getSelection();
    if (!$isRangeSelection(selection)) return null;
    const collapsed = selection.isCollapsed();
    const point = !collapsed && selection.isBackward() ? selection.focus : selection.anchor;
    const node = point.getNode();
    const line = $lineOf(node);
    const text = line ? $text(line) : '';
    const at = line ? $offsetIn(line, node, point.offset) : point.offset;
    const base: Where = { type: line?.getType() ?? node.getType(), line: text, left: text.slice(0, at), right: text.slice(at), format: selection.format, style: selection.style };
    return collapsed ? base : { ...base, selected: selection.getTextContent(), backward: selection.isBackward() };
  });
}
const caret = (type: string, line: string, at: number) => ({ type, line, left: line.slice(0, at), right: line.slice(at) });

/** Where the peer's published awareness position resolves in `viewer`'s editor, as (line text, offset in it). */
function published(p: Peer, viewer: Peer = p): [string, number] | null {
  const state = p.aware.getLocalState() as unknown as UserState;
  return viewer.editor.getEditorState().read(() => {
    const at = $getAnchorAndFocusForUserState(viewer.binding, state);
    const node = at.anchorKey === null ? null : $getNodeByKey(at.anchorKey);
    const line = node && $lineOf(node);
    return node && line ? [$text(line), $offsetIn(line, node, at.anchorOffset)] : null;
  });
}
function selectionPoint(p: Peer): [string, number] | null {
  const now = where(p);
  return now ? [now.line, now.left.length] : null;
}

// ---- Ada's changes ----

const heading = (text = LINE, offset = 0) => () => { $select($line(text), offset); $setBlocksType($range(), () => $createHeadingNode('h2')); };
const quote = (text = LINE) => () => { $select($line(text), 0); $setBlocksType($range(), () => $createQuoteNode()); };
const list = (type: ListType, text = LINE) => () => { $select($line(text), 0); $insertList(type); };
const enter = (text: string, offset: number) => () => { $select($line(text), offset); $range().insertParagraph(); };
const typeAt = (text: string, offset: number, typed: string, nth = 0) => () => { $select($line(text, nth), offset); $range().insertText(typed); };
const bold = (text: string, from: number, to: number) => () => { $select($line(text), from, to); $range().formatText('bold'); };
/** Backspace at the start of the line: its children join the line above. */
const mergeUp = (text: string, nth = 0) => () => {
  const line = $line(text, nth);
  const above = line.getPreviousSibling() as ElementNode;
  above.append(...line.getChildren());
  line.remove();
};

// ---- Scenarios ----

interface Scenario {
  md: string;
  /** Ben's line, and the offsets of his caret (or range) in it. */
  ben: [string, number] | [string, number, number];
  nth?: number;
  /** Ben's edits still on their way when Ada's arrive: delivered to Ada only afterwards. */
  flight?: () => void;
  /** Ada's changes, each its own update; delivered as one unless `apart`. */
  ada: (() => void)[];
  apart?: boolean;
}
interface Outcome { where: Where | null; lines: [string, string][]; after?: { ada: [string, string][]; ben: [string, string][] } }

/** What the restore may never do (U9): write to the doc, add an undo step, or carry a dirty node. */
function watchWrites(ben: Peer) {
  const clock = Y.getState(ben.doc.store, ben.doc.clientID);
  const updates = ben.updates.length;
  const commits = ben.commits.length;
  const stacks = [ben.undo.undoStack.length, ben.undo.redoStack.length];
  return () => {
    expect(Y.getState(ben.doc.store, ben.doc.clientID), "Ben's own clock is unchanged by the restore").toBe(clock);
    expect(ben.updates.slice(updates), 'no update from a local origin').toEqual([]);
    expect([ben.undo.undoStack.length, ben.undo.redoStack.length], "Ben's undo stacks are unchanged").toEqual(stacks);
    for (const commit of ben.commits.slice(commits)) if (commit.tags.has(PEER_CARET_TAG)) expect(commit.dirty, 'the restore commit has no dirty node').toBe(0);
  };
}

async function run(s: Scenario, module = true, options: Options = {}): Promise<Outcome> {
  const [ada, ben] = await note(s.md, ['ada', 'ben'], { ben: { ...options, module } });
  ben.edit(() => { const line = $line(s.ben[0], s.nth); $select(line, s.ben[1], s.ben[2] ?? s.ben[1]); });
  if (s.flight) ben.edit(s.flight);
  const checkWrites = watchWrites(ben);
  for (const edit of s.ada) {
    ada.edit(edit);
    if (s.apart) await deliver(ada, ben);
  }
  if (!s.apart) await deliver(ada, ben);
  const outcome: Outcome = { where: where(ben), lines: ben.lines() };
  checkWrites();
  if (s.flight) {
    await deliver(ben, ada);
    await deliver(ada, ben);
    outcome.after = { ada: ada.lines(), ben: ben.lines() };
  }
  return outcome;
}
/** As today: the scenario ends exactly as its twin without the module. */
async function asToday(s: Scenario) {
  const fixed = await run(s, true);
  const twin = await run(s, false);
  expect(fixed).toEqual(twin);
}

// ---- Facts the design stands on (green on m9) ----

interface LineRecord { key: string; text: string; parent: string | null }
function linesOf(state: EditorState): LineRecord[] {
  return state.read(() => $lines().map(line => ({ key: line.getKey(), text: $text(line), parent: line.getParent()?.getKey() ?? null })));
}
/** Ben's next collaboration commit, as the lines it kept and the lines it created. */
async function identity(md: string, change: () => void, at: [string, number] = [LINE, MID]) {
  const [ada, ben] = await note(md, ['ada', 'ben'], { ben: { module: false } });
  ben.edit(() => { $select($line(at[0]), at[1]); });
  let seen: { prev: EditorState; next: EditorState } | null = null;
  const stop = ben.editor.registerUpdateListener(({ prevEditorState, editorState, tags }) => {
    if (tags.has(COLLABORATION_TAG) && !seen) seen = { prev: prevEditorState, next: editorState };
  });
  ada.edit(change);
  await deliver(ada, ben);
  stop();
  if (!seen) throw new Error('no collaboration commit');
  const { prev, next } = seen as { prev: EditorState; next: EditorState };
  const before = linesOf(prev);
  const after = linesOf(next);
  const kept = before.filter(line => after.some(other => other.key === line.key));
  const fresh = after.filter(line => !prev._nodeMap.has(line.key));
  // The premise: the lines whose keys are in both states stand in the same order in both.
  expect(after.filter(line => kept.some(other => other.key === line.key)).map(line => line.key), 'kept lines keep their order').toEqual(kept.map(line => line.key));
  return { before, after, kept, fresh, prev };
}

describe('facts: what the receiver of a peer\'s change keeps @p:col-1', () => {
  it('F1 a replaced line gets a new key, a split keeps its key, and kept lines keep their order', async () => {
    const swap = await identity(PLAIN, heading());
    expect(swap.kept.map(line => line.text), 'heading: the old line is gone').toEqual([PREV, NEXT]);
    expect(swap.fresh.map(line => line.text), 'heading: one fresh line').toEqual([LINE]);

    const split = await identity(PLAIN, enter(LINE, 6));
    expect(split.kept.map(line => line.text), 'Enter: the line keeps its key').toContain('Target');
    expect(split.fresh.map(line => line.text), 'Enter: one fresh line after it').toEqual([TAIL]);
    expect(split.after.findIndex(line => line.text === TAIL)).toBe(split.after.findIndex(line => line.text === 'Target') + 1);

    for (const md of [['- one', '- two', '', LINE, '', NEXT].join('\n'), [PREV, '', LINE, '', '- one', '- two'].join('\n')]) {
      const join = await identity(md, list('bullet'));
      expect(join.fresh.map(line => line.text), 'bullet joining a list: one fresh line').toEqual([LINE]);
      const list0 = join.fresh[0]!.parent;
      expect(join.after.filter(line => line.parent === list0).map(line => line.text), 'the fresh item is in that list').toContain('one');
      expect(join.prev._nodeMap.has(list0!), 'the list existed before').toBe(true);
    }

    const numbered = await identity(['- First item', `- ${LINE}`, '- Last item'].join('\n'), list('number'));
    expect(numbered.fresh.map(line => line.text), 'bullet to numbered: every item fresh').toEqual(['First item', LINE, 'Last item']);

    const merge = await identity(PLAIN, mergeUp(LINE));
    expect(merge.fresh, 'Backspace-merge: no fresh line').toEqual([]);

    const reorder = await identity(['Alpha line.', '', LINE, '', 'Charlie line.'].join('\n'), () => { $line('Alpha line.').insertBefore($line('Charlie line.')); });
    // Recorded, not asserted: which lines a reorder re-creates.
    console.info('F1 reorder [A, L, C] to [C, A, L]: fresh lines', JSON.stringify(reorder.fresh.map(line => line.text)));
  });

  it('F2 a discrete update made in the listener of a collaboration commit commits before a microtask queued there, with only its tags, and is published', async () => {
    const [ada, ben] = await note(PLAIN, ['ada', 'ben'], { ben: { module: false } });
    ben.edit(() => { $select($line(LINE), MID); });
    const order: string[] = [];
    let tags: Set<string> | null = null;
    let armed = true;
    const stop = ben.editor.registerUpdateListener(({ tags: commitTags }) => {
      if (commitTags.has('f2-probe')) { order.push('commit'); tags = new Set(commitTags); return; }
      if (!armed || !commitTags.has(COLLABORATION_TAG)) return;
      armed = false;
      ben.editor.update(() => { $select($line(NEXT), 3); }, { discrete: true, tag: 'f2-probe' });
      queueMicrotask(() => order.push('microtask'));
    });
    ada.edit(typeAt(PREV, 3, 'k'));
    await deliver(ada, ben);
    stop();
    expect(order).toEqual(['commit', 'microtask']);
    expect(tags).toEqual(new Set(['f2-probe']));
    expect(published(ben), 'the binding published the probe').toEqual([NEXT, 3]);
  });

  it('F3 a selection set inside a collaboration-tagged update is not published, and a peer\'s next keystroke pulls it back', async () => {
    const [ada, ben] = await note(PLAIN, ['ada', 'ben'], { ben: { module: false } });
    ben.edit(() => { $select($line(LINE), MID); });
    expect(published(ben)).toEqual([LINE, MID]);
    ben.editor.update(() => { $select($line(NEXT), 3); }, { discrete: true, tag: COLLABORATION_TAG });
    expect(selectionPoint(ben)).toEqual([NEXT, 3]);
    expect(published(ben), 'not published').toEqual([LINE, MID]);
    ada.edit(typeAt(PREV, 3, 'k'));
    await deliver(ada, ben);
    expect(selectionPoint(ben), 'pulled back to the awareness position').toEqual([LINE, MID]);
  });
});

// ---- Rules ----

const OFFSETS = [0, MID, LINE.length];
const CONVERSIONS: { name: string; md: string; ada: () => void; type: string }[] = [
  { name: 'Heading 2', md: PLAIN, ada: heading(), type: 'heading' },
  { name: 'quote', md: PLAIN, ada: quote(), type: 'quote' },
  { name: 'bullet as a new list', md: PLAIN, ada: list('bullet'), type: 'listitem' },
  { name: 'bullet joining the list above', md: ['- one', '- two', '', LINE, '', NEXT].join('\n'), ada: list('bullet'), type: 'listitem' },
  { name: 'bullet joining the list below', md: [PREV, '', LINE, '', '- one', '- two'].join('\n'), ada: list('bullet'), type: 'listitem' },
  { name: 'bullet between two lists', md: ['- one', '', LINE, '', '- two'].join('\n'), ada: list('bullet'), type: 'listitem' },
  { name: 'checkbox', md: PLAIN, ada: list('check'), type: 'listitem' },
  { name: 'bullet to numbered, Ben in item 2 of 3', md: ['- First item', `- ${LINE}`, '- Last item'].join('\n'), ada: list('number'), type: 'listitem' },
  {
    name: 'indent of Ben\'s item', md: ['- First item', `- ${LINE}`, '- Last item'].join('\n'), type: 'listitem',
    ada: () => { const item = $line(LINE); $select(item, 0); if ($isListItemNode(item)) item.setIndent(1); },
  },
];

describe('rules: a peer\'s block change keeps the waiting caret on its words @p:col-1', () => {
  for (const c of CONVERSIONS) {
    for (const at of OFFSETS) {
      it(`U1 ${c.name}, Ben idle at ${at}`, async () => {
        const outcome = await run({ md: c.md, ben: [LINE, at], ada: [c.ada] });
        expect(outcome.where).toMatchObject(caret(c.type, LINE, at));
      });
    }
  }
  it('U1 an empty replacement (/quote): the start of the new empty block', async () => {
    const outcome = await run({ md: PLAIN, ben: [LINE, MID], ada: [() => { const block = $createQuoteNode(); $line(LINE).replace(block); block.select(); }] });
    expect(outcome.where).toMatchObject(caret('quote', '', 0));
  });
  it('U1 "- " typed at Ben\'s offset 0 and turned into a bullet', async () => {
    const outcome = await run({
      md: PLAIN, ben: [LINE, 0], apart: true,
      ada: [typeAt(LINE, 0, '- '), () => { const line = $line(`- ${LINE}`); (line.getFirstChild() as TextNode).spliceText(0, 2, ''); $select(line, 0); $insertList('bullet'); }],
    });
    expect(outcome.where).toMatchObject(caret('listitem', LINE, 0));
  });

  const ENTERS: { name: string; md: string; ben: [string, number]; ada: () => void; want: ReturnType<typeof caret> }[] = [
    { name: 'before his caret', md: PLAIN, ben: [LINE, MID], ada: enter(LINE, 6), want: caret('paragraph', TAIL, TAIL.length - RIGHT.length) },
    { name: 'at offset 0', md: PLAIN, ben: [LINE, MID], ada: enter(LINE, 0), want: caret('paragraph', LINE, MID) },
    { name: 'mid-line, Ben at the very end', md: PLAIN, ben: [LINE, LINE.length], ada: enter(LINE, 6), want: caret('paragraph', TAIL, TAIL.length) },
    {
      name: 'in a list item', md: ['- First item', '- Item where Ben waits too'].join('\n'), ben: ['Item where Ben waits too', 14],
      ada: enter('Item where Ben waits too', 4), want: caret('listitem', ' where Ben waits too', 10),
    },
    {
      name: 'in a cell paragraph', md: ['| Head | More |', '| --- | --- |', '| Cell where Ben waits | x |'].join('\n'), ben: ['Cell where Ben waits', 14],
      ada: enter('Cell where Ben waits', 4), want: caret('paragraph', ' where Ben waits', 10),
    },
    { name: 'in a heading', md: `## ${LINE}`, ben: [LINE, MID], ada: enter(LINE, 6), want: caret('heading', TAIL, TAIL.length - RIGHT.length) },
    { name: 'at offset 0 of a heading', md: `## ${LINE}`, ben: [LINE, MID], ada: enter(LINE, 0), want: caret('heading', LINE, MID) },
    {
      name: 'before a bold run, Ben after it', md: 'Hello **bold** tail end.', ben: ['Hello bold tail end.', 13],
      ada: enter('Hello bold tail end.', 2), want: caret('paragraph', 'llo bold tail end.', 11),
    },
    {
      name: 'before a link Ben is inside', md: 'See [the link text](https://example.invalid/x) after it.', ben: ['See the link text after it.', 10],
      ada: enter('See the link text after it.', 2), want: caret('paragraph', 'e the link text after it.', 8),
    },
  ];
  for (const c of ENTERS) {
    it(`U2 Ada's Enter ${c.name}: the new block, the same words on the right`, async () => {
      const outcome = await run({ md: c.md, ben: c.ben, ada: [c.ada] });
      expect(outcome.where).toMatchObject(c.want);
    });
  }

  for (const [name, change, want] of [
    ['a heading', heading(), [LINE, MID]],
    ['an Enter before the caret', enter(LINE, 6), [TAIL, TAIL.length - RIGHT.length]],
  ] as const) {
    it(`U3 after ${name}, Ben's awareness agrees and a peer's next keystroke elsewhere leaves the caret`, async () => {
      const [ada, ben] = await note(PLAIN, ['ada', 'ben']);
      ben.edit(() => { $select($line(LINE), MID); });
      ada.edit(change);
      await deliver(ada, ben);
      expect(selectionPoint(ben)).toEqual(want);
      expect(published(ben), 'awareness resolves to the selection').toEqual(want);
      ada.edit(typeAt(PREV, 3, 'k'));
      await deliver(ada, ben);
      expect(selectionPoint(ben), 'unchanged after the next remote keystroke').toEqual(want);
    });
  }

  for (const keys of [1, 3, 12, 200]) {
    it(`U4 ${keys} typed characters in flight and a conversion: before the words on the right; the keys are gone (storage limit, PROGRESS.md T9.47)`, async () => {
      const outcome = await run({ md: PLAIN, ben: [LINE, MID], flight: () => $range().insertText('k'.repeat(keys)), ada: [heading()] });
      expect(outcome.where).toMatchObject(caret('heading', LINE, MID));
      expect(outcome.after).toEqual({ ada: [['paragraph', PREV], ['heading', LINE], ['paragraph', NEXT]], ben: [['paragraph', PREV], ['heading', LINE], ['paragraph', NEXT]] });
    });
  }
  it('U4 two Backspaces in flight and a conversion: before the words on the right; the characters are back on the left', async () => {
    const outcome = await run({ md: PLAIN, ben: [LINE, MID], flight: () => { $range().deleteCharacter(true); $range().deleteCharacter(true); }, ada: [heading()] });
    expect(outcome.where).toMatchObject(caret('heading', LINE, MID));
    expect(outcome.after?.ben).toEqual([['paragraph', PREV], ['heading', LINE], ['paragraph', NEXT]]);
    expect(outcome.after?.ada).toEqual(outcome.after?.ben);
  });
  it('U4 typing at the end of the line in flight and a conversion: the end of the new block; the keys are gone', async () => {
    const outcome = await run({ md: PLAIN, ben: [LINE, LINE.length], flight: () => $range().insertText(' and'), ada: [heading()] });
    expect(outcome.where).toMatchObject(caret('heading', LINE, LINE.length));
    expect(outcome.after?.ben).toEqual([['paragraph', PREV], ['heading', LINE], ['paragraph', NEXT]]);
    expect(outcome.after?.ada).toEqual(outcome.after?.ben);
  });
  it('U4 abc in flight and Enter before the caret: the new block before the words on the right; abc stays in the first block', async () => {
    const outcome = await run({ md: PLAIN, ben: [LINE, MID], flight: () => $range().insertText('abc'), ada: [enter(LINE, 6)] });
    expect(outcome.where).toMatchObject(caret('paragraph', TAIL, TAIL.length - RIGHT.length));
    expect(outcome.after?.ben).toEqual([['paragraph', PREV], ['paragraph', 'Targetabc'], ['paragraph', TAIL], ['paragraph', NEXT]]);
    expect(outcome.after?.ada).toEqual(outcome.after?.ben);
  });

  it('U5 one update with Ada\'s zz at Ben\'s caret and then a conversion: the caret after zz', async () => {
    const outcome = await run({ md: PLAIN, ben: [LINE, MID], ada: [typeAt(LINE, MID, 'zz'), heading(`${LEFT}zz${RIGHT}`)] });
    expect(outcome.where).toMatchObject(caret('heading', `${LEFT}zz${RIGHT}`, MID + 2));
  });
  it('U5 one update with Ada\'s zz at the end of the line and then a conversion: the caret on its words', async () => {
    const outcome = await run({ md: PLAIN, ben: [LINE, MID], ada: [typeAt(LINE, LINE.length, 'zz'), heading(`${LINE}zz`)] });
    expect(outcome.where).toMatchObject(caret('heading', `${LINE}zz`, MID));
  });

  const WORD: [number, number] = [MID - 3, MID];
  const RANGES: { name: string; ben: [number, number]; ada: () => void; selected: string; type: string; line: string }[] = [
    { name: 'both ends in the converted block', ben: WORD, ada: heading(), selected: 'Ben', type: 'heading', line: LINE },
    { name: 'both ends after a split', ben: WORD, ada: enter(LINE, 6), selected: 'Ben', type: 'paragraph', line: TAIL },
    { name: 'a word selected and Enter directly before it', ben: WORD, ada: enter(LINE, MID - 3), selected: 'Ben', type: 'paragraph', line: 'Ben waits.' },
    { name: 'a range across the split point', ben: [7, MID], ada: enter(LINE, 16), selected: 'paragraph where Ben', type: 'paragraph', line: LINE.slice(0, 16) },
  ];
  for (const c of RANGES) {
    for (const backward of [false, true]) {
      it(`U6 a range, ${c.name}${backward ? ', backward' : ''}: the same characters, format and style kept`, async () => {
        const [ada, ben] = await note(PLAIN, ['ada', 'ben']);
        ben.edit(() => {
          const selection = backward ? $select($line(LINE), c.ben[1], c.ben[0]) : $select($line(LINE), c.ben[0], c.ben[1]);
          selection.format = 2;
          selection.style = 'color: red';
        });
        const checkWrites = watchWrites(ben);
        ada.edit(c.ada);
        await deliver(ada, ben);
        checkWrites();
        const now = where(ben);
        expect(now).toMatchObject({ type: c.type, line: c.line, backward, format: 2, style: 'color: red' });
        // The range across the split now also spans the block break.
        expect(now?.selected?.split('\n').join(''), 'the same selected characters').toBe(c.selected);
        expect(now?.selected?.includes('\n'), 'across the break').toBe(c.name.includes('across'));
        if (c.name.startsWith('a word selected')) {
          ben.edit(() => $range().insertText('X'));
          await deliver(ben, ada);
          for (const p of [ada, ben]) expect(p.lines(), 'Ada\'s two blocks stay two blocks').toEqual([['paragraph', PREV], ['paragraph', 'Target paragraph where '], ['paragraph', 'X waits.'], ['paragraph', NEXT]]);
        }
      });
    }
  }
  it('U6 a range from an untouched paragraph into the converted one: the same characters', async () => {
    const [ada, ben] = await note(PLAIN, ['ada', 'ben']);
    ben.edit(() => { $select($line(PREV), 9, MID, $line(LINE)); });
    const selected = where(ben)?.selected;
    ada.edit(heading());
    await deliver(ada, ben);
    expect(where(ben)).toMatchObject({ type: 'paragraph', line: PREV, selected });
    expect(ben.editor.getEditorState().read(() => $lineOf($range().focus.getNode())?.getType())).toBe('heading');
  });

  for (const [name, change, ben0, cy0, line] of [
    ['a conversion', heading(), MID, 7, LINE],
    ['an Enter before both carets', enter(LINE, 6), MID, MID + 3, TAIL],
  ] as const) {
    it(`U7 Ada, Ben and Cy: ${name} keeps Ben and Cy on their own words`, async () => {
      const [ada, ben, cy] = await note(PLAIN, ['ada', 'ben', 'cy']);
      ben.edit(() => { $select($line(LINE), ben0); });
      cy.edit(() => { $select($line(LINE), cy0); });
      ada.edit(change);
      await deliver(ada, ben);
      await deliver(ada, cy);
      const shift = LINE.length - line.length;
      expect(where(ben)).toMatchObject({ line, left: LINE.slice(shift, ben0), right: LINE.slice(ben0) });
      expect(where(cy)).toMatchObject({ line, left: LINE.slice(shift, cy0), right: LINE.slice(cy0) });
      expect(published(ben, cy), "Cy's view of Ben's caret is in the new block").toEqual([line, ben0 - shift]);
    });
  }

  it('U8 Ada converts and undoes: Ben stays on his words both times', async () => {
    const [ada, ben] = await note(PLAIN, ['ada', 'ben']);
    ben.edit(() => { $select($line(LINE), MID); });
    ada.step(heading());
    await deliver(ada, ben);
    expect(where(ben)).toMatchObject(caret('heading', LINE, MID));
    ada.undo.undo();
    await deliver(ada, ben);
    expect(where(ben)).toMatchObject(caret('paragraph', LINE, MID));
  });
  it('U8 Ada\'s Enter and then her undo: as today', async () => {
    const once = async (module: boolean) => {
      const [ada, ben] = await note(PLAIN, ['ada', 'ben'], { ben: { module } });
      ben.edit(() => { $select($line(LINE), MID); });
      ada.step(enter(LINE, 6));
      await deliver(ada, ben);
      ada.undo.undo();
      await deliver(ada, ben);
      return { where: where(ben), ada: ada.lines(), ben: ben.lines() };
    };
    expect(await once(true)).toEqual(await once(false));
  });
  it('U8 Ben types wor, Ada converts, Ben undoes twice: both documents as today, and nothing throws', async () => {
    const once = async (module: boolean) => {
      const [ada, ben] = await note(PLAIN, ['ada', 'ben'], { ben: { module } });
      ben.edit(() => { $select($line(LINE), MID); });
      ben.step(() => $range().insertText('wor'));
      await deliver(ben, ada);
      ada.step(heading(`${LEFT}wor${RIGHT}`));
      await deliver(ada, ben);
      ben.undo.undo();
      await settle();
      ben.undo.undo();
      await settle();
      await deliver(ben, ada);
      await deliver(ada, ben);
      return { ada: ada.lines(), ben: ben.lines() };
    };
    expect(await once(true)).toEqual(await once(false));
  });
});

// ---- Controls: as today, by twin ----

describe('controls: what the module leaves as today @p:col-1', () => {
  const C: [string, Scenario][] = [
    ['C1 Ada types before Ben\'s caret', { md: PLAIN, ben: [LINE, MID], ada: [typeAt(LINE, 3, 'k')] }],
    ['C1 Ada types after Ben\'s caret', { md: PLAIN, ben: [LINE, MID], ada: [typeAt(LINE, 30, 'k')] }],
    ['C1 Ada bolds a word before Ben\'s caret', { md: PLAIN, ben: [LINE, MID], ada: [bold(LINE, 7, 16)] }],
    ['C1 Ada bolds a word after Ben\'s caret', { md: PLAIN, ben: [LINE, MID], ada: [bold(LINE, 27, 32)] }],
    ['C1 Ada merges Ben\'s line up', { md: PLAIN, ben: [LINE, MID], ada: [mergeUp(LINE)] }],
    ['C1 Ada merges Ben\'s line up, an identical paragraph below', { md: [PREV, '', LINE, '', LINE].join('\n'), ben: [LINE, MID], ada: [mergeUp(LINE)] }],
    ['C1 Ada merges the next line into Ben\'s', { md: PLAIN, ben: [LINE, MID], ada: [() => { const line = $line(LINE); const next = $line(NEXT); line.append(...next.getChildren()); next.remove(); }] }],
    ['C1 Ada deletes Ben\'s paragraph', { md: PLAIN, ben: [LINE, MID], ada: [() => { $line(LINE).remove(); }] }],
    ...(['Alpha line.', LINE, 'Charlie line.'] as const).map((at): [string, Scenario] => [
      `C2 [A, L, C] to [C, A, L], Ben in ${at}`,
      { md: ['Alpha line.', '', LINE, '', 'Charlie line.'].join('\n'), ben: [at, 3], ada: [() => { $line('Alpha line.').insertBefore($line('Charlie line.')); }] },
    ]),
    ['C2 a two-item swap', { md: [LINE, '', 'Charlie line.'].join('\n'), ben: [LINE, MID], ada: [() => { $line(LINE).insertBefore($line('Charlie line.')); }] }],
    ['C2 three items that read the same', { md: ['Same.', '', 'Same.', '', 'Same.'].join('\n'), ben: ['Same.', 2], nth: 1, ada: [() => { $line('Same.', 0).insertBefore($line('Same.', 2)); }] }],
    ...([['one character before the end', 16, 'New line.'], ['at the end', 17, 'New line.'], ['a new paragraph as long as the deleted run', 17, 'Beta.']] as const).map(([name, at, added]): [string, Scenario] => [
      `C3 one update: a word deleted on Ben's left and a paragraph added below, Ben ${name}`,
      { md: ['Alpha beta gamma.', '', NEXT].join('\n'), ben: ['Alpha beta gamma.', at], ada: [() => { const line = $line('Alpha beta gamma.'); (line.getFirstChild() as TextNode).spliceText(6, 5, ''); line.insertAfter($createParagraphNode().append($createTextNode(added))); }] },
    ]),
    ...([['unrelated text', 'Unrelated words here.'], ['an empty paragraph', ''], ['a prefix of Ben\'s line', 'Target para']] as const).map(([name, written]): [string, Scenario] => [
      `C4 one update: Ben's line merged up and ${name} written where it stood`,
      { md: PLAIN, ben: [LINE, MID], ada: [() => { const line = $line(LINE); const block = $createParagraphNode(); if (written) block.append($createTextNode(written)); line.insertAfter(block); mergeUp(LINE)(); }] },
    ]),
    ['C4 one update: the paragraph above deleted, Ben\'s converted, one added below', {
      md: ['Above stays.', '', 'Paragraph above.', '', LINE, '', NEXT].join('\n'), ben: [LINE, MID],
      ada: [() => { $line('Paragraph above.').remove(); heading()(); $line(LINE).insertAfter($createParagraphNode().append($createTextNode('Added below.'))); }],
    }],
    ['C5 Ada replaces from mid-line to the end with two paragraphs, the second ending like Ben\'s line', {
      md: ['Alpha beta gamma.', '', NEXT].join('\n'), ben: ['Alpha beta gamma.', 10],
      ada: [() => { const line = $line('Alpha beta gamma.'); (line.getFirstChild() as TextNode).spliceText(6, 11, 'One.'); line.insertAfter($createParagraphNode().append($createTextNode('Two gamma.'))); }],
    }],
    ['C6 Enter exactly at Ben\'s caret', { md: PLAIN, ben: [LINE, MID], ada: [enter(LINE, MID)] }],
    ['C6 Enter after Ben\'s caret', { md: PLAIN, ben: [LINE, MID], ada: [enter(LINE, 30)] }],
    ['C6 Enter mid-line while Ben\'s abc at the end of the line is unsent', { md: PLAIN, ben: [LINE, LINE.length], flight: () => $range().insertText('abc'), ada: [enter(LINE, 6)] }],
    ['C6 Enter before Ben\'s caret while his Backspaces are unsent', { md: PLAIN, ben: [LINE, MID], flight: () => { $range().deleteCharacter(true); $range().deleteCharacter(true); }, ada: [enter(LINE, 6)] }],
    ['C6 Enter at offset 0 with Ben at offset 0', { md: PLAIN, ben: [LINE, 0], ada: [enter(LINE, 0)] }],
    ['C7 Ada pastes three lines before Ben\'s caret', { md: PLAIN, ben: [LINE, MID], ada: [() => { const s = $select($line(LINE), 7); s.insertText('one'); s.insertParagraph(); $range().insertText('two'); $range().insertParagraph(); $range().insertText('three '); }] }],
    ['C7 one update: Ada\'s Enter and then zz at Ben\'s place in the new block', { md: PLAIN, ben: [LINE, MID], ada: [enter(LINE, 6), typeAt(TAIL, TAIL.length - RIGHT.length, 'zz')] }],
    ['C7 one update that changes Ben\'s line on both sides of his caret', { md: PLAIN, ben: [LINE, MID], ada: [heading(), typeAt(LINE, 0, 'x'), typeAt(`x${LINE}`, LINE.length + 1, 'y')] }],
  ];
  for (const [name, scenario] of C) it(`${name}: as today`, () => asToday(scenario));

  it('C6 Enter exactly at Ben\'s caret held at the start of a bold node: as today', async () => {
    const once = async (module: boolean) => {
      const [ada, ben] = await note('Hello **bold** tail', ['ada', 'ben'], { ben: { module } });
      ben.edit(() => {
        const node = $leaves($line('Hello bold tail'))[1] as TextNode;
        const selection = $createRangeSelection();
        selection.anchor.set(node.getKey(), 0, 'text');
        selection.focus.set(node.getKey(), 0, 'text');
        $setSelection(selection);
      });
      ada.edit(enter('Hello bold tail', 6));
      await deliver(ada, ben);
      return { where: where(ben), lines: ben.lines() };
    };
    expect(await once(true)).toEqual(await once(false));
  });

  const composing = (root: HTMLElement) => root.dispatchEvent(new Event('compositionstart'));
  it('C8 composing, not editable, no selection: as today', async () => {
    const once = async (module: boolean, prepare: (ben: Peer) => void, park = true) => {
      const [ada, ben] = await note(PLAIN, ['ada', 'ben'], { ben: { module, root: true } });
      if (park) ben.edit(() => { $select($line(LINE), MID); });
      prepare(ben);
      ada.edit(heading());
      await deliver(ada, ben);
      return { where: where(ben), restores: ben.commits.filter(commit => commit.tags.has(PEER_CARET_TAG)).length };
    };
    expect(await once(true, ben => composing(ben.element!))).toEqual(await once(false, ben => composing(ben.element!)));
    expect(await once(true, ben => ben.editor.setEditable(false))).toEqual(await once(false, ben => ben.editor.setEditable(false)));
    expect(await once(true, noop, false)).toEqual({ where: null, restores: 0 });
  });
  for (const [name, prepare] of [
    ['after compositionend', (root: HTMLElement) => { composing(root); root.dispatchEvent(new Event('compositionend')); }],
    ['after focusout with no compositionend', (root: HTMLElement) => { composing(root); root.dispatchEvent(new FocusEvent('focusout')); }],
    ['with the root not the active element', noop],
  ] as const) {
    it(`C8b ${name}: restored, without touching the DOM selection of an unfocused editor`, async () => {
      const [ada, ben] = await note(PLAIN, ['ada', 'ben'], { ben: { root: true } });
      ben.edit(() => { $select($line(LINE), MID); });
      prepare(ben.element!);
      const from = ben.commits.length;
      ada.edit(heading());
      await deliver(ada, ben);
      expect(where(ben)).toMatchObject(caret('heading', LINE, MID));
      const restores = ben.commits.slice(from).filter(commit => commit.tags.has(PEER_CARET_TAG));
      expect(restores.length).toBeGreaterThan(0);
      for (const commit of restores) expect(commit.tags.has(SKIP_DOM_SELECTION_TAG)).toBe(true);
    });
  }

  it('C9 a skip-collab update queued before the restore joins its commit: the restore is issued once more and awareness agrees', async () => {
    const before = (editor: LexicalEditor) => editor.registerUpdateListener(({ tags }) => {
      if (tags.has(COLLABORATION_TAG)) editor.update(noop, { tag: SKIP_COLLAB_TAG });
    });
    const [ada, ben] = await note(PLAIN, ['ada', 'ben'], { ben: { before } });
    ben.edit(() => { $select($line(LINE), MID); });
    const from = ben.commits.length;
    ada.edit(heading());
    await deliver(ada, ben);
    expect(where(ben)).toMatchObject(caret('heading', LINE, MID));
    expect(published(ben), 'awareness agrees').toEqual([LINE, MID]);
    expect(ben.commits.slice(from).filter(commit => commit.tags.has(PEER_CARET_TAG)).length, 'exactly two restore commits').toBe(2);
  });
});

// ---- Cost ----

describe('cost: a peer\'s keystroke never places the caret, and a placement is linear @p:col-1', () => {
  it('S1 200 of Ada\'s keystrokes elsewhere and on Ben\'s left: place is never called', async () => {
    const [ada, ben] = await note(PLAIN, ['ada', 'ben']);
    ben.edit(() => { $select($line(LINE), MID); });
    const placed = peerCaretWork.placed;
    for (let i = 0; i < 100; i++) {
      ada.edit(() => { const line = $lines()[0]!; ($leaves(line)[0] as TextNode).spliceText(3, 0, 'k'); });
      await deliver(ada, ben);
    }
    for (let i = 0; i < 100; i++) {
      ada.edit(() => { const line = $lines()[1]!; ($leaves(line)[0] as TextNode).spliceText(3, 0, 'k'); });
      await deliver(ada, ben);
    }
    expect(peerCaretWork.placed - placed).toBe(0);
    expect(where(ben)?.right).toBe(RIGHT);
  }, 60_000);

  it('S1 a 5,000-item and a 20,000-item list changed bullet to numbered, Ben in item 2: node visits grow linearly', async () => {
    const visits: number[] = [];
    for (const size of [5_000, 20_000]) {
      const md = Array.from({ length: size }, (_, i) => `- Item ${i + 1}`).join('\n');
      const [ada, ben] = await note(md, ['ada', 'ben']);
      ben.edit(() => { $select($line('Item 2'), 3); });
      const from = peerCaretWork.visits;
      ada.edit(list('number', 'Item 1'));
      await deliver(ada, ben);
      visits.push(peerCaretWork.visits - from);
      expect(where(ben)).toMatchObject(caret('listitem', 'Item 2', 3));
      while (opened.length > 0) opened.pop()!.dispose();
    }
    expect(visits[0]!, 'the placement walked the list').toBeGreaterThan(0);
    expect(visits[1]!, `visits ${JSON.stringify(visits)}`).toBeLessThanOrEqual(visits[0]! * 4.5);
  }, 240_000);
});
