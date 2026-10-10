// The DocDO's comments (docs/design/comments.md §3, §4, §13; A§13): the reserved writer R persisted in meta, gate 2b,
// the frame engine's changes flushed through writeComments in the same turn, the create RPC, and marker import.
// Every write to Y.Map('comments') goes through #writer.
import * as encoding from 'lib0/encoding';
import * as Y from 'yjs';
import { AnchorEngine, mintAnchor, MAX_QUOTE, OVERLAP_CAP, type Anchor, type Unit } from '@moss-multi/core/anchor-frame';
import { idKey, maxCoverage, ordinalsOf, unitsAt, unitText } from '@moss-multi/core/comment-units';
import { decodeRelPos, encodeRelPos, findQuote, positionAt, project, type TextQuote } from '@moss-multi/core/tree-anchor';
import { CommentsWriter, ENGINE_SKIPPED_ORIGINS, newCommentsClient, type GuardRefusal } from './comments-guard.ts';
import type { DocStore } from './persistence.ts';
import type { ImportedMarks } from '../server-doc.ts';
import { COMMENT_TEXT_MAX } from '@moss-multi/protocol/limits';

/** A comment's text, in characters (413 past it). */
export { COMMENT_TEXT_MAX };

export const COMMENTS_CLIENT_META = 'commentsClient';
/** Comment and reply records per doc. */
export const COMMENTS_PER_DOC = 2_000;
/** Quote-only searches one sidecar import runs; later position-less entries are dropped. */
export const MAX_IMPORT_SEARCHES = 100;
/**
 * The share of the state cap comment writes may fill. The rest is the typing headroom STATE_CAP_BYTES builds in, so
 * comments, which copy their quote, never leave a doc too full to edit.
 */
export const COMMENT_STATE_SHARE = 0.8;
/** Distinct reaction emoji on one comment (comments.md §12). */
export const REACTIONS_PER_COMMENT = 20;
/** Moss's marker ids: what `%%m:<id>:start%%` can carry. */
const ID = /^[A-Za-z0-9_-]{1,64}$/;

/** An item's header in an update, past its key and value: info, ids, origins, parent; generous. */
const ITEM_OVERHEAD = 48;

/** What one `comments` entry adds to the encoded state: its key and value as Yjs encodes them, plus an item header. */
export function entryBytes(key: string, value: unknown): number {
  const encoder = encoding.createEncoder();
  encoding.writeVarString(encoder, key);
  encoding.writeAny(encoder, value as Parameters<typeof encoding.writeAny>[1]);
  return encoding.length(encoder) + ITEM_OVERHEAD;
}

export type CommentSource = 'user' | 'agent' | 'external';

/** The `c:<id>` record (A§13). Times are seconds, as moss expects. */
export interface CommentRecord {
  author: string;
  text: string;
  createdAt: number;
  updatedAt: number;
  /** The DocDO's write order: above every record's when written, so it orders records within one second. */
  seq?: number;
  source: CommentSource;
  parentId?: string;
  resolvedAt?: number;
  resolvedBy?: CommentSource;
  reactions: Record<string, string[]>;
}

export interface CommentCreate {
  /** The server principal; never read from the request body. */
  author: string;
  source?: CommentSource;
  id: string;
  text: string;
  parentId?: string;
  anchor?: { kind?: Anchor['kind']; start?: string; end?: string; quote?: string | TextQuote };
}

/** A thread delete removes the root and every reply; a comment delete removes one message (comments.md §12). */
export type CommentDeleteScope = 'comment' | 'thread';

export type CommentResult =
  | {
      ok: true;
      id: string;
      quote: string | null;
      /** A reply's thread author, for the Worker's reply notification. */
      rootAuthor?: string;
      /** The reply a root delete promoted to root. */
      promoted?: string;
    }
  | { ok: false; status: 400 | 401 | 403 | 404 | 409 | 413 | 503; error: string };

const refuse = (status: 400 | 403 | 404 | 409 | 413, error: string): CommentResult => ({ ok: false, status, error });
const nowSeconds = () => Math.floor(Date.now() / 1000);
const isSource = (value: unknown): value is CommentSource => value === 'user' || value === 'agent' || value === 'external';

export class DocComments {
  #writer: CommentsWriter;
  #engine: AnchorEngine;
  #pending = new Map<string, Anchor>();
  #seq = 0;

  constructor(
    readonly doc: Y.Doc,
    private readonly store: DocStore,
  ) {
    const stored = Number(store.meta(COMMENTS_CLIENT_META));
    let r = stored;
    if (!Number.isInteger(stored) || stored <= 0 || stored > 0xffffffff) {
      r = newCommentsClient(doc);
      store.setMeta(COMMENTS_CLIENT_META, String(r));
    }
    this.#writer = this.#writerFor(r);
    this.#engine = this.#load();
    for (const [key, value] of doc.getMap<unknown>('comments')) if (key.startsWith('c:')) this.#seq = Math.max(this.#seq, seqOf(value));
    doc.on('afterTransaction', (txn: Y.Transaction) => {
      if (ENGINE_SKIPPED_ORIGINS.has(txn.origin)) return;
      try {
        for (const [id, anchor] of this.#engine.frame(txn)) this.#pending.set(id, anchor);
      } catch (error) {
        // The frame has applied; a forged shape the engine cannot read must not stop it persisting.
        console.error('comment anchor engine failed on a frame', error);
      }
    });
  }

  get client(): number {
    return this.#writer.client;
  }

  /** Gate 2b (comments.md §3): null admits the frame. */
  check(decoded: ReturnType<typeof Y.decodeUpdate>): GuardRefusal | null {
    return this.#writer.checkDecoded(decoded);
  }

  /** Writes the anchor changes collected since the last flush, in the caller's turn (I8). */
  flush(): void {
    if (!this.#pending.size) return;
    const changes = [...this.#pending];
    this.#pending.clear();
    this.#writer.write((comments) => {
      for (const [id, anchor] of changes) if (comments.has(`a:${id}`)) comments.set(`a:${id}`, anchor);
    });
    for (const [id, anchor] of changes) this.#engine.set(id, anchor);
  }

  /**
   * The create RPC (comments.md §4): a reply, a positioned root, or a quote-only root searched once. `room` is the
   * encoded bytes comment writes may still add; the record and anchor, quote included, must fit (413 doc-cap).
   */
  create(input: CommentCreate, maxRecords = COMMENTS_PER_DOC, room = Number.POSITIVE_INFINITY): CommentResult {
    if (!ID.test(input.id)) return refuse(400, 'bad-id');
    if (typeof input.text !== 'string' || !input.text.trim()) return refuse(400, 'bad-text');
    if (input.text.length > COMMENT_TEXT_MAX) return refuse(413, 'text-too-long');
    const comments = this.doc.getMap<unknown>('comments');
    if (comments.has(`c:${input.id}`) || comments.has(`a:${input.id}`)) return refuse(409, 'exists');
    if (this.#count() >= maxRecords) return refuse(409, 'comment-cap');
    const now = nowSeconds();
    const record: CommentRecord = {
      author: input.author,
      text: input.text,
      createdAt: now,
      updatedAt: now,
      source: isSource(input.source) ? input.source : 'user',
      reactions: {},
      seq: this.#seq + 1,
    };
    if (input.parentId !== undefined) {
      const parent = comments.get(`c:${input.parentId}`) as CommentRecord | undefined;
      if (!parent || parent.parentId !== undefined) return refuse(409, 'parent-missing');
      const reply = { ...record, parentId: input.parentId };
      if (entryBytes(`c:${input.id}`, reply) > room) return refuse(413, 'doc-cap');
      this.#writer.write((map) => map.set(`c:${input.id}`, reply));
      this.#seq += 1;
      return { ok: true, id: input.id, quote: null, rootAuthor: parent.author };
    }
    const placed = this.#place(input.anchor);
    if ('error' in placed) return placed.error;
    const anchor = placed.anchor;
    if (entryBytes(`c:${input.id}`, record) + entryBytes(`a:${input.id}`, anchor) > room) return refuse(413, 'doc-cap');
    this.#writer.write((map) => {
      map.set(`c:${input.id}`, record);
      map.set(`a:${input.id}`, anchor);
    });
    this.#seq += 1;
    this.#engine.set(input.id, anchor);
    return { ok: true, id: input.id, quote: anchor.quote };
  }

  /**
   * Resolves or reopens a thread (comments.md §12): the root carries the state, as moss reads it. Only the `c:` record
   * is rewritten, so a resolve costs one record whatever the thread's length.
   */
  resolve(id: string, resolved: boolean, by: CommentSource): CommentResult {
    if (!ID.test(id)) return refuse(400, 'bad-id');
    const record = this.doc.getMap<unknown>('comments').get(`c:${id}`) as CommentRecord | undefined;
    if (!record) return refuse(404, 'comment-missing');
    if (record.parentId !== undefined) return refuse(409, 'not-a-thread');
    if ((record.resolvedAt !== undefined) === resolved) return { ok: true, id, quote: null };
    const next: CommentRecord = { ...record };
    delete next.resolvedAt;
    delete next.resolvedBy;
    if (resolved) Object.assign(next, { resolvedAt: nowSeconds(), resolvedBy: by });
    this.#writer.write((map) => map.set(`c:${id}`, next));
    return { ok: true, id, quote: null };
  }

  /** Rewrites a comment's text; only its author may (comments.md §12). */
  edit(id: string, actor: string, text: string, room = Number.POSITIVE_INFINITY): CommentResult {
    if (!ID.test(id)) return refuse(400, 'bad-id');
    if (typeof text !== 'string' || !text.trim()) return refuse(400, 'bad-text');
    if (text.length > COMMENT_TEXT_MAX) return refuse(413, 'text-too-long');
    const record = this.#record(id);
    if (!record) return refuse(404, 'comment-missing');
    if (record.author !== actor) return refuse(403, 'not-author');
    if (record.text === text) return { ok: true, id, quote: null };
    const next: CommentRecord = { ...record, text, updatedAt: nowSeconds() };
    if (entryBytes(`c:${id}`, next) - entryBytes(`c:${id}`, record) > room) return refuse(413, 'doc-cap');
    this.#writer.write((map) => map.set(`c:${id}`, next));
    return { ok: true, id, quote: null };
  }

  /**
   * Deletes a comment as its author (comments.md §12). A thread delete is the root author's and removes every reply.
   * Deleting a root that has replies promotes the oldest reply in the same write: it takes the root's anchor (re-keyed
   * to its id) and resolution, loses its parentId, and the other replies are re-parented to it.
   */
  remove(id: string, actor: string, scope: CommentDeleteScope): CommentResult {
    if (!ID.test(id)) return refuse(400, 'bad-id');
    const comments = this.doc.getMap<unknown>('comments');
    const record = this.#record(id);
    if (!record) return refuse(404, 'comment-missing');
    if (record.author !== actor) return refuse(403, 'not-author');
    if (record.parentId !== undefined) {
      if (scope === 'thread') return refuse(409, 'not-a-thread');
      this.#writer.write((map) => map.delete(`c:${id}`));
      return { ok: true, id, quote: null };
    }
    const replies: [string, CommentRecord][] = [];
    for (const [key, value] of comments) {
      if (key.startsWith('c:') && (value as CommentRecord | undefined)?.parentId === id) replies.push([key.slice(2), value as CommentRecord]);
    }
    replies.sort(([a, x], [b, y]) => x.createdAt - y.createdAt || seqOf(x) - seqOf(y) || (a < b ? -1 : a > b ? 1 : 0));
    const anchor = comments.get(`a:${id}`) as Anchor | undefined;
    const promoted = scope === 'comment' ? replies[0] : undefined;
    this.#writer.write((map) => {
      map.delete(`c:${id}`);
      map.delete(`a:${id}`);
      if (!promoted) {
        for (const [replyId] of replies) map.delete(`c:${replyId}`);
        return;
      }
      const [newId, reply] = promoted;
      const root: CommentRecord = { ...reply };
      delete root.parentId;
      delete root.resolvedAt;
      delete root.resolvedBy;
      if (record.resolvedAt !== undefined) root.resolvedAt = record.resolvedAt;
      if (record.resolvedBy !== undefined) root.resolvedBy = record.resolvedBy;
      map.set(`c:${newId}`, root);
      if (anchor) map.set(`a:${newId}`, anchor);
      for (const [replyId, other] of replies.slice(1)) map.set(`c:${replyId}`, { ...other, parentId: newId });
    });
    this.#engine.set(id, undefined);
    if (promoted && anchor) this.#engine.set(promoted[0], anchor);
    return { ok: true, id, quote: null, ...(promoted ? { promoted: promoted[0] } : {}) };
  }

  /** Adds or removes `actor`'s reaction `emoji` (one emoji grapheme) on a comment; at most 20 distinct per comment. */
  react(id: string, actor: string, emoji: string, on: boolean, room = Number.POSITIVE_INFINITY): CommentResult {
    if (!ID.test(id)) return refuse(400, 'bad-id');
    if (!isEmoji(emoji)) return refuse(400, 'bad-emoji');
    const record = this.#record(id);
    if (!record) return refuse(404, 'comment-missing');
    const reactions = coerceReactions(record.reactions);
    const who = reactions[emoji] ?? [];
    if (who.includes(actor) === on) return { ok: true, id, quote: null };
    if (on) {
      if (!reactions[emoji] && Object.keys(reactions).length >= REACTIONS_PER_COMMENT) return refuse(409, 'too-many-reactions');
      reactions[emoji] = [...who, actor];
    } else {
      const rest = who.filter((principal) => principal !== actor);
      if (rest.length) reactions[emoji] = rest;
      else delete reactions[emoji];
    }
    const next: CommentRecord = { ...record, reactions };
    if (on && entryBytes(`c:${id}`, next) - entryBytes(`c:${id}`, record) > room) return refuse(413, 'doc-cap');
    this.#writer.write((map) => map.set(`c:${id}`, next));
    return { ok: true, id, quote: null };
  }

  #record(id: string): CommentRecord | undefined {
    const value = this.doc.getMap<unknown>('comments').get(`c:${id}`);
    return value && typeof value === 'object' ? (value as CommentRecord) : undefined;
  }

  /**
   * Marker import (comments.md §13), right after the import's tree diff in the same turn: each sidecar root whose
   * markers were found gets one anchor from its first marker to its last, a root without markers but with a `quote`
   * gets one search, and replies follow only an anchored root, as moss prunes them.
   *
   * Cost is bounded per import, not per entry: one projection, at most MAX_IMPORT_SEARCHES searches, one ordinal
   * walk and one unit walk. Records are admitted earliest first while their bytes, quotes included, fit `room`.
   */
  importSidecar(sidecar: Record<string, unknown>, marks: ImportedMarks, author: string, maxRecords = COMMENTS_PER_DOC, room = Number.POSITIVE_INFINITY): void {
    const entries = coerceSidecar(sidecar);
    const aligned = marks.ranges.size > 0 && unitText(this.doc) === marks.text;
    if (marks.ranges.size > 0 && !aligned) console.error('comment import: the imported tree does not match the live units; markers dropped');
    const byTime = [...entries].sort((a, b) => a[1].createdAt - b[1].createdAt);
    const spans = new Map<string, { first: number; last: number; block: boolean }>();
    const quoted: [string, Y.ID, Y.ID][] = [];
    let projection: ReturnType<typeof project> | null = null;
    let searches = 0;
    for (const [id, entry] of byTime) {
      if (entry.parentId !== undefined) continue;
      const range = marks.ranges.get(id);
      if (range) {
        if (aligned) spans.set(id, { first: range.first, last: range.last, block: Boolean(range.block) && range.first === range.last });
        continue;
      }
      if (!entry.quote || searches >= MAX_IMPORT_SEARCHES) continue;
      searches += 1;
      projection ??= project(this.doc);
      const found = findQuote(projection.text, { exact: entry.quote, prefix: '', suffix: '' });
      if (!found.range) continue;
      const s = positionAt(projection, found.range.start, 0)?.item;
      const e = positionAt(projection, found.range.end, -1)?.item;
      if (s && e) quoted.push([id, s, e]);
    }
    if (quoted.length) {
      const ordinals = ordinalsOf(this.doc, quoted.flatMap(([, s, e]) => [s, e]));
      for (const [id, s, e] of quoted) {
        const first = ordinals.get(idKey(s));
        const last = ordinals.get(idKey(e));
        if (first !== undefined && last !== undefined && first <= last) spans.set(id, { first, last, block: false });
      }
    }
    const units = spans.size ? unitsAt(this.doc, [...spans.values()].flatMap(({ first, last }) => [first, last])) : new Map<number, Unit>();
    const intervals: [number, number][] = [];
    const roots = new Map<string, Anchor>();
    const records = new Map<string, CommentRecord>();
    let left = room;
    // Each record's seq follows sidecar time, counted before its bytes are.
    const seq = new Map(byTime.map(([id], i) => [id, this.#seq + i + 1]));
    for (const [id, entry] of byTime) {
      const span = spans.get(id);
      if (!span || records.size >= maxRecords) continue;
      const first = units.get(span.first);
      const last = units.get(span.last);
      if (!first || !last || span.last - span.first >= MAX_QUOTE || maxCoverage(intervals, span.first, span.last) >= OVERLAP_CAP) continue;
      const anchor = mintAnchor(first, last, span.block ? 'block' : 'text');
      const record = toRecord(entry, author, seq.get(id)!);
      const bytes = entryBytes(`c:${id}`, record) + entryBytes(`a:${id}`, anchor);
      if (bytes > left) continue;
      left -= bytes;
      intervals.push([span.first, span.last]);
      roots.set(id, anchor);
      records.set(id, record);
    }
    for (const [id, entry] of byTime) {
      if (entry.parentId === undefined || !roots.has(entry.parentId) || records.size >= maxRecords) continue;
      const record = { ...toRecord(entry, author, seq.get(id)!), parentId: entry.parentId };
      const bytes = entryBytes(`c:${id}`, record);
      if (bytes > left) continue;
      left -= bytes;
      records.set(id, record);
    }
    if (!records.size) return;
    this.#seq += byTime.length;
    this.#writer.write((map) => {
      for (const [id, record] of records) map.set(`c:${id}`, record);
      for (const [id, anchor] of roots) map.set(`a:${id}`, anchor);
    });
    for (const [id, anchor] of roots) this.#engine.set(id, anchor);
  }

  /**
   * A duplicate's snapshot carries the source's records under the source's R. The copy adopts that R, so the copied
   * items stay R's (I1), then deletes every record: comments stay with the source, as moss's duplicate drops them.
   */
  dropCopied(): void {
    const comments = this.doc.getMap<unknown>('comments');
    const clients = new Set<number>();
    for (const item of comments._map.values()) clients.add(item.id.client);
    clients.delete(this.client);
    const [source] = clients;
    const adoptable = clients.size === 1
      && Y.getState(this.doc.store, this.client) === 0
      && (this.doc.store.clients.get(source) ?? []).every((struct) => !(struct instanceof Y.Item) || rootOf(struct) === comments);
    if (adoptable) {
      this.store.setMeta(COMMENTS_CLIENT_META, String(source));
      this.#writer = this.#writerFor(source);
    } else if (clients.size) {
      // Only R ever writes comments, so a copy whose records are not one R's came from outside that rule.
      console.error('duplicate: comment records not written by one reserved writer');
    }
    const keys = [...comments.keys()];
    if (keys.length) this.#writer.write((map) => {
      for (const key of keys) map.delete(key);
    });
    this.#engine = new AnchorEngine(this.doc);
  }

  /**
   * After a version restore (A§14; comments.md limitation 6): each detached comment the version held anchored is
   * minted again on the restored units at its recorded span, only when they read exactly as they did in the version
   * and stay under OVERLAP_CAP. A server-trusted re-mint from the snapshot, never a search.
   */
  reanchor(spans: Record<string, [first: number, last: number, kind: Anchor['kind'], text: string]>): void {
    const comments = this.doc.getMap<unknown>('comments');
    const wanted = Object.entries(spans).filter(([id, span]) => Array.isArray(span) && comments.has(`c:${id}`)
      && (comments.get(`a:${id}`) as Anchor | undefined)?.status === 'orphaned');
    if (!wanted.length) return;
    const text = unitText(this.doc);
    const anchoredEnds: Y.ID[] = [];
    for (const [key, value] of this.doc.getMap<Anchor>('comments')) {
      if (!key.startsWith('a:') || value?.status !== 'anchored') continue;
      const s = safeItem(value.start);
      const e = safeItem(value.end);
      if (s && e) anchoredEnds.push(s, e);
    }
    const ordinals = ordinalsOf(this.doc, anchoredEnds);
    const intervals: [number, number][] = [];
    for (let i = 0; i < anchoredEnds.length; i += 2) {
      const a = ordinals.get(idKey(anchoredEnds[i]));
      const b = ordinals.get(idKey(anchoredEnds[i + 1]));
      if (a !== undefined && b !== undefined && a <= b) intervals.push([a, b]);
    }
    const fits = wanted.filter(([, [first, last, , quote]]) => Number.isInteger(first) && Number.isInteger(last) && first <= last
      && last - first < MAX_QUOTE && text.slice(first, last + 1) === quote);
    const units = unitsAt(this.doc, fits.flatMap(([, [first, last]]) => [first, last]));
    const minted = new Map<string, Anchor>();
    for (const [id, [first, last, kind]] of fits) {
      const s = units.get(first);
      const e = units.get(last);
      if (!s || !e || maxCoverage(intervals, first, last) >= OVERLAP_CAP) continue;
      if (kind === 'block' && (first !== last || !(s.item.content instanceof Y.ContentType))) continue;
      minted.set(id, mintAnchor(s, e, kind === 'block' ? 'block' : 'text'));
      intervals.push([first, last]);
    }
    if (!minted.size) return;
    this.#writer.write((map) => {
      for (const [id, anchor] of minted) map.set(`a:${id}`, anchor);
    });
    for (const [id, anchor] of minted) this.#engine.set(id, anchor);
  }

  #writerFor(r: number): CommentsWriter {
    // The DocDO never writes as R.
    while (this.doc.clientID === r) this.doc.clientID = newCommentsClient(this.doc);
    return new CommentsWriter(this.doc, r);
  }

  #load(): AnchorEngine {
    const engine = new AnchorEngine(this.doc);
    const records: [string, Anchor][] = [];
    for (const [key, value] of this.doc.getMap<Anchor>('comments')) if (key.startsWith('a:')) records.push([key.slice(2), value]);
    engine.load(records);
    return engine;
  }

  #count(): number {
    let n = 0;
    for (const key of this.doc.getMap('comments').keys()) if (key.startsWith('c:')) n += 1;
    return n;
  }

  /** Validates and mints a root's anchor from positions, or from one quote search when it has none (I6). */
  #place(request: CommentCreate['anchor']): { anchor: Anchor } | { error: CommentResult } {
    if (!request || typeof request !== 'object') return { error: refuse(400, 'bad-anchor') };
    let { start, end } = request;
    const quote = typeof request.quote === 'string' ? { exact: request.quote, prefix: '', suffix: '' } : request.quote;
    if (quote && (typeof quote.exact !== 'string' || quote.exact.length > MAX_QUOTE)) return { error: refuse(413, 'quote-too-long') };
    if (!start && !end) {
      if (!quote?.exact) return { error: refuse(400, 'bad-anchor') };
      const projection = project(this.doc);
      const found = findQuote(projection.text, { exact: quote.exact, prefix: String(quote.prefix ?? ''), suffix: String(quote.suffix ?? '') });
      if (!found.range) return { error: refuse(409, found.ambiguous ? 'quote-ambiguous' : 'quote-not-found') };
      const s = positionAt(projection, found.range.start, 0);
      const e = positionAt(projection, found.range.end, -1);
      if (!s || !e) return { error: refuse(409, 'quote-not-found') };
      start = encodeRelPos(s);
      end = encodeRelPos(e);
    }
    let s: Y.ID | null;
    let e: Y.ID | null;
    try {
      s = typeof start === 'string' && start ? decodeRelPos(start).item : null;
      e = typeof end === 'string' && end ? decodeRelPos(end).item : null;
    } catch {
      return { error: refuse(400, 'bad-anchor') };
    }
    if (!s || !e) return { error: refuse(400, 'bad-anchor') };
    for (const id of [s, e]) if (id.clock >= Y.getState(this.doc.store, id.client)) return { error: refuse(409, 'anchor-pending') };
    const anchored: [string, string][] = [];
    for (const [key, value] of this.doc.getMap<Anchor>('comments')) {
      if (!key.startsWith('a:') || value?.status !== 'anchored') continue;
      anchored.push([value.start, value.end]);
    }
    const ends = anchored.flatMap(([a, b]) => [a, b]).map((value) => safeItem(value));
    const ordinals = ordinalsOf(this.doc, [s, e, ...ends.filter((id): id is Y.ID => id !== null)]);
    const from = ordinals.get(idKey(s));
    const to = ordinals.get(idKey(e));
    if (from === undefined || to === undefined || from > to) return { error: refuse(409, 'anchor-gone') };
    if (to - from + 1 > MAX_QUOTE) return { error: refuse(413, 'quote-too-long') };
    const intervals: [number, number][] = [];
    for (let i = 0; i < ends.length; i += 2) {
      const a = ends[i] && ordinals.get(idKey(ends[i]!));
      const b = ends[i + 1] && ordinals.get(idKey(ends[i + 1]!));
      if (typeof a === 'number' && typeof b === 'number' && a <= b) intervals.push([a, b]);
    }
    if (maxCoverage(intervals, from, to) >= OVERLAP_CAP) return { error: refuse(409, 'too-many-overlapping') };
    const units = unitsAt(this.doc, [from, to]);
    const first = units.get(from);
    const last = units.get(to);
    if (!first || !last) return { error: refuse(409, 'anchor-gone') };
    const block = request.kind === 'block';
    if (block && (from !== to || !(first.item.content instanceof Y.ContentType))) return { error: refuse(400, 'bad-anchor') };
    return { anchor: mintAnchor(first, last, block ? 'block' : 'text') };
  }
}

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** One emoji grapheme: a reaction is never a word, a letter or a space. */
export function isEmoji(value: unknown): value is string {
  if (typeof value !== 'string' || !value || value.length > 32) return false;
  return [...graphemes.segment(value)].length === 1 && /\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(value);
}

const seqOf = (record: unknown): number => {
  const seq = (record as { seq?: unknown } | null)?.seq;
  return typeof seq === 'number' && Number.isSafeInteger(seq) && seq > 0 ? seq : 0;
};

function coerceReactions(value: unknown): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
  for (const [emoji, who] of Object.entries(value as Record<string, unknown>)) {
    if (Array.isArray(who)) out[emoji] = who.filter((principal): principal is string => typeof principal === 'string');
  }
  return out;
}

function safeItem(value: string): Y.ID | null {
  try {
    return value ? decodeRelPos(value).item : null;
  } catch {
    return null;
  }
}

function rootOf(struct: Y.Item): Y.AbstractType<unknown> | null {
  let type = struct.parent as Y.AbstractType<unknown> | null;
  while (type?._item) type = type._item.parent as Y.AbstractType<unknown>;
  return type;
}

interface SidecarEntry {
  text: string;
  createdAt: number;
  updatedAt: number;
  source: CommentSource;
  parentId?: string;
  resolvedAt?: number;
  resolvedBy?: CommentSource;
  quote?: string;
}

/** Moss's comments.json, kept only where each field has its type (moss's `coerceCommentMetadataMap`). */
export function coerceSidecar(value: unknown): [string, SidecarEntry][] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const out: [string, SidecarEntry][] = [];
  for (const [id, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!ID.test(id) || !raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const entry = raw as Record<string, unknown>;
    const { text, createdAt, updatedAt } = entry;
    if (typeof text !== 'string' || text.length > COMMENT_TEXT_MAX) continue;
    if (typeof createdAt !== 'number' || !Number.isFinite(createdAt) || typeof updatedAt !== 'number' || !Number.isFinite(updatedAt)) continue;
    out.push([id, {
      text,
      createdAt,
      updatedAt,
      source: isSource(entry.source) ? entry.source : 'user',
      ...(typeof entry.parentId === 'string' && ID.test(entry.parentId) ? { parentId: entry.parentId } : {}),
      ...(typeof entry.resolvedAt === 'number' && Number.isFinite(entry.resolvedAt) ? { resolvedAt: entry.resolvedAt } : {}),
      ...(isSource(entry.resolvedBy) ? { resolvedBy: entry.resolvedBy } : {}),
      ...(typeof entry.quote === 'string' && entry.quote.length <= MAX_QUOTE ? { quote: entry.quote } : {}),
    }]);
  }
  return out;
}

function toRecord(entry: SidecarEntry, author: string, seq: number): CommentRecord {
  return {
    author,
    text: entry.text,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    source: entry.source,
    ...(entry.resolvedAt !== undefined ? { resolvedAt: entry.resolvedAt } : {}),
    ...(entry.resolvedBy !== undefined ? { resolvedBy: entry.resolvedBy } : {}),
    reactions: {},
    seq,
  };
}
