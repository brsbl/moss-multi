// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { decodePayloadFrame, encodeSyncFrame, PAYLOAD_STEP1 } from '@moss-multi/protocol/sync';

const sockets: FakeSocket[] = [];
class FakeSocket extends EventTarget {
  static OPEN = 1;
  static CONNECTING = 0;
  static CLOSED = 3;
  static CLOSING = 2;
  readyState = 0;
  sent: unknown[] = [];
  closes: number[] = [];
  constructor(readonly url: string) { super(); sockets.push(this); }
  send(frame: unknown) { this.sent.push(frame); }
  close(code = 1000) { this.closes.push(code); this.readyState = 2; }
  open() { this.readyState = 1; this.dispatchEvent(new Event('open')); }
  ended(code: number) { this.readyState = 3; this.dispatchEvent(new CloseEvent('close', { code })); }
}
vi.stubGlobal('WebSocket', FakeSocket);
const sessionModule = await import('./doc-session.ts');
const { DocSession, severDocSessions } = sessionModule;
/** T2.5's recovery hook, looked up so the rest of the file runs while it is missing. */
const reopenDocs = (docIds: string[]) => (sessionModule as { reopenDocs?: (ids: string[]) => void }).reopenDocs?.(docIds);
const { terminalOf, clearTerminal } = await import('./terminal.ts');
const { hasUnacked } = await import('./unacked.ts');
let session: InstanceType<typeof DocSession>;
const latest = () => sockets[sockets.length - 1];
/** A code block element naming payload `id` in the note's tree, as the binding writes one. */
function nameInTree(id: string): void {
  const element = new Y.XmlElement('code-block');
  element.setAttribute('__type', 'code-block');
  element.setAttribute('__regId', id);
  session.doc.get('root', Y.XmlText).insertEmbed(0, element);
}
beforeEach(async () => {
  vi.useFakeTimers();
  sockets.length = 0;
  clearTerminal('doc');
  session = new DocSession('doc');
  await session.provider.connect();
});
afterEach(() => { session.dispose(); vi.useRealTimers(); vi.restoreAllMocks(); });
it('detaches a half-open socket without its close event and ignores its late close', async () => {
  const old = latest(); old.open(); session.provider.synced = true;
  session.doc.getText('title').insert(0, 'kept');
  await vi.advanceTimersByTimeAsync(13_500);
  expect(old.closes).toContain(4408);
  expect(sockets).toHaveLength(2);
  expect(session.state.connection).toBe('offline');
  const fresh = latest(); fresh.open(); session.provider.synced = true;
  old.ended(1006);
  expect(session.provider.ws).toBe(fresh);
  expect(session.state.connection).toBe('online');
  expect(session.doc.getText('title').toString()).toBe('kept');
  expect(hasUnacked()).toBe(true);
});
it('keeps the socket while a busy main thread holds the heartbeat back, then detaches once it is idle and still silent', async () => {
  const socket = latest(); socket.open(); session.provider.synced = true;
  // A collaborator's large paste applied here: every 1 s tick runs about 2.5 s late, and no frame is read for 30 s.
  for (let i = 0; i < 12; i += 1) {
    vi.setSystemTime(Date.now() + 1_500);
    await vi.advanceTimersByTimeAsync(1_000);
  }
  expect(socket.closes, 'a busy tab is not a silent socket').not.toContain(4408);
  await vi.advanceTimersByTimeAsync(13_500);
  expect(socket.closes, 'idle and still silent: half-open').toContain(4408);
});
it('sends no step 1 while the last is unanswered and frames still arrive, and keeps the 4 s step 1 once answered or silent', async () => {
  const socket = latest(); socket.open(); session.provider.synced = true;
  const step1s = () => socket.sent.filter((frame) => frame instanceof Uint8Array && frame[0] === 0 && frame[1] === 0).length;
  let n = 0;
  const receive = (step: number) => {
    const peer = new Y.Doc();
    peer.getText('peer').insert(0, `${n++}`);
    socket.dispatchEvent(new MessageEvent('message', { data: encodeSyncFrame(step, Y.encodeStateAsUpdate(peer)).slice().buffer }));
    // lib0 read Date.now before the fake clock replaced it: stamp the frame on the fake clock, as the provider would.
    session.provider.wsLastMessageReceived = Date.now();
  };
  expect(step1s(), 'the step 1 on open').toBe(1);
  // A peer behind a large paste: its pieces arrive about once a second, and the answer is queued behind them.
  for (let i = 0; i < 10; i += 1) {
    receive(2);
    await vi.advanceTimersByTimeAsync(1_000);
  }
  expect(step1s(), 'no second step 1 while its answer is on its way').toBe(1);
  receive(1);
  for (let i = 0; i < 5; i += 1) {
    receive(2);
    await vi.advanceTimersByTimeAsync(1_000);
  }
  expect(step1s(), 'answered: the 4 s step 1 resumes').toBe(2);
  await vi.advanceTimersByTimeAsync(9_000);
  expect(step1s(), 'nothing arriving: the step 1 keeps frames flowing').toBeGreaterThanOrEqual(3);
  expect(socket.closes).toEqual([]);
});
it.each([[4402, 'session-ended'], [4404, 'unavailable'], [4410, 'deleted'], [4429, 'conn-limit']] as const)(
  'stops reconnecting synchronously on %s', async (code, reason) => {
    latest().open(); latest().ended(code);
    expect(terminalOf('doc')).toBe(reason);
    expect(session.provider.shouldConnect).toBe(false);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(sockets).toHaveLength(1);
  },
);
it('a rate close keeps the doc and reconnects', async () => {
  latest().open(); session.provider.synced = true;
  session.doc.getText('title').insert(0, 'pending');
  latest().ended(4420);
  await vi.advanceTimersByTimeAsync(300);
  expect(sockets).toHaveLength(2);
  expect(session.doc.getText('title').toString()).toBe('pending');
  expect(session.state.unacked).toBe(true);
});
it('a reconnect sends the note\'s unacked writes before any payload frame, so blocks made offline are named first', async () => {
  const first = latest(); first.open(); session.provider.synced = true;
  first.ended(1006);
  // Offline: a note write (a new block's element) and its payload's first text.
  nameInTree('minted');
  session.payloads.hold('minted', true).getText('payload').insert(0, 'code');
  await vi.advanceTimersByTimeAsync(300);
  const socket = latest();
  expect(socket).not.toBe(first);
  socket.open();
  const kinds = socket.sent.map((frame) => {
    const bytes = frame as Uint8Array;
    return bytes[0] === 7 ? 'payload' : bytes[0] === 0 && bytes[1] !== 0 ? 'note write' : 'other';
  });
  const payload = kinds.indexOf('payload');
  expect(payload, 'the payload is resent').toBeGreaterThan(-1);
  expect(kinds.slice(0, payload), 'the note write goes first').toContain('note write');
});
it('a payload made and deleted offline is neither resent nor unacked until the tree names it again (B036)', async () => {
  const first = latest(); first.open(); session.provider.synced = true;
  first.ended(1006);
  session.payloads.hold('gone', true).getText('payload').insert(0, 'deleted offline');
  expect(session.state.unacked).toBe(true);
  await vi.advanceTimersByTimeAsync(300);
  const socket = latest();
  socket.open();
  const writes = (id: string) => socket.sent.filter((frame) => {
    const payload = frame instanceof Uint8Array ? decodePayloadFrame(frame) : null;
    return payload?.id === id && payload.step !== PAYLOAD_STEP1;
  }).length;
  expect(writes('gone'), 'no element names it: not resent').toBe(0);
  expect(session.state.unacked, 'set aside, not unacked').toBe(false);
  nameInTree('gone');
  expect(writes('gone'), 'an undo or a later update names it: resent').toBe(1);
  expect(session.state.unacked).toBe(true);
});
it('an empty block named while online stays shared: its offline writes after a delete are resent and unacked', async () => {
  const first = latest(); first.open(); session.provider.synced = true;
  // An empty code block: its payload is held fresh and writes nothing, and its element goes out while online.
  session.payloads.hold('shared', true);
  nameInTree('shared');
  first.ended(1006);
  // Offline: a peer filled it meanwhile; this client edits it, then deletes the block.
  session.payloads.get('shared')!.getText('payload').insert(0, 'only copy');
  session.doc.get('root', Y.XmlText).delete(0, 1);
  await vi.advanceTimersByTimeAsync(300);
  const socket = latest();
  socket.open();
  const writes = socket.sent.filter((frame) => {
    const payload = frame instanceof Uint8Array ? decodePayloadFrame(frame) : null;
    return payload?.id === 'shared' && payload.step !== PAYLOAD_STEP1;
  });
  expect(writes.length, 'the server may serve it to peers: resent').toBe(1);
  expect(session.state.unacked, 'an unsaved edit until acked').toBe(true);
});
it('three failed handshakes stop the ladder and ask REST before retrying', async () => {
  const request = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 404 }));
  for (let i = 0; i < 3; i++) { latest().ended(1006); await vi.advanceTimersByTimeAsync(1000); }
  expect(request).toHaveBeenCalledTimes(1);
  expect(terminalOf('doc')).toBe('unavailable');
  expect(session.provider.shouldConnect).toBe(false);
});
it('a demotion requests a fresh read-only binding', async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ role: 'viewer' }));
  latest().open(); session.provider.synced = true;
  session.doc.getText('title').insert(0, 'refused');
  latest().ended(4403);
  await vi.advanceTimersByTimeAsync(300);
  expect(session.state).toMatchObject({ canWrite: false, resync: true });
  expect(sockets).toHaveLength(1);
});
it('a demotion alone keeps the view-only notice; a removal right after it leaves only the ended notice (T3.S20)', async () => {
  const { refusalMessage } = await import('../refusal.ts');
  const VIEW_ONLY = 'You can view this note but can no longer edit it.';
  const access = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ role: 'viewer' }));
  latest().open(); session.provider.synced = true;
  latest().ended(4403);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(refusalMessage(), 'the demotion says the note is view-only').toBe(VIEW_ONLY);
  // The pane rebinds read-only, then the owner removes him within the notice's 4 s.
  session.dispose();
  session = new DocSession('doc', false);
  await session.provider.connect();
  access.mockResolvedValue(new Response('{}', { status: 404 }));
  latest().open(); session.provider.synced = true;
  latest().ended(4403);
  await vi.advanceTimersByTimeAsync(300);
  expect(terminalOf('doc')).toBe('revoked');
  expect(refusalMessage(), 'the ended note no longer says it can be viewed').not.toBe(VIEW_ONLY);
});
it('a refused write requests a fresh binding without retrying the rejected state', async () => {
  latest().open(); session.provider.synced = true;
  latest().ended(4409);
  await vi.advanceTimersByTimeAsync(1000);
  expect(session.state.resync).toBe(true);
  expect(session.provider.shouldConnect).toBe(false);
});
it('the first-sync deadline leaves the doc closed and sign-out stops every socket', async () => {
  latest().open();
  await vi.advanceTimersByTimeAsync(8000);
  expect(session.state).toMatchObject({ synced: false, retrying: true });
  severDocSessions();
  expect(terminalOf('doc')).toBe('session-ended');
  expect(session.provider.shouldConnect).toBe(false);
});

it('a connect requested after a terminal close cannot reopen it', async () => {
  latest().open(); latest().ended(4410);
  await session.provider.connect();
  expect(session.provider.shouldConnect).toBe(false);
  expect(sockets).toHaveLength(1);
});

it('a connection limit preserves a lingering unacked document for Retry', async () => {
  latest().open(); session.provider.synced = true;
  session.doc.getText('title').insert(0, 'pending');
  session.release();
  latest().ended(4429);
  expect(hasUnacked()).toBe(true);
  expect(session.doc.isDestroyed).toBe(false);
  session.retry();
  await vi.advanceTimersByTimeAsync(1);
  expect(sockets).toHaveLength(2);
  expect(session.doc.getText('title').toString()).toBe('pending');
});
it('a repeated 4403 with editor REST access backs off instead of looping immediately', async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ role: 'editor' }));
  latest().open(); latest().ended(4403);
  await vi.advanceTimersByTimeAsync(999);
  expect(sockets).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(sockets).toHaveLength(2);
  latest().open(); latest().ended(4403);
  await vi.advanceTimersByTimeAsync(1999);
  expect(sockets).toHaveLength(2);
  await vi.advanceTimersByTimeAsync(1);
  expect(sockets).toHaveLength(3);
});

it('re-announces unchanged presence every four seconds without changing the caret', async () => {
  latest().open(); session.provider.synced = true;
  const state = { name: 'Ada', anchorPos: { tname: 'root', index: 2 }, focusPos: null, focusing: true };
  session.provider.awareness.setLocalState(state);
  const clock = () => session.provider.awareness.meta.get(session.doc.clientID)?.clock ?? 0;
  const before = clock();
  await vi.advanceTimersByTimeAsync(4_000);
  expect(clock()).toBeGreaterThan(before);
  expect(session.provider.awareness.getLocalState()).toEqual(state);
});

it('a hidden idle tab sends no frames or reconnects and immediately re-announces on return', async () => {
  latest().open(); session.provider.synced = true;
  const state = { name: 'Ada', anchorPos: null, focusPos: null, focusing: false };
  session.provider.awareness.setLocalState(state);
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
  document.dispatchEvent(new Event('visibilitychange'));
  const socket = latest();
  const sent = socket.sent.length;
  const clock = () => session.provider.awareness.meta.get(session.doc.clientID)?.clock ?? 0;
  const before = clock();
  await vi.advanceTimersByTimeAsync(100_000);
  expect(socket.sent).toHaveLength(sent);
  expect(sockets).toHaveLength(1);
  expect(socket.closes).toEqual([]);
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
  document.dispatchEvent(new Event('visibilitychange'));
  expect(clock()).toBeGreaterThan(before);
  expect(session.provider.awareness.getLocalState()).toEqual(state);
  expect(socket.sent.length).toBeGreaterThan(sent);
});

it('a persisted pageshow restores the presence and caret saved before pagehide', async () => {
  latest().open(); session.provider.synced = true;
  const state = { name: 'Ada', anchorPos: { tname: 'root', index: 2 }, focusPos: null, focusing: true };
  session.provider.awareness.setLocalState(state);
  window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
  expect(session.provider.awareness.getLocalState()).toBeNull();
  const sent = latest().sent.length;
  await vi.advanceTimersByTimeAsync(100_000);
  expect(latest().sent).toHaveLength(sent);
  expect(sockets).toHaveLength(1);
  window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
  expect(session.provider.awareness.getLocalState()).toEqual(state);
  expect(latest().sent.length).toBeGreaterThan(sent);
});

it('an ended session sends nothing on its closing socket: no reply to a late server frame, no presence, no edit', async () => {
  latest().open(); session.provider.synced = true;
  session.provider.awareness.setLocalState({ name: 'Ada' });
  session.end('deleted');
  const socket = latest();
  expect(socket.readyState).toBe(FakeSocket.CLOSING);
  const sent = socket.sent.length;
  // A server sync step 1 still in flight when the close began: y-partyserver answers it with a step 2.
  const vector = Y.encodeStateVector(new Y.Doc());
  socket.dispatchEvent(new MessageEvent('message', { data: new Uint8Array([0, 0, vector.length, ...vector]).buffer }));
  session.provider.awareness.setLocalStateField('focusing', false);
  session.doc.getText('title').insert(0, 'late');
  await vi.advanceTimersByTimeAsync(5_000);
  expect(socket.sent).toHaveLength(sent);
});

it.each(['cleared', 'ended', 'released'] as const)('pageshow never revives %s presence', (reason) => {
  latest().open(); session.provider.synced = true;
  session.provider.awareness.setLocalState(reason === 'cleared' ? null : { name: 'Ada' });
  window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
  if (reason === 'ended') session.end('session-ended');
  if (reason === 'released') { session.doc.getText('title').insert(0, 'pending'); session.release(); }
  window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
  expect(session.provider.awareness.getLocalState()).toBeNull();
});

it('a doc left terminal deleted by a trash that never committed reopens editable when its workspace says it changed', async () => {
  const access = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ role: 'editor' }));
  latest().open(); session.provider.synced = true;
  latest().ended(4410);
  expect(terminalOf('doc')).toBe('deleted');
  reopenDocs(['doc']);
  await vi.advanceTimersByTimeAsync(300);
  expect(access, 'it asks REST whether the note is live').toHaveBeenCalledTimes(1);
  expect(terminalOf('doc')).toBeNull();
  expect(session.provider.shouldConnect).toBe(true);
  expect(sockets).toHaveLength(2);
  latest().open();
  session.doc.getText('title').insert(0, 'typed after');
  expect(session.state).toMatchObject({ canWrite: true, unacked: true });
});

it('a doc REST still has in Trash stays terminal, and a live session is left alone', async () => {
  const access = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ deleted: true }));
  reopenDocs(['doc']);
  await vi.advanceTimersByTimeAsync(300);
  expect(access, 'a live session asks nothing').not.toHaveBeenCalled();
  latest().open(); latest().ended(4410);
  reopenDocs(['doc']);
  await vi.advanceTimersByTimeAsync(20_000);
  expect(access).toHaveBeenCalledTimes(1);
  expect(terminalOf('doc')).toBe('deleted');
  expect(sockets).toHaveLength(1);
});

/** The update a sync write frame (`[0, 1|2, varUint8Array]`) carries, else null. */
function writeOf(frame: unknown): Uint8Array | null {
  if (!(frame instanceof Uint8Array) || frame[0] !== 0 || (frame[1] !== 1 && frame[1] !== 2)) return null;
  let length = 0;
  let at = 2;
  for (let shift = 0; at < frame.length; shift += 7) {
    const byte = frame[at++];
    length += (byte & 0x7f) * 2 ** shift;
    if (byte < 0x80) break;
  }
  return frame.subarray(at, at + length);
}
/** The title the sync writes `socket` sent from index `from` on carry, applied to an empty doc. */
function sentTitle(socket: FakeSocket, from = 0): string {
  const doc = new Y.Doc();
  for (const frame of socket.sent.slice(from)) {
    const update = writeOf(frame);
    if (update) Y.applyUpdate(doc, update);
  }
  return doc.getText('title').toString();
}
let peerFrames = 0;
/** Every peer update delivered, as the DocDO holds them. */
const peerUpdates: Uint8Array[] = [];
/** A peer's update arriving on `socket`, stamped on the fake clock as the provider would stamp it. */
function peerUpdate(socket: FakeSocket): void {
  const peer = new Y.Doc();
  peer.getText('peer').insert(0, `${peerFrames++}`);
  peerUpdates.push(Y.encodeStateAsUpdate(peer));
  socket.dispatchEvent(new MessageEvent('message', { data: encodeSyncFrame(2, Y.encodeStateAsUpdate(peer)).slice().buffer }));
  session.provider.wsLastMessageReceived = Date.now();
}
/** A server event on `socket`, as y-partyserver unicasts one. */
function serverEvent(socket: FakeSocket, event: object): void {
  socket.dispatchEvent(new MessageEvent('message', { data: `__YPS:${JSON.stringify(event)}` }));
}
const base64 = (bytes: Uint8Array) => btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(''));
const step1Count = (socket: FakeSocket) => socket.sent.filter((frame) => frame instanceof Uint8Array && frame[0] === 0 && frame[1] === 0).length;

it('detaches a socket that stays open and silent while every tick runs late, once the bounded busy grace runs out, and replays the ledger (B208)', async () => {
  const socket = latest(); socket.open(); session.provider.synced = true;
  session.doc.getText('title').insert(0, 'kept');
  // Every 1 s tick runs 2.5 s late and nothing is ever heard: busy, but the socket is dead too.
  for (let i = 0; i < 60 && !socket.closes.includes(4408); i += 1) {
    vi.setSystemTime(Date.now() + 1_500);
    await vi.advanceTimersByTimeAsync(1_000);
  }
  expect(socket.closes, 'the busy grace is bounded').toContain(4408);
  await vi.advanceTimersByTimeAsync(1_000);
  const fresh = latest();
  expect(fresh, 'it reconnects').not.toBe(socket);
  fresh.open();
  expect(sentTitle(fresh), 'the reconnect replays the unacked edit').toBe('kept');
  expect(session.state.unacked).toBe(true);
});
it('keeps a socket through one long block of the main thread, whose frames are read once it ends (B208)', async () => {
  const socket = latest(); socket.open(); session.provider.synced = true;
  await vi.advanceTimersByTimeAsync(1_000);
  // A collaborator's 40,000-paragraph paste rendered here holds the thread 60 s: the frames sent meanwhile wait behind it.
  vi.setSystemTime(Date.now() + 60_000);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(socket.closes, 'a frame queued behind the block is not silence').toEqual([]);
  peerUpdate(socket);
  await vi.advanceTimersByTimeAsync(5_000);
  expect(socket.closes).toEqual([]);
  expect(sockets).toHaveLength(1);
});
it('keeps a busy tab connected for as long as frames keep arriving (B208)', async () => {
  const socket = latest(); socket.open(); session.provider.synced = true;
  for (let i = 0; i < 60; i += 1) {
    vi.setSystemTime(Date.now() + 1_500);
    await vi.advanceTimersByTimeAsync(1_000);
    if (i % 2 === 0) peerUpdate(socket);
  }
  expect(socket.closes).toEqual([]);
  expect(sockets).toHaveLength(1);
});
it('sends a fresh step 1 once the outstanding one is held back past its maximum, though peer updates keep arriving, and replays the unacked edit (B213)', async () => {
  const socket = latest(); socket.open(); session.provider.synced = true;
  session.doc.getText('title').insert(0, 'unacked');
  expect(step1Count(socket), 'the step 1 on open').toBe(1);
  // The step 2 answering it is lost; a peer's update arrives every second.
  for (let i = 0; i < 60 && step1Count(socket) < 2; i += 1) {
    peerUpdate(socket);
    await vi.advanceTimersByTimeAsync(1_000);
  }
  expect(step1Count(socket), 'a fresh step 1 after the maximum hold-back').toBeGreaterThanOrEqual(2);
  let resent = socket.sent.length - 1;
  while (resent > 0 && !(socket.sent[resent] instanceof Uint8Array && (socket.sent[resent] as Uint8Array)[0] === 0 && (socket.sent[resent] as Uint8Array)[1] === 0)) resent -= 1;
  expect(sentTitle(socket, resent), 'and the unacked edit is replayed').toBe('unacked');
  expect(socket.closes).toEqual([]);
});
it('detaches an outbox stalled at its budget with writes still queued and converges on the next socket, without a reload (B209)', async () => {
  const socket = latest(); socket.open(); session.provider.synced = true;
  // A paste of about 3 MB, past the 1.5 MB budget, in blocks the outbox sends as pieces.
  session.doc.transact(() => {
    session.doc.getArray<Y.Text>('blocks').push(Array.from({ length: 3_000 }, (_, i) => new Y.Text(`${i} ${'x'.repeat(1_000)}`)));
  });
  // Every ack is lost; peer updates keep the socket from reading as silent.
  for (let i = 0; i < 90 && !socket.closes.includes(4408); i += 1) {
    peerUpdate(socket);
    await vi.advanceTimersByTimeAsync(1_000);
  }
  expect(socket.closes, 'stalled at the budget: detached').toContain(4408);
  await vi.advanceTimersByTimeAsync(1_000);
  const fresh = latest();
  expect(fresh).not.toBe(socket);
  fresh.open();
  expect(fresh.sent.some((frame) => writeOf(frame) !== null), 'the ledger replays on the fresh socket').toBe(true);
  // Transport restored: a DocDO that held only the peers' updates applies what the fresh socket sends, and acks that.
  const server = new Y.Doc();
  for (const update of peerUpdates) Y.applyUpdate(server, update);
  let read = 0;
  for (let i = 0; i < 200 && session.state.unacked; i += 1) {
    for (; read < fresh.sent.length; read += 1) {
      const update = writeOf(fresh.sent[read]);
      if (update) Y.applyUpdate(server, update);
    }
    serverEvent(fresh, { t: 'ack', sv: base64(Y.encodeStateVector(server)), ds: base64(Y.encodeSnapshot(Y.createSnapshot(Y.createDeleteSet(), new Map()))) });
    await vi.advanceTimersByTimeAsync(100);
  }
  expect(session.state.unacked, 'every write acked').toBe(false);
  expect(server.store.pendingStructs, 'nothing the server holds waits on a missing write').toBeNull();
  expect(server.getArray('blocks').toJSON(), 'the server converged on the whole paste').toEqual(session.doc.getArray('blocks').toJSON());
  expect(session.state.resync, 'no reload').toBe(false);
  expect(terminalOf('doc')).toBeNull();
  expect(fresh.closes).toEqual([]);
});
/** The paste reservation API (B209), looked up so the rest of the file runs while it is missing. */
type Ticket = { id: string; answer: string; settled: Promise<void>; land(): void; end(): void };
const reservePaste = (doc: Y.Doc, bytes: number): Ticket | null =>
  (sessionModule as { reservePaste?: (doc: Y.Doc, bytes: number) => Ticket | null }).reservePaste?.(doc, bytes) ?? null;
const customSent = (socket: FakeSocket) => socket.sent.filter((frame): frame is string => typeof frame === 'string').map((frame) => JSON.parse(frame.slice('__YPS:'.length)) as { t: string; p?: unknown; b?: number });
/** The tag sent right before each write frame of `socket`, or null for an untagged write. */
const writeTags = (socket: FakeSocket) => socket.sent.flatMap((frame, i) => {
  if (writeOf(frame) === null) return [];
  const before = socket.sent[i - 1];
  return [typeof before === 'string' && before.includes('"t":"paste"') ? (JSON.parse(before.slice('__YPS:'.length)) as { p: string[] }).p : null];
});
it('reserves a large paste by its id before any of it lands, waits for the answer, and tags each frame that writes it (B209)', async () => {
  const socket = latest(); socket.open(); session.provider.synced = true;
  const ticket = reservePaste(session.doc, 1_000);
  expect(ticket, 'a session reserves for its doc').not.toBeNull();
  expect(customSent(socket).at(-1)).toEqual({ t: 'reserve', p: ticket!.id, b: 1_030 });
  expect(ticket!.answer).toBe('pending');
  serverEvent(socket, { t: 'reserved', p: ticket!.id });
  await ticket!.settled;
  expect(ticket!.answer).toBe('reserved');
  ticket!.land();
  session.doc.getText('title').insert(0, 'pasted');
  expect(writeTags(socket), 'the paste\'s frame names it').toEqual([[ticket!.id]]);
  ticket!.end();
  // Still unacked: a later frame may carry the paste's writes, so it names the paste too.
  await vi.advanceTimersByTimeAsync(0);
  session.doc.getText('title').insert(0, 'typed ');
  expect(writeTags(socket).at(-1)).toEqual([ticket!.id]);
  expect(socket.closes).toEqual([]);
});
it('refuses only the new paste when its reserve is refused: nothing of it is written and the socket stays (B209)', async () => {
  const socket = latest(); socket.open(); session.provider.synced = true;
  const ticket = reservePaste(session.doc, 1_000);
  serverEvent(socket, { t: 'reserve-refused', p: ticket!.id });
  await ticket!.settled;
  expect(ticket!.answer).toBe('refused');
  expect(socket.sent.some((frame) => writeOf(frame) !== null)).toBe(false);
  expect(session.state.resync, 'no reload').toBe(false);
  expect(socket.closes).toEqual([]);
});
it('sends an unanswered reserve again on the next socket, and tags the ledger replay with the pastes it carries (B209)', async () => {
  const socket = latest(); socket.open(); session.provider.synced = true;
  const landed = reservePaste(session.doc, 1_000);
  serverEvent(socket, { t: 'reserved', p: landed!.id });
  await landed!.settled;
  landed!.land();
  session.doc.getText('title').insert(0, 'pasted');
  landed!.end();
  const waiting = reservePaste(session.doc, 2_000);
  socket.ended(1006);
  await vi.advanceTimersByTimeAsync(5_000);
  const fresh = latest();
  expect(fresh).not.toBe(socket);
  fresh.open();
  expect(customSent(fresh).filter((event) => event.t === 'reserve'), 'the unanswered reserve, again').toEqual([{ t: 'reserve', p: waiting!.id, b: 2_060 }]);
  expect(writeTags(fresh)[0], 'the replay names the paste whose writes it carries').toEqual([landed!.id]);
  expect(sentTitle(fresh)).toBe('pasted');
});
it('holds the frames of a paste that lands before its answer: a refusal drops them, keeps what went before, and rebinds (B209)', async () => {
  const socket = latest(); socket.open(); session.provider.synced = true;
  session.doc.getText('title').insert(0, 'before ');
  const ticket = reservePaste(session.doc, 1_000);
  // A key pressed while the reserve is unanswered lands the paste at once; its frames wait for the answer.
  ticket!.land();
  session.doc.getText('title').insert(7, 'pasted');
  ticket!.end();
  session.doc.getText('title').insert(13, ' typed');
  expect(sentTitle(socket), 'only the edit before the paste went out').toBe('before ');
  serverEvent(socket, { t: 'reserve-refused', p: ticket!.id });
  await ticket!.settled;
  await vi.advanceTimersByTimeAsync(0);
  expect(sentTitle(socket), 'nothing of the paste, or after it, is sent').toBe('before ');
  expect(session.state.resync, 'the pane rebinds to what the server holds').toBe(true);
  expect(socket.closes).toEqual([]);
});
it('sends the held frames of a paste that landed before its answer once it is reserved (B209)', async () => {
  const socket = latest(); socket.open(); session.provider.synced = true;
  const ticket = reservePaste(session.doc, 1_000);
  ticket!.land();
  session.doc.getText('title').insert(0, 'pasted');
  ticket!.end();
  expect(sentTitle(socket)).toBe('');
  serverEvent(socket, { t: 'reserved', p: ticket!.id });
  await ticket!.settled;
  expect(sentTitle(socket)).toBe('pasted');
  expect(writeTags(socket)).toEqual([[ticket!.id]]);
  expect(session.state.resync).toBe(false);
});
it('counts payloads as the DocDO\'s total plus unacked local growth: a paste that fits only beside the larger of the two is refused, and the ack neither loses nor double-counts the growth (B207)', async () => {
  const { pasteFits } = await import('../large-paste.ts');
  const { countedPayloadBytes, PASTE_LIMIT_BYTES } = sessionModule;
  const socket = latest(); socket.open(); session.provider.synced = true;
  // The DocDO counts 4 MB of withheld payloads this tab does not hold.
  const server = 4_000_000;
  serverEvent(socket, { t: 'usage', pb: server });
  nameInTree('code');
  const payload = session.payloads.hold('code', true);
  payload.getText('payload').insert(0, 'y'.repeat(300_000));
  const grown = Y.encodeStateAsUpdate(payload).byteLength;
  const note = Y.encodeStateAsUpdate(session.doc).byteLength;
  // Fits beside the larger of what this tab holds and what the DocDO last said; not beside that total plus the growth.
  const paste = PASTE_LIMIT_BYTES - note - server - 150_000;
  expect(note + Math.max(grown, server) + paste).toBeLessThanOrEqual(PASTE_LIMIT_BYTES);
  expect(countedPayloadBytes(session.doc), 'the unacked growth counts').toBeGreaterThan(server + grown - 64);
  expect(pasteFits(session.doc, paste, 1_000), 'refused before anything of it is applied').toBe(false);
  // The ack: the DocDO now counts the growth itself.
  const acked = server + grown;
  serverEvent(socket, {
    t: 'ack', sv: base64(Y.encodeStateVector(session.doc)), pb: acked,
    p: { code: { sv: base64(Y.encodeStateVector(payload)) } },
  });
  expect(session.state.unacked).toBe(false);
  expect(countedPayloadBytes(session.doc), 'neither lost nor double-counted').toBe(acked);
  expect(pasteFits(session.doc, PASTE_LIMIT_BYTES - note - acked - 1_000, 1_000)).toBe(true);
});
