// @vitest-environment jsdom
// T5.1: a Suggest mount on a real DocSession, its requests answered by the real ingest over a fake doc socket. A
// record closed while the socket is down reaches the author in the new socket's sync step 2, before 'sync'; the
// session must still settle `data-sync-unacked` so the pane can remount. A record an editor accepted meanwhile is
// different: the offline text resumes its lease and continues, never offered back.
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { STATE_CAP_BYTES } from '@moss-multi/protocol/limits';
import type { SuggestRequest } from '@moss-multi/protocol/suggest';
import { handleSuggest, SuggestIngest } from '../../../../../../packages/sync/src/doc/suggest.ts';
import { bindEditor } from '../../../../../../packages/sync/src/suggest/fork-shim.ts';
import { readMeta, readRecord, recordIds } from '../../../../../../packages/sync/src/suggest/records.ts';
import { acceptRecord, nodeRegistry, previewRecord } from '../../../../../../packages/sync/src/suggest/review.ts';
import { deterministicIds, EDITOR, seededBody, select, SUGGESTER } from '../../../../../../packages/sync/src/suggest/test-support.ts';

const sockets: FakeSocket[] = [];
class FakeSocket extends EventTarget {
  static OPEN = 1;
  static CONNECTING = 0;
  static CLOSED = 3;
  static CLOSING = 2;
  readonly OPEN = 1;
  readyState = 0;
  sent: unknown[] = [];
  constructor(readonly url: string) { super(); sockets.push(this); }
  send(frame: unknown) { this.sent.push(frame); }
  close() { this.readyState = 2; }
  open() { this.readyState = 1; this.dispatchEvent(new Event('open')); }
  ended(code: number) { this.readyState = 3; this.dispatchEvent(new CloseEvent('close', { code })); }
}
vi.stubGlobal('WebSocket', FakeSocket);
const { DocSession } = await import('../doc-session.ts');
const { SuggestMount } = await import('./mounts.ts');
const { clearTerminal } = await import('../terminal.ts');
const latest = () => sockets[sockets.length - 1];

let restore: () => void = () => {};
beforeEach(() => {
  vi.useFakeTimers();
  sockets.length = 0;
  clearTerminal('doc');
  restore = deterministicIds();
});
afterEach(() => { restore(); vi.useRealTimers(); vi.restoreAllMocks(); });

it('a record closed while offline, arriving in sync step 2 with requests still owed, settles unacked after the resync', async () => {
  const live = seededBody();
  const ingest = new SuggestIngest(live, { stateCap: STATE_CAP_BYTES, registry: nodeRegistry() });
  const session = new DocSession('doc');
  await session.provider.connect();
  const who = { ...SUGGESTER, role: 'suggester', connection: 'c1' };
  // What the DocDO has that the author's B lacks, applied as the provider applies a sync frame.
  const catchUp = () => Y.applyUpdate(session.doc, Y.encodeStateAsUpdate(live, Y.encodeStateVector(session.doc)), session.provider);
  let read = 0;
  const pending = (socket: FakeSocket): SuggestRequest[] => {
    const frames = socket.sent.filter((frame): frame is string => typeof frame === 'string' && frame.includes('"suggest-'));
    const fresh = frames.slice(read).map((frame) => JSON.parse(frame.slice('__YPS:'.length)) as SuggestRequest);
    read = frames.length;
    return fresh;
  };
  // The DocDO stores each request, broadcasts what changed, then replies.
  const answer = (socket: FakeSocket, requests: SuggestRequest[]) => {
    for (const request of requests) {
      const reply = handleSuggest(ingest, who, request);
      catchUp();
      socket.dispatchEvent(new MessageEvent('message', { data: `__YPS:${JSON.stringify(reply)}` }));
    }
  };

  const first = latest();
  first.open();
  catchUp();
  session.provider.synced = true;
  const mount = new SuggestMount(session, SUGGESTER.id, { ready() {}, refused() {}, rebuild() {}, closed() {}, change() {} });
  const bound = bindEditor(mount.fork.doc);
  try {
    void mount.provider.connect();
    answer(first, pending(first));
    expect(mount.fork.ready, 'F is filled once its lease arrives').toBe(true);
    bound.editor.update(() => {}, { discrete: true });
    const type = (step: () => void) => {
      bound.editor.update(() => {}, { discrete: true });
      bound.editor.update(step, { discrete: true });
      bound.editor.update(() => {}, { discrete: true });
    };
    type(() => select('Hello', 24).insertText(' One.'));
    type(() => select('Hello', 29).insertText(' Two.'));
    const requests = pending(first);
    expect(requests.map((request) => request.t)).toEqual(['suggest-ops', 'suggest-ops']);
    // One reply arrives while the other request is still in flight.
    answer(first, requests.slice(0, 1));
    expect(session.state.unacked).toBe(true);
    const [record] = recordIds(live);

    // The socket drops; meanwhile another of the author's windows withdraws the record.
    first.ended(1006);
    expect(ingest.withdraw({ ...who, connection: 'c2' }, record)).toMatchObject({ ok: true });
    await vi.advanceTimersByTimeAsync(1_000);
    const second = latest();
    expect(second).not.toBe(first);
    read = 0;
    who.connection = 'c3';
    second.open();
    // Sync step 2 lands before 'sync': the fork sees its record closed with a request still owed.
    catchUp();
    expect(mount.fork.closed, 'input closes').toBe(true);
    session.provider.synced = true;
    answer(second, pending(second));
    expect(session.state.unacked, 'nothing is owed by a closed fork, so the pane can remount').toBe(false);
  } finally {
    bound.dispose();
    mount.dispose();
    session.dispose();
  }
});

it('a record accepted while offline, arriving in sync step 2 with an insert under its lease unacked, continues: the lease set resumed comes from the body as it now is', async () => {
  const live = seededBody();
  const ingest = new SuggestIngest(live, { stateCap: STATE_CAP_BYTES, registry: nodeRegistry() });
  const session = new DocSession('doc');
  await session.provider.connect();
  const who = { ...SUGGESTER, role: 'suggester', connection: 'c1' };
  const catchUp = () => Y.applyUpdate(session.doc, Y.encodeStateAsUpdate(live, Y.encodeStateVector(session.doc)), session.provider);
  let read = 0;
  const pending = (socket: FakeSocket): SuggestRequest[] => {
    const frames = socket.sent.filter((frame): frame is string => typeof frame === 'string' && frame.includes('"suggest-'));
    const fresh = frames.slice(read).map((frame) => JSON.parse(frame.slice('__YPS:'.length)) as SuggestRequest);
    read = frames.length;
    return fresh;
  };
  const replies: string[] = [];
  const answer = (socket: FakeSocket, requests: SuggestRequest[]) => {
    for (const request of requests) {
      const reply = handleSuggest(ingest, who, request);
      replies.push(reply.t === 'suggest-refused' ? `refused:${reply.reason}` : reply.t);
      catchUp();
      socket.dispatchEvent(new MessageEvent('message', { data: `__YPS:${JSON.stringify(reply)}` }));
    }
  };
  const unsaved: string[][] = [];
  const first = latest();
  first.open();
  catchUp();
  session.provider.synced = true;
  const mount = new SuggestMount(session, SUGGESTER.id, { ready() {}, refused(text) { unsaved.push(text); }, rebuild() {}, closed() {}, change() {} });
  const bound = bindEditor(mount.fork.doc);
  try {
    void mount.provider.connect();
    answer(first, pending(first));
    expect(mount.fork.ready).toBe(true);
    const type = (step: () => void) => {
      bound.editor.update(() => {}, { discrete: true });
      bound.editor.update(step, { discrete: true });
      bound.editor.update(() => {}, { discrete: true });
    };
    type(() => select('Hello', 24).insertText(' One.'));
    type(() => select('Hello', 29).insertText(' Two.'));
    const requests = pending(first);
    expect(requests.map((request) => request.t)).toEqual(['suggest-ops', 'suggest-ops']);
    answer(first, requests.slice(0, 1));
    expect(session.state.unacked).toBe(true);
    const [record] = recordIds(live);

    // The socket drops; meanwhile an editor accepts the record as it stands (the first insert).
    first.ended(1006);
    const preview = previewRecord(live, record);
    if (!preview.ok) throw new Error(`preview refused: ${preview.reason}`);
    expect(acceptRecord(live, record, { previewHash: preview.hash, digest: preview.digest }, EDITOR)).toEqual({ ok: true });
    await vi.advanceTimersByTimeAsync(1_000);
    const second = latest();
    expect(second).not.toBe(first);
    read = 0;
    who.connection = 'c3';
    second.open();
    // Sync step 2 lands before 'sync': the fork sees its record accepted with the second insert still owed.
    catchUp();
    expect(readMeta(session.doc, record)?.status).toBe('accepted');
    session.provider.synced = true;
    answer(second, pending(second));
    expect(replies.filter((reply) => reply.startsWith('refused')), 'the resumed fork is never refused').toEqual([]);
    expect(unsaved, 'nothing is offered back').toEqual([]);
    expect(mount.fork.closed, 'input stays open').toBe(false);
    expect(session.state.unacked, 'every request is answered').toBe(false);
    const continuation = recordIds(live).map((id) => readMeta(live, id)!).find((meta) => meta.continues === record);
    expect(continuation?.status, 'the offline insert opens a continuation of the accepted record').toBe('open');
    expect(readRecord(live, continuation!.id)?.ops.length).toBe(1);
  } finally {
    bound.dispose();
    mount.dispose();
    session.dispose();
  }
});
