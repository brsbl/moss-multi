// The viewer's pure parts: the moss interchange read (title from the leading H1, frontmatter, layout.json), media
// routing by note id, and the electronAPI stand-in (reads reach the owning viewer; everything else is inert).
import { afterEach, describe, expect, it } from 'vitest';
import { createViewerElectronApi } from './electron-api.ts';
import { readLayout, readMossNote } from './moss-file.ts';
import { NO_MEDIA, registerViewer, viewerAssetUrl } from './registry.ts';

describe('readMossNote', () => {
  it('takes the title from the leading H1 and leaves the body without it', () => {
    const note = readMossNote({ markdown: '---\nstatus: draft\n---\n# Seed [[Library]] Notes\n\nBody text.\n\n# A later H1\n' });
    expect(note.title).toBe('Seed Library Notes');
    expect(note.frontmatter).toEqual({ status: 'draft' });
    expect(note.body).toBe('Body text.\n\n# A later H1\n');
    expect(note.state).toBeUndefined();
  });

  it('falls back to the given title when the file has no H1', () => {
    expect(readMossNote({ markdown: 'Just a body.\n', title: 'From the filename' }).title).toBe('From the filename');
  });

  it('takes a serialized state with its title and raw frontmatter', () => {
    const state = { root: { children: [], type: 'root', version: 1 } };
    const note = readMossNote({ state: JSON.stringify(state), title: 'Stateful', frontmatter: 'tags:\n  - a\n' });
    expect(note).toMatchObject({ title: 'Stateful', frontmatter: { tags: ['a'] }, body: '', state });
    expect(() => readMossNote({ state: { nope: true } })).toThrow(/serialized Lexical editor state/);
    expect(() => readMossNote({})).toThrow(/markdown or state/);
  });
});

describe('readLayout', () => {
  it("keeps moss's version 1 shape and drops what is not a positive width", () => {
    expect(readLayout({ version: 1, tableCount: 2, tables: [{ columnWidths: [260, -1, 'x', 120] }, null] })).toEqual({
      version: 1,
      tableCount: 2,
      tables: [{ columnWidths: [260, 120] }, {}],
    });
    expect(readLayout({ version: 1, tableCount: 0, tables: [], tabGroupCount: 1, tabGroups: [{ tabWidths: [90, 'x'] }] })).toMatchObject({
      tabGroupCount: 1,
      tabGroups: [{ tabWidths: [90, null] }],
    });
  });

  it('ignores anything else', () => {
    for (const value of [null, [], 'layout', { version: 2, tableCount: 0, tables: [] }, { version: 1, tableCount: 1.5, tables: [] }, { version: 1, tableCount: 1 }]) {
      expect(readLayout(value)).toBeUndefined();
    }
  });
});

describe('media and the electronAPI stand-in', () => {
  const stops: (() => void)[] = [];
  afterEach(() => stops.splice(0).forEach((stop) => stop()));

  it("resolves a viewer's media only through its own assetUrl, by note id", () => {
    const asked: string[] = [];
    const assetUrl = (ref: string, kind: string) => {
      asked.push(`${kind}:${ref}`);
      return ref.endsWith('.png') ? `/a/${ref}` : null;
    };
    stops.push(registerViewer('moss-viewer-a', { notes: [], services: { assetUrl } }));
    stops.push(registerViewer('moss-viewer-b', { notes: [], services: {} }));
    expect(viewerAssetUrl('assets/x.png', 'moss-viewer-a')).toBe('/a/assets/x.png');
    expect(viewerAssetUrl('assets/clip.webm', 'moss-viewer-a')).toBe(NO_MEDIA);
    expect(viewerAssetUrl('assets/x.png', 'moss-viewer-b')).toBe(NO_MEDIA);
    expect(viewerAssetUrl('assets/x.png', 'some-other-note')).toBeUndefined();
    expect(asked).toEqual(['image:assets/x.png', 'video:assets/clip.webm']);
  });

  it('answers embed previews from the owning viewer and leaves every other call inert', async () => {
    stops.push(registerViewer('moss-viewer-c', { notes: [{ id: 'n1', title: 'One', headings: ['Intro'] }], services: { unfurl: async () => ({ title: 'A post', height: 240 }) } }));
    const api = createViewerElectronApi() as Record<string, Record<string, (...args: unknown[]) => unknown>>;
    const preview = (await api.webEmbedPreview.ensure({ noteId: 'moss-viewer-c', url: 'https://x.com/a/status/1' })) as { status: string; metadata: object };
    expect(preview).toMatchObject({ kind: 'web-embed-preview', status: 'resolved', metadata: { title: 'A post', height: 240 } });
    expect(await api.webEmbedPreview.ensure({ noteId: 'unknown', url: 'https://x.com/a/status/1' })).toBeNull();
    expect(await api.notes.getHeadings('n1')).toEqual(['Intro']);
    expect(await api.notes.update('n1', { content: 'x' })).toBeUndefined();
    expect(await api.images.save('x')).toBeUndefined();
    const unsubscribe = api.htmlPreview.onMaterialized(() => undefined);
    expect(typeof unsubscribe).toBe('function');
  });
});
