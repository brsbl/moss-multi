// Settings → Agents over REST (T3.6; A§7, A§8, A§18): a person mints an agent key that is shown once and stored only as
// its sha256, lists their live agents with each agent's id, and revokes one through the kick path, after which the key
// is refused at once. A share's add field takes an agent id: the agent gets a direct grant, listed as an agent row.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AGENT_KEY_PREFIX, sha256Hex } from '../auth/principal.ts';
import { migratedD1, type TestD1 } from '../test/d1.ts';
import { BASE, insertDoc, insertFolder, insertGrant, SECRET, signedUpUser, type AuthTestEnv, type TestUser } from '../test/principals.ts';
import { handleApi } from './router.ts';

const revoked: string[] = [];
let revokeFails = false;

const PrincipalDO = {
  idFromName: (name: string) => ({ name, toString: () => name }),
  get: (id: { name: string }) => ({
    setName: async () => undefined,
    publish: async () => undefined,
    revokePrincipal: async () => {
      if (revokeFails) throw new Error('PrincipalDO unavailable');
      revoked.push(id.name);
    },
  }),
};

const DocDO = {
  idFromName: (name: string) => ({ name, toString: () => name }),
  get: () => ({ setName: async () => undefined, recheck: async () => ({ closed: 0 }) }),
};

let d1: TestD1;
let env: AuthTestEnv & Parameters<typeof handleApi>[1];
let ada: TestUser;
let ben: TestUser;
let cy: TestUser;

/** While set, runs once just before the first statement (or batch holding one) matching `sql`: a write landing then. */
let race: { sql: RegExp; run: () => Promise<unknown> } | null = null;

/** D1 as the routes see it, with `race` run ahead of the batch holding the statement it matches. */
function racingDb(db: D1Database): D1Database {
  const queries = new WeakMap<D1PreparedStatement, string>();
  const claim = async (query: string) => {
    const hook = race;
    if (!hook?.sql.test(query)) return;
    race = null;
    await hook.run();
  };
  return new Proxy(db, {
    get(target, prop) {
      if (prop === 'prepare') {
        return (query: string) => {
          const statement = target.prepare(query);
          const bind = statement.bind.bind(statement);
          statement.bind = (...args: unknown[]) => {
            const bound = bind(...args);
            queries.set(bound, query);
            return bound;
          };
          queries.set(statement, query);
          return statement;
        };
      }
      if (prop === 'batch') {
        return async (statements: D1PreparedStatement[]) => {
          for (const statement of statements) await claim(queries.get(statement) ?? '');
          return target.batch(statements);
        };
      }
      const value = Reflect.get(target, prop, target) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

beforeAll(async () => {
  d1 = await migratedD1();
  env = { DB: racingDb(d1.db), BETTER_AUTH_SECRET: SECRET, BETTER_AUTH_URL: BASE, DocDO: DocDO as never, PrincipalDO: PrincipalDO as never };
  ada = await signedUpUser(env, 'agents-ada', 'Ada');
  ben = await signedUpUser(env, 'agents-ben', 'Ben');
  cy = await signedUpUser(env, 'agents-cy', 'Cy');
}, 60_000);
afterAll(() => d1?.dispose());
beforeEach(() => {
  revoked.length = 0;
  revokeFails = false;
  race = null;
});

type Credential = { cookie: string } | { bearer: string } | null;

const call = (method: string, path: string, who: Credential, body?: unknown) =>
  handleApi(new Request(`${BASE}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      origin: BASE,
      ...(who && 'cookie' in who ? { cookie: who.cookie } : {}),
      ...(who && 'bearer' in who ? { authorization: `Bearer ${who.bearer}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), env);

interface Minted { agent: { id: string; name: string; createdAt: number }; key: string }

async function mint(user: TestUser, name = 'Scribe'): Promise<Minted> {
  const response = await call('POST', '/api/agents', { cookie: user.cookie }, { name });
  expect(response.status).toBe(201);
  return (await response.json()) as Minted;
}

describe('minting', () => {
  it('returns the key once, stores only its sha256, and lists the agent with its id but never the key', async () => {
    const { agent, key } = await mint(ada, '  Claude Code  ');
    expect(key.startsWith(AGENT_KEY_PREFIX)).toBe(true);
    expect(key.length).toBeGreaterThanOrEqual(AGENT_KEY_PREFIX.length + 40);
    expect(agent.name).toBe('Claude Code');
    const row = await d1.db.prepare('SELECT * FROM agents WHERE id = ?').bind(agent.id).first<Record<string, unknown>>();
    expect(row).toMatchObject({ owner_user_id: ada.id, key_hash: await sha256Hex(key), revoked_at: null });
    expect(JSON.stringify(row)).not.toContain(key);

    const listed = await call('GET', '/api/agents', { cookie: ada.cookie });
    expect(listed.status).toBe(200);
    expect(listed.headers.get('cache-control')).toBe('no-store');
    const text = await listed.text();
    expect(text).not.toContain(key);
    expect(text).not.toContain(await sha256Hex(key));
    expect((JSON.parse(text) as { agents: { id: string; name: string }[] }).agents).toContainEqual(expect.objectContaining({ id: agent.id, name: 'Claude Code' }));
  });

  it('makes a working key: a raw bearer request resolves to the agent acting for its owner', async () => {
    const { key, agent } = await mint(ada);
    const me = await call('GET', '/api/me', { bearer: key });
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({ principal: { type: 'agent', id: agent.id, ownerUserId: ada.id } });
  });

  it('lists only the caller’s own live agents', async () => {
    const mine = await mint(ada, 'Mine');
    const theirs = await mint(ben, 'Theirs');
    const listed = (await (await call('GET', '/api/agents', { cookie: ada.cookie })).json()) as { agents: { id: string }[] };
    const ids = listed.agents.map((a) => a.id);
    expect(ids).toContain(mine.agent.id);
    expect(ids).not.toContain(theirs.agent.id);
  });

  it('refuses a blank name, an agent key, and a caller with no session', async () => {
    expect((await call('POST', '/api/agents', { cookie: ada.cookie }, { name: '   ' })).status).toBe(400);
    expect((await call('POST', '/api/agents', { cookie: ada.cookie }, { name: 'x'.repeat(81) })).status).toBe(400);
    const { key } = await mint(ada);
    // An agent acts; it administers no keys.
    expect((await call('POST', '/api/agents', { bearer: key }, { name: 'Child' })).status).toBe(403);
    expect((await call('GET', '/api/agents', { bearer: key })).status).toBe(403);
    expect((await call('GET', '/api/agents', null)).status).toBe(401);
    expect((await call('POST', '/api/agents', null, { name: 'Nobody' })).status).toBe(401);
  });

  it('refuses a cookie POST from another origin', async () => {
    const response = await handleApi(new Request(`${BASE}/api/agents`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1:9999', cookie: ada.cookie },
      body: JSON.stringify({ name: 'Cross' }),
    }), env);
    expect(response.status).toBe(403);
  });
});

describe('revoking', () => {
  it('commits the revocation, kicks the agent’s PrincipalDO before answering, and the key 401s at once', async () => {
    const { agent, key } = await mint(ada);
    const response = await call('DELETE', `/api/agents/${agent.id}`, { cookie: ada.cookie });
    expect(response.status).toBe(200);
    expect(revoked).toEqual([agent.id]);
    expect((await call('GET', '/api/me', { bearer: key })).status).toBe(401);
    const listed = (await (await call('GET', '/api/agents', { cookie: ada.cookie })).json()) as { agents: { id: string }[] };
    expect(listed.agents.map((a) => a.id)).not.toContain(agent.id);
  });

  it('answers 503 when the kick is not acknowledged, with the key already refused; a retry kicks again', async () => {
    const { agent, key } = await mint(ada);
    revokeFails = true;
    expect((await call('DELETE', `/api/agents/${agent.id}`, { cookie: ada.cookie })).status).toBe(503);
    expect((await call('GET', '/api/me', { bearer: key })).status).toBe(401);
    revokeFails = false;
    expect((await call('DELETE', `/api/agents/${agent.id}`, { cookie: ada.cookie })).status).toBe(200);
    expect(revoked).toEqual([agent.id]);
  });

  it('gives another person’s agent the same 404 as a missing one, and revokes nothing', async () => {
    const { agent, key } = await mint(ben);
    const foreign = await call('DELETE', `/api/agents/${agent.id}`, { cookie: ada.cookie });
    const missing = await call('DELETE', `/api/agents/${crypto.randomUUID()}`, { cookie: ada.cookie });
    expect(foreign.status).toBe(404);
    expect(await foreign.text()).toBe(await missing.text());
    expect(revoked).toEqual([]);
    expect((await call('GET', '/api/me', { bearer: key })).status).toBe(200);
  });

  it('refuses an agent key revoking itself', async () => {
    const { agent, key } = await mint(ada);
    expect((await call('DELETE', `/api/agents/${agent.id}`, { bearer: key })).status).toBe(403);
    expect((await call('GET', '/api/me', { bearer: key })).status).toBe(200);
  });
});

describe('sharing with an agent by id', () => {
  interface Listed { members: { principalId: string; principalType: string; name: string; role: string }[] }
  const members = (target: string) => `/api/${target}/members`;

  it('grants the caller’s own agent directly, and lists it as an agent row at its role', async () => {
    const docId = await insertDoc(d1.db, ben);
    const { agent, key } = await mint(ben, 'Scribe');
    const shared = await call('POST', members(`docs/${docId}`), { cookie: ben.cookie }, { agentId: agent.id, role: 'commenter' });
    expect(shared.status).toBe(201);
    expect(await shared.json()).toMatchObject({ shared: { agentId: agent.id, name: 'Scribe', role: 'commenter' } });
    const listed = (await (await call('GET', members(`docs/${docId}`), { cookie: ben.cookie })).json()) as Listed;
    expect(listed.members).toContainEqual({ principalId: agent.id, principalType: 'agent', name: 'Scribe', role: 'commenter' });
    // A repeat or a raise answers 200; a lowering is refused here, as for an invite.
    expect((await call('POST', members(`docs/${docId}`), { cookie: ben.cookie }, { agentId: agent.id, role: 'editor' })).status).toBe(200);
    expect((await call('POST', members(`docs/${docId}`), { cookie: ben.cookie }, { agentId: agent.id, role: 'viewer' })).status).toBe(409);
    expect((await call('GET', `/api/docs/${docId}/access`, { bearer: key })).status).toBe(200);
  });

  it('never makes an agent an owner', async () => {
    const docId = await insertDoc(d1.db, ben);
    const { agent } = await mint(ben);
    expect((await call('POST', members(`docs/${docId}`), { cookie: ben.cookie }, { agentId: agent.id, role: 'owner' })).status).toBe(400);
    expect((await call('POST', members(`docs/${docId}`), { cookie: ben.cookie }, { agentId: agent.id, role: 'editor' })).status).toBe(201);
    expect((await call('PATCH', members(`docs/${docId}`), { cookie: ben.cookie }, { principalId: agent.id, role: 'owner' })).status).toBe(400);
  });

  // PRODUCT ruling 20: an agent id is a label, never consent.
  for (const kind of ['doc', 'folder'] as const) {
    it(`answers another person’s agent, a co-owner’s, a revoked one and an unknown id alike on a ${kind}, granting nothing`, async () => {
      const targetId = kind === 'doc' ? await insertDoc(d1.db, ben) : await insertFolder(d1.db, ben, ben.homeId);
      const path = members(`${kind === 'doc' ? 'docs' : 'folders'}/${targetId}`);
      const table = kind === 'doc' ? 'doc_members' : 'folder_members';
      const column = kind === 'doc' ? 'doc_id' : 'folder_id';
      // Cy co-owns the vault the target sits in.
      await insertGrant(d1.db, { folderId: ben.homeId }, { id: cy.id }, 'owner');
      const adas = await mint(ada, 'Adas');
      const cys = await mint(cy, 'Cys');
      const gone = await mint(ben, 'Gone');
      await call('DELETE', `/api/agents/${gone.agent.id}`, { cookie: ben.cookie });
      const answers = await Promise.all([adas.agent.id, cys.agent.id, gone.agent.id, crypto.randomUUID()].map(async (agentId) => {
        const response = await call('POST', path, { cookie: ben.cookie }, { agentId, role: 'viewer' });
        return { status: response.status, body: await response.text() };
      }));
      expect(answers.map((a) => a.status)).toEqual([404, 404, 404, 404]);
      expect(new Set(answers.map((a) => a.body)).size).toBe(1);
      const agentRows = await d1.db.prepare(`SELECT count(*) AS n FROM ${table} WHERE ${column} = ? AND principal_type = 'agent'`).bind(targetId).first<{ n: number }>();
      expect(agentRows?.n).toBe(0);
      if (kind === 'doc') expect((await call('GET', `/api/docs/${targetId}/access`, { bearer: adas.key })).status).toBe(404);
      await d1.db.prepare('DELETE FROM folder_members WHERE folder_id = ? AND principal_id = ?').bind(ben.homeId, cy.id).run();
    });
  }

  it('refuses in the guarded write when the agent changes hands between the read and the write', async () => {
    const docId = await insertDoc(d1.db, ben);
    const { agent } = await mint(ben, 'Moved');
    race = { sql: /^\s*INSERT INTO doc_members/, run: () => d1.db.prepare('UPDATE agents SET owner_user_id = ? WHERE id = ?').bind(ada.id, agent.id).run() };
    const response = await call('POST', members(`docs/${docId}`), { cookie: ben.cookie }, { agentId: agent.id, role: 'viewer' });
    expect(response.status).toBe(404);
    const rows = await d1.db.prepare('SELECT count(*) AS n FROM doc_members WHERE doc_id = ?').bind(docId).first<{ n: number }>();
    expect(rows?.n).toBe(0);
  });

  it('lets only the target’s owner add an agent', async () => {
    const docId = await insertDoc(d1.db, ben);
    const { agent } = await mint(ada);
    expect((await call('POST', members(`docs/${docId}`), { cookie: ada.cookie }, { agentId: agent.id, role: 'viewer' })).status).toBe(404);
  });
});
