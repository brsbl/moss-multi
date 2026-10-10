// The comment REST calls (docs/design/comments.md §4, §12). A new comment or reply shows at once as pending in the
// doc's model, under the id the composer proposed, until the server's record arrives over the doc socket. An
// `anchor-pending` answer means the server lacks an item the selection names (an edit not yet acked): the call waits
// for this tab's acks and retries, at most 3 times. Any other refusal drops the pending comment and says why.
import type { Anchor } from '@moss-multi/core/anchor-frame';
import type { Doc } from 'yjs';
import { shareToken } from '../media/web-asset-url.ts';
import { refuseInput } from '../refusal.ts';
import type { Minted } from './mint.ts';
import { modelFor, type CommentRecord } from './model.ts';
import { myPrincipalId } from './people.ts';

const RETRIES = 3;
const ACK_WAIT_MS = 10_000;

/** The doc sessions' ack wait, set by the pane so this module stays free of the socket layer. */
let waitDocsAcked: (docIds: string[], timeoutMs: number) => Promise<boolean> = () => Promise.resolve(true);
export function setAckWaiter(wait: typeof waitDocsAcked): void {
  waitDocsAcked = wait;
}

const REFUSED: Record<string, string> = {
  'anchor-gone': 'The text you commented on is no longer there, so the comment was not added.',
  'anchor-pending': "Your comment couldn't be added yet. Try again in a moment.",
  'too-many-overlapping': 'Too many comments already cover this text.',
  'comment-cap': 'This note has as many comments as it can hold.',
  'doc-cap': 'This note is at its size limit, so the comment was not added.',
  'text-too-long': 'This comment is too long.',
  'quote-too-long': 'That selection is too long to comment on.',
  'parent-missing': 'That thread is gone, so the reply was not added.',
  'rate-limited': "You're commenting faster than this note allows. Try again in a minute.",
  'not-author': 'Only its author can change this comment.',
  'too-many-reactions': 'This comment has as many reactions as it can hold.',
  unauthenticated: 'Sign in to comment.',
  forbidden: "You can't comment on this note.",
};
const FAILED = "Your comment couldn't be saved. Try again.";

async function post(path: string, body: unknown, method = 'POST'): Promise<{ ok: boolean; error?: string }> {
  const share = shareToken();
  try {
    const response = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', accept: 'application/json', ...(share ? { 'x-moss-share': share } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(15_000),
    });
    if (response.ok) return { ok: true };
    const answer = (await response.json().catch(() => ({}))) as { error?: unknown };
    return { ok: false, error: typeof answer.error === 'string' ? answer.error : String(response.status) };
  } catch {
    return { ok: false, error: 'network' };
  }
}

const now = () => Math.floor(Date.now() / 1000);

function pendingRecord(text: string, parentId?: string): CommentRecord {
  return { author: myPrincipalId() ?? '', text, createdAt: now(), updatedAt: now(), source: 'user', ...(parentId ? { parentId } : {}), reactions: {} };
}

async function send(docId: string, doc: Doc, id: string, body: Record<string, unknown>): Promise<void> {
  const model = modelFor(doc);
  for (let attempt = 0; ; attempt += 1) {
    const result = await post(`/api/docs/${encodeURIComponent(docId)}/comments`, { id, ...body });
    // A lost answer to a write that landed: the record is already here.
    if (result.ok || result.error === 'exists') return;
    if (result.error === 'anchor-pending' && attempt < RETRIES && (await waitDocsAcked([docId], ACK_WAIT_MS))) {
      // Acked here can still be in flight to the DocDO's store; give it a beat.
      await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
      continue;
    }
    model.dropPending(id);
    refuseInput(REFUSED[result.error ?? ''] ?? FAILED);
    return;
  }
}

/** Creates a root comment on `minted`; it paints at once. */
export function createComment(docId: string, doc: Doc, minted: Minted, text: string): string {
  const id = crypto.randomUUID();
  const anchor: Anchor = { kind: minted.kind, start: minted.start, end: minted.end, status: 'anchored', quote: minted.quote };
  modelFor(doc).addPending(id, pendingRecord(text), anchor);
  void send(docId, doc, id, { text, anchor: { kind: minted.kind, start: minted.start, end: minted.end, quote: minted.quote } });
  return id;
}

/** Adds a reply to the thread `parentId`; it shows at once. */
export function replyTo(docId: string, doc: Doc, parentId: string, text: string): string {
  const id = crypto.randomUUID();
  modelFor(doc).addPending(id, pendingRecord(text, parentId));
  void send(docId, doc, id, { text, parentId });
  return id;
}

/** Resolves or reopens a thread; the change arrives with the record. */
export async function resolveThread(docId: string, rootId: string, resolved: boolean): Promise<void> {
  const result = await post(`/api/docs/${encodeURIComponent(docId)}/comments/${encodeURIComponent(rootId)}/resolve`, { resolved });
  if (!result.ok) refuseInput(REFUSED[result.error ?? ''] ?? "That thread couldn't be updated. Try again.");
}

const commentPath = (docId: string, id: string) => `/api/docs/${encodeURIComponent(docId)}/comments/${encodeURIComponent(id)}`;

/** Rewrites the caller's own comment; the new text arrives with the record. */
export async function editComment(docId: string, id: string, text: string): Promise<void> {
  const result = await post(commentPath(docId, id), { text }, 'PATCH');
  if (!result.ok) refuseInput(REFUSED[result.error ?? ''] ?? "That comment couldn't be edited. Try again.");
}

/** Deletes the caller's own comment, or with `thread` their whole thread; the deletion arrives with the records. */
export async function deleteComment(docId: string, id: string, scope: 'comment' | 'thread'): Promise<void> {
  const result = await post(`${commentPath(docId, id)}${scope === 'thread' ? '?scope=thread' : ''}`, undefined, 'DELETE');
  if (!result.ok) refuseInput(REFUSED[result.error ?? ''] ?? "That comment couldn't be deleted. Try again.");
}

/** Adds (`on`) or removes the caller's reaction `emoji`. */
export async function reactTo(docId: string, id: string, emoji: string, on: boolean): Promise<void> {
  const result = await post(`${commentPath(docId, id)}/reactions`, { emoji, on });
  if (!result.ok) refuseInput(REFUSED[result.error ?? ''] ?? "That reaction couldn't be saved. Try again.");
}

/** The server's answer to a bound composer's submit. */
export type Completion = { ok: true } | { ok: false; error: string };
/** Where a bound composer's draft lives in a doc: the new-comment composer, a thread's reply box, or a comment's edit. */
export type DraftSlot = 'root' | `reply:${string}` | `edit:${string}`;
/** A bound composer's submit, kept until the server takes it. */
export interface Draft { id: string; text: string; anchor?: Minted; parentId?: string; failed?: string; done: Promise<Completion> }

/** Tests-first stub (T4.B3): no draft is kept yet. */
export function draftOf(docId: string, slot: DraftSlot): Draft | undefined {
  void docId;
  void slot;
  return undefined;
}
