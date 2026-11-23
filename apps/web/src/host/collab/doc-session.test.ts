// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { decodePayloadFrame, encodePayloadFrame, encodeSyncFrame, PAYLOAD_STEP1, PAYLOAD_UPDATE } from '@moss-multi/protocol/sync';

const sockets: FakeSocket[] = [];
class FakeSocket extends EventTarget {
  static OPEN = 1;
  static CONNECTING = 0;
  static CLOSED = 3;
  static CLOSING = 2;
  // y-partyserver sends an update only while `ws.readyState === ws.OPEN`.
  readonly OPEN = 1;
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
const { CLIENT_PROTOCOL, PROTOCOL_PARAM } = await import('@moss-multi/protocol/client-protocol');
const { reportOutdated } = await import('../client-protocol.ts');
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
it('asks again at once when a peer update arrives with an earlier one lost, in the note or a payload, once per gap', async () => {
  const socket = latest(); socket.open();
  answer(socket, new Y.Doc());
  await vi.advanceTimersByTimeAsync(1_500);
  const payloadStep1s = () => socket.sent.filter((frame) => frame instanceof Uint8Array && decodePayloadFrame(frame)?.step === PAYLOAD_STEP1).length;
  const receive = (frame: Uint8Array) => {
    socket.dispatchEvent(new MessageEvent('message', { data: frame.slice().buffer }));
    session.provider.wsLastMessageReceived = Date.now();
  };
  // A peer types four characters into the note; the second update is lost on the way.
  const peer = new Y.Doc();
  const updates: Uint8Array[] = [];
  peer.on('update', (update: Uint8Array) => updates.push(update));
  for (const c of 'abcd') peer.getText('peer').insert(peer.getText('peer').length, c);
  receive(encodeSyncFrame(2, updates[0]));
  const before = step1Count(socket);
  receive(encodeSyncFrame(2, updates[2]));
  expect(step1Count(socket), 'a lost update: a step 1 at once, not at the next 4 s one').toBe(before + 1);
  receive(encodeSyncFrame(2, updates[3]));
  expect(step1Count(socket), 'the same gap asks once').toBe(before + 1);
  // The answer fills the gap, then the next update integrates.
  receive(encodeSyncFrame(1, Y.encodeStateAsUpdate(peer, Y.encodeStateVector(session.doc))));
  expect(session.doc.getText('peer').toString()).toBe('abcd');
  await vi.advanceTimersByTimeAsync(1_500);
  // A code block's text: the same in its payload doc, which asks with its own step 1.
  session.payloads.hold('code');
  const code = new Y.Doc();
  const writes: Uint8Array[] = [];
  code.on('update', (update: Uint8Array) => writes.push(update));
  for (const c of 'xyz') code.getText('payload').insert(code.getText('payload').length, c);
  receive(encodePayloadFrame('code', PAYLOAD_UPDATE, writes[0]));
  const notes = step1Count(socket);
  const payloads = payloadStep1s();
  receive(encodePayloadFrame('code', PAYLOAD_UPDATE, writes[2]));
  expect(step1Count(socket), 'a lost payload update: the note asks at once').toBe(notes + 1);
  expect(payloadStep1s(), 'and so does the payload').toBe(payloads + 1);
  expect(socket.closes).toEqual([]);
});
it.each([[4402, 'session-ended'], [4404, 'unavailable'], [4410, 'deleted'], [4426, 'outdated'], [4429, 'conn-limit']] as const)(
  'stops reconnecting synchronously on %s', async (code, reason) => {
    latest().open(); latest().ended(code);
    expect(terminalOf('doc')).toBe(reason);
    expect(session.provider.shouldConnect).toBe(false);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(sockets).toHaveLength(1);
  },
);
it('names its client protocol on the socket, so a server that has moved on can refuse it (rule 10)', () => {
  expect(new URL(latest().url).searchParams.get(PROTOCOL_PARAM)).toBe(String(CLIENT_PROTOCOL));
});
it('ends every session outdated when REST says this bundle is too old', () => {
  latest().open(); session.provider.synced = true;
  reportOutdated();
  expect(terminalOf('doc')).toBe('outdated');
  expect(session.provider.shouldConnect).toBe(false);
});
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
  // The server speaks first (comments.md §6): the backlog is replayed on its step 1, then the payloads resend.
  serverStep1(socket, Y.encodeStateVector(new Y.Doc()));
  await vi.advanceTimersByTimeAsync(1_000);
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
  serverStep1(socket, Y.encodeStateVector(new Y.Doc()));
  await vi.advanceTimersByTimeAsync(1_000);
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
  // The payloads resend once the server's step 1 has been answered (comments.md §6).
  serverStep1(socket, Y.encodeStateVector(new Y.Doc()));
  await vi.advanceTimersByTimeAsync(1_000);
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
it('a suggester whose handshakes keep failing keeps reconnecting with its suggestions unsent, never view-only', async () => {
  const request = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ role: 'suggester' }));
  latest().open(); session.provider.synced = true;
  latest().ended(1006);
  session.sendSuggest({ t: 'suggest-ops', record: 'r1', update: 'AA==' });
  for (let i = 0; i < 3; i++) { await vi.advanceTimersByTimeAsync(1000); latest().ended(1006); }
  await vi.advanceTimersByTimeAsync(300);
  expect(request).toHaveBeenCalledTimes(1);
  const count = sockets.length;
  await vi.advanceTimersByTimeAsync(2_000);
  expect(sockets.length, 'it connects again after asking REST').toBeGreaterThan(count);
  expect(session.state).toMatchObject({ resync: false, unacked: true });
  expect(terminalOf('doc')).toBeNull();
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

/** The Yjs updates a socket sent after its first `from` frames: sync updates (step 2) and step 2 replies (step 1). */
function syncSent(socket: FakeSocket, from = 0): { step: number; update: Uint8Array }[] {
  const out: { step: number; update: Uint8Array }[] = [];
  for (const sent of socket.sent.slice(from)) {
    if (!ArrayBuffer.isView(sent)) continue;
    const frame = new Uint8Array(sent.buffer, sent.byteOffset, sent.byteLength);
    if (frame[0] !== 0 || frame[1] === 0) continue;
    let pos = 2;
    let length = 0;
    for (let scale = 1; ; scale *= 128) {
      const byte = frame[pos++];
      length += (byte & 0x7f) * scale;
      if (byte < 0x80) break;
    }
    out.push({ step: frame[1], update: frame.subarray(pos, pos + length) });
  }
  return out;
}
const serverStep1 = (socket: FakeSocket, vector: Uint8Array) =>
  socket.dispatchEvent(new MessageEvent('message', { data: new Uint8Array([0, 0, vector.length, ...vector]).buffer }));

it('after a reconnect, a write made before the server\'s step 1 waits behind the backlog, also after a cut-off replay', async () => {
  // The DocDO: it refuses a frame whose structs Yjs would park (comments.md §6), so none may arrive ahead of its origin.
  const server = new Y.Doc();
  const deliver = (socket: FakeSocket) => {
    for (const { update } of syncSent(socket)) {
      Y.applyUpdate(server, update);
      expect(server.store.pendingStructs, 'an honest frame never parks').toBeNull();
    }
  };
  const title = session.doc.getText('title');
  const first = latest();
  first.open(); session.provider.synced = true;
  title.insert(0, 'quick brown');
  title.delete(0, 6);
  title.insert(0, 'slow ');
  // Lost in flight: the server never got the first socket's frames.
  first.ended(1006);
  await vi.advanceTimersByTimeAsync(1_000);
  const second = latest();
  expect(second).not.toBe(first);
  second.open();
  // Typed between the socket's open and the server's step 1.
  title.insert(title.length, '!');
  expect(syncSent(second), 'nothing goes ahead of the backlog').toEqual([]);
  serverStep1(second, Y.encodeStateVector(server));
  deliver(second);
  // The replay is cut off after its first frame; the next socket starts over.
  second.ended(1006);
  await vi.advanceTimersByTimeAsync(1_000);
  const third = latest();
  expect(third).not.toBe(second);
  third.open();
  title.insert(0, '>');
  expect(syncSent(third), 'nothing goes ahead of the backlog').toEqual([]);
  serverStep1(third, Y.encodeStateVector(server));
  await vi.advanceTimersByTimeAsync(1_000);
  deliver(third);
  expect(server.getText('title').toString()).toBe(title.toString());
  expect(syncSent(third).at(-1)?.step, 'the step 2 comes after the backlog').toBe(1);
  // Released: a write now goes live.
  const sent = syncSent(third).length;
  title.insert(0, '#');
  expect(syncSent(third)).toHaveLength(sent + 1);
});
it('a suggest request made on a reconnected socket before its sync waits for the fork\'s resume, never naming the old lease', async () => {
  const suggestSent = (socket: FakeSocket) => socket.sent.filter((frame): frame is string => typeof frame === 'string' && frame.includes('"suggest-'));
  const first = latest();
  first.open(); session.provider.synced = true;
  session.sendSuggest({ t: 'suggest-lease', fork: 'fork-0001' });
  expect(suggestSent(first)).toHaveLength(1);
  first.ended(1006);
  await vi.advanceTimersByTimeAsync(1_000);
  const second = latest();
  expect(second).not.toBe(first);
  second.open();
  // Typed between the new socket's open and its sync: the leases still belong to the dropped connection.
  session.sendSuggest({ t: 'suggest-ops', record: 'r1', update: 'AA==' });
  expect(suggestSent(second), 'nothing goes out ahead of the resume').toEqual([]);
  expect(session.state.unacked).toBe(true);
  session.provider.synced = true;
  session.resendSuggest(() => session.sendSuggest({ t: 'suggest-lease', resume: [7], fork: 'fork-0001' }));
  expect(suggestSent(second), 'the resume goes first').toHaveLength(1);
  expect(suggestSent(second)[0]).toContain('"resume"');
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

it('a first sync answered in pieces lands as one change, so the editor writes no empty paragraph ahead of the note (T7.Q)', async () => {
  const { createBinding, syncLexicalUpdateToYjs, syncYjsChangesToLexical } = await import('@lexical/yjs');
  const { $createParagraphNode, $createTextNode, $getRoot } = await import('lexical');
  const { createConverterEditor } = await import('@moss-multi/sync/converter');
  const { excludedPropertiesFor } = await import('@moss-multi/sync/excluded-properties');
  const { splitUpdate } = await import('@moss-multi/sync/update-pieces');
  const noop = () => {};
  const quiet = {
    awareness: { getLocalState: () => null, getStates: () => new Map(), on: noop, off: noop, setLocalState: noop, setLocalStateField: noop },
    connect: noop, disconnect: noop, on: noop, off: noop,
  } as unknown as Parameters<typeof createBinding>[1];
  /** A Lexical editor bound to `doc` before anything reaches it, as the collaboration plugin binds one. */
  const bind = (doc: Y.Doc) => {
    const editor = createConverterEditor();
    const binding = createBinding(editor, quiet, 'root', doc, new Map([['root', doc]]), excludedPropertiesFor(editor));
    editor.registerUpdateListener(({ prevEditorState, editorState, dirtyElements, dirtyLeaves, normalizedNodes, tags }) => {
      syncLexicalUpdateToYjs(binding, quiet, prevEditorState, editorState, dirtyElements, dirtyLeaves, normalizedNodes, tags);
    });
    binding.root.getSharedType().observeDeep((events, transaction) => {
      if (transaction.origin !== binding) syncYjsChangesToLexical(binding, quiet, events as never, false, noop);
    });
    return editor;
  };
  /** One server write under its own Yjs client, as each DocDO write's mirror makes one. */
  const write = (server: Y.Doc, client: number, edit: () => void) => {
    const mirror = new Y.Doc();
    mirror.clientID = client;
    const editor = bind(mirror);
    Y.applyUpdate(mirror, Y.encodeStateAsUpdate(server));
    editor.update(noop, { discrete: true });
    editor.update(edit, { discrete: true });
    Y.applyUpdate(server, Y.encodeStateAsUpdate(mirror, Y.encodeStateVector(server)));
  };
  const paragraph = (text: string) => $createParagraphNode().append($createTextNode(text));
  const server = new Y.Doc();
  // The seed, the import that replaced it, then an agent's large push. Yjs writes higher clients first, so the answer's
  // first piece holds the deleted seed and push blocks that wait on the import, which comes last.
  write(server, 900, () => { $getRoot().append($createParagraphNode()); });
  write(server, 100, () => { $getRoot().clear().append(paragraph('The first line.')); });
  write(server, 500, () => {
    for (let i = 0; i < 200; i += 1) $getRoot().append(paragraph(`Paragraph ${i}: the beans climb the trellis.`));
  });
  const pieces = splitUpdate(Y.encodeStateAsUpdate(server), 4_096).map((piece) => piece.update);
  expect(pieces.length, 'the answer comes in pieces').toBeGreaterThan(2);

  // The lowest client, so a paragraph it wrote would sort ahead of the import's; the awareness keeps its own id.
  const clientID = session.doc.clientID;
  session.doc.clientID = 1;
  try {
    const editor = bind(session.doc);
    const local: unknown[] = [];
    session.doc.on('update', (_update: Uint8Array, origin: unknown) => {
      if (origin !== session.provider) local.push(origin);
    });
    const socket = latest(); socket.open();
    for (const [index, piece] of pieces.entries()) {
      socket.dispatchEvent(new MessageEvent('message', { data: encodeSyncFrame(index === pieces.length - 1 ? 1 : 2, piece).slice().buffer }));
      // Each frame is its own task in the browser: Lexical commits what it reconciled before the next one is read.
      await vi.advanceTimersByTimeAsync(0);
      for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
    }
    expect(session.state.synced).toBe(true);
    expect(local, 'opening the note writes nothing to it').toEqual([]);
    const blocks = editor.getEditorState().read(() => $getRoot().getChildren().map((node) => node.getTextContent()));
    expect(blocks[0], 'the note opens on its first line').toBe('The first line.');
    expect(blocks).toHaveLength(201);
  } finally {
    session.doc.clientID = clientID;
  }
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
  // The backlog replays on the server's step 1 (comments.md §6).
  serverStep1(fresh, Y.encodeStateVector(new Y.Doc()));
  await vi.advanceTimersByTimeAsync(1_000);
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
it('reads a socket that hears only server events (acks) as alive, not silent', async () => {
  const socket = latest(); socket.open(); session.provider.synced = true;
  const ds = base64(Y.encodeSnapshot(Y.createSnapshot(Y.createDeleteSet(), new Map())));
  for (let i = 0; i < 30; i += 1) {
    serverEvent(socket, { t: 'ack', sv: base64(Y.encodeStateVector(session.doc)), ds });
    await vi.advanceTimersByTimeAsync(1_000);
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
  // The backlog replays on the server's step 1 (comments.md §6), stamped on the fake clock as the provider would stamp it.
  serverStep1(fresh, Y.encodeStateVector(new Y.Doc()));
  session.provider.wsLastMessageReceived = Date.now();
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
it('counts a payload write the DocDO\'s usage figure already includes once, though its ack was lost (B207)', async () => {
  const { countedPayloadBytes } = sessionModule;
  const socket = latest(); socket.open(); session.provider.synced = true;
  nameInTree('code');
  const payload = session.payloads.hold('code', true);
  payload.getText('payload').insert(0, 'y'.repeat(100_000));
  // The write persisted and its ack was lost with the socket: the next connect's usage figure includes it.
  socket.ended(1006);
  await vi.advanceTimersByTimeAsync(5_000);
  const fresh = latest(); fresh.open();
  const persisted = 4_000_000 + Y.encodeStateAsUpdate(payload).byteLength;
  serverEvent(fresh, { t: 'usage', pb: persisted });
  expect(countedPayloadBytes(session.doc), 'counted once').toBe(persisted);
  payload.getText('payload').insert(0, 'z'.repeat(10_000));
  const grown = countedPayloadBytes(session.doc) - persisted;
  expect(grown, 'growth after the figure still counts').toBeGreaterThanOrEqual(10_000);
  expect(grown).toBeLessThan(10_200);
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
it('a doc-cap refusal says which limit it met: the text limit, the structure limit, or the bytes notice as before (T3.B31c)', async () => {
  const { refusalMessage } = await import('../refusal.ts');
  const socket = latest(); socket.open(); session.provider.synced = true;
  serverEvent(socket, { t: 'write-refused', reason: 'doc-cap', limit: 'text' });
  expect(refusalMessage()).toBe('This note has reached its size limit (1.02 million characters).');
  serverEvent(socket, { t: 'write-refused', reason: 'doc-cap', limit: 'structure' });
  expect(refusalMessage()).toBe('This note is too big to add to: it has too many separate lines, cells or past edits. Continue in a new note.');
  serverEvent(socket, { t: 'write-refused', reason: 'doc-cap' });
  expect(refusalMessage()).toBe('This note is at its size limit, so your last change was not saved.');
});
it('a paste is refused whole before it applies when it would take the note past 1,020,000 characters or 165,000 structs, counting the payloads the tab holds; one just under lands (T3.B31c)', async () => {
  const { pasteFits } = await import('../large-paste.ts');
  const socket = latest(); socket.open(); session.provider.synced = true;
  // 900,000 characters in the body and 100,000 in a code block the tree names.
  session.doc.get('root', Y.XmlText).insert(0, 'a'.repeat(900_000));
  nameInTree('code');
  session.payloads.hold('code', true).getText('payload').insert(0, 'c'.repeat(100_000));
  expect(pasteFits(session.doc, 1_000, 1_000, { chars: 20_000, structs: 10 }), 'up to the text cap fits').toBe(true);
  expect(pasteFits(session.doc, 1_000, 1_000, { chars: 20_001, structs: 10 }), 'one character past it is refused').toBe(false);
  const structs = [...session.doc.store.clients.values(), ...[...session.payloads.docs.values()].flatMap((doc) => [...doc.store.clients.values()])]
    .reduce((sum, list) => sum + list.length, 0);
  // A paste's own batches may split up to 256 structs its replay does not.
  expect(pasteFits(session.doc, 1_000, 1_000, { chars: 10, structs: 165_000 - structs - 256 }), 'up to the structure cap fits').toBe(true);
  expect(pasteFits(session.doc, 1_000, 1_000, { chars: 10, structs: 165_000 - structs - 255 }), 'past it is refused').toBe(false);
});
it('a paste waits for a payload doc the note names that is still arriving, so its text counts when the paste is checked (T3.B31c)', async () => {
  const { pasteFits, payloadsArrive } = await import('../large-paste.ts');
  const socket = latest(); socket.open(); session.provider.synced = true;
  session.doc.get('root', Y.XmlText).insert(0, 'a'.repeat(900_000));
  nameInTree('code');
  const code = session.payloads.hold('code', true);
  session.payloads.await('code');
  const wait = payloadsArrive(session.doc, () => false);
  expect(wait.next().done, 'waits while the code block\'s text is on its way').toBe(false);
  expect(wait.next().done).toBe(false);
  code.getText('payload').insert(0, 'c'.repeat(100_000));
  session.payloads.arrived('code');
  expect(wait.next().done, 'goes on once it arrived').toBe(true);
  expect(pasteFits(session.doc, 1_000, 1_000, { chars: 20_001, structs: 10 }), 'and its text counts').toBe(false);
});
it('a paste stops waiting for an arriving payload doc after 10 seconds, or at once when other input lands it (T3.B31c)', async () => {
  const { payloadsArrive } = await import('../large-paste.ts');
  const socket = latest(); socket.open(); session.provider.synced = true;
  nameInTree('code');
  session.payloads.hold('code', true);
  session.payloads.await('code');
  const wait = payloadsArrive(session.doc, () => false);
  expect(wait.next().done).toBe(false);
  vi.advanceTimersByTime(10_001);
  expect(wait.next().done, 'past the wait').toBe(true);
  let flushing = false;
  const flushed = payloadsArrive(session.doc, () => flushing);
  expect(flushed.next().done).toBe(false);
  flushing = true;
  expect(flushed.next().done, 'landed by other input').toBe(true);
  expect(payloadsArrive(undefined, () => false).next().done, 'no note, nothing to wait for').toBe(true);
});
it('a code block deleted in this tab stops counting toward the paste check at once, as the server stops counting it (T3.B31c)', async () => {
  const { pasteFits } = await import('../large-paste.ts');
  const socket = latest(); socket.open(); session.provider.synced = true;
  session.doc.get('root', Y.XmlText).insert(0, 'a'.repeat(900_000));
  nameInTree('code');
  session.payloads.hold('code', true).getText('payload').insert(0, 'c'.repeat(100_000));
  // A payload the tab holds but its tree does not name (one minted, then its block deleted) counts nothing either.
  session.payloads.hold('stray', true).getText('payload').insert(0, 's'.repeat(50_000));
  expect(pasteFits(session.doc, 1_000, 1_000, { chars: 100_000, structs: 10 }), 'with the block named, the paste does not fit').toBe(false);
  // The block is deleted (the root holds it first), its payload doc still held.
  session.doc.get('root', Y.XmlText).delete(0, 1);
  expect(session.payloads.get('code'), 'the tab still holds its doc').toBeDefined();
  expect(pasteFits(session.doc, 1_000, 1_000, { chars: 120_000, structs: 10 }), 'its text no longer counts').toBe(true);
  expect(pasteFits(session.doc, 1_000, 1_000, { chars: 120_001, structs: 10 }), 'up to the limit, and no further').toBe(false);
});

// ---------- T3.B32: a paste that cannot finish leaves nothing behind ----------

const PASTE_ROLLED_BACK = "The paste didn't fit, so nothing was pasted.";
const PASTE_PARTLY_KEPT = "The paste didn't fit. It was removed, except for what someone else had already edited.";
const ROLLBACK_PREFIX = 'moss-multi:paste-rollback:doc:';
const rollbackKey = (client: number, from: number) => `${ROLLBACK_PREFIX}${client}:${from}`;
/** The pastes this profile stores for 'doc', by key. */
function storedPastes(): Record<string, unknown> {
  const found: Record<string, unknown> = {};
  for (let i = 0; i < localStorage.length; i += 1) {
    const key = localStorage.key(i)!;
    if (key.startsWith(ROLLBACK_PREFIX)) found[key] = JSON.parse(localStorage.getItem(key)!);
  }
  return found;
}
/** The update frames (sync type 2) a socket sent. */
const updatesSent = (socket: FakeSocket) => socket.sent.filter((frame): frame is Uint8Array => frame instanceof Uint8Array && frame[0] === 0 && frame[1] === 2);
/** The update a sync frame carries. */
function updateOf(frame: Uint8Array): Uint8Array {
  let at = 2;
  let length = 0;
  for (let shift = 0; ; shift += 7) {
    const byte = frame[at++];
    length += (byte & 0x7f) * 2 ** shift;
    if (byte < 0x80) break;
  }
  return frame.subarray(at, at + length);
}
/** The deletes a sync frame carries, as [client, clock, length]. */
function deletesOf(frame: Uint8Array): number[][] {
  const ranges: number[][] = [];
  Y.decodeUpdate(updateOf(frame)).ds.clients.forEach((items, client) => {
    for (const { clock, len } of items) ranges.push([client, clock, len]);
  });
  return ranges;
}
const trackPaste = (doc: Y.Doc, abort: () => void) =>
  (sessionModule as unknown as { trackPaste?: (doc: Y.Doc, abort: () => void) => { finish(): void } | null }).trackPaste?.(doc, abort) ?? null;
const rootText = () => session.doc.get('root', Y.XmlText).toString();

/** A fresh profile whose role on the doc is editor (earlier tests demote it). */
async function freshProfile(): Promise<void> {
  const { rememberRole } = await import('../access.ts');
  rememberRole('doc', 'editor');
  localStorage.clear();
}

/**
 * A paste of `batches` updates in another tab's doc, after 'Kept.' that the server holds: the server takes the first
 * `landed` of them. Returns the server's doc and the paste's record, as the refused tab stored it.
 */
function cutPaste(batches: number, landed: number) {
  const server = new Y.Doc();
  server.get('root', Y.XmlText).insert(0, 'Kept.');
  const tab = new Y.Doc();
  Y.applyUpdate(tab, Y.encodeStateAsUpdate(server));
  const updates: Uint8Array[] = [];
  tab.on('update', (update: Uint8Array) => updates.push(update));
  const from = Y.getState(tab.store, tab.clientID);
  const root = tab.get('root', Y.XmlText);
  for (let i = 0; i < batches; i += 1) root.insert(root.length, ` Alpha ${i}.`);
  for (const update of updates.slice(0, landed)) Y.applyUpdate(server, update);
  const record = { note: { client: tab.clientID, from, to: Y.getState(tab.store, tab.clientID) }, payloads: {} };
  return { server, record, key: rollbackKey(tab.clientID, from) };
}

/** The server's copy arrives as the answer to the session's step 1. */
function answer(socket: FakeSocket, server: Y.Doc): void {
  // The provider sends a local update only on a socket whose own OPEN matches its state, as a browser's does.
  Object.assign(socket, { OPEN: FakeSocket.OPEN });
  socket.dispatchEvent(new MessageEvent('message', { data: encodeSyncFrame(1, Y.encodeStateAsUpdate(server)).slice().buffer }));
}

/** The ack covering every write of the session's doc, its deletes included. */
function ackAll(socket: FakeSocket): void {
  const ds = Y.encodeSnapshot(Y.createSnapshot(Y.createDeleteSetFromStructStore(session.doc.store), new Map()));
  serverEvent(socket, { t: 'ack', sv: base64(Y.encodeStateVector(session.doc)), ds: base64(ds) });
}

/** A fresh session on 'doc' whose socket is open. */
async function reopen(canWrite = true): Promise<FakeSocket> {
  session.dispose();
  session = new DocSession('doc', canWrite);
  await session.provider.connect();
  const socket = latest();
  socket.open();
  return socket;
}

it('a large paste cut short by a limit stops landing, says nothing was pasted and stores its items under the doc, client id and its first clock (T3.B32)', async () => {
  const { refusalMessage } = await import('../refusal.ts');
  await freshProfile();
  const socket = latest(); socket.open(); session.provider.synced = true;
  const root = session.doc.get('root', Y.XmlText);
  root.insert(0, 'Kept.');
  const abort = vi.fn();
  const from = Y.getState(session.doc.store, session.doc.clientID);
  const track = trackPaste(session.doc, abort);
  expect(track, 'a session tracks the paste').not.toBeNull();
  const code = session.payloads.hold('code', true);
  code.getText('payload').insert(0, 'c'.repeat(40));
  root.insert(root.length, 'Alpha'.repeat(100));
  track?.finish();
  serverEvent(socket, { t: 'write-refused', reason: 'doc-cap', limit: 'structure' });
  expect(abort, 'nothing more of the paste lands').toHaveBeenCalled();
  expect(refusalMessage()).toBe(PASTE_ROLLED_BACK);
  expect(storedPastes()).toEqual({
    [rollbackKey(session.doc.clientID, from)]: {
      note: { client: session.doc.clientID, from, to: from + 500 },
      payloads: { code: { client: code.clientID, from: 0, to: 40 } },
      deletes: [],
    },
  });
  socket.ended(4409);
  expect(refusalMessage(), 'the close says it again').toBe(PASTE_ROLLED_BACK);
  expect(session.state.resync).toBe(true);
});

it("a large paste's record holds the deletes it made in a payload doc it made, so its rollback tells another writer's apart (T3.B32)", async () => {
  await freshProfile();
  const socket = latest(); socket.open(); session.provider.synced = true;
  const track = trackPaste(session.doc, () => {});
  const code = session.payloads.hold('code', true);
  code.getText('payload').insert(0, 'c'.repeat(40));
  code.getText('payload').delete(0, 5);
  session.doc.get('root', Y.XmlText).insert(0, 'Alpha');
  track?.finish();
  serverEvent(socket, { t: 'write-refused', reason: 'doc-cap', limit: 'structure' });
  const [stored] = Object.values(storedPastes()) as { payloads: Record<string, unknown> }[];
  expect(stored.payloads.code).toEqual({ client: code.clientID, from: 0, to: 40, deletes: [[code.clientID, 0, 5]] });
});

it('two large pastes still unacked when a limit refuses a write each keep their own record (T3.B32)', async () => {
  await freshProfile();
  const socket = latest(); socket.open(); session.provider.synced = true;
  const root = session.doc.get('root', Y.XmlText);
  const client = session.doc.clientID;
  const first = trackPaste(session.doc, () => {});
  root.insert(0, 'Alpha'.repeat(10));
  first?.finish();
  // The second paste lands the first at once (pasteLarge flushes it) and starts its own record.
  const second = trackPaste(session.doc, () => {});
  root.insert(root.length, 'Bravo'.repeat(10));
  second?.finish();
  serverEvent(socket, { t: 'write-refused', reason: 'doc-cap', limit: 'text' });
  const stored = storedPastes();
  expect(Object.keys(stored).sort()).toEqual([rollbackKey(client, 0), rollbackKey(client, 50)].sort());
  expect(stored[rollbackKey(client, 0)]).toMatchObject({ note: { client, from: 0, to: 50 } });
  expect(stored[rollbackKey(client, 50)]).toMatchObject({ note: { client, from: 50, to: 100 } });
});

it('a large paste that replaced a selection sends its deletes only once all its items are acked, so a cut one leaves the selection and its rollback the note as it was (T3.B32)', async () => {
  await freshProfile();
  const server = new Y.Doc();
  server.get('root', Y.XmlText).insert(0, 'Kept. Tail.');
  let socket = latest(); socket.open();
  answer(socket, server);
  await vi.advanceTimersByTimeAsync(1);
  expect(session.state.synced).toBe(true);
  const root = session.doc.get('root', Y.XmlText);
  const sent = updatesSent(socket).length;
  const track = trackPaste(session.doc, () => {});
  // The first batch replaces the selected 'Kept.', the second adds to it.
  session.doc.transact(() => {
    root.delete(0, 5);
    root.insert(0, 'Alpha 0.');
  });
  root.insert(8, ' Alpha 1.');
  track?.finish();
  const frames = updatesSent(socket).slice(sent);
  expect(frames, 'each batch goes out').toHaveLength(2);
  expect(frames.flatMap(deletesOf), "without the paste's deletes").toEqual([]);
  Y.applyUpdate(server, updateOf(frames[0]));
  expect(server.get('root', Y.XmlText).toString(), 'the selection stays on the server while the paste lands').toBe('Kept.Alpha 0. Tail.');

  // Its second batch is refused for a limit: the next binding rolls the paste back.
  serverEvent(socket, { t: 'write-refused', reason: 'doc-cap', limit: 'text' });
  socket.ended(4409);
  socket = await reopen();
  answer(socket, server);
  await vi.advanceTimersByTimeAsync(1);
  expect(rootText(), 'the note as it was before the paste').toBe('Kept. Tail.');
  Y.applyUpdate(server, Y.encodeStateAsUpdate(session.doc));
  expect(server.get('root', Y.XmlText).toString(), 'on the server too').toBe('Kept. Tail.');
});

it('a large paste that landed whole sends the deletes it held back once its items are acked (T3.B32)', async () => {
  await freshProfile();
  const server = new Y.Doc();
  server.get('root', Y.XmlText).insert(0, 'Kept. Tail.');
  const socket = latest(); socket.open();
  answer(socket, server);
  await vi.advanceTimersByTimeAsync(1);
  const root = session.doc.get('root', Y.XmlText);
  const sent = updatesSent(socket).length;
  const track = trackPaste(session.doc, () => {});
  session.doc.transact(() => {
    root.delete(0, 5);
    root.insert(0, 'Alpha 0.');
  });
  track?.finish();
  expect(updatesSent(socket).slice(sent).flatMap(deletesOf), 'held back').toEqual([]);
  serverEvent(socket, { t: 'ack', sv: base64(Y.encodeStateVector(session.doc)) });
  const release = updatesSent(socket).slice(sent + 1);
  expect(release, 'one delete-only frame once the items are acked').toHaveLength(1);
  expect(Y.decodeUpdate(updateOf(release[0])).structs).toEqual([]);
  expect(deletesOf(release[0])).toEqual([[server.clientID, 0, 5]]);
  for (const frame of updatesSent(socket).slice(sent)) Y.applyUpdate(server, updateOf(frame));
  expect(server.get('root', Y.XmlText).toString()).toBe('Alpha 0. Tail.');
  ackAll(socket);
  expect(session.state.unacked).toBe(false);
});

it('the next binding deletes the landed part of a cut paste before the note shows, and keeps its record until the deletes are acked; reopened before that, it resumes (T3.B32)', async () => {
  const { refusalMessage } = await import('../refusal.ts');
  await freshProfile();
  const { server, record, key } = cutPaste(6, 3);
  expect(server.get('root', Y.XmlText).toString(), 'half the paste landed').toBe('Kept. Alpha 0. Alpha 1. Alpha 2.');
  localStorage.setItem(key, JSON.stringify(record));
  let socket = latest(); socket.open();
  answer(socket, server);
  expect(session.state.synced, 'the note stays closed while the rollback runs').toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(session.state.synced).toBe(true);
  expect(rootText(), 'nothing of the paste shows').toBe('Kept.');
  expect(updatesSent(socket).length, 'the deletes go out').toBeGreaterThan(0);
  expect(refusalMessage()).toBe(PASTE_ROLLED_BACK);
  expect(session.state.unacked).toBe(true);
  expect(storedPastes()[key], 'kept until acked, its verdict with it').toMatchObject({ decided: 'cut' });

  // The tab closes before the deletes reach the server: the note reopened in this profile rolls the paste back again.
  socket = await reopen();
  answer(socket, server);
  await vi.advanceTimersByTimeAsync(1);
  expect(rootText()).toBe('Kept.');
  Y.applyUpdate(server, Y.encodeStateAsUpdate(session.doc));
  expect(server.get('root', Y.XmlText).toString(), 'the server holds the note as it was before the paste').toBe('Kept.');
  ackAll(socket);
  expect(session.state.unacked).toBe(false);
  expect(storedPastes(), 'acked: done').toEqual({});
});

it('a paste found cut short stays cut short when reopened, even once all its clocks read as landed (T3.B32)', async () => {
  await freshProfile();
  // Deletes never lower a clock: a rollback half done, or a paste whose payload frame was refused, reads as whole.
  const { server, record, key } = cutPaste(4, 4);
  localStorage.setItem(key, JSON.stringify({ ...record, decided: 'cut' }));
  const socket = latest(); socket.open();
  answer(socket, server);
  await vi.advanceTimersByTimeAsync(1);
  expect(rootText(), 'rolled back as first decided').toBe('Kept.');
  expect(updatesSent(socket).length).toBeGreaterThan(0);
});

it('a paste that landed whole is left as it is, and its record dropped (T3.B32)', async () => {
  await freshProfile();
  const { server, record, key } = cutPaste(4, 4);
  localStorage.setItem(key, JSON.stringify(record));
  const socket = latest(); socket.open();
  answer(socket, server);
  await vi.advanceTimersByTimeAsync(1);
  expect(session.state.synced).toBe(true);
  expect(rootText()).toBe('Kept. Alpha 0. Alpha 1. Alpha 2. Alpha 3.');
  expect(updatesSent(socket)).toHaveLength(0);
  expect(session.state.unacked).toBe(false);
  expect(storedPastes()).toEqual({});
});

it('a paste whose payload docs are slow to arrive is settled once they have, never read as cut short meanwhile (T3.B32)', async () => {
  await freshProfile();
  const { server, record, key } = cutPaste(4, 4);
  // The paste's code block landed whole too, its doc still on its way to this tab.
  const element = new Y.XmlElement('code-block');
  element.setAttribute('__type', 'code-block');
  element.setAttribute('__regId', 'code');
  server.get('root', Y.XmlText).insertEmbed(0, element);
  const code = new Y.Doc();
  code.getText('payload').insert(0, 'c'.repeat(40));
  localStorage.setItem(key, JSON.stringify({ ...record, payloads: { code: { client: code.clientID, from: 0, to: 40 } } }));
  // The binding holds the note's tree as it opens, so the rollback reads which payloads it names.
  session.doc.get('root', Y.XmlText);
  session.payloads.hold('code');
  session.payloads.await('code');
  const socket = latest(); socket.open();
  answer(socket, server);
  await vi.advanceTimersByTimeAsync(10_001);
  expect(session.state.synced, 'the note shows after 10 s').toBe(true);
  expect(rootText(), 'the paste stays').toContain('Alpha 3.');
  expect(updatesSent(socket)).toHaveLength(0);
  expect(storedPastes()[key], 'not settled yet').toBeDefined();
  // Its state arrives from the server, as the payload sync applies it.
  Y.applyUpdate(session.payloads.get('code')!, Y.encodeStateAsUpdate(code), session.provider);
  session.payloads.arrived('code');
  await vi.advanceTimersByTimeAsync(1);
  expect(rootText(), 'it landed whole').toContain('Alpha 3.');
  expect(updatesSent(socket)).toHaveLength(0);
  expect(storedPastes()).toEqual({});
});

it('without write access the landed part stays: a read-only binding tries nothing, and a rollback refused in its turn is never tried again (T3.B32)', async () => {
  await freshProfile();
  const { server, record, key } = cutPaste(6, 3);
  const landed = server.get('root', Y.XmlText).toString();
  localStorage.setItem(key, JSON.stringify(record));
  // Demoted to viewer meanwhile: the pane binds read-only.
  let socket = await reopen(false);
  answer(socket, server);
  await vi.advanceTimersByTimeAsync(1);
  expect(session.state.synced).toBe(true);
  expect(rootText(), 'the documented residual').toBe(landed);
  expect(updatesSent(socket)).toHaveLength(0);
  expect(storedPastes()).toEqual({});

  // Write access the tab still believed it had: the DocDO refuses the deletes, and nothing tries them again.
  localStorage.setItem(key, JSON.stringify(record));
  socket = await reopen();
  answer(socket, server);
  await vi.advanceTimersByTimeAsync(1);
  expect(updatesSent(socket).length).toBeGreaterThan(0);
  serverEvent(socket, { t: 'write-refused', reason: 'role' });
  socket.ended(4409);
  expect(storedPastes()).toEqual({});
  socket = await reopen();
  answer(socket, server);
  await vi.advanceTimersByTimeAsync(1);
  expect(rootText()).toBe(landed);
  expect(updatesSent(socket), 'no loop').toHaveLength(0);
});

it('a person demoted mid-paste stores nothing: the part that landed stays, as documented (T3.B32)', async () => {
  await freshProfile();
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ role: 'viewer' }));
  const socket = latest(); socket.open(); session.provider.synced = true;
  const root = session.doc.get('root', Y.XmlText);
  const track = trackPaste(session.doc, () => {});
  root.insert(0, 'Alpha'.repeat(100));
  track?.finish();
  serverEvent(socket, { t: 'write-refused', reason: 'role' });
  socket.ended(4403);
  await vi.advanceTimersByTimeAsync(300);
  expect(session.state).toMatchObject({ canWrite: false, resync: true });
  expect(localStorage.length).toBe(0);
});

/**
 * Another tab's paste of a code block and a line after 'Kept.', all of it on the server and stored as cut short; the
 * code block's payload doc holds the paste's 'print(1)' and, when given, `peer` typed in by another writer.
 */
function cutCodePaste(peer?: string, { peerDeletes = false, ownDeletes = false } = {}) {
  const server = new Y.Doc();
  server.get('root', Y.XmlText).insert(0, 'Kept.');
  const tab = new Y.Doc();
  Y.applyUpdate(tab, Y.encodeStateAsUpdate(server));
  const from = Y.getState(tab.store, tab.clientID);
  const element = new Y.XmlElement('code-block');
  element.setAttribute('__type', 'code-block');
  element.setAttribute('__regId', 'code');
  tab.get('root', Y.XmlText).insertEmbed(5, element);
  tab.get('root', Y.XmlText).insert(6, ' Alpha.');
  Y.applyUpdate(server, Y.encodeStateAsUpdate(tab));
  const code = new Y.Doc();
  code.getText('payload').insert(0, ownDeletes ? 'print(1)x' : 'print(1)');
  if (ownDeletes) code.getText('payload').delete(8, 1);
  const payload = new Y.Doc();
  Y.applyUpdate(payload, Y.encodeStateAsUpdate(code));
  if (peer) payload.getText('payload').insert(0, peer);
  if (peerDeletes) payload.getText('payload').delete(0, 2);
  const key = rollbackKey(tab.clientID, from);
  localStorage.setItem(key, JSON.stringify({
    note: { client: tab.clientID, from, to: Y.getState(tab.store, tab.clientID) },
    payloads: { code: ownDeletes ? { client: code.clientID, from: 0, to: 9, deletes: [[code.clientID, 8, 1]] } : { client: code.clientID, from: 0, to: 8 } },
    decided: 'cut',
  }));
  // The binding holds the note's tree as it opens; the payload doc is on its way.
  session.doc.get('root', Y.XmlText);
  session.payloads.hold('code');
  session.payloads.await('code');
  const socket = latest(); socket.open();
  answer(socket, server);
  const arrive = () => {
    Y.applyUpdate(session.payloads.get('code')!, Y.encodeStateAsUpdate(payload), session.provider);
    session.payloads.arrived('code');
  };
  return { key, arrive };
}
const codeText = () => session.payloads.get('code')!.getText('payload').toString();

it("a cut paste's code block another writer typed into stays whole, the paste's code too, and the notice says so (T3.B32)", async () => {
  const { namedPayloadIds } = await import('@moss-multi/sync/payload-docs');
  const { refusalMessage } = await import('../refusal.ts');
  await freshProfile();
  const { arrive } = cutCodePaste('ben();');
  arrive();
  await vi.advanceTimersByTimeAsync(1);
  expect(session.state.synced).toBe(true);
  expect(rootText(), "the paste's line goes").not.toContain('Alpha');
  expect([...namedPayloadIds(session.doc)], 'the code block stays named').toEqual(['code']);
  expect(codeText(), "the other writer's code and the paste's, as it stood").toBe('ben();print(1)');
  expect(refusalMessage()).toBe(PASTE_PARTLY_KEPT);
});

it("a cut paste's code block another writer only deleted from stays whole, and the notice says so (T3.B32)", async () => {
  const { namedPayloadIds } = await import('@moss-multi/sync/payload-docs');
  const { refusalMessage } = await import('../refusal.ts');
  await freshProfile();
  const { arrive } = cutCodePaste(undefined, { peerDeletes: true });
  arrive();
  await vi.advanceTimersByTimeAsync(1);
  expect(rootText(), "the paste's line goes").not.toContain('Alpha');
  expect([...namedPayloadIds(session.doc)], 'the code block stays named').toEqual(['code']);
  expect(codeText(), 'as it stood').toBe('int(1)');
  expect(refusalMessage()).toBe(PASTE_PARTLY_KEPT);
});

it("a cut paste's code block holding only the paste's own deletes goes whole (T3.B32)", async () => {
  const { namedPayloadIds } = await import('@moss-multi/sync/payload-docs');
  const { refusalMessage } = await import('../refusal.ts');
  await freshProfile();
  const { arrive } = cutCodePaste(undefined, { ownDeletes: true });
  arrive();
  await vi.advanceTimersByTimeAsync(1);
  expect(rootText()).not.toContain('Alpha');
  expect([...namedPayloadIds(session.doc)]).toEqual([]);
  expect(refusalMessage()).toBe(PASTE_ROLLED_BACK);
});

it('a paste already found cut short waits for its payload docs too, and once they arrive deletes its block whole, leaving the payload as it was (T3.B32)', async () => {
  const { refusalMessage } = await import('../refusal.ts');
  const { namedPayloadIds } = await import('@moss-multi/sync/payload-docs');
  await freshProfile();
  const { key, arrive } = cutCodePaste();
  await vi.advanceTimersByTimeAsync(10_001);
  expect(session.state.synced, 'the note shows after 10 s').toBe(true);
  expect(rootText(), 'not rolled back while its code block is on its way').toContain('Alpha');
  expect(storedPastes()[key], 'not settled yet').toBeDefined();
  arrive();
  await vi.advanceTimersByTimeAsync(1);
  expect(rootText()).not.toContain('Alpha');
  expect([...namedPayloadIds(session.doc)]).toEqual([]);
  expect(codeText(), 'nothing inside the payload is deleted').toBe('print(1)');
  expect(refusalMessage()).toBe(PASTE_ROLLED_BACK);
});

it('tracks an Edit-mode paste for rollback but never a Suggest-mode one, whose fork keeps its own path (T5.W)', async () => {
  const { registerFork } = await import('@moss-multi/sync/suggest/forks');
  const track = (sessionModule as unknown as { trackPaste?: (doc: Y.Doc, abort: () => void) => unknown }).trackPaste;
  const socket = latest(); socket.open(); session.provider.synced = true;
  expect(track?.(session.doc, () => {}) ?? null, 'an Edit-mode paste is tracked').not.toBeNull();
  const fork = new Y.Doc();
  registerFork(fork, { body: session.doc, admit: () => null, recordChars: () => 0, recordStructs: () => 0 });
  expect(track?.(fork, () => {}) ?? null, 'a Suggest-mode paste writes the fork and is not rolled back').toBeNull();
  fork.destroy();
});
