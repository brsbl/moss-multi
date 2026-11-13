// The one access resolver (A§8) over real D1: ownership, the doc grant, grants on every folder up to the vault,
// agents with their owner's access plus their own grants, and share links as a ceiling. roles.test.ts proves the
// fold itself; this proves each source reaches it.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Principal } from '../auth/principal.ts';
import { createDb } from '../db/client.ts';
import { migratedD1, type TestD1 } from '../test/d1.ts';
import {
  BASE, insertAgent, insertDoc, insertFolder, insertGrant, insertLink, SECRET, signedUpUser, type AuthTestEnv, type TestUser,
} from '../test/principals.ts';
import type { Role } from '@moss-multi/protocol/roles';
import {
  accessibleDocs, accessibleFolders, foldDocRoles, foldFolderRoles, resolveDocAccess, resolveFolderAccess,
} from './access.ts';

let d1: TestD1;
let env: AuthTestEnv;
let ada: TestUser;
let ben: TestUser;
let cy: TestUser;

beforeAll(async () => {
  d1 = await migratedD1();
  env = { DB: d1.db, BETTER_AUTH_SECRET: SECRET, BETTER_AUTH_URL: BASE };
  ada = await signedUpUser(env, 'access-ada');
  ben = await signedUpUser(env, 'access-ben', 'Ben');
  cy = await signedUpUser(env, 'access-cy', 'Cy');
}, 60_000);
afterAll(() => d1?.dispose());

const user = (u: TestUser): Principal => ({ type: 'user', id: u.id, name: u.name, email: u.email, sessionId: 's', credential: 'cookie' });
const agentOf = (owner: TestUser, id: string): Principal => ({ type: 'agent', id, name: 'Scribe', ownerUserId: owner.id });
const anonymous = (shareToken: string): Principal => ({ type: 'anonymous', id: 'anonymous', name: 'Anonymous', shareToken });

const roleOn = async (principal: Principal, docId: string, token: string | null = null) =>
  (await resolveDocAccess(createDb(d1.db), principal, docId, token))?.role ?? null;

/** Ada's vault > a > b > c, with a doc in c and one at the vault root. */
async function nested(): Promise<{ vault: string; a: string; b: string; c: string; deep: string; top: string }> {
  const vault = await insertFolder(d1.db, ada, null);
  const a = await insertFolder(d1.db, ada, vault);
  const b = await insertFolder(d1.db, ada, a);
  const c = await insertFolder(d1.db, ada, b);
  return { vault, a, b, c, deep: await insertDoc(d1.db, ada, { folderId: c }), top: await insertDoc(d1.db, ada, { folderId: vault }) };
}

describe('resolveDocAccess', () => {
  it('makes the vault owner the owner, and gives anyone else with no grant nothing', async () => {
    const docId = await insertDoc(d1.db, ada);
    expect(await resolveDocAccess(createDb(d1.db), user(ada), docId)).toEqual({ role: 'owner', ownerUserId: ada.id, folderId: ada.homeId, deleted: false, linkOnly: false, viaLink: false });
    expect(await roleOn(user(ben), docId)).toBeNull();
    expect(await roleOn(user(ben), crypto.randomUUID())).toBeNull();
  });

  it('reads a doc grant at its role, for that person only', async () => {
    const docId = await insertDoc(d1.db, ada);
    await insertGrant(d1.db, { docId }, ben, 'commenter');
    expect(await roleOn(user(ben), docId)).toBe('commenter');
    expect(await roleOn(user(cy), docId)).toBeNull();
  });

  it('reads a grant on any folder up the chain, the vault included, for every doc below it', async () => {
    const tree = await nested();
    await insertGrant(d1.db, { folderId: tree.vault }, ben, 'viewer');
    expect(await roleOn(user(ben), tree.deep), 'a vault grant reaches three folders down').toBe('viewer');
    expect(await roleOn(user(ben), tree.top), 'a vault grant reaches the root').toBe('viewer');
    await insertGrant(d1.db, { folderId: tree.b }, cy, 'editor');
    expect(await roleOn(user(cy), tree.deep), 'a mid-chain folder grant reaches below it').toBe('editor');
    expect(await roleOn(user(cy), tree.top), 'and not above it').toBeNull();
  });

  it('takes the highest of the doc grant and the folder grants', async () => {
    const tree = await nested();
    await insertGrant(d1.db, { docId: tree.deep }, ben, 'viewer');
    await insertGrant(d1.db, { folderId: tree.a }, ben, 'editor');
    await insertGrant(d1.db, { folderId: tree.vault }, ben, 'commenter');
    expect(await roleOn(user(ben), tree.deep)).toBe('editor');
    await insertGrant(d1.db, { docId: tree.top }, cy, 'editor');
    await insertGrant(d1.db, { folderId: tree.vault }, cy, 'viewer');
    expect(await roleOn(user(cy), tree.top)).toBe('editor');
  });

  it("gives an agent its owner's access, plus by MAX any grant to the agent itself, but never above editor", async () => {
    const docId = await insertDoc(d1.db, ada);
    const adas = await insertAgent(d1.db, ada);
    expect(await roleOn(agentOf(ada, adas.id), docId), "Ada's agent on Ada's note: owner access needs a person").toBe('editor');
    const bens = await insertAgent(d1.db, ben);
    expect(await roleOn(agentOf(ben, bens.id), docId), "Ben's agent, Ben without access").toBeNull();
    await insertGrant(d1.db, { docId }, { id: bens.id, type: 'agent' }, 'viewer');
    expect(await roleOn(agentOf(ben, bens.id), docId), 'a grant to the agent alone').toBe('viewer');
    expect(await roleOn(user(ben), docId), "the agent's grant is not Ben's").toBeNull();
    await insertGrant(d1.db, { docId }, ben, 'editor');
    expect(await roleOn(agentOf(ben, bens.id), docId), "Ben's editor grant over the agent's viewer").toBe('editor');
  });

  it('treats a doc link as a ceiling: viewer signed out, its role signed in, the max with a grant', async () => {
    const docId = await insertDoc(d1.db, ada);
    const token = await insertLink(d1.db, { docId }, 'editor');
    expect(await roleOn(anonymous(token), docId), 'anonymous').toBe('viewer');
    expect(await roleOn(user(cy), docId, token), 'signed in, no grant').toBe('editor');
    await insertGrant(d1.db, { docId }, ben, 'commenter');
    expect(await roleOn(user(ben), docId, token), 'signed in, a lower grant').toBe('editor');
    const viewerLink = await insertLink(d1.db, { docId }, 'viewer');
    expect(await roleOn(user(ben), docId, viewerLink), 'signed in, a higher grant').toBe('commenter');
    expect(await roleOn(user(ada), docId, viewerLink), 'the owner with a link').toBe('owner');
  });

  it('applies a folder link to every doc below the folder, and no link to a doc it does not cover', async () => {
    const tree = await nested();
    const token = await insertLink(d1.db, { folderId: tree.a }, 'commenter');
    expect(await roleOn(user(cy), tree.deep, token)).toBe('commenter');
    expect(await roleOn(anonymous(token), tree.deep)).toBe('viewer');
    expect(await roleOn(user(cy), tree.top, token), 'the link covers a, not the vault root').toBeNull();
    const other = await insertLink(d1.db, { docId: tree.top }, 'editor');
    expect(await roleOn(user(cy), tree.deep, other), "another doc's link").toBeNull();
  });

  it('opens nothing through a revoked, forged or empty token', async () => {
    const docId = await insertDoc(d1.db, ada);
    const revoked = await insertLink(d1.db, { docId }, 'editor', { revoked: true });
    expect(await roleOn(anonymous(revoked), docId)).toBeNull();
    expect(await roleOn(user(cy), docId, revoked)).toBeNull();
    expect(await roleOn(anonymous('forged'), docId)).toBeNull();
    expect(await roleOn(user(cy), docId, '')).toBeNull();
  });

  it('reports a trashed doc as deleted to whoever could open it', async () => {
    const docId = await insertDoc(d1.db, ada, { deleted: true });
    await insertGrant(d1.db, { docId }, ben, 'editor');
    expect(await resolveDocAccess(createDb(d1.db), user(ben), docId)).toMatchObject({ role: 'editor', deleted: true });
    expect(await resolveDocAccess(createDb(d1.db), user(cy), docId)).toBeNull();
  });
});

describe('resolveFolderAccess', () => {
  it('makes the owner the owner and reads grants on the folder and its ancestors', async () => {
    const tree = await nested();
    expect(await resolveFolderAccess(createDb(d1.db), user(ada), tree.b)).toMatchObject({ role: 'owner', ownerUserId: ada.id, kind: 'folder', deleted: false, linkOnly: false });
    await insertGrant(d1.db, { folderId: tree.vault }, ben, 'editor');
    expect((await resolveFolderAccess(createDb(d1.db), user(ben), tree.c))?.role).toBe('editor');
    expect((await resolveFolderAccess(createDb(d1.db), user(ben), tree.vault))).toMatchObject({ role: 'editor', kind: 'vault' });
    expect(await resolveFolderAccess(createDb(d1.db), user(cy), tree.c)).toBeNull();
    expect(await resolveFolderAccess(createDb(d1.db), user(ada), crypto.randomUUID())).toBeNull();
  });
});

describe('discovery (accessibleFolders, accessibleDocs)', () => {
  it('gives every live doc and folder the role the resolver gives, for people and agents, over all the fixtures above', async () => {
    const tree = await nested();
    const bens = await insertAgent(d1.db, ben);
    await insertGrant(d1.db, { folderId: tree.a }, { id: bens.id, type: 'agent' }, 'editor');
    await insertGrant(d1.db, { folderId: tree.b }, cy, 'owner');
    await insertGrant(d1.db, { docId: tree.top }, cy, 'commenter');
    await insertGrant(d1.db, { docId: tree.deep }, ben, 'suggester');
    const db = createDb(d1.db);
    const docIds = (await d1.db.prepare('SELECT id FROM docs WHERE deleted_at IS NULL').all<{ id: string }>()).results.map((r) => r.id);
    const folderIds = (await d1.db.prepare('SELECT id FROM folders WHERE deleted_at IS NULL').all<{ id: string }>()).results.map((r) => r.id);
    for (const principal of [user(ada), user(ben), user(cy), agentOf(ben, bens.id)]) {
      const folders = await accessibleFolders(db, principal);
      const docs = await accessibleDocs(db, principal, folders);
      const folderRoles = new Map(folders.map((f) => [f.id, f.role]));
      const docRoles = new Map(docs.map((d) => [d.id, d.role]));
      for (const id of folderIds) {
        expect(folderRoles.get(id) ?? null, `folder ${id} for ${principal.type} ${principal.id}`).toBe((await resolveFolderAccess(db, principal, id))?.role ?? null);
      }
      for (const id of docIds) {
        expect(docRoles.get(id) ?? null, `doc ${id} for ${principal.type} ${principal.id}`).toBe((await resolveDocAccess(db, principal, id))?.role ?? null);
      }
    }
  }, 120_000);

  /** `items` with every element read through it counted. */
  function counted<T extends object>(items: T[]): { items: T[]; reads: () => number } {
    let reads = 0;
    const proxy = new Proxy(items, {
      get(target, key, receiver) {
        if (typeof key === 'string' && /^\d+$/.test(key)) reads += 1;
        return Reflect.get(target, key, receiver);
      },
    });
    return { items: proxy, reads: () => reads };
  }

  it('folds doc roles in work linear in docs, grants and folders', () => {
    const n = 4_000;
    const folderRows = Array.from({ length: 100 }, (_, i) => ({ id: `f${i}`, role: 'viewer' as Role }));
    const rows = Array.from({ length: n }, (_, i) => ({ id: `d${i}`, folderId: `f${i % 100}`, ownerUserId: ada.id }));
    const grants = Array.from({ length: n }, (_, i) => ({ docId: `d${i}`, role: (i % 2 ? 'editor' : 'commenter') as Role }));
    const [r, g, f] = [counted(rows), counted(grants), counted(folderRows)];
    const folded = foldDocRoles(user(ben), r.items, g.items, f.items);
    expect(folded.map((d) => d.role)).toEqual(rows.map((_, i) => (i % 2 ? 'editor' : 'commenter')));
    expect(r.reads() + g.reads() + f.reads(), 'element reads').toBeLessThanOrEqual(2 * (rows.length + grants.length + folderRows.length));
  });

  it('folds folder roles in work linear in folders and grants', () => {
    const n = 3_000;
    const vault = { id: 'v', parentId: null, deletedAt: null, kind: 'vault' as const, ownerUserId: ada.id };
    const rows = [vault, ...Array.from({ length: n }, (_, i) => ({ id: `f${i}`, parentId: i < 10 ? 'v' : `f${i % 10}`, deletedAt: null, kind: 'folder' as const, ownerUserId: ada.id }))];
    const grants = [{ folderId: 'v', role: 'viewer' as Role }, ...Array.from({ length: n }, (_, i) => ({ folderId: `f${i}`, role: (i % 3 ? 'viewer' : 'editor') as Role }))];
    const [r, g] = [counted(rows), counted(grants)];
    const folded = foldFolderRoles(user(ben), r.items, g.items);
    // A folder's role is the highest grant on it and its parent (folders below f0..f9 inherit theirs).
    const own = (i: number) => (i % 3 ? 'viewer' : 'editor');
    expect(folded.map((x) => x.role)).toEqual(['viewer', ...Array.from({ length: n }, (_, i) =>
      (i < 10 ? own(i) : own(i) === 'editor' || own(i % 10) === 'editor' ? 'editor' : 'viewer'))]);
    expect(r.reads() + g.reads(), 'element reads').toBeLessThanOrEqual(3 * (rows.length + grants.length));
  });
});
