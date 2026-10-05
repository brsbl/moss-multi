// T2.8 over REST: copy-link invites and the bell's notifications. Every share by email is an invite bound to the email
// and a random token, never to an account (A§8): it grants nothing until its invitee, signed in with that email,
// redeems it, from its link or from its notice in their bell. Only the owner reads the link; the bell derives an
// invite's notice from the invite itself, for the account whose email it names; an invite dies when its inviter
// stops managing the item or the item goes to Trash.
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
  /** A share's invite token, for the account whose email it names. */
  invite?: string;
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
    await expect.poll(() => published).toContainEqual({ id: ada.id, event: { type: 'notifications' } });

    expect((await accept(cy.cookie, token)).status, 'a redeemed link opens nothing for anyone else').toBe(404);
    expect(await roleOf(cy.cookie, docId)).toBeNull();
  });

  it('refuses forged, revoked, trashed and other accounts’ invites with one answer, and lets the owner follow a link without spending it', async () => {
    const docId = await titled(ada, 'Guarded');
    const path = `/api/docs/${docId}`;
    const ghost = unknownEmail('guarded');
    await share(ada, path, ghost);
    const token = tokenOf(await inviteLink(ada, path, ghost));
    const forged = await accept(cy.cookie, 'f'.repeat(48));
    expect(forged.status).toBe(404);
    const refusal = await forged.text();
    expect(JSON.parse(refusal), 'the redeemer only hears the invite is for another email').toMatchObject({ error: 'invite-unavailable', message: expect.stringMatching(/another email/) });
    const wrong = await accept(cy.cookie, token);
    expect(await wrong.text(), 'another account: the same answer').toBe(refusal);
    const owner = await accept(ada.cookie, token);
    expect(owner.status).toBe(200);
    expect((await membersOf(ada, path)).invites.map((i) => i.email), 'the owner’s own click leaves it pending').toEqual([ghost]);

    const gil = await signedUpUser(env, 't28-gil', 'Gil', ghost);
    await d1.db.prepare('UPDATE docs SET deleted_at = ? WHERE id = ?').bind(Date.now(), docId).run();
    const trashed = await accept(gil.cookie, token);
    expect(trashed.status).toBe(404);
    expect(await trashed.text(), 'one refusal for every cause').toBe(refusal);
    await d1.db.prepare('UPDATE docs SET deleted_at = NULL WHERE id = ?').bind(docId).run();
    await d1.db.prepare('UPDATE invites SET revoked_at = ? WHERE token = ?').bind(Date.now(), token).run();
    expect(await (await accept(gil.cookie, token)).text()).toBe(refusal);
    expect(await roleOf(gil.cookie, docId)).toBeNull();
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

describe('who an invite admits', { timeout: 30_000 }, () => {
  it('redeems only for its own email, so following a link never tells the owner whether the email had an account', async () => {
    const docId = await titled(ada, 'No oracle');
    const path = `/api/docs/${docId}`;
    const kim = await signedUpUser(env, 't28-kim', 'Kim');
    const ghost = unknownEmail('oracle');
    await share(ada, path, kim.email);
    await share(ada, path, ghost);
    expect(await roleOf(kim.cookie, docId), 'an account is granted nothing until it redeems').toBeNull();
    const before = await membersOf(ada, path);
    // Ada's second account (Cy) follows both links.
    const known = await accept(cy.cookie, tokenOf(await inviteLink(ada, path, kim.email)));
    const unknown = await accept(cy.cookie, tokenOf(await inviteLink(ada, path, ghost)));
    expect([known.status, unknown.status], 'neither link admits another account').toEqual([404, 404]);
    expect(await known.text()).toBe(await unknown.text());
    expect(await roleOf(cy.cookie, docId)).toBeNull();
    const after = await membersOf(ada, path);
    expect(after, 'the member list is unchanged and names nobody').toEqual(before);
    expect(after.members.map((m) => m.name)).toEqual(['Ada']);
    expect(after.invites.map((i) => i.email)).toEqual([kim.email, ghost]);

    expect((await accept(kim.cookie, tokenOf(await inviteLink(ada, path, kim.email)))).status, 'its own account redeems it').toBe(200);
    expect((await membersOf(ada, path)).members.map((m) => m.name)).toEqual(['Ada', 'Kim']);
  });

  it('refuses an invite once its inviter no longer manages the target: revocation wins', async () => {
    const folderId = await insertFolder(d1.db, ada, ada.homeId);
    const docId = await titled(ada, 'Moved out', { folderId });
    const coOwner = await signedUpUser(env, 't28-joe', 'Joe');
    await share(ada, `/api/folders/${folderId}`, coOwner.email, 'owner');
    const ghost = unknownEmail('regain');
    await share(coOwner, `/api/docs/${docId}`, ghost, 'owner');
    const token = tokenOf(await inviteLink(coOwner, `/api/docs/${docId}`, ghost));

    // Ada moves the note out of Joe's folder, which ends his access to it.
    await d1.db.prepare('UPDATE docs SET folder_id = ? WHERE id = ?').bind(ada.homeId, docId).run();
    expect(await roleOf(coOwner.cookie, docId)).toBeNull();
    const ghostAccount = await signedUpUser(env, 't28-kit', 'Kit', ghost);
    expect((await accept(ghostAccount.cookie, token)).status, 'the invite died with Joe’s authority').toBe(404);
    expect(await roleOf(ghostAccount.cookie, docId)).toBeNull();

    // A folder invite likewise needs its inviter to manage the folder still.
    const other = unknownEmail('folder-regain');
    await share(coOwner, `/api/folders/${folderId}`, other, 'owner');
    const folderToken = tokenOf(await inviteLink(coOwner, `/api/folders/${folderId}`, other));
    await d1.db.prepare('DELETE FROM folder_members WHERE folder_id = ? AND principal_id = ?').bind(folderId, coOwner.id).run();
    const otherAccount = await signedUpUser(env, 't28-liv', 'Liv', other);
    expect((await accept(otherAccount.cookie, folderToken)).status).toBe(404);
    expect((await call('GET', `/api/folders/${folderId}`, otherAccount.cookie)).status).not.toBe(200);
  });

  it('lets a re-share by a current owner take over an invite whose inviter lost access, with a fresh link', async () => {
    const folderId = await insertFolder(d1.db, ada, ada.homeId);
    const docId = await titled(ada, 'Taken over', { folderId });
    const coOwner = await signedUpUser(env, 't28-max', 'Max');
    await share(ada, `/api/folders/${folderId}`, coOwner.email, 'owner');
    const ghost = unknownEmail('takeover');
    await share(coOwner, `/api/docs/${docId}`, ghost, 'owner');
    const dead = tokenOf(await inviteLink(coOwner, `/api/docs/${docId}`, ghost));
    await d1.db.prepare('UPDATE docs SET folder_id = ? WHERE id = ?').bind(ada.homeId, docId).run();

    await share(ada, `/api/docs/${docId}`, ghost, 'commenter');
    const fresh = tokenOf(await inviteLink(ada, `/api/docs/${docId}`, ghost));
    expect(fresh, 'the re-share offers a new link').not.toBe(dead);
    const guest = await signedUpUser(env, 't28-nia', 'Nia', ghost);
    expect((await accept(guest.cookie, dead)).status, 'the old link stays dead').toBe(404);
    expect((await accept(guest.cookie, fresh)).status, 'the new link redeems').toBe(200);
    expect(await roleOf(guest.cookie, docId), 'at the role the current owner chose').toBe('commenter');
  });
});

describe('the bell', { timeout: 30_000 }, () => {
  it('derives a share’s notice from its invite for the account with that email, and pushes it to their tabs', async () => {
    const dee = await signedUpUser(env, 't28-dee', 'Dee');
    const docId = await titled(ada, 'Roadmap');
    published.length = 0;
    await share(ada, `/api/docs/${docId}`, dee.email);
    const ghost = unknownEmail('nobody');
    await share(ada, `/api/docs/${docId}`, ghost);
    const notices = await bell(dee);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ type: 'share-invite', read: false, by: 'Ada', target: { type: 'doc', id: docId, title: 'Roadmap', kind: 'doc' } });
    expect(notices[0].invite, 'the notice carries its invite').toBe(tokenOf(await inviteLink(ada, `/api/docs/${docId}`, dee.email)));
    await expect.poll(() => published, { message: 'pushed after the answer' }).toContainEqual({ id: dee.id, event: { type: 'notifications' } });
    expect((await bell(ada)).filter((n) => n.target.id === docId), 'the owner hears nothing about her own share').toEqual([]);

    await share(ada, `/api/docs/${docId}`, dee.email);
    expect(await bell(dee), 'a repeat is not a new notice').toHaveLength(1);
    const vault = await signedUpUser(env, 't28-vault', 'Vee');
    await share(ada, `/api/folders/${ada.homeId}`, vault.email, 'viewer');
    expect((await bell(vault))[0]).toMatchObject({ type: 'share-invite', target: { type: 'folder', id: ada.homeId, kind: 'vault' } });

    // An email that signs up after the share finds its invite in the bell too.
    const late = await signedUpUser(env, 't28-late', 'Lou', ghost);
    expect((await bell(late)).map((n) => [n.type, n.target.id])).toEqual([['share-invite', docId]]);
  });

  it('opens a notice’s invite from the bell: following it redeems the share, once', async () => {
    const fay = await signedUpUser(env, 't28-fay', 'Fay');
    const docId = await titled(ada, 'Read me');
    const path = `/api/docs/${docId}`;
    await share(ada, path, fay.email);
    const [notice] = await bell(fay);
    expect((await membersOf(ada, path)).invites.map((i) => i.email), 'pending until Fay redeems it').toEqual([fay.email]);
    expect(await roleOf(fay.cookie, docId)).toBeNull();

    expect((await call('POST', '/api/notifications/read', ada.cookie, { ids: [notice.id] })).status).toBe(200);
    expect((await bell(fay))[0].read, 'someone else cannot mark it').toBe(false);
    published.length = 0;
    expect((await call('POST', '/api/notifications/read', fay.cookie, { ids: [notice.id] })).status).toBe(200);
    expect((await bell(fay))[0].read).toBe(true);
    await expect.poll(() => published, { message: 'her other tabs hear it' }).toContainEqual({ id: fay.id, event: { type: 'notifications' } });
    expect(await roleOf(fay.cookie, docId), 'reading a notice redeems nothing').toBeNull();

    expect((await accept(fay.cookie, notice.invite!)).status).toBe(200);
    expect(await roleOf(fay.cookie, docId)).toBe('editor');
    const after = await membersOf(ada, path);
    expect(after.members.map((m) => m.name), 'redeemed, Fay is a member by name').toEqual(['Ada', 'Fay']);
    expect(after.invites).toEqual([]);
    expect((await bell(fay)).map((n) => n.target.id), 'the redeemed notice stays while she can open the note').toEqual([docId]);

    expect((await call('GET', '/api/notifications', null)).status).toBe(401);
    expect((await call('POST', '/api/notifications/read', fay.cookie, { ids: 'all' })).status).toBe(400);
  });

  it('omits a notice whose grant was revoked, whose note was trashed or whose inviter lost manage, and shows it again once it is live', async () => {
    const eve = await signedUpUser(env, 't28-eve', 'Eve');
    const revoked = await titled(ada, 'Revoked');
    const trashed = await titled(ada, 'Trashed');
    const folderId = await insertFolder(d1.db, ada, ada.homeId);
    const orphaned = await titled(ada, 'Orphaned', { folderId });
    const joe = await signedUpUser(env, 't28-joe2', 'Joe');
    await d1.db.prepare("INSERT INTO folder_members (folder_id, principal_id, principal_type, role, added_by, created_at) VALUES (?, ?, 'user', 'owner', ?, 1)")
      .bind(folderId, joe.id, ada.id).run();
    await share(ada, `/api/docs/${revoked}`, eve.email);
    await share(ada, `/api/docs/${trashed}`, eve.email);
    await share(joe, `/api/docs/${orphaned}`, eve.email);
    expect((await bell(eve)).map((n) => n.target.title).sort()).toEqual(['Orphaned', 'Revoked', 'Trashed']);
    const redeemNotice = (await bell(eve)).find((n) => n.target.id === revoked)!;
    expect((await accept(eve.cookie, redeemNotice.invite!)).status).toBe(200);

    await d1.db.prepare('DELETE FROM doc_members WHERE doc_id = ? AND principal_id = ?').bind(revoked, eve.id).run();
    await d1.db.prepare('UPDATE docs SET deleted_at = ? WHERE id = ?').bind(Date.now(), trashed).run();
    await d1.db.prepare('UPDATE docs SET folder_id = ? WHERE id = ?').bind(ada.homeId, orphaned).run();
    const text = await (await call('GET', '/api/notifications', eve.cookie)).text();
    expect(JSON.parse(text)).toEqual({ notifications: [] });
    for (const title of ['Revoked', 'Trashed', 'Orphaned']) expect(text, `not even the title ${title} leaks`).not.toContain(title);

    await d1.db.prepare('UPDATE docs SET deleted_at = NULL WHERE id = ?').bind(trashed).run();
    expect((await bell(eve)).map((n) => n.target.title)).toEqual(['Trashed']);
  });
});
