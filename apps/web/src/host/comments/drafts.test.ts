// @vitest-environment jsdom
// A bound composer's submit is kept as a retryable draft until the server takes it (comments.md §4, §12): a failed
// create, reply or edit keeps its text and its anchor, parent or comment, a retry reuses the proposed id so it lands
// exactly once, and a success clears only its own draft. A new submit is its own write: a second reply or a revised
// text is sent under a new id, never folded into a draft still in flight or one whose answer was lost.
import type { Binding } from '@lexical/yjs';
import { createEditor } from 'lexical';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { rememberRole } from '../access.ts';
import { failedDraftText, mutate, submitted } from './adapter.ts';
import { createComment, draftOf } from './api.ts';
import type { Minted } from './mint.ts';
import { modelFor } from './model.ts';
import { bindCommentPaint, markShared } from './paint.ts';

type Mode = 'ok' | 'network-before' | 'network-after' | `refuse:${string}`;

/** The comment routes as a server that keeps each proposed id once. */
class FakeServer {
  readonly landed = new Map<string, Record<string, unknown>>();
  readonly edits: { id: string; text: string }[] = [];
  readonly calls: { method: string; path: string; body: Record<string, unknown> }[] = [];
  mode: Mode = 'ok';
  /** While set, each request waits for it before the server sees it. */
  gate: Promise<void> | null = null;

  fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const path = new URL(String(input), 'http://localhost').pathname;
    const method = init?.method ?? 'GET';
    const body = (init?.body ? JSON.parse(String(init.body)) : {}) as Record<string, unknown>;
    this.calls.push({ method, path, body });
    if (this.gate) await this.gate;
    if (this.mode === 'network-before') throw new TypeError('Failed to fetch');
    if (this.mode.startsWith('refuse:')) return Response.json({ error: this.mode.slice('refuse:'.length) }, { status: 429 });
    if (method === 'POST' && path.endsWith('/comments')) {
      const id = String(body.id);
      if (this.landed.has(id)) return Response.json({ error: 'exists' }, { status: 409 });
      this.landed.set(id, body);
    } else if (method === 'PATCH') {
      this.edits.push({ id: decodeURIComponent(path.split('/').pop() ?? ''), text: String(body.text) });
    }
    if (this.mode === 'network-after') throw new TypeError('Failed to fetch');
    return Response.json({}, { status: 201 });
  };
}

let server: FakeServer;
beforeEach(() => {
  server = new FakeServer();
  vi.stubGlobal('fetch', server.fetch);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const MINTED: Minted = { kind: 'text', start: 'c3RhcnQ=', end: 'ZW5k', quote: 'quick brown' };

/** An editor a pane binds to `docId` with a painter, at `role`. */
function boundEditor(docId: string, role = 'commenter') {
  const doc = new Y.Doc();
  const editor = createEditor();
  rememberRole(docId, role);
  markShared(editor, docId);
  bindCommentPaint(editor, { doc, id: docId } as unknown as Binding);
  return { doc, editor };
}

it('a root comment that fails on the network keeps its text and anchor, and its retry lands once', async () => {
  const doc = new Y.Doc();
  server.mode = 'network-before';
  const id = createComment('doc-root', doc, MINTED, 'Is the fox brown?');
  await vi.waitFor(() => expect(draftOf('doc-root', 'root')?.failed, 'the failure is recorded').toBe('network'));
  expect(draftOf('doc-root', 'root'), 'the draft keeps the text and the minted anchor').toMatchObject({ id, text: 'Is the fox brown?', anchor: MINTED });
  expect(modelFor(doc).record(id), 'nothing shows as posted').toBeUndefined();

  // The answer is lost after the server took it: the retry must not post a second comment.
  server.mode = 'network-after';
  expect(createComment('doc-root', doc, MINTED, 'Is the fox brown?'), 'the retry reuses the proposed id').toBe(id);
  await vi.waitFor(() => expect(draftOf('doc-root', 'root')?.failed).toBe('network'));
  server.mode = 'ok';
  expect(createComment('doc-root', doc, MINTED, 'Is the fox brown?')).toBe(id);
  await vi.waitFor(() => expect(draftOf('doc-root', 'root'), 'the success clears the draft').toBeUndefined());
  expect([...server.landed.keys()], 'one comment landed').toEqual([id]);
  expect(server.calls.filter((call) => call.method === 'POST').map((call) => call.body.id), 'every attempt carried the same id').toEqual([id, id, id]);
});

it('a refused root comment keeps its draft; a new selection mints a new comment', async () => {
  const doc = new Y.Doc();
  server.mode = 'refuse:rate-limited';
  const id = createComment('doc-root-2', doc, MINTED, 'Too fast');
  await vi.waitFor(() => expect(draftOf('doc-root-2', 'root')?.failed).toBe('rate-limited'));
  expect(draftOf('doc-root-2', 'root')).toMatchObject({ id, text: 'Too fast', anchor: MINTED });
  server.mode = 'ok';
  const other: Minted = { ...MINTED, start: 'b3RoZXI=' };
  const next = createComment('doc-root-2', doc, other, 'Elsewhere');
  expect(next, 'another anchor is another comment').not.toBe(id);
  await vi.waitFor(() => expect(server.landed.has(next)).toBe(true));
  await vi.waitFor(() => expect(draftOf('doc-root-2', 'root'), 'the other anchor keeps its failed draft').toMatchObject({ id, failed: 'rate-limited' }));
  expect([...server.landed.keys()]).toEqual([next]);
});

it('a retry with revised text after a lost answer saves the revision, for a root comment and a reply', async () => {
  const { doc, editor } = boundEditor('doc-revise');
  server.mode = 'network-after';
  const first = createComment('doc-revise', doc, MINTED, 'Version one');
  await vi.waitFor(() => expect(draftOf('doc-revise', 'root')?.failed).toBe('network'));
  server.mode = 'ok';
  const second = createComment('doc-revise', doc, MINTED, 'Version two');
  expect(second, 'a revised text is a new write').not.toBe(first);
  await vi.waitFor(() => expect(draftOf('doc-revise', 'root'), 'the revision supersedes the failed draft').toBeUndefined());
  expect(server.landed.get(second), 'the revision is stored').toMatchObject({ text: 'Version two' });

  server.mode = 'network-after';
  mutate(editor, { type: 'reply', parentId: 'p1', text: 'Reply one' });
  expect(await submitted('doc-revise', 'reply:p1')).toEqual({ ok: false, error: 'network' });
  server.mode = 'ok';
  mutate(editor, { type: 'reply', parentId: 'p1', text: 'Reply two' });
  expect(await submitted('doc-revise', 'reply:p1')).toEqual({ ok: true });
  expect([...server.landed.values()].map((body) => body.text), 'every text the server was sent is stored once')
    .toEqual(['Version one', 'Version two', 'Reply one', 'Reply two']);
  expect(draftOf('doc-revise', 'reply:p1')).toBeUndefined();
});

it('a second reply sent while the first is in flight is its own reply, and both land', async () => {
  const { editor } = boundEditor('doc-two-replies');
  let open = () => {};
  server.gate = new Promise((resolve) => { open = resolve; });
  expect(mutate(editor, { type: 'reply', parentId: 'p1', text: 'Slow reply A' })).toBe(true);
  const a = submitted('doc-two-replies', 'reply:p1');
  expect(mutate(editor, { type: 'reply', parentId: 'p1', text: 'Quick reply B' })).toBe(true);
  const b = submitted('doc-two-replies', 'reply:p1');
  expect(b, 'the second submit has its own answer').not.toBe(a);
  open();
  expect(await a).toEqual({ ok: true });
  expect(await b).toEqual({ ok: true });
  const posted = server.calls.filter((call) => call.method === 'POST').map((call) => call.body);
  expect(posted.map((body) => body.text)).toEqual(['Slow reply A', 'Quick reply B']);
  expect(new Set(posted.map((body) => body.id)).size, 'under two ids').toBe(2);
  expect(draftOf('doc-two-replies', 'reply:p1')).toBeUndefined();
});

it('a root resubmit while the first is in flight: the same text posts once, a revised text posts the revision', async () => {
  const doc = new Y.Doc();
  let open = () => {};
  server.gate = new Promise((resolve) => { open = resolve; });
  const id = createComment('doc-inflight', doc, MINTED, 'Held');
  expect(createComment('doc-inflight', doc, MINTED, 'Held'), 'a double submit is one comment').toBe(id);
  const revised = createComment('doc-inflight', doc, MINTED, 'Held plus more');
  expect(revised).not.toBe(id);
  open();
  await vi.waitFor(() => expect(draftOf('doc-inflight', 'root')).toBeUndefined());
  expect(server.calls.filter((call) => call.method === 'POST').map((call) => call.body.text)).toEqual(['Held', 'Held plus more']);
});

it("a failed reply's and edit's text stays readable for the composer until a later submit in its slot", async () => {
  const { editor } = boundEditor('doc-recover');
  // Two replies in flight together, then both fail.
  server.mode = 'network-before';
  let open = () => {};
  server.gate = new Promise((resolve) => { open = resolve; });
  mutate(editor, { type: 'reply', parentId: 'p1', text: 'Lost A' });
  const a = submitted('doc-recover', 'reply:p1');
  mutate(editor, { type: 'reply', parentId: 'p1', text: 'Lost B' });
  const b = submitted('doc-recover', 'reply:p1');
  open();
  await Promise.all([a, b]);
  server.gate = null;
  mutate(editor, { type: 'edit', id: 'c1', text: 'Lost edit' });
  await submitted('doc-recover', 'edit:c1');
  expect(failedDraftText('doc-recover', 'reply:p1'), 'both failed replies come back').toBe('Lost A\n\nLost B');
  expect(failedDraftText('doc-recover', 'reply:p2')).toBeNull();
  expect(failedDraftText('doc-recover', 'edit:c1')).toBe('Lost edit');
  server.mode = 'ok';
  mutate(editor, { type: 'reply', parentId: 'p1', text: 'Lost A\n\nLost B' });
  expect(await submitted('doc-recover', 'reply:p1')).toEqual({ ok: true });
  expect(failedDraftText('doc-recover', 'reply:p1'), 'the resubmit took both').toBeNull();
  mutate(editor, { type: 'edit', id: 'c1', text: 'Found edit' });
  expect(await submitted('doc-recover', 'edit:c1')).toEqual({ ok: true });
  expect(failedDraftText('doc-recover', 'edit:c1')).toBeNull();
});

it('a reply that fails keeps its text and parent; the bound composer gets the answer and its retry lands once', async () => {
  const { editor } = boundEditor('doc-reply');
  server.mode = 'refuse:rate-limited';
  expect(mutate(editor, { type: 'reply', parentId: 'p1', text: 'A reply' }), 'the command signature still answers sent').toBe(true);
  const first = submitted('doc-reply', 'reply:p1');
  expect(first, 'the composer gets the in-flight answer').not.toBeNull();
  expect(await first).toEqual({ ok: false, error: 'rate-limited' });
  const draft = draftOf('doc-reply', 'reply:p1');
  expect(draft, 'the reply draft survives').toMatchObject({ text: 'A reply', parentId: 'p1', failed: 'rate-limited' });
  expect(submitted('doc-reply', 'reply:p1'), 'nothing is in flight after the failure').toBeNull();

  server.mode = 'network-after';
  expect(mutate(editor, { type: 'reply', parentId: 'p1', text: 'A reply' })).toBe(true);
  expect(await submitted('doc-reply', 'reply:p1')).toEqual({ ok: false, error: 'network' });
  server.mode = 'ok';
  expect(mutate(editor, { type: 'reply', parentId: 'p1', text: 'A reply' })).toBe(true);
  expect(await submitted('doc-reply', 'reply:p1')).toEqual({ ok: true });
  expect(draftOf('doc-reply', 'reply:p1'), 'the success clears it').toBeUndefined();
  expect([...server.landed.keys()], 'one reply landed, under the first proposed id').toEqual([draft?.id]);
  expect(server.landed.get(draft?.id ?? '')).toMatchObject({ parentId: 'p1', text: 'A reply' });
});

it('an edit that fails keeps its text for its comment, and the retry saves it', async () => {
  const { editor } = boundEditor('doc-edit');
  server.mode = 'network-before';
  expect(mutate(editor, { type: 'edit', id: 'c1', text: 'Better words' })).toBe(true);
  expect(await submitted('doc-edit', 'edit:c1')).toEqual({ ok: false, error: 'network' });
  expect(draftOf('doc-edit', 'edit:c1'), 'the edit draft survives').toMatchObject({ id: 'c1', text: 'Better words', failed: 'network' });
  server.mode = 'refuse:rate-limited';
  expect(mutate(editor, { type: 'edit', id: 'c1', text: 'Better words' })).toBe(true);
  expect(await submitted('doc-edit', 'edit:c1')).toEqual({ ok: false, error: 'rate-limited' });
  expect(draftOf('doc-edit', 'edit:c1')).toMatchObject({ text: 'Better words', failed: 'rate-limited' });
  server.mode = 'ok';
  expect(mutate(editor, { type: 'edit', id: 'c1', text: 'Better words' })).toBe(true);
  expect(await submitted('doc-edit', 'edit:c1')).toEqual({ ok: true });
  expect(draftOf('doc-edit', 'edit:c1')).toBeUndefined();
  expect(server.edits).toEqual([{ id: 'c1', text: 'Better words' }]);
});

it('a successful save clears only its own draft', async () => {
  const { doc, editor } = boundEditor('doc-own');
  server.mode = 'refuse:rate-limited';
  createComment('doc-own', doc, MINTED, 'Root draft');
  mutate(editor, { type: 'reply', parentId: 'p1', text: 'First reply' });
  mutate(editor, { type: 'reply', parentId: 'p2', text: 'Second reply' });
  mutate(editor, { type: 'edit', id: 'c9', text: 'An edit' });
  await vi.waitFor(() => expect(draftOf('doc-own', 'edit:c9')?.failed).toBe('rate-limited'));
  server.mode = 'ok';
  mutate(editor, { type: 'reply', parentId: 'p2', text: 'Second reply' });
  expect(await submitted('doc-own', 'reply:p2')).toEqual({ ok: true });
  expect(draftOf('doc-own', 'reply:p2')).toBeUndefined();
  expect(draftOf('doc-own', 'reply:p1'), 'the other reply keeps its draft').toMatchObject({ text: 'First reply' });
  expect(draftOf('doc-own', 'root'), 'and the root its own').toMatchObject({ text: 'Root draft' });
  expect(draftOf('doc-own', 'edit:c9'), 'and the edit its own').toMatchObject({ text: 'An edit' });
});

it('a viewer submits nothing and keeps no draft', () => {
  const { editor } = boundEditor('doc-viewer', 'viewer');
  expect(mutate(editor, { type: 'reply', parentId: 'p1', text: 'No' })).toBe(false);
  expect(submitted('doc-viewer', 'reply:p1')).toBeNull();
  expect(draftOf('doc-viewer', 'reply:p1')).toBeUndefined();
  expect(server.calls).toEqual([]);
});
