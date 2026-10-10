// T5.S10 (suggestions.md §5): a Suggest-mode paste is Lexical's own paste, one editor update in the fork, never the
// large paste's batches (large-paste.ts). Before it is dispatched (routing.ts) it is admitted whole against every
// suggest limit by a bound no paste of the clipboard exceeds, or refused with nothing changed and the selection kept.
import { STATE_CAP_BYTES } from '@moss-multi/protocol/limits';
import type { IdSpan, SuggestRefusal } from '@moss-multi/protocol/suggest';
import { isPayloadType } from '@moss-multi/sync/payload-docs';
import { seedOf } from '@moss-multi/sync/registers';
import { pendingPartBytes } from '@moss-multi/sync/suggest/client';
import type { ForkView } from '@moss-multi/sync/suggest/forks';
import {
  $getSelection, $isElementNode, $isRangeSelection, $isRootOrShadowRoot, $isTextNode, type BaseSelection, type LexicalNode, type TextNode,
} from 'lexical';
import * as Y from 'yjs';
import { noteBytes } from '../../large-paste.ts';
import { WRITE_REFUSED } from '../doc-session.ts';

const utf8 = new TextEncoder();
const bytesOf = (text: string): number => utf8.encode(text).byteLength;

/** Bytes of ops a pasted character takes at most: Yjs writes text as UTF-8, with an item header per run. */
const PER_BYTE = 1.25;
/** Bytes of ops a line or an HTML node adds besides its text: a block and a node in it, their properties and headers. */
const PER_LINE = 640;
/** Bytes of ops an inline node adds (a format run, a link, a tab, a tag, a formula); each opens with a markup character. */
const PER_MARK = 320;
const MARKUP = /[*_~`=^$[|#{\t]/g;
/** A Lexical clipboard's JSON: each property becomes a map entry whose key and header are under twice its JSON. */
const PER_JSON_BYTE = 3;

function textBound(text: string): number {
  if (!text) return 0;
  const lines = text.split('\n').length;
  return bytesOf(text) * PER_BYTE + lines * PER_LINE + (text.match(MARKUP)?.length ?? 0) * PER_MARK;
}

/**
 * Every element and text node of the HTML may become a block and a node in it (a table cell, its paragraph), and every
 * attribute of an element a property of its node (a link keeps its href, title, rel and target).
 */
function htmlBound(html: string): number {
  if (!html) return 0;
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  let bound = 0;
  const walker = parsed.createTreeWalker(parsed.body, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    bound += PER_LINE;
    if (node.nodeType === Node.TEXT_NODE) bound += bytesOf(node.nodeValue ?? '') * PER_BYTE;
    else for (const { name, value } of (node as Element).attributes) bound += (bytesOf(name) + bytesOf(value)) * PER_BYTE + PER_MARK;
  }
  return bound;
}

/**
 * The most ops a paste of `data` can add, whichever of its kinds the paste handlers take (markdown or plain text,
 * HTML, a Lexical clipboard): the largest of their bounds.
 */
export function clipboardBound(data: DataTransfer | null): number {
  const read = (type: string): string => {
    try {
      return data?.getData(type) ?? '';
    } catch {
      return '';
    }
  };
  return Math.max(
    textBound(read('text/plain')),
    textBound(read('text/markdown')),
    textBound(read('text/uri-list')),
    htmlBound(read('text/html')),
    bytesOf(read('application/x-lexical-editor')) * PER_JSON_BYTE,
  );
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

/**
 * Admits, at the selection, a paste of at most `bound` bytes of ops that strikes `targets` (the body text it
 * replaces) and removes `owned` bytes of the author's own text ($ownedBytes): null when it fits every limit, else the
 * notice to show. A record's ops only grow, so it counts the paste, its one undo and its one redo: the bound twice
 * (the redo re-creates the paste), the rest of the block it lands in once for the paste and once more, as restored
 * copies (stepBytes), for each of its undo and its redo, the strike twice (the redo strikes again), and the own text once (the undo restores it). It
 * counts them against the record cap with what the record it lands in already holds (client.ts admit, which finds
 * that record as the DocDO does), the open records' ops, the open-suggestion cap, and the note's cap with the payloads
 * the DocDO counts for the body. Every undo and redo is admitted again on its own (admitStep).
 */
export function $admitPaste(fork: ForkView, bound: number, targets: IdSpan[], owned = 0): string | null {
  const selection = $getSelection();
  const adds = 2 * bound + (1 + 2 * PER_BYTE) * $restBytes(selection) + (targets.length ? pendingPartBytes(targets) : 0) + owned;
  if (noteBytes(fork.body) + adds > STATE_CAP_BYTES * 0.97) return WRITE_REFUSED['doc-cap'];
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

/**
 * The most ops replaying `steps` (an undo or a redo) adds: each deleted item a step deleted comes back as a new copy
 * with its content (yjs redoItem), and what it inserted goes in a delete set. BodyUndo replays from the top until a
 * step changes something, so steps count until one has an item to restore or remove.
 */
export function stepBytes(steps: readonly UndoStep[]): number {
  let bytes = 0;
  for (let at = steps.length - 1; at >= 0; at -= 1) {
    let live = false;
    for (const { manager, item } of steps[at].entries) {
      eachItem(manager.doc, item.deletions, (struct, offset, len) => {
        if (!struct.deleted) return;
        live = true;
        bytes += contentBytes(struct, offset, len) * PER_BYTE + ITEM_BYTES + bytesOf(struct.parentSub ?? '');
      });
      eachItem(manager.doc, item.insertions, (struct) => {
        if (struct.deleted) return;
        live = true;
        bytes += 16;
      });
    }
    if (live) break;
  }
  return bytes;
}

/**
 * The top-level blocks of the body (`root`) the top step's items sit in, numbered as client.ts #mergedBy numbers them
 * (a deleted block between the live ones beside it); undefined when none of its items is in the body.
 */
export function stepBlocks(root: Y.XmlText, steps: readonly UndoStep[]): { from: number; to: number } | undefined {
  const step = steps.at(-1);
  if (!step) return undefined;
  const tops = new Set<Y.Item>();
  const see = (struct: Y.Item) => {
    let at: Y.Item | null = struct;
    while (at && at.parent !== root) at = (at.parent as Y.AbstractType<unknown>)._item;
    if (at) tops.add(at);
  };
  for (const { manager, item } of step.entries) {
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
  const adds = stepBytes(steps) + extra;
  if (adds === 0 && targets.length === 0) return null;
  const strike = targets.length ? pendingPartBytes(targets) : 0;
  if (noteBytes(fork.body) + adds + strike > STATE_CAP_BYTES * 0.97) return stepRefused(kind, 'doc-cap');
  const refusal = fork.admit(adds, targets, stepBlocks(root, steps));
  return refusal ? stepRefused(kind, refusal) : null;
}

