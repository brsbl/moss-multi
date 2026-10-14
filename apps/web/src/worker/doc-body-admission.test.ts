// T8.R: a note create and a CLI push read their body only after admission (T3.S3b, T7.2): through the Worker's routing
// to the real handlers, a caller who is signed out, has no access, or is out of tokens is refused without the body
// being pulled, so a stream of tens of MB never reaches the isolate's memory.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { CREATE_BODY_MAX_BYTES } from '@moss-multi/protocol/limits';
import { handleApi } from '../api/router.ts';
import type { Build } from '../provenance.ts';
import { migratedD1, type TestD1 } from '../test/d1.ts';
import { BASE, insertDoc, SECRET, signedUpUser, type TestUser } from '../test/principals.ts';
import { routeRequest, type RouteDeps } from './route.ts';

const CHUNK = 64 * 1024;

/** A body with no Content-Length, larger than any document cap, that counts the bytes anyone pulls from it. */
function streamed() {
  const total = CREATE_BODY_MAX_BYTES + 8 * 1024 * 1024;
  const pulled = { bytes: 0 };
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pulled.bytes >= total) return controller.close();
      pulled.bytes += CHUNK;
      controller.enqueue(new Uint8Array(CHUNK).fill(0x20));
    },
  });
  return { body, pulled };
}

const throttle = { create: false, push: false };
const PrincipalDO = {
  idFromName: (name: string) => ({ name, toString: () => name }),
  get: () => ({
    setName: async () => undefined, publish: async () => undefined,
    takeCreateToken: async () => (throttle.create ? 30_000 : true),
    takePushToken: async () => !throttle.push,
  }),
};
const DocDO = {
  idFromName: (name: string) => ({ name, toString: () => name }),
  get: () => ({ setName: async () => undefined }),
};

let d1: TestD1;
let env: Parameters<typeof handleApi>[1] & { BETTER_AUTH_SECRET: string; BETTER_AUTH_URL: string };
let ada: TestUser;
let ben: TestUser;
let docId: string;

beforeAll(async () => {
  d1 = await migratedD1();
  env = { DB: d1.db, ASSETS: d1.assets, BETTER_AUTH_SECRET: SECRET, BETTER_AUTH_URL: BASE, DocDO: DocDO as never, PrincipalDO: PrincipalDO as never };
  ada = await signedUpUser(env, 'doc-body-admission', 'Ada');
  ben = await signedUpUser(env, 'doc-body-admission', 'Ben');
  docId = await insertDoc(d1.db, ada);
}, 60_000);
afterAll(() => d1?.dispose());

const deps = (): RouteDeps => ({
  build: {} as Build,
  testHooksAllowed: () => false,
  handleTestHook: vi.fn(async () => null),
  handleAuth: vi.fn(async () => new Response(null, { status: 404 })),
  handleWorkspaceSocket: vi.fn(async () => new Response(null, { status: 404 })),
  handleApi: (request) => handleApi(request, env),
  authenticateParty: vi.fn(async () => ({ ok: false as const, code: 4401 as const })),
  routeParty: vi.fn(async () => null),
  refuseSocket: vi.fn(() => new Response(null)),
  startFetch: vi.fn(async () => new Response(null, { status: 404 })),
});

async function send(path: string, cookie?: string) {
  const { body, pulled } = streamed();
  const request = new Request(`${BASE}${path}`, {
    method: 'POST', body, duplex: 'half',
    headers: { origin: BASE, 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
  } as RequestInit);
  const response = await routeRequest(request, deps());
  return { status: response.status, pulled: pulled.bytes };
}

describe('a create or push body is read only after admission', () => {
  it('refuses a signed-out create or push, and a push to a note the caller cannot open, without pulling the body', async () => {
    const cases: [string, string | undefined, number][] = [
      ['/api/docs', undefined, 401],
      [`/api/docs/${docId}/push`, undefined, 401],
      [`/api/docs/${docId}/push`, ben.cookie, 404],
    ];
    for (const [path, cookie, status] of cases) {
      const answer = await send(path, cookie);
      expect(answer.status, path).toBe(status);
      expect(answer.pulled, path).toBeLessThanOrEqual(2 * CHUNK);
    }
  });

  it('refuses a create past the create budget with 429 before reading its body', async () => {
    throttle.create = true;
    try {
      const answer = await send('/api/docs', ada.cookie);
      expect(answer.status).toBe(429);
      expect(answer.pulled).toBeLessThanOrEqual(2 * CHUNK);
    } finally {
      throttle.create = false;
    }
  });

  it('refuses a push past the push budget with 429 before reading its body', async () => {
    throttle.push = true;
    try {
      const answer = await send(`/api/docs/${docId}/push`, ada.cookie);
      expect(answer.status).toBe(429);
      expect(answer.pulled).toBeLessThanOrEqual(2 * CHUNK);
    } finally {
      throttle.push = false;
    }
  });

  it('still refuses an admitted body that streams past its cap with 413', async () => {
    const answer = await send('/api/docs', ada.cookie);
    expect(answer.status).toBe(413);
    expect(answer.pulled).toBeLessThanOrEqual(CREATE_BODY_MAX_BYTES + 2 * CHUNK);
  });
});
