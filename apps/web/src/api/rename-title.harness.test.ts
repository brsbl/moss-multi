// REST title writes (PATCH /api/docs/:id, POST /api/docs with a title) into the real DocDO in the Node harness, over
// D1, the real PrincipalDO and the one access resolver (A§5.1, A§8): a title is admitted against the state cap like a
// body (413 doc-cap, nothing written or projected), and a rename is re-authorized in the DocDO's own serialized turn,
// so a revocation or a trash that commits while it waits after the Worker's admission refuses it with nothing changed.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { d1Projections } from '@moss-multi/sync/projections';
import { DocDO } from '../../../../packages/sync/src/doc-do.ts';
import { PrincipalDO } from '../../../../packages/sync/src/principal-do.ts';
import { Backing, openDoc, start, wake, type Opened } from '../../../../packages/sync/test/harness/do-harness.ts';
import { FakeState } from '../../../../packages/sync/test/harness/workerd.ts';
import { migratedD1, type TestD1 } from '../test/d1.ts';
import { BASE, insertAgent, insertGrant, insertLink, SECRET, signedUpUser, type TestUser } from '../test/principals.ts';
import { docAccessCheck } from '../worker/doc-access.ts';
import { handleApi } from './router.ts';

let d1: TestD1;

/** The real DocDO, projecting into D1, settling from it and re-resolving access through the one resolver. */
class RenameDocDO extends DocDO {
  static override projectionTarget = () => d1Projections(d1.db);
  static override registry = () => null;
  static override searchFeed = () => null;
  static override access = () => docAccessCheck({ DB: d1.db });
  static override liveness = () => async (docId: string) => {
    const row = await d1.db.prepare('SELECT deleted_at FROM docs WHERE id = ?').bind(docId).first<{ deleted_at: number | null }>();
    return !row || row.deleted_at !== null;
  };
}

/** A small state cap, so a near-cap note is quick to make. */
const CAP = 48 * 1024;
class CappedDocDO extends RenameDocDO {
  static override limits = { ...DocDO.limits, stateCapBytes: CAP };
}
let capped = false;

// DO RPC hands the Worker a thrown error as an Error whose message carries the class name; the stub rethrows the same way.
const overRpc = (error: unknown) => (error instanceof Error && error.name !== 'Error' ? new Error(`${error.name}: ${error.message}`) : error);

const docs = new Map<string, Opened>();
const made: string[] = [];
const opened = (name: string): Opened => {
  let doc = docs.get(name);
  if (!doc) {
    docs.set(name, (doc = openDoc(new Backing(name), (capped ? CappedDocDO : RenameDocDO) as never)));
    made.push(name);
  }
  return doc;
};
const docNs = {
  idFromName: (name: string) => ({ name, toString: () => name }),
  get: (id: { name: string }) => {
    const { dobj } = opened(id.name);
    return new Proxy(dobj, {
      get(target, prop) {
        const value = Reflect.get(target, prop, target) as unknown;
        if (typeof value !== 'function') return value;
        return async (...args: unknown[]) => {
          try {
            return await (value as (...a: unknown[]) => unknown).apply(target, args);
          } catch (error) {
            throw overRpc(error);
          }
        };
      },
    });
  },
};
/** Evicts the doc's DocDO; the next call wakes a fresh instance over the same storage. */
const restart = async (docId: string) => {
  const doc = docs.get(docId);
  if (doc) docs.set(docId, await start(wake(doc)));
};

/** Real PrincipalDOs; a rename's write token waits on `paused` once, after the Worker has authorized it. */
let paused: { reached: () => void; release: Promise<void> } | null = null;
const principals = new Map<string, PrincipalDO>();
const principalNs = {
  idFromName: (name: string) => ({ name, toString: () => name }),
  get: (id: { name: string }) => {
    let dobj = principals.get(id.name);
    if (!dobj) principals.set(id.name, (dobj = new PrincipalDO(new FakeState(new Backing(id.name)) as never, {} as never)));
    const real = dobj;
    return new Proxy(real, {
      get(target, prop) {
        if (prop === 'takeWriteToken') {
          return async () => {
            const gate = paused;
            paused = null;
            if (gate) {
              gate.reached();
              await gate.release;
            }
            return target.takeWriteToken();
          };
        }
        const value = Reflect.get(target, prop, target) as unknown;
        return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    });
  },
};

/** Holds the next rename after the Worker's admission; `reached` resolves there, `release` lets it on. */
function pauseNextRename() {
  let reached = () => {};
  let release = () => {};
  const at = new Promise<void>((done) => { reached = done; });
  paused = { reached, release: new Promise<void>((done) => { release = done; }) };
  return { reached: at, release };
}

let env: Parameters<typeof handleApi>[1] & { BETTER_AUTH_SECRET: string; BETTER_AUTH_URL: string };
let ada: TestUser;
let ben: TestUser;
let cy: TestUser;

beforeAll(async () => {
  d1 = await migratedD1();
  env = { DB: d1.db, ASSETS: d1.assets, BETTER_AUTH_SECRET: SECRET, BETTER_AUTH_URL: BASE, DocDO: docNs as never, PrincipalDO: principalNs as never };
  ada = await signedUpUser(env, 'rename-ada', 'Ada');
  ben = await signedUpUser(env, 'rename-ben', 'Ben');
  cy = await signedUpUser(env, 'rename-cy', 'Cy');
}, 60_000);
afterAll(() => d1?.dispose());

type Headers = Record<string, string>;
const as = (user: TestUser): Headers => ({ cookie: user.cookie });

const createDoc = (body: Record<string, unknown>, headers: Headers = as(ada)) => handleApi(new Request(`${BASE}/api/docs`, {
  method: 'POST', headers: { origin: BASE, 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
}), env);
const rename = (docId: string, title: string, headers: Headers) => handleApi(new Request(`${BASE}/api/docs/${docId}`, {
  method: 'PATCH', headers: { origin: BASE, 'content-type': 'application/json', ...headers }, body: JSON.stringify({ title }),
}), env);
const trash = (docId: string) => handleApi(new Request(`${BASE}/api/docs/${docId}`, { method: 'DELETE', headers: { origin: BASE, ...as(ada) } }), env);
const restore = (docId: string) => handleApi(new Request(`${BASE}/api/docs/${docId}/restore`, { method: 'POST', headers: { origin: BASE, ...as(ada) } }), env);

async function newDoc(title: string, markdown?: string): Promise<string> {
  const response = await createDoc({ title, ...(markdown ? { markdown } : {}) });
  expect(response.status, await response.clone().text()).toBe(201);
  return ((await response.json()) as { doc: { id: string } }).doc.id;
}

const doTitle = (docId: string) => opened(docId).dobj.document.getText('title').toString();
const doState = (docId: string) => Y.encodeStateAsUpdate(opened(docId).dobj.document).byteLength;
const row = (docId: string) => d1.db.prepare('SELECT title, filename FROM docs WHERE id = ?').bind(docId).first<{ title: string; filename: string }>();

/** What a refused rename must leave as it was: the doc's title and state, and its D1 row. */
async function snapshot(docId: string) {
  return { title: doTitle(docId), state: doState(docId), row: await row(docId) };
}

/** Starts a rename, holds it after the Worker's admission, runs `meanwhile`, then lets it finish. */
async function racedRename(docId: string, title: string, headers: Headers, meanwhile: () => Promise<unknown>): Promise<Response> {
  const gate = pauseNextRename();
  const pending = rename(docId, title, headers);
  await gate.reached;
  await meanwhile();
  gate.release();
  return pending;
}

/** Paragraphs of text that make a note's state land near the cap. */
const body = (bytes: number) => Array.from({ length: Math.ceil(bytes / 900) }, (_, i) => `Paragraph ${i} ${'x'.repeat(880)}`).join('\n\n');

describe('a title against the state cap (A§5.1 Limits)', () => {
  it('a rename past the cap is 413 doc-cap, changing nothing; a short rename still lands', async () => {
    capped = true;
    const docId = await newDoc('Near cap', body(CAP - 12 * 1024));
    capped = false;
    expect(doState(docId), 'the note is near the cap').toBeGreaterThan(CAP - 16 * 1024);
    const before = await snapshot(docId);
    const long = `Long ${'t'.repeat(CAP - before.state + 2_048)}`;
    const refused = await rename(docId, long, as(ada));
    expect(refused.status).toBe(413);
    expect(await refused.json()).toEqual({ error: 'doc-cap' });
    expect(await snapshot(docId), 'the title, the state and the D1 row are unchanged').toEqual(before);

    const short = await rename(docId, 'Near cap, renamed', as(ada));
    expect(short.status).toBe(200);
    expect(doTitle(docId)).toBe('Near cap, renamed');
    expect((await row(docId))?.title).toBe('Near cap, renamed');
  });

  it('a create whose body and title together pass the cap is 413 doc-cap, leaving no row and no content', async () => {
    capped = true;
    const markdown = body(CAP - 12 * 1024);
    const control = await newDoc('Body alone', markdown);
    const bodyState = doState(control);
    const from = made.length;
    const refused = await createDoc({ title: `Long ${'t'.repeat(CAP - bodyState + 2_048)}`, markdown });
    capped = false;
    expect(refused.status).toBe(413);
    expect(await refused.json()).toEqual({ error: 'doc-cap' });
    const [refusedId] = made.slice(from);
    expect(refusedId, 'the create reached a DocDO').toBeDefined();
    expect(await row(refusedId), 'no row is left behind').toBeNull();
    expect(doTitle(refusedId), 'the title was never written').toBe('');
    expect(opened(refusedId).dobj.document.get('root', Y.XmlText).toString(), 'nor the body').not.toContain('Paragraph 1 ');
  });
});

describe('a rename re-authorized in the DocDO turn (A§8)', () => {
  it('a user whose grant is revoked while the rename waits is refused; with the grant it lands', async () => {
    const docId = await newDoc('Granted');
    await insertGrant(d1.db, { docId }, ben, 'editor');
    expect((await rename(docId, 'Ben renamed', as(ben))).status, 'the control: an editor grant renames').toBe(200);
    expect(doTitle(docId)).toBe('Ben renamed');

    const before = await snapshot(docId);
    const response = await racedRename(docId, 'After revocation', as(ben),
      () => d1.db.prepare('DELETE FROM doc_members WHERE doc_id = ? AND principal_id = ?').bind(docId, ben.id).run());
    expect(response.status).toBe(404);
    expect(await snapshot(docId)).toEqual(before);
  });

  it("an agent whose key is revoked while the rename waits is refused; with a live key it lands", async () => {
    const docId = await newDoc('Agent');
    const agent = await insertAgent(d1.db, ada);
    const bearer = { authorization: `Bearer ${agent.key}` };
    expect((await rename(docId, 'Agent renamed', bearer)).status, 'the control: a live key renames').toBe(200);
    expect(doTitle(docId)).toBe('Agent renamed');

    const before = await snapshot(docId);
    const response = await racedRename(docId, 'After key revocation', bearer,
      () => d1.db.prepare('UPDATE agents SET revoked_at = ? WHERE id = ?').bind(Date.now(), agent.id).run());
    expect(response.status).toBe(404);
    expect(await snapshot(docId)).toEqual(before);
  });

  it('an editor share link revoked while the rename waits is refused; while live it lands', async () => {
    const docId = await newDoc('Linked');
    const token = await insertLink(d1.db, { docId }, 'editor');
    const linked = { ...as(cy), 'x-moss-share': token };
    expect((await rename(docId, 'Link renamed', linked)).status, 'the control: a live editor link renames').toBe(200);
    expect(doTitle(docId)).toBe('Link renamed');

    const before = await snapshot(docId);
    const response = await racedRename(docId, 'After link revocation', linked,
      () => d1.db.prepare('UPDATE share_links SET revoked_at = ? WHERE token = ?').bind(Date.now(), token).run());
    expect(response.status).toBe(404);
    expect(await snapshot(docId)).toEqual(before);
  });
});

describe('a rename and Trash (A§5.1, A§8)', () => {
  it('a rename that waits while the note is trashed and settled is refused, before and after a restart', async () => {
    const docId = await newDoc('Kept name');
    const before = await snapshot(docId);
    const response = await racedRename(docId, 'Renamed in Trash', as(ada), async () => {
      expect((await trash(docId)).status).toBe(200);
    });
    expect(response.status).toBe(404);
    expect(doTitle(docId)).toBe(before.title);
    expect(await row(docId)).toEqual(before.row);
    await restart(docId);
    expect(doTitle(docId), 'nothing was persisted').toBe(before.title);
    expect(await row(docId)).toEqual(before.row);
  });

  it('a rename while a trash holds the note closed is refused; once the hold settles it lands', async () => {
    const docId = await newDoc('Held');
    const { dobj } = opened(docId);
    await dobj.trash('hold-rename');
    const before = await snapshot(docId);
    expect((await rename(docId, 'Renamed while held', as(ada))).status).toBe(404);
    expect(await snapshot(docId)).toEqual(before);
    await dobj.settle('hold-rename');
    expect((await rename(docId, 'Renamed after the hold', as(ada))).status).toBe(200);
    expect(doTitle(docId)).toBe('Renamed after the hold');
  });

  it('a restored note renames', async () => {
    const docId = await newDoc('Restored');
    expect((await trash(docId)).status).toBe(200);
    expect((await rename(docId, 'Renamed in Trash', as(ada))).status).toBe(404);
    expect((await restore(docId)).status).toBe(200);
    const response = await rename(docId, 'Renamed after restore', as(ada));
    expect(response.status).toBe(200);
    expect(doTitle(docId)).toBe('Renamed after restore');
    expect((await row(docId))?.title).toBe('Renamed after restore');
  });
});
