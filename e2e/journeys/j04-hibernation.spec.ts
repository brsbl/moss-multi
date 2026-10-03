// T1.7: one shared natural-idle window, with constructor identity proving every cold path.
import type { Actor, Actors } from '../lib/actors.ts';
import { BODY_BINDING_ATTR, DOC_ID_ATTR, EDITOR_PANE_ATTR, SYNC_UNACKED_ATTR } from '../lib/contract.ts';
import { IDLE_MS, induce, inductionProblems } from '../lib/hibernate.ts';
import { awarenessFrames, visibility } from '../lib/idle.ts';
import type { Principal } from '../lib/principals.ts';
import { expect, test, ui } from '../lib/test.ts';

const TEXT = 'Kept after sleep: café, two  spaces & a peer.';
async function live(actor: Actor, docId: string) {
  await expect(ui.body(actor, docId)).toHaveAttribute(BODY_BINDING_ATTR, 'live', { timeout: 30_000 });
  await expect(ui.body(actor, docId)).toHaveText(TEXT);
}
async function note(actors: Actors, owner: Principal, peer: Principal, label: string) {
  const actor = await actors.session(owner, { label });
  const frames = awarenessFrames(actor);
  await actor.goto('/');
  await actor.page.getByRole(ui.NEW_NOTE.role, { name: ui.NEW_NOTE.name }).click();
  const pane = actor.page.locator(`[${EDITOR_PANE_ATTR}]`);
  await expect(pane).toHaveCount(1);
  const docId = await pane.getAttribute(DOC_ID_ATTR);
  if (!docId) throw new Error('new note has no doc id');
  await expect(ui.body(actor, docId)).toHaveAttribute(BODY_BINDING_ATTR, 'live');
  await ui.typeBody(actor, docId, TEXT);
  await expect(pane).toHaveAttribute(SYNC_UNACKED_ATTR, '0');
  await ui.shareWith(actor, docId, peer, 'Can edit');
  await actor.page.keyboard.press('Escape');
  return { actor, docId, frames };
}

test('j04-hibernation: a UI-authored note reopens non-empty after a process restart @p:col-6 @p:tech-6', async ({ actors, stack }, info) => {
  const owner = await actors.principal('ada');
  const peer = await actors.principal('ben');
  const { actor, docId } = await note(actors, owner, peer, 'creator');
  const reader = await actors.session(peer);
  const proof = await induce(stack, {
    docId, lever: 'restart',
    quiesce: async () => { await actor.page.close(); },
    decisive: async () => { await reader.goto(`/d/${docId}`); await live(reader, docId); },
  });
  await info.attach('restart-instance.json', { body: JSON.stringify(proof), contentType: 'application/json' });
  expect(proof.after.instanceId).not.toBe(proof.base.instanceId);
  await reader.page.reload();
  await live(reader, docId);
});

test('j04-hibernation: reopen and warm creator with a cold peer after shared idle; presence both ways @hibernate @slow @p:col-6 @p:tech-6 @p:col-2', async ({ actors, stack }, info) => {
  test.setTimeout(240_000);
  info.annotations.push({ type: 'quiescence', description: 'simulated document visibility; real surviving WebSocket' });
  const owner = await actors.principal('ada');
  const peer = await actors.principal('ben');
  const closed = await note(actors, owner, peer, 'closed-creator');
  const warm = await note(actors, owner, peer, 'warm-creator');
  const reader = await actors.session(peer, { label: 'reopen-peer' });
  const joiner = await actors.session(peer, { label: 'cold-peer' });
  const incoming = awarenessFrames(joiner);
  await expect.poll(() => warm.frames.sent.size).toBe(1);
  const [creatorId] = warm.frames.sent.keys();
  const baseline = await Promise.all([stack.docInstance(closed.docId), stack.docInstance(warm.docId)]);
  await closed.actor.page.close();
  await visibility(warm.actor, true);
  const socket = warm.actor.telemetry.sockets.find((s) => s.docId === warm.docId);
  expect(socket).toBeDefined();
  const clock = warm.frames.sent.get(creatorId);
  await new Promise((resolve) => setTimeout(resolve, IDLE_MS));
  expect(socket?.closedAt, 'the warm creator socket survives idle').toBeNull();
  expect(warm.frames.sent.get(creatorId), 'hidden presence does not keep the DO awake').toBe(clock);

  for (const [index, scenario, actor] of [[0, closed, reader], [1, warm, joiner]] as const) {
    const decisiveAt = Date.now();
    await actor.goto(`/d/${scenario.docId}`);
    await live(actor, scenario.docId);
    const after = await stack.docInstance(scenario.docId);
    const proof = { docId: scenario.docId, base: baseline[index], after, decisiveAt, idleMs: IDLE_MS };
    await info.attach(`idle-${index}-instance.json`, { body: JSON.stringify(proof), contentType: 'application/json' });
    expect(inductionProblems(baseline[index], after, decisiveAt), 'hibernation must be induced').toEqual([]);
    expect(after.instanceId).not.toBe(baseline[index].instanceId);
  }
  await visibility(warm.actor, false);
  await expect.poll(() => incoming.received.has(creatorId), { message: 'the newcomer receives the surviving creator presence' }).toBe(true);
  await expect.poll(() => incoming.sent.size).toBe(1);
  const [peerId] = incoming.sent.keys();
  expect(peerId).not.toBe(creatorId);
  await expect.poll(() => warm.frames.received.has(peerId), { message: 'the creator receives the newcomer presence' }).toBe(true);
  await live(warm.actor, warm.docId);
  expect(warm.actor.telemetry.sockets.filter((s) => s.docId === warm.docId)).toHaveLength(1);
  expect(socket?.closedAt).toBeNull();
});
