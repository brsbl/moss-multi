// A markdown import that spends the converter's work budget on table cells (A§12; SP2), through POST /api/docs into
// the real DocDO in the Node harness: it lands whole or is a JSON 413 doc-cap with no row left behind, never a 500.
// scripts/measure-converter.mjs holds the same notes, at the markdown cap, to SP2's CPU budget in workerd.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { exportMarkdown, importMarkdown } from '../../../../packages/sync/src/converter/index.ts';
import { DocDO } from '../../../../packages/sync/src/doc-do.ts';
import { Backing, openDoc } from '../../../../packages/sync/test/harness/do-harness.ts';
import { migratedD1, type TestD1 } from '../test/d1.ts';
import { BASE, SECRET, signedUpUser, unmeteredPrincipals, type TestUser } from '../test/principals.ts';
import { handleApi } from './router.ts';

class TableDocDO extends DocDO {
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
    if (!dobj) opened.set(id.name, (dobj = openDoc(new Backing(id.name), TableDocDO as never).dobj));
    return dobj;
  },
};

let d1: TestD1;
let env: Parameters<typeof handleApi>[1] & { BETTER_AUTH_SECRET: string; BETTER_AUTH_URL: string };
let ada: TestUser;

beforeAll(async () => {
  d1 = await migratedD1();
  env = { DB: d1.db, ASSETS: d1.assets, BETTER_AUTH_SECRET: SECRET, BETTER_AUTH_URL: BASE, DocDO: docNs as never, PrincipalDO: unmeteredPrincipals as never };
  ada = await signedUpUser(env, 'table-import', 'Ada');
}, 60_000);
afterAll(() => d1?.dispose());

const create = (markdown: string) => handleApi(new Request(`${BASE}/api/docs`, {
  method: 'POST', headers: { origin: BASE, 'content-type': 'application/json', cookie: ada.cookie }, body: JSON.stringify({ title: 'Table', markdown }),
}), env);
const rows = async () => (await d1.db.prepare('SELECT COUNT(*) AS n FROM docs WHERE owner_user_id = ?1').bind(ada.id).first<{ n: number }>())?.n ?? 0;

const header = (cells: number) => `|${' h |'.repeat(cells)}\n|${' --- |'.repeat(cells)}\n`;

/** `bytes` of rows of `cells` one-letter cells under a header as wide: 256K cells at 512 KB, past the cell budget. */
function denseTable(cells: number, bytes: number): string {
  const row = `|${'a|'.repeat(cells)}\n`;
  return `${header(cells)}${row.repeat(Math.floor(bytes / row.length))}`;
}

/** `count` one-cell rows under a header of `cells` columns, each padded to the header's width. */
const paddedTable = (cells: number, count: number) => `${header(cells)}${'|b|\n'.repeat(count)}`;

describe('table imports past the work budget', () => {
  it.each([['dense cells', denseTable(64, 512 * 1024)], ['narrow rows padded under a wide header', paddedTable(4_096, 20_000)]])(
    '%s: lands whole or is a JSON 413 doc-cap with no row, never a 500', { timeout: 120_000 }, async (_, markdown) => {
      const before = await rows();
      const started = performance.now();
      const response = await create(markdown);
      const text = await response.clone().text();
      expect([201, 413], `${Math.round(performance.now() - started)} ms: ${text.slice(0, 500)}`).toContain(response.status);
      if (response.status === 413) {
        expect(response.headers.get('content-type')).toContain('application/json');
        expect(JSON.parse(text)).toEqual({ error: 'doc-cap' });
        expect(await rows(), 'the provisional row is removed').toBe(before);
      } else {
        const { doc } = JSON.parse(text) as { doc: { id: string } };
        expect(await rows()).toBe(before + 1);
        expect((await opened.get(doc.id)!.exportMarkdown()).length).toBeGreaterThan(0);
      }
    });

  it('imports an ordinary table of 2,000 rows as the converter does', { timeout: 120_000 }, async () => {
    const markdown = ['| Item | Link | Note |', '| --- | --- | --- |', ...Array.from({ length: 2_000 }, (_, i) => `| **i${i}** | [l${i}](https://e.com/${i}) | \`c${i}\` and *n${i}* |`)].join('\n');
    const response = await create(markdown);
    expect(response.status, await response.clone().text()).toBe(201);
    const { doc } = (await response.json()) as { doc: { id: string } };
    expect(await opened.get(doc.id)!.exportMarkdown()).toBe(exportMarkdown(importMarkdown(markdown)));
  });
});
