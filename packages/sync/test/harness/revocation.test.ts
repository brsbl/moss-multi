// The one kick path inside the DOs (T2.5; A§5.1, A§5.2, A§8): DocDO.recheck persists a revocation and closes what it
// names (4403 for a principal or a link, 4402 for a session), a woken DO already knows it, and a connection whose role
// was resolved before a principal's revocation is refused while a later one is admitted. The PrincipalDO's sign-out
// registry lists the docs a session opened, endSession rechecks each before closing the session's workspace sockets,
// and a doc socket that registers after its session ended closes 4402.
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { SESSION_MAX_MS } from '@moss-multi/protocol/limits';
import { CLOSE, TRUSTED } from '@moss-multi/protocol/sync';
import { DocDO } from '../../src/doc-do.ts';
import { PrincipalDO } from '../../src/principal-do.ts';
import { connect, openDoc, start, wake, type Opened } from './do-harness.ts';
import { Backing, FakeState, serverEnds } from './workerd.ts';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(5_000_000);
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

const flushAsync = async () => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
};

describe('DocDO.recheck @p:ppl-2', () => {
  it('closes a revoked principal 4403 and leaves everyone else open', async () => {
    const opened = await start(openDoc());
    const ben = await connect(opened, { id: 'ben', role: 'editor' });
    const benAgain = await connect(opened, { id: 'ben', role: 'editor' });
    const cy = await connect(opened, { id: 'cy', role: 'editor' });
    await opened.dobj.recheck({ principalIds: ['ben'], at: Date.now() });
    expect(ben.closed?.code).toBe(CLOSE.revoked);
    expect(benAgain.closed?.code).toBe(CLOSE.revoked);
    expect(cy.closed).toBeNull();
  });

  it('closes every connection that presented a revoked link, signed in or not', async () => {
    const opened = await start(openDoc());
    const anonymous = await connect(opened, { kind: 'anonymous', id: 'anonymous', role: 'viewer', session: null, share: 'tok-1' });
    const rider = await connect(opened, { id: 'cy', role: 'editor', share: 'tok-1' });
    const other = await connect(opened, { kind: 'anonymous', id: 'anonymous', role: 'viewer', session: null, share: 'tok-2' });
    await opened.dobj.recheck({ tokens: ['tok-1'], at: Date.now() });
    expect(anonymous.closed?.code).toBe(CLOSE.revoked);
    expect(rider.closed?.code).toBe(CLOSE.revoked);
    expect(other.closed).toBeNull();
  });

  it('closes an ended session 4402', async () => {
    const opened = await start(openDoc());
    const windowB = await connect(opened, { id: 'ada', session: 'sess-a' });
    const otherSession = await connect(opened, { id: 'ada', session: 'sess-b' });
    await opened.dobj.recheck({ sessions: ['sess-a'], at: Date.now() });
    expect(windowB.closed?.code).toBe(CLOSE.sessionEnded);
    expect(otherSession.closed).toBeNull();
  });

  it('persists revocations, so a woken DO refuses a socket resolved before them and a stale socket\'s first frame', async () => {
    const opened = await start(openDoc());
    const resolvedBefore = Date.now() - 50;
    await opened.dobj.recheck({ principalIds: ['ben'], tokens: ['tok-1'], sessions: ['sess-a'], at: Date.now() });
    const woken = await start(wake(opened));
    expect((await connect(woken, { id: 'ben', resolvedAt: resolvedBefore })).closed?.code, 'an upgrade resolved before the demotion').toBe(CLOSE.revoked);
    expect((await connect(woken, { id: 'ben', resolvedAt: Date.now() + 1 })).closed, 'a fresh resolution after it').toBeNull();
    expect((await connect(woken, { kind: 'anonymous', id: 'anonymous', role: 'viewer', session: null, share: 'tok-1', resolvedAt: resolvedBefore })).closed?.code).toBe(CLOSE.revoked);
    expect((await connect(woken, { id: 'ada', session: 'sess-a' })).closed?.code).toBe(CLOSE.sessionEnded);
  });

  it('wakes a hibernated DO and closes the hibernated sockets it names', async () => {
    const opened = await start(openDoc());
    const holder = await connect(opened, { id: 'cy', role: 'editor', share: 'tok-cold' });
    const owner = await connect(opened, { id: 'ada', role: 'owner' });
    const woken = wake(opened);
    holder.opened = woken;
    await woken.dobj.recheck({ tokens: ['tok-cold'], at: Date.now() });
    expect(holder.closed?.code).toBe(CLOSE.revoked);
    expect(owner.closed).toBeNull();
    // The holder's first frame after the wake meets the revocation, not the doc.
    const title = woken.dobj.document.getText('title').toString();
    holder.socket.readyState = 1;
    holder.doc.getText('title').insert(0, 'after revoke ');
    await holder.flush();
    expect(woken.dobj.document.getText('title').toString()).toBe(title);
  });

  it('refuses a link only on sockets resolved before its revocation, so a note moved back under the link opens again', async () => {
    const opened = await start(openDoc());
    const resolvedBefore = Date.now() - 50;
    await opened.dobj.recheck({ tokens: ['tok-1'], at: Date.now() });
    expect((await connect(opened, { id: 'cy', share: 'tok-1', resolvedAt: resolvedBefore })).closed?.code).toBe(CLOSE.revoked);
    vi.advanceTimersByTime(1_000);
    expect((await connect(opened, { id: 'cy', share: 'tok-1' })).closed, 'resolved after the link reached the note again').toBeNull();
    const woken = await start(wake(opened));
    expect((await connect(woken, { kind: 'anonymous', id: 'anonymous', role: 'viewer', session: null, share: 'tok-1' })).closed).toBeNull();
  });

  it('a recheck for everyone closes every socket resolved before it and admits the ones resolved after', async () => {
    const opened = await start(openDoc());
    const owner = await connect(opened, { id: 'ada', role: 'owner' });
    const rider = await connect(opened, { kind: 'anonymous', id: 'anonymous', role: 'viewer', session: null, share: 'tok-1' });
    await opened.dobj.recheck({ everyone: true, at: Date.now() });
    expect(owner.closed?.code).toBe(CLOSE.revoked);
    expect(rider.closed?.code).toBe(CLOSE.revoked);
    vi.advanceTimersByTime(1_000);
    expect((await connect(opened, { id: 'ada', role: 'owner' })).closed).toBeNull();
  });

  it('keeps the latest revocation time for a principal across rechecks', async () => {
    const opened = await start(openDoc());
    await opened.dobj.recheck({ principalIds: ['ben'], at: Date.now() });
    vi.advanceTimersByTime(1_000);
    const between = Date.now();
    vi.advanceTimersByTime(1_000);
    await opened.dobj.recheck({ principalIds: ['ben'], at: Date.now() });
    await opened.dobj.recheck({ principalIds: ['ben'], at: between - 5_000 });
    expect((await connect(opened, { id: 'ben', resolvedAt: between })).closed?.code).toBe(CLOSE.revoked);
  });
});

/** A PrincipalDO over its own backing, named by its principal id, with its rechecks recorded. */
function principal(name: string) {
  const backing = new Backing(name);
  const open = () => ({ dobj: new PrincipalDO(new FakeState(backing) as never, {} as never), backing });
  return { backing, open };
}

function recordRechecks(fail = new Set<string>()) {
  const calls: { docId: string; input: Parameters<DocDO['recheck']>[0] }[] = [];
  const original = PrincipalDO.rechecker;
  PrincipalDO.rechecker = () => async (docId, input) => {
    calls.push({ docId, input });
    if (fail.has(docId)) throw new Error('DocDO unavailable');
  };
  onTestFinished(() => { PrincipalDO.rechecker = original; });
  return calls;
}

async function workspaceSocket(dobj: PrincipalDO, principalId: string, sessionId: string) {
  await dobj.setName(principalId);
  await dobj.fetch(new Request('https://moss.invalid/api/workspace/ws', { headers: {
    upgrade: 'websocket', [TRUSTED.principal]: principalId, [TRUSTED.session]: sessionId,
  } }));
  return serverEnds.at(-1)!;
}

describe('PrincipalDO sign-out registry @p:ppl-2', () => {
  it('rechecks every doc the session opened, then closes that session\'s workspace sockets 4402', async () => {
    const calls = recordRechecks();
    const { open } = principal('ada');
    const { dobj } = open();
    await dobj.setName('ada');
    expect(await dobj.registerDocSocket('sess-a', 'doc-1')).toBe('ok');
    expect(await dobj.registerDocSocket('sess-a', 'doc-2')).toBe('ok');
    expect(await dobj.registerDocSocket('sess-a', 'doc-1')).toBe('ok');
    expect(await dobj.registerDocSocket('sess-b', 'doc-3')).toBe('ok');
    const windowA = await workspaceSocket(dobj, 'ada', 'sess-a');
    const windowC = await workspaceSocket(dobj, 'ada', 'sess-b');

    // A cold instance: the registry lives in storage.
    const cold = open().dobj;
    await cold.endSession('sess-a');
    expect(calls.map((c) => c.docId).sort()).toEqual(['doc-1', 'doc-2']);
    expect(calls.every((c) => c.input.sessions?.[0] === 'sess-a')).toBe(true);
    expect(windowA.sent).toContain(JSON.stringify({ type: 'session-ended', sessionId: 'sess-a' }));
    expect(windowA.closed?.code).toBe(CLOSE.sessionEnded);
    expect(windowC.closed).toBeNull();
  });

  it('answers ended to a doc socket that registers after its session ended, even after a wake', async () => {
    recordRechecks();
    const { open } = principal('ada');
    const first = open().dobj;
    await first.setName('ada');
    await first.endSession('sess-late');
    expect(await open().dobj.registerDocSocket('sess-late', 'doc-9')).toBe('ended');
    expect(await open().dobj.registerDocSocket('sess-live', 'doc-9')).toBe('ok');
  });

  it('closes the session\'s workspace sockets at once, without waiting for its doc rechecks', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const original = PrincipalDO.rechecker;
    PrincipalDO.rechecker = () => async () => { await gate; };
    onTestFinished(() => { PrincipalDO.rechecker = original; });
    const { open } = principal('ada');
    const { dobj } = open();
    await dobj.setName('ada');
    await dobj.registerDocSocket('sess-a', 'doc-1');
    const windowB = await workspaceSocket(dobj, 'ada', 'sess-a');
    let done = false;
    const ending = dobj.endSession('sess-a').then(() => { done = true; });
    await flushAsync();
    expect(windowB.closed?.code).toBe(CLOSE.sessionEnded);
    expect(done, 'sign-out still waits for the doc rechecks').toBe(false);
    release();
    await ending;
  });

  it('fails the sign-out when a doc does not acknowledge, and a retry rechecks it again', async () => {
    const fail = new Set(['doc-2']);
    const calls = recordRechecks(fail);
    const { open } = principal('ada');
    const { dobj } = open();
    await dobj.setName('ada');
    await dobj.registerDocSocket('sess-a', 'doc-1');
    await dobj.registerDocSocket('sess-a', 'doc-2');
    await expect(dobj.endSession('sess-a')).rejects.toThrow();
    fail.clear();
    calls.length = 0;
    await dobj.endSession('sess-a');
    expect(calls.map((c) => c.docId)).toContain('doc-2');
  });

  it('closes 4402 a workspace socket that arrives after its session ended, and 4401 one from a revoked agent', async () => {
    recordRechecks();
    const ada = principal('ada');
    const first = ada.open().dobj;
    await first.setName('ada');
    await first.endSession('sess-a');
    const late = await workspaceSocket(ada.open().dobj, 'ada', 'sess-a');
    expect(late.sent).toContain(JSON.stringify({ type: 'session-ended', sessionId: 'sess-a' }));
    expect(late.closed?.code).toBe(CLOSE.sessionEnded);
    expect((await workspaceSocket(ada.open().dobj, 'ada', 'sess-b')).closed).toBeNull();

    const agent = principal('agent-2');
    const revoked = agent.open().dobj;
    await revoked.setName('agent-2');
    await revoked.revokePrincipal();
    const agentLate = await workspaceSocket(agent.open().dobj, 'agent-2', '');
    expect(agentLate.closed?.code).toBe(CLOSE.noPrincipal);
  });

  it('a revoked agent key rechecks every doc the agent opened and refuses its later registrations', async () => {
    const calls = recordRechecks();
    const { open } = principal('agent-1');
    const { dobj } = open();
    await dobj.setName('agent-1');
    expect(await dobj.registerDocSocket(null, 'doc-4')).toBe('ok');
    await dobj.revokePrincipal();
    expect(calls).toEqual([{ docId: 'doc-4', input: expect.objectContaining({ principalIds: ['agent-1'] }) }]);
    expect(await open().dobj.registerDocSocket(null, 'doc-5')).toBe('ended');
  });
});

describe('DocDO registers sockets in the sign-out registry @p:ppl-2', () => {
  function registry(answer: 'ok' | 'ended') {
    const state = { answer, registered: [] as { principalId: string; sessionId: string | null; docId: string }[] };
    const original = DocDO.registry;
    DocDO.registry = () => async (principalId, sessionId, docId) => {
      state.registered.push({ principalId, sessionId, docId });
      return state.answer;
    };
    onTestFinished(() => { DocDO.registry = original; });
    return state;
  }

  it('registers a signed-in socket with its session and an agent socket with none', async () => {
    const { registered } = registry('ok');
    const opened: Opened = await start(openDoc());
    const user = await connect(opened, { id: 'ada', session: 'sess-a' });
    await connect(opened, { id: 'agent-1', kind: 'agent', session: null });
    await connect(opened, { kind: 'anonymous', id: 'anonymous', role: 'viewer', session: null, share: 'tok' });
    await flushAsync();
    expect(registered).toEqual([
      { principalId: 'ada', sessionId: 'sess-a', docId: opened.backing.docId },
      { principalId: 'agent-1', sessionId: null, docId: opened.backing.docId },
    ]);
    expect(user.closed).toBeNull();
  });

  it('closes a socket whose registration fails, so it reconnects and registers rather than outliving a sign-out', async () => {
    const original = DocDO.registry;
    DocDO.registry = () => async () => { throw new Error('PrincipalDO unavailable'); };
    onTestFinished(() => { DocDO.registry = original; });
    const opened = await start(openDoc());
    const socket = await connect(opened, { id: 'ada', session: 'sess-a' });
    await flushAsync();
    expect(socket.closed?.code).toBe(1013);
  });

  it('closes 4402 a socket whose session ended before it registered, and remembers the session', async () => {
    const answers = registry('ended');
    const opened = await start(openDoc());
    const late = await connect(opened, { id: 'ada', session: 'sess-gone' });
    await flushAsync();
    expect(late.closed?.code).toBe(CLOSE.sessionEnded);
    answers.answer = 'ok';
    const woken = await start(wake(opened));
    expect((await connect(woken, { id: 'ada', session: 'sess-gone' })).closed?.code).toBe(CLOSE.sessionEnded);
  });
});

describe('no doc socket outlives its sign-out registry row @p:ppl-2', () => {
  it('a doc socket closes 1013 before SESSION_MAX_MS from its admission, on the alarm, and the younger one stays', async () => {
    const opened = await start(openDoc());
    const old = await connect(opened, { id: 'ada', session: 'sess-a' });
    const due = opened.backing.alarm;
    expect(due, 'admission schedules the close').not.toBeNull();
    expect(due!).toBeLessThan(Date.now() + SESSION_MAX_MS);
    vi.setSystemTime(Date.now() + SESSION_MAX_MS / 2);
    const young = await connect(opened, { id: 'ada', session: 'sess-a' });
    expect(opened.backing.alarm, 'a younger socket does not push the close later').toBe(due);
    vi.setSystemTime(due!);
    const woken = await start(wake(opened));
    old.opened = woken;
    young.opened = woken;
    await woken.dobj.alarm();
    expect(old.closed?.code, 'it reconnects and registers afresh').toBe(1013);
    expect(young.closed).toBeNull();
    expect(woken.backing.alarm, 'the younger socket\'s close is scheduled next').toBeGreaterThan(Date.now());
    expect(woken.backing.alarm!).toBeLessThan(Date.now() + SESSION_MAX_MS);
  });

  it('an agent socket, which no session bounds, closes the same way', async () => {
    const opened = await start(openDoc());
    const agent = await connect(opened, { kind: 'agent', id: 'agent-1', session: null });
    vi.setSystemTime(opened.backing.alarm!);
    await opened.dobj.alarm();
    expect(agent.closed?.code).toBe(1013);
  });
});
