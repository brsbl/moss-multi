// Full sharing over REST (T2.4): share-by-email is no account-enumeration oracle (an unknown email becomes a pending
// invite with the same answer, rate limited per owner), the owner role can be granted, share links are created,
// listed and revoked by owners only, and a link opens a folder landing and a link-scoped workspace.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migratedD1, type TestD1 } from '../test/d1.ts';
import { BASE, insertDoc, insertFolder, insertGrant, SECRET, signedUpUser, type AuthTestEnv, type TestUser } from '../test/principals.ts';
import { handleApi } from './router.ts';

/** A§18: invites, 20 per hour per inviter. */
const SHARES_PER_HOUR = 20;

const DocDO = {
  idFromName: (name: string) => ({ name, toString: () => name }),
  get: () => ({ setName: async () => undefined, create: async () => undefined }),
};

let d1: TestD1;
let env: AuthTestEnv & Parameters<typeof handleApi>[1];
let ada: TestUser;
let ben: TestUser;
let cy: TestUser;

beforeAll(async () => {
  d1 = await migratedD1();
  env = { DB: d1.db, BETTER_AUTH_SECRET: SECRET, BETTER_AUTH_URL: BASE, DocDO: DocDO as never };
  ada = await signedUpUser(env, 'sharing-ada', 'Ada');
  ben = await signedUpUser(env, 'sharing-ben', 'Ben');
  cy = await signedUpUser(env, 'sharing-cy', 'Cy');
}, 60_000);
afterAll(() => d1?.dispose());

const call = (method: string, path: string, cookie: string | null, body?: unknown, headers: Record<string, string> = {}) =>
  handleApi(
    new Request(`${BASE}${path}`, {
      method,
      headers: { 'content-type': 'application/json', origin: BASE, ...(cookie ? { cookie } : {}), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    env,
  );

async function sha256(bytes: ArrayBuffer): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function fingerprint(response: Response) {
  return {
    status: response.status,
    contentType: response.headers.get('content-type'),
    cacheControl: response.headers.get('cache-control'),
    sha256: await sha256(await response.arrayBuffer()),
  };
}

async function roleOf(cookie: string | null, docId: string, token?: string): Promise<string | null> {
  const response = await call('GET', `/api/docs/${docId}${token ? `?share=${token}` : ''}`, cookie);
  return response.status === 200 ? ((await response.json()) as { role: string }).role : null;
}

const unknownEmail = (label: string) => `mm-t24-${label}-${crypto.randomUUID().slice(0, 8)}@example.invalid`;

describe('share-by-email is not an enumeration oracle', () => {
  it('turns an unknown email into a pending invite the owner sees by email, and nobody else sees', async () => {
    const docId = await insertDoc(d1.db, ada);
    await insertGrant(d1.db, { docId }, ben, 'viewer');
    const email = unknownEmail('pending');
    const response = await call('POST', `/api/docs/${docId}/members`, ada.cookie, { email: email.toUpperCase(), role: 'commenter' });
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ shared: { email, role: 'commenter' } });
    const row = await d1.db.prepare('SELECT email, target_type, target_id, role, invited_by, accepted_at, revoked_at FROM invites WHERE email = ?').bind(email).first();
    expect(row).toEqual({ email, target_type: 'doc', target_id: docId, role: 'commenter', invited_by: ada.id, accepted_at: null, revoked_at: null });

    const owner = (await (await call('GET', `/api/docs/${docId}/members`, ada.cookie)).json()) as { invites: unknown[] };
    expect(owner.invites).toEqual([{ email, role: 'commenter' }]);
    const member = await call('GET', `/api/docs/${docId}/members`, ben.cookie);
    const text = await member.text();
    expect(text).not.toContain('@');
    expect(JSON.parse(text)).not.toHaveProperty('invites');
  });

  it('treats a repeat, a raise and a lowering of a pending invite as it treats a member', async () => {
    const folderId = await insertFolder(d1.db, ada, ada.homeId);
    const email = unknownEmail('repeat');
    const path = `/api/folders/${folderId}/members`;
    for (const [person, label] of [[email, 'unknown'], [ben.email, 'known']] as const) {
      expect((await call('POST', path, ada.cookie, { email: person, role: 'commenter' })).status, `${label} first`).toBe(201);
      expect((await call('POST', path, ada.cookie, { email: person, role: 'commenter' })).status, `${label} repeat`).toBe(200);
      const raised = await call('POST', path, ada.cookie, { email: person, role: 'editor' });
      expect(raised.status, `${label} raise`).toBe(200);
      expect(await raised.json()).toEqual({ shared: { email: person, role: 'editor' } });
      const lowered = await call('POST', path, ada.cookie, { email: person, role: 'viewer' });
      expect(lowered.status, `${label} lowering`).toBe(409);
      expect(await lowered.json()).toMatchObject({ error: 'demotion-unavailable' });
    }
    const owner = (await (await call('GET', path, ada.cookie)).json()) as { invites: unknown[] };
    expect(owner.invites).toEqual([{ email, role: 'editor' }]);
  });

  it(`limits each owner to ${SHARES_PER_HOUR} new shares an hour, refusing known and unknown emails alike`, async () => {
    const owner = await signedUpUser(env, 'sharing-busy', 'Busy');
    const docId = await insertDoc(d1.db, owner);
    for (let i = 0; i < SHARES_PER_HOUR - 1; i += 1) {
      expect((await call('POST', `/api/docs/${docId}/members`, owner.cookie, { email: unknownEmail(`burst${i}`), role: 'viewer' })).status).toBe(201);
    }
    expect((await call('POST', `/api/docs/${docId}/members`, owner.cookie, { email: ben.email, role: 'viewer' })).status).toBe(201);
    const known = await call('POST', `/api/docs/${docId}/members`, owner.cookie, { email: cy.email, role: 'viewer' });
    const unknown = await call('POST', `/api/docs/${docId}/members`, owner.cookie, { email: unknownEmail('over'), role: 'viewer' });
    expect(known.status).toBe(429);
    expect(await fingerprint(unknown)).toEqual(await fingerprint(known));
    expect(await roleOf(cy.cookie, docId), 'nothing is granted past the limit').toBeNull();
    // Another owner is unaffected.
    expect((await call('POST', `/api/docs/${await insertDoc(d1.db, ada)}/members`, ada.cookie, { email: cy.email, role: 'viewer' })).status).toBe(201);
   }, 30_000);
});

describe('the owner role', () => {
  it('makes a co-owner who shares, sees emails and manages links, and cannot be lowered yet', async () => {
    const docId = await insertDoc(d1.db, ada);
    expect((await call('POST', `/api/docs/${docId}/members`, ada.cookie, { email: cy.email, role: 'owner' })).status).toBe(201);
    expect(await roleOf(cy.cookie, docId)).toBe('owner');
    expect((await call('POST', `/api/docs/${docId}/members`, cy.cookie, { email: ben.email, role: 'viewer' })).status).toBe(201);
    const list = (await (await call('GET', `/api/docs/${docId}/members`, cy.cookie)).json()) as { members: { email?: string; role: string }[] };
    expect(list.members.map((m) => [m.email, m.role])).toEqual([[ada.email, 'owner'], [cy.email, 'owner'], [ben.email, 'viewer']]);
    expect((await call('POST', `/api/docs/${docId}/links`, cy.cookie, { role: 'viewer' })).status).toBe(201);
    expect((await call('POST', `/api/docs/${docId}/members`, ada.cookie, { email: cy.email, role: 'editor' })).status).toBe(409);
  });
});

interface Link { token: string; role: string; createdAt: number }

describe('share links', () => {
  it('lets the owner create, list and revoke doc links; a revoked link answers like a forged one', async () => {
    const docId = await insertDoc(d1.db, ada);
    const made: Link[] = [];
    for (const role of ['viewer', 'commenter', 'editor']) {
      const response = await call('POST', `/api/docs/${docId}/links`, ada.cookie, { role });
      expect(response.status, role).toBe(201);
      const { link } = (await response.json()) as { link: Link };
      expect(link).toMatchObject({ role, token: expect.stringMatching(/^[0-9a-f]{48}$/) });
      made.push(link);
    }
    for (const role of ['owner', 'suggester', 'admin', null]) {
      expect((await call('POST', `/api/docs/${docId}/links`, ada.cookie, { role })).status, String(role)).toBe(400);
    }
    const listed = (await (await call('GET', `/api/docs/${docId}/links`, ada.cookie)).json()) as { links: Link[] };
    expect(listed.links.map((link) => link.token).sort()).toEqual(made.map((link) => link.token).sort());

    const [viewer] = made;
    expect(await roleOf(null, docId, viewer.token)).toBe('viewer');
    const revoked = await call('DELETE', `/api/docs/${docId}/links/${viewer.token}`, ada.cookie);
    expect(revoked.status).toBe(200);
    expect(((await (await call('GET', `/api/docs/${docId}/links`, ada.cookie)).json()) as { links: Link[] }).links).toHaveLength(2);
    const forged = 'f'.repeat(48);
    expect(await fingerprint(await call('GET', `/api/docs/${docId}?share=${viewer.token}`, null)))
      .toEqual(await fingerprint(await call('GET', `/api/docs/${docId}?share=${forged}`, null)));
    expect((await call('DELETE', `/api/docs/${docId}/links/${viewer.token}`, ada.cookie)).status, 'already revoked').toBe(404);
    const other = await insertDoc(d1.db, ada);
    expect((await call('DELETE', `/api/docs/${other}/links/${made[1].token}`, ada.cookie)).status, "another doc's link").toBe(404);
    expect(await roleOf(null, docId, made[1].token)).toBe('viewer');
  });

  it('is owner-only: a member gets 403, a stranger and a link holder 404, and nothing changes', async () => {
    const docId = await insertDoc(d1.db, ada);
    await insertGrant(d1.db, { docId }, ben, 'editor');
    const { link } = (await (await call('POST', `/api/docs/${docId}/links`, ada.cookie, { role: 'editor' })).json()) as { link: Link };
    for (const [method, suffix, body] of [['GET', ''], ['POST', '', { role: 'viewer' }], ['DELETE', `/${link.token}`]] as const) {
      const path = `/api/docs/${docId}/links${suffix}`;
      expect((await call(method, path, ben.cookie, body)).status, `member ${method}`).toBe(403);
      const stranger = await fingerprint(await call(method, path, cy.cookie, body));
      expect(stranger.status, `stranger ${method}`).toBe(404);
      expect(await fingerprint(await call(method, `/api/docs/${crypto.randomUUID()}/links${suffix}`, cy.cookie, body))).toEqual(stranger);
      expect((await call(method, `${path}?share=${link.token}`, null, body)).status, `link holder ${method}`).toBe(404);
    }
    expect(await roleOf(null, docId, link.token)).toBe('viewer');
  });

  it('puts a folder link over the whole subtree, as a ceiling that sign-in lifts and a grant can exceed', async () => {
    const folderId = await insertFolder(d1.db, ada, ada.homeId);
    const childId = await insertFolder(d1.db, ada, folderId);
    const docId = await insertDoc(d1.db, ada, { folderId: childId });
    const { link } = (await (await call('POST', `/api/folders/${folderId}/links`, ada.cookie, { role: 'editor' })).json()) as { link: Link };
    expect(await roleOf(null, docId, link.token), 'signed out: viewer').toBe('viewer');
    expect(await roleOf(ben.cookie, docId, link.token), 'signed in: the link role').toBe('editor');
    await insertGrant(d1.db, { docId }, cy, 'owner');
    expect(await roleOf(cy.cookie, docId, link.token), 'a grant above the link: the grant').toBe('owner');
    expect(await roleOf(ben.cookie, await insertDoc(d1.db, ada), link.token), 'nothing outside the folder').toBeNull();
  });
});

describe('GET /api/folders/:id', () => {
  it('answers the owner, a folder-link holder at viewer, and nobody else', async () => {
    const folderId = await insertFolder(d1.db, ada, ada.homeId);
    const owner = await call('GET', `/api/folders/${folderId}`, ada.cookie);
    expect(owner.status).toBe(200);
    expect(await owner.json()).toMatchObject({ folder: { id: folderId, kind: 'folder', vaultId: ada.homeId }, role: 'owner' });
    const { link } = (await (await call('POST', `/api/folders/${folderId}/links`, ada.cookie, { role: 'commenter' })).json()) as { link: Link };
    const anonymous = await call('GET', `/api/folders/${folderId}?share=${link.token}`, null);
    expect(anonymous.status).toBe(200);
    const body = (await anonymous.json()) as { folder: Record<string, unknown>; role: string };
    expect(body.role).toBe('viewer');
    expect(body.folder, 'a link holder learns nothing about the vault').not.toHaveProperty('vaultId');
    const denied = await fingerprint(await call('GET', `/api/folders/${folderId}`, cy.cookie));
    expect(denied.status).toBe(404);
    expect(await fingerprint(await call('GET', `/api/folders/${crypto.randomUUID()}`, cy.cookie))).toEqual(denied);
    const docToken = (await (await call('POST', `/api/docs/${await insertDoc(d1.db, ada, { folderId })}/links`, ada.cookie, { role: 'viewer' })).json()) as { link: Link };
    expect((await call('GET', `/api/folders/${folderId}?share=${docToken.link.token}`, null)).status, 'a doc link opens no folder').toBe(404);
  });
});

interface Listing {
  vault: { id: string; name: string; role: string; owned: boolean };
  vaults: { id: string; owned: boolean }[];
  docs: { id: string; folderPath: string; role: string }[];
  folders: { id: string; path: string }[];
}

describe('a link-scoped workspace', () => {
  it('lists only a doc link\'s doc, and a folder link\'s subtree, to an anonymous holder', async () => {
    const folderId = await insertFolder(d1.db, ada, ada.homeId);
    const childId = await insertFolder(d1.db, ada, folderId);
    const inside = await insertDoc(d1.db, ada, { folderId: childId });
    const outside = await insertDoc(d1.db, ada);
    const { link: docLink } = (await (await call('POST', `/api/docs/${inside}/links`, ada.cookie, { role: 'editor' })).json()) as { link: Link };
    const forDoc = await call('GET', '/api/workspace', null, undefined, { 'x-moss-share': docLink.token });
    expect(forDoc.status).toBe(200);
    const docListing = (await forDoc.json()) as Listing;
    expect(docListing.docs).toEqual([expect.objectContaining({ id: inside, folderPath: 'Notes', role: 'viewer' })]);
    expect(docListing.folders).toEqual([]);
    expect(JSON.stringify(docListing), 'no folder or vault of the owner is named').not.toMatch(new RegExp(`${folderId}|${childId}|${ada.homeId}`));

    const { link } = (await (await call('POST', `/api/folders/${folderId}/links`, ada.cookie, { role: 'viewer' })).json()) as { link: Link };
    const listing = (await (await call('GET', `/api/workspace?share=${link.token}`, null)).json()) as Listing;
    expect(listing.vault).toMatchObject({ id: folderId, role: 'viewer', owned: false });
    expect(listing.folders.map((folder) => folder.id)).toEqual([childId]);
    expect(listing.docs.map((doc) => doc.id)).toEqual([inside]);
    expect(listing.docs[0].folderPath).toBe(listing.folders[0].path);
    expect(listing.docs.map((doc) => doc.id)).not.toContain(outside);

    const forged = await fingerprint(await call('GET', `/api/workspace?share=${'0'.repeat(48)}`, null));
    expect(forged.status).toBe(404);
    expect(await fingerprint(await call('DELETE', `/api/docs/${inside}/links/${docLink.token}`, ada.cookie))).toMatchObject({ status: 200 });
    expect(await fingerprint(await call('GET', `/api/workspace?share=${docLink.token}`, null)), 'revoked as forged').toEqual(forged);
  });

  it('offers a signed-in holder of a folder link that folder beside their own vaults', async () => {
    const folderId = await insertFolder(d1.db, ada, ada.homeId);
    const docId = await insertDoc(d1.db, ada, { folderId });
    const { link } = (await (await call('POST', `/api/folders/${folderId}/links`, ada.cookie, { role: 'editor' })).json()) as { link: Link };
    const home = (await (await call('GET', `/api/workspace?share=${link.token}`, ben.cookie)).json()) as Listing;
    expect(home.vault.id).toBe(ben.homeId);
    expect(home.vaults).toContainEqual(expect.objectContaining({ id: folderId, owned: false }));
    expect(home.docs.map((doc) => doc.id)).not.toContain(docId);
    const scoped = (await (await call('GET', `/api/workspace?share=${link.token}&vault=${folderId}`, ben.cookie)).json()) as Listing;
    expect(scoped.vault).toMatchObject({ id: folderId, role: 'editor' });
    expect(scoped.docs).toEqual([expect.objectContaining({ id: docId, role: 'editor' })]);
    const without = (await (await call('GET', `/api/workspace?vault=${folderId}`, ben.cookie)).json()) as Listing;
    expect(without.vault.id, 'no link, no folder').toBe(ben.homeId);
  });
});
