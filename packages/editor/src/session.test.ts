// The editor's save loop against the fixture host (an in-memory Moss workspace), with a stand-in for moss's
// editor surface: autosave timing, refused stale writes, external changes into a clean or a dirty editor, the
// silent meta retry, flush and unmount, drafts and receipts, and assets that only ever go through the host.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MossEditorEvent } from './contract';
import { MemoryHost, MemoryVolume, seedNote } from './testing/memory-host.js';
import { isMossAssetName } from './host/moss-editor-host.js';
import { assembleContent, type EditorContent, type RendererSnapshot } from './desktop/pipeline';
import { isNoteRelativeCompanionPath } from './desktop/note-store.port';
import { EditorSession, TIMING, type SessionSurface } from './session';

vi.setConfig({ testTimeout: 20_000 });

const ID = '3f0c2a1b-4d5e-4f60-8a7b-9c0d1e2f3a4b';
const DIR = '/Moss/Notes/Projects/Plan';
const META = {
  id: ID,
  title: 'Plan',
  createdAt: 1_780_000_000,
  updatedAt: 1_780_000_100,
  stickyTabs: [],
  frontmatterMeta: {},
  folderPath: 'Notes/Projects',
  trashedAt: null,
  lastOpenedAt: null,
  contentType: 'medium-text',
};

class FakeSurface implements SessionSurface {
  loaded: EditorContent | null = null;
  loads: { keepView: boolean }[] = [];
  editable = false;
  live = { title: '', body: '', comments: {} as RendererSnapshot['commentMetadata'] };
  views: unknown[] = [];
  colors: Record<string, number> = {};
  commit?: () => void;
  frozen = false;
  /** The chunk a body holding CHART needs before it shows, as the real surface's lazy views: held while set. */
  chunk: Promise<void> | null = null;

  prepare(content: EditorContent) {
    return content.body.includes('CHART') ? this.chunk : null;
  }

  freeze(frozen: boolean) {
    this.frozen = frozen;
  }

  load(content: EditorContent, options: { keepView: boolean }) {
    this.loaded = content;
    this.loads.push(options);
    this.live = { title: content.title, body: content.body, comments: content.commentMetadata };
    this.colors = { ...(content.commentColors ?? {}) };
  }

  /** As the real surface: a color the user did not change takes the new baseline's. */
  adoptCommentColors(previous: Record<string, number> | undefined, next: Record<string, number> | undefined) {
    for (const id of new Set([...Object.keys(previous ?? {}), ...Object.keys(next ?? {})])) {
      if (this.colors[id] !== previous?.[id]) continue;
      if (next?.[id] === undefined) delete this.colors[id];
      else this.colors[id] = next[id];
    }
  }

  snapshot(): RendererSnapshot {
    if (!this.loaded) throw new Error('nothing loaded');
    return {
      content: assembleContent(this.loaded, { title: this.live.title, body: this.live.body }),
      commentMetadata: this.live.comments,
      layoutMetadata: { version: 1, tableCount: 0, tables: [] },
      intents: { frontmatterMetaUpdates: {}, commentColors: { ...this.colors } },
    };
  }

  setEditable(editable: boolean) {
    this.editable = editable;
  }

  view(view: unknown) {
    this.views.push(view);
  }
}

let volume: MemoryVolume;
let host: MemoryHost;
let surface: FakeSurface;
let events: MossEditorEvent[];

const markdownOnDisk = () => volume.readFile(`${DIR}/Plan.md`);
const kinds = () => events.map((event) => event.kind);

function mount(options: { restoreDraft?: ConstructorParameters<typeof EditorSession>[0]['restoreDraft']; bridge?: unknown } = {}) {
  const session = new EditorSession({
    noteId: ID,
    bridge: (options.bridge ?? host) as ConstructorParameters<typeof EditorSession>[0]['bridge'],
    surface,
    onEvent: (event) => events.push(event),
    restoreDraft: options.restoreDraft,
  });
  return session;
}

/** Types into the stand-in editor and tells the session, as the real surface does on each change. */
function type(session: EditorSession, body: string) {
  surface.live.body = body;
  session.markEdited();
}

/** Lets I/O (crypto.subtle in the host's version tokens) complete, one real loop turn at a time. */
async function drain(turns = 40, minMs = 5) {
  // crypto.subtle runs on the thread pool, so a busy CI machine needs real time, not just loop turns.
  const until = performance.now() + minMs;
  for (let i = 0; i < turns || performance.now() < until; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
    await vi.advanceTimersByTimeAsync(0);
  }
}

/** Advances the fake clock by `ms` in small steps, letting I/O finish between them and after the last. */
async function settle(ms = 0) {
  const end = Date.now() + ms;
  await drain();
  while (Date.now() < end) {
    await vi.advanceTimersByTimeAsync(Math.min(25, end - Date.now()));
    await drain();
  }
  await drain(400, 50);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  vi.setSystemTime(new Date('2026-10-05T12:00:00Z'));
  volume = new MemoryVolume();
  seedNote(volume, ['Notes', 'Projects', 'Plan'], { markdown: '# Plan\n\nBody\n', meta: META });
  host = new MemoryHost({ volume });
  surface = new FakeSurface();
  events = [];
});

afterEach(() => {
  vi.useRealTimers();
});

describe('loading', () => {
  it('reads the note, renders it editable and reports clean', async () => {
    const session = mount();
    expect(session.status).toBe('loading');
    await session.ready;
    expect(session.status).toBe('clean');
    expect(surface.editable).toBe(true);
    expect(surface.loaded?.title).toBe('Plan');
    expect(surface.loaded?.body).toBe('Body\n');
    expect(session.location).toEqual({ folderPath: 'Notes/Projects', folderName: 'Plan', markdownName: 'Plan.md' });
  });

  it('a missing note rejects ready with notFound, and flush and unmount report notLoaded', async () => {
    volume.silently(() => volume.unlink(`${DIR}/meta.json`));
    const session = mount();
    await expect(session.ready).rejects.toMatchObject({ name: 'MossEditorError', code: 'notFound' });
    expect(session.status).toBe('notLoaded');
    await expect(session.flush()).resolves.toEqual({ kind: 'notLoaded' });
    await expect(session.unmount()).resolves.toEqual({ kind: 'unmounted', flush: { kind: 'notLoaded' } });
  });

  it('an API 1 bridge rejects ready with apiMismatch before any bridge call', async () => {
    const session = mount({ bridge: Object.assign(Object.create(host), { api: 1 }) });
    await expect(session.ready).rejects.toMatchObject({ name: 'MossEditorError', code: 'apiMismatch', message: 'bridge.api is 1; this editor implements API 2' });
    expect(session.status).toBe('notLoaded');
    expect(host.calls).toEqual([]);
  });

  it('a trashed note rejects ready with notEditable', async () => {
    volume.silently(() => volume.writeFile(`${DIR}/meta.json`, JSON.stringify({ ...META, trashedAt: 1_780_000_500 }, null, 2)));
    const session = mount();
    await expect(session.ready).rejects.toMatchObject({ code: 'notEditable', reason: 'trashed' });
  });
});

describe('autosave', () => {
  it('saves 1.5 s after the last edit, with the bytes desktop writes, and reports dirty, saving, saved', async () => {
    const session = mount();
    await session.ready;
    type(session, 'Body, edited\n');
    expect(session.status).toBe('dirty');
    await settle(1_400);
    type(session, 'Body, edited again\n');
    await settle(1_400);
    expect(markdownOnDisk()).toBe('# Plan\n\nBody\n');
    await settle(200);
    expect(markdownOnDisk()).toBe('# Plan\n\nBody, edited again\n');
    expect(session.status).toBe('clean');
    expect(kinds()).toEqual(['dirty', 'saving', 'saved']);
    const saved = events[2] as Extract<MossEditorEvent, { kind: 'saved' }>;
    expect(saved.files).toEqual(['markdown', 'meta']);
    expect(saved.renamed).toBe(false);
    expect(saved.receipt.files.markdown).toBe('# Plan\n\nBody, edited again\n');
    const meta = JSON.parse(volume.readFile(`${DIR}/meta.json`));
    expect(meta.updatedAt).toBeGreaterThanOrEqual(Math.floor(saved.at / 1000) - 1);
    expect(meta.updatedAt).toBeLessThanOrEqual(Math.floor(saved.at / 1000));
    expect(meta.commentColors).toEqual({});
  });

  it('saves at once when an edit arrives 15 s after the first unsaved edit', async () => {
    const session = mount();
    await session.ready;
    for (let i = 0; i < 15; i += 1) {
      type(session, `Body ${i}\n`);
      await settle(1_000);
    }
    expect(host.calls.filter((call) => call.op === 'write')).toHaveLength(0);
    type(session, 'Body 15\n');
    await settle(0);
    expect(markdownOnDisk()).toBe('# Plan\n\nBody 15\n');
  });

  it('a retitle renames the folder and the markdown file', async () => {
    const session = mount();
    await session.ready;
    surface.live.title = 'Q3 Plan';
    session.markEdited();
    await settle(1_500);
    expect(volume.isFile('/Moss/Notes/Projects/Q3 Plan/Q3 Plan.md')).toBe(true);
    expect(volume.exists(DIR)).toBe(false);
    expect(session.location?.folderName).toBe('Q3 Plan');
    const saved = events.find((event) => event.kind === 'saved') as Extract<MossEditorEvent, { kind: 'saved' }>;
    expect(saved.renamed).toBe(true);
  });
});

describe('conflicts with the Mac app', () => {
  it('a stale write is refused: the Mac bytes stay, and the editor keeps its edits in conflict', async () => {
    const session = mount();
    await session.ready;
    // Moss saves without bb seeing a change notification first.
    volume.silently(() => volume.writeFile(`${DIR}/Plan.md`, '# Plan\n\nWritten by Moss\n'));
    type(session, 'Written in bb\n');
    await settle(1_500);
    expect(markdownOnDisk()).toBe('# Plan\n\nWritten by Moss\n');
    expect(session.status).toBe('conflict');
    expect(events.find((event) => event.kind === 'conflict')).toMatchObject({ cause: 'refused' });
    const flushed = await session.flush();
    expect(flushed).toMatchObject({ kind: 'conflict' });
    if (flushed.kind === 'conflict') expect(flushed.draft.files.markdown).toBe('# Plan\n\nWritten in bb\n');
  });

  it('an external change reloads a clean editor in place', async () => {
    const session = mount();
    await session.ready;
    volume.writeFile(`${DIR}/Plan.md`, '# Plan\n\nChanged in Moss\n');
    await settle(250);
    expect(surface.loaded?.body).toBe('Changed in Moss\n');
    expect(surface.loads.at(-1)).toEqual({ keepView: true });
    expect(events.at(-1)).toMatchObject({ kind: 'reloaded', cause: 'external', overwrittenSave: null, status: 'clean' });
  });

  it('a replacement soon after a save carries the save as overwrittenSave', async () => {
    const session = mount();
    await session.ready;
    type(session, 'Saved by bb\n');
    await settle(1_500);
    volume.writeFile(`${DIR}/Plan.md`, '# Plan\n\nMoss replaced it\n');
    await settle(250);
    const reloaded = events.at(-1) as Extract<MossEditorEvent, { kind: 'reloaded' }>;
    expect(reloaded.kind).toBe('reloaded');
    expect(reloaded.overwrittenSave?.files.markdown).toBe('# Plan\n\nSaved by bb\n');
  });

  it('an external change under unsaved edits shows a conflict, and Overwrite saves the local version on top', async () => {
    const session = mount();
    await session.ready;
    type(session, 'Local edit\n');
    volume.writeFile(`${DIR}/Plan.md`, '# Plan\n\nRemote edit\n');
    await settle(250);
    expect(session.status).toBe('conflict');
    expect(events.find((event) => event.kind === 'conflict')).toMatchObject({ cause: 'external' });
    await settle(5_000);
    expect(markdownOnDisk()).toBe('# Plan\n\nRemote edit\n');
    await session.resolveConflict('overwrite');
    await settle(0);
    expect(markdownOnDisk()).toBe('# Plan\n\nLocal edit\n');
    expect(events.find((event) => event.kind === 'conflictResolved')).toMatchObject({ resolution: 'overwritten' });
    expect(session.status).toBe('clean');
  });

  it('Reload drops the local edits and shows the disk version', async () => {
    const session = mount();
    await session.ready;
    type(session, 'Local edit\n');
    volume.writeFile(`${DIR}/Plan.md`, '# Plan\n\nRemote edit\n');
    await settle(250);
    await session.resolveConflict('reload');
    expect(surface.loaded?.body).toBe('Remote edit\n');
    expect(session.status).toBe('clean');
    expect(events.find((event) => event.kind === 'conflictResolved')).toMatchObject({ resolution: 'reloaded' });
  });

  it('a meta-only change is re-read and retried silently, keeping the new meta.json fields', async () => {
    const session = mount();
    await session.ready;
    volume.silently(() => volume.writeFile(`${DIR}/meta.json`, JSON.stringify({ ...META, lastOpenedAt: 1_790_000_000, pinned: true, pinnedAt: 1_790_000_001 }, null, 2)));
    type(session, 'Edited\n');
    await settle(1_500);
    expect(markdownOnDisk()).toBe('# Plan\n\nEdited\n');
    expect(JSON.parse(volume.readFile(`${DIR}/meta.json`))).toMatchObject({ lastOpenedAt: 1_790_000_000, pinned: true });
    expect(kinds()).not.toContain('conflict');
    expect(session.status).toBe('clean');
  });

  it('a meta-only change to comment colors is kept by the next body save', async () => {
    volume.silently(() => volume.writeFile(`${DIR}/meta.json`, JSON.stringify({ ...META, commentColors: { a: 1 } }, null, 2)));
    const session = mount();
    await session.ready;
    volume.writeFile(`${DIR}/meta.json`, JSON.stringify({ ...META, commentColors: { a: 3 } }, null, 2));
    await settle(250);
    type(session, 'Edited\n');
    await settle(1_500);
    expect(markdownOnDisk()).toBe('# Plan\n\nEdited\n');
    expect(JSON.parse(volume.readFile(`${DIR}/meta.json`)).commentColors).toEqual({ a: 3 });
  });

  it('a comment color changed in meta.json during a save is kept by the silent meta retry', async () => {
    volume.silently(() => volume.writeFile(`${DIR}/meta.json`, JSON.stringify({ ...META, commentColors: { a: 1 } }, null, 2)));
    const session = mount();
    await session.ready;
    volume.silently(() => volume.writeFile(`${DIR}/meta.json`, JSON.stringify({ ...META, commentColors: { a: 3 } }, null, 2)));
    type(session, 'Edited\n');
    await settle(1_500);
    expect(markdownOnDisk()).toBe('# Plan\n\nEdited\n');
    expect(JSON.parse(volume.readFile(`${DIR}/meta.json`)).commentColors).toEqual({ a: 3 });
    expect(session.status).toBe('clean');
  });

  it('a removed note makes the editor read-only and keeps the edits as a draft', async () => {
    const session = mount();
    await session.ready;
    type(session, 'Unsaved\n');
    volume.unlink(`${DIR}/meta.json`);
    await settle(250);
    expect(session.status).toBe('removed');
    expect(surface.editable).toBe(false);
    expect(events.find((event) => event.kind === 'removed')).toMatchObject({ reason: 'notFound', hadUnsavedEdits: true });
    const flushed = await session.flush();
    expect(flushed).toMatchObject({ kind: 'removed' });
  });
});

describe('flush and unmount', () => {
  it('flush saves now and covers every edit present at the call', async () => {
    const session = mount();
    await session.ready;
    type(session, 'Flushed\n');
    const result = await session.flush();
    expect(result.kind).toBe('saved');
    expect(markdownOnDisk()).toBe('# Plan\n\nFlushed\n');
    await expect(session.flush()).resolves.toMatchObject({ kind: 'clean' });
  });

  it('unmount keeps the editor when the final flush fails, and tears down with discardUnsaved', async () => {
    const session = mount();
    await session.ready;
    volume.silently(() => volume.writeFile(`${DIR}/Plan.md`, '# Plan\n\nMoss\n'));
    type(session, 'bb\n');
    const kept = await session.unmount();
    expect(kept.kind).toBe('kept');
    expect(surface.editable).toBe(true);
    const gone = await session.unmount({ discardUnsaved: true });
    expect(gone.kind).toBe('unmounted');
    expect(session.status).toBe('unmounted');
    await expect(session.unmount()).resolves.toBe(gone);
  });

  it('an edit that lands while unmount waits for its final write is saved before teardown, and the editor is frozen meanwhile', async () => {
    const session = mount();
    await session.ready;
    type(session, 'Typed\n');
    const write = host.write.bind(host);
    let late = true;
    const frozenDuringWrite: boolean[] = [];
    host.write = async (noteId, request) => {
      frozenDuringWrite.push(surface.frozen);
      if (late) {
        late = false;
        // A comment reply moss's UI accepts while the write is pending.
        type(session, 'Typed\n\nReply\n');
      }
      return write(noteId, request);
    };
    const result = await session.unmount();
    expect(result.kind).toBe('unmounted');
    expect(markdownOnDisk()).toBe('# Plan\n\nTyped\n\nReply\n');
    if (result.kind === 'unmounted' && result.flush.kind === 'saved') expect(result.flush.receipt.files.markdown).toBe('# Plan\n\nTyped\n\nReply\n');
    else throw new Error(`expected a saved flush, got ${result.flush.kind}`);
    expect(frozenDuringWrite[0]).toBe(true);
  });

  it('a host reload whose read finishes after unmount leaves the torn-down session alone', async () => {
    const session = mount();
    await session.ready;
    const gate: { release?: () => void } = {};
    const read = host.read.bind(host);
    host.read = async (noteId) => {
      const result = await read(noteId);
      await new Promise<void>((resolve) => (gate.release = resolve));
      return result;
    };
    volume.silently(() => volume.writeFile(`${DIR}/Plan.md`, '# Plan\n\nChanged in Moss\n'));
    const reloading = session.reload();
    for (let i = 0; i < 20 && !gate.release; i += 1) await drain(5);
    expect(gate.release).toBeDefined();
    host.read = read;
    await expect(session.unmount()).resolves.toMatchObject({ kind: 'unmounted' });
    const loads = surface.loads.length;
    gate.release!();
    const result = await reloading;
    expect(result.kind).not.toBe('reloaded');
    expect(session.status).toBe('unmounted');
    expect(surface.loads).toHaveLength(loads);
    expect(kinds()).not.toContain('reloaded');
  });

  it('an unmount while the first load renders leaves nothing running', async () => {
    const gate: { release?: () => void } = {};
    const load = surface.load.bind(surface);
    surface.load = async (content, options) => {
      load(content, options);
      await new Promise<void>((resolve) => (gate.release = resolve));
    };
    const session = mount();
    for (let i = 0; i < 20 && !gate.release; i += 1) await drain(5);
    expect(gate.release).toBeDefined();
    await expect(session.unmount()).resolves.toMatchObject({ kind: 'unmounted' });
    gate.release!();
    await expect(session.ready).rejects.toMatchObject({ code: 'unmounted' });
    expect(session.status).toBe('unmounted');
    expect(surface.editable).toBe(false);
    volume.writeFile(`${DIR}/Plan.md`, '# Plan\n\nChanged in Moss\n');
    await settle(250);
    expect(surface.loads).toHaveLength(1);
  });
});

describe('reloads never take an edit typed meanwhile', () => {
  it('an edit typed while a host reload reads the disk refuses the reload and is saved', async () => {
    const session = mount();
    await session.ready;
    let reading = false;
    const gate: { release?: () => void } = {};
    const read = host.read.bind(host);
    host.read = async (noteId) => {
      reading = true;
      await new Promise<void>((resolve) => (gate.release = resolve));
      return read(noteId);
    };
    const reloading = session.reload();
    for (let i = 0; i < 50 && !gate.release; i += 1) await Promise.resolve();
    expect(reading).toBe(true);
    type(session, 'Typed meanwhile\n');
    gate.release!();
    host.read = read;
    await expect(reloading).resolves.toEqual({ kind: 'refused', reason: 'dirty' });
    expect(kinds()).not.toContain('reloaded');
    await settle(1_500);
    expect(markdownOnDisk()).toBe('# Plan\n\nTyped meanwhile\n');
  });

  it('a host reload whose read a local save superseded shows the saved version, not the older read', async () => {
    const session = mount();
    await session.ready;
    const gate: { release?: () => void } = {};
    const read = host.read.bind(host);
    host.read = async (noteId) => {
      host.read = read;
      const stale = await read(noteId);
      await new Promise<void>((resolve) => (gate.release = resolve));
      return stale;
    };
    const reloading = session.reload();
    for (let i = 0; i < 20 && !gate.release; i += 1) await drain(5);
    expect(gate.release).toBeDefined();
    type(session, 'Saved meanwhile\n');
    await expect(session.flush()).resolves.toMatchObject({ kind: 'saved' });
    gate.release!();
    await reloading;
    await settle(0);
    expect(markdownOnDisk()).toBe('# Plan\n\nSaved meanwhile\n');
    expect(surface.live.body).toBe('Saved meanwhile\n');
    expect(session.status).toBe('clean');
    type(session, 'Saved meanwhile, then more\n');
    await settle(1_500);
    expect(markdownOnDisk()).toBe('# Plan\n\nSaved meanwhile, then more\n');
    expect(kinds()).not.toContain('conflict');
  });

  it('the editor is not editable while a reload loads into it', async () => {
    const session = mount();
    await session.ready;
    const editableDuringLoad: boolean[] = [];
    const load = surface.load.bind(surface);
    surface.load = (content, options) => {
      editableDuringLoad.push(surface.editable);
      load(content, options);
    };
    volume.writeFile(`${DIR}/Plan.md`, '# Plan\n\nChanged in Moss\n');
    await settle(250);
    expect(kinds()).toContain('reloaded');
    expect(editableDuringLoad).toEqual([false]);
    expect(surface.editable).toBe(true);
  });

  it('an edit the surface has not committed yet (a focused title) turns an external change into a conflict', async () => {
    const session = mount();
    await session.ready;
    let pending = true;
    surface.commit = () => {
      if (!pending) return;
      pending = false;
      surface.live.title = 'Mine';
      session.markEdited();
    };
    volume.writeFile(`${DIR}/Plan.md`, '# Q3\n\nBody\n');
    await settle(250);
    expect(kinds()).not.toContain('reloaded');
    expect(session.status).toBe('conflict');
    expect(markdownOnDisk()).toBe('# Q3\n\nBody\n');
  });
});

/** Holds the CHART chunk until the returned release is called. */
function holdChunk(): () => void {
  let release: () => void = () => undefined;
  surface.chunk = new Promise<void>((resolve) => (release = resolve));
  return () => {
    surface.chunk = null;
    release();
  };
}

describe('a load waiting for its views changes nothing until it applies, and only the newest applies', () => {
  it('an older reload whose chunk arrives after a newer reload never wins, and edits to the newer one are saved', async () => {
    const session = mount();
    await session.ready;
    const release = holdChunk();
    volume.writeFile(`${DIR}/Plan.md`, '# Plan\n\nVersion A CHART\n');
    await settle(250);
    expect(surface.live.body, 'nothing is shown before its views are in').toBe('Body\n');
    volume.writeFile(`${DIR}/Plan.md`, '# Plan\n\nVersion B\n');
    await settle(250);
    expect(surface.live.body).toBe('Version B\n');
    expect(surface.editable).toBe(true);
    type(session, 'Version B typed\n');
    expect(session.status).toBe('dirty');
    release();
    await settle(0);
    expect(surface.live.body, 'the older version never replaces the newer one').toBe('Version B typed\n');
    expect(kinds().filter((kind) => kind === 'reloaded')).toHaveLength(1);
    await settle(1_500);
    expect(markdownOnDisk()).toBe('# Plan\n\nVersion B typed\n');
    expect(session.status).toBe('clean');
    expect(kinds()).not.toContain('conflict');
  });

  it('an edit made while a reload waits for its chunk stays in the document, and the reload becomes a conflict', async () => {
    const session = mount();
    await session.ready;
    const release = holdChunk();
    volume.writeFile(`${DIR}/Plan.md`, '# Plan\n\nRemote CHART\n');
    await settle(250);
    // A comment reply in moss's portalled popover, say: an edit to the document still on screen.
    type(session, 'Reply meanwhile\n');
    expect(session.status).toBe('dirty');
    release();
    await settle(0);
    expect(surface.live.body).toBe('Reply meanwhile\n');
    expect(session.status).toBe('conflict');
    expect(kinds()).not.toContain('reloaded');
    await settle(5_000);
    expect(markdownOnDisk()).toBe('# Plan\n\nRemote CHART\n');
    const flushed = await session.flush();
    expect(flushed).toMatchObject({ kind: 'conflict' });
    if (flushed.kind === 'conflict') expect(flushed.draft.files.markdown).toBe('# Plan\n\nReply meanwhile\n');
  });

  it('a save during a slow chunk is refused rather than writing the old body over the newer version', async () => {
    const session = mount();
    await session.ready;
    const release = holdChunk();
    volume.writeFile(`${DIR}/Plan.md`, '# Plan\n\nRemote CHART\n');
    await settle(250);
    type(session, 'Reply meanwhile\n');
    await settle(3_000);
    expect(markdownOnDisk()).toBe('# Plan\n\nRemote CHART\n');
    expect(session.status).toBe('conflict');
    release();
    await settle(0);
    expect(surface.live.body).toBe('Reply meanwhile\n');
    expect(session.status).toBe('conflict');
    expect(kinds()).not.toContain('reloaded');
    expect(markdownOnDisk()).toBe('# Plan\n\nRemote CHART\n');
  });

  it('a first mount shows the note only once its views are in', async () => {
    volume.writeFile(`${DIR}/Plan.md`, '# Plan\n\nHas a CHART\n');
    const release = holdChunk();
    const session = mount();
    await settle(0);
    expect(session.status).toBe('loading');
    expect(surface.loads).toHaveLength(0);
    release();
    await session.ready;
    expect(surface.loaded?.body).toBe('Has a CHART\n');
    expect(session.status).toBe('clean');
  });

  it('unmounting while the first mount waits for its chunk rejects ready with unmounted at once', async () => {
    volume.writeFile(`${DIR}/Plan.md`, '# Plan\n\nHas a CHART\n');
    const release = holdChunk();
    const session = mount();
    await settle(0);
    expect(session.status).toBe('loading');
    await expect(session.unmount()).resolves.toMatchObject({ kind: 'unmounted' });
    await expect(session.ready).rejects.toMatchObject({ code: 'unmounted' });
    release();
    await settle(0);
    expect(surface.loads).toHaveLength(0);
    expect(session.status).toBe('unmounted');
  });

  it('unmounting while a reload waits for its chunk applies nothing', async () => {
    const session = mount();
    await session.ready;
    const release = holdChunk();
    volume.writeFile(`${DIR}/Plan.md`, '# Plan\n\nRemote CHART\n');
    await settle(250);
    await expect(session.unmount()).resolves.toMatchObject({ kind: 'unmounted', flush: { kind: 'clean' } });
    release();
    await settle(0);
    expect(surface.loads).toHaveLength(1);
    expect(kinds()).not.toContain('reloaded');
  });
});

describe('pending drafts and late input during a chunk wait are never dropped', () => {
  /** A focused title the user types into: reported only when the surface commits it (blur, Enter, Tab, commit()). */
  function typeTitle(session: EditorSession, title: string) {
    surface.commit = () => {
      if (surface.live.title === title) return;
      surface.live.title = title;
      session.markEdited();
    };
  }

  it('a title typed while an external reload waits for its chunk is committed, and the reload becomes a conflict', async () => {
    const session = mount();
    await session.ready;
    const release = holdChunk();
    volume.writeFile(`${DIR}/Plan.md`, '# Plan\n\nRemote CHART\n');
    await settle(250);
    typeTitle(session, 'Plan renamed');
    release();
    await settle(0);
    expect(kinds()).not.toContain('reloaded');
    expect(surface.live.title).toBe('Plan renamed');
    expect(session.status).toBe('conflict');
    const flushed = await session.flush();
    if (flushed.kind !== 'conflict') throw new Error(`expected a conflict, got ${flushed.kind}`);
    expect(flushed.draft.files.markdown).toBe('# Plan renamed\n\nBody\n');
  });

  it('a title typed while a host reload waits for its chunk refuses the reload', async () => {
    const session = mount();
    await session.ready;
    const release = holdChunk();
    volume.silently(() => volume.writeFile(`${DIR}/Plan.md`, '# Plan\n\nRemote CHART\n'));
    const reloading = session.reload();
    await settle(50);
    typeTitle(session, 'Plan renamed');
    release();
    await expect(reloading).resolves.toEqual({ kind: 'refused', reason: 'dirty' });
    expect(kinds()).not.toContain('reloaded');
    expect(surface.live.title).toBe('Plan renamed');
    expect(session.status).toBe('dirty');
  });

  it('a host reload overtaken while it waits for its chunk reports the version on screen, not its own', async () => {
    const session = mount();
    await session.ready;
    const release = holdChunk();
    volume.silently(() => volume.writeFile(`${DIR}/Plan.md`, '# Plan\n\nVersion A CHART\n'));
    const older = session.reload();
    await settle(50);
    volume.silently(() => volume.writeFile(`${DIR}/Plan.md`, '# Plan\n\nVersion B\n'));
    const newer = await session.reload();
    if (newer.kind !== 'reloaded') throw new Error(`expected reloaded, got ${newer.kind}`);
    release();
    const result = await older;
    expect(result).toEqual({ kind: 'reloaded', version: newer.version });
    expect(surface.live.body).toBe('Version B\n');
  });

  it('text typed after pressing Reload in the conflict bar, while the chunk loads, keeps the conflict instead of vanishing', async () => {
    const session = mount();
    await session.ready;
    type(session, 'Local edit\n');
    volume.writeFile(`${DIR}/Plan.md`, '# Plan\n\nRemote CHART\n');
    await settle(250);
    expect(session.status).toBe('conflict');
    const release = holdChunk();
    const resolving = session.resolveConflict('reload');
    await settle(50);
    type(session, 'Local edit late\n');
    release();
    await resolving;
    expect(surface.live.body).toBe('Local edit late\n');
    expect(session.status).toBe('conflict');
    expect(kinds()).not.toContain('reloaded');
    expect(kinds()).not.toContain('conflictResolved');
  });
});

describe('the fixture host', () => {
  it('a raced write rolls back only files that still hold its own bytes', async () => {
    const session = mount();
    await session.ready;
    host.onApply = (file) => {
      if (file !== 'meta') return;
      host.onApply = null;
      volume.silently(() => {
        volume.writeFile(`${DIR}/Plan.md`, '# Plan\n\nMoss meanwhile\n');
        volume.writeFile(`${DIR}/meta.json`, JSON.stringify({ ...META, updatedAt: 1_780_000_200 }, null, 2));
      });
    };
    type(session, 'bb\n');
    await settle(1_500);
    expect(markdownOnDisk()).toBe('# Plan\n\nMoss meanwhile\n');
    expect(session.status).toBe('conflict');
  });
});

describe('the fixture host, step 6', () => {
  it('a file another writer replaces after its own op is caught by the final re-read', async () => {
    const session = mount();
    await session.ready;
    host.onApply = (file) => {
      if (file !== 'meta') return;
      host.onApply = null;
      volume.silently(() => volume.writeFile(`${DIR}/Plan.md`, '# Plan\n\nMoss after bb\n'));
    };
    type(session, 'bb\n');
    await settle(1_500);
    expect(markdownOnDisk()).toBe('# Plan\n\nMoss after bb\n');
    const write = events.find((event) => event.kind === 'saved');
    expect(write, 'no saved event for a write another writer replaced').toBeUndefined();
    expect(session.status).toBe('conflict');
  });
});

describe('drafts and receipts', () => {
  it('restoring a receipt that is already on disk opens clean; a stale draft opens in conflict', async () => {
    const first = mount();
    await first.ready;
    type(first, 'Saved\n');
    const saved = await first.flush();
    if (saved.kind !== 'saved') throw new Error('expected saved');
    await first.unmount();

    events = [];
    const clean = mount({ restoreDraft: saved.receipt });
    await clean.ready;
    expect(clean.status).toBe('clean');
    await clean.unmount();

    volume.writeFile(`${DIR}/Plan.md`, '# Plan\n\nMoss moved on\n');
    events = [];
    const stale = mount({ restoreDraft: { ...saved.receipt, files: { ...saved.receipt.files, markdown: '# Plan\n\nMine\n' } } });
    await stale.ready;
    expect(stale.status).toBe('conflict');
    expect(surface.loaded?.body).toBe('Mine\n');
    expect(events.find((event) => event.kind === 'conflict')).toMatchObject({ cause: 'external' });
  });

  it("restoring a receipt whose files are already on disk writes the receipt's comment colors", async () => {
    volume.silently(() => volume.writeFile(`${DIR}/meta.json`, JSON.stringify({ ...META, commentColors: { a: 1 } }, null, 2)));
    const first = mount();
    await first.ready;
    type(first, 'Saved\n');
    const saved = await first.flush();
    if (saved.kind !== 'saved') throw new Error('expected saved');
    await first.unmount();

    const receipt = { ...saved.receipt, intents: { ...saved.receipt.intents, commentColors: { a: 4 } } };
    const restored = mount({ restoreDraft: receipt });
    await restored.ready;
    await expect(restored.flush()).resolves.toMatchObject({ kind: 'saved' });
    expect(JSON.parse(volume.readFile(`${DIR}/meta.json`)).commentColors).toEqual({ a: 4 });
  });

  it('a draft on the same base opens dirty and saves', async () => {
    const first = mount();
    await first.ready;
    type(first, 'Draft body\n');
    // The host keeps the draft, as after a frame that closed before its save; the first editor never saves.
    const draft = first.draft();
    expect(markdownOnDisk()).toBe('# Plan\n\nBody\n');
    const second = mount({ restoreDraft: draft });
    await second.ready;
    expect(second.status).toBe('dirty');
    await second.flush();
    expect(markdownOnDisk()).toBe('# Plan\n\nDraft body\n');
  });

  it('a stale draft restored in conflict is exported on its own base, so restoring the export opens in conflict again', async () => {
    const first = mount();
    await first.ready;
    type(first, 'Mine\n');
    const draft = first.draft();
    await first.unmount({ discardUnsaved: true });
    volume.writeFile(`${DIR}/Plan.md`, '# Plan\n\nMoss moved on\n');

    const second = mount({ restoreDraft: draft });
    await second.ready;
    expect(second.status).toBe('conflict');
    // Keep editing stays in conflict and keeps the base the edits were made on.
    await second.resolveConflict('keep');
    type(second, 'Mine and more\n');
    const flushed = await second.flush();
    if (flushed.kind !== 'conflict') throw new Error(`expected conflict, got ${flushed.kind}`);
    expect(flushed.draft.baseVersion).toBe(draft.baseVersion);
    expect(flushed.draft.companions).toEqual(draft.companions);
    const kept = await second.unmount();
    if (kept.kind !== 'kept' || kept.flush.kind !== 'conflict') throw new Error('expected a kept conflict');
    expect(kept.flush.draft.baseVersion).toBe(draft.baseVersion);
    const exported = kept.flush.draft;
    await second.unmount({ discardUnsaved: true });

    events = [];
    const third = mount({ restoreDraft: exported });
    await third.ready;
    expect(third.status).toBe('conflict');
    await settle(5_000);
    expect(markdownOnDisk()).toBe('# Plan\n\nMoss moved on\n');
    expect(kinds()).not.toContain('saved');

    // Overwrite is the explicit choice: it saves on top, and the next export is on the new version.
    await third.resolveConflict('overwrite');
    await settle(0);
    expect(markdownOnDisk()).toBe('# Plan\n\nMine and more\n');
    expect(third.status).toBe('clean');
  });

  it('a Reload whose read fails keeps a restored draft in conflict: no retry or flush writes it over the newer disk', async () => {
    const first = mount();
    await first.ready;
    type(first, 'Mine\n');
    const draft = first.draft();
    await first.unmount({ discardUnsaved: true });
    volume.writeFile(`${DIR}/Plan.md`, '# Plan\n\nMoss moved on\n');

    events = [];
    const second = mount({ restoreDraft: draft });
    await second.ready;
    expect(second.status).toBe('conflict');
    const read = host.read.bind(host);
    let broken = true;
    host.read = async (noteId) => {
      if (broken) throw new Error('the disk is busy');
      return read(noteId);
    };
    await second.resolveConflict('reload');
    expect(second.status).toBe('conflict');
    broken = false;
    await settle(TIMING.errorRetryMs + 1_000);
    const flushed = await second.flush();
    expect(flushed.kind).toBe('conflict');
    if (flushed.kind === 'conflict') expect(flushed.draft.baseVersion).toBe(draft.baseVersion);
    expect(markdownOnDisk()).toBe('# Plan\n\nMoss moved on\n');
    expect(kinds()).not.toContain('saved');
  });

  it('Reload resolves a restored draft conflict: the editor then drafts on the disk version', async () => {
    const first = mount();
    await first.ready;
    type(first, 'Mine\n');
    const draft = first.draft();
    await first.unmount({ discardUnsaved: true });
    volume.writeFile(`${DIR}/Plan.md`, '# Plan\n\nMoss moved on\n');

    const second = mount({ restoreDraft: draft });
    await second.ready;
    await second.resolveConflict('reload');
    expect(second.status).toBe('clean');
    expect(second.draft().baseVersion).not.toBe(draft.baseVersion);
    type(second, 'After reload\n');
    await second.flush();
    expect(markdownOnDisk()).toBe('# Plan\n\nAfter reload\n');
  });
});

describe('assets', () => {
  it('a pasted image is stored only through the host, under the name desktop would give it', async () => {
    const session = mount();
    await session.ready;
    const stored = await session.putAsset({ data: new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' }), filename: 'Screen Shot.png', mimeType: 'image/png', purpose: 'body' });
    expect(stored.relativePath).toMatch(/^assets\/Screen Shot-\d+-[0-9a-f]{8}\.png$/);
    const name = stored.relativePath.slice('assets/'.length);
    expect(isMossAssetName(name)).toBe(true);
    expect(volume.isFile(`${DIR}/${stored.relativePath}`)).toBe(true);
    expect(host.calls.filter((call) => call.op === 'assetPut')).toEqual([
      { op: 'assetPut', noteId: ID, name, mimeType: 'image/png', purpose: 'body' },
    ]);
  });

  it('an unknown image type is stored as .png, and a name collision is retried once with a new name', async () => {
    const session = mount();
    await session.ready;
    let first = true;
    const put = host.assets.put;
    host.assets.put = async (noteId, asset) => {
      if (first) {
        first = false;
        return { kind: 'exists' };
      }
      return put(noteId, asset);
    };
    const stored = await session.putAsset({ data: new Blob(['x']), filename: '../evil..name.tiff', mimeType: 'image/tiff', purpose: 'comment' });
    expect(stored.relativePath).toMatch(/^assets\/image-\d+-[0-9a-f]{8}\.png$/);
  });
});

describe('confinement (security review of the contract)', () => {
  it('the editor only ever asks for companion paths inside the note folder', () => {
    for (const path of ['../Other/meta.json', '/etc/passwd', 'assets/../../x', 'a\0b', '', '..']) expect(isNoteRelativeCompanionPath(path), path).toBe(false);
    expect(isNoteRelativeCompanionPath('assets/landing-mockup.html')).toBe(true);
  });

  it('the fixture host reads and serves nothing outside the note folder, and refuses an unsafe asset name', async () => {
    seedNote(volume, ['Notes', 'Projects', 'Other'], {
      markdown: '# Other\n',
      meta: { ...META, id: '7a6b5c4d-3e2f-4a1b-8c9d-0e1f2a3b4c5d', title: 'Other' },
      assets: { 'secret.png': 'png' },
    });
    for (const path of ['../Other/assets/secret.png', '~/secret', '/Moss/Notes/Projects/Other/assets/secret.png']) {
      await expect(host.readCompanion(ID, path)).resolves.toMatchObject({ kind: 'absent' });
      expect(host.assets.url(ID, path, 'image')).toBeNull();
    }
    await expect(host.assets.put(ID, { name: '../escape.png', data: new Blob(['x']), mimeType: 'image/png', purpose: 'body' })).resolves.toEqual({ kind: 'refused', reason: 'name' });
  });
});
