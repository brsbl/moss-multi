// window.electronAPI for a page that hosts editors. Moss's renderer calls it; here media goes to the editor that
// owns the note (and from there only through its bridge), embed previews to its services, and everything else is
// inert: it resolves with nothing and opens no network, socket or storage path. Note IO is the session's, not moss's
// `notes.update`, so a stray metadata write (collapsed headings) changes nothing.
import { createWebEmbedPreviewResult, getWebEmbedPreviewDescriptor } from '@moss-desktop/common/web-embed-preview';
import { activeEditor, editorFor } from './registry';
import type { MossEditorUnfurl } from './contract';

type AnyFunction = (...args: never[]) => unknown;
type Namespace = Record<string, AnyFunction>;

const noop = () => undefined;
const inert = async () => undefined;
const unsubscriber = () => noop;

const fallbackFor = (method: string): AnyFunction => (/^(on[A-Z]|subscribe)/.test(method) ? unsubscriber : inert);

function inertNamespace(own: Namespace = {}): Namespace {
  return new Proxy(own, { get: (target, method) => (typeof method === 'string' ? (target[method] ?? fallbackFor(method)) : undefined) });
}

function previewFor(url: string, unfurl: MossEditorUnfurl | null) {
  const descriptor = getWebEmbedPreviewDescriptor(url);
  if (!descriptor || !unfurl) return null;
  const metadata: Record<string, string | number> = {};
  for (const key of ['title', 'description', 'providerName', 'authorName'] as const) {
    const value = unfurl[key];
    if (typeof value === 'string' && value.trim()) metadata[key] = value;
  }
  if (typeof unfurl.height === 'number' && unfurl.height > 0) metadata.height = unfurl.height;
  if (unfurl.siteIcon) metadata.siteIconAssetRelativePath = unfurl.siteIcon;
  return createWebEmbedPreviewResult({
    descriptor,
    status: unfurl.status === 'unavailable' ? 'failed' : 'resolved',
    assetRelativePath: unfurl.image,
    metadata,
  });
}

const MEDIA_ACCEPT = '.png,.jpg,.jpeg,.gif,.webp,.svg,.mp4,.webm,.mov';

/** The browser's chooser: a detached `<input type=file multiple>`, clicked inside the user's gesture. */
function chooseFiles(): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = MEDIA_ACCEPT;
    input.multiple = true;
    input.hidden = true;
    const done = (files: File[]) => {
      input.remove();
      resolve(files);
    };
    input.addEventListener('change', () => done([...(input.files ?? [])]), { once: true });
    input.addEventListener('cancel', () => done([]), { once: true });
    document.body.appendChild(input);
    input.click();
  });
}

function decodeBase64(data: string): Uint8Array<ArrayBuffer> {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function owner(noteId: string | undefined) {
  const record = editorFor(noteId) ?? (noteId ? undefined : activeEditor());
  if (!record) throw new Error('Open a note before adding media.');
  return record;
}

export function createEditorElectronApi(): Record<string, Namespace> {
  const namespaces: Record<string, Namespace> = {
    images: inertNamespace({
      save: async (input: { data: string; filename?: string; mimeType: string; noteId?: string }) =>
        owner(input.noteId).session.putAsset({
          data: new Blob([decodeBase64(input.data)], { type: input.mimeType }),
          filename: input.filename,
          mimeType: input.mimeType,
          purpose: 'body',
        }),
      pick: async (input: { noteId?: string } = {}) => {
        const record = owner(input.noteId);
        const results = [];
        for (const file of await chooseFiles()) {
          try {
            results.push(await record.session.putAsset({ data: file, filename: file.name, mimeType: file.type || 'image/png', purpose: 'body' }));
          } catch {
            // announced through the session's error event; the other files still land
          }
        }
        return results;
      },
      copyFromNoteAsset: async (input: { sourceNoteId: string; sourceRelativePath: string; destinationNoteId: string; filename?: string }) => {
        const ref = input.sourceRelativePath.replace(/^\.?\//, '');
        if (!ref.startsWith('assets/')) throw new Error('Only a note asset can be copied.');
        const filename = input.filename?.trim() || ref.slice(ref.lastIndexOf('/') + 1);
        return owner(input.destinationNoteId).session.copyAsset(input.sourceNoteId, ref as `assets/${string}`, filename);
      },
      // The frame has no network and no file system: a remote image stays a remote reference, as moss keeps it on
      // failure; a desktop path cannot be read.
      persistUrl: async () => {
        throw new Error('Remote images stay remote references in an embedded editor.');
      },
      copyFromPath: async () => {
        throw new Error('A file path cannot be read from an embedded editor.');
      },
    }),
    notes: inertNamespace({
      getHeadings: async (noteId: string) => {
        for (const record of [editorFor(noteId), activeEditor()]) {
          const notes = record ? await Promise.resolve(record.services.notes?.() ?? []) : [];
          const note = notes.find((entry) => entry.id === noteId);
          if (note) return [...(note.headings ?? [])];
        }
        return [];
      },
      getAll: async () => [],
      getMetadataByIds: async () => [],
      search: async () => [],
    }),
    webEmbedPreview: inertNamespace({
      ensure: async ({ noteId, url }: { noteId: string; url: string }) => {
        const unfurl = editorFor(noteId)?.services.unfurl;
        return unfurl ? previewFor(url, await unfurl(url)) : null;
      },
    }),
    htmlPreview: inertNamespace({ ensure: async () => null }),
    system: inertNamespace({
      createWindow: async ({ noteId }: { noteId?: string | null } = {}) => {
        if (noteId) activeEditor()?.services.navigate?.({ kind: 'note', noteId, heading: null });
        return { action: 'created', windowId: -1 };
      },
    }),
  };
  return new Proxy(namespaces, {
    get: (target, name) => (typeof name === 'string' ? (target[name] ??= inertNamespace()) : undefined),
  });
}

export function installEditorElectronApi(): void {
  const scope = window as unknown as { electronAPI?: unknown };
  scope.electronAPI ??= createEditorElectronApi();
}
