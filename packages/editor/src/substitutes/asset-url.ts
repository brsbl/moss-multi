// Substituted for moss's editor/utils/asset-url.ts in the editor bundle (A§2.1): an editor's media reference resolves
// only through its bridge's `assets.url`; the rest is moss's module at the pin, unchanged.
import { editorAssetUrl } from '@moss-editor/registry';
import { toDisplaySrc as mossToDisplaySrc } from '@moss-pristine/asset-url';

export { REMOTE_URL_PATTERN, fromDisplaySrc, normalizeLocalAssetPathForDisplay } from '@moss-pristine/asset-url';

export function toDisplaySrc(src: string, noteId?: string | null): string {
  return editorAssetUrl(src, noteId) ?? mossToDisplaySrc(src, noteId);
}
