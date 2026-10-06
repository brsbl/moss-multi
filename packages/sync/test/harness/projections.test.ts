// The DocDO's D1 projections (A§5.1; BUILDPLAN T1.4): a client's title writes project the trimmed title at most
// every 750 ms with a trailing flush, an empty title never projects, seed and replay never project, principal edits
// touch updated_at at most every 5 s, and create() with a title projects through the same path.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DocDO } from '../../src/doc-do.ts';
import type { ProjectionTarget } from '../../src/doc/projections.ts';
import { bindLexical, connect, openDoc, start, wake, type Opened, type TestClient } from './do-harness.ts';

interface Write { kind: 'title' | 'touch'; docId: string; value: string | number; at: number }

let writes: Write[] = [];
const target: ProjectionTarget = {
  title: async (docId, title) => {
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
