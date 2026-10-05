// Lexical nodes to Yjs items and back, through a bound editor's binding (@lexical/yjs V1): a text node is its
// property map embedded in the parent's XmlText followed by its characters; an element is its own XmlText; a decorator
// is an XmlElement. Used by suggestion paint, routed deletes and caret restore (docs/design/suggestions.md §5, §7).
import type { Binding } from '@lexical/yjs';
import type { IdSpan } from '@moss-multi/protocol/suggest';
import type { LexicalEditor, NodeKey } from 'lexical';
import * as Y from 'yjs';

interface CollabLike {
  _key: NodeKey;
  _map?: Y.Map<unknown>;
  _text?: string;
  _xmlText?: Y.XmlText;
  _xmlElem?: Y.XmlElement;
}

const collabOf = (binding: Binding, key: NodeKey): CollabLike | undefined => binding.collabNodeMap.get(key) as unknown as CollabLike | undefined;

/** The ids of a text node's characters, in order; null when the binding holds no text node for `key`. */
export function textIds(binding: Binding, key: NodeKey): Y.ID[] | null {
  const collab = collabOf(binding, key);
  if (!collab || typeof collab._text !== 'string' || !(collab._map instanceof Y.Map)) return null;
  const start = collab._map._item;
  if (!start) return null;
  const ids: Y.ID[] = [];
  for (let item = start.right; item; item = item.right) {
    if (item.deleted) continue;
    if (item.content instanceof Y.ContentString) {
      for (let i = 0; i < item.length; i += 1) ids.push(Y.createID(item.id.client, item.id.clock + i));
      continue;
    }
    if (item.content instanceof Y.ContentFormat) continue;
    break;
  }
  return ids.length === collab._text.length ? ids : null;
}

/** The Yjs item behind an element or decorator node. */
export function sharedItem(binding: Binding, key: NodeKey): Y.Item | null {
  const collab = collabOf(binding, key);
  return (collab?._xmlText ?? collab?._xmlElem ?? collab?._map)?._item ?? null;
}

export const idKey = (id: { client: number; clock: number }): string => `${id.client}:${id.clock}`;

export interface CharPlace {
  key: NodeKey;
  offset: number;
}

/** Every text character by id, plus each element's item id → its key (offset -1). O(text). */
export function charIndex(binding: Binding): Map<string, CharPlace> {
  const index = new Map<string, CharPlace>();
  for (const [key, collab] of binding.collabNodeMap as unknown as Map<NodeKey, CollabLike>) {
    if (typeof collab._text === 'string') {
      const ids = textIds(binding, key);
      if (collab._map?._item) index.set(idKey(collab._map._item.id), { key, offset: 0 });
      if (ids) ids.forEach((id, offset) => index.set(idKey(id), { key, offset }));
      continue;
    }
    const item = (collab._xmlText ?? collab._xmlElem)?._item;
    if (item) index.set(idKey(item.id), { key, offset: -1 });
  }
  return index;
}

const graphemes = typeof Intl !== 'undefined' && 'Segmenter' in Intl ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;

/** The UTF-16 range [from, to) of the character (grapheme) holding code unit `at`; never splits a surrogate pair. */
export function charAround(text: string, at: number): [number, number] {
  const segment = graphemes?.segment(text).containing(at);
  if (segment) return [segment.index, segment.index + segment.segment.length];
  const high = (i: number) => i >= 0 && i < text.length && (text.charCodeAt(i) & 0xfc00) === 0xd800;
  const low = (i: number) => i >= 0 && i < text.length && (text.charCodeAt(i) & 0xfc00) === 0xdc00;
  if (high(at) && low(at + 1)) return [at, at + 2];
  if (low(at) && high(at - 1)) return [at - 1, at + 1];
  return [at, at + 1];
}

/** Consecutive ids folded into spans. */
export function toSpans(ids: readonly Y.ID[]): IdSpan[] {
  const spans: IdSpan[] = [];
  for (const id of ids) {
    const last = spans.at(-1);
    if (last && last.client === id.client && last.clock + last.len === id.clock) last.len += 1;
    else spans.push({ client: id.client, clock: id.clock, len: 1 });
  }
  return spans;
}

/** The DOM text node holding a Lexical text node's characters, when it holds exactly `length` of them. */
export function domText(editor: LexicalEditor, key: NodeKey, length: number): Text | null {
  const element = editor.getElementByKey(key);
  if (!element) return null;
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  const text = walker.nextNode() as Text | null;
  return text && text.data.length === length && !walker.nextNode() ? text : null;
}

/** DOM ranges over each run of a binding's characters that `match` picks. */
export function rangesWhere(editor: LexicalEditor, binding: Binding, match: (id: Y.ID) => boolean): Range[] {
  const ranges: Range[] = [];
  for (const [key, collab] of binding.collabNodeMap as unknown as Map<NodeKey, CollabLike>) {
    if (typeof collab._text !== 'string' || collab._text.length === 0) continue;
    const ids = textIds(binding, key);
    if (!ids) continue;
    let text: Text | null | undefined;
    let from = -1;
    const flush = (to: number) => {
      if (from < 0) return;
      text ??= domText(editor, key, ids.length);
      if (text) {
        const range = document.createRange();
        range.setStart(text, from);
        range.setEnd(text, to);
        ranges.push(range);
      }
      from = -1;
    };
    ids.forEach((id, i) => {
      if (match(id)) {
        if (from < 0) from = i;
      } else flush(i);
    });
    flush(ids.length);
  }
  return ranges;
}
