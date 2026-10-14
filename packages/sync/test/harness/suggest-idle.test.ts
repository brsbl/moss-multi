// The idle check (docs/design/suggestions.md §4.7) runs at most IDLE_BATCH previews per alarm, then yields and
// re-arms; a record checked at its updatedAt is not previewed again, across a wake, until it changes.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { IDLE_BATCH, reviewPreview } from '../../src/suggest/review.ts';
import { readMeta } from '../../src/suggest/records.ts';
import { forgeRecord, opOn, SEED } from '../../src/suggest/test-support.ts';
import { openDoc, start, wake, type Opened } from './do-harness.ts';

// reviewPreview as itself, counted.
vi.mock('../../src/suggest/review.ts', async (original) => {
  const actual = await original<typeof import('../../src/suggest/review.ts')>();
  return { ...actual, reviewPreview: vi.fn(actual.reviewPreview) };
});

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

const RECORDS = IDLE_BATCH * 2 + 3;

/** Open records with something to show, last changed long ago, so every one is due at once. */
function forgeAll(opened: Opened, count: number, from: number): void {
  const live = opened.dobj.document;
  for (let n = from; n < from + count; n += 1) {
    forgeRecord(live, `idle${n}`, [opOn(live, 'body', (copy) => {
      const block = copy.get('root', Y.XmlText).toDelta()[0].insert as Y.XmlText;
      block.insert(block.length, ` Word${n}`);
    })]);
  }
}

async function withRecords(count: number): Promise<Opened> {
  const opened = await start(openDoc());
  await opened.dobj.create({ folderId: 'folder-1', ownerId: 'owner-1', markdown: SEED });
  forgeAll(opened, count, 0);
  return opened;
}

const previewed = () => vi.mocked(reviewPreview).mock.calls.map(([, id]) => id);

describe('T5.S6 bounded idle check', () => {
  it('previews at most IDLE_BATCH records per alarm, re-arming at once until every due record is checked', async () => {
    const opened = await withRecords(RECORDS);
    vi.setSystemTime(Date.now() + 30_001);
    const seen: string[] = [];
    for (let alarm = 0; alarm < 10 && seen.length < RECORDS; alarm += 1) {
      vi.mocked(reviewPreview).mockClear();
      await opened.dobj.alarm();
      const batch = previewed();
      expect(batch.length, 'previews per alarm are bounded').toBeLessThanOrEqual(IDLE_BATCH);
      expect(batch.length, 'each alarm makes progress').toBeGreaterThan(0);
      seen.push(...batch);
      if (seen.length < RECORDS) expect(opened.backing.alarm, 'the rest re-arm at once').toBeLessThanOrEqual(Date.now());
    }
    expect(seen, 'every due record previewed once').toHaveLength(RECORDS);
    expect(new Set(seen).size).toBe(RECORDS);
    for (let n = 0; n < RECORDS; n += 1) expect(readMeta(opened.dobj.document, `idle${n}`)?.status).toBe('open');
  });

  it('a wake without edits replays nothing; a record changed after the wake is checked alone', async () => {
    let opened = await withRecords(RECORDS);
    vi.setSystemTime(Date.now() + 30_001);
    for (let alarm = 0; alarm < 10; alarm += 1) await opened.dobj.alarm();
    expect(new Set(previewed()).size).toBe(RECORDS);
    opened = await start(wake(opened));
    vi.setSystemTime(Date.now() + 60_000);
    vi.mocked(reviewPreview).mockClear();
    await opened.dobj.alarm();
    await opened.dobj.alarm();
    expect(previewed(), 'nothing replays after a wake').toEqual([]);
    forgeAll(opened, 1, RECORDS);
    vi.setSystemTime(Date.now() + 30_001);
    await opened.dobj.alarm();
    expect(previewed()).toEqual([`idle${RECORDS}`]);
  });
});
