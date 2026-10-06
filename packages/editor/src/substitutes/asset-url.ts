// Substituted for moss's editor/utils/asset-url.ts in the editor bundle (A§2.1): an editor's media reference resolves
// only through its bridge's `assets.url`, and a URL a host issued reads back through `assets.parseUrl`; the rest is
// moss's module at the pin, unchanged.
import { editorAssetUrl, hostAsset } from '@moss-editor/registry';
import { fromDisplaySrc as mossFromDisplaySrc, toDisplaySrc as mossToDisplaySrc } from '@moss-pristine/asset-url';

export { REMOTE_URL_PATTERN, normalizeLocalAssetPathForDisplay } from '@moss-pristine/asset-url';

export function toDisplaySrc(src: string, noteId?: string | null): string {
  return editorAssetUrl(src, noteId) ?? mossToDisplaySrc(src, noteId);
}

/**
 * moss's fromDisplaySrc, plus host-issued URLs: one for this note's asset (or with no note given, as ImageNode's
 * importDOM calls it) becomes its `assets/` reference; another note's becomes the `moss-asset://` URL desktop keeps
 * for a cross-note reference whose copy failed, so a host URL is never saved.
 */
export function fromDisplaySrc(src: string, currentNoteId?: string | null): string {
  const asset = hostAsset(src);
  if (!asset) return mossFromDisplaySrc(src, currentNoteId);
  if (currentNoteId && asset.noteId !== currentNoteId.trim()) return `moss-asset://${encodeURIComponent(asset.ref)}?noteId=${encodeURIComponent(asset.noteId)}`;
  return asset.ref;
}
