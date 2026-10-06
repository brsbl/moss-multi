// The note creation budget (T3.S3; A§5.2, A§18): every route that mints a note (create, markdown import, duplicate)
// takes a token from the acting user's PrincipalDO before any D1 row, DocDO or media work, so one account, or its
// agent keys between them, cannot mint docs without bound. Over the real PrincipalDO in the Node harness and D1.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { DOC_CREATE_DAILY, DOC_CREATE_RATE, MARKDOWN_CAP_BYTES, VAULT_NOTE_CAP } from '@moss-multi/protocol/limits';
import { PrincipalDO } from '../../../../packages/sync/src/principal-do.ts';
import { Backing, FakeState } from '../../../../packages/sync/test/harness/workerd.ts';
import { migratedD1, type TestD1 } from '../test/d1.ts';
import { agentKey, BASE, insertDoc, insertFolder, SECRET, signedUpUser, type TestUser } from '../test/principals.ts';
import { handleApi } from './router.ts';

const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 31, 21, 196, 137]);

/** Every DocDO name addressed, and every seeded one. */
const addressed: string[] = [];
const seededDocs: string[] = [];
const DocDO = {
  idFromName: (name: string) => ({ name, toString: () => name }),
  get: (id: { name: string }) => {
    addressed.push(id.name);
    return {
      setName: async () => undefined,
      create: async () => { seededDocs.push(id.name); },
      snapshotForDuplicate: async () => ({ title: 'Original', state: new Uint8Array([1]), payloads: [] }),
      createFromSnapshot: async () => { seededDocs.push(id.name); },
    };
  },
};

/** Real PrincipalDOs over per-name storage; `evict` drops an instance so the next call wakes a fresh one. */
const backings = new Map<string, Backing>();
const live = new Map<string, { dobj: PrincipalDO; state: FakeState }>();
const principalOf = (name: string) => {
  let opened = live.get(name);
  if (!opened) {
    let backing = backings.get(name);
    if (!backing) backings.set(name, (backing = new Backing(name)));
    const state = new FakeState(backing);
    live.set(name, (opened = { dobj: new PrincipalDO(state as never, {} as never), state }));
  }
  return opened.dobj;
};
const evict = (name: string) => {
  const opened = live.get(name);
  if (opened) opened.state.alive = false;
  live.delete(name);
};
const PrincipalNs = { idFromName: (name: string) => ({ name, toString: () => name }), get: (id: { name: string }) => principalOf(id.name) };

let d1: TestD1;
let env: Parameters<typeof handleApi>[1] & { BETTER_AUTH_SECRET: string; BETTER_AUTH_URL: string };

beforeAll(async () => {
  d1 = await migratedD1();
  env = { DB: d1.db, ASSETS: d1.assets, BETTER_AUTH_SECRET: SECRET, BETTER_AUTH_URL: BASE, DocDO: DocDO as never, PrincipalDO: PrincipalNs as never };
}, 60_000);
afterAll(() => d1?.dispose());
afterEach(() => { vi.useRealTimers(); });

type Who = { cookie: string } | { bearer: string };
const call = (method: string, path: string, who: Who, body?: BodyInit, type = 'application/json') => {
  const headers: Record<string, string> = { origin: BASE, 'content-type': type };
  if ('cookie' in who) headers.cookie = who.cookie;
  else headers.authorization = `Bearer ${who.bearer}`;
  if (body instanceof Uint8Array) headers['content-length'] = String(body.byteLength);
  return handleApi(new Request(`${BASE}${path}`, { method, headers, body }), env);
};
const create = (who: Who, body: Record<string, unknown> = {}) => call('POST', '/api/docs', who, JSON.stringify(body));
const duplicate = (who: Who, docId: string) => call('POST', `/api/docs/${docId}/duplicate`, who);

const count = async (sql: string, ...binds: unknown[]) =>
  (await d1.db.prepare(sql).bind(...binds).first<{ n: number }>())?.n ?? 0;
const docsBy = (user: TestUser) => count('SELECT COUNT(*) AS n FROM docs WHERE created_by = ?1 OR owner_user_id = ?1', user.id);
const objects = async () => (await d1.assets.list()).objects.length;

/** Spends `n` of the user's creation tokens through `who`, each a 201. */
async function spend(who: Who, n: number): Promise<void> {
  for (let i = 0; i < n; i += 1) {
    const made = await create(who, { title: `Spent ${i}` });
    expect(made.status, `create ${i + 1}: ${await made.clone().text()}`).toBe(201);
  }
}

async function expectRefused(response: Response): Promise<void> {
  expect(response.status, await response.clone().text()).toBe(429);
  expect(response.headers.get('retry-after')).toBe(String(DOC_CREATE_RATE.windowMs / 1000));
  expect(((await response.json()) as { error: string }).error).toBe('rate-limited');
}

describe('note creation budget per acting user (T3.S3)', () => {
  it('refuses a create and import burst past the budget with 429, writing no row and seeding no DocDO', async () => {
    const ada = await signedUpUser(env, 'budget-burst', 'Ada');
    const before = await docsBy(ada);
    const seeds = seededDocs.length;
    const over = 5;
    const responses = await Promise.all(Array.from({ length: DOC_CREATE_RATE.max + over }, (_, i) =>
      create(ada, i % 2 ? { title: `Burst ${i}`, markdown: `Imported body ${i}\n` } : { title: `Burst ${i}` })));
    const statuses = responses.map((response) => response.status);
    expect(statuses.filter((status) => status === 201)).toHaveLength(DOC_CREATE_RATE.max);
    expect(statuses.filter((status) => status === 429)).toHaveLength(over);
    for (const response of responses.filter((r) => r.status === 429)) await expectRefused(response);
    expect(await docsBy(ada), 'doc rows').toBe(before + DOC_CREATE_RATE.max);
    expect(seededDocs.length - seeds, 'DocDOs seeded').toBe(DOC_CREATE_RATE.max);

    // Refused before anything is touched: no row, no DocDO addressed, whatever the body imports.
    const addressedBefore = addressed.length;
    await expectRefused(await create(ada, { title: 'One more', markdown: '# One more\n\nbody\n' }));
    expect(addressed.length, 'no DocDO addressed').toBe(addressedBefore);
    expect(await docsBy(ada)).toBe(before + DOC_CREATE_RATE.max);
  }, 60_000);

  it('refuses a duplicate past the budget before any row, DocDO, media refcount or stored bytes', async () => {
    const ben = await signedUpUser(env, 'budget-dup', 'Ben');
    const source = await insertDoc(d1.db, ben);
    const sent = await call('POST', `/api/docs/${source}/assets?filename=seed.png`, ben, PNG, 'image/png');
    expect(sent.status, await sent.clone().text()).toBe(201);
    const copied = await duplicate(ben, source);
    expect(copied.status, await copied.clone().text()).toBe(201);
    await spend(ben, DOC_CREATE_RATE.max - 1);

    const rows = await docsBy(ben);
    const media = await count('SELECT COUNT(*) AS n FROM doc_media');
    const stored = await objects();
    const addressedBefore = addressed.length;
    await expectRefused(await duplicate(ben, source));
    expect(await docsBy(ben), 'doc rows').toBe(rows);
    expect(await count('SELECT COUNT(*) AS n FROM doc_media'), 'media refcounts').toBe(media);
    expect(await objects(), 'stored objects').toBe(stored);
    expect(addressed.length, 'no DocDO addressed, the source included').toBe(addressedBefore);
    // Duplicates and creates draw on one budget.
    await expectRefused(await create(ben));
  }, 60_000);

  it('charges agent keys to their owner, so an owner and their keys share one budget', async () => {
    const cy = await signedUpUser(env, 'budget-agent', 'Cy');
    const dee = await signedUpUser(env, 'budget-other', 'Dee');
    const first = { bearer: await agentKey(d1.db, cy) };
    const second = { bearer: await agentKey(d1.db, cy) };
    await spend(cy, DOC_CREATE_RATE.max - 1);
    expect((await create(first, { title: 'By the agent' })).status).toBe(201);
    await expectRefused(await create(first));
    await expectRefused(await create(second));
    await expectRefused(await create(cy));
    expect((await create(dee)).status, 'another person has their own budget').toBe(201);
  }, 60_000);

  it('slides: refused inside the window across a PrincipalDO wake, granted once the window has passed', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const start = Date.now();
    vi.setSystemTime(start);
    const eve = await signedUpUser(env, 'budget-slide', 'Eve');
    await spend(eve, DOC_CREATE_RATE.max);
    await expectRefused(await create(eve));

    vi.setSystemTime(start + DOC_CREATE_RATE.windowMs / 2);
    evict(eve.id);
    await expectRefused(await create(eve));

    vi.setSystemTime(start + DOC_CREATE_RATE.windowMs + 1_000);
    evict(eve.id);
    expect((await create(eve, { title: 'After the window' })).status).toBe(201);
  }, 60_000);
});

/** A request body that fails the request if anything reads it. */
const unreadable = () => new ReadableStream<Uint8Array>({ pull() { throw new Error('the body was read'); } });
const streamedCreate = (who: Who, headers: Record<string, string> = {}) => {
  const auth: Record<string, string> = 'cookie' in who ? { cookie: who.cookie } : { authorization: `Bearer ${who.bearer}` };
  return handleApi(new Request(`${BASE}/api/docs`, {
    method: 'POST', headers: { origin: BASE, 'content-type': 'application/json', ...auth, ...headers }, body: unreadable(), duplex: 'half',
  } as RequestInit), env);
};

describe('creation admission order (T3.S3b)', () => {
  it('refuses an over-budget create before reading its body', async () => {
    const hal = await signedUpUser(env, 'budget-unread', 'Hal');
    await spend(hal, DOC_CREATE_RATE.max);
    const addressedBefore = addressed.length;
    await expectRefused(await streamedCreate(hal));
    expect(addressed.length, 'no DocDO addressed').toBe(addressedBefore);
  }, 60_000);

  it('refuses an oversized Content-Length with 413 before reading the body or taking a token', async () => {
    const ivy = await signedUpUser(env, 'budget-oversize', 'Ivy');
    const refused = await streamedCreate(ivy, { 'content-length': String(MARKDOWN_CAP_BYTES * 8) });
    expect(refused.status, await refused.clone().text()).toBe(413);
    await spend(ivy, DOC_CREATE_RATE.max);
  }, 60_000);
});

describe('daily creation budget (T3.S3b)', () => {
  it('refuses past DOC_CREATE_DAILY with 429 and writes nothing, until a day has passed', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const start = Date.now();
    let now = start;
    vi.setSystemTime(now);
    const jo = await signedUpUser(env, 'budget-daily', 'Jo');
    const dobj = principalOf(jo.id);
    // Paced under the minute window, as a steady script would be.
    for (let i = 0; i < DOC_CREATE_DAILY.max; i += 1) {
      if (i > 0 && i % DOC_CREATE_RATE.max === 0) vi.setSystemTime((now += DOC_CREATE_RATE.windowMs + 1));
      expect(await dobj.takeCreateToken(), `token ${i + 1}`).toBe(true);
    }
    vi.setSystemTime(now + DOC_CREATE_RATE.windowMs + 1);
    const rows = await docsBy(jo);
    const addressedBefore = addressed.length;
    const refused = await create(jo, { title: 'Past the day' });
    expect(refused.status, await refused.clone().text()).toBe(429);
    expect(((await refused.json()) as { error: string }).error).toBe('rate-limited');
    const wait = Number(refused.headers.get('retry-after'));
    expect(wait).toBeGreaterThan(DOC_CREATE_RATE.windowMs / 1000);
    expect(wait).toBeLessThanOrEqual(DOC_CREATE_DAILY.windowMs / 1000);
    expect(await docsBy(jo), 'doc rows').toBe(rows);
    expect(addressed.length, 'no DocDO addressed').toBe(addressedBefore);
    // Once the first minute's grants are a day old, creating works again.
    vi.setSystemTime(start + DOC_CREATE_DAILY.windowMs + 1_000);
    evict(jo.id);
    expect((await create(jo, { title: 'A day later' })).status).toBe(201);
  }, 120_000);
});

describe('live notes per vault (T3.S3b)', () => {
  it('refuses a create or duplicate into a full vault with 409 and writes nothing; other vaults and trash free room', async () => {
    const kim = await signedUpUser(env, 'vault-cap', 'Kim');
    const sub = await insertFolder(d1.db, kim, kim.homeId);
    // VAULT_NOTE_CAP - 1 live notes over the vault's folders, and trashed ones, which don't count.
    const fill = (folder: string, prefix: string, n: number, deleted: number | null) => d1.db.prepare(`WITH RECURSIVE n(i) AS (
        SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?2)
      INSERT INTO docs (id, owner_user_id, created_by, folder_id, title, filename, created_at, updated_at, deleted_at)
      SELECT ?1 || i, ?3, ?3, ?4, '', ?1 || i || '.md', 0, 0, ?5 FROM n`).bind(prefix, n, kim.id, folder, deleted).run();
    const half = Math.floor(VAULT_NOTE_CAP / 2);
    await fill(kim.homeId, `cap-a-${kim.id}-`, half, null);
    await fill(sub, `cap-b-${kim.id}-`, VAULT_NOTE_CAP - 1 - half, null);
    await fill(sub, `cap-t-${kim.id}-`, 5, 1);
    const last = await create(kim, { title: 'The last one' });
    expect(last.status, await last.clone().text()).toBe(201);

    const rows = await docsBy(kim);
    const seeds = seededDocs.length;
    const addressedBefore = addressed.length;
    const full = await create(kim, { title: 'One too many', folderId: sub });
    expect(full.status, await full.clone().text()).toBe(409);
    expect(((await full.json()) as { error: string }).error).toBe('vault-full');
    expect(addressed.length, 'no DocDO addressed').toBe(addressedBefore);
    const copied = await duplicate(kim, `cap-a-${kim.id}-1`);
    expect(copied.status, await copied.clone().text()).toBe(409);
    expect(await docsBy(kim), 'doc rows').toBe(rows);
    expect(seededDocs.length, 'no DocDO seeded').toBe(seeds);

    const other = await insertFolder(d1.db, kim, null);
    expect((await create(kim, { folderId: other })).status, 'another vault has its own room').toBe(201);
    await d1.db.prepare('UPDATE docs SET deleted_at = 1 WHERE id = ?1').bind(`cap-a-${kim.id}-2`).run();
    expect((await create(kim, { title: 'After a trash' })).status).toBe(201);
  }, 120_000);
});
