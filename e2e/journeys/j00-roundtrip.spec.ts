// j00-roundtrip (T0.7; the server half of SP3): a note created through the API binds a headless V1 editor over
// YProvider to the DocDO's seed, takes an edit, and reopens with that text after a stack restart on a new DO
// instance. A doc socket the Worker denies opens and closes with its code, never a refused handshake (1006).
// T0.12: a page on another port of the stack's host, where the session cookie still rides, cannot read a note.
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { DOC_SOCKET_PATH } from '../../packages/protocol/src/dom-contract.ts';
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

interface Attempt { code: number | null; frames: number; leaked: boolean }

/**
 * In a page: opens the doc socket, asks for the whole doc (a sync step 1 with an empty state vector) and reports
 * until the close, the secret's arrival or 8 s.
 */
function attempt({ url, secret }: { url: string; secret: string }): Promise<Attempt> {
  return new Promise((resolve) => {
    const result: Attempt = { code: null, frames: 0, leaked: false };
    const socket = new WebSocket(url);
    socket.binaryType = 'arraybuffer';
    const finish = () => {
      clearTimeout(timer);
      resolve({ ...result });
    };
    const timer = setTimeout(() => {
      socket.close();
      finish();
    }, 8_000);
    socket.onopen = () => socket.send(new Uint8Array([0, 0, 1, 0]));
    socket.onmessage = (event: MessageEvent<ArrayBuffer | string>) => {
      result.frames += 1;
      if ((typeof event.data === 'string' ? event.data : new TextDecoder().decode(event.data)).includes(secret)) {
        result.leaked = true;
        socket.close();
        finish();
      }
    };
    socket.onclose = (event) => {
      result.code = event.code;
      finish();
    };
  });
}

/** A page on another port of `host`: another origin, but the same site, so the browser still sends the cookie. */
async function servePage(host: string): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((_, response) => response.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><title>elsewhere</title>'));
  await new Promise<void>((resolve) => server.listen(0, host, resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://${host}:${port}/`, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

test('j00-roundtrip: a page on another origin opens the doc socket with the signed-in cookie and reads nothing @p:ppl-1', async ({ actors, stack }) => {
  actors.solo('one signed-in person; the other side is a page on another port, not a principal');
  const ada = await actors.principal('ada');
  const adaCookie = cookieHeader(await signIn(stack.baseUrl, ada));
  const docId = await createNote(stack.baseUrl, adaCookie);
  const secret = `j00-origin-${randomUUID()}`;
  const writer = await openDocClient(stack.baseUrl, docId, adaCookie);
  try {
    await writer.synced;
    writer.type(secret);
    await writer.acked();
  } finally {
    writer.close();
  }

  // Ada's browser: her session cookie, a tab on the app, and a tab on a page elsewhere. The forged ?share= token
  // tells the refusals apart: a socket that arrived without the cookie would close 4404, not 4401.
  const victim = await actors.session(ada);
  const target = { url: `${stack.baseUrl.replace(/^http/, 'ws')}${DOC_SOCKET_PATH}${docId}?share=${randomUUID()}`, secret };
  const elsewhere = await servePage(new URL(stack.baseUrl).hostname);
  try {
    const home = await victim.context.newPage();
    await home.goto(`${stack.baseUrl}/api/version`);
    expect(await home.evaluate(attempt, target), 'the control: the same script on the app origin reads the note').toMatchObject({ leaked: true });

    const page = await victim.context.newPage();
    await page.goto(elsewhere.url);
    const result = await page.evaluate(attempt, target);
    expect(result.leaked, 'a page on another origin read the note').toBe(false);
    expect(result.frames, 'a page on another origin received doc frames').toBe(0);
    expect(result.code, 'the cookie rode the handshake and was refused for its origin').toBe(CLOSE.noPrincipal);
  } finally {
    await elsewhere.close();
  }
});
