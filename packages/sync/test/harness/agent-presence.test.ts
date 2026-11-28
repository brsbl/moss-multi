// An agent's push is attributed with Bot-badged presence (T7.3; A§10.7, A§17): the DocDO adds a server-owned awareness
// entry for about 15 s, refreshed before a client's 12 s sweep could drop it, then removes it. Only presence-allowed
// sockets hear it, and a socket cannot take the entry over. A timer-driven refresh or removal first re-validates the
// sockets (A§8), so a revoked reader whose kick was missed hears none of it.
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import { encodePartyPrincipal, TRUSTED } from '@moss-multi/protocol/sync';
import { sha256Hex } from '../../src/doc/bases.ts';
import { DocDO } from '../../src/doc-do.ts';
import { Backing, connect, openDoc, start, type Opened, type TestClient } from './do-harness.ts';

beforeEach(() => vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] }));
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

const AGENT = { id: 'agent-1', name: 'Scribe' };
/** PRODUCT and A§10.7: about 15 s. */
const AGENT_PRESENCE_MS = 15_000;
const BODY = 'Beans first.\n\nPeas next.';

async function seeded(): Promise<Opened> {
  const opened = await start(openDoc());
  await opened.dobj.create({ folderId: 'f', ownerId: 'ada', markdown: BODY });
  return opened;
}

async function agentPush(opened: Opened, from: string, to: string, presence: typeof AGENT | null = AGENT) {
  return opened.dobj.push({
    newText: to, baseHash: await sha256Hex(from), baseText: from, reviewer: { id: AGENT.id, role: 'editor' },
    actor: { kind: 'agent', principalId: AGENT.id, sessionId: null, shareToken: null },
    ...(presence ? { presence } : {}),
  });
}

type State = { name?: string; user?: { principalId: string; name: string; isAgent: boolean; color: string; colorSettled: boolean } } | null;

/** Every awareness entry a client received, in order: [clientId, clock, state]. */
function heard(client: TestClient): [number, number, State][] {
  const out: [number, number, State][] = [];
  for (const frame of client.socket.sent) {
    if (typeof frame === 'string' || frame[0] !== 1) continue;
    const outer = decoding.createDecoder(frame);
    decoding.readVarUint(outer);
    const payload = decoding.createDecoder(decoding.readVarUint8Array(outer));
    const count = decoding.readVarUint(payload);
    for (let i = 0; i < count; i++) {
      const id = decoding.readVarUint(payload);
      const clock = decoding.readVarUint(payload);
      out.push([id, clock, JSON.parse(decoding.readVarString(payload)) as State]);
    }
  }
  return out;
}

const bots = (opened: Opened) => [...opened.dobj.document.awareness.getStates()].filter(([, state]) => (state as State)?.user?.isAgent);

it('an agent push shows a Bot-badged presence for about 15 s, refreshed before the 12 s client sweep, then removed @p:agt-1', async () => {
  const opened = await seeded();
  const ada = await connect(opened, { id: 'ada', name: 'Ada' });
  const link = await connect(opened, { id: 'link', kind: 'anonymous', share: 'token' });
  const base = await opened.dobj.pullMarkdown();
  const verdict = await agentPush(opened, base, base.replace('Peas next.', 'Peas next, then squash.'));
  expect(verdict).toMatchObject({ ok: true });

  const [entry] = bots(opened);
  expect(entry, 'the push adds an agent entry').toBeDefined();
  const [botId, state] = entry as [number, State];
  expect(state?.user).toMatchObject({ principalId: AGENT.id, name: AGENT.name, isAgent: true, colorSettled: true });
  expect(state?.name).toBe(AGENT.name);
  expect(heard(ada).some(([id, , s]) => id === botId && s?.user?.isAgent), 'a member hears it').toBe(true);
  expect(heard(link), 'a link-only visitor hears no identity').toHaveLength(0);

  // A client drops a state it has not heard for 12 s, so the server says it again before then.
  vi.advanceTimersByTime(11_000);
  const refreshed = heard(ada).filter(([id, , s]) => id === botId && s !== null);
  expect(refreshed.length, 'refreshed inside the sweep window').toBeGreaterThanOrEqual(2);
  expect(refreshed.at(-1)![1]).toBeGreaterThan(refreshed[0]![1]);
  expect(bots(opened)).toHaveLength(1);

  vi.advanceTimersByTime(AGENT_PRESENCE_MS - 11_000 + 1_000);
  expect(bots(opened), 'gone after about 15 s').toHaveLength(0);
  expect(heard(ada).at(-1), 'and the member hears it leave').toEqual([botId, expect.any(Number), null]);
});

it('a second push inside the window keeps one entry and extends it; a push that changed nothing adds none', async () => {
  const opened = await seeded();
  const ada = await connect(opened, { id: 'ada', name: 'Ada' });
  let base = await opened.dobj.pullMarkdown();
  await agentPush(opened, base, base.replace('Beans first.', 'Broad beans first.'));
  const [[botId]] = bots(opened) as [[number, unknown]];
  vi.advanceTimersByTime(10_000);
  base = await opened.dobj.pullMarkdown();
  await agentPush(opened, base, base.replace('Peas next.', 'Peas after.'));
  expect(bots(opened).map(([id]) => id)).toEqual([botId]);
  vi.advanceTimersByTime(10_000);
  expect(bots(opened), 'still there 20 s after the first push').toHaveLength(1);
  vi.advanceTimersByTime(6_000);
  expect(bots(opened)).toHaveLength(0);

  base = await opened.dobj.pullMarkdown();
  const heardBefore = heard(ada).length;
  await agentPush(opened, base, base);
  expect(bots(opened)).toHaveLength(0);
  expect(heard(ada)).toHaveLength(heardBefore);
});

it('a push without an agent identity (a person at a terminal) adds no presence', async () => {
  const opened = await seeded();
  const base = await opened.dobj.pullMarkdown();
  await agentPush(opened, base, base.replace('Beans first.', 'Beans go first.'), null);
  expect(bots(opened)).toHaveLength(0);
});

it('a socket cannot take over the agent entry or clear it', async () => {
  const opened = await seeded();
  const ben = await connect(opened, { id: 'ben', name: 'Ben' });
  const base = await opened.dobj.pullMarkdown();
  await agentPush(opened, base, base.replace('Beans first.', 'Beans go first.'));
  const [[botId]] = bots(opened) as [[number, unknown]];
  const frame = (value: unknown, clock: number) => {
    const body = encoding.createEncoder();
    encoding.writeVarUint(body, 1); encoding.writeVarUint(body, botId); encoding.writeVarUint(body, clock);
    encoding.writeVarString(body, JSON.stringify(value));
    const out = encoding.createEncoder(); encoding.writeVarUint(out, 1);
    encoding.writeVarUint8Array(out, encoding.toUint8Array(body)); return encoding.toUint8Array(out);
  };
  const benState = { name: 'Ben', color: '#abcdef', user: { principalId: 'ben', name: 'Ben', isAgent: false, color: '#abcdef', colorSettled: true } };
  await ben.deliver(frame(benState, 99));
  await ben.deliver(frame(null, 100));
  expect(bots(opened).map(([id]) => id)).toEqual([botId]);
});

/** A socket the Worker admitted under the doc's access epoch `owner:1`. */
const admitted = (id: string) => ({ headers: {
  [TRUSTED.principal]: encodePartyPrincipal({ id, kind: 'user', name: id }),
  [TRUSTED.role]: 'editor', [TRUSTED.session]: `sess-${id}`, [TRUSTED.resolvedAt]: String(Date.now()), [TRUSTED.epoch]: 'owner:1',
} });

it('a timer-driven refresh or removal reaches only sockets that still have access, even when a kick was missed (B351)', async () => {
  // D1's view: an epoch, and who may read. Revoking Ben moves the epoch and drops him, with no kick delivered.
  let epoch = 'owner:1';
  const readers = new Set(['ada', 'ben', AGENT.id]);
  class CheckedDocDO extends DocDO {
    static override access = () => ({
      stamp: (_docId: string, sessions: string[], agents: string[]) => Promise.resolve({ key: epoch, sessions: new Set(sessions), agents: new Set(agents) }),
      resolve: (_docId: string, who: { principalId: string }) => Promise.resolve(readers.has(who.principalId) ? { role: 'editor' as const, presence: true } : null),
    });
  }
  const opened = await start(openDoc(new Backing(), CheckedDocDO as never));
  await opened.dobj.create({ folderId: 'f', ownerId: 'ada', markdown: BODY });
  const ada = await connect(opened, admitted('ada'));
  const ben = await connect(opened, admitted('ben'));
  const base = await opened.dobj.pullMarkdown();
  expect(await agentPush(opened, base, base.replace('Peas next.', 'Peas next, then squash.'))).toMatchObject({ ok: true });
  const [[botId]] = bots(opened) as [[number, unknown]];
  expect(heard(ben).some(([id]) => id === botId), 'Ben hears the agent while he may read').toBe(true);

  epoch = 'owner:2';
  readers.delete('ben');
  const benHeard = heard(ben).length;
  const adaHeard = heard(ada).length;
  await vi.advanceTimersByTimeAsync(9_000);
  expect(heard(ben), 'the revoked socket hears no refresh').toHaveLength(benHeard);
  expect(heard(ada).length, 'a permitted peer still does').toBeGreaterThan(adaHeard);
  await vi.advanceTimersByTimeAsync(AGENT_PRESENCE_MS);
  expect(bots(opened), 'the entry still expires').toHaveLength(0);
  expect(heard(ben), 'nor its removal').toHaveLength(benHeard);
  expect(heard(ada).at(-1), 'which the permitted peer hears').toEqual([botId, expect.any(Number), null]);
});

it('a refresh whose validation cannot answer is not sent, and the entry still expires on time (B351)', async () => {
  let failing = false;
  class FlakyDocDO extends DocDO {
    static override access = () => ({
      stamp: (_docId: string, sessions: string[], agents: string[]) => (failing
        ? Promise.reject(new Error('D1 down'))
        : Promise.resolve({ key: 'owner:1', sessions: new Set(sessions), agents: new Set(agents) })),
      resolve: () => Promise.resolve({ role: 'editor' as const, presence: true }),
    });
  }
  const opened = await start(openDoc(new Backing(), FlakyDocDO as never));
  await opened.dobj.create({ folderId: 'f', ownerId: 'ada', markdown: BODY });
  const ada = await connect(opened, admitted('ada'));
  const base = await opened.dobj.pullMarkdown();
  expect(await agentPush(opened, base, base.replace('Peas next.', 'Peas next, then squash.'))).toMatchObject({ ok: true });
  expect(bots(opened)).toHaveLength(1);
  failing = true;
  const adaHeard = heard(ada).length;
  await vi.advanceTimersByTimeAsync(AGENT_PRESENCE_MS + 1_000);
  expect(heard(ada), 'nothing is sent without a validation').toHaveLength(adaHeard);
  expect(bots(opened), 'the entry expires on time').toHaveLength(0);
});
