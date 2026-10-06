// A revocation that lands mid-trash (T2.5 from T2.3s's checker; A§5.1, A§8), over the real DocDO and PrincipalDO in
// the Node harness, D1 and the REST routes: the trash closes open editors 4410 before D1 decides, the D1 write loses
// to the revocation, and the note reopens. Each editor that had it open hears of the change on its workspace channel,
// which is what moves a pane left terminal on a live note back to editable (doc-session.test.ts) without a reload.
import { afterAll, beforeAll, expect, it } from 'vitest';
import { CLOSE, TRUSTED } from '@moss-multi/protocol/sync';
import { DocDO } from '../../../../packages/sync/src/doc-do.ts';
import { PrincipalDO } from '../../../../packages/sync/src/principal-do.ts';
import { Backing, connect, openDoc, start, type Opened } from '../../../../packages/sync/test/harness/do-harness.ts';
import { FakeState, serverEnds } from '../../../../packages/sync/test/harness/workerd.ts';
import { migratedD1, type TestD1 } from '../test/d1.ts';
import { BASE, insertDoc, insertGrant, SECRET, signedUpUser, type TestUser } from '../test/principals.ts';
import { handleApi } from './router.ts';

let d1: TestD1;

/** The real DocDO, reading D1 for liveness, with no projections or sign-out registry in the way. */
class TrashDocDO extends DocDO {
  static override projectionTarget = () => null;
  static override registry = () => null;
  static override liveness = () => async (docId: string) => {
    const row = await d1.db.prepare('SELECT deleted_at FROM docs WHERE id = ?').bind(docId).first<{ deleted_at: number | null }>();
    return !row || row.deleted_at !== null;
  };
}

/** A namespace `getServerByName` can address, making each named instance once. */
function namespace<T extends object>(make: (name: string) => T) {
  const made = new Map<string, T>();
  const get = (name: string) => {
    let instance = made.get(name);
    if (!instance) made.set(name, (instance = make(name)));
    return instance;
  };
  return { get, ns: { idFromName: (name: string) => ({ name, toString: () => name }), get: (id: { name: string }) => get(id.name) } };
}

const docs = namespace((name) => openDoc(new Backing(name), TrashDocDO as never));
const docNs = { ...docs.ns, get: (id: { name: string }) => docs.get(id.name).dobj };
const principals = namespace((name) => new PrincipalDO(new FakeState(new Backing(name)) as never, {} as never));

/** While set, runs once just before the first statement matching it (alone or in a batch): a request landing in between. */
let race: { sql: RegExp; run: () => Promise<unknown> } | null = null;
const RACED = Symbol('raced');
const racing = (db: D1Database): D1Database => new Proxy(db, {
  get(target, prop) {
    if (prop === 'prepare') {
      return (query: string) => {
        const hook = race;
        if (!hook?.sql.test(query)) return target.prepare(query);
        race = null;
        const statement = (args: unknown[]) => {
          const run = (method: 'run' | 'all' | 'raw' | 'first') => async (...rest: unknown[]) => {
            await hook.run();
            const bound = target.prepare(query).bind(...args) as unknown as Record<string, (...a: unknown[]) => unknown>;
            return bound[method](...rest);
          };
          const raced = async () => {
            await hook.run();
            return target.prepare(query).bind(...args);
          };
          return { bind: (...more: unknown[]) => statement([...args, ...more]), run: run('run'), all: run('all'), raw: run('raw'), first: run('first'), [RACED]: raced };
        };
        return statement([]);
      };
    }
    if (prop === 'batch') {
      return async (statements: (D1PreparedStatement & { [RACED]?: () => Promise<D1PreparedStatement> })[]) => {
        const real: D1PreparedStatement[] = [];
        for (const statement of statements) real.push(statement[RACED] ? await statement[RACED]() : statement);
        return target.batch(real);
      };
    }
    const value = Reflect.get(target, prop, target) as unknown;
    return typeof value === 'function' ? value.bind(target) : value;
  },
});

let env: Parameters<typeof handleApi>[1] & { BETTER_AUTH_SECRET: string; BETTER_AUTH_URL: string };
let ada: TestUser;
let ben: TestUser;
let cy: TestUser;

beforeAll(async () => {
  d1 = await migratedD1();
  env = { DB: racing(d1.db), BETTER_AUTH_SECRET: SECRET, BETTER_AUTH_URL: BASE, DocDO: docNs as never, PrincipalDO: principals.ns as never };
  ada = await signedUpUser(env, 'midtrash-ada', 'Ada');
  ben = await signedUpUser(env, 'midtrash-ben', 'Ben');
  cy = await signedUpUser(env, 'midtrash-cy', 'Cy');
}, 60_000);
afterAll(() => d1?.dispose());

async function workspaceChannel(principalId: string, sessionId: string) {
  const dobj = principals.get(principalId);
  await dobj.setName(principalId);
  await dobj.fetch(new Request('https://moss.invalid/api/workspace/ws', { headers: {
    upgrade: 'websocket', [TRUSTED.principal]: principalId, [TRUSTED.session]: sessionId,
  } }));
  return serverEnds.at(-1)!;
}

const heard = (socket: { sent: (string | Uint8Array)[] }) =>
  socket.sent.filter((frame): frame is string => typeof frame === 'string' && frame.startsWith('{')).map((frame) => JSON.parse(frame) as { type: string; docIds?: string[] });

it('a co-owner demoted mid-trash trashes nothing: the note reopens and its open editor hears it changed', async () => {
  const docId = await insertDoc(d1.db, ada);
  await insertGrant(d1.db, { docId }, cy, 'owner');
  await insertGrant(d1.db, { docId }, ben, 'editor');
  const opened: Opened = await start(docs.get(docId));
  const editor = await connect(opened, { id: ben.id, role: 'editor' });
  await editor.hello();
  editor.doc.getText('title').insert(0, 'Kept');
  await editor.flush();
  const channel = await workspaceChannel(ben.id, 'sess-ben');

  race = { sql: /^update "docs"/i, run: () => d1.db.prepare("UPDATE doc_members SET role = 'editor' WHERE doc_id = ? AND principal_id = ?").bind(docId, cy.id).run() };
  const response = await handleApi(new Request(`${BASE}/api/docs/${docId}`, { method: 'DELETE', headers: { origin: BASE, cookie: cy.cookie } }), env);
  expect(race, 'the demotion landed between the hold and the D1 write').toBeNull();
  expect(response.status).toBe(403);
  expect((await d1.db.prepare('SELECT deleted_at FROM docs WHERE id = ?').bind(docId).first<{ deleted_at: number | null }>())?.deleted_at).toBeNull();
  expect(editor.closed?.code, 'the hold closed the editor before D1 decided').toBe(CLOSE.deleted);

  expect(heard(channel).some((event) => event.type === 'meta' && event.docIds?.includes(docId)),
    'the editor’s workspace channel names the note, so its terminal pane re-asks and reopens').toBe(true);

  const back = await connect(opened, { id: ben.id, role: 'editor' }, editor.doc);
  await back.hello();
  expect(back.closed, 'the note is live again').toBeNull();
  back.doc.getText('title').insert(4, ' and edited');
  await back.flush();
  expect(opened.dobj.document.getText('title').toString()).toBe('Kept and edited');
});
