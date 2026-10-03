// Mounted viewers by moss note id. Each viewer renders its note under a unique id, so a call moss makes with that
// id (CurrentNoteIdContext: media URLs, embed previews) reaches that viewer's services and no other.
import { isLocalVideoPath } from '@moss-desktop/renderer/editor/utils/video-url';
import type { MossViewerAssetKind, MossViewerNote, MossViewerServices } from './types.ts';

export interface ViewerRecord {
  services: MossViewerServices;
  /** The notes its services listed, once they arrive. */
  notes: readonly MossViewerNote[];
}

/** A URL that loads nothing and fails as media, for a reference the services did not resolve. */
export const NO_MEDIA = 'data:,';

const viewers = new Map<string, ViewerRecord>();
let lastActive: string | null = null;

export function registerViewer(noteId: string, record: ViewerRecord): () => void {
  viewers.set(noteId, record);
  return () => {
    viewers.delete(noteId);
    if (lastActive === noteId) lastActive = null;
  };
}

export function viewerFor(noteId: string | null | undefined): ViewerRecord | undefined {
  return noteId ? viewers.get(noteId) : undefined;
}

/** The viewer the reader last pressed in, for calls moss makes without a source note id. */
export function markActive(noteId: string): void {
  lastActive = noteId;
}

export function activeViewer(): ViewerRecord | undefined {
  return viewerFor(lastActive);
}

/** The note entry any mounted viewer listed for this id. */
export function listedNote(noteId: string): MossViewerNote | undefined {
  for (const viewer of viewers.values()) {
    const note = viewer.notes.find((entry) => entry.id === noteId);
    if (note) return note;
  }
  return undefined;
}

export const assetKind = (ref: string): MossViewerAssetKind => (isLocalVideoPath(ref) ? 'video' : 'image');

/**
 * The URL a viewer's note loads for a media reference; undefined when no viewer renders `noteId`. A reference
 * the services leave unresolved gets NO_MEDIA, so it never reaches the network.
 */
export function viewerAssetUrl(ref: string, noteId: string | null | undefined): string | undefined {
  const viewer = viewerFor(noteId);
  if (!viewer) return undefined;
  return viewer.services.assetUrl?.(ref, assetKind(ref)) || NO_MEDIA;
}
