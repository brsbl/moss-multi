// The comment REST API (BUILDPLAN T4.1, T4.4; docs/design/comments.md §4, §12): commenter and above, authorship from
// the server principal, 60 operations per principal per minute, the DocDO's verdict passed through, and the bell's
// rows for mentions and replies: users only, re-checked against their live access, never the actor.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migratedD1, type TestD1 } from '../test/d1.ts';
import { BASE, insertAgent, insertDoc, insertFolder, insertGrant, insertLink, SECRET, signedUpUser, type AuthTestEnv, type TestUser } from '../test/principals.ts';
import { handleApi } from './router.ts';

const calls: { docId: string; input: Record<string, unknown> }[] = [];
let verdict: Record<string, unknown> = { ok: true, id: 'c1', quote: 'brown fox' };

const DocDO = {
  idFromName: (name: string) => ({ name, toString: () => name }),
  get: (id: { name: string }) => ({
    setName: async () => undefined,
    createComment: async (input: Record<string, unknown>) => {
      calls.push({ docId: id.name, input });
      return verdict;
    },
    resolveComment: async (input: Record<string, unknown>) => {
      resolves.push({ docId: id.name, input });
      return verdict;
    },
    editComment: async (input: Record<string, unknown>) => {
      writes.push({ op: 'edit', docId: id.name, input });
      return verdict;
    },
    deleteComment: async (input: Record<string, unknown>) => {
      writes.push({ op: 'delete', docId: id.name, input });
      return verdict;
    },
    reactComment: async (input: Record<string, unknown>) => {
      writes.push({ op: 'react', docId: id.name, input });
      return verdict;
    },
  }),
};
const resolves: { docId: string; input: Record<string, unknown> }[] = [];
const writes: { op: string; docId: string; input: Record<string, unknown> }[] = [];

const tokenAsks: string[] = [];
let commentTokens = Infinity;
const PrincipalDO = {
  idFromName: (name: string) => ({ name, toString: () => name }),
  get: (id: { name: string }) => ({
    setName: async () => undefined,
    takeCommentToken: async () => {
      tokenAsks.push(id.name);
      commentTokens -= 1;
      return commentTokens >= 0;
    },
  }),
};

let d1: TestD1;
let env: AuthTestEnv & Parameters<typeof handleApi>[1];
let ada: TestUser;
let ben: TestUser;
let cara: TestUser;
let dan: TestUser;
let docId: string;
/** The actor the DocDO re-resolves: Ben by his session, with no share token. */
const actorBen = () => ({ kind: 'user', principalId: ben.id, sessionId: expect.any(String), shareToken: null });

beforeAll(async () => {
  d1 = await migratedD1();
  env = { DB: d1.db, BETTER_AUTH_SECRET: SECRET, BETTER_AUTH_URL: BASE, DocDO: DocDO as never, PrincipalDO: PrincipalDO as never };
  ada = await signedUpUser(env, 'comments-ada');
  ben = await signedUpUser(env, 'comments-ben', 'Ben');
  cara = await signedUpUser(env, 'comments-cara', 'Cara');
  dan = await signedUpUser(env, 'comments-dan', 'Dan');
  docId = await insertDoc(d1.db, ada);
  await insertGrant(d1.db, { docId }, { id: ben.id }, 'commenter');
  await insertGrant(d1.db, { docId }, { id: cara.id }, 'viewer');
}, 60_000);
afterAll(() => d1?.dispose());
beforeEach(() => {
  calls.length = 0;
  resolves.length = 0;
  writes.length = 0;
  tokenAsks.length = 0;
  commentTokens = Infinity;
  verdict = { ok: true, id: 'c1', quote: 'brown fox' };
});

const post = (cookie: string | null, body: unknown, path = `/api/docs/${docId}/comments`) =>
  handleApi(
    new Request(`${BASE}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: BASE, ...(cookie ? { cookie } : {}) },
      body: JSON.stringify(body),
    }),
    env,
  );

const COMMENT = { id: 'c1', text: 'Nice', anchor: { kind: 'text', start: 'AAA=', end: 'AAA=' }, author: 'forged-author' };

describe('POST /api/docs/:id/comments @p:tech-3 @p:mean-1', () => {
  it('lets a commenter create a comment authored by their own principal', async () => {
    const response = await post(ben.cookie, COMMENT);
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ comment: { id: 'c1', quote: 'brown fox' } });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ docId, input: { author: ben.id, source: 'user', id: 'c1', text: 'Nice', anchor: { kind: 'text', start: 'AAA=', end: 'AAA=' } } });
    expect(tokenAsks).toEqual([ben.id]);
  });

  it('lets the owner reply, and passes parentId', async () => {
    const response = await post(ada.cookie, { id: 'r1', text: 'Reply', parentId: 'c1' });
    expect(response.status).toBe(201);
    expect(calls[0].input).toMatchObject({ author: ada.id, id: 'r1', parentId: 'c1' });
  });

  it('refuses a viewer 403, a stranger the shared 404 and an anonymous caller 401', async () => {
    expect((await post(cara.cookie, COMMENT)).status).toBe(403);
    expect((await post(dan.cookie, COMMENT)).status).toBe(404);
    const anonymous = await post(null, COMMENT);
    expect(anonymous.status).toBe(401);
    expect(await anonymous.json()).toMatchObject({ message: 'Sign in to comment' });
    const link = await insertLink(d1.db, { docId }, 'commenter');
    const holder = await post(null, COMMENT, `/api/docs/${docId}/comments?share=${link}`);
    expect(holder.status).toBe(401);
    expect(calls).toEqual([]);
  });

  it('answers 429 past 60 comment operations per principal per minute', async () => {
    commentTokens = 0;
    const response = await post(ben.cookie, COMMENT);
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('60');
    expect(calls).toEqual([]);
  });

  it('refuses a malformed body with 400 before the DocDO', async () => {
    for (const body of [{ text: 'no id' }, { id: 'c1' }, { id: 'c1', text: 42 }, { id: 'c1', text: 'x', anchor: 'nope' }, { id: 'bad id!', text: 'x', parentId: 'c' }]) {
      expect((await post(ben.cookie, body)).status, JSON.stringify(body)).toBe(400);
    }
    expect(calls).toEqual([]);
  });

  it.each([
    [{ ok: false, status: 409, error: 'anchor-pending' }, 409],
    [{ ok: false, status: 409, error: 'too-many-overlapping' }, 409],
    [{ ok: false, status: 413, error: 'quote-too-long' }, 413],
  ])('passes the DocDO verdict %j through', async (answer, status) => {
    verdict = answer;
    const response = await post(ben.cookie, COMMENT);
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ error: answer.error });
  });
});

describe('POST /api/docs/:id/comments/:commentId/resolve @p:mean-1', () => {
  const resolve = (cookie: string | null, body: unknown, commentId = 'c1') => post(cookie, body, `/api/docs/${docId}/comments/${commentId}/resolve`);

  it('lets a commenter resolve and reopen a thread, as a user', async () => {
    const response = await resolve(ben.cookie, { resolved: true });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ comment: { id: 'c1', resolved: true } });
    expect(resolves).toEqual([{ docId, input: { actor: actorBen(), id: 'c1', resolved: true, by: 'user' } }]);
    expect((await resolve(ada.cookie, { resolved: false })).status).toBe(200);
    expect(tokenAsks).toEqual([ben.id, ada.id]);
  });

  it('refuses a viewer 403, a stranger 404, an anonymous caller 401 and a bad body 400', async () => {
    expect((await resolve(cara.cookie, { resolved: true })).status).toBe(403);
    expect((await resolve(dan.cookie, { resolved: true })).status).toBe(404);
    expect((await resolve(null, { resolved: true })).status).toBe(401);
    expect((await resolve(ben.cookie, { resolved: 'yes' })).status).toBe(400);
    expect((await resolve(ben.cookie, { resolved: true }, 'bad.id')).status).toBe(400);
    expect(resolves).toEqual([]);
  });

  it('passes a missing thread through as the DocDO answers it', async () => {
    verdict = { ok: false, status: 404, error: 'comment-missing' };
    const response = await resolve(ben.cookie, { resolved: true }, 'nope');
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: 'comment-missing' });
  });
});

const send = (method: string, cookie: string | null, path: string, body?: unknown) =>
  handleApi(
    new Request(`${BASE}${path}`, {
      method,
      headers: { 'content-type': 'application/json', origin: BASE, ...(cookie ? { cookie } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    env,
  );

describe('PATCH and DELETE /api/docs/:id/comments/:commentId, POST .../reactions @p:mean-1', () => {
  const path = (commentId = 'c1') => `/api/docs/${docId}/comments/${commentId}`;

  it('passes the caller as the author of an edit, a delete and a reaction, never the body', async () => {
    expect((await send('PATCH', ben.cookie, path(), { text: 'Edited', author: ada.id })).status).toBe(200);
    expect((await send('DELETE', ben.cookie, `${path()}?scope=thread`)).status).toBe(200);
    expect((await send('DELETE', ben.cookie, path())).status).toBe(200);
    expect((await send('POST', ben.cookie, `${path()}/reactions`, { emoji: '👍', on: true, principal: ada.id })).status).toBe(200);
    expect(writes).toEqual([
      { op: 'edit', docId, input: { actor: actorBen(), id: 'c1', author: ben.id, text: 'Edited' } },
      { op: 'delete', docId, input: { actor: actorBen(), id: 'c1', author: ben.id, scope: 'thread' } },
      { op: 'delete', docId, input: { actor: actorBen(), id: 'c1', author: ben.id, scope: 'comment' } },
      { op: 'react', docId, input: { actor: actorBen(), id: 'c1', principal: ben.id, emoji: '👍', on: true } },
    ]);
    expect(tokenAsks).toEqual([ben.id, ben.id, ben.id, ben.id]);
  });

  it("answers a non-author's raw delete and edit 403, as the DocDO rules", async () => {
    verdict = { ok: false, status: 403, error: 'not-author' };
    const deleted = await send('DELETE', ben.cookie, path());
    expect(deleted.status).toBe(403);
    expect(await deleted.json()).toMatchObject({ error: 'not-author' });
    expect((await send('PATCH', ben.cookie, path(), { text: 'Mine now' })).status).toBe(403);
  });

  it('refuses a viewer 403, a stranger 404, an anonymous caller 401 and a bad body 400, before the DocDO', async () => {
    expect((await send('DELETE', cara.cookie, path())).status).toBe(403);
    expect((await send('PATCH', dan.cookie, path(), { text: 'x' })).status).toBe(404);
    expect((await send('POST', null, `${path()}/reactions`, { emoji: '👍', on: true })).status).toBe(401);
    expect((await send('PATCH', ben.cookie, path(), { text: 7 })).status).toBe(400);
    expect((await send('DELETE', ben.cookie, `${path()}?scope=everything`)).status).toBe(400);
    expect((await send('POST', ben.cookie, `${path()}/reactions`, { emoji: '👍', on: 'yes' })).status).toBe(400);
    expect((await send('PUT', ben.cookie, path(), { text: 'x' })).status).toBe(405);
    expect(writes).toEqual([]);
  });
});

describe('comment notifications: mentions and replies reach the bell @p:ppl-3 @p:mean-1', () => {
  const mention = (name: string, id: string) => `\u2063@person:${name}\u2062${id}\u2064`;
  const rows = async (userId: string) =>
    (await d1.db.prepare('SELECT type, payload_json AS payload FROM notifications WHERE user_id = ? ORDER BY created_at, rowid').bind(userId).all<{ type: string; payload: string }>()).results;
  const bell = async (who: TestUser) => {
    const response = await send('GET', who.cookie, '/api/notifications');
    expect(response.status).toBe(200);
    return ((await response.json()) as { notifications: { type: string; by: string; target: { id: string }; commentId?: string }[] }).notifications;
  };
  let note: string;
  let eve: TestUser;
  let fay: TestUser;
  let agent: { id: string };

  beforeAll(async () => {
    eve = await signedUpUser(env, 'comments-eve', 'Eve');
    fay = await signedUpUser(env, 'comments-fay', 'Fay');
    note = await insertDoc(d1.db, ada);
    await insertGrant(d1.db, { docId: note }, { id: eve.id }, 'commenter');
    agent = await insertAgent(d1.db, ada);
    await insertGrant(d1.db, { docId: note }, { id: agent.id, type: 'agent' }, 'commenter');
  }, 60_000);

  const create = (who: TestUser, body: Record<string, unknown>) => send('POST', who.cookie, `/api/docs/${note}/comments`, body);

  it('an @mention writes a mention row for a mentioned person who can open the note, and reaches their bell', async () => {
    verdict = { ok: true, id: 'm1', quote: 'brown fox' };
    expect((await create(ada, { id: 'm1', text: `Look ${mention('Eve', eve.id)}`, anchor: { start: 'AAA=', end: 'AAA=' } })).status).toBe(201);
    expect(await rows(eve.id)).toEqual([{ type: 'mention', payload: JSON.stringify({ targetType: 'doc', targetId: note, by: ada.id, commentId: 'm1' }) }]);
    const notices = await bell(eve);
    expect(notices[0]).toMatchObject({ type: 'mention', by: 'Ada', target: { id: note }, commentId: 'm1' });
  });

  it('a reply writes a comment-reply row for the root author, and none for the replier', async () => {
    verdict = { ok: true, id: 'r1', quote: null, rootAuthor: eve.id };
    const before = (await rows(eve.id)).length;
    expect((await create(ada, { id: 'r1', text: 'Agreed', parentId: 'm1' })).status).toBe(201);
    const after = await rows(eve.id);
    expect(after).toHaveLength(before + 1);
    expect(after.at(-1)).toMatchObject({ type: 'comment-reply' });
    verdict = { ok: true, id: 'r2', quote: null, rootAuthor: eve.id };
    expect((await create(eve, { id: 'r2', text: `Me again ${mention('Eve', eve.id)}`, parentId: 'm1' })).status).toBe(201);
    expect(await rows(eve.id), 'the actor is never notified, by reply or self-mention').toHaveLength(before + 1);
    expect((await bell(eve)).map((n) => n.type)).toEqual(['comment-reply', 'mention']);
  });

  it('mentioning an agent writes no notification row', async () => {
    verdict = { ok: true, id: 'a1', quote: 'brown fox' };
    const before = (await d1.db.prepare('SELECT COUNT(*) AS n FROM notifications').first<{ n: number }>())!.n;
    expect((await create(ada, { id: 'a1', text: `Hey ${mention('Scribe', agent.id)}`, anchor: { start: 'AAA=', end: 'AAA=' } })).status).toBe(201);
    expect(await rows(agent.id)).toEqual([]);
    expect((await d1.db.prepare('SELECT COUNT(*) AS n FROM notifications').first<{ n: number }>())!.n).toBe(before);
    verdict = { ok: true, id: 'a2', quote: null, rootAuthor: agent.id };
    expect((await create(ada, { id: 'a2', text: 'Reply to the agent', parentId: 'a1' })).status).toBe(201);
    expect((await d1.db.prepare('SELECT COUNT(*) AS n FROM notifications').first<{ n: number }>())!.n, 'nor a reply to an agent').toBe(before);
    // An agent row would fail notifications.user_id's key and take the whole batch with it: the person's row proves
    // the agent was filtered out, not refused.
    verdict = { ok: true, id: 'a3', quote: 'brown fox' };
    const eves = (await rows(eve.id)).length;
    expect((await create(ada, { id: 'a3', text: `${mention('Scribe', agent.id)} and ${mention('Eve', eve.id)}`, anchor: { start: 'AAA=', end: 'AAA=' } })).status).toBe(201);
    expect(await rows(eve.id), 'the person mentioned beside the agent is notified').toHaveLength(eves + 1);
    expect(await rows(agent.id)).toEqual([]);
  });

  it('a mention of someone who cannot open the note writes nothing, and a lost grant hides the notice', async () => {
    verdict = { ok: true, id: 'f1', quote: 'brown fox' };
    expect((await create(ada, { id: 'f1', text: `Hi ${mention('Fay', fay.id)}`, anchor: { start: 'AAA=', end: 'AAA=' } })).status).toBe(201);
    expect(await rows(fay.id), 'no grant, no row').toEqual([]);
    await insertGrant(d1.db, { docId: note }, { id: fay.id }, 'viewer');
    verdict = { ok: true, id: 'f2', quote: 'brown fox' };
    expect((await create(ada, { id: 'f2', text: `Now ${mention('Fay', fay.id)}`, anchor: { start: 'AAA=', end: 'AAA=' } })).status).toBe(201);
    expect(await rows(fay.id)).toHaveLength(1);
    expect(await bell(fay)).toHaveLength(1);
    await d1.db.prepare('DELETE FROM doc_members WHERE doc_id = ? AND principal_id = ?').bind(note, fay.id).run();
    expect(await bell(fay), 'the notice is re-checked against the live grant when read').toEqual([]);
  });
});

/**
 * `db` with every prepared statement counted, and `before` run once ahead of the first statement that writes a
 * notification, whether it runs alone or in a batch: the moment between resolving recipients and inserting their rows.
 */
function instrumented(db: D1Database, before: (() => Promise<void>) | null = null) {
  let prepared = 0;
  let hook = before;
  const real = new WeakMap<object, D1PreparedStatement>();
  const notifying = new WeakSet<object>();
  const fire = async () => {
    const run = hook;
    hook = null;
    if (run) await run();
  };
  const wrap = (statement: D1PreparedStatement, writes: boolean): D1PreparedStatement => {
    const wrapped = new Proxy(statement, {
      get(target, name) {
        if (name === 'bind') return (...values: unknown[]) => wrap(target.bind(...values), writes);
        const value = Reflect.get(target, name, target);
        if (typeof value !== 'function') return value;
        if (!writes || !['all', 'run', 'first', 'raw'].includes(String(name))) return value.bind(target);
        return async (...args: unknown[]) => {
          await fire();
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      },
    });
    real.set(wrapped, statement);
    if (writes) notifying.add(wrapped);
    return wrapped;
  };
  const wrappedDb = new Proxy(db, {
    get(target, name) {
      if (name === 'prepare') return (query: string) => {
        prepared += 1;
        return wrap(target.prepare(query), /INSERT INTO notifications/i.test(query));
      };
      if (name === 'batch') return async (statements: D1PreparedStatement[]) => {
        if (statements.some((statement) => notifying.has(statement))) await fire();
        return target.batch(statements.map((statement) => real.get(statement) ?? statement));
      };
      const value = Reflect.get(target, name, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { db: wrappedDb, prepared: () => prepared };
}

describe('comment notifications are written only to people who can open the note at the insert @p:ppl-3 @p:mean-1', () => {
  const mention = (name: string, id: string) => `⁣@person:${name}⁢${id}⁤`;
  const rowsOf = async (docId: string) =>
    (await d1.db.prepare("SELECT user_id AS userId, type FROM notifications WHERE json_extract(payload_json, '$.targetId') = ? ORDER BY user_id")
      .bind(docId).all<{ userId: string; type: string }>()).results;
  const sendWith = (dbEnv: typeof env, who: TestUser, path: string, body: unknown) => handleApi(new Request(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: BASE, cookie: who.cookie },
    body: JSON.stringify(body),
  }), dbEnv);
  /** A person with an account and no access anywhere yet. */
  const person = async (label: string) => {
    const id = crypto.randomUUID();
    const now = Date.now();
    await d1.db.prepare('INSERT INTO user (id, name, email, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .bind(id, label, `mm-t4b1-${label}-${id}@example.invalid`, now, now).run();
    return id;
  };
  let vault: string;
  let folder: string;
  beforeAll(async () => {
    vault = await insertFolder(d1.db, ada, null);
    folder = await insertFolder(d1.db, ada, vault);
  });

  it('notifies the owner and people with a direct, folder or vault grant, and no link-only non-member', async () => {
    const note = await insertDoc(d1.db, ada, { folderId: folder });
    await insertGrant(d1.db, { docId: note }, { id: ben.id }, 'commenter');
    const [direct, inFolder, inVault, linkOnly] = await Promise.all(['direct', 'folder', 'vault', 'link'].map(person));
    await insertGrant(d1.db, { docId: note }, { id: direct! }, 'viewer');
    await insertGrant(d1.db, { folderId: folder }, { id: inFolder! }, 'viewer');
    await insertGrant(d1.db, { folderId: vault }, { id: inVault! }, 'commenter');
    await insertLink(d1.db, { docId: note }, 'commenter');
    verdict = { ok: true, id: 'g1', quote: 'brown fox' };
    const text = [mention('Ada', ada.id), mention('D', direct!), mention('F', inFolder!), mention('V', inVault!), mention('L', linkOnly!)].join(' ');
    expect((await sendWith(env, ben, `/api/docs/${note}/comments`, { id: 'g1', text, anchor: { start: 'AAA=', end: 'AAA=' } })).status).toBe(201);
    expect(await rowsOf(note)).toEqual([ada.id, direct!, inFolder!, inVault!].sort().map((userId) => ({ userId, type: 'mention' })));
  });

  const changes: [string, (note: string, id: string) => Promise<unknown>][] = [
    ['a recipient whose grant is removed', (note, id) => d1.db.prepare('DELETE FROM doc_members WHERE doc_id = ? AND principal_id = ?').bind(note, id).run()],
    ['a note sent to Trash', (note) => d1.db.prepare('UPDATE docs SET deleted_at = ? WHERE id = ?').bind(Date.now(), note).run()],
  ];
  it.each(changes)('%s between resolution and insert gets no row', async (_, change) => {
    const note = await insertDoc(d1.db, ada, { folderId: folder });
    const reader = await person('reader');
    await insertGrant(d1.db, { docId: note }, { id: reader }, 'viewer');
    verdict = { ok: true, id: 'g2', quote: 'brown fox' };
    const racing = instrumented(d1.db, async () => {
      await change(note, reader);
    });
    const response = await sendWith({ ...env, DB: racing.db }, ada, `/api/docs/${note}/comments`, { id: 'g2', text: `Hi ${mention('R', reader)}`, anchor: { start: 'AAA=', end: 'AAA=' } });
    expect(response.status).toBe(201);
    expect(await rowsOf(note)).toEqual([]);
  });

  it('reads and writes the same number of statements for 1 recipient and for 20', async () => {
    const note = await insertDoc(d1.db, ada, { folderId: folder });
    const people: string[] = [];
    for (let i = 0; i < 20; i += 1) {
      const id = await person(`many${i}`);
      await insertGrant(d1.db, i % 2 ? { docId: note } : { folderId: folder }, { id }, 'viewer');
      people.push(id);
    }
    const statements = async (ids: string[], commentId: string) => {
      verdict = { ok: true, id: commentId, quote: 'brown fox' };
      const counted = instrumented(d1.db);
      const text = ids.map((id) => mention('P', id)).join(' ');
      expect((await sendWith({ ...env, DB: counted.db }, ada, `/api/docs/${note}/comments`, { id: commentId, text, anchor: { start: 'AAA=', end: 'AAA=' } })).status).toBe(201);
      return counted.prepared();
    };
    const one = await statements(people.slice(0, 1), 'n1');
    const twenty = await statements(people, 'n20');
    expect(twenty, 'no statement per recipient').toBe(one);
    expect(await rowsOf(note)).toHaveLength(21);
  }, 60_000);
});
