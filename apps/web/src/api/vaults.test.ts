// The vaults API (T3.5; A§6, A§8, A§11): POST /api/vaults creates one of the caller's own vaults, PATCH
// /api/vaults/:id renames it and DELETE /api/vaults/:id sends it to Trash as one batch. Only the vault's owner renames
// or trashes; a member gets 403 and a stranger the one 404; the last live vault is never trashed.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migratedD1, type TestD1 } from '../test/d1.ts';
import { agentKey, BASE, insertDoc, insertFolder, insertGrant, SECRET, signedUpUser, type AuthTestEnv, type TestUser } from '../test/principals.ts';
import { handleApi } from './router.ts';

const trashed: string[] = [];
const published = new Map<string, { type: string; docIds?: string[]; folderIds?: string[] }[]>();

const DocDO = {
  idFromName: (name: string) => ({ name, toString: () => name }),
  get: (id: { name: string }) => ({
    setName: async () => undefined,
    trash: async () => { trashed.push(id.name); },
  }),
};

const PrincipalDO = {
  idFromName: (name: string) => ({ name, toString: () => name }),
  get: (id: { name: string }) => ({
    setName: async () => undefined,
    publish: async (event: { type: string }) => { published.set(id.name, [...(published.get(id.name) ?? []), event]); },
  }),
};

let d1: TestD1;
let env: AuthTestEnv & Parameters<typeof handleApi>[1];
let ada: TestUser;
let ben: TestUser;
let cy: TestUser;

beforeAll(async () => {
  d1 = await migratedD1();
  env = { DB: d1.db, BETTER_AUTH_SECRET: SECRET, BETTER_AUTH_URL: BASE, DocDO: DocDO as never, PrincipalDO: PrincipalDO as never };
  ada = await signedUpUser(env, 'vaults-ada');
  ben = await signedUpUser(env, 'vaults-ben', 'Ben');
  cy = await signedUpUser(env, 'vaults-cy', 'Cy');
}, 60_000);
afterAll(() => d1?.dispose());
beforeEach(() => {
  trashed.length = 0;
  published.clear();
});

const call = (user: TestUser | null, method: string, path: string, body?: unknown) =>
  handleApi(new Request(`${BASE}${path}`, {
    method,
    headers: { origin: BASE, 'content-type': 'application/json', ...(user ? { cookie: user.cookie } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), env);

const row = (id: string) => d1.db.prepare('SELECT * FROM folders WHERE id = ?').bind(id).first<Record<string, unknown>>();
const docRow = (id: string) => d1.db.prepare('SELECT * FROM docs WHERE id = ?').bind(id).first<Record<string, unknown>>();

async function expectSentence(response: Response, status: number, pattern?: RegExp): Promise<void> {
  expect(response.status).toBe(status);
  const body = (await response.json()) as { error?: string; message?: string };
  expect(typeof body.error).toBe('string');
  expect(body.message).toMatch(/^[A-Z].*\S \S.*[.!]$/);
  if (pattern) expect(body.message).toMatch(pattern);
}

async function newVault(user: TestUser, name: string): Promise<string> {
  const response = await call(user, 'POST', '/api/vaults', { name });
  expect(response.status, await response.clone().text()).toBe(201);
  const body = (await response.json()) as { vault: { id: string; name: string; role: string; owned: boolean } };
  expect(body.vault).toMatchObject({ name, role: 'owner', owned: true });
  return body.vault.id;
}

const listedVaults = async (user: TestUser, query = '') =>
  ((await (await call(user, 'GET', `/api/workspace${query}`)).json()) as { vault: { id: string }; vaults: { id: string; name: string; role?: string }[] });

describe('POST /api/vaults', () => {
  it('creates a vault the caller owns, lists it, and tells the caller’s other tabs', async () => {
    const id = await newVault(ada, 'Research');
    expect(await row(id)).toMatchObject({ owner_user_id: ada.id, created_by: ada.id, name: 'Research', kind: 'vault', parent_id: null, deleted_at: null });
    const listing = await listedVaults(ada, `?vault=${id}`);
    expect(listing.vault.id).toBe(id);
    expect(listing.vaults.map((vault) => vault.name)).toContain('Research');
    expect(published.get(ada.id)).toContainEqual({ type: 'vaults' });
  });

  it('refuses a duplicate name (any case), a blank name, a slash and anonymous callers, each with a sentence', async () => {
    await newVault(ada, 'Journal');
    await expectSentence(await call(ada, 'POST', '/api/vaults', { name: 'journal' }), 409, /already have a vault/);
    await expectSentence(await call(ada, 'POST', '/api/vaults', { name: '   ' }), 400);
    await expectSentence(await call(ada, 'POST', '/api/vaults', { name: 'a/b' }), 400);
    await expectSentence(await call(ada, 'POST', '/api/vaults', { name: 'x'.repeat(101) }), 400);
    expect((await call(null, 'POST', '/api/vaults', { name: 'Nope' })).status).toBe(401);
    // Another person may use the same name.
    await newVault(ben, 'Journal');
  });
});

describe('PATCH /api/vaults/:id', () => {
  it('lets the owner rename, and everyone with access hears about it', async () => {
    const id = await newVault(ada, 'Drafts');
    await insertGrant(d1.db, { folderId: id }, ben, 'editor');
    published.clear();
    const response = await call(ada, 'PATCH', `/api/vaults/${id}`, { name: 'Final drafts' });
    expect(response.status, await response.clone().text()).toBe(200);
    expect(((await response.json()) as { vault: { name: string } }).vault.name).toBe('Final drafts');
    expect(await row(id)).toMatchObject({ name: 'Final drafts' });
    expect(published.get(ada.id)).toContainEqual({ type: 'vaults' });
    expect(published.get(ben.id)).toContainEqual({ type: 'vaults' });
    const benSees = await listedVaults(ben);
    expect(benSees.vaults).toContainEqual(expect.objectContaining({ id, name: 'Final drafts', role: 'editor' }));
  });

  it('refuses a member with 403, a stranger and a folder with the one 404, and a taken name with 409', async () => {
    const id = await newVault(ada, 'Shared space');
    await insertGrant(d1.db, { folderId: id }, ben, 'editor');
    await expectSentence(await call(ben, 'PATCH', `/api/vaults/${id}`, { name: 'Mine now' }), 403, /owner/);
    const stranger = await call(cy, 'PATCH', `/api/vaults/${id}`, { name: 'Mine now' });
    expect(stranger.status).toBe(404);
    const folder = await insertFolder(d1.db, ada, id);
    const notVault = await call(ada, 'PATCH', `/api/vaults/${folder}`, { name: 'Renamed' });
    expect(notVault.status).toBe(404);
    expect(await stranger.text()).toBe(await notVault.text());
    await newVault(ada, 'Taken');
    await expectSentence(await call(ada, 'PATCH', `/api/vaults/${id}`, { name: 'TAKEN' }), 409, /already have a vault/);
    await expectSentence(await call(ada, 'PATCH', `/api/vaults/${id}`, { name: '' }), 400);
    expect(await row(id)).toMatchObject({ name: 'Shared space' });
  });
});

describe('an agent key never renames or trashes a vault', () => {
  const asAgent = (key: string, method: string, path: string, body?: unknown) =>
    handleApi(new Request(`${BASE}${path}`, {
      method,
      headers: { origin: BASE, 'content-type': 'application/json', authorization: `Bearer ${key}` },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }), env);

  it('the owner’s own live agent is refused a rename with 403 and the name stays; the owner still renames', async () => {
    const id = await newVault(ada, 'Agent proof');
    const key = await agentKey(d1.db, ada);
    await expectSentence(await asAgent(key, 'PATCH', `/api/vaults/${id}`, { name: 'Agent named' }), 403, /owner/);
    expect(await row(id)).toMatchObject({ name: 'Agent proof' });
    await expectSentence(await asAgent(key, 'DELETE', `/api/vaults/${id}`), 403, /owner/);
    expect((await row(id))?.deleted_at).toBeNull();
    expect((await call(ada, 'PATCH', `/api/vaults/${id}`, { name: 'Owner named' })).status).toBe(200);
    expect(await row(id)).toMatchObject({ name: 'Owner named' });
  });
});

describe('DELETE /api/vaults/:id', () => {
  it('sends the vault, its folders and its notes to Trash as one batch and closes the open notes', async () => {
    const id = await newVault(ada, 'Old project');
    const folder = await insertFolder(d1.db, ada, id);
    const atRoot = await insertDoc(d1.db, ada, { folderId: id });
    const inFolder = await insertDoc(d1.db, ada, { folderId: folder });
    await insertGrant(d1.db, { folderId: id }, ben, 'viewer');
    published.clear();
    const response = await call(ada, 'DELETE', `/api/vaults/${id}`);
    expect(response.status, await response.clone().text()).toBe(200);
    const vault = await row(id);
    expect(vault?.deleted_at).not.toBeNull();
    expect((await row(folder))?.trash_batch_id).toBe(vault?.trash_batch_id);
    expect((await docRow(atRoot))?.trash_batch_id).toBe(vault?.trash_batch_id);
    expect((await docRow(inFolder))?.deleted_at).not.toBeNull();
    expect(trashed.sort()).toEqual([atRoot, inFolder].sort());
    expect(published.has(ben.id)).toBe(true);
    // Gone from both switchers; asking for it falls back to Home.
    expect((await listedVaults(ben)).vaults.map((v) => v.id)).not.toContain(id);
    const fallback = await listedVaults(ada, `?vault=${id}`);
    expect(fallback.vault.id).not.toBe(id);
    expect(fallback.vaults.map((v) => v.id)).not.toContain(id);
    expect((await call(ada, 'GET', `/api/docs/${atRoot}`)).status).toBe(404);
  });

  it('is the owner’s alone: a member gets 403, a stranger 404, and nothing changes', async () => {
    const id = await newVault(ada, 'Keep me');
    await insertGrant(d1.db, { folderId: id }, ben, 'editor');
    await expectSentence(await call(ben, 'DELETE', `/api/vaults/${id}`), 403, /owner/);
    expect((await call(cy, 'DELETE', `/api/vaults/${id}`)).status).toBe(404);
    expect((await row(id))?.deleted_at).toBeNull();
  });

  it('never trashes the last live vault, and trashing the default vault moves the default', async () => {
    const solo = await signedUpUser(env, 'vaults-solo', 'Solo');
    await expectSentence(await call(solo, 'DELETE', `/api/vaults/${solo.homeId}`), 409, /only vault/);
    expect((await row(solo.homeId))?.deleted_at).toBeNull();
    const other = await newVault(solo, 'Second');
    expect((await call(solo, 'DELETE', `/api/vaults/${solo.homeId}`)).status).toBe(200);
    expect((await listedVaults(solo)).vault.id).toBe(other);
    await expectSentence(await call(solo, 'DELETE', `/api/vaults/${other}`), 409, /only vault/);
  });
});
