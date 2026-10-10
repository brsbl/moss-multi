// T5.S10 (suggestions.md §5): a Suggest-mode paste is Lexical's own paste, one editor update in the fork, never the
// large paste's batches (large-paste.ts). Before it is dispatched (routing.ts) it is admitted whole against every
// suggest limit by a bound no paste of the clipboard exceeds, or refused with nothing changed and the selection kept.
import { STATE_CAP_BYTES } from '@moss-multi/protocol/limits';
import type { IdSpan, SuggestRefusal } from '@moss-multi/protocol/suggest';
import { pendingPartBytes } from '@moss-multi/sync/suggest/client';
import type { ForkView } from '@moss-multi/sync/suggest/forks';
import { $getSelection, $isElementNode, $isRangeSelection, $isRootOrShadowRoot, $isTextNode, type BaseSelection, type LexicalNode } from 'lexical';
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

/** A refused paste's notice, by the cap it would pass. */
const REFUSED: Partial<Record<SuggestRefusal, string>> & { default: string } = {
  default: 'This paste is too large for one suggestion, so none of it was added.',
  'open-cap': 'You have too many open suggestions on this note, so none of the paste was added.',
  'record-closed': 'Suggesting stopped before the paste went in, so none of it was added.',
  lease: 'Suggesting stopped before the paste went in, so none of it was added.',
};

/**
 * Admits, at the selection, a paste of at most `bound` bytes of ops that strikes `targets` (the body text it
 * replaces): null when it fits every limit, else the notice to show. A record's ops only grow, so it counts the paste,
 * its one undo and its one redo: the bound twice (the redo re-creates the paste), the rest of the block it lands in
 * three times (the paste, its undo and its redo each re-create it), and the strike twice (the redo strikes again). It
 * counts them against the record cap with what the record it lands in already holds (client.ts admit, which finds
 * that record as the DocDO does), the open records' ops, the open-suggestion cap, and the note's cap with the payloads
 * the DocDO counts for the body.
 */
export function $admitPaste(fork: ForkView, bound: number, targets: IdSpan[]): string | null {
  const selection = $getSelection();
  const adds = 2 * bound + 3 * $restBytes(selection) + (targets.length ? pendingPartBytes(targets) : 0);
  if (noteBytes(fork.body) + adds > STATE_CAP_BYTES * 0.97) return WRITE_REFUSED['doc-cap'];
  // The blocks it spans: an older open record of the author's it builds on merges into its record.
  const tops = $isRangeSelection(selection)
    ? [selection.anchor, selection.focus].map((point) => point.getNode().getTopLevelElement()?.getIndexWithinParent() ?? -1)
    : [-1];
  const refusal = fork.admit(adds, targets, { from: Math.min(...tops), to: Math.max(...tops) });
  return refusal ? (REFUSED[refusal] ?? REFUSED.default) : null;
}
