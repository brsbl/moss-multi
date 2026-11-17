// The DocDO's D1 projections (A§5.1; BUILDPLAN T1.4): a client's title writes project the trimmed title at most
// every 750 ms with a trailing flush, an empty title never projects, seed and replay never project, principal edits
// touch updated_at at most every 5 s, and create() with a title projects through the same path.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DocDO } from '../../src/doc-do.ts';
import type { ProjectionTarget } from '../../src/doc/projections.ts';
import { bindLexical, connect, openDoc, start, wake, type Opened, type TestClient } from './do-harness.ts';

interface Write { kind: 'title' | 'touch'; docId: string; value: string | number; at: number }

let writes: Write[] = [];
/** Title writes still to fail, and a gate the empty name's write waits on. */
let failTitles = 0;
let failedAt: number[] = [];
let emptyGate: Promise<void> | null = null;
const target: ProjectionTarget = {
  title: async (docId, title) => {
    if (failTitles > 0) {
      failTitles -= 1;
      failedAt.push(Date.now());
      throw new Error('D1 unavailable');
    }
    if (title === '' && emptyGate) await emptyGate;
    writes.push({ kind: 'title', docId, value: title, at: Date.now() });
  },
  touch: async (docId, at) => {
    writes.push({ kind: 'touch', docId, value: at, at: Date.now() });
  },
};

class ProjectingDoc extends DocDO {
  static override projectionTarget = () => target;
}

const titles = () => writes.filter((w) => w.kind === 'title').map((w) => w.value);
const touches = () => writes.filter((w) => w.kind === 'touch');

beforeEach(() => {
  vi.useFakeTimers();
  writes = [];
  failTitles = 0;
  failedAt = [];
  emptyGate = null;
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

const open = () => start(openDoc(undefined, ProjectingDoc as never));

async function editor(opened: Opened): Promise<TestClient> {
  const client = await connect(opened, { role: 'editor' });
  await client.hello();
  return client;
}

/** Types into the client's title one character per frame, `gapMs` apart. */
async function typeTitle(client: TestClient, text: string, gapMs: number): Promise<void> {
  for (const char of text) {
    const title = client.doc.getText('title');
    title.insert(title.length, char);
    await client.flush();
    await vi.advanceTimersByTimeAsync(gapMs);
  }
}

describe('title projection', () => {
  it('projects the trimmed title at most every 750 ms, ending on the last value', async () => {
    const opened = await open();
    const client = await editor(opened);
    await typeTitle(client, '  Weekly review ', 100);
    await vi.advanceTimersByTimeAsync(800);
    expect(titles().at(-1), 'the trailing flush lands the final title, trimmed').toBe('Weekly review');
    expect(titles().length, '16 keystrokes over 1.6 s project at most 3 times').toBeLessThanOrEqual(3);
    const times = writes.filter((w) => w.kind === 'title').map((w) => w.at);
    for (let i = 1; i < times.length; i += 1) expect(times[i] - times[i - 1]).toBeGreaterThanOrEqual(750);
    expect(new Set(writes.map((w) => w.docId))).toEqual(new Set([opened.backing.docId]));
  });

  it('never projects an empty title: clearing and retyping it projects only the retyped title', async () => {
    const opened = await open();
    const client = await editor(opened);
    await typeTitle(client, 'Plan', 10);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(titles()).toEqual(['Plan']);
    const title = client.doc.getText('title');
    title.delete(0, title.length);
    await client.flush();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(titles(), 'the empty title wrote nothing').toEqual(['Plan']);
    title.insert(0, '   ');
    await client.flush();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(titles(), 'nor does a blank one').toEqual(['Plan']);
    await typeTitle(client, 'Plans', 10);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(titles()).toEqual(['Plan', 'Plans']);
  });

  it('never projects the seed or a replay after a wake', async () => {
    const opened = await open();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(writes, 'the seed projects nothing').toEqual([]);
    const client = await editor(opened);
    await typeTitle(client, 'Kept', 10);
    await vi.advanceTimersByTimeAsync(1_000);
    writes = [];
    const woken = await start(wake(opened));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(woken.dobj.document.getText('title').toString()).toBe('Kept');
    expect(writes, 'a replayed title projects nothing').toEqual([]);
  });

  it('create() with a title projects it before it returns', async () => {
    const opened = await open();
    await opened.dobj.create({ folderId: 'folder-1', ownerId: 'user-1', title: '  Imported notes ' });
    expect(titles()).toEqual(['Imported notes']);
    expect(opened.dobj.document.getText('title').toString(), 'the doc holds the title as given, trimmed').toBe('Imported notes');
  });
});

describe('title projection failures', () => {
  it('a failed title write retries on its own, though a touch landed after it and nothing else was typed', async () => {
    const opened = await open();
    const client = await editor(opened);
    // Fails at ~0.75 s, ~1.75 s and ~3.75 s, so the trailing touch (~5 s) lands while the title is still failing.
    failTitles = 3;
    await typeTitle(client, 'Retried', 10);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(failedAt.length).toBe(3);
    const landed = writes.find((w) => w.kind === 'title');
    expect(landed?.value, 'the retry projected the title').toBe('Retried');
    expect(touches().some((w) => w.at > failedAt[2] && w.at < landed!.at), 'a touch landed between the last failure and the retry').toBe(true);
  });

  it('a wake reconciles a title whose write failed before the eviction', async () => {
    const opened = await open();
    const client = await editor(opened);
    failTitles = Number.POSITIVE_INFINITY;
    await typeTitle(client, 'Healed', 10);
    await vi.advanceTimersByTimeAsync(800);
    expect(titles()).toEqual([]);
    failTitles = 0;
    const woken = await start(wake(opened));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(woken.dobj.document.getText('title').toString()).toBe('Healed');
    expect(titles(), 'the woken DO projected the title D1 lacked').toEqual(['Healed']);
    writes = [];
    await start(wake(woken));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(writes, 'a title D1 already has is not projected again').toEqual([]);
  });

  it("create's empty name lands before a title projected while its write was in flight", async () => {
    const opened = await open();
    let release = () => {};
    emptyGate = new Promise<void>((done) => { release = done; });
    const created = opened.dobj.create({ folderId: 'folder-1', ownerId: 'user-1' });
    await vi.advanceTimersByTimeAsync(0);
    const client = await editor(opened);
    await typeTitle(client, 'Newer', 10);
    await vi.advanceTimersByTimeAsync(800);
    release();
    await created;
    await vi.advanceTimersByTimeAsync(800);
    expect(titles().at(-1), 'the newer title is the last write, so its title and filename win').toBe('Newer');
  });
});

describe('updated_at', () => {
  it('a principal edit touches updated_at at once, then at most every 5 s with a trailing touch', async () => {
    const opened = await open();
    const client = await editor(opened);
    const body = bindLexical(client.doc);
    await client.hello();
    for (let i = 0; i < 12; i += 1) {
      body.type(`word ${i} `);
      await client.flush();
      await vi.advanceTimersByTimeAsync(1_000);
    }
    await vi.advanceTimersByTimeAsync(6_000);
    const at = touches().map((w) => w.at);
    expect(at.length, '12 edits over 12 s touch 3 or 4 times').toBeGreaterThanOrEqual(3);
    expect(at.length).toBeLessThanOrEqual(4);
    for (let i = 1; i < at.length; i += 1) expect(at[i] - at[i - 1]).toBeGreaterThanOrEqual(5_000);
    expect(at.at(-1), 'the last edit is covered by a trailing touch').toBeGreaterThanOrEqual(at[0] + 10_000);
    expect(titles(), 'body edits project no title').toEqual([]);
  });

  it('the seed and a server import touch nothing', async () => {
    const opened = await open();
    await opened.dobj.create({ folderId: 'folder-1', ownerId: 'user-1', markdown: 'An imported body' });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(touches()).toEqual([]);
  });
});
