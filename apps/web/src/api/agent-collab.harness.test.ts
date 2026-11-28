// Agents as collaborators (T7.3; A§17, A§8) over the real DocDO and PrincipalDO in the Node harness, real D1 and the
// REST routes: `push --suggest` lands a pending suggestion record that an editor can accept, never the body; an agent
// granted commenter by its owner can read and comment but its push and its suggestion are refused; and the read
// routes the CLI's `comments` and `suggestions` commands call list a note's threads and its open suggestions.
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { liveCredentials } from '../../../../packages/sync/src/access-epoch.ts';
import { DocDO } from '../../../../packages/sync/src/doc-do.ts';
import { PrincipalDO } from '../../../../packages/sync/src/principal-do.ts';
import { Backing, openDoc } from '../../../../packages/sync/test/harness/do-harness.ts';
import { FakeState } from '../../../../packages/sync/test/harness/workerd.ts';
import { migratedD1, type TestD1 } from '../test/d1.ts';
import { BASE, insertAgent, insertDoc, insertGrant, SECRET, signedUpUser, type TestUser } from '../test/principals.ts';
import { docAccessCheck } from '../worker/doc-access.ts';
import { handleApi } from './router.ts';

let d1: TestD1;

class CollabDocDO extends DocDO {
  static override projectionTarget = () => null;
  static override registry = () => null;
  static override liveness = () => async (docId: string) => {
    const row = await d1.db.prepare('SELECT deleted_at FROM docs WHERE id = ?').bind(docId).first<{ deleted_at: number | null }>();
    return !row || row.deleted_at !== null;
  };
  static override access = () => docAccessCheck({ DB: d1.db });
}

class CollabPrincipalDO extends PrincipalDO {
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

const docs = namespace((name) => openDoc(new Backing(name), CollabDocDO as never));
const principals = namespace((name) => new CollabPrincipalDO(new FakeState(new Backing(name)) as never, {} as never));

let env: Parameters<typeof handleApi>[1] & { BETTER_AUTH_SECRET: string; BETTER_AUTH_URL: string };

beforeAll(async () => {
  d1 = await migratedD1();
  env = {
    DB: d1.db, BETTER_AUTH_SECRET: SECRET, BETTER_AUTH_URL: BASE,
    DocDO: { idFromName: docs.idFromName, get: (id: { name: string }) => docs.get(id.name).dobj } as never,
    PrincipalDO: { idFromName: principals.idFromName, get: (id: { name: string }) => principals.get(id.name) } as never,
  };
}, 60_000);
afterAll(() => d1?.dispose());

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

async function seeded(owner: TestUser, markdown: string): Promise<string> {
  const docId = await insertDoc(d1.db, owner);
  await docs.get(docId).dobj.create({ folderId: owner.homeId, ownerId: owner.id, markdown });
  return docId;
}

interface Listed<T> { status: number; items: T[] }
interface SuggestionRow { id: string; author: { id: string; name: string }; status: string; source: string; outdated: boolean }
interface CommentRow { id: string; parentId: string | null; author: { id: string; name: string; type: string }; text: string; quote: string | null; resolved: boolean }

async function suggestions(docId: string, creds: Creds): Promise<Listed<SuggestionRow>> {
  const response = await call('GET', `/api/docs/${docId}/suggestions`, creds);
  return { status: response.status, items: response.ok ? ((await response.json()) as { suggestions: SuggestionRow[] }).suggestions : [] };
}

async function comments(docId: string, creds: Creds): Promise<Listed<CommentRow>> {
  const response = await call('GET', `/api/docs/${docId}/comments`, creds);
  return { status: response.status, items: response.ok ? ((await response.json()) as { comments: CommentRow[] }).comments : [] };
}

const BODY = ['Beans go in first.', 'Peas follow the beans.', 'Squash goes in last.'].join('\n\n');

describe('push --suggest @p:mean-2 @p:agt-1', () => {
  it('lands the change as an open suggestion by the agent, leaves the body as it was, and an editor can accept it', async () => {
    const ada = await signedUpUser(env, 'suggest-ada', 'Ada');
    const docId = await seeded(ada, BODY);
    const agent = await insertAgent(d1.db, ada);
    const base = await content(docId, bearer(agent.key));
    const next = base.replace('Peas follow the beans.', 'Peas follow the beans by a week.');

    const response = await call('POST', `/api/docs/${docId}/push`, bearer(agent.key), { newText: next, baseHash: sha(base), suggest: true });
    const pushed = (await response.json()) as { ok: boolean; mode?: string; suggestionId?: string };
    expect(response.status, JSON.stringify(pushed)).toBe(200);
    expect(pushed).toMatchObject({ ok: true, mode: 'suggest' });
    expect(typeof pushed.suggestionId).toBe('string');
    expect(await content(docId, cookieOf(ada)), 'the body is untouched until someone accepts').toBe(base);

    const listed = await suggestions(docId, cookieOf(ada));
    expect(listed.status).toBe(200);
    expect(listed.items).toHaveLength(1);
    expect(listed.items[0]).toMatchObject({ id: pushed.suggestionId, author: { id: agent.id, name: 'Scribe' }, status: 'open', source: 'cli', outdated: false });

    const preview = await call('GET', `/api/docs/${docId}/suggestions/${pushed.suggestionId}/preview`, cookieOf(ada));
    expect(preview.status).toBe(200);
    const { preview: shown } = (await preview.json()) as { preview: { hash: string; digest: string; hunks: unknown[] } };
    expect(JSON.stringify(shown.hunks)).toContain('by a week');
    const accepted = await call('POST', `/api/docs/${docId}/suggestions/${pushed.suggestionId}/accept`, cookieOf(ada), { previewHash: shown.hash, digest: shown.digest });
    expect(accepted.status, await accepted.clone().text()).toBe(200);
    expect(await content(docId, cookieOf(ada)), 'accepting lands exactly the pushed change').toBe(next);
    expect((await suggestions(docId, cookieOf(ada))).items, 'an accepted suggestion is no longer open').toHaveLength(0);
  });

  it('a suggestion deleting a sentence and adding a paragraph lands as pushed once accepted', async () => {
    const ada = await signedUpUser(env, 'suggest-del', 'Ada');
    const docId = await seeded(ada, BODY);
    const agent = await insertAgent(d1.db, ada);
    const base = await content(docId, bearer(agent.key));
    const next = `${base.replace('Peas follow the beans.\n\n', '')}\n\nWater at dawn.`;
    const response = await call('POST', `/api/docs/${docId}/push`, bearer(agent.key), { newText: next, baseHash: sha(base), suggest: true });
    const pushed = (await response.json()) as { suggestionId: string };
    expect(response.status).toBe(200);
    expect(await content(docId, cookieOf(ada))).toBe(base);
    const preview = (await (await call('GET', `/api/docs/${docId}/suggestions/${pushed.suggestionId}/preview`, cookieOf(ada))).json()) as { preview: { hash: string; digest: string } };
    const accepted = await call('POST', `/api/docs/${docId}/suggestions/${pushed.suggestionId}/accept`, cookieOf(ada), { previewHash: preview.preview.hash, digest: preview.preview.digest });
    expect(accepted.status, await accepted.clone().text()).toBe(200);
    expect(await content(docId, cookieOf(ada))).toBe(next);
  });

  it('a degenerate suggestion is refused like a degenerate push, and one that changes nothing suggests nothing', async () => {
    const ada = await signedUpUser(env, 'suggest-degenerate', 'Ada');
    const docId = await seeded(ada, BODY);
    const agent = await insertAgent(d1.db, ada);
    const base = await content(docId, bearer(agent.key));
    const wiped = await call('POST', `/api/docs/${docId}/push`, bearer(agent.key), { newText: 'Beans.', baseHash: sha(base), suggest: true });
    expect(wiped.status).toBe(409);
    expect(await wiped.json()).toMatchObject({ ok: false, reason: 'degenerate' });
    const same = await call('POST', `/api/docs/${docId}/push`, bearer(agent.key), { newText: base, baseHash: sha(base), suggest: true });
    expect(same.status).toBe(200);
    expect(await same.json()).toMatchObject({ ok: true, mode: 'edit', applied: 0 });
    expect((await suggestions(docId, cookieOf(ada))).items).toHaveLength(0);
  });
});

describe('an agent granted commenter by its owner @p:ppl-2 @p:agt-1', () => {
  it('pulls and comments; its push and its suggestion are refused 403 and change nothing', async () => {
    const ada = await signedUpUser(env, 'grant-ada', 'Ada');
    const ben = await signedUpUser(env, 'grant-ben', 'Ben');
    const docId = await seeded(ada, BODY);
    const agent = await insertAgent(d1.db, ben);
    await insertGrant(d1.db, { docId }, { id: agent.id, type: 'agent' }, 'commenter');
    const key = bearer(agent.key);

    const base = await content(docId, key);
    expect(base).toBe(await content(docId, cookieOf(ada)));
    const next = base.replace('Squash goes in last.', 'Squash goes in last, by the fence.');
    const edit = await call('POST', `/api/docs/${docId}/push`, key, { newText: next, baseHash: sha(base) });
    expect(edit.status).toBe(403);
    expect(await edit.json()).toMatchObject({ ok: false, reason: 'forbidden' });
    const suggest = await call('POST', `/api/docs/${docId}/push`, key, { newText: next, baseHash: sha(base), suggest: true });
    expect(suggest.status).toBe(403);
    expect(await suggest.json()).toMatchObject({ ok: false, reason: 'forbidden' });
    expect(await content(docId, cookieOf(ada))).toBe(base);
    expect((await suggestions(docId, cookieOf(ada))).items).toHaveLength(0);

    const commented = await call('POST', `/api/docs/${docId}/comments`, key, { id: 'agent-note-1', text: 'Squash needs room.', anchor: { quote: 'Squash goes in last' } });
    expect(commented.status, await commented.clone().text()).toBe(201);
    const listed = await comments(docId, cookieOf(ada));
    expect(listed.status).toBe(200);
    expect(listed.items).toEqual([expect.objectContaining({
      id: 'agent-note-1', parentId: null, text: 'Squash needs room.', quote: 'Squash goes in last', resolved: false,
      author: { id: agent.id, name: 'Scribe', type: 'agent' },
    })]);
  });

  it('a suggester agent may suggest but not edit', async () => {
    const ada = await signedUpUser(env, 'suggester-ada', 'Ada');
    const ben = await signedUpUser(env, 'suggester-ben', 'Ben');
    const docId = await seeded(ada, BODY);
    const agent = await insertAgent(d1.db, ben);
    await insertGrant(d1.db, { docId }, { id: agent.id, type: 'agent' }, 'suggester');
    const base = await content(docId, bearer(agent.key));
    const next = base.replace('Beans go in first.', 'Broad beans go in first.');
    expect((await call('POST', `/api/docs/${docId}/push`, bearer(agent.key), { newText: next, baseHash: sha(base) })).status).toBe(403);
    const suggested = await call('POST', `/api/docs/${docId}/push`, bearer(agent.key), { newText: next, baseHash: sha(base), suggest: true });
    expect(suggested.status).toBe(200);
    expect((await suggestions(docId, cookieOf(ada))).items).toEqual([expect.objectContaining({ author: { id: agent.id, name: 'Scribe' }, status: 'open' })]);
    expect(await content(docId, cookieOf(ada))).toBe(base);
  });
});

describe('the read routes behind `comments` and `suggestions` @p:agt-1', () => {
  it('list threads with replies under any reader, and refuse a stranger with the 404 a missing doc gets', async () => {
    const ada = await signedUpUser(env, 'read-ada', 'Ada');
    const cara = await signedUpUser(env, 'read-cara', 'Cara');
    const eve = await signedUpUser(env, 'read-eve', 'Eve');
    const docId = await seeded(ada, BODY);
    await insertGrant(d1.db, { docId }, cara, 'viewer');
    expect((await call('POST', `/api/docs/${docId}/comments`, cookieOf(ada), { id: 'root-1', text: 'Which beans?', anchor: { quote: 'Beans go in first' } })).status).toBe(201);
    expect((await call('POST', `/api/docs/${docId}/comments`, cookieOf(ada), { id: 'reply-1', text: 'Broad beans.', parentId: 'root-1' })).status).toBe(201);

    const listed = await comments(docId, cookieOf(cara));
    expect(listed.status).toBe(200);
    expect(listed.items.map((row) => [row.id, row.parentId, row.author.name, row.text])).toEqual([
      ['root-1', null, 'Ada', 'Which beans?'],
      ['reply-1', 'root-1', 'Ada', 'Broad beans.'],
    ]);
    expect(listed.items[0]!.quote).toBe('Beans go in first');
    expect((await suggestions(docId, cookieOf(cara))).status).toBe(200);

    const stranger = await call('GET', `/api/docs/${docId}/comments`, cookieOf(eve));
    const missing = await call('GET', `/api/docs/${crypto.randomUUID()}/comments`, cookieOf(eve));
    expect(stranger.status).toBe(404);
    expect(await stranger.text()).toBe(await missing.text());
    expect((await call('GET', `/api/docs/${docId}/suggestions`, cookieOf(eve))).status).toBe(404);
    expect((await call('GET', `/api/docs/${docId}/comments`, {})).status).toBe(401);
  });
});
