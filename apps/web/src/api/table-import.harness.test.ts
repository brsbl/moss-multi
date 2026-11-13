// Markdown imports of tables (A§12; SP2) through POST /api/docs into the real DocDO in the Node harness: one that runs
// past the converter's work budget on table cells is a JSON 413 doc-cap with no row left behind, never a 500 and never
// a note cut short; one within it lands whole. scripts/measure-converter.mjs holds 2 MB notes of the same rows, and a
// table within the budget, to SP2's 5 s of workerd CPU.
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

// DO RPC hands the Worker a thrown DocCapError as an Error whose message carries the class name (measure-converter.mjs
// sees `Error: DocCapError: doc-cap` in workerd); the stub here rethrows the same way.
const overRpc = (error: unknown) => (error instanceof Error && error.name !== 'Error' ? new Error(`${error.name}: ${error.message}`) : error);

const opened = new Map<string, DocDO>();
const docNs = {
  idFromName: (name: string) => ({ name, toString: () => name }),
  get: (id: { name: string }) => {
    let dobj = opened.get(id.name);
    if (!dobj) opened.set(id.name, (dobj = openDoc(new Backing(id.name), TableDocDO as never).dobj));
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
  ada = await signedUpUser(env, 'table-import', 'Ada');
}, 60_000);
afterAll(() => d1?.dispose());

const create = (markdown: string) => handleApi(new Request(`${BASE}/api/docs`, {
  method: 'POST', headers: { origin: BASE, 'content-type': 'application/json', cookie: ada.cookie }, body: JSON.stringify({ title: 'Table', markdown }),
}), env);
const rows = async () => (await d1.db.prepare('SELECT COUNT(*) AS n FROM docs WHERE owner_user_id = ?1').bind(ada.id).first<{ n: number }>())?.n ?? 0;

const header = (cells: number) => `|${' h |'.repeat(cells)}\n|${' --- |'.repeat(cells)}\n`;

/** `count` rows of `cells` one-letter cells under a header as wide. */
const denseTable = (cells: number, count: number) => `${header(cells)}${`|${'a|'.repeat(cells)}\n`.repeat(count)}`;

/** `count` two-cell rows under a header of `cells` columns, each padded to the header's width. */
const paddedTable = (cells: number, count: number) => `${header(cells)}${'| b | c |\n'.repeat(count)}`;

describe('table imports', () => {
  // 512 KB of 64-cell rows (262,144 cells), and 4,000 two-cell rows each padded to 4,096 cells: both past the budget.
  it.each([['dense cells', denseTable(64, 4_096)], ['narrow rows padded under a wide header', paddedTable(4_096, 4_000)]])(
    'past the work budget, %s: a JSON 413 doc-cap with no row, never a 500 or a note cut short', { timeout: 120_000 }, async (_, markdown) => {
      const before = await rows();
      const started = performance.now();
      const response = await create(markdown);
      const text = await response.clone().text();
      expect(response.status, `${Math.round(performance.now() - started)} ms: ${text.slice(0, 500)}`).toBe(413);
      expect(response.headers.get('content-type')).toContain('application/json');
      expect(JSON.parse(text)).toEqual({ error: 'doc-cap' });
      expect(await rows(), 'the provisional row is removed').toBe(before);
    });

  it('within the work budget, 8,192 dense cells land whole, as the converter imports them', { timeout: 120_000 }, async () => {
    const markdown = denseTable(64, 127);
    const response = await create(markdown);
    expect(response.status, await response.clone().text()).toBe(201);
    const { doc } = (await response.json()) as { doc: { id: string } };
    const converted = importMarkdown(markdown);
    const blocks = converted.getEditorState().toJSON().root.children as { type: string; children?: unknown[] }[];
    expect(blocks.find((block) => block.type === 'table')?.children, 'every row is a table row').toHaveLength(128);
    expect(await opened.get(doc.id)!.exportMarkdown()).toBe(exportMarkdown(converted));
  });

  it('imports an ordinary table of 2,000 rows as the converter does', { timeout: 120_000 }, async () => {
    const markdown = ['| Item | Link | Note |', '| --- | --- | --- |', ...Array.from({ length: 2_000 }, (_, i) => `| **i${i}** | [l${i}](https://e.com/${i}) | \`c${i}\` and *n${i}* |`)].join('\n');
    const response = await create(markdown);
    expect(response.status, await response.clone().text()).toBe(201);
    const { doc } = (await response.json()) as { doc: { id: string } };
    expect(await opened.get(doc.id)!.exportMarkdown()).toBe(exportMarkdown(importMarkdown(markdown)));
  });
});
