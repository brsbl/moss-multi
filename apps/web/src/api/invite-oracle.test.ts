// T2.8's ruling (A§6, A§8): whether an email has an account is never observable to anyone but that account's holder.
// An invite binds to its email and a random token, never to an account, until the invitee redeems it signed in with
// that email. This file runs every flow an owner (or the owner's second account) can see twice, for an email with an
// account and for one without, and asserts byte-identical answers and member lists, and that a share never uses the
// email to look anything up but the invite. It carries the regression for each oracle the T2.8 checkers found.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migratedD1, type TestD1 } from '../test/d1.ts';
import { inviteToken } from '../test/invites.ts';
import { BASE, insertDoc, insertFolder, insertGrant, SECRET, signedUpUser, type AuthTestEnv, type TestUser } from '../test/principals.ts';
import { handleApi } from './router.ts';

const DocDO = {
  idFromName: (name: string) => ({ name, toString: () => name }),
  get: () => ({ setName: async () => undefined, create: async () => undefined }),
};

let d1: TestD1;
let env: AuthTestEnv & Parameters<typeof handleApi>[1];
let ada: TestUser;
let alt: TestUser;

beforeAll(async () => {
  d1 = await migratedD1();
  // No PrincipalDO: the push to an invitee's tabs is off the response path and out of scope here.
  env = { DB: d1.db, BETTER_AUTH_SECRET: SECRET, BETTER_AUTH_URL: BASE, DocDO: DocDO as never, PrincipalDO: undefined as never };
  ada = await signedUpUser(env, 't28o-ada', 'Ada');
  // Ada's second account, which she uses to probe her own invites.
  alt = await signedUpUser(env, 't28o-alt', 'Alt');
}, 60_000);
afterAll(() => d1?.dispose());

const call = (method: string, path: string, cookie: string | null, body?: unknown, over = env) =>
  handleApi(new Request(`${BASE}${path}`, {
    method,
    headers: { 'content-type': 'application/json', origin: BASE, ...(cookie ? { cookie } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), over);

const unknownEmail = (label: string) => `mm-t28o-${label}-${crypto.randomUUID().slice(0, 8)}@example.invalid`;

/** One side of the comparison: an email (with or without an account) and the ids its responses may name. */
interface World {
  email: string;
  folderId: string;
  docId: string;
}

/** A response as the caller can tell it apart: status, varying headers and body, with this world's own names masked. */
async function seen(world: World, response: Response): Promise<string> {
  const body = (await response.text())
    .replaceAll(world.email, '<email>')
    .replaceAll(world.docId, '<doc>')
    .replaceAll(world.folderId, '<folder>')
    .replace(/[0-9a-f]{48}/g, '<token>');
  return JSON.stringify({ status: response.status, type: response.headers.get('content-type'), cache: response.headers.get('cache-control'), body });
}

async function world(email: string): Promise<World> {
  const folderId = await insertFolder(d1.db, ada, ada.homeId);
  return { email, folderId, docId: await insertDoc(d1.db, ada, { folderId }) };
}

/** Runs `step` in both worlds and asserts the two are indistinguishable. */
async function alike(known: World, unknown: World, label: string, step: (w: World) => Promise<Response>): Promise<void> {
  const a = await seen(known, await step(known));
  const b = await seen(unknown, await step(unknown));
  expect(b, label).toBe(a);
}

const members = (w: World, cookie = ada.cookie) => call('GET', `/api/docs/${w.docId}/members`, cookie);
const links = (w: World, cookie = ada.cookie) => call('GET', `/api/docs/${w.docId}/invites`, cookie);
const share = (w: World, role: string, cookie = ada.cookie) => call('POST', `/api/docs/${w.docId}/members`, cookie, { email: w.email, role });
const follow = (token: string, cookie: string) => call('POST', `/api/invites/${token}/accept`, cookie);

describe('every owner-visible flow answers alike for an email with an account and one without', { timeout: 60_000 }, () => {
  it('first share, repeat, raise, lowering, the member list, the invite links and the owner’s own click', async () => {
    const kim = await signedUpUser(env, 't28o-kim', 'Kim');
    const known = await world(kim.email);
    const unknown = await world(unknownEmail('flows'));
    for (const role of ['commenter', 'commenter', 'editor', 'viewer']) {
      await alike(known, unknown, `share at ${role}`, (w) => share(w, role));
      await alike(known, unknown, `members after ${role}`, (w) => members(w));
      await alike(known, unknown, `invite links after ${role}`, (w) => links(w));
    }
    for (const w of [known, unknown]) {
      const listed = (await (await members(w)).json()) as { members: { name: string }[]; invites: { email: string; role: string }[] };
      expect(listed.members.map((m) => m.name), 'nobody is named before redeeming').toEqual(['Ada']);
      expect(listed.invites).toEqual([{ email: w.email, role: 'editor' }]);
    }
    await alike(known, unknown, 'the owner follows her own link', async (w) => follow(await inviteToken(env, ada, `/api/docs/${w.docId}`, w.email), ada.cookie));
    await alike(known, unknown, 'members after the owner’s click', (w) => members(w));
    expect(await (await call('GET', `/api/docs/${known.docId}`, kim.cookie)).text(), 'the account holder has no access until redeeming')
      .toBe(await (await call('GET', `/api/docs/${crypto.randomUUID()}`, kim.cookie)).text());
  });

  it("refuses the owner's second account alike, and the member list stays identical, however it follows the link (check #1 P1)", async () => {
    const lia = await signedUpUser(env, 't28o-lia', 'Lia');
    const known = await world(lia.email);
    const unknown = await world(unknownEmail('second'));
    await alike(known, unknown, 'share', (w) => share(w, 'editor'));
    const tokens = new Map<World, string>();
    for (const w of [known, unknown]) tokens.set(w, await inviteToken(env, ada, `/api/docs/${w.docId}`, w.email));
    await alike(known, unknown, 'the second account follows the link', (w) => follow(tokens.get(w)!, alt.cookie));
    await alike(known, unknown, 'and again', (w) => follow(tokens.get(w)!, alt.cookie));
    await alike(known, unknown, 'members after', (w) => members(w));
    await alike(known, unknown, 'invite links after', (w) => links(w));
    await alike(known, unknown, 'the second account still has no access', (w) => call('GET', `/api/docs/${w.docId}`, alt.cookie));
    // A forged token answers as both.
    expect(await seen(known, await follow('f'.repeat(48), alt.cookie))).toBe(await seen(known, await follow(tokens.get(known)!, alt.cookie)));
  });

  it('kills an invite whose inviter lost manage, alike, and a re-share at any role replaces it with a fresh link (check #1 P1, #2 P2, #3 P1)', async () => {
    for (const reshare of ['commenter', 'editor', 'owner']) {
      const joe = await signedUpUser(env, `t28o-joe-${reshare}`, 'Joe');
      const mia = await signedUpUser(env, `t28o-mia-${reshare}`, 'Mia');
      const known = await world(mia.email);
      const unknown = await world(unknownEmail(`stale-${reshare}`));
      for (const w of [known, unknown]) await insertGrant(d1.db, { folderId: w.folderId }, joe, 'owner');
      // Joe, a co-owner by the folder, invites at editor; Ada then moves the note out of his folder.
      await alike(known, unknown, 'Joe shares', (w) => share(w, 'editor', joe.cookie));
      const dead = new Map<World, string>();
      for (const w of [known, unknown]) {
        dead.set(w, await inviteToken(env, joe, `/api/docs/${w.docId}`, w.email));
        await d1.db.prepare('UPDATE docs SET folder_id = ? WHERE id = ?').bind(ada.homeId, w.docId).run();
      }
      await alike(known, unknown, 'the dead invite is no longer listed', (w) => members(w));
      await alike(known, unknown, `Ada re-shares at ${reshare}`, (w) => share(w, reshare));
      await alike(known, unknown, `members after the re-share at ${reshare}`, (w) => members(w));
      await alike(known, unknown, `invite links after the re-share at ${reshare}`, (w) => links(w));
      for (const w of [known, unknown]) {
        expect(await inviteToken(env, ada, `/api/docs/${w.docId}`, w.email), 'a fresh link').not.toBe(dead.get(w));
      }
      await alike(known, unknown, 'the second account follows the dead link', (w) => follow(dead.get(w)!, alt.cookie));
      // The account holder can never redeem the dead link; the fresh one admits them at the role Ada chose.
      expect((await follow(dead.get(known)!, mia.cookie)).status).toBe(404);
      expect((await follow(await inviteToken(env, ada, `/api/docs/${known.docId}`, mia.email), mia.cookie)).status).toBe(200);
      const role = ((await (await call('GET', `/api/docs/${known.docId}`, mia.cookie)).json()) as { role: string }).role;
      expect(role, 'no grant from the dead invite survives').toBe(reshare);
    }
  });

  it('kills an invite when its item goes to Trash, alike', async () => {
    const ned = await signedUpUser(env, 't28o-ned', 'Ned');
    const known = await world(ned.email);
    const unknown = await world(unknownEmail('trash'));
    await alike(known, unknown, 'share', (w) => share(w, 'editor'));
    const tokens = new Map<World, string>();
    for (const w of [known, unknown]) {
      tokens.set(w, await inviteToken(env, ada, `/api/docs/${w.docId}`, w.email));
      await d1.db.prepare('UPDATE docs SET deleted_at = ? WHERE id = ?').bind(Date.now(), w.docId).run();
    }
    await alike(known, unknown, 'the second account follows the trashed item’s link', (w) => follow(tokens.get(w)!, alt.cookie));
    await alike(known, unknown, 'a share of the trashed item', (w) => share(w, 'editor'));
    expect((await follow(tokens.get(known)!, ned.cookie)).status, 'not even its own email redeems it').toBe(404);
    expect(await seen(known, await follow(tokens.get(known)!, ned.cookie))).toBe(await seen(known, await follow(tokens.get(known)!, alt.cookie)));
  });

  it('answers the rate limit alike', async () => {
    const busy = await signedUpUser(env, 't28o-busy', 'Busy');
    const kay = await signedUpUser(env, 't28o-kay', 'Kay');
    const docId = await insertDoc(d1.db, busy);
    for (let i = 0; i < 20; i += 1) {
      expect((await call('POST', `/api/docs/${docId}/members`, busy.cookie, { email: unknownEmail(`fill${i}`), role: 'viewer' })).status).toBe(201);
    }
    const masked = async (email: string) => (await seen({ email, docId, folderId: '-' }, await call('POST', `/api/docs/${docId}/members`, busy.cookie, { email, role: 'viewer' })));
    expect(await masked(unknownEmail('over'))).toBe(await masked(kay.email));
  }, 30_000);
});

/** Each D1 statement a request prepares, with the values bound to it. */
function recording(db: D1Database, log: { query: string; values: unknown[] }[]): D1Database {
  const wrap = (query: string, statement: D1PreparedStatement): D1PreparedStatement => new Proxy(statement, {
    get(target, key) {
      if (key === 'bind') {
        return (...values: unknown[]) => {
          log.push({ query, values });
          return target.bind(...values);
        };
      }
      const value = Reflect.get(target, key) as unknown;
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
  return {
    prepare: (query: string) => wrap(query.replace(/\s+/g, ' ').trim(), db.prepare(query)),
    batch: (statements: D1PreparedStatement[]) => db.batch(statements),
    exec: (query: string) => db.exec(query),
    dump: () => db.dump(),
    withSession: (constraint?: string) => db.withSession(constraint as never),
  } as unknown as D1Database;
}

describe('a share looks up no account by the email', { timeout: 60_000 }, () => {
  it('binds the shared email into no statement on an account table, at every step of a share', async () => {
    const ola = await signedUpUser(env, 't28o-ola', 'Ola');
    const known = await world(ola.email);
    const unknown = await world(unknownEmail('trace'));
    for (const role of ['commenter', 'commenter', 'editor', 'viewer']) {
      const traces: string[][] = [];
      for (const w of [known, unknown]) {
        const log: { query: string; values: unknown[] }[] = [];
        await call('POST', `/api/docs/${w.docId}/members`, ada.cookie, { email: w.email, role }, { ...env, DB: recording(d1.db, log) });
        const touching = log.filter((entry) => entry.values.some((value) => typeof value === 'string' && value.toLowerCase() === w.email));
        // Never against an account table: no user, account or session row is read or written by the email.
        for (const entry of touching) expect(entry.query, `${role}: the email reaches no account table`).not.toMatch(/\b(user|account|session)\b/i);
        expect(touching.length, `${role}: the email is used`).toBeGreaterThan(0);
        traces.push(log.map((entry) => entry.query));
      }
      expect(traces[1], `${role}: the statements an unknown email runs`).toEqual(traces[0]);
    }
  });
});
