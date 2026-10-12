// T5.S10 (suggestions.md §5): a Suggest-mode paste is Lexical's own paste, one editor update in the fork, never the
// large paste's batches (large-paste.ts). Before it is dispatched (routing.ts) it is admitted whole against every
// suggest limit by a bound no paste of the clipboard exceeds, or refused with nothing changed and the selection kept.
import { STATE_CAP_BYTES } from '@moss-multi/protocol/limits';
import { SUGGEST_LIMITS, type IdSpan, type SuggestRefusal } from '@moss-multi/protocol/suggest';
import { isMossCanvasFenceName } from '@moss-desktop/common/markdown-fences';
import { parseSketchBlock } from '@moss-desktop/renderer/editor/nodes/SketchNode';
import { parseChartConfig, validateChartConfig } from '@moss-desktop/renderer/editor/utils/chartDefaults';
import { isPayloadType } from '@moss-multi/sync/payload-docs';
import { MAP_REGISTERS, seedOf } from '@moss-multi/sync/registers';
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

/** A compound payload's entry: its key, its value and a map item's header. */
const PER_ENTRY = 40;

/**
 * Bytes of ops a compound payload (a chart's config, a sketch's grid and labels) takes in its payload doc, encoded as
 * the register writes it (map-codecs.ts): a chart writes two entries per array element, each keyed by its full path.
 */
function encodedBytes(type: 'chart' | 'sketch', fields: Record<string, unknown>): number {
  let bytes = 0;
  for (const [key, value] of MAP_REGISTERS[type].encode(fields)) bytes += (bytesOf(key) + bytesOf(JSON.stringify(value) ?? '')) * PER_BYTE + PER_ENTRY;
  return bytes;
}
const chartBytes = (config: unknown): number => (config && typeof config === 'object' ? encodedBytes('chart', { __config: config }) : 0);
function sketchBytes(text: string): number {
  const { grid, labels } = parseSketchBlock(text);
  return encodedBytes('sketch', { __grid: grid, __labels: labels });
}

/** A fence line, after any blockquote, list-item or indent prefix: its marker and its language. */
const FENCE = /^((?:[ \t>]|[-+*][ \t]|\d{1,9}[.)][ \t])*)(`{3,}|~{3,})[ \t]*([^\s`]*)/;

/**
 * The compound payloads the Markdown import makes of `text`'s chart and canvas fences (normalize.ts): each block's
 * lines, read with and without its prefix, whichever reading encodes larger.
 */
function fencedPayloadBytes(text: string): number {
  const lines = text.split('\n');
  let bytes = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const open = FENCE.exec(lines[i]);
    if (!open) continue;
    const [, prefix, marker, language] = open;
    const chart = language === 'moss-chart';
    if (!chart && !isMossCanvasFenceName(language)) continue;
    const kept: string[] = [];
    const trimmed: string[] = [];
    for (i += 1; i < lines.length; i += 1) {
      const close = FENCE.exec(lines[i]);
      if (close && close[2][0] === marker[0] && close[2].length >= marker.length && !close[3]) break;
      kept.push(lines[i].replace(new RegExp(`^[ \\t>]{0,${prefix.length}}`), ''));
      trimmed.push(lines[i].replace(/^[ \t>]*/, ''));
    }
    const sizes = [kept.join('\n'), trimmed.join('\n')].map((body) => {
      if (!body.trim()) return 0;
      if (!chart) return sketchBytes(body);
      const parsed = parseChartConfig(body);
      return parsed.valid ? chartBytes(parsed.config) : 0;
    });
    bytes += Math.max(...sizes);
  }
  return bytes;
}

function textBound(raw: string): number {
  if (!raw) return 0;
  // The paste handlers read a CR or a CRLF as a line break (MarkdownEditor normalizeClipboardLineEndings).
  const text = raw.replace(/\r\n?/g, '\n');
  const lines = text.split('\n').length;
  return bytesOf(text) * PER_BYTE + lines * PER_LINE + (text.match(MARKUP)?.length ?? 0) * PER_MARK + fencedPayloadBytes(text);
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
    if (node.nodeType === Node.TEXT_NODE) {
      bound += bytesOf(node.nodeValue ?? '') * PER_BYTE;
      continue;
    }
    const element = node as Element;
    for (const { name, value } of element.attributes) bound += (bytesOf(name) + bytesOf(value)) * PER_BYTE + PER_MARK;
    // A chart's or a sketch's element (ChartNode, SketchNode importDOM) becomes a compound payload.
    const config = element.getAttribute('data-chart-config');
    if (config) {
      try {
        const checked = validateChartConfig(JSON.parse(config));
        if (checked.valid) bound += chartBytes(checked.config);
      } catch {
        // Not JSON: no chart.
      }
    }
    if (element.hasAttribute('data-sketch-grid')) bound += sketchBytes(element.getAttribute('data-sketch-grid') || element.textContent || '');
  }
  return bound;
}

/** A Lexical clipboard: its JSON, and the compound payloads its chart and sketch nodes import to. */
function lexicalBound(json: string): number {
  if (!json) return 0;
  let bytes = 0;
  const visit = (node: unknown) => {
    if (!node || typeof node !== 'object') return;
    const { type, config, grid, children } = node as { type?: unknown; config?: unknown; grid?: unknown; children?: unknown };
    if (type === 'chart') bytes += chartBytes(config);
    if (type === 'sketch' && typeof grid === 'string') bytes += sketchBytes(grid);
    if (Array.isArray(children)) children.forEach(visit);
  };
  try {
    const parsed = JSON.parse(json) as { nodes?: unknown };
    if (Array.isArray(parsed.nodes)) parsed.nodes.forEach(visit);
  } catch {
    // Not a Lexical clipboard: the paste handler ignores it.
  }
  return bytesOf(json) * PER_JSON_BYTE + bytes;
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
    lexicalBound(read('application/x-lexical-editor')),
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
 * that record as the DocDO does), the open records' ops, the room the DocDO last gave retained suggestion state, the open-suggestion cap, and the share of the note's cap
 * suggestions may fill (the rest is kept for edits) with the payloads the DocDO counts for the body. Every undo and redo is admitted again on its own (admitStep).
 */
export function $admitPaste(fork: ForkView, bound: number, targets: IdSpan[], owned = 0): string | null {
  const selection = $getSelection();
  const adds = 2 * bound + (1 + 2 * PER_BYTE) * $restBytes(selection) + (targets.length ? pendingPartBytes(targets) : 0) + owned;
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
    eachItem(manager.doc, item.deletions, (struct) => {
      if (sure || !struct.deleted || struct.redone !== null || !inScope(manager, struct) || Y.isDeleted(item.insertions, struct.id)) return;
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

