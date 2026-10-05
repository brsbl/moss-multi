// T2.8 over REST: copy-link invites and the bell's notifications. Every share by email has an invite link only the
// owner can read, the same shape for a known and an unknown email; the link redeems for whoever signs in with it,
// once; a known grantee hears about a share in the bell, re-checked against the live grant whenever it is read, and
// redemption happens only on an explicit open (the link, the bell or the note's URL), never on a socket admission.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migratedD1, type TestD1 } from '../test/d1.ts';
import { BASE, insertDoc, insertFolder, insertLink, SECRET, signedUpUser, type AuthTestEnv, type TestUser } from '../test/principals.ts';
import { handleApi } from './router.ts';

const DocDO = {
  idFromName: (name: string) => ({ name, toString: () => name }),
  get: () => ({ setName: async () => undefined, create: async () => undefined }),
};

let d1: TestD1;
let env: AuthTestEnv & Parameters<typeof handleApi>[1];
let ada: TestUser;
let ben: TestUser;
let cy: TestUser;
const published: { id: string; event: unknown }[] = [];

beforeAll(async () => {
  d1 = await migratedD1();
  const PrincipalDO = {
    idFromName: (name: string) => name,
    get: (id: string) => ({ setName: async () => undefined, publish: async (event: unknown) => { published.push({ id, event }); } }),
  };
  env = { DB: d1.db, BETTER_AUTH_SECRET: SECRET, BETTER_AUTH_URL: BASE, DocDO: DocDO as never, PrincipalDO: PrincipalDO as never };
  ada = await signedUpUser(env, 't28-ada', 'Ada');
  ben = await signedUpUser(env, 't28-ben', 'Ben');
  cy = await signedUpUser(env, 't28-cy', 'Cy');
}, 60_000);
afterAll(() => d1?.dispose());

const call = (method: string, path: string, cookie: string | null, body?: unknown) =>
  handleApi(new Request(`${BASE}${path}`, {
    method,
    headers: { 'content-type': 'application/json', origin: BASE, ...(cookie ? { cookie } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), env);

const unknownEmail = (label: string) => `mm-t28-${label}-${crypto.randomUUID().slice(0, 8)}@example.invalid`;

async function roleOf(cookie: string, docId: string): Promise<string | null> {
  const response = await call('GET', `/api/docs/${docId}`, cookie);
  return response.status === 200 ? ((await response.json()) as { role: string }).role : null;
}

async function titled(owner: TestUser, title: string, options: { folderId?: string } = {}): Promise<string> {
  const docId = await insertDoc(d1.db, owner, options);
  await d1.db.prepare('UPDATE docs SET title = ? WHERE id = ?').bind(title, docId).run();
  return docId;
}

async function share(owner: TestUser, path: string, email: string, role = 'editor'): Promise<void> {
  const response = await call('POST', `${path}/members`, owner.cookie, { email, role });
  expect(response.status, `share ${email}`).toBeLessThan(300);
}

/** The owner's copyable invite link for `email`, read from the owner-only invites list. */
async function inviteLink(owner: TestUser, path: string, email: string): Promise<string> {
  const response = await call('GET', `${path}/invites`, owner.cookie);
  expect(response.status).toBe(200);
  const { invites } = (await response.json()) as { invites: { email: string; role: string; url: string }[] };
  const invite = invites.find((i) => i.email === email);
  if (!invite) throw new Error(`no invite for ${email}`);
  return invite.url;
}

const tokenOf = (url: string) => new URL(url, BASE).pathname.replace(/^\/invite\//, '');
const accept = (cookie: string | null, token: string) => call('POST', `/api/invites/${token}/accept`, cookie);

interface Notice {
  id: string;
  type: string;
  read: boolean;
  by: string;
  target: { type: string; id: string; title: string; kind: string };
}

async function bell(user: TestUser): Promise<Notice[]> {
  const response = await call('GET', '/api/notifications', user.cookie);
  expect(response.status).toBe(200);
  return ((await response.json()) as { notifications: Notice[] }).notifications;
}

async function membersOf(owner: TestUser, path: string) {
  return (await (await call('GET', `${path}/members`, owner.cookie)).json()) as { members: { name: string; role: string }[]; invites: { email: string }[] };
}

describe('copy-link invites', () => {
  it('gives the owner a copyable /invite link for every pending share, the same for a known and an unknown email', async () => {
    const docId = await titled(ada, 'Links');
    const path = `/api/docs/${docId}`;
    const ghost = unknownEmail('links');
    await share(ada, path, ben.email);
    await share(ada, path, ghost);
    const response = await call('GET', `${path}/invites`, ada.cookie);
    const { invites } = (await response.json()) as { invites: { email: string; role: string; url: string }[] };
    expect(invites.map((i) => [i.email, i.role])).toEqual([[ben.email, 'editor'], [ghost, 'editor']]);
    for (const invite of invites) expect(invite.url, invite.email).toMatch(new RegExp(`^${BASE}/invite/[0-9a-f]{48}$`));
    expect(Object.keys(invites[0]).sort()).toEqual(Object.keys(invites[1]).sort());

    await d1.db.prepare("INSERT INTO doc_members (doc_id, principal_id, principal_type, role, added_by, created_at) VALUES (?, ?, 'user', 'editor', ?, 1)")
      .bind(docId, cy.id, ada.id).run();
    expect((await call('GET', `${path}/invites`, cy.cookie)).status, 'an editor gets no invite links').toBe(403);
    const link = await insertLink(d1.db, { docId }, 'editor');
    expect((await call('GET', `${path}/invites?share=${link}`, null)).status, 'nor does a link holder').toBe(404);
  });

  it('redeems an unknown email’s invite after sign-up, once, at its role, and tells the inviter', async () => {
    const docId = await titled(ada, 'Welcome aboard');
    const path = `/api/docs/${docId}`;
    const ghost = unknownEmail('redeem');
    await share(ada, path, ghost, 'commenter');
    const token = tokenOf(await inviteLink(ada, path, ghost));

    expect((await accept(null, token)).status, 'signed out, the link asks for a session').toBe(401);
    const gus = await signedUpUser(env, 't28-gus', 'Gus', ghost);
    expect(await roleOf(gus.cookie, docId), 'signing up alone grants nothing').toBeNull();
    const redeemed = await accept(gus.cookie, token);
    expect(redeemed.status).toBe(200);
    expect(await redeemed.json()).toEqual({ target: { type: 'doc', id: docId } });
    expect(await roleOf(gus.cookie, docId), 'the invite role').toBe('commenter');
    expect((await accept(gus.cookie, token)).status, 'following it again still opens it').toBe(200);

    const after = await membersOf(ada, path);
    expect(after.members.map((m) => [m.name, m.role])).toEqual([['Ada', 'owner'], ['Gus', 'commenter']]);
    expect(after.invites).toEqual([]);
    const [notice] = await bell(ada);
    expect(notice).toMatchObject({ type: 'invite-accepted', read: false, by: 'Gus', target: { type: 'doc', id: docId, title: 'Welcome aboard' } });
    expect(published).toContainEqual({ id: ada.id, event: { type: 'notifications' } });

    expect((await accept(cy.cookie, token)).status, 'a redeemed link opens nothing for anyone else').toBe(404);
    expect(await roleOf(cy.cookie, docId)).toBeNull();
  });

  it('refuses forged, revoked and trashed invites alike, and lets the owner follow a link without spending it', async () => {
    const docId = await titled(ada, 'Guarded');
    const path = `/api/docs/${docId}`;
    const ghost = unknownEmail('guarded');
    await share(ada, path, ghost);
    const token = tokenOf(await inviteLink(ada, path, ghost));
    const forged = await accept(cy.cookie, 'f'.repeat(48));
    expect(forged.status).toBe(404);
    const refusal = await forged.text();
    const owner = await accept(ada.cookie, token);
    expect(owner.status).toBe(200);
    expect((await membersOf(ada, path)).invites.map((i) => i.email), 'the owner’s own click leaves it pending').toEqual([ghost]);

    await d1.db.prepare('UPDATE docs SET deleted_at = ? WHERE id = ?').bind(Date.now(), docId).run();
    const trashed = await accept(cy.cookie, token);
    expect(trashed.status).toBe(404);
    expect(await trashed.text(), 'one refusal for every cause').toBe(refusal);
    await d1.db.prepare('UPDATE docs SET deleted_at = NULL WHERE id = ?').bind(docId).run();
    await d1.db.prepare('UPDATE invites SET revoked_at = ? WHERE token = ?').bind(Date.now(), token).run();
    expect((await accept(cy.cookie, token)).status).toBe(404);
    expect(await roleOf(cy.cookie, docId)).toBeNull();
  });

  it('redeems a folder invite into the whole folder', async () => {
    const folderId = await insertFolder(d1.db, ada, ada.homeId);
    const inside = await titled(ada, 'Inside', { folderId });
    const ghost = unknownEmail('folder');
    await share(ada, `/api/folders/${folderId}`, ghost, 'viewer');
    const token = tokenOf(await inviteLink(ada, `/api/folders/${folderId}`, ghost));
    const hal = await signedUpUser(env, 't28-hal', 'Hal', ghost);
    const redeemed = await accept(hal.cookie, token);
    expect(await redeemed.json()).toEqual({ target: { type: 'folder', id: folderId } });
    expect(await roleOf(hal.cookie, inside)).toBe('viewer');
  });
});

describe('the bell', () => {
  it('tells a known grantee about a share, pushed to their tabs, and nobody about an unknown email', async () => {
    const dee = await signedUpUser(env, 't28-dee', 'Dee');
    const docId = await titled(ada, 'Roadmap');
    published.length = 0;
    await share(ada, `/api/docs/${docId}`, dee.email);
    await share(ada, `/api/docs/${docId}`, unknownEmail('nobody'));
    const notices = await bell(dee);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ type: 'share-invite', read: false, by: 'Ada', target: { type: 'doc', id: docId, title: 'Roadmap', kind: 'doc' } });
    expect(published).toContainEqual({ id: dee.id, event: { type: 'notifications' } });
    expect(await bell(ada), 'the owner hears nothing about her own share').toEqual([]);

    await share(ada, `/api/docs/${docId}`, dee.email);
    expect(await bell(dee), 'a repeat is not a new notice').toHaveLength(1);
    const vault = await signedUpUser(env, 't28-vault', 'Vee');
    await share(ada, `/api/folders/${ada.homeId}`, vault.email, 'viewer');
    expect((await bell(vault))[0]).toMatchObject({ type: 'share-invite', target: { type: 'folder', id: ada.homeId, kind: 'vault' } });
  });

  it('omits a notice whose grant was revoked or whose note was trashed, and shows it again once access returns', async () => {
    const eve = await signedUpUser(env, 't28-eve', 'Eve');
    const revoked = await titled(ada, 'Revoked');
    const trashed = await titled(ada, 'Trashed');
    await share(ada, `/api/docs/${revoked}`, eve.email);
    await share(ada, `/api/docs/${trashed}`, eve.email);
    expect((await bell(eve)).map((n) => n.target.title).sort()).toEqual(['Revoked', 'Trashed']);

    await d1.db.prepare('DELETE FROM doc_members WHERE doc_id = ? AND principal_id = ?').bind(revoked, eve.id).run();
    await d1.db.prepare('UPDATE docs SET deleted_at = ? WHERE id = ?').bind(Date.now(), trashed).run();
    const text = await (await call('GET', '/api/notifications', eve.cookie)).text();
    expect(JSON.parse(text)).toEqual({ notifications: [] });
    expect(text, 'not even the title leaks').not.toContain('Revoked');

    await d1.db.prepare('UPDATE docs SET deleted_at = NULL WHERE id = ?').bind(trashed).run();
    expect((await bell(eve)).map((n) => n.target.title)).toEqual(['Trashed']);
  });

  it('marks notices read for their owner only, and an opened share notice redeems the share', async () => {
    const fay = await signedUpUser(env, 't28-fay', 'Fay');
    const docId = await titled(ada, 'Read me');
    const path = `/api/docs/${docId}`;
    await share(ada, path, fay.email);
    const [notice] = await bell(fay);
    expect((await membersOf(ada, path)).invites.map((i) => i.email), 'pending until Fay opens it').toEqual([fay.email]);

    expect((await call('POST', '/api/notifications/read', ada.cookie, { ids: [notice.id] })).status).toBe(200);
    expect((await bell(fay))[0].read, 'someone else cannot mark it').toBe(false);
    published.length = 0;
    expect((await call('POST', '/api/notifications/read', fay.cookie, { ids: [notice.id], open: notice.id })).status).toBe(200);
    expect((await bell(fay))[0].read).toBe(true);
    expect(published, 'her other tabs hear it').toContainEqual({ id: fay.id, event: { type: 'notifications' } });
    const after = await membersOf(ada, path);
    expect(after.members.map((m) => m.name), 'opened from the bell, Fay is a member by name').toEqual(['Ada', 'Fay']);
    expect(after.invites).toEqual([]);

    expect((await call('GET', '/api/notifications', null)).status).toBe(401);
    expect((await call('POST', '/api/notifications/read', fay.cookie, { ids: 'all' })).status).toBe(400);
  });
});
