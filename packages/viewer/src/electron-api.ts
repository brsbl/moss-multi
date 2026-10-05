// window.electronAPI for a page that hosts viewers. Moss's renderer calls it; here every read goes to the viewer
// that owns the note, and everything else (saves, uploads, windows, analytics, settings) is inert: it resolves
// with nothing and opens no network, socket or storage path. A host page that already has an electronAPI (the
// moss-multi app) keeps its own.
import { createWebEmbedPreviewResult, getWebEmbedPreviewDescriptor } from '@moss-desktop/common/web-embed-preview';
import { ensureHtmlPreview } from './html-preview.ts';
import { activeViewer, listedNote, viewerFor } from './registry.ts';
import type { MossViewerUnfurl } from './types.ts';

type AnyFunction = (...args: never[]) => unknown;
type Namespace = Record<string, AnyFunction>;

const noop = () => undefined;
const inert = async () => undefined;
const unsubscriber = () => noop;

/** Subscriptions return an unsubscriber; every other method resolves with nothing. */
const fallbackFor = (method: string): AnyFunction => (/^(on[A-Z]|subscribe)/.test(method) ? unsubscriber : inert);

function inertNamespace(own: Namespace = {}): Namespace {
  return new Proxy(own, { get: (target, method) => (typeof method === 'string' ? (target[method] ?? fallbackFor(method)) : undefined) });
}

function previewFor(url: string, unfurl: MossViewerUnfurl | null) {
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

export function createViewerElectronApi(): Record<string, Namespace> {
  const namespaces: Record<string, Namespace> = {
    notes: inertNamespace({
      getHeadings: async (noteId: string) => [...(listedNote(noteId)?.headings ?? [])],
      getAll: async () => [],
      getMetadataByIds: async () => [],
    }),
    webEmbedPreview: inertNamespace({
      ensure: async ({ noteId, url }: { noteId: string; url: string }) => {
        const unfurl = viewerFor(noteId)?.services.unfurl;
        return unfurl ? previewFor(url, await unfurl(url)) : null;
      },
    }),
    htmlPreview: inertNamespace({
      // A cached screenshot through the viewer's assetUrl; never a capture.
      ensure: async ({ noteId, rawHtml }: { noteId: string; rawHtml: string }) => ensureHtmlPreview(noteId, rawHtml),
    }),
    system: inertNamespace({
      // A file link's "Open in New Window": the reader follows it in the viewer they pressed in.
      createWindow: async ({ noteId }: { noteId?: string | null } = {}) => {
        if (noteId) activeViewer()?.services.navigate?.({ kind: 'note', noteId, heading: null });
        return { action: 'created', windowId: -1 };
      },
    }),
  };
  return new Proxy(namespaces, {
    get: (target, name) => (typeof name === 'string' ? (target[name] ??= inertNamespace()) : undefined),
  });
}

export function installViewerElectronApi(): void {
  const scope = window as unknown as { electronAPI?: unknown };
  scope.electronAPI ??= createViewerElectronApi();
}
