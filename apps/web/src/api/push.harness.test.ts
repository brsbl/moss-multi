// POST /api/docs/:id/push (T7.2; A§17) over the real DocDO and PrincipalDO in the Node harness, real D1 and the REST
// routes: the base cache and its `base-missing` resend, the degenerate guard and --force, the size cap on the merged
// result, the 60-per-minute push limit charged to the acting user (an agent counts against its owner, and nobody else
// can fill that bucket), the role floor, and the actor re-validated inside the serialized write.
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { liveCredentials } from '../../../../packages/sync/src/access-epoch.ts';
import { DocDO } from '../../../../packages/sync/src/doc-do.ts';
import { PrincipalDO } from '../../../../packages/sync/src/principal-do.ts';
import { Backing, openDoc } from '../../../../packages/sync/test/harness/do-harness.ts';
import { FakeState } from '../../../../packages/sync/test/harness/workerd.ts';
import { MARKDOWN_CAP_BYTES, PUSH_RATE } from '@moss-multi/protocol/limits';
import { migratedD1, type TestD1 } from '../test/d1.ts';
import { BASE, insertAgent, insertDoc, insertGrant, SECRET, signedUpUser, type TestUser } from '../test/principals.ts';
import { docAccessCheck } from '../worker/doc-access.ts';
import { handleApi } from './router.ts';

let d1: TestD1;

class PushDocDO extends DocDO {
  static override projectionTarget = () => null;
  static override registry = () => null;
  static override liveness = () => async (docId: string) => {
    const row = await d1.db.prepare('SELECT deleted_at FROM docs WHERE id = ?').bind(docId).first<{ deleted_at: number | null }>();
    return !row || row.deleted_at !== null;
  };
  static override access = () => docAccessCheck({ DB: d1.db });
}

/** A doc whose state cap is small, so a merged result past it is cheap to build. */
class SmallDocDO extends PushDocDO {
  static override limits = { ...DocDO.limits, stateCapBytes: 64 * 1024 };
}

class PushPrincipalDO extends PrincipalDO {
  static override credentials = () => (sessions: string[], agents: string[]) => liveCredentials(d1.db, sessions, agents);
  static override rechecker = () => async () => undefined;
}

function namespace<T extends object>(make: (name: string) => T) {
  const made = new Map<string, T>();
  const get = (name: string) => {
    let instance = made.get(name);
    if (!instance) made.set(name, (instance = make(name)));
    return instance;
  };
  return { get, idFromName: (name: string) => ({ name, toString: () => name }) };
}

const small = new Set<string>();
const docs = namespace((name) => openDoc(new Backing(name), (small.has(name) ? SmallDocDO : PushDocDO) as never));
const docNs = { idFromName: docs.idFromName, get: (id: { name: string }) => docs.get(id.name).dobj };

/** While set, runs once after the Worker took a push token, before the DocDO RPC. */
let paused: (() => Promise<unknown>) | null = null;
/** Every push token taken, by the bucket it was charged to. */
const charged: string[] = [];

const principals = namespace((name) => new PushPrincipalDO(new FakeState(new Backing(name)) as never, {} as never));
const principalNs = {
  idFromName: principals.idFromName,
  get: (id: { name: string }) => new Proxy(principals.get(id.name), {
    get(target, prop) {
      if (prop === 'takePushToken') {
        return async () => {
          charged.push(id.name);
          const ok = await target.takePushToken();
          const hook = paused;
          paused = null;
          if (hook) await hook();
          return ok;
        };
      }
      const value = Reflect.get(target, prop, target) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }),
};

let env: Parameters<typeof handleApi>[1] & { BETTER_AUTH_SECRET: string; BETTER_AUTH_URL: string };

beforeAll(async () => {
  d1 = await migratedD1();
  env = { DB: d1.db, BETTER_AUTH_SECRET: SECRET, BETTER_AUTH_URL: BASE, DocDO: docNs as never, PrincipalDO: principalNs as never };
}, 60_000);
afterAll(() => d1?.dispose());
beforeEach(() => {
  paused = null;
  charged.length = 0;
});

type Creds = Record<string, string>;
const cookieOf = (user: TestUser): Creds => ({ cookie: user.cookie });
const bearer = (token: string): Creds => ({ authorization: `Bearer ${token}` });
const sha = (text: string) => createHash('sha256').update(text).digest('hex');

function call(method: string, path: string, creds: Creds, body?: unknown): Promise<Response> {
  return handleApi(new Request(`${BASE}${path}`, {
    method,
    headers: { 'content-type': 'application/json', origin: BASE, ...creds },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), env);
}

async function content(docId: string, creds: Creds): Promise<string> {
  const response = await call('GET', `/api/docs/${docId}/content`, creds);
  expect(response.status).toBe(200);
  return response.text();
}

interface Pushed { status: number; body: Record<string, unknown>; retryAfter: string | null }

async function push(docId: string, creds: Creds, request: Record<string, unknown>): Promise<Pushed> {
  const response = await call('POST', `/api/docs/${docId}/push`, creds, request);
  return { status: response.status, body: (await response.json()) as Record<string, unknown>, retryAfter: response.headers.get('retry-after') };
}

async function seeded(owner: TestUser, markdown: string, options: { small?: boolean } = {}): Promise<string> {
  const docId = await insertDoc(d1.db, owner);
  if (options.small) small.add(docId);
  await docs.get(docId).dobj.create({ folderId: owner.homeId, ownerId: owner.id, markdown });
  return docId;
}

const BODY = ['Alpha one stays.', 'Bravo two stays.', 'Charlie three changes.', 'Delta four stays.', 'Echo five stays.'].join('\n\n');

describe('POST /api/docs/:id/push @p:agt-1 @p:tech-5 @p:tech-7', () => {
  it('merges against the base a pull served; a base it never served is asked for, checked against its hash, then used', async () => {
    const ada = await signedUpUser(env, 'push-ada', 'Ada');
    const docId = await seeded(ada, BODY);
    const base = await content(docId, cookieOf(ada));
    const next = base.replace('Charlie three changes.', 'Charlie three has changed.');
    const landed = await push(docId, cookieOf(ada), { newText: next, baseHash: sha(base) });
    expect(landed.status, 'the pulled export is a cached base').toBe(200);
    expect(landed.body).toMatchObject({ ok: true, mode: 'edit', failedHunks: [] });
    expect(landed.body.applied).toBeGreaterThan(0);
    const after = await content(docId, cookieOf(ada));
    expect(after).toBe(next);

    // A file kept from elsewhere: its base was never served here.
    const elsewhere = `${BODY}\n\nA paragraph this doc never had.`;
    const edited = elsewhere.replace('Echo five stays.', 'Echo five was pushed.');
    const missing = await push(docId, cookieOf(ada), { newText: edited, baseHash: sha(elsewhere) });
    expect(missing.status).toBe(409);
    expect(missing.body).toEqual({ ok: false, reason: 'base-missing' });
    expect(await content(docId, cookieOf(ada)), 'nothing landed').toBe(after);
    const forged = await push(docId, cookieOf(ada), { newText: edited, baseHash: sha(elsewhere), baseText: `${elsewhere} (not the base)` });
    expect(forged.status, 'a base text that does not hash to baseHash is not trusted').toBe(400);
    const refused = await push(docId, cookieOf(ada), { newText: 'x', baseHash: sha(elsewhere), baseText: elsewhere });
    expect(refused.body).toMatchObject({ ok: false, reason: 'degenerate' });
    const uncached = await push(docId, cookieOf(ada), { newText: edited, baseHash: sha(elsewhere) });
    expect(uncached.body, 'a refused push caches no base').toEqual({ ok: false, reason: 'base-missing' });
    const resent = await push(docId, cookieOf(ada), { newText: edited, baseHash: sha(elsewhere), baseText: elsewhere });
    expect(resent.status).toBe(200);
    const merged = await content(docId, cookieOf(ada));
    expect(merged).toContain('Charlie three has changed.');
    expect(merged).toContain('Echo five was pushed.');
  });

  it('refuses a push deleting most of the doc unless forced, and lands CRLF as LF', async () => {
    const ada = await signedUpUser(env, 'push-ada', 'Ada');
    const docId = await seeded(ada, BODY);
    const base = await content(docId, cookieOf(ada));
    const refused = await push(docId, cookieOf(ada), { newText: 'Alpha one stays.', baseHash: sha(base), baseText: base });
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ ok: false, reason: 'degenerate' });
    expect(refused.body.deletedRatio).toBeGreaterThan(0.6);
    expect(await content(docId, cookieOf(ada))).toBe(base);
    const emptied = await push(docId, cookieOf(ada), { newText: '', baseHash: sha(base), baseText: base });
    expect(emptied.body).toMatchObject({ ok: false, reason: 'degenerate' });

    const forced = await push(docId, cookieOf(ada), { newText: 'Alpha one stays.\r\n\r\nNew tail.', baseHash: sha(base), baseText: base, force: true });
    expect(forced.status).toBe(200);
    expect(await content(docId, cookieOf(ada))).toBe('Alpha one stays.\n\nNew tail.');
  });

  it('refuses with 409 push-unverified, naming the block, a push that would change words it did not edit', async () => {
    const ada = await signedUpUser(env, 'push-ada', 'Ada');
    const docId = await seeded(ada, 'Lead paragraph.\n\nWord&#160;gap here and more.\n\nTail paragraph.');
    const base = await content(docId, cookieOf(ada));
    const refused = await push(docId, cookieOf(ada), { newText: base.replace('and more', 'and more still'), baseHash: sha(base) });
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ ok: false, reason: 'push-unverified' });
    expect(String(refused.body.message)).toMatch(/block 2/);
    expect(await content(docId, cookieOf(ada)), 'nothing landed').toBe(base);
    const beside = await push(docId, cookieOf(ada), { newText: base.replace('Tail paragraph.', 'Tail paragraph, pushed.'), baseHash: sha(base) });
    expect(beside.status, 'an edit beside that paragraph lands').toBe(200);
    expect(await content(docId, cookieOf(ada))).toBe(base.replace('Tail paragraph.', 'Tail paragraph, pushed.'));
  });

  it('refuses a file past 2 MB and a merged result past the state cap with 413, leaving the doc as it was', async () => {
    const ada = await signedUpUser(env, 'push-ada', 'Ada');
    const docId = await seeded(ada, BODY, { small: true });
    const base = await content(docId, cookieOf(ada));
    const huge = await push(docId, cookieOf(ada), { newText: `${base}\n\n${'x'.repeat(MARKDOWN_CAP_BYTES)}`, baseHash: sha(base), baseText: base });
    expect(huge.status).toBe(413);
    expect(huge.body).toMatchObject({ ok: false, reason: 'too-large' });
    const paragraphs = Array.from({ length: 400 }, (_, i) => `Paragraph ${i} grows the doc past its small cap.`).join('\n\n');
    const capped = await push(docId, cookieOf(ada), { newText: `${base}\n\n${paragraphs}`, baseHash: sha(base), baseText: base });
    expect(capped.status).toBe(413);
    expect(capped.body).toMatchObject({ ok: false, reason: 'too-large' });
    expect(await content(docId, cookieOf(ada))).toBe(base);
  });

  it('charges 60 pushes a minute to the acting user: her agent spends her bucket, and another person\'s pushes do not', async () => {
    const ada = await signedUpUser(env, 'push-ada', 'Ada');
    const eve = await signedUpUser(env, 'push-eve', 'Eve');
    const docId = await seeded(ada, BODY);
    await insertGrant(d1.db, { docId }, eve, 'editor');
    const agent = await insertAgent(d1.db, ada);
    const base = await content(docId, cookieOf(ada));
    const request = { newText: base, baseHash: sha(base), baseText: base };
    for (let i = 0; i < PUSH_RATE.max; i += 1) {
      const creds = i % 2 === 0 ? cookieOf(ada) : bearer(agent.key);
      const pushed = await push(docId, creds, request);
      expect(pushed.status, `push ${i + 1}`).toBe(200);
    }
    expect(new Set(charged), 'every push was charged to Ada, the agent\'s too').toEqual(new Set([ada.id]));
    const over = await push(docId, bearer(agent.key), request);
    expect(over.status).toBe(429);
    expect(over.body).toMatchObject({ ok: false, reason: 'rate-limited' });
    expect(Number(over.retryAfter)).toBeGreaterThan(0);
    expect((await push(docId, cookieOf(ada), request)).status, 'Ada herself is limited too').toBe(429);
    expect((await push(docId, cookieOf(eve), request)).status, 'Eve has her own bucket').toBe(200);
  });

  it('refuses a viewer with 403 and a stranger with the same 404 as a missing doc', async () => {
    const ada = await signedUpUser(env, 'push-ada', 'Ada');
    const cara = await signedUpUser(env, 'push-cara', 'Cara');
    const sam = await signedUpUser(env, 'push-sam', 'Sam');
    const docId = await seeded(ada, BODY);
    await insertGrant(d1.db, { docId }, cara, 'viewer');
    const base = await content(docId, cookieOf(ada));
    const request = { newText: `${base}\n\nMore.`, baseHash: sha(base), baseText: base };
    const viewer = await push(docId, cookieOf(cara), request);
    expect(viewer.status).toBe(403);
    expect(viewer.body).toMatchObject({ ok: false, reason: 'forbidden' });
    const stranger = await call('POST', `/api/docs/${docId}/push`, cookieOf(sam), request);
    const missing = await call('POST', `/api/docs/${crypto.randomUUID()}/push`, cookieOf(sam), request);
    expect(stranger.status).toBe(404);
    expect(await stranger.text()).toBe(await missing.text());
    expect(await content(docId, cookieOf(ada))).toBe(base);
  });

  it('re-validates the actor inside the write: a key revoked after admission lands nothing', async () => {
    const ada = await signedUpUser(env, 'push-ada', 'Ada');
    const docId = await seeded(ada, BODY);
    const agent = await insertAgent(d1.db, ada);
    const base = await content(docId, cookieOf(ada));
    paused = () => d1.db.prepare('UPDATE agents SET revoked_at = ? WHERE id = ?').bind(Date.now(), agent.id).run();
    const pushed = await push(docId, bearer(agent.key), { newText: `${base}\n\nFrom a revoked key.`, baseHash: sha(base), baseText: base });
    expect(paused, 'the revocation committed mid-request').toBeNull();
    expect([401, 403, 404]).toContain(pushed.status);
    expect(await content(docId, cookieOf(ada))).toBe(base);
  });
});
