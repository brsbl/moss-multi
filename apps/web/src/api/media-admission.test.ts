// Media admission (T3.2s; A§16): every route that places media into a note (the direct upload, a remote image saved
// from a URL, a cross-note copy and a duplicate carrying its media) passes the same per-identity upload window and the
// same vault media quota, so no sibling route places media past either.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { UPLOAD_RATE, VAULT_MEDIA_QUOTA_BYTES } from '@moss-multi/protocol/limits';
import { migratedD1, type TestD1 } from '../test/d1.ts';
import { BASE, insertDoc, SECRET, signedUpUser, type AuthTestEnv, type TestUser } from '../test/principals.ts';
import { setRemoteFetchForTests } from './remote.ts';
import { handleApi } from './router.ts';

const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 31, 21, 196, 137]);
const IMAGE_URL = 'https://img.example/cat.png';

const DocDO = {
  idFromName: (name: string) => ({ name, toString: () => name }),
  get: () => ({
    setName: async () => undefined,
    snapshotForDuplicate: async () => ({ title: 'Original', state: new Uint8Array([1]) }),
    createFromSnapshot: async () => undefined,
  }),
};

/** Upload tokens counted per window name, as the PrincipalDO's persisted window counts them. */
const uploadsTaken = new Map<string, number>();
const PrincipalDO = {
  idFromName: (name: string) => ({ name, toString: () => name }),
  get: (id: { name: string }) => ({
    setName: async () => undefined,
    publish: async () => undefined,
    takeWriteToken: async () => true,
    takeFetchToken: async () => true,
    takeUploadToken: async () => {
      const taken = (uploadsTaken.get(id.name) ?? 0) + 1;
      uploadsTaken.set(id.name, taken);
      return taken <= UPLOAD_RATE.max;
    },
  }),
};

let d1: TestD1;
let env: AuthTestEnv & Parameters<typeof handleApi>[1];

beforeAll(async () => {
  d1 = await migratedD1();
  env = { DB: d1.db, ASSETS: d1.assets, BETTER_AUTH_SECRET: SECRET, BETTER_AUTH_URL: BASE, DocDO: DocDO as never, PrincipalDO: PrincipalDO as never };
  setRemoteFetchForTests({
    fetch: (async (input: RequestInfo | URL) => {
      if (String(input) !== IMAGE_URL) throw new Error(`unexpected fetch ${String(input)}`);
      return new Response(PNG, { headers: { 'content-type': 'image/png' } });
    }) as typeof fetch,
    resolve: async (host) => (host === 'img.example' ? ['93.184.215.15'] : []),
  });
}, 60_000);
afterAll(() => {
  setRemoteFetchForTests(null);
  d1?.dispose();
});
beforeEach(() => uploadsTaken.clear());

function call(path: string, cookie: string, init: { body?: BodyInit; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { origin: BASE, cookie, ...init.headers };
  if (init.body instanceof Uint8Array) headers['content-length'] = String(init.body.byteLength);
  return handleApi(new Request(`${BASE}${path}`, { method: 'POST', headers, body: init.body }), env);
}
const jsonBody = (value: unknown) => ({ body: JSON.stringify(value), headers: { 'content-type': 'application/json' } });

/** A person with a note holding `seed.png`, their upload window then emptied. */
async function seeded(label: string): Promise<{ user: TestUser; source: string; target: string }> {
  const user = await signedUpUser(env, label);
  const source = await insertDoc(d1.db, user);
  const target = await insertDoc(d1.db, user);
  const sent = await call(`/api/docs/${source}/assets?filename=seed.png`, user.cookie, { body: PNG, headers: { 'content-type': 'image/png' } });
  expect(sent.status, await sent.clone().text()).toBe(201);
  uploadsTaken.clear();
  return { user, source, target };
}

type Route = (user: TestUser, source: string, target: string) => Promise<Response>;
const ROUTES: [string, Route][] = [
  ['the direct upload', (user, _source, target) =>
    call(`/api/docs/${target}/assets?filename=burst.png`, user.cookie, { body: PNG, headers: { 'content-type': 'image/png' } })],
  ['from-url', (user, _source, target) => call(`/api/docs/${target}/assets/from-url`, user.cookie, jsonBody({ url: IMAGE_URL }))],
  ['the cross-note copy', (user, source, target) =>
    call(`/api/docs/${target}/assets/copy`, user.cookie, jsonBody({ sourceNoteId: source, sourceRelativePath: 'assets/seed.png' }))],
  ['the duplicate', (user, source) => call(`/api/docs/${source}/duplicate`, user.cookie)],
];

describe('one admission for every route that places media (T3.2s)', () => {
  it.each(ROUTES)('%s admits a window of uploads and refuses the next with 429', async (label, route) => {
    const { user, source, target } = await seeded(`admit-rate-${label.replace(/\W+/g, '-')}`);
    for (let i = 0; i < UPLOAD_RATE.max; i += 1) {
      const response = await route(user, source, target);
      expect(response.status, `call ${i + 1}: ${await response.clone().text()}`).toBe(201);
    }
    const refused = await route(user, source, target);
    expect(refused.status, `call ${UPLOAD_RATE.max + 1}`).toBe(429);
    expect(refused.headers.get('retry-after')).toBe(String(UPLOAD_RATE.windowMs / 1000));
  }, 60_000);

  it.each(ROUTES)('%s refuses media past the vault quota with 413', async (label, route) => {
    const { user, source, target } = await seeded(`admit-quota-${label.replace(/\W+/g, '-')}`);
    await d1.db.prepare("INSERT INTO assets (id, folder_id, filename, kind, content_type, size, current_version_id, created_by, created_at) VALUES (?1, ?2, 'filler.mp4', 'video', 'video/mp4', ?3, NULL, ?4, ?5)")
      .bind(crypto.randomUUID(), user.homeId, VAULT_MEDIA_QUOTA_BYTES - PNG.byteLength, user.id, Date.now()).run();
    const refused = await route(user, source, target);
    expect(refused.status, await refused.clone().text()).toBe(413);
    expect(((await refused.json()) as { message: string }).message).toMatch(/storage/i);
  }, 60_000);
});
