// j00-roundtrip (T0.7; the server half of SP3): a note created through the API binds a headless V1 editor over
// YProvider to the DocDO's seed, takes an edit, and reopens with that text after a stack restart on a new DO
// instance. A doc socket the Worker denies opens and closes with its code, never a refused handshake (1006).
import { randomUUID } from 'node:crypto';
import { CLOSE } from '../../packages/protocol/src/sync.ts';
import { cookieHeader, openDocClient, probeSocket, type DocClient } from '../lib/doc-client.ts';
import { induce } from '../lib/hibernate.ts';
import { signIn } from '../lib/principals.ts';
import { expect, test } from '../lib/test.ts';

const TEXT = 'Round trip: café, “quotes” & two  spaces';

async function createNote(baseUrl: string, cookie: string): Promise<string> {
  const response = await fetch(`${baseUrl}/api/docs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: baseUrl, cookie },
    body: '{}',
    signal: AbortSignal.timeout(15_000),
  });
  const body = await response.text();
  expect(response.status, `POST /api/docs: ${body.slice(0, 200)}`).toBe(201);
  return (JSON.parse(body) as { doc: { id: string } }).doc.id;
}

test('j00-roundtrip: a seeded note takes an edit and reopens with it after a restart on a new DO instance @p:tech-1 @p:tech-6', async ({ actors, stack }) => {
  const ada = await actors.principal('ada');
  const ben = await actors.principal('ben');
  const adaCookie = cookieHeader(await signIn(stack.baseUrl, ada));
  const benCookie = cookieHeader(await signIn(stack.baseUrl, ben));
  const docId = await createNote(stack.baseUrl, adaCookie);

  const first = await openDocClient(stack.baseUrl, docId, adaCookie);
  let reopened: DocClient | null = null;
  try {
    await first.synced;
    expect(first.blocks(), 'the DocDO seeded one empty paragraph').toEqual(['paragraph']);
    expect(first.doc.getText('title').toString(), 'the seed writes no title text').toBe('');
    first.type(TEXT);
    await first.acked();

    const { base, after } = await induce(stack, {
      docId,
      lever: 'restart',
      quiesce: async () => first.close(),
      decisive: async () => {
        reopened = await openDocClient(stack.baseUrl, docId, adaCookie);
        await reopened.synced;
      },
    });
    expect(after.instanceId).not.toBe(base.instanceId);
    const client = reopened as DocClient | null;
    if (!client) throw new Error('the reopen never ran');
    expect(client.text(), 'the reopened note holds the typed text').toBe(TEXT);
    expect(client.blocks()).toEqual(['paragraph']);
  } finally {
    first.close();
    (reopened as DocClient | null)?.close();
  }

  expect(await probeSocket(stack.baseUrl, docId, benCookie), "another person's socket to Ada's note").toEqual({ opened: true, code: CLOSE.unavailable });
  expect(await probeSocket(stack.baseUrl, randomUUID(), adaCookie), 'a socket to a note that does not exist').toEqual({ opened: true, code: CLOSE.unavailable });
  expect(await probeSocket(stack.baseUrl, docId, null), 'a socket with no credential').toEqual({ opened: true, code: CLOSE.noPrincipal });
});
