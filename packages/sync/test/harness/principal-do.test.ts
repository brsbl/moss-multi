// The PrincipalDO's REST write window across its lifecycle (A§5.1, A§5.2): a hibernated or evicted PrincipalDO
// wakes empty, so the window lives in its storage and an exhausted identity stays refused after a wake. Also its
// workspace channel: publishing reaches hibernated sockets, and clients cannot publish.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { COMMENT_OP_RATE, REST_WRITE_RATE, UPLOAD_RATE } from '@moss-multi/protocol/limits';
import { TRUSTED } from '@moss-multi/protocol/sync';
import { PrincipalDO } from '../../src/principal-do.ts';
import { Backing, FakeState, serverEnds } from './workerd.ts';

const open = (backing: Backing) => {
  const state = new FakeState(backing);
  return { dobj: new PrincipalDO(state as never, {} as never), state };
};

/** Eviction: the instance dies with its memory; a fresh one opens over the same storage. */
const wake = (opened: ReturnType<typeof open>) => {
  opened.state.alive = false;
  return open(opened.state.backing);
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('PrincipalDO write window across wakes @p:tech-8', () => {
  it('keeps an exhausted identity refused after an eviction inside the window', () => {
    let opened = open(new Backing('principal-1'));
    for (let i = 0; i < REST_WRITE_RATE.max; i += 1) expect(opened.dobj.takeWriteToken()).toBe(true);
    expect(opened.dobj.takeWriteToken()).toBe(false);

    // Idle until hibernation (~10 s), then continue inside the same minute.
    vi.advanceTimersByTime(10_000);
    opened = wake(opened);
    expect(opened.dobj.takeWriteToken()).toBe(false);

    vi.advanceTimersByTime(20_000);
    opened = wake(opened);
    expect(opened.dobj.takeWriteToken()).toBe(false);
  });

  it('counts denied attempts across wakes and grants again once the window slides', () => {
    let opened = open(new Backing('principal-2'));
    for (let i = 0; i < REST_WRITE_RATE.max; i += 1) opened.dobj.takeWriteToken();
    // Denied attempts at +30 s keep the window full until +90 s.
    vi.advanceTimersByTime(30_000);
    for (let i = 0; i < REST_WRITE_RATE.max; i += 1) expect(opened.dobj.takeWriteToken()).toBe(false);
    vi.advanceTimersByTime(REST_WRITE_RATE.windowMs - 1);
    opened = wake(opened);
    expect(opened.dobj.takeWriteToken()).toBe(false);

    vi.advanceTimersByTime(REST_WRITE_RATE.windowMs);
    opened = wake(opened);
    expect(opened.dobj.takeWriteToken()).toBe(true);
  });

  it('keeps identities apart', () => {
    const a = open(new Backing('principal-a'));
    for (let i = 0; i < REST_WRITE_RATE.max; i += 1) a.dobj.takeWriteToken();
    expect(a.dobj.takeWriteToken()).toBe(false);
    expect(open(new Backing('principal-b')).dobj.takeWriteToken()).toBe(true);
  });
});

describe('PrincipalDO upload window across wakes (T3.1s)', () => {
  it('refuses the upload past the window after an eviction, apart from the REST write window', () => {
    let opened = open(new Backing('principal-uploads'));
    for (let i = 0; i < UPLOAD_RATE.max; i += 1) expect(opened.dobj.takeUploadToken()).toBe(true);
    expect(opened.dobj.takeUploadToken()).toBe(false);
    expect(opened.dobj.takeWriteToken(), 'a rename is counted on its own window').toBe(true);

    vi.advanceTimersByTime(10_000);
    opened = wake(opened);
    expect(opened.dobj.takeUploadToken()).toBe(false);

    vi.advanceTimersByTime(UPLOAD_RATE.windowMs);
    opened = wake(opened);
    expect(opened.dobj.takeUploadToken()).toBe(true);
  });
});

describe('PrincipalDO comment window across wakes (T4.1)', () => {
  it('grants the 60th comment operation, refuses the 61st, and keeps refusing after an eviction', () => {
    expect(COMMENT_OP_RATE).toEqual({ max: 60, windowMs: 60_000 });
    let opened = open(new Backing('principal-comments'));
    for (let i = 0; i < 60; i += 1) expect(opened.dobj.takeCommentToken(), `operation ${i + 1}`).toBe(true);
    expect(opened.dobj.takeCommentToken(), 'operation 61').toBe(false);
    expect(opened.dobj.takeWriteToken(), 'a rename is counted on its own window').toBe(true);

    vi.advanceTimersByTime(10_000);
    opened = wake(opened);
    expect(opened.dobj.takeCommentToken()).toBe(false);

    vi.advanceTimersByTime(COMMENT_OP_RATE.windowMs);
    opened = wake(opened);
    expect(opened.dobj.takeCommentToken()).toBe(true);
  });
});

it('publishes to hibernated workspace sockets on a fresh RPC and does not accept client publishing', async () => {
  const backing = new Backing();
  const state = new FakeState(backing);
  const principal = new PrincipalDO(state as never, {} as never);
  await principal.setName(backing.docId);
  await principal.fetch(new Request('https://moss.invalid/api/workspace/ws', { headers: {
    upgrade: 'websocket', [TRUSTED.principal]: backing.docId, [TRUSTED.session]: 'session',
  } }));
  const socket = serverEnds.at(-1)!;
  expect(socket.closed).toBeNull();
  const event = { type: 'meta' as const, docIds: ['changed'], folderIds: [] };
  const cold = new PrincipalDO(new FakeState(backing) as never, {} as never);
  await cold.publish(event);
  expect(socket.sent).toContain(JSON.stringify(event));
  const before = socket.sent.length;
  await cold.webSocketMessage(socket as never, JSON.stringify(event));
  expect(socket.sent).toHaveLength(before);
  await cold.webSocketMessage(socket as never, 'ping');
  expect(socket.sent.at(-1)).toBe('pong');
  await cold.webSocketClose(socket as never, 1000, '', true);
  expect(socket.closed).toEqual({ code: 1000, reason: 'closed' });
  backing.db.close();
});
