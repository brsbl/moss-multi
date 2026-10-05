// The editor's save loop against the fixture host (an in-memory Moss workspace), with a stand-in for moss's
// editor surface: autosave timing, refused stale writes, external changes into a clean or a dirty editor, the
// silent meta retry, flush and unmount, drafts and receipts, and assets that only ever go through the host.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MossEditorEvent } from './contract';
import { MemoryHost, MemoryVolume, seedNote } from './testing/memory-host.js';
import { isMossAssetName } from './host/moss-editor-host.js';
import { assembleContent, type EditorContent, type RendererSnapshot } from './desktop/pipeline';
import { isNoteRelativeCompanionPath } from './desktop/note-store.port';
import { EditorSession, type SessionSurface } from './session';

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

  load(content: EditorContent, options: { keepView: boolean }) {
    this.loaded = content;
    this.loads.push(options);
    this.live = { title: content.title, body: content.body, comments: content.commentMetadata };
  }

  snapshot(): RendererSnapshot {
    if (!this.loaded) throw new Error('nothing loaded');
    return {
      content: assembleContent(this.loaded, { title: this.live.title, body: this.live.body }),
      commentMetadata: this.live.comments,
      layoutMetadata: { version: 1, tableCount: 0, tables: [] },
      intents: { frontmatterMetaUpdates: {}, commentColors: {} },
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

/** Lets I/O (crypto.subtle in the host's version tokens) complete, one loop turn at a time. */
async function drain() {
  for (let i = 0; i < 10; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
    await vi.advanceTimersByTimeAsync(0);
  }
}

/** Advances the fake clock by `ms` in small steps, letting I/O finish between them. */
async function settle(ms = 0) {
  const end = Date.now() + ms;
  await drain();
  while (Date.now() < end) {
    await vi.advanceTimersByTimeAsync(Math.min(25, end - Date.now()));
    await drain();
  }
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

  it('a bridge of another API version rejects ready with apiMismatch', async () => {
    const session = mount({ bridge: Object.assign(Object.create(host), { api: 2 }) });
    await expect(session.ready).rejects.toMatchObject({ code: 'apiMismatch' });
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
    expect(meta.updatedAt).toBe(Math.floor(Date.now() / 1000));
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

  it('the fixture host reads and serves nothing outside the note folder, and copies only from notes the user opened', async () => {
    seedNote(volume, ['Notes', 'Projects', 'Other'], {
      markdown: '# Other\n',
      meta: { ...META, id: '7a6b5c4d-3e2f-4a1b-8c9d-0e1f2a3b4c5d', title: 'Other' },
      assets: { 'secret.png': 'png' },
    });
    for (const path of ['../Other/assets/secret.png', '~/secret', '/Moss/Notes/Projects/Other/assets/secret.png']) {
      await expect(host.readCompanion(ID, path)).resolves.toMatchObject({ kind: 'absent' });
      expect(host.assets.url(ID, path, 'image')).toBeNull();
    }
    host.opened = new Set([ID]);
    await expect(host.assets.copyFromNote(ID, { sourceNoteId: '7a6b5c4d-3e2f-4a1b-8c9d-0e1f2a3b4c5d', sourceRef: 'assets/secret.png', name: 'copy-1-abcdef12.png' })).resolves.toEqual({ kind: 'notFound' });
    await expect(host.assets.put(ID, { name: '../escape.png', data: new Blob(['x']), mimeType: 'image/png', purpose: 'body' })).resolves.toEqual({ kind: 'refused', reason: 'name' });
  });
});
