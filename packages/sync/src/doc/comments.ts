// The DocDO's comments (docs/design/comments.md §3, §4, §13; A§13): the reserved writer R persisted in meta, gate 2b,
// the frame engine's changes flushed through writeComments in the same turn, the create RPC, and marker import.
// Every write to Y.Map('comments') goes through #writer.
import * as Y from 'yjs';
import { AnchorEngine, mintAnchor, MAX_QUOTE, OVERLAP_CAP, type Anchor, type Unit } from '@moss-multi/core/anchor-frame';
import { idKey, maxCoverage, ordinalsOf, unitsAt, unitText } from '@moss-multi/core/comment-units';
import { decodeRelPos, encodeRelPos, findQuote, positionAt, project, type TextQuote } from '@moss-multi/core/tree-anchor';
import { COMMENT_ORIGIN, CommentsWriter, newCommentsClient, type GuardRefusal } from './comments-guard.ts';
import type { DocStore } from './persistence.ts';
import type { ImportedMarks } from '../server-doc.ts';

export const COMMENTS_CLIENT_META = 'commentsClient';
/** A comment's text, in characters (413 past it). */
export const COMMENT_TEXT_MAX = 10_000;
/** Comment and reply records per doc. */
export const COMMENTS_PER_DOC = 2_000;
/** Quote-only searches one sidecar import runs; later position-less entries are dropped. */
export const MAX_IMPORT_SEARCHES = 100;
/**
 * The share of the state cap comment writes may fill. The rest is the typing headroom STATE_CAP_BYTES builds in, so
 * comments, which copy their quote, never leave a doc too full to edit.
 */
export const COMMENT_STATE_SHARE = 0.8;
/** Moss's marker ids: what `%%m:<id>:start%%` can carry. */
const ID = /^[A-Za-z0-9_-]{1,64}$/;

/** Origins the engine never reads: replay from storage, the seed, and comments writes themselves. */
const SKIPPED: ReadonlySet<unknown> = new Set(['persistence', 'server-seed', COMMENT_ORIGIN]);

export type CommentSource = 'user' | 'agent' | 'external';

/** The `c:<id>` record (A§13). Times are seconds, as moss expects. */
export interface CommentRecord {
  author: string;
  text: string;
  createdAt: number;
  updatedAt: number;
  source: CommentSource;
  parentId?: string;
  resolvedAt?: number;
  resolvedBy?: string;
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

export type CommentResult = { ok: true; id: string; quote: string | null } | { ok: false; status: 400 | 404 | 409 | 413; error: string };

const refuse = (status: 400 | 404 | 409 | 413, error: string): CommentResult => ({ ok: false, status, error });
const nowSeconds = () => Math.floor(Date.now() / 1000);
const isSource = (value: unknown): value is CommentSource => value === 'user' || value === 'agent' || value === 'external';

export class DocComments {
  #writer: CommentsWriter;
  #engine: AnchorEngine;
  #pending = new Map<string, Anchor>();

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
    doc.on('afterTransaction', (txn: Y.Transaction) => {
      if (SKIPPED.has(txn.origin)) return;
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

  /** The create RPC (comments.md §4): a reply, a positioned root, or a quote-only root searched once. */
  create(input: CommentCreate, maxRecords = COMMENTS_PER_DOC): CommentResult {
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
    };
    if (input.parentId !== undefined) {
      const parent = comments.get(`c:${input.parentId}`) as CommentRecord | undefined;
      if (!parent || parent.parentId !== undefined) return refuse(409, 'parent-missing');
      this.#writer.write((map) => map.set(`c:${input.id}`, { ...record, parentId: input.parentId }));
      return { ok: true, id: input.id, quote: null };
    }
    const placed = this.#place(input.anchor);
    if ('error' in placed) return placed.error;
    const anchor = placed.anchor;
    this.#writer.write((map) => {
      map.set(`c:${input.id}`, record);
      map.set(`a:${input.id}`, anchor);
    });
    this.#engine.set(input.id, anchor);
    return { ok: true, id: input.id, quote: anchor.quote };
  }

  /**
   * Marker import (comments.md §13), right after the import's tree diff in the same turn: each sidecar root whose
   * markers were found gets one anchor from its first marker to its last, a root without markers but with a `quote`
   * gets one search, and replies follow only an anchored root, as moss prunes them.
   */
  importSidecar(sidecar: Record<string, unknown>, marks: ImportedMarks, author: string, maxRecords = COMMENTS_PER_DOC): void {
    const entries = coerceSidecar(sidecar);
    const aligned = marks.ranges.size > 0 && unitText(this.doc) === marks.text;
    if (marks.ranges.size > 0 && !aligned) console.error('comment import: the imported tree does not match the live units; markers dropped');
    const ordinals = [...marks.ranges.values()].flatMap(({ first, last }) => [first, last]);
    const units = aligned ? unitsAt(this.doc, ordinals) : new Map<number, Unit>();
    const intervals: [number, number][] = [];
    const roots = new Map<string, Anchor>();
    const records = new Map<string, CommentRecord>();
    const byTime = [...entries].sort((a, b) => a[1].createdAt - b[1].createdAt);
    for (const [id, entry] of byTime) {
      if (entry.parentId !== undefined || records.size >= maxRecords) continue;
      let anchor: Anchor | null = null;
      const range = marks.ranges.get(id);
      if (range) {
        const first = units.get(range.first);
        const last = units.get(range.last);
        if (first && last && range.last - range.first < MAX_QUOTE && maxCoverage(intervals, range.first, range.last) < OVERLAP_CAP) {
          anchor = mintAnchor(first, last, range.block && range.first === range.last ? 'block' : 'text');
          intervals.push([range.first, range.last]);
        }
      } else if (entry.quote) {
        const placed = this.#place({ quote: entry.quote }, intervals);
        if ('anchor' in placed) {
          anchor = placed.anchor;
          intervals.push(placed.span);
        }
      }
      if (!anchor) continue;
      roots.set(id, anchor);
      records.set(id, toRecord(entry, author));
    }
    for (const [id, entry] of byTime) {
      if (entry.parentId === undefined || !roots.has(entry.parentId) || records.size >= maxRecords) continue;
      records.set(id, { ...toRecord(entry, author), parentId: entry.parentId });
    }
    if (!records.size) return;
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
  #place(
    request: CommentCreate['anchor'],
    imported?: [number, number][],
  ): { anchor: Anchor; span: [number, number] } | { error: CommentResult } {
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
    const intervals: [number, number][] = imported ? [...imported] : [];
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
    return { anchor: mintAnchor(first, last, block ? 'block' : 'text'), span: [from, to] };
  }
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
  resolvedBy?: string;
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

function toRecord(entry: SidecarEntry, author: string): CommentRecord {
  return {
    author,
    text: entry.text,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    source: entry.source,
    ...(entry.resolvedAt !== undefined ? { resolvedAt: entry.resolvedAt } : {}),
    ...(entry.resolvedBy !== undefined ? { resolvedBy: entry.resolvedBy } : {}),
    reactions: {},
  };
}
