// mountMossViewer: moss's own MarkdownEditor, read-only and unbound, on the canvas moss paints a note on. Each
// viewer has its own Jotai store (as moss's PdfExportApp does) and a unique note id that routes moss's media and
// preview calls to its services; links leave through services.navigate.
import { StrictMode, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { Provider, createStore } from 'jotai';
import { MarkdownEditor } from '@moss-desktop/renderer/editor/MarkdownEditor';
import { CanvasArea } from '@moss/shared/components/layout/CanvasArea';
import { noteEntityAtom, noteIdsAtom } from '@moss/shared/state/note-atoms';
import { browserSplitTargetAtom, mapNoteMetadataToNoteEntity, splitTabNoteIdAtom, webEmbedLightboxTargetAtom } from '@moss/shared/state/atoms';
import { installViewerElectronApi } from './electron-api.ts';
import { readMossNote, type MossNoteContent } from './moss-file.ts';
import { markActive, registerViewer, type ViewerRecord } from './registry.ts';
import type { MossViewerHandle, MossViewerNote, MossViewerOptions, MossViewerServices, MossViewerTheme } from './types.ts';

type Store = ReturnType<typeof createStore>;

let sequence = 0;
const noop = () => undefined;

function setNotes(store: Store, own: MossViewerNote, notes: readonly MossViewerNote[]): void {
  const all = [own, ...notes.filter((note) => note.id !== own.id)];
  for (const note of all) {
    store.set(
      noteEntityAtom(note.id),
      mapNoteMetadataToNoteEntity({
        id: note.id,
        title: note.title,
        createdAt: note.updatedAt ?? 0,
        updatedAt: note.updatedAt ?? 0,
        folderPath: note.folderPath ?? 'Notes',
      }),
    );
  }
  store.set(noteIdsAtom, new Set(all.map((note) => note.id)));
}

/** Moss opens web links in its browser split or lightbox, and notes in a split; a viewer hands each to its host. */
function routeNavigation(store: Store, viewerNoteId: string, ownNoteId: string | undefined, services: MossViewerServices): () => void {
  const toUrl = (target: typeof browserSplitTargetAtom | typeof webEmbedLightboxTargetAtom) =>
    store.sub(target, () => {
      const request = store.get(target);
      if (!request) return;
      store.set(target, null);
      services.navigate?.({ kind: 'url', url: request.url, title: request.title });
    });
  const stops = [
    toUrl(browserSplitTargetAtom),
    toUrl(webEmbedLightboxTargetAtom),
    store.sub(splitTabNoteIdAtom, () => {
      const noteId = store.get(splitTabNoteIdAtom);
      if (!noteId) return;
      store.set(splitTabNoteIdAtom, null);
      const target = noteId === viewerNoteId ? ownNoteId : noteId;
      if (target) services.navigate?.({ kind: 'note', noteId: target, heading: null });
    }),
  ];
  return () => stops.forEach((stop) => stop());
}

function MossViewer({ noteId, note, onReady, onNavigateToNote }: {
  noteId: string;
  note: MossNoteContent;
  onReady: () => void;
  onNavigateToNote: (noteId: string, heading?: string | null) => void;
}): ReactNode {
  return (
    <div className="relative flex h-full min-w-0 flex-1 flex-col bg-surface-canvas" data-moss-viewer-root="">
      <CanvasArea className="relative min-w-0 flex-1" responsiveLayout innerClassName="flex w-full flex-col gap-1" contentClassName="mx-auto max-w-canvas-blocks">
        <div className="relative">
          {note.title ? (
            <div className="relative mx-auto w-full max-w-canvas-prose">
              <h1 data-moss-viewer-title="" className="mb-1 min-h-12 w-full text-left text-h1 font-semibold tracking-title text-ink-default">
                {note.title}
              </h1>
            </div>
          ) : null}
          <MarkdownEditor
            noteId={noteId}
            value={note.body}
            layoutMetadata={note.layout}
            {...(note.state ? { initialSerializedState: note.state } : {})}
            onChange={noop}
            readOnly
            placeholder=""
            enableSearchPlugin={false}
            onReady={onReady}
            onNavigateToNote={onNavigateToNote}
          />
        </div>
      </CanvasArea>
    </div>
  );
}

export function mountMossViewer(el: HTMLElement, options: MossViewerOptions): MossViewerHandle {
  const note = readMossNote(options);
  installViewerElectronApi();
  const noteId = `moss-viewer-${(sequence += 1)}`;
  const services = options.services ?? {};
  const record: ViewerRecord = { services, notes: [] };
  const unregister = registerViewer(noteId, record);
  const store = createStore();
  const own: MossViewerNote = { id: noteId, title: note.title };
  let mounted = true;

  setNotes(store, own, []);
  void Promise.resolve(services.notes?.() ?? [])
    .then((notes) => {
      if (!mounted) return;
      record.notes = notes;
      setNotes(store, own, notes);
    })
    .catch((error: unknown) => console.warn('[moss-viewer] services.notes failed:', error));
  const stopNavigation = routeNavigation(store, noteId, options.noteId, services);

  const host = document.createElement('div');
  host.className = 'h-full';
  host.dataset.mossViewer = '';
  host.dataset.theme = options.theme ?? 'light';
  const activate = () => markActive(noteId);
  host.addEventListener('pointerdown', activate, true);
  el.append(host);

  let settle: (value: void) => void = noop;
  const ready = new Promise<void>((resolve) => {
    settle = resolve;
  });
  const onReady = () => {
    host.dataset.mossViewerState = 'ready';
    settle();
  };
  const onNavigateToNote = (target: string, heading?: string | null) => {
    // A heading in this note: moss has already scrolled to it.
    if (target === noteId) return;
    services.navigate?.({ kind: 'note', noteId: target, heading: heading ?? null });
  };

  const root = createRoot(host);
  root.render(
    <StrictMode>
      <Provider store={store}>
        <MossViewer noteId={noteId} note={note} onReady={onReady} onNavigateToNote={onNavigateToNote} />
      </Provider>
    </StrictMode>,
  );

  return {
    title: note.title,
    frontmatter: note.frontmatter,
    ready,
    setTheme(theme: MossViewerTheme) {
      host.dataset.theme = theme;
    },
    unmount() {
      if (!mounted) return;
      mounted = false;
      root.unmount();
      host.removeEventListener('pointerdown', activate, true);
      host.remove();
      stopNavigation();
      unregister();
    },
  };
}
