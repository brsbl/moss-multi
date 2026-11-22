// Suggestion paint (docs/design/suggestions.md §7): derived, never written to the tree (L§4.12). Inserts paint
// `::highlight(suggest-insert)` and delete targets `::highlight(suggest-delete)` in F (Suggest) and C (Review). In
// Edit mode, on B, each run of record items in C gets a wedge at its left body neighbour, a gutter bar beside its
// block and a hover preview of its text; delete targets paint struck; a block a record restyles gets a dot.
import type { Binding } from '@lexical/yjs';
import { attrsOf, BODY_DOC, canonical, readsAsBody, regRefs, restoredCopies, yValue } from '@moss-multi/core/suggest/apply';
import { SUGGEST_MARK_ATTR, OVERLAY_SURFACE_ATTR } from '@moss-multi/protocol/dom-contract';
import type { IdSpan } from '@moss-multi/protocol/suggest';
import { payloadMap, payloadText } from '@moss-multi/sync/payload-docs';
import { openRecords, payloadIdsOf, SpanSet, type Built, type SuggestFork } from '@moss-multi/sync/suggest/client';
import type { LexicalEditor } from 'lexical';
import * as Y from 'yjs';
import { charIndex, idKey, isPending, rangesWhere, type CharPlace } from './chars.ts';

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

/**
 * Paint for an editor bound to F or C: items of `own` clients that B lacks as inserts (an accepted record's text is
 * body text, though a continuation writes on under its lease), `struck` spans as deletes. Pass the fork's cached
 * `strikes()` where there is one; an array is indexed once per call.
 */
export function paintBound(owner: object, editor: LexicalEditor, binding: Binding, own: ReadonlySet<number>, struck: readonly IdSpan[] | SpanSet, body?: Y.Doc | null): void {
  const pending = pendingInserts(binding.doc, own, body);
  const insert = own.size ? rangesWhere(editor, binding, pending) : [];
  const strikes = struck instanceof SpanSet ? struck : new SpanSet(struck);
  const strike = strikes.empty ? [] : rangesWhere(editor, binding, (id) => strikes.has(id));
  paintRanges(owner, insert, strike);
}

/**
 * Which items of `doc` (F or C) paint as pending inserts: items of `own` clients that B lacks, outside any block that
 * reads as it does in B, and not copies restoring B's text (a split and its undo leave the split rest as copies:
 * nothing a reader sees, nothing painted, whatever is typed beside them).
 */
export function pendingInserts(doc: Y.Doc, own: ReadonlySet<number>, body?: Y.Doc | null): (id: Y.ID) => boolean {
  const unchanged = body ? readsAsBody(doc, body) : () => false;
  const { copies } = body ? restoredCopies(doc, body) : { copies: new Map<string, Y.ID>() };
  return (id) => isPending(id, own, body) && !copies.has(idKey(id)) && !unchanged(id);
}

/** Every valid open record's delete targets. */
export function partTargets(body: Y.Doc, valid: ReadonlySet<string>): IdSpan[] {
  return [...struckByRecord(body, valid).values()].flat();
}

/**
 * Each valid open record's struck body items: its delete parts' targets and, with `built`, the body items its own ops
 * delete (a join, a split, a restyle rewrite their original text), less the items of any record's leased clients.
 */
export function struckByRecord(body: Y.Doc, valid: ReadonlySet<string>, built?: Built): Map<string, IdSpan[]> {
  const out = new Map<string, IdSpan[]>();
  const unchanged = built ? readsAsBody(built.doc, body) : null;
  const restored = built ? restoredCopies(built.doc, body).originals : null;
  for (const record of openRecords(body)) {
    if (!valid.has(record.meta.id)) continue;
    const spans: IdSpan[] = record.parts.flatMap((part) => part.targets);
    for (const op of built ? record.ops : []) {
      if (op.doc !== BODY_DOC) continue;
      let ds: ReturnType<typeof Y.decodeUpdate>['ds'];
      try {
        ds = Y.decodeUpdate(op.update).ds;
      } catch {
        continue;
      }
      for (const [client, ranges] of ds.clients) {
        if (built!.clients.has(client)) continue;
        for (const { clock, len } of ranges) spans.push(...outsideUnchanged(built!.doc, client, clock, len, unchanged!, restored!));
      }
    }
    if (spans.length) out.set(record.meta.id, spans);
  }
  return out;
}

/**
 * The parts of a removed span whose items sit outside blocks that read as they do in B (`readsAsBody`) and that no
 * copy restores (`restored`, restoredCopies).
 */
function outsideUnchanged(doc: Y.Doc, client: number, clock: number, len: number, unchanged: (id: Y.ID) => boolean, restored: ReadonlySet<string>): IdSpan[] {
  const structs = doc.store.clients.get(client);
  const end = clock + len;
  if (!structs || clock >= Y.getState(doc.store, client)) return [{ client, clock, len }];
  const out: IdSpan[] = [];
  const add = (from: number, to: number) => {
    const last = out.at(-1);
    if (last && last.clock + last.len === from) last.len += to - from;
    else out.push({ client, clock: from, len: to - from });
  };
  for (let i = Y.findIndexSS(structs, clock); i < structs.length && structs[i]!.id.clock < end; i++) {
    const struct = structs[i]!;
    if (struct instanceof Y.Item && unchanged(struct.id)) continue;
    const from = Math.max(clock, struct.id.clock);
    const to = Math.min(end, struct.id.clock + struct.length);
    if (!restored.size) {
      add(from, to);
      continue;
    }
    for (let at = from; at < to; at += 1) if (!restored.has(`${client}:${at}`)) add(at, at + 1);
  }
  return out;
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

/**
 * A payload as C's records leave it: its text, or a compound payload's fields as stable JSON, read from the map's own
 * entries (a `__proto__` key stays a field) with what JSON cannot hold (a BigInt) tagged, never thrown.
 */
function payloadPreview(doc: Y.Doc | undefined): string {
  if (!doc) return '';
  const map = payloadMap(doc);
  return map.size ? canonical(Object.fromEntries([...map.entries()].map(([key, value]) => [key, yValue(value)]))) : payloadText(doc).toString();
}

/** The marks Edit mode paints for C's records over B's binding. */
export function editMarks(body: Y.Doc, built: Built, binding: Binding): Mark[] {
  const index = charIndex(binding);
  const marks = new Map<string, Mark>();
  // Original payloads a record edits (a proposal applied only at accept): their decorators in B get a mark previewing
  // the payload in C.
  const refs = regRefs(body);
  const payloads = new Map<string, string>();
  const valid = new Set(built.valid);
  for (const record of openRecords(body)) {
    if (!valid.has(record.meta.id)) continue;
    for (const id of payloadIdsOf(record)) if (refs.has(id) && !payloads.has(id)) payloads.set(id, record.meta.id);
  }
  const unchanged = readsAsBody(built.doc, body);
  // Copies restoring B's text (the rest of an undone split) read as that text: no mark, and a mark after one sits
  // after the character it restores.
  const { copies } = restoredCopies(built.doc, body);
  const lastOf = (item: Y.Item) => Y.createID(item.id.client, item.id.clock + item.length - 1);
  const mark = (record: string, text: string, anchor: Y.ID | undefined, after: boolean) => {
    const place = anchor && index.get(idKey(anchor));
    if (!place) return;
    const key = `${place.key}:${place.offset}:${record}`;
    const held = marks.get(key);
    if (held) held.text += text;
    else marks.set(key, { kind: 'insert', place, after: after && place.offset >= 0, text, record });
  };
  for (const [client, record] of built.clients) {
    for (const struct of built.doc.store.clients.get(client) ?? []) {
      if (!(struct instanceof Y.Item) || struct.deleted || struct.parentSub !== null || unchanged(struct.id)) continue;
      const content = struct.content;
      // A text node's property map marks no text of its own.
      if (content instanceof Y.ContentType && content.type instanceof Y.Map) continue;
      if (copies.has(idKey(struct.id)) && !(content instanceof Y.ContentString)) continue;
      let text: string;
      if (content instanceof Y.ContentString) text = content.str;
      else if (content instanceof Y.ContentType) text = content.type instanceof Y.XmlText ? `\n${plain(content.type as Y.AbstractType<unknown>)}` : '';
      else continue;
      let left = struct.left;
      let restoredLeft: Y.ID | undefined;
      while (left && (left.deleted || built.clients.has(left.id.client))) {
        restoredLeft = !left.deleted ? copies.get(idKey(lastOf(left))) : undefined;
        if (restoredLeft) break;
        left = left.left;
      }
      const anchor = restoredLeft ?? (left ? lastOf(left) : (struct.parent as Y.AbstractType<unknown>)._item?.id);
      const after = !!left && left.content instanceof Y.ContentString;
      if (!(content instanceof Y.ContentString) || !copies.size) {
        mark(record, text, anchor, after);
        continue;
      }
      // A run partly restored: each stretch of its own characters marks after the character before it.
      let from = -1;
      for (let i = 0; i <= text.length; i += 1) {
        const was = i < text.length ? copies.get(`${struct.id.client}:${struct.id.clock + i}`) : undefined;
        if (i < text.length && !was) {
          if (from < 0) from = i;
          continue;
        }
        if (from >= 0) {
          const before = from === 0 ? anchor : copies.get(`${struct.id.client}:${struct.id.clock + from - 1}`);
          mark(record, text.slice(from, i), before, from === 0 ? after : true);
          from = -1;
        }
      }
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
      // Read from each map's live entries, as stable JSON: a BigInt or a `__proto__` key compares like any value.
      if (!was || canonical(attrsOf(was)) === canonical(attrsOf(insert))) continue;
      const place = index.get(idKey(id));
      // The record whose leased client wrote one of the changed attributes.
      let record = '';
      for (const item of insert._map.values()) {
        const by = !item.deleted ? built.clients.get(item.id.client) : undefined;
        if (by) {
          record = by;
          break;
        }
      }
      if (place) marks.set(`attr:${place.key}`, { kind: 'attribute', place, after: false, text: '', record });
    }
  };
  visit(built.doc.get('root', Y.XmlText));
  for (const [id, record] of payloads) {
    for (const type of refs.get(id) ?? []) {
      const place = type._item && index.get(idKey(type._item.id));
      if (place) marks.set(`reg:${place.key}`, { kind: 'insert', place, after: false, text: payloadPreview(built.payloads.get(id)), record });
    }
  }
  return [...marks.values()];
}

/** Where a mark sits, relative to `host`. */
function rectOf(editor: LexicalEditor, mark: Mark): DOMRect | null {
  return rectAt(editor, mark.place, mark.after);
}

/** The collapsed rect at a character of the editor (after it with `after`), or its element's. */
function rectAt(editor: LexicalEditor, place: CharPlace, after: boolean): DOMRect | null {
  const element = editor.getElementByKey(place.key);
  if (!element) return null;
  if (place.offset < 0) return element.getBoundingClientRect();
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  const text = walker.nextNode() as Text | null;
  if (!text) return element.getBoundingClientRect();
  const range = document.createRange();
  const offset = Math.min(place.offset + (after ? 1 : 0), text.data.length);
  range.setStart(text, offset);
  range.setEnd(text, offset);
  // jsdom lays nothing out and has no range rects.
  if (typeof range.getClientRects !== 'function') return element.getBoundingClientRect();
  return range.getClientRects()[0] ?? range.getBoundingClientRect();
}

/** The top-level block element holding a key's DOM. */
function blockElement(editor: LexicalEditor, key: string): HTMLElement | null {
  const root = editor.getRootElement();
  let element = editor.getElementByKey(key);
  while (element && element.parentElement && element.parentElement !== root) element = element.parentElement;
  return element && element.parentElement === root ? element : null;
}

/** The gap a preview keeps from the viewport's edges. */
const PREVIEW_MARGIN = 8;

/** Shows a wedge's preview, shifted along the line so all of it is inside the viewport. */
function openPreview(wedge: HTMLElement, preview: HTMLElement): void {
  wedge.dataset.open = '';
  preview.style.left = '';
  const box = preview.getBoundingClientRect();
  const viewport = document.documentElement.clientWidth;
  let shift = 0;
  if (box.right > viewport - PREVIEW_MARGIN) shift = viewport - PREVIEW_MARGIN - box.right;
  if (box.left + shift < PREVIEW_MARGIN) shift = PREVIEW_MARGIN - box.left;
  if (shift !== 0) preview.style.left = `${parseFloat(getComputedStyle(preview).left) + shift}px`;
}

/** Draws Edit-mode marks into `overlay` (pointer-transparent; wedges and gutter bars take hover and a click). */
export function drawMarks(editor: LexicalEditor, overlay: HTMLElement, marks: Mark[], onOpen?: (record: string) => void): void {
  // A repaint (an edit, a resize) replaces the wedges; the one whose preview is open stays open.
  const open = overlay.querySelector<HTMLElement>('.moss-suggest-wedge[data-open]')?.dataset.markKey;
  overlay.replaceChildren();
  const host = overlay.getBoundingClientRect();
  const gutters = new Set<HTMLElement>();
  const reopen: [HTMLElement, HTMLElement][] = [];
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
      if (mark.record) {
        dot.dataset.suggestionId = mark.record;
        dot.setAttribute('aria-label', 'Suggested change to this block');
        if (onOpen) dot.addEventListener('click', () => onOpen(mark.record));
      }
      overlay.appendChild(dot);
      continue;
    }
    const wedge = document.createElement('span');
    wedge.setAttribute(SUGGEST_MARK_ATTR, 'insert');
    wedge.className = 'moss-suggest-wedge';
    wedge.dataset.suggestionId = mark.record;
    wedge.dataset.markKey = `${mark.place.key}:${mark.place.offset}:${mark.record}`;
    wedge.setAttribute('aria-label', `Suggested insert: ${mark.text.trim()}`);
    wedge.style.left = `${(mark.after ? rect.right : rect.left) - host.left - 4}px`;
    wedge.style.top = `${rect.bottom - host.top - 2}px`;
    if (onOpen && mark.record) wedge.addEventListener('click', () => onOpen(mark.record));
    const preview = document.createElement('span');
    preview.setAttribute(OVERLAY_SURFACE_ATTR, '');
    preview.dataset.suggestPreview = '';
    preview.className = 'moss-suggest-preview';
    preview.textContent = mark.text.trim() || '(new block)';
    wedge.appendChild(preview);
    if (open !== undefined && wedge.dataset.markKey === open) reopen.push([wedge, preview]);
    wedge.addEventListener('pointerenter', () => openPreview(wedge, preview));
    wedge.addEventListener('pointerleave', () => {
      delete wedge.dataset.open;
      preview.style.left = '';
    });
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
      if (mark.record) bar.dataset.suggestionId = mark.record;
      if (onOpen && mark.record) bar.addEventListener('click', () => onOpen(mark.record));
      overlay.appendChild(bar);
    }
  }
  for (const [wedge, preview] of reopen) {
    openPreview(wedge, preview);
    // The pointer never entered the new wedge, so no pointerleave closes it: the next move off it and its preview
    // does (by position: the move a layout change makes may name another target).
    const off = (event: PointerEvent) => {
      const over = (element: Element) => {
        const box = element.getBoundingClientRect();
        return event.clientX >= box.left && event.clientX <= box.right && event.clientY >= box.top && event.clientY <= box.bottom;
      };
      if (wedge.isConnected && (over(wedge) || over(preview))) return;
      document.removeEventListener('pointermove', off, true);
      delete wedge.dataset.open;
      preview.style.left = '';
    };
    document.addEventListener('pointermove', off, true);
  }
}

/** A struck original F no longer holds, shown struck where it stood (presentation only, never in the tree or a record). */
export interface Ghost {
  text: string;
  place: CharPlace;
  /** After the character at `place` rather than at it. */
  after: boolean;
}

function itemIn(doc: Y.Doc, id: Y.ID): Y.Item | null {
  if (id.clock >= Y.getState(doc.store, id.client)) return null;
  const struct = Y.getItem(doc.store, id);
  return struct instanceof Y.Item ? struct : null;
}

/** The live unit standing for `id` now: itself, or what undo or redo restored it as. */
function liveUnit(doc: Y.Doc, id: Y.ID): { item: Y.Item; id: Y.ID } | null {
  let at = id;
  for (let guard = 0; guard < 1_000; guard += 1) {
    const item = itemIn(doc, at);
    if (!item) return null;
    if (!item.deleted) return { item, id: at };
    if (!item.redone) return null;
    at = Y.createID(item.redone.client, item.redone.clock + at.clock - item.id.clock);
  }
  return null;
}

/**
 * Where a removed item of F stood, by the binding: after the live character before it (other struck text it removed
 * skipped, text undo or redo restored followed), or at the start of the text node whose map is before it. Undefined
 * when the unit before it is gone for good (the text around it moved on), unless `lenient`: then older tombstones are
 * passed over too, to the nearest live unit in its block.
 */
function placeOf(doc: Y.Doc, id: Y.ID, gone: ReadonlySet<string>, index: Map<string, CharPlace>, lenient: boolean): Omit<Ghost, 'text'> | undefined {
  let item = itemIn(doc, id);
  if (!item) return undefined;
  let offset = id.clock - item.id.clock - 1;
  for (let guard = 0; guard < 100_000; guard += 1) {
    if (offset < 0) {
      item = item.left;
      if (!item) return undefined;
      offset = item.length - 1;
      continue;
    }
    // Formatting marks hold no place; a collected tombstone (ContentDeleted) keeps its length.
    if (item.content instanceof Y.ContentFormat) {
      offset = -1;
      continue;
    }
    const unit = Y.createID(item.id.client, item.id.clock + offset);
    const live = item.deleted && gone.has(idKey(unit)) ? null : liveUnit(doc, unit);
    if (!live) {
      if (item.deleted && (lenient || gone.has(idKey(unit)))) {
        offset -= 1;
        continue;
      }
      return undefined;
    }
    const place = index.get(idKey(live.id));
    if (!place) return undefined;
    const { content } = live.item;
    if (content instanceof Y.ContentString) return { place, after: true };
    return content instanceof Y.ContentType && content.type instanceof Y.Map && place.offset === 0 ? { place, after: false } : undefined;
  }
  return undefined;
}

/** The struck text a rewrite removed from F (`removedStrikes`), each run placed where it stood in the editor. */
export function ghostsOf(fork: Pick<SuggestFork, 'doc' | 'body' | 'removedStrikes'>, binding: Binding): Ghost[] {
  const removed = fork.removedStrikes();
  if (removed.length === 0) return [];
  const index = charIndex(binding);
  const gone = new Set(removed.flatMap(({ stood }) => stood.map(idKey)));
  const out = new Map<string, Ghost>();
  for (const { original, stood } of removed) {
    const source = itemIn(fork.body, original);
    if (!(source?.content instanceof Y.ContentString)) continue;
    const text = source.content.str[original.clock - source.id.clock] ?? '';
    // Its latest copy that still has text beside it, else where the original stood.
    let at: Omit<Ghost, 'text'> | undefined;
    for (const id of stood) if ((at = placeOf(fork.doc, id, gone, index, false))) break;
    at ??= placeOf(fork.doc, stood.at(-1) ?? original, gone, index, true);
    if (!at) continue;
    const key = `${at.place.key}:${at.place.offset}:${at.after}`;
    const held = out.get(key);
    if (held) held.text += text;
    else out.set(key, { text, ...at });
  }
  return [...out.values()];
}

/** Draws `ghosts` into `overlay` (pointer-transparent), struck, each at the gap where its text stood. */
export function drawGhosts(editor: LexicalEditor, overlay: HTMLElement, ghosts: readonly Ghost[]): void {
  for (const old of overlay.querySelectorAll('[data-suggest-ghost]')) old.remove();
  const host = overlay.getBoundingClientRect();
  for (const ghost of ghosts) {
    const element = document.createElement('span');
    element.dataset.suggestGhost = '';
    element.className = 'moss-suggest-ghost';
    element.setAttribute('aria-hidden', 'true');
    element.textContent = ghost.text;
    const rect = rectAt(editor, ghost.place, ghost.after);
    if (rect) {
      element.style.left = `${rect.left - host.left}px`;
      element.style.top = `${rect.top - host.top}px`;
      element.style.setProperty('--ghost-line', `${rect.height}px`);
    }
    overlay.appendChild(element);
  }
}
