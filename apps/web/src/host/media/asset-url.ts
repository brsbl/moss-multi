// Substituted for moss's editor/utils/asset-url.ts in the web build (A§2.1, A§16; apps/web/vite.config.ts): a note's
// uploaded media loads from its asset route, and that route reads back to moss's relative path when moss's clipboard
// HTML is pasted into the same note. Everything else is moss's module at the pin.
import { fromDisplaySrc as mossFromDisplaySrc, toDisplaySrc as mossToDisplaySrc } from '@moss-pristine/asset-url';
import { parseWebAssetUrl, uploadedFilename, webAssetUrl } from '@moss-multi/host/media/web-asset-url';

export { REMOTE_URL_PATTERN, normalizeLocalAssetPathForDisplay } from '@moss-pristine/asset-url';

export function toDisplaySrc(src: string, noteId?: string | null): string {
  const filename = noteId ? uploadedFilename(src) : null;
  return noteId && filename ? webAssetUrl(noteId, filename) : mossToDisplaySrc(src, noteId);
}

/** Another note's asset stays a full URL, as moss keeps another note's `moss-asset://` (its paste plugin copies it). */
export function fromDisplaySrc(src: string, currentNoteId?: string | null): string {
  const asset = parseWebAssetUrl(src);
  if (!asset) return mossFromDisplaySrc(src, currentNoteId);
  return currentNoteId && asset.noteId !== currentNoteId ? src : asset.relativePath;
}
