// T2.8 over REST under PRODUCT ruling 19: copy-link invites and the bell. Every share by email is an invite bound to
// the email and a random token, a personal link only the owner reads, and it grants nothing until an account with that
// email redeems it while signed in; anyone else is told it is for another email. Owning the address alone grants
// nothing and tells its account nothing. An invite dies when its inviter stops managing the item or the item goes to
// Trash, also when that lands while a share is in flight. The bell tells an inviter their invite was accepted, pushed
// to their tabs and re-checked against the live grant whenever it is read.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { migratedD1, type TestD1 } from '../test/d1.ts';
import { redeem } from '../test/invites.ts';
import { BASE, insertDoc, insertFolder, insertGrant, insertLink, SECRET, signedUpUser, type AuthTestEnv, type TestUser } from '../test/principals.ts';
import { INVITE_OTHER_EMAIL } from './invites.ts';
import { handleApi } from './router.ts';

const DocDO = {
  idFromName: (name: string) => ({ name, toString: () => name }),
  get: () => ({ setName: async () => undefined, create: async () => undefined, trash: async () => undefined, settle: async () => ({}) }),
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
    await expect.poll(() => published).toContainEqual({ id: ada.id, event: { type: 'notifications' } });

    expect((await accept(cy.cookie, token)).status, 'a redeemed link opens nothing for anyone else').toBe(404);
    expect(await roleOf(cy.cookie, docId)).toBeNull();
  });

  it('refuses forged, revoked, spent and trashed invites with one answer, and lets the owner follow a link without spending it', async () => {
    const docId = await titled(ada, 'Guarded');
    const path = `/api/docs/${docId}`;
    const ghost = unknownEmail('guarded');
    await share(ada, path, ghost);
    const token = tokenOf(await inviteLink(ada, path, ghost));
    const forged = await accept(cy.cookie, 'f'.repeat(48));
    expect(forged.status).toBe(404);
    const refusal = await forged.text();
    expect(JSON.parse(refusal)).toMatchObject({ error: 'invite-unavailable', message: expect.stringMatching(/no longer open/) });
    const owner = await accept(ada.cookie, token);
    expect(owner.status).toBe(200);
    expect((await membersOf(ada, path)).invites.map((i) => i.email), 'the owner’s own click leaves it pending').toEqual([ghost]);

    const gil = await signedUpUser(env, 't28-gil', 'Gil', ghost);
    expect((await call('DELETE', path, ada.cookie)).status, 'Ada sends the note to Trash').toBe(200);
    const trashed = await accept(gil.cookie, token);
    expect(trashed.status).toBe(404);
    expect(await trashed.text(), 'one refusal for every cause').toBe(refusal);
    // A restore brings the note back, never the invite that died with the trash.
    expect((await call('POST', `${path}/restore`, ada.cookie)).status).toBe(200);
    expect(await (await accept(gil.cookie, token)).text(), 'the trashed invite stays dead after a restore').toBe(refusal);
    expect(await roleOf(gil.cookie, docId)).toBeNull();
    expect((await membersOf(ada, path)).invites, 'and is not listed again').toEqual([]);
  });

  it('keeps an invite dead after a folder trash and a restore of its note', async () => {
    const folderId = await insertFolder(d1.db, ada, ada.homeId);
    const docId = await titled(ada, 'Folder trash', { folderId });
    const path = `/api/docs/${docId}`;
    const ghost = unknownEmail('folder-trash');
    await share(ada, path, ghost);
    const token = tokenOf(await inviteLink(ada, path, ghost));
    expect((await call('DELETE', `/api/folders/${folderId}`, ada.cookie)).status).toBe(200);
    expect((await call('POST', `${path}/restore`, ada.cookie)).status).toBe(200);
    expect((await accept(cy.cookie, token)).status).toBe(404);
    expect(await roleOf(cy.cookie, docId)).toBeNull();
    expect((await membersOf(ada, path)).invites).toEqual([]);
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
  it('admits only an account with the invite’s email: anyone else is told it is for another email and it stays open', async () => {
    const docId = await titled(ada, 'For Kim');
    const path = `/api/docs/${docId}`;
    const kim = await signedUpUser(env, 't28-kim', 'Kim');
    await share(ada, path, kim.email);
    expect(await roleOf(kim.cookie, docId), 'an account is granted nothing by its email alone').toBeNull();
    expect((await membersOf(ada, path)).members.map((m) => m.name)).toEqual(['Ada']);
    // Ada's link reaches Cy instead: it admits nobody but Kim.
    const token = tokenOf(await inviteLink(ada, path, kim.email));
    const other = await accept(cy.cookie, token);
    expect(other.status).toBe(403);
    expect(await other.json()).toEqual({ error: 'invite-for-another-email', message: INVITE_OTHER_EMAIL });
    expect(await roleOf(cy.cookie, docId)).toBeNull();
    expect((await membersOf(ada, path)).invites.map((i) => i.email), 'still open for Kim').toEqual([kim.email]);
    expect((await accept(kim.cookie, token)).status).toBe(200);
    expect(await roleOf(kim.cookie, docId)).toBe('editor');
    expect((await accept(cy.cookie, token)).status, 'spent, it admits nobody else').toBe(404);
    const after = await membersOf(ada, path);
    expect(after.members.map((m) => m.name)).toEqual(['Ada', 'Kim']);
    expect(after.invites).toEqual([]);
  });

  it('refuses an invite once its inviter no longer manages the target: revocation wins', async () => {
    const folderId = await insertFolder(d1.db, ada, ada.homeId);
    const docId = await titled(ada, 'Moved out', { folderId });
    const coOwner = await signedUpUser(env, 't28-joe', 'Joe');
    await share(ada, `/api/folders/${folderId}`, coOwner.email, 'owner');
    await redeem(env, ada, `/api/folders/${folderId}`, coOwner);
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

  it('never revives an invite when its inviter gets manage back: the note moves out of their folder and back', async () => {
    const folderId = await insertFolder(d1.db, ada, ada.homeId);
    const docId = await titled(ada, 'Out and back', { folderId });
    const coOwner = await signedUpUser(env, 't28-ola', 'Ola');
    await share(ada, `/api/folders/${folderId}`, coOwner.email, 'owner');
    await redeem(env, ada, `/api/folders/${folderId}`, coOwner);
    const ghost = unknownEmail('out-and-back');
    await share(coOwner, `/api/docs/${docId}`, ghost, 'editor');
    const token = tokenOf(await inviteLink(coOwner, `/api/docs/${docId}`, ghost));

    const move = (to: string) => call('PATCH', `/api/docs/${docId}`, ada.cookie, { folderId: to });
    expect((await move(ada.homeId)).status, 'out of Ola’s folder').toBe(200);
    expect(await roleOf(coOwner.cookie, docId)).toBeNull();
    expect((await move(folderId)).status, 'and back in').toBe(200);
    expect(await roleOf(coOwner.cookie, docId), 'Ola manages it again').toBe('owner');
    expect((await accept(cy.cookie, token)).status, 'her old invite died when she lost manage').toBe(404);
    expect(await roleOf(cy.cookie, docId)).toBeNull();
    expect((await membersOf(ada, `/api/docs/${docId}`)).invites, 'and is not listed again').toEqual([]);
  });

  it('never revives a folder invite when its folder moves out of the inviter’s folder and back', async () => {
    const outer = await insertFolder(d1.db, ada, ada.homeId);
    const inner = await insertFolder(d1.db, ada, outer);
    const coOwner = await signedUpUser(env, 't28-pia', 'Pia');
    await share(ada, `/api/folders/${outer}`, coOwner.email, 'owner');
    await redeem(env, ada, `/api/folders/${outer}`, coOwner);
    const ghost = unknownEmail('folder-out-and-back');
    await share(coOwner, `/api/folders/${inner}`, ghost, 'viewer');
    const token = tokenOf(await inviteLink(coOwner, `/api/folders/${inner}`, ghost));

    const move = (to: string) => call('PATCH', `/api/folders/${inner}`, ada.cookie, { parentId: to });
    expect((await move(ada.homeId)).status).toBe(200);
    expect((await move(outer)).status).toBe(200);
    expect((await accept(cy.cookie, token)).status).toBe(404);
    expect((await call('GET', `/api/folders/${inner}`, cy.cookie)).status).not.toBe(200);
  });

  it('lets a re-share by a current owner take over an invite whose inviter lost access, with a fresh link', async () => {
    const folderId = await insertFolder(d1.db, ada, ada.homeId);
    const docId = await titled(ada, 'Taken over', { folderId });
    const coOwner = await signedUpUser(env, 't28-max', 'Max');
    await share(ada, `/api/folders/${folderId}`, coOwner.email, 'owner');
    await redeem(env, ada, `/api/folders/${folderId}`, coOwner);
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

/** `env` whose next D1 batch waits at the gate: `arrived` resolves when it gets there, `open()` lets it run. */
function gatedBatch() {
  let arrive: () => void = () => undefined;
  let open: () => void = () => undefined;
  const arrived = new Promise<void>((resolve) => { arrive = resolve; });
  const gate = new Promise<void>((resolve) => { open = resolve; });
  const DB = new Proxy(d1.db, {
    get(target, key) {
      if (key !== 'batch') {
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      }
      return async (statements: D1PreparedStatement[]) => {
        arrive();
        await gate;
        return target.batch(statements);
      };
    },
  });
  return { env: { ...env, DB }, arrived, open };
}

const openInvites = async (docId: string) => (await d1.db.prepare(`SELECT email, role, invited_by AS inviter FROM invites
    WHERE target_id = ? AND accepted_at IS NULL AND revoked_at IS NULL ORDER BY rowid`).bind(docId).all()).results;

const sharing = (cookie: string, docId: string, email: string, role: string, over: typeof env) =>
  handleApi(new Request(`${BASE}/api/docs/${docId}/members`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: BASE, cookie },
    body: JSON.stringify({ email, role }),
  }), over);

describe('a share in flight across a revocation (A§8: the write that commits first wins)', { timeout: 30_000 }, () => {
  it('cannot raise another inviter’s invite once the note moved out of the sharer’s folder', async () => {
    const folderId = await insertFolder(d1.db, ada, ada.homeId);
    const docId = await titled(ada, 'Stalled raise', { folderId });
    const joe = await signedUpUser(env, 't28-joe-raise', 'Joe');
    await insertGrant(d1.db, { folderId }, joe, 'owner');
    const ghost = unknownEmail('stalled-raise');
    await share(ada, `/api/docs/${docId}`, ghost, 'viewer');

    // Joe's share at owner has passed its access check when Ada moves the note out of his folder.
    const gated = gatedBatch();
    const raising = sharing(joe.cookie, docId, ghost, 'owner', gated.env);
    await gated.arrived;
    expect((await call('PATCH', `/api/docs/${docId}`, ada.cookie, { folderId: ada.homeId })).status).toBe(200);
    gated.open();
    expect((await raising).status, 'Joe no longer manages the note').toBe(404);
    expect(await openInvites(docId), 'Ada’s invite keeps its role').toEqual([{ email: ghost, role: 'viewer', inviter: ada.id }]);
    const guest = await signedUpUser(env, 't28-gia', 'Gia', ghost);
    expect((await accept(guest.cookie, tokenOf(await inviteLink(ada, `/api/docs/${docId}`, ghost)))).status).toBe(200);
    expect(await roleOf(guest.cookie, docId), 'the link grants what Ada chose').toBe('viewer');
  });

  it('leaves no open invite after a trash lands mid-share and the note is restored', async () => {
    const docId = await titled(ada, 'Stalled trash');
    const ghost = unknownEmail('stalled-trash');
    const gated = gatedBatch();
    const pending = sharing(ada.cookie, docId, ghost, 'editor', gated.env);
    await gated.arrived;
    expect((await call('DELETE', `/api/docs/${docId}`, ada.cookie)).status, 'Ada sends the note to Trash').toBe(200);
    gated.open();
    expect((await pending).status, 'the share of a trashed note is refused').toBe(404);
    expect((await call('POST', `/api/docs/${docId}/restore`, ada.cookie)).status).toBe(200);
    expect(await openInvites(docId), 'no invite came back with the restore').toEqual([]);
    expect((await membersOf(ada, `/api/docs/${docId}`)).invites).toEqual([]);
  });
});

describe('the bell', { timeout: 30_000 }, () => {
  it('writes one notice when the same account redeems twice at once, in the same millisecond', async () => {
    const docId = await titled(ada, 'Twice at once');
    const path = `/api/docs/${docId}`;
    const ghost = unknownEmail('twice');
    await share(ada, path, ghost);
    const token = tokenOf(await inviteLink(ada, path, ghost));
    const rae = await signedUpUser(env, 't28-rae', 'Rae', ghost);
    // Both requests read the open invite before either batch runs, and both batches run in one millisecond.
    let arrived = 0;
    let release: () => void = () => undefined;
    const bothThere = new Promise<void>((resolve) => { release = resolve; });
    const DB = new Proxy(d1.db, {
      get(target, key) {
        if (key !== 'batch') {
          const value = Reflect.get(target, key, target);
          return typeof value === 'function' ? value.bind(target) : value;
        }
        return async (statements: D1PreparedStatement[]) => {
          arrived += 1;
          if (arrived === 2) release();
          await bothThere;
          return target.batch(statements);
        };
      },
    });
    const raced = { ...env, DB };
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    try {
      const answers = await Promise.all([0, 1].map(() => handleApi(new Request(`${BASE}/api/invites/${token}/accept`, {
        method: 'POST', headers: { origin: BASE, cookie: rae.cookie },
      }), raced)));
      expect(answers.map((a) => a.status), 'both lead Rae to the note').toEqual([200, 200]);
    } finally {
      clock.mockRestore();
    }
    expect(await roleOf(rae.cookie, docId)).toBe('editor');
    expect((await bell(ada)).filter((n) => n.target.id === docId), 'one notice').toHaveLength(1);
  });

  it('tells nobody about a share before its link is redeemed, then tells the inviter who accepted it', async () => {
    const dee = await signedUpUser(env, 't28-dee', 'Dee');
    const docId = await titled(ada, 'Roadmap');
    const path = `/api/docs/${docId}`;
    published.length = 0;
    await share(ada, path, dee.email);
    expect(await bell(dee), 'the address’s account hears nothing').toEqual([]);
    expect(published, 'and no tab is pushed').toEqual([]);
    expect((await bell(ada)).filter((n) => n.target.id === docId), 'nor the owner, yet').toEqual([]);

    expect((await accept(dee.cookie, tokenOf(await inviteLink(ada, path, dee.email)))).status).toBe(200);
    await expect.poll(() => published, { message: 'the inviter’s tabs are pushed' }).toContainEqual({ id: ada.id, event: { type: 'notifications' } });
    const [notice] = (await bell(ada)).filter((n) => n.target.id === docId);
    expect(notice).toMatchObject({ type: 'invite-accepted', read: false, by: 'Dee', target: { type: 'doc', id: docId, title: 'Roadmap', kind: 'doc' } });
  });

  it('marks notices read for their owner only, and reading redeems nothing', async () => {
    const fay = await signedUpUser(env, 't28-fay', 'Fay');
    const docId = await titled(ada, 'Read me');
    const path = `/api/docs/${docId}`;
    await share(ada, path, fay.email);
    await share(ada, path, unknownEmail('read'), 'viewer');
    expect((await accept(fay.cookie, tokenOf(await inviteLink(ada, path, fay.email)))).status).toBe(200);
    const [notice] = (await bell(ada)).filter((n) => n.target.id === docId);
    expect((await call('POST', '/api/notifications/read', fay.cookie, { ids: [notice.id] })).status).toBe(200);
    expect((await bell(ada)).find((n) => n.id === notice.id)?.read, 'someone else cannot mark it').toBe(false);
    published.length = 0;
    expect((await call('POST', '/api/notifications/read', ada.cookie, { ids: [notice.id] })).status).toBe(200);
    expect((await bell(ada)).find((n) => n.id === notice.id)?.read).toBe(true);
    await expect.poll(() => published, { message: 'her other tabs hear it' }).toContainEqual({ id: ada.id, event: { type: 'notifications' } });
    expect((await membersOf(ada, path)).invites, 'the other invite is still pending').toHaveLength(1);

    expect((await call('GET', '/api/notifications', null)).status).toBe(401);
    expect((await call('POST', '/api/notifications/read', ada.cookie, { ids: 'all' })).status).toBe(400);
  });

  it('omits a notice once its reader can no longer open the item, title and all, and shows it again when they can', async () => {
    const joe = await signedUpUser(env, 't28-joe2', 'Joe');
    const eve = await signedUpUser(env, 't28-eve', 'Eve');
    const folderId = await insertFolder(d1.db, ada, ada.homeId);
    const docId = await titled(ada, 'Revocable', { folderId });
    await d1.db.prepare("INSERT INTO folder_members (folder_id, principal_id, principal_type, role, added_by, created_at) VALUES (?, ?, 'user', 'owner', ?, 1)")
      .bind(folderId, joe.id, ada.id).run();
    // Joe, a co-owner by the folder, invites Eve; she accepts, and Joe hears it.
    await share(joe, `/api/docs/${docId}`, eve.email);
    expect((await accept(eve.cookie, tokenOf(await inviteLink(joe, `/api/docs/${docId}`, eve.email)))).status).toBe(200);
    expect((await bell(joe)).map((n) => n.target.title)).toEqual(['Revocable']);

    await d1.db.prepare('DELETE FROM folder_members WHERE folder_id = ? AND principal_id = ?').bind(folderId, joe.id).run();
    const text = await (await call('GET', '/api/notifications', joe.cookie)).text();
    expect(JSON.parse(text)).toEqual({ notifications: [] });
    expect(text, 'not even the title leaks').not.toContain('Revocable');
    await d1.db.prepare("INSERT INTO folder_members (folder_id, principal_id, principal_type, role, added_by, created_at) VALUES (?, ?, 'user', 'owner', ?, 1)")
      .bind(folderId, joe.id, ada.id).run();
    await d1.db.prepare('UPDATE docs SET deleted_at = ? WHERE id = ?').bind(Date.now(), docId).run();
    expect(await bell(joe), 'nor a trashed one').toEqual([]);
    await d1.db.prepare('UPDATE docs SET deleted_at = NULL WHERE id = ?').bind(docId).run();
    expect((await bell(joe)).map((n) => n.target.title)).toEqual(['Revocable']);
  });
});
