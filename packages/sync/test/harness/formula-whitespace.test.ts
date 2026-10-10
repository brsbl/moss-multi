// A formula with a long blank run inside ({{1+     +2|3}}) used to cost quadratic time wherever moss's formula runtime
// read it: authoredFormulaIds on every import (before any import budget), the DocDO's create, and the stored-formula
// recompute in every export, which the search feed runs after each save. Below LINEAR_IMPORT_LIMITS.lineChars (128K;
// converter/formula-literals.golden.test.ts holds the doubling range around it) the formula is a node; above it the
// line stays literal text but its payload is still read. Each path must grow linearly as the run doubles to 2 MB.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MARKDOWN_CAP_BYTES } from '@moss-multi/protocol/limits';
import { markdownToState } from '../../src/converter/index.ts';
import { DocDO, type SearchFeed } from '../../src/doc-do.ts';
import type { IndexEntry } from '../../src/search-do.ts';
import { Backing, openDoc, start } from './do-harness.ts';

beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] }));
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

/** One line of `chars` characters: a formula whose expression is mostly one blank run. */
const note = (chars: number): string => {
  const head = 'Total {{1+';
  const tail = '+2|3}} done.';
  return `${head}${' '.repeat(Math.max(1, chars - head.length - tail.length))}${tail}`;
};

/** Times `run` on a note of each doubling size; each must cost at most about three times the half-size one. */
async function expectLinear<T>(prepare: (markdown: string) => Promise<T>, run: (prepared: T) => Promise<void>): Promise<void> {
  const time = async (chars: number): Promise<number> => {
    const prepared = await prepare(note(chars));
    const startedAt = performance.now();
    await run(prepared);
    return performance.now() - startedAt;
  };
  await time(1024); // warm up
  let previous = await time(2048);
  for (let chars = 4096; chars <= MARKDOWN_CAP_BYTES; chars *= 2) {
    const took = await time(chars);
    expect(took, `${chars} chars took ${Math.round(took)} ms after ${Math.round(previous)} ms for half`).toBeLessThan(3 * previous + 250);
    previous = took;
  }
}

const fed: IndexEntry[] = [];
class FedDoc extends DocDO {
  static override searchFeed = (): SearchFeed => ({ index: async (entry) => { fed.push(entry); return { linksChanged: false }; } });
}

async function created(markdown: string): Promise<DocDO> {
  const { dobj } = await start(openDoc(new Backing(crypto.randomUUID()), FedDoc as never));
  await dobj.create({ folderId: 'f', ownerId: 'o', markdown });
  return dobj;
}

describe('a formula with a long blank run costs linear time @p:tech-8', () => {
  it('through markdownToState', async () => {
    await expectLinear(async (markdown) => markdown, async (markdown) => { markdownToState(markdown); });
  }, 300_000);

  it('through the DocDO create', async () => {
    await expectLinear(async (markdown) => ({ markdown, dobj: (await start(openDoc(new Backing(crypto.randomUUID()), FedDoc as never))).dobj }),
      async ({ markdown, dobj }) => dobj.create({ folderId: 'f', ownerId: 'o', markdown }));
  }, 300_000);

  it('through the stored-formula export and the search feed after a save', async () => {
    await expectLinear(created, async (dobj) => {
      const before = fed.length;
      await dobj.onSave();
      expect(fed.length, 'the save fed search').toBe(before + 1);
      expect(fed.at(-1)!.body).toContain('done.');
    });
  }, 300_000);

  it('keeps the formula a formula below lineChars, with its result recomputed on export', async () => {
    const dobj = await created(note(64 * 1024));
    expect(await dobj.exportMarkdown()).toMatch(/\{\{1\+ +\+2\|3\}\}/);
    const small = await created('{{1+   +2|9}}');
    expect(await small.exportMarkdown()).toContain('{{1+   +2|3}}');
  });
});
