// The viewer's answers to moss-multi's host hooks (A§2.2), per mounted viewer: a note's HTML blocks load its
// viewer's frame document (services.htmlFrameUrl), or keep the cached screenshots when it has none; a note no viewer
// renders keeps the page's default.
import { resolveFrameDocument } from '@moss-multi/host/html-frame.ts';
import { viewerFor } from './registry.ts';

export function installViewerHooks(): void {
  resolveFrameDocument((noteId) => {
    const viewer = viewerFor(noteId);
    return viewer ? (viewer.services.htmlFrameUrl ?? null) : undefined;
  });
}
