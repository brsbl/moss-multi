// POST /api/docs takes the largest note it promises (T3.S7, T4.R2; A§18) through the real DocDO in the Node harness:
// near-cap markdown with comment markers and a moss comments sidecar, every character escaped, lands whole with its
// threads. body-cap.test.ts holds every route's 413s.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CREATE_BODY_MAX_BYTES, MARKDOWN_CAP_BYTES } from '@moss-multi/protocol/limits';
import { DocDO } from '../../../../packages/sync/src/doc-do.ts';
import { Backing, openDoc } from '../../../../packages/sync/test/harness/do-harness.ts';
import { migratedD1, type TestD1 } from '../test/d1.ts';
import { BASE, SECRET, signedUpUser, unmeteredPrincipals, type TestUser } from '../test/principals.ts';
import { handleApi } from './router.ts';

class CapDocDO extends DocDO {
  static override projectionTarget = () => null;
  static override registry = () => null;
  static override liveness = () => null;
  static override searchFeed = () => null;
}

const opened = new Map<string, DocDO>();
const docNs = {
  idFromName: (name: string) => ({ name, toString: () => name }),
  get: (id: { name: string }) => {
    let dobj = opened.get(id.name);
    if (!dobj) opened.set(id.name, (dobj = openDoc(new Backing(id.name), CapDocDO as never).dobj));
    return dobj;
  },
};

let d1: TestD1;
let env: Parameters<typeof handleApi>[1] & { BETTER_AUTH_SECRET: string; BETTER_AUTH_URL: string };
let ada: TestUser;

beforeAll(async () => {
  d1 = await migratedD1();
  env = { DB: d1.db, ASSETS: d1.assets, BETTER_AUTH_SECRET: SECRET, BETTER_AUTH_URL: BASE, DocDO: docNs as never, PrincipalDO: unmeteredPrincipals as never };
  ada = await signedUpUser(env, 'body-cap-harness', 'Ada');
}, 60_000);
afterAll(() => d1?.dispose());

/** The create body before T4.R2, which took the markdown escaped but not a sidecar beside it. */
const MARKDOWN_ONLY_BODY_MAX_BYTES = MARKDOWN_CAP_BYTES * 6 + 64 * 1024;

describe('note creation at the body cap', () => {
  it('takes near-cap markdown with markers and a full sidecar, every character escaped, and keeps them all', async () => {
    // JSON escapes each U+0001 as six bytes.
    const fill = '\u0001'.repeat(1_000);
    const head = 'The %%m:c1:start%%quick brown%%m:c1:end%% fox.\n\n';
    const paragraphs = Math.floor((MARKDOWN_CAP_BYTES - head.length - 4_096) / (fill.length + 2));
    const markdown = `${head}${`${fill}\n\n`.repeat(paragraphs)}`;
    expect(new TextEncoder().encode(markdown).byteLength).toBeLessThanOrEqual(MARKDOWN_CAP_BYTES);
    const at = 1_700_000_000;
    const comments: Record<string, unknown> = { c1: { text: 'On the fox', createdAt: at, updatedAt: at, source: 'user' } };
    for (let i = 1; i <= 24; i += 1) comments[`r${i}`] = { text: '\u0001'.repeat(10_000), parentId: 'c1', createdAt: at + i, updatedAt: at + i, source: 'user' };
    expect(new TextEncoder().encode(JSON.stringify(comments)).byteLength, 'the sidecar is within its own cap').toBeLessThanOrEqual(MARKDOWN_CAP_BYTES);
    const sent = JSON.stringify({ title: 'Imported', markdown, comments });
    const bytes = new TextEncoder().encode(sent).byteLength;
    expect(bytes, 'the smaller cap would refuse it').toBeGreaterThan(MARKDOWN_ONLY_BODY_MAX_BYTES);
    expect(bytes).toBeLessThanOrEqual(CREATE_BODY_MAX_BYTES);

    const response = await handleApi(new Request(`${BASE}/api/docs`, {
      method: 'POST', headers: { origin: BASE, 'content-type': 'application/json', cookie: ada.cookie }, body: sent,
    }), env);
    const text = await response.clone().text();
    expect(response.status, text.slice(0, 500)).toBe(201);
    const { doc } = JSON.parse(text) as { doc: { id: string } };
    const dobj = opened.get(doc.id)!;
    expect(dobj.document.getText('title').toString()).toBe('Imported');
    const exported = await dobj.exportMarkdown();
    expect(exported, 'the markers became a comment').not.toContain('%%m:');
    expect(exported).toContain('The quick brown fox.');
    expect(exported.split(fill).length - 1, 'every paragraph landed').toBe(paragraphs);
    const map = dobj.document.getMap('comments').toJSON() as Record<string, { text?: string; parentId?: string; author?: string; status?: string }>;
    expect(map['c:c1']).toMatchObject({ text: 'On the fox', author: ada.id });
    expect(map['a:c1']?.status, 'the root is anchored on its marked text').toBe('anchored');
    for (let i = 1; i <= 24; i += 1) expect(map[`c:r${i}`], `reply r${i}`).toMatchObject({ text: '\u0001'.repeat(10_000), parentId: 'c1' });
  }, 300_000);
});
