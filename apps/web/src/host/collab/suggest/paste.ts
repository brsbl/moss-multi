// T5.S10 (suggestions.md §5): a Suggest-mode paste is Lexical's own paste, one editor update in the fork, never the
// large paste's batches (large-paste.ts). Before it is dispatched (routing.ts) it is measured, not predicted: the same
// paste runs first on a throwaway copy of the fork with the pane's own paste handlers and transforms, and the bytes of
// the ops it writes there are admitted against every suggest limit, or the paste is refused with nothing changed.
import { createBinding, syncLexicalUpdateToYjs, syncYjsChangesToLexical, type Provider } from '@lexical/yjs';
import { STATE_CAP_BYTES } from '@moss-multi/protocol/limits';
import { SUGGEST_LIMITS, type IdSpan, type SuggestRefusal } from '@moss-multi/protocol/suggest';
import { excludedPropertiesFor } from '@moss-multi/sync/excluded-properties';
import { attachPayloadDocs, isPayloadType, PAYLOAD_LOADED, PayloadDocs, payloadDocsFor } from '@moss-multi/sync/payload-docs';
import { bindRegisters, seedOf } from '@moss-multi/sync/registers';
import { pendingPartBytes, type SuggestFork } from '@moss-multi/sync/suggest/client';
import { registerFork, type ForkView } from '@moss-multi/sync/suggest/forks';
import { $isTableCellNode, $isTableNode, $isTableSelection } from '@lexical/table';
import { $dfs, $findMatchingParent } from '@lexical/utils';
import {
  $createNodeSelection, $createRangeSelection, $getRoot, $getSelection, $isElementNode, $isNodeSelection,
  $isRangeSelection, $isRootOrShadowRoot, $isTextNode, $setSelection, COMMAND_PRIORITY_CRITICAL, createEditor, PASTE_COMMAND,
  SELECTION_INSERT_CLIPBOARD_NODES_COMMAND, type BaseSelection, type LexicalEditor, type LexicalNode, type PointType, type TextNode,
} from 'lexical';
import * as Y from 'yjs';
import { noteBytes } from '../../large-paste.ts';
import { WRITE_REFUSED } from '../doc-session.ts';

const utf8 = new TextEncoder();
const bytesOf = (text: string): number => utf8.encode(text).byteLength;

/** Bytes of ops a restored character takes at most: Yjs writes text as UTF-8, with an item header per run. */
const PER_BYTE = 1.25;
/** Bytes of ops a restored run or leaf adds besides its text: its item and the properties it carries. */
const PER_MARK = 320;
/** A payload's seed as a restored copy: each entry a map item whose key and header are under twice its JSON. */
const PER_JSON_BYTE = 3;

/** The pane's own paste handlers and content transforms, registered on an editor (suggest/paste-stack.ts). */
export type PasteStack = (editor: LexicalEditor) => () => void;

/** What PASTE_COMMAND carries. */
export type PasteEvent = ClipboardEvent | InputEvent | KeyboardEvent;

/** Where a point of the selection sits, by child index from the root: the same place in a copy bound to the same doc. */
interface PastePoint {
  path: number[];
  offset: number;
  type: 'text' | 'element';
}
export type PasteAt =
  | { kind: 'range'; anchor: PastePoint; focus: PastePoint }
  | { kind: 'node'; paths: number[][] }
  // A selection the copy cannot rebuild: the paste is not measured, so it is refused.
  | { kind: 'unsupported' }
  | null;

function $pathOf(node: LexicalNode): number[] {
  const path: number[] = [];
  for (let at: LexicalNode = node, parent = at.getParent(); parent; at = parent, parent = at.getParent()) path.unshift(at.getIndexWithinParent());
  return path;
}

function $nodeAt(path: readonly number[]): LexicalNode {
  let node: LexicalNode = $getRoot();
  for (const index of path) {
    const child: LexicalNode | null = $isElementNode(node) ? node.getChildAtIndex(index) : null;
    if (!child) throw new Error('the copy does not hold the selection');
    node = child;
  }
  return node;
}

/**
 * The selection the paste goes in at, read before the routing changes it. `toEnd`: the routing strikes it and the paste
 * goes in at its end (routing.ts $routeRange), so the copy pastes at that caret.
 */
export function $pasteAt(toEnd: boolean): PasteAt {
  const selection = $getSelection();
  const point = (at: PointType): PastePoint => ({ path: $pathOf(at.getNode()), offset: at.offset, type: at.type });
  if ($isRangeSelection(selection)) {
    if (!toEnd) return { kind: 'range', anchor: point(selection.anchor), focus: point(selection.focus) };
    const end = point(selection.isBackward() ? selection.anchor : selection.focus);
    return { kind: 'range', anchor: end, focus: end };
  }
  if ($isNodeSelection(selection)) return { kind: 'node', paths: selection.getNodes().map($pathOf) };
  return selection ? { kind: 'unsupported' } : null;
}

function $select(at: PasteAt): void {
  if (!at) {
    $setSelection(null);
    return;
  }
  if (at.kind === 'unsupported') throw new Error('the copy cannot rebuild the selection');
  if (at.kind === 'node') {
    const selection = $createNodeSelection();
    for (const path of at.paths) selection.add($nodeAt(path).getKey());
    $setSelection(selection);
    return;
  }
  const selection = $createRangeSelection();
  selection.anchor.set($nodeAt(at.anchor.path).getKey(), at.anchor.offset, at.anchor.type);
  selection.focus.set($nodeAt(at.focus.path).getKey(), at.focus.offset, at.focus.type);
  $setSelection(selection);
}

const noop = () => {};
const quiet = {
  awareness: { getLocalState: () => null, getStates: () => new Map(), on: noop, off: noop, setLocalState: noop, setLocalStateField: noop },
  connect: noop, disconnect: noop, on: noop, off: noop,
} as unknown as Provider;
const COPY_LOADED = Symbol('moss-multi:paste-copy-loaded');
const COLLAB_UNDO_MANAGER = Symbol.for('@lexical/yjs/UndoManager');

/**
 * Whether Lexical's table plugin would write `nodes` over a table's cells, removing what they hold natively: over
 * selected cells, or a table pasted with the selection in a cell (LexicalTablePluginHelpers, the clipboard command).
 */
export function $overwritesCells(nodes: readonly LexicalNode[], selection: BaseSelection | null): boolean {
  if ($isTableSelection(selection)) return true;
  if (!$isRangeSelection(selection)) return false;
  const inCell = [selection.anchor, selection.focus].some((point) => $findMatchingParent(point.getNode(), $isTableCellNode) !== null);
  return inCell && nodes.some((node) => $isTableNode(node) || $dfs(node).some(({ node: inner }) => $isTableNode(inner)));
}

/**
 * The bytes of ops pasting `event` at `at` writes in the fork, measured: a throwaway copy of the fork (its body and the
 * payload docs it holds, under its client) is bound to a headless editor with the source editor's nodes and HTML
 * import and the pane's `stack`, the same paste runs there as one update, and every update it makes in the copy's body
 * and payload docs is counted, as the fork forwards each as an op. Null when the copy cannot run it; 'cells' when the
 * paste writes over a table's cells ($overwritesCells), which a suggestion cannot strike.
 */
export function measurePaste(source: LexicalEditor, fork: SuggestFork, event: PasteEvent, at: PasteAt, stack: PasteStack): number | 'cells' | null {
  const cleanup: (() => void)[] = [];
  let counting = false;
  let bytes = 0;
  let cells = false;
  // An error in the copy is recorded, not thrown, so Lexical restores the pane's own update around it.
  let failed = false;
  try {
    const doc = new Y.Doc({ gc: fork.doc.gc });
    cleanup.push(() => doc.destroy());
    const own = fork.payloads;
    const body = payloadDocsFor(fork.body);
    const payloads = attachPayloadDocs(doc, new PayloadDocs((id) => {
      const from = own.get(id) ?? body.get(id);
      return from ? Y.encodeStateAsUpdate(from) : null;
    }, (id) => own.has(id)));
    cleanup.push(() => payloads.destroy());
    const count = (update: Uint8Array, origin: unknown) => {
      if (counting && origin !== COPY_LOADED && origin !== PAYLOAD_LOADED) bytes += update.byteLength;
    };
    doc.on('update', count);
    payloads.onHold((_id, payload) => {
      payload.clientID = fork.doc.clientID;
      payload.on('update', count);
    });
    // A fork's doc: the paste handlers take it as Suggest mode's (large-paste.ts pastesInBatches).
    registerFork(doc, fork);
    const args = source._createEditorArgs;
    // Never given a root element, so nothing renders; not headless, since the pane's plugins take root listeners.
    const copy = createEditor({
      // The source's namespace: Lexical pastes a clipboard's serialized nodes only into an editor of the namespace
      // that copied them, as the pane does a copy made in it.
      namespace: source._config.namespace,
      nodes: args?.nodes,
      html: args?.html,
      theme: args?.theme,
      onError: () => {
        failed = true;
      },
    });
    const binding = createBinding(copy, quiet, 'root', doc, new Map([['root', doc]]), excludedPropertiesFor(copy));
    const root = binding.root.getSharedType();
    const undo = new Y.UndoManager(root, { trackedOrigins: new Set([binding]) });
    cleanup.push(() => undo.destroy());
    (copy as unknown as Record<symbol, unknown>)[COLLAB_UNDO_MANAGER] = undo;
    const observer: Parameters<Y.XmlText['observeDeep']>[0] = (events, transaction) => {
      if (transaction.origin !== binding) syncYjsChangesToLexical(binding, quiet, events as never, false, noop);
    };
    root.observeDeep(observer);
    cleanup.push(() => root.unobserveDeep(observer));
    // As the client binds them, but writing a new block's first payload text in the update that makes it.
    cleanup.push(bindRegisters(copy, doc, { serializedImports: true, payloads }));
    cleanup.push(copy.registerTextContentListener(noop));
    cleanup.push(copy.registerUpdateListener(({ prevEditorState, editorState, dirtyElements, dirtyLeaves, normalizedNodes, tags }) => {
      syncLexicalUpdateToYjs(binding, quiet, prevEditorState, editorState, dirtyElements, dirtyLeaves, normalizedNodes, tags);
    }));
    cleanup.push(stack(copy));
    cleanup.push(copy.registerCommand(SELECTION_INSERT_CLIPBOARD_NODES_COMMAND, ({ nodes, selection }) => {
      if ($overwritesCells(nodes, selection)) cells = true;
      return false;
    }, COMMAND_PRIORITY_CRITICAL));
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(fork.doc), COPY_LOADED);
    // The fork's client, set after the load: yjs gives a doc whose own client a remote update advanced a new one.
    doc.clientID = fork.doc.clientID;
    // The note as the binding reads it, untransformed, as the pane holds it.
    copy.update(noop, { discrete: true, skipTransforms: true });
    // The selection is committed first: the paste handlers read it from the editor's state, as in the pane.
    copy.update(() => $select(at), { discrete: true });
    counting = true;
    copy.update(() => {
      copy.dispatchCommand(PASTE_COMMAND, event);
    }, { discrete: true });
    copy.update(noop, { discrete: true });
    if (cells) return 'cells';
    return failed ? null : bytes;
  } catch {
    return null;
  } finally {
    counting = false;
    for (const stop of cleanup.reverse()) {
      try {
        stop();
      } catch {
        // The copy is thrown away either way.
      }
    }
  }
}

/** A node's own properties as the binding writes them (its JSON, children apart), plus an item header. */
const nodeBytes = (node: LexicalNode, text?: string): number =>
  bytesOf(JSON.stringify({ ...node.exportJSON(), ...(text === undefined ? {} : { text }) })) + 32;
const treeBytes = (node: LexicalNode): number =>
  nodeBytes(node) + ($isElementNode(node) ? node.getChildren().reduce((sum, child) => sum + treeBytes(child), 0) : 0);

/**
 * The rest of the block after the selection, to the end of its top-level block (its following siblings at every
 * level), with the elements that hold it: a paste that splits a text node or a block re-creates it under the
 * suggester's client, the same bytes again.
 */
function $restBytes(selection: BaseSelection | null): number {
  if (!$isRangeSelection(selection)) return 0;
  const end = selection.isBackward() ? selection.anchor : selection.focus;
  const node = end.getNode();
  if ($isRootOrShadowRoot(node)) return 0;
  let bytes = 0;
  if ($isTextNode(node)) bytes += nodeBytes(node, node.getTextContent().slice(end.offset));
  else if ($isElementNode(node)) bytes += nodeBytes(node) + node.getChildren().slice(end.offset).reduce((sum, child) => sum + treeBytes(child), 0);
  // Up to the block that sits in the root (or a table cell): its siblings stay where they are.
  for (let at: LexicalNode = node, parent = at.getParent(); parent && !$isRootOrShadowRoot(parent); at = parent, parent = at.getParent()) {
    for (let next = at.getNextSibling(); next; next = next.getNextSibling()) bytes += treeBytes(next);
    bytes += nodeBytes(parent);
  }
  return bytes;
}

/**
 * What undo restores of the author's own selected text and leaves, which Lexical's paste removes natively: their
 * characters and nodes as new copies (undo.ts), a leaf's payload with it, and the blocks the selection spans.
 */
export function $ownedBytes(mine: readonly { node: TextNode; from: number; to: number }[], leaves: readonly LexicalNode[]): number {
  let bytes = 0;
  const nodes = new Set<TextNode>();
  for (const { node, from, to } of mine) {
    bytes += bytesOf(node.getTextContent().slice(from, to)) * PER_BYTE + PER_MARK;
    nodes.add(node);
  }
  for (const node of nodes) bytes += nodeBytes(node, '');
  const payloads = (node: LexicalNode): number => {
    let sum = 0;
    if (isPayloadType(node.getType())) {
      const seed = seedOf(node);
      sum += (typeof seed === 'string' ? bytesOf(seed) : bytesOf(JSON.stringify([...seed]))) * PER_JSON_BYTE;
    }
    if ($isElementNode(node)) for (const child of node.getChildren()) sum += payloads(child);
    return sum;
  };
  for (const leaf of leaves) bytes += treeBytes(leaf) * PER_BYTE + payloads(leaf);
  for (const node of $getSelection()?.getNodes() ?? []) if ($isElementNode(node)) bytes += nodeBytes(node);
  return bytes;
}

/** A refused paste's notice, by the cap it would pass. */
const REFUSED: Partial<Record<SuggestRefusal, string>> & { default: string } = {
  default: 'This paste is too large for one suggestion, so none of it was added.',
  'open-cap': 'You have too many open suggestions on this note, so none of the paste was added.',
  'record-closed': 'Suggesting stopped before the paste went in, so none of it was added.',
  lease: 'Suggesting stopped before the paste went in, so none of it was added.',
};

/** What the pane's own editor may write beyond the copy (its other plugins' transforms): a share and a floor. */
const COPY_SLACK = 1.05;
const COPY_FLOOR = 1_024;

/**
 * Admits, at the selection, a paste whose ops measure `measured` bytes on the fork's copy (measurePaste), striking
 * `targets` (the body text it replaces) and removing `owned` bytes of the author's own text ($ownedBytes): null when it
 * fits every limit, else the notice to show. A record's ops only grow, so it counts the paste, its one undo and its one
 * redo: the paste twice (the redo re-creates it), the rest of the block it splits once more and again as restored
 * copies (stepBytes) for its undo and its redo, the strike twice (the redo strikes again), and the own text once (the
 * undo restores it). It counts them against the record cap with what the record it lands in already holds (client.ts
 * admit, which finds that record as the DocDO does, a continuation of an accepted one included), the open records'
 * ops, the room the DocDO last gave retained suggestion state, the open-suggestion cap, and the share of the note's cap
 * suggestions may fill with the payloads the DocDO counts for the body. Every undo and redo is admitted again on its
 * own (admitStep).
 */
export function $admitPaste(fork: ForkView, measured: number, targets: IdSpan[], owned = 0): string | null {
  const paste = measured > 0 ? measured * COPY_SLACK + COPY_FLOOR : 0;
  const selection = $getSelection();
  const adds = 2 * paste + (1 + 2 * PER_BYTE) * $restBytes(selection) + (targets.length ? pendingPartBytes(targets) : 0) + owned;
  if (noteBytes(fork.body) + adds > STATE_CAP_BYTES * SUGGEST_LIMITS.reserveShare) return WRITE_REFUSED['doc-cap'];
  // The blocks it spans: an older open record of the author's it builds on merges into its record.
  const tops = $isRangeSelection(selection)
    ? [selection.anchor, selection.focus].map((point) => point.getNode().getTopLevelElement()?.getIndexWithinParent() ?? -1)
    : [-1];
  const refusal = fork.admit(adds, targets, { from: Math.min(...tops), to: Math.max(...tops) });
  return refusal ? (REFUSED[refusal] ?? REFUSED.default) : null;
}

type StackItem = Y.UndoManager['undoStack'][number];
/** A step of the body's undo stack (payload-docs.ts BodyUndo): its Yjs stack items, each with its manager. */
export interface UndoStep {
  entries: readonly { manager: Y.UndoManager; item: StackItem }[];
}

/** A restored copy's header: its ids, origins and property key. */
const ITEM_BYTES = 48;

/** Bytes of `len` units of an item's content from `offset`, as a copy of it encodes. */
function contentBytes(item: Y.Item, offset: number, len: number): number {
  const { content } = item;
  const json = (value: unknown): number => bytesOf(JSON.stringify(value) ?? '');
  if (content instanceof Y.ContentString) return bytesOf(content.str.slice(offset, offset + len));
  if (content instanceof Y.ContentAny) return json(content.arr.slice(offset, offset + len));
  if (content instanceof Y.ContentJSON) return json(content.arr.slice(offset, offset + len));
  if (content instanceof Y.ContentType) return 16 + bytesOf((content.type as { nodeName?: string }).nodeName ?? '');
  if (content instanceof Y.ContentFormat) return bytesOf(content.key) + json(content.value);
  if (content instanceof Y.ContentEmbed) return json(content.embed);
  if (content instanceof Y.ContentBinary) return content.content.byteLength;
  if (content instanceof Y.ContentDeleted) return 0;
  return 64;
}

/** Every item overlapping a delete set's ranges in `doc`, with the overlap, read without splitting. */
function eachItem(doc: Y.Doc, set: StackItem['deletions'], visit: (item: Y.Item, offset: number, len: number) => void): void {
  set.clients.forEach((ranges, client) => {
    const structs = doc.store.clients.get(client);
    if (!structs?.length) return;
    const first = structs[0].id.clock;
    const end = structs.at(-1)!.id.clock + structs.at(-1)!.length;
    for (const { clock, len } of ranges) {
      if (clock >= end || clock + len <= first) continue;
      for (let i = Y.findIndexSS(structs, Math.max(clock, first)); i < structs.length && structs[i].id.clock < clock + len; i += 1) {
        const struct = structs[i];
        if (!(struct instanceof Y.Item)) continue;
        const from = Math.max(clock, struct.id.clock);
        visit(struct, from - struct.id.clock, Math.min(clock + len, struct.id.clock + struct.length) - from);
      }
    }
  });
}

/** Whether `struct` is in what `manager` undoes: yjs replays nothing outside its scope. */
const inScope = (manager: Y.UndoManager, struct: Y.Item): boolean =>
  manager.scope.some((type) => (type as unknown) === manager.doc || Y.isParentOf(type as Y.AbstractType<unknown>, struct));
/** Whether the delete set `set` holds every clock of `client` in [clock, clock + len). */
function covered(set: StackItem['insertions'], client: number, clock: number, len: number): boolean {
  const ranges = [...(set.clients.get(client) ?? [])].sort((a, b) => a.clock - b.clock);
  let at = clock;
  for (const range of ranges) {
    if (range.clock > at) break;
    at = Math.max(at, range.clock + range.len);
    if (at >= clock + len) return true;
  }
  return at >= clock + len;
}
/** Whether a type holds a live item of a client other than `client`, at any depth. */
function holdsOthers(type: Y.AbstractType<unknown>, client: number): boolean {
  const other = (item: Y.Item): boolean => !item.deleted
    && (item.id.client !== client || (item.content instanceof Y.ContentType && holdsOthers(item.content.type as Y.AbstractType<unknown>, client)));
  for (let item = type._start; item; item = item.right) if (other(item)) return true;
  for (const item of type._map.values()) if (other(item)) return true;
  return false;
}

/**
 * Whether replaying a step surely changes something, as yjs popStackItem and redoItem decide: a deleted item the
 * step did not also insert comes back where its parent stands (a property value only when no later value of its key
 * outlives the step), or a live item it inserted goes. In the body (`body`) undo.ts's deleteFilter keeps a container
 * holding another client's items and decides a property's fate itself, so neither of those is sure.
 */
function surelyReplays({ entries }: UndoStep, body: Y.Doc | undefined): boolean {
  let sure = false;
  for (const { manager, item } of entries) {
    eachItem(manager.doc, item.deletions, (struct, offset, len) => {
      if (sure || !struct.deleted || struct.redone !== null || !inScope(manager, struct)) return;
      // Yjs merges adjacent deleted items, so the overlap is checked unit by unit, as popStackItem splits it.
      if (covered(item.insertions, struct.id.client, struct.id.clock + offset, len)) return;
      if ((struct.parent as Y.AbstractType<unknown>)._item?.deleted) return;
      for (let right = struct.parentSub === null ? null : struct.right; right; right = right.right) {
        if (right.redone === null && !Y.isDeleted(item.insertions, right.id)) return;
      }
      sure = true;
    });
    eachItem(manager.doc, item.insertions, (struct) => {
      if (sure || struct.deleted || struct.redone !== null || !inScope(manager, struct)) return;
      if (manager.doc === body) {
        if (struct.parentSub !== null) return;
        if (struct.content instanceof Y.ContentType && holdsOthers(struct.content.type as Y.AbstractType<unknown>, struct.id.client)) return;
      }
      sure = true;
    });
    if (sure) return true;
  }
  return false;
}

/**
 * The most ops replaying `steps` (an undo or a redo) adds, with the docs and the steps it runs (`run`). BodyUndo pops
 * from the top until a step changes something, so it counts every step down to the first that surely does (all of
 * them when none surely does): each deleted item comes back as a new copy with its content (yjs redoItem), and what a
 * step inserted goes in a delete set.
 */
export function stepBytes(steps: readonly UndoStep[], body?: Y.Doc): { bytes: number; docs: Set<Y.Doc>; run: UndoStep[] } {
  let bytes = 0;
  const docs = new Set<Y.Doc>();
  const run: UndoStep[] = [];
  for (let at = steps.length - 1; at >= 0; at -= 1) {
    run.push(steps[at]);
    for (const { manager, item } of steps[at].entries) {
      docs.add(manager.doc);
      eachItem(manager.doc, item.deletions, (struct, offset, len) => {
        if (struct.deleted) bytes += contentBytes(struct, offset, len) * PER_BYTE + ITEM_BYTES + bytesOf(struct.parentSub ?? '');
      });
      eachItem(manager.doc, item.insertions, (struct) => {
        if (!struct.deleted) bytes += 16;
      });
    }
    if (surelyReplays(steps[at], body)) break;
  }
  return { bytes, docs, run };
}

/**
 * The top-level blocks of the body (`root`) the items of the steps a replay runs (`run`, stepBytes) sit in, numbered
 * as client.ts #mergedBy numbers them (a deleted block between the live ones beside it); undefined when none of their
 * items is in the body.
 */
export function stepBlocks(root: Y.XmlText, run: readonly UndoStep[]): { from: number; to: number } | undefined {
  const tops = new Set<Y.Item>();
  const see = (struct: Y.Item) => {
    let at: Y.Item | null = struct;
    while (at && at.parent !== root) at = (at.parent as Y.AbstractType<unknown>)._item;
    if (at) tops.add(at);
  };
  for (const { manager, item } of run.flatMap((step) => step.entries)) {
    if (manager.doc !== root.doc) continue;
    eachItem(manager.doc, item.deletions, see);
    eachItem(manager.doc, item.insertions, see);
  }
  if (tops.size === 0) return undefined;
  let from = Infinity;
  let to = -Infinity;
  let index = -1;
  for (let item = root._start; item; item = item.right) {
    const block = !item.deleted && item.content instanceof Y.ContentType;
    if (block) index += 1;
    if (!tops.has(item)) continue;
    from = Math.min(from, block ? index : Math.max(0, index));
    to = Math.max(to, block ? index : index + 1);
  }
  return from <= to ? { from, to } : undefined;
}

/** A refused undo's or redo's notice, by the cap it would pass. */
function stepRefused(kind: 'undo' | 'redo', refusal: SuggestRefusal | 'doc-cap'): string {
  const done = kind === 'undo' ? 'undone' : 'redone';
  if (refusal === 'doc-cap') return `This note is at its size limit, so nothing was ${done}.`;
  if (refusal === 'open-cap') return `You have too many open suggestions on this note, so nothing was ${done}.`;
  if (refusal === 'record-closed' || refusal === 'lease') return `Suggesting stopped, so nothing was ${done}.`;
  return `This ${kind} would make the suggestion too large, so nothing was ${done}.`;
}

/**
 * Admits an undo or a redo before it changes anything: what replaying `steps` adds (stepBytes) and `extra` bytes, with
 * a strike of `targets`, against every limit $admitPaste counts. Null when it fits, else the notice to show; a refused
 * step stays where it is in the history.
 */
export function admitStep(
  fork: ForkView, kind: 'undo' | 'redo', root: Y.XmlText, steps: readonly UndoStep[], extra: number, targets: IdSpan[],
): string | null {
  const replay = stepBytes(steps, root.doc ?? undefined);
  const adds = replay.bytes + extra;
  if (adds === 0 && targets.length === 0) return null;
  const strike = targets.length ? pendingPartBytes(targets) : 0;
  if (noteBytes(fork.body) + adds + strike > STATE_CAP_BYTES * SUGGEST_LIMITS.reserveShare) return stepRefused(kind, 'doc-cap');
  // A payload doc's items it names may be an older record's of the author's, which merges too (client.ts #forward).
  const payloads = [...replay.docs].filter((doc) => doc !== root.doc);
  const refusal = fork.admit(adds, targets, stepBlocks(root, replay.run), payloads);
  return refusal ? stepRefused(kind, refusal) : null;
}

