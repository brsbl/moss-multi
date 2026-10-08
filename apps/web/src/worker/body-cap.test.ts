// T8.3a: every /api request body is bounded before any handler reads it (A§18 limits). A body is buffered whole by
// request.text() and JSON.parse, so without a cap one unauthenticated 90 MB POST holds the isolate's 128 MB.
import { describe, expect, it, vi } from 'vitest';
import { DOC_BODY_CAP_BYTES, JSON_BODY_CAP_BYTES } from '@moss-multi/protocol/limits';
import type { Build } from '../provenance.ts';
import { routeRequest, type RouteDeps } from './route.ts';

const ORIGIN = 'http://127.0.0.1:8850';

function harness() {
  const seen: { path: string; body: string }[] = [];
  const read = vi.fn(async (request: Request) => {
    seen.push({ path: new URL(request.url).pathname, body: await request.text() });
    return new Response('handled');
  });
  const deps: RouteDeps = {
    build: {} as Build,
    testHooksAllowed: () => false,
    handleTestHook: vi.fn(async () => null),
    handleAuth: read,
    handleWorkspaceSocket: read,
    handleApi: read,
    authenticateParty: vi.fn(async () => ({ ok: false as const, code: 4401 as const })),
    routeParty: vi.fn(async () => null),
    refuseSocket: vi.fn(() => new Response(null)),
    startFetch: read,
  };
  const route = (path: string, init?: RequestInit) => routeRequest(new Request(`${ORIGIN}${path}`, init), deps);
  return { route, read, seen };
}

/** A body sent without a Content-Length, as a chunked upload is. */
const chunked = (bytes: number): RequestInit => {
  let sent = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= bytes) return controller.close();
      const chunk = new Uint8Array(Math.min(64 * 1024, bytes - sent)).fill(0x20);
      sent += chunk.byteLength;
      controller.enqueue(chunk);
    },
  });
  return { method: 'POST', body: stream, duplex: 'half' } as RequestInit;
};

const declared = (bytes: number): RequestInit => ({ method: 'POST', body: ' '.repeat(bytes), headers: { 'content-type': 'application/json' } });

describe('the /api body cap', () => {
  it.each(['/api/unfurl', '/api/feedback', '/api/docs/d1/comments', '/api/docs/d1/assets/copy', '/api/auth/sign-in/email', '/api/auth/sign-up/email'])(
    '%s refuses a JSON body over the cap with 413, before any handler runs',
    async (path) => {
      const { route, read } = harness();
      const response = await route(path, declared(JSON_BODY_CAP_BYTES + 1));
      expect(response.status).toBe(413);
      expect(response.headers.get('content-type')).toMatch(/^application\/json/);
      expect(await response.json()).toMatchObject({ error: 'too-large' });
      expect(read).not.toHaveBeenCalled();
    },
  );

  it('refuses a chunked body that grows past the cap, without a Content-Length to check', async () => {
    const { route, read } = harness();
    const response = await route('/api/unfurl', chunked(JSON_BODY_CAP_BYTES + 64 * 1024));
    expect(response.status).toBe(413);
    expect(read).not.toHaveBeenCalled();
  });

  it('hands a body within the cap to the handler unchanged, chunked or not', async () => {
    const { route, seen } = harness();
    const body = JSON.stringify({ noteId: 'd1', url: 'https://example.com/' });
    expect((await route('/api/unfurl', { method: 'POST', body, headers: { 'content-type': 'application/json' } })).status).toBe(200);
    expect((await route('/api/auth/sign-in/email', chunked(JSON_BODY_CAP_BYTES))).status).toBe(200);
    expect(seen[0]).toEqual({ path: '/api/unfurl', body });
    expect(seen[1].body.length).toBe(JSON_BODY_CAP_BYTES);
  });

  it('gives a note create and a push the larger document cap', async () => {
    for (const path of ['/api/docs', '/api/docs/d1/push']) {
      const { route } = harness();
      expect((await route(path, declared(JSON_BODY_CAP_BYTES + 1))).status, path).toBe(200);
      expect((await route(path, declared(DOC_BODY_CAP_BYTES + 1))).status, path).toBe(413);
    }
  });

  it('leaves a media upload to its own declared-length cap (assets.ts)', async () => {
    const { route, seen } = harness();
    expect((await route('/api/docs/d1/assets?filename=a.png', declared(JSON_BODY_CAP_BYTES + 1))).status).toBe(200);
    expect(seen[0].body.length).toBe(JSON_BODY_CAP_BYTES + 1);
  });

  it('caps no GET and nothing outside /api', async () => {
    const { route, read } = harness();
    expect((await route('/api/me')).status).toBe(200);
    expect((await route('/login', declared(JSON_BODY_CAP_BYTES + 1))).status).toBe(200);
    expect(read).toHaveBeenCalledTimes(2);
  });
});
