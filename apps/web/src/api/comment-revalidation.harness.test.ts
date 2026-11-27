// A comment write re-authorizes its actor in the DocDO's serialized write (T4.S1; A§8 pull validation, T2.5). Over the
// real DocDO and PrincipalDO in the Node harness, real D1 and the REST routes: each comment request is paused after the
// Worker admitted it, a change that removes the actor's right to comment commits, and then the request goes on. With
// or without a socket of the actor's on the doc, the write is refused and the comment records stay byte-identical; a
// commenter who keeps access still writes.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { liveCredentials } from '../../../../packages/sync/src/access-epoch.ts';
import { DocDO } from '../../../../packages/sync/src/doc-do.ts';
import { PrincipalDO } from '../../../../packages/sync/src/principal-do.ts';
import { Backing, connect, openDoc, start, type TestClient } from '../../../../packages/sync/test/harness/do-harness.ts';
import { FakeState } from '../../../../packages/sync/test/harness/workerd.ts';
import { handleAuthRoute } from '../auth/route.ts';
import { migratedD1, type TestD1 } from '../test/d1.ts';
import { BASE, insertAgent, insertDoc, insertGrant, insertLink, SECRET, signedUpUser, type TestUser } from '../test/principals.ts';
import { authenticateParty } from '../worker/party.ts';
import { docAccessCheck } from '../worker/doc-access.ts';
import { handleApi } from './router.ts';

let d1: TestD1;

/** The real DocDO with the Worker's access check, reading D1 for liveness; no projections or sign-out registry. */
class CommentDocDO extends DocDO {
  static override projectionTarget = () => null;
  static override registry = () => null;
  static override liveness = () => async (docId: string) => {
    const row = await d1.db.prepare('SELECT deleted_at FROM docs WHERE id = ?').bind(docId).first<{ deleted_at: number | null }>();
    return !row || row.deleted_at !== null;
  };
  static override access = () => docAccessCheck({ DB: d1.db });
}

/** The real PrincipalDO; its kicks are dropped, so only the DocDO's own check can refuse. */
class CommentPrincipalDO extends PrincipalDO {
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

const docs = namespace((name) => openDoc(new Backing(name), CommentDocDO as never));
const docNs = {
  idFromName: docs.idFromName,
  get: (id: { name: string }) => new Proxy(docs.get(id.name).dobj, {
    get(target, prop) {
      // Every kick is dropped: the write itself must catch the change.
      if (prop === 'recheck') return async () => ({ closed: 0 });
      const value = Reflect.get(target, prop, target) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }),
};

/** While set, runs once after the Worker admitted a comment request and took its rate token, before the DocDO RPC. */
let paused: (() => Promise<unknown>) | null = null;

const principals = namespace((name) => new CommentPrincipalDO(new FakeState(new Backing(name)) as never, {} as never));
const principalNs = {
  idFromName: principals.idFromName,
  get: (id: { name: string }) => new Proxy(principals.get(id.name), {
    get(target, prop) {
      if (prop === 'endSession') return async () => undefined;
      if (prop === 'takeCommentToken') {
        return async () => {
          const ok = await target.takeCommentToken();
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
let ips = 0;

beforeAll(async () => {
  d1 = await migratedD1();
  env = { DB: d1.db, BETTER_AUTH_SECRET: SECRET, BETTER_AUTH_URL: BASE, DocDO: docNs as never, PrincipalDO: principalNs as never };
}, 60_000);
afterAll(() => d1?.dispose());
beforeEach(() => {
  paused = null;
});

/** How a principal presents itself: a cookie or a bearer, and a share token when a link is what lets it in. */
interface Creds {
  headers: Record<string, string>;
  share?: string;
}

const userCreds = (cookie: string): Creds => ({ headers: { cookie } });

function call(method: string, path: string, creds: Creds, body?: unknown): Promise<Response> {
  const url = new URL(`${BASE}${path}`);
  if (creds.share) url.searchParams.set('share', creds.share);
  return handleApi(new Request(url, {
    method,
    headers: { 'content-type': 'application/json', origin: BASE, ...creds.headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), env);
}

async function signIn(user: TestUser): Promise<string> {
  ips += 1;
  const response = await handleAuthRoute(new Request(`${BASE}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: BASE, 'cf-connecting-ip': `203.0.113.${ips % 250}` },
    body: JSON.stringify({ email: user.email, password: 'correct horse battery' }),
  }), env);
  if (response.status !== 200) throw new Error(`sign-in ${response.status}`);
  return response.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
}

/** The Worker's admission, then the actor's socket at the DocDO, validated and synced. */
async function join(docId: string, creds: Creds): Promise<TestClient> {
  const verdict = await authenticateParty(new Request(`${BASE}/parties/doc-d-o/${docId}${creds.share ? `?share=${creds.share}` : ''}`, {
    headers: { upgrade: 'websocket', origin: BASE, ...creds.headers },
  }), docId, env);
  if (!verdict.ok) throw new Error(`admission refused ${verdict.code}`);
  const client = await connect(await start(docs.get(docId)), { headers: verdict.headers });
  if (client.closed) throw new Error(`socket refused ${client.closed.code}`);
  await client.hello();
  return client;
}

/** The doc's comment records, exactly. */
const records = (docId: string) => JSON.stringify(docs.get(docId).dobj.document.getMap('comments').toJSON());

/** One comment write by the actor, on a doc where it authored root `r` and the owner replied `p`. */
type Op = { name: string; run: (docId: string, creds: Creds) => Promise<Response> };
const OPS: Op[] = [
  { name: 'create a thread', run: (docId, creds) => call('POST', `/api/docs/${docId}/comments`, creds, { id: 'n1', text: 'new', anchor: { quote: 'lazy dog' } }) },
  { name: 'reply', run: (docId, creds) => call('POST', `/api/docs/${docId}/comments`, creds, { id: 'n2', text: 'reply', parentId: 'r' }) },
  { name: 'resolve', run: (docId, creds) => call('POST', `/api/docs/${docId}/comments/r/resolve`, creds, { resolved: true }) },
  { name: 'edit', run: (docId, creds) => call('PATCH', `/api/docs/${docId}/comments/r`, creds, { text: 'edited' }) },
  { name: 'delete a comment', run: (docId, creds) => call('DELETE', `/api/docs/${docId}/comments/r`, creds) },
  { name: 'delete the thread, others’ replies included', run: (docId, creds) => call('DELETE', `/api/docs/${docId}/comments/r?scope=thread`, creds) },
  { name: 'react', run: (docId, creds) => call('POST', `/api/docs/${docId}/comments/p/reactions`, creds, { emoji: '👍', on: true }) },
];

/** A doc with text, root `r` by the actor and reply `p` by the owner, both written through REST. */
async function seeded(owner: TestUser, setup: (docId: string) => Promise<Creds>): Promise<{ docId: string; creds: Creds }> {
  const docId = await insertDoc(d1.db, owner);
  await docs.get(docId).dobj.create({ folderId: owner.homeId, ownerId: owner.id, markdown: 'The quick brown fox jumps over the lazy dog' });
  const creds = await setup(docId);
  const root = await call('POST', `/api/docs/${docId}/comments`, creds, { id: 'r', text: 'mine', anchor: { quote: 'brown fox' } });
  expect(root.status, 'the actor comments while it may').toBe(201);
  const reply = await call('POST', `/api/docs/${docId}/comments`, userCreds(owner.cookie), { id: 'p', text: 'owner’s reply', parentId: 'r' });
  expect(reply.status).toBe(201);
  return { docId, creds };
}

/** A change that removes the actor's right to comment: how the actor is let in, and what commits mid-request. */
interface Change {
  name: string;
  setup: (ctx: { owner: TestUser; actor: TestUser; docId: string }) => Promise<{ creds: Creds; revoke: () => Promise<unknown> }>;
}

const CHANGES: Change[] = [
  {
    name: 'a grant removal',
    setup: async ({ owner, actor, docId }) => {
      await insertGrant(d1.db, { docId }, actor, 'commenter');
      return { creds: userCreds(actor.cookie), revoke: () => call('DELETE', `/api/docs/${docId}/members`, userCreds(owner.cookie), { principalId: actor.id }) };
    },
  },
  {
    name: 'a demotion to viewer',
    setup: async ({ owner, actor, docId }) => {
      await insertGrant(d1.db, { docId }, actor, 'commenter');
      return { creds: userCreds(actor.cookie), revoke: () => call('PATCH', `/api/docs/${docId}/members`, userCreds(owner.cookie), { principalId: actor.id, role: 'viewer' }) };
    },
  },
  {
    name: 'a session revocation',
    setup: async ({ actor, docId }) => {
      await insertGrant(d1.db, { docId }, actor, 'commenter');
      const cookie = await signIn(actor);
      return {
        creds: userCreds(cookie),
        revoke: async () => {
          const out = await handleAuthRoute(new Request(`${BASE}/api/auth/sign-out`, {
            method: 'POST', headers: { 'content-type': 'application/json', origin: BASE, cookie }, body: '{}',
          }), env);
          expect(out.status).toBe(200);
        },
      };
    },
  },
  {
    name: 'an agent key revocation',
    setup: async ({ actor, docId }) => {
      const agent = await insertAgent(d1.db, actor);
      await insertGrant(d1.db, { docId }, { id: agent.id, type: 'agent' }, 'commenter');
      return {
        creds: { headers: { authorization: `Bearer ${agent.key}` } },
        revoke: () => d1.db.prepare('UPDATE agents SET revoked_at = ? WHERE id = ?').bind(Date.now(), agent.id).run(),
      };
    },
  },
  {
    name: 'a link revocation',
    setup: async ({ owner, actor, docId }) => {
      const token = await insertLink(d1.db, { docId }, 'commenter');
      return { creds: { headers: { cookie: actor.cookie }, share: token }, revoke: () => call('DELETE', `/api/docs/${docId}/links/${token}`, userCreds(owner.cookie)) };
    },
  },
  {
    name: 'a settled trash',
    setup: async ({ owner, actor, docId }) => {
      await insertGrant(d1.db, { docId }, actor, 'commenter');
      return {
        creds: userCreds(actor.cookie),
        revoke: async () => {
          expect((await call('DELETE', `/api/docs/${docId}`, userCreds(owner.cookie))).status).toBe(200);
          expect((await d1.db.prepare('SELECT deleted_at FROM docs WHERE id = ?').bind(docId).first<{ deleted_at: number | null }>())?.deleted_at).not.toBeNull();
        },
      };
    },
  },
];

describe('a comment write re-authorizes its actor in the serialized write @p:ppl-2', () => {
  for (const change of CHANGES) {
    for (const socket of [false, true]) {
      it(`${change.name} committed after admission refuses every comment write, ${socket ? 'with' : 'without'} an actor socket`, async () => {
        const owner = await signedUpUser(env, 'crv-owner', 'Ada');
        const actor = await signedUpUser(env, 'crv-actor', 'Ben');
        for (const op of OPS) {
          let revoke: () => Promise<unknown> = async () => undefined;
          const { docId, creds } = await seeded(owner, async (id) => {
            const made = await change.setup({ owner, actor, docId: id });
            revoke = made.revoke;
            return made.creds;
          });
          if (socket) await join(docId, creds);
          const before = records(docId);
          paused = revoke;
          const response = await op.run(docId, creds);
          expect(paused, `${op.name}: the change committed mid-request`).toBeNull();
          expect([401, 403, 404], `${op.name}: refused`).toContain(response.status);
          expect(records(docId), `${op.name}: the comment records are unchanged`).toBe(before);
        }
      });
    }
  }

  for (const socket of [false, true]) {
    it(`a commenter who keeps access still writes, ${socket ? 'with' : 'without'} a socket`, async () => {
      const owner = await signedUpUser(env, 'crv-owner', 'Ada');
      const actor = await signedUpUser(env, 'crv-actor', 'Ben');
      const bystander = await signedUpUser(env, 'crv-other', 'Cy');
      for (const op of OPS) {
        const { docId, creds } = await seeded(owner, async (id) => {
          await insertGrant(d1.db, { docId: id }, actor, 'commenter');
          await insertGrant(d1.db, { docId: id }, bystander, 'commenter');
          return userCreds(actor.cookie);
        });
        if (socket) await join(docId, creds);
        const before = records(docId);
        // An unrelated change bumps the access epoch mid-request.
        paused = () => call('DELETE', `/api/docs/${docId}/members`, userCreds(owner.cookie), { principalId: bystander.id });
        const response = await op.run(docId, creds);
        expect(paused).toBeNull();
        expect([200, 201], `${op.name}: allowed`).toContain(response.status);
        expect(records(docId), `${op.name}: written`).not.toBe(before);
      }
    });
  }
});
