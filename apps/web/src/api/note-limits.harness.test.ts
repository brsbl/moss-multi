// The note's limits at the real caps through POST /api/docs into the real DocDO in the Node harness (A§5.1; T3.B31c):
// markdown holding 1,020,000 characters of text lands, and its export imports again whole (the pull and push round
// trip); one character more is a JSON 413 naming the text limit, with no row left. A note of one-line paragraphs just
// within the structure guard lands; one just past it is refused with the structure limit.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DocDO } from '../../../../packages/sync/src/doc-do.ts';
import { Backing, openDoc } from '../../../../packages/sync/test/harness/do-harness.ts';
import { migratedD1, type TestD1 } from '../test/d1.ts';
import { BASE, SECRET, signedUpUser, unmeteredPrincipals, type TestUser } from '../test/principals.ts';
import { handleApi } from './router.ts';

class LimitsDocDO extends DocDO {
  static override projectionTarget = () => null;
  static override registry = () => null;
  static override liveness = () => null;
  static override searchFeed = () => null;
}

// DO RPC hands the Worker a thrown error as an Error whose message carries the class name.
const overRpc = (error: unknown) => (error instanceof Error && error.name !== 'Error' ? new Error(`${error.name}: ${error.message}`) : error);

const opened = new Map<string, DocDO>();
const docNs = {
  idFromName: (name: string) => ({ name, toString: () => name }),
  get: (id: { name: string }) => {
    let dobj = opened.get(id.name);
    if (!dobj) opened.set(id.name, (dobj = openDoc(new Backing(id.name), LimitsDocDO as never).dobj));
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

let d1: TestD1;
let env: Parameters<typeof handleApi>[1] & { BETTER_AUTH_SECRET: string; BETTER_AUTH_URL: string };
let ada: TestUser;

beforeAll(async () => {
  d1 = await migratedD1();
  env = { DB: d1.db, ASSETS: d1.assets, BETTER_AUTH_SECRET: SECRET, BETTER_AUTH_URL: BASE, DocDO: docNs as never, PrincipalDO: unmeteredPrincipals as never };
  ada = await signedUpUser(env, 'note-limits', 'Ada');
}, 60_000);
afterAll(() => d1?.dispose());

const create = (markdown: string) => handleApi(new Request(`${BASE}/api/docs`, {
  method: 'POST', headers: { origin: BASE, 'content-type': 'application/json', cookie: ada.cookie }, body: JSON.stringify({ title: 'Large', markdown }),
}), env);
const content = (id: string) => handleApi(new Request(`${BASE}/api/docs/${id}/content`, { headers: { cookie: ada.cookie, accept: 'text/markdown' } }), env);
const rows = async () => (await d1.db.prepare('SELECT COUNT(*) AS n FROM docs WHERE owner_user_id = ?1').bind(ada.id).first<{ n: number }>())?.n ?? 0;

/** Paragraphs of 1,000 characters (the last holds the rest), `chars` in all. */
const text = (chars: number) => Array.from({ length: Math.ceil(chars / 1_000) }, (_, i) => 'a'.repeat(Math.min(1_000, chars - i * 1_000))).join('\n\n');

const lines = (count: number) => Array.from({ length: count }, (_, i) => `Line ${i} of the note.`).join('\n\n');

describe('the text limit, 1,020,000 characters', () => {
  it('a note of 1,020,000 characters lands, and its export imports again whole', { timeout: 180_000 }, async () => {
    const markdown = text(1_020_000);
    const response = await create(markdown);
    expect(response.status, await response.clone().text()).toBe(201);
    const { doc } = (await response.json()) as { doc: { id: string } };
    const pulled = await content(doc.id);
    expect(pulled.status).toBe(200);
    const exported = await pulled.text();
    expect(exported.replace(/\n/g, '').length, 'every character is in the export').toBe(1_020_000);
    const again = await create(exported);
    expect(again.status, 'the pulled note pushes back whole').toBe(201);
    const { doc: copy } = (await again.json()) as { doc: { id: string } };
    expect(await (await content(copy.id)).text()).toBe(exported);
  });

  it('one character more is a 413 naming the text limit, with no row left', { timeout: 180_000 }, async () => {
    const before = await rows();
    const response = await create(text(1_020_001));
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: 'doc-cap', limit: 'text', message: 'This note has reached its size limit (1.02 million characters).' });
    expect(await rows(), 'the provisional row is removed').toBe(before);
  });
});

describe('the structure limit, 180,000 structs', () => {
  it('35,998 one-line paragraphs land; 36,000 are a 413 naming the structure limit', { timeout: 300_000 }, async () => {
    const under = await create(lines(35_998));
    expect(under.status, await under.clone().text()).toBe(201);
    const before = await rows();
    const over = await create(lines(36_000));
    expect(over.status).toBe(413);
    expect(await over.json()).toEqual({
      error: 'doc-cap', limit: 'structure', message: 'This note is too big to add to: it has too many separate lines, cells or past edits. Continue in a new note.',
    });
    expect(await rows()).toBe(before);
  });
});
