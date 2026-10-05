// Suggestion paint (docs/design/suggestions.md §7): derived, never written to the tree (L§4.12). Inserts paint
// `::highlight(suggest-insert)` and delete targets `::highlight(suggest-delete)` in F (Suggest) and C (Review). In
// Edit mode, on B, each run of record items in C gets a wedge at its left body neighbour, a gutter bar beside its
// block and a hover preview of its text; delete targets paint struck; a block a record restyles gets a dot.
import type { Binding } from '@lexical/yjs';
import { regRefs } from '@moss-multi/core/suggest/apply';
import { SUGGEST_MARK_ATTR, OVERLAY_SURFACE_ATTR } from '@moss-multi/protocol/dom-contract';
import { openRecords, type Built } from '@moss-multi/sync/suggest/client';
import type { LexicalEditor } from 'lexical';
import * as Y from 'yjs';
import { charIndex, idKey, rangesWhere, type CharPlace } from './chars.ts';

const INSERT = 'suggest-insert';
const DELETE = 'suggest-delete';
const layers = new Map<object, { insert: Range[]; strike: Range[] }>();

const highlights = (): Map<string, unknown> | null =>
  typeof CSS !== 'undefined' && 'highlights' in CSS && typeof Highlight !== 'undefined' ? (CSS as unknown as { highlights: Map<string, unknown> }).highlights : null;

function publish(): void {
  const registry = highlights();
  if (!registry) return;
  const all = [...layers.values()];
  const insert = all.flatMap((layer) => layer.insert);
  const strike = all.flatMap((layer) => layer.strike);
  if (insert.length) registry.set(INSERT, new Highlight(...insert));
  else registry.delete(INSERT);
  if (strike.length) registry.set(DELETE, new Highlight(...strike));
  else registry.delete(DELETE);
}

export function paintRanges(owner: object, insert: Range[], strike: Range[]): void {
  layers.set(owner, { insert, strike });
  publish();
}

export function clearPaint(owner: object): void {
  if (layers.delete(owner)) publish();
}

const covers = (spans: readonly { client: number; clock: number; len: number }[], id: Y.ID) =>
  spans.some((span) => span.client === id.client && span.clock <= id.clock && id.clock < span.clock + span.len);

/** Paint for an editor bound to F or C: items of `own` clients as inserts, `struck` spans as deletes. */
export function paintBound(owner: object, editor: LexicalEditor, binding: Binding, own: ReadonlySet<number>, struck: readonly { client: number; clock: number; len: number }[]): void {
  const insert = own.size ? rangesWhere(editor, binding, (id) => own.has(id.client)) : [];
  const strike = struck.length ? rangesWhere(editor, binding, (id) => covers(struck, id)) : [];
  paintRanges(owner, insert, strike);
}

/** Every valid open record's delete targets. */
export function partTargets(body: Y.Doc, valid: ReadonlySet<string>): { client: number; clock: number; len: number }[] {
  return openRecords(body).filter((record) => valid.has(record.meta.id)).flatMap((record) => record.parts.flatMap((part) => part.targets));
}

/**
 * Body items a valid record's own ops delete (a join, a split, a restyle rewrite their original text): each op's
 * delete set, less the items of any record's leased clients. Decoded once per rebuild of C.
 */
export function removedBodyItems(body: Y.Doc, built: Built): { client: number; clock: number; len: number }[] {
  const valid = new Set(built.valid);
  const spans: { client: number; clock: number; len: number }[] = [];
  for (const record of openRecords(body)) {
    if (!valid.has(record.meta.id)) continue;
    for (const op of record.ops) {
      let ds: ReturnType<typeof Y.decodeUpdate>['ds'];
      try {
        ds = Y.decodeUpdate(op).ds;
      } catch {
        continue;
      }
      for (const [client, ranges] of ds.clients) {
        if (built.clients.has(client)) continue;
        for (const { clock, len } of ranges) spans.push({ client, clock, len });
      }
    }
  }
  return spans;
}

interface Mark {
  kind: 'insert' | 'attribute';
  place: CharPlace;
  /** After the anchor character rather than at it. */
  after: boolean;
  text: string;
  record: string;
}

function plain(type: Y.AbstractType<unknown>): string {
  if (type instanceof Y.XmlText) {
    return (type.toDelta() as { insert: unknown }[]).map(({ insert }) => (typeof insert === 'string' ? insert : insert instanceof Y.XmlText ? plain(insert as unknown as Y.AbstractType<unknown>) : '')).join('');
  }
  return '';
}

/** The `registers` key an item sits under (an entry, or anything inside one), or null outside `registers`. */
function registerKey(doc: Y.Doc, item: Y.Item): string | null {
  const registers = doc.getMap('registers') as unknown as Y.AbstractType<unknown>;
  for (let current: Y.Item | null = item; current; ) {
    const parent = current.parent as Y.AbstractType<unknown>;
    if (parent === registers) return current.parentSub;
    current = parent._item;
  }
  return null;
}

function registerPreview(doc: Y.Doc, key: string): string {
  const value = doc.getMap('registers').get(key);
  if (value instanceof Y.Text) return value.toString();
  if (value instanceof Y.AbstractType) return JSON.stringify(value.toJSON());
  return typeof value === 'string' ? value : '';
}

/**
 * The marks Edit mode paints for C's records over B's binding. `removed`: body items the records' ops delete, so an
 * edit that only deletes inside an original register still marks its block.
 */
export function editMarks(body: Y.Doc, built: Built, binding: Binding, removed: readonly { client: number; clock: number; len: number }[] = []): Mark[] {
  const index = charIndex(binding);
  const marks = new Map<string, Mark>();
  // Original registers a record edits, by key: their decorators in B get a mark previewing the register in C.
  const registers = new Map<string, string>();
  const noteRegister = (item: Y.Item, record: string) => {
    const key = registerKey(built.doc, item);
    if (key !== null && !registers.has(key) && body.getMap('registers').has(key)) registers.set(key, record);
  };
  for (const [client, record] of built.clients) {
    for (const struct of built.doc.store.clients.get(client) ?? []) {
      if (struct instanceof Y.Item) noteRegister(struct, record);
      if (!(struct instanceof Y.Item) || struct.deleted || struct.parentSub !== null) continue;
      const content = struct.content;
      // A text node's property map marks no text of its own.
      if (content instanceof Y.ContentType && content.type instanceof Y.Map) continue;
      let text: string;
      if (content instanceof Y.ContentString) text = content.str;
      else if (content instanceof Y.ContentType) text = content.type instanceof Y.XmlText ? `\n${plain(content.type as Y.AbstractType<unknown>)}` : '';
      else continue;
      let left = struct.left;
      while (left && (left.deleted || built.clients.has(left.id.client))) left = left.left;
      const anchor = left ? Y.createID(left.id.client, left.id.clock + left.length - 1) : (struct.parent as Y.AbstractType<unknown>)._item?.id;
      const place = anchor && index.get(idKey(anchor));
      if (!place) continue;
      const key = `${place.key}:${place.offset}:${record}`;
      const mark = marks.get(key);
      if (mark) mark.text += text;
      else marks.set(key, { kind: 'insert', place, after: !!left && place.offset >= 0 && left.content instanceof Y.ContentString, text, record });
    }
  }
  // A block whose own attributes a record changed, nested ones (a checked list item) included.
  const visit = (parent: Y.XmlText) => {
    for (const { insert } of parent.toDelta() as { insert: unknown }[]) {
      if (!(insert instanceof Y.XmlText) || !insert._item) continue;
      visit(insert);
      const id = insert._item.id;
      if (id.clock >= Y.getState(body.store, id.client)) continue;
      const before = Y.getItem(body.store, id);
      const was = before instanceof Y.Item && before.content instanceof Y.ContentType ? (before.content.type as Y.XmlText) : null;
      if (!was || JSON.stringify(was.getAttributes()) === JSON.stringify(insert.getAttributes())) continue;
      const place = index.get(idKey(id));
      if (place) marks.set(`attr:${place.key}`, { kind: 'attribute', place, after: false, text: '', record: '' });
    }
  };
  visit(built.doc.get('root', Y.XmlText));
  for (const span of removed) {
    if (span.clock >= Y.getState(built.doc.store, span.client)) continue;
    const item = Y.getItem(built.doc.store, Y.createID(span.client, span.clock));
    if (item instanceof Y.Item) noteRegister(item, '');
  }
  if (registers.size > 0) {
    const refs = regRefs(body);
    for (const [key, record] of registers) {
      for (const type of refs.get(key) ?? []) {
        const place = type._item && index.get(idKey(type._item.id));
        if (place) marks.set(`reg:${place.key}`, { kind: 'insert', place, after: false, text: registerPreview(built.doc, key), record });
      }
    }
  }
  return [...marks.values()];
}

/** Where a mark sits, relative to `host`. */
function rectOf(editor: LexicalEditor, mark: Mark): DOMRect | null {
  const element = editor.getElementByKey(mark.place.key);
  if (!element) return null;
  if (mark.place.offset < 0) return element.getBoundingClientRect();
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  const text = walker.nextNode() as Text | null;
  if (!text) return element.getBoundingClientRect();
  const range = document.createRange();
  const offset = Math.min(mark.place.offset + (mark.after ? 1 : 0), text.data.length);
  range.setStart(text, offset);
  range.setEnd(text, offset);
  return range.getClientRects()[0] ?? range.getBoundingClientRect();
}

/** The top-level block element holding a key's DOM. */
function blockElement(editor: LexicalEditor, key: string): HTMLElement | null {
  const root = editor.getRootElement();
  let element = editor.getElementByKey(key);
  while (element && element.parentElement && element.parentElement !== root) element = element.parentElement;
  return element && element.parentElement === root ? element : null;
}

/** Draws Edit-mode marks into `overlay` (pointer-transparent; wedges take hover for their preview). */
export function drawMarks(editor: LexicalEditor, overlay: HTMLElement, marks: Mark[]): void {
  overlay.replaceChildren();
  const host = overlay.getBoundingClientRect();
  const gutters = new Set<HTMLElement>();
  for (const mark of marks) {
    const rect = rectOf(editor, mark);
    if (!rect) continue;
    const block = blockElement(editor, mark.place.key);
    if (mark.kind === 'attribute') {
      const dot = document.createElement('span');
      dot.setAttribute(SUGGEST_MARK_ATTR, 'attribute');
      dot.className = 'moss-suggest-dot';
      dot.style.left = `${rect.left - host.left - 14}px`;
      dot.style.top = `${rect.top - host.top + 6}px`;
      overlay.appendChild(dot);
      continue;
    }
    const wedge = document.createElement('span');
    wedge.setAttribute(SUGGEST_MARK_ATTR, 'insert');
    wedge.className = 'moss-suggest-wedge';
    wedge.dataset.suggestionId = mark.record;
    wedge.setAttribute('aria-label', `Suggested insert: ${mark.text.trim()}`);
    wedge.style.left = `${(mark.after ? rect.right : rect.left) - host.left - 4}px`;
    wedge.style.top = `${rect.bottom - host.top - 2}px`;
    const preview = document.createElement('span');
    preview.setAttribute(OVERLAY_SURFACE_ATTR, '');
    preview.dataset.suggestPreview = '';
    preview.className = 'moss-suggest-preview';
    preview.textContent = mark.text.trim() || '(new block)';
    wedge.appendChild(preview);
    overlay.appendChild(wedge);
    if (block && !gutters.has(block)) {
      gutters.add(block);
      const box = block.getBoundingClientRect();
      const bar = document.createElement('span');
      bar.setAttribute(SUGGEST_MARK_ATTR, 'gutter');
      bar.className = 'moss-suggest-gutter';
      bar.style.left = `${box.left - host.left - 10}px`;
      bar.style.top = `${box.top - host.top}px`;
      bar.style.height = `${box.height}px`;
      overlay.appendChild(bar);
    }
  }
}
