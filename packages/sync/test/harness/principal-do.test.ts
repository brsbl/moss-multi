import { expect, it } from 'vitest';
import { TRUSTED } from '@moss-multi/protocol/sync';
import { PrincipalDO } from '../../src/principal-do.ts';
import { Backing, FakeState, serverEnds } from './workerd.ts';

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
