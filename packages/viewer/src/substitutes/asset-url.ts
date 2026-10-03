// Substituted for moss's editor/utils/asset-url.ts in the viewer bundle (A§2.1): a viewer's media reference
// resolves only through its assetUrl service; the rest is moss's module at the pin, unchanged.
import { viewerAssetUrl } from '@moss-viewer/registry';
import { toDisplaySrc as mossToDisplaySrc } from '@moss-pristine/asset-url';

export { REMOTE_URL_PATTERN, fromDisplaySrc, normalizeLocalAssetPathForDisplay } from '@moss-pristine/asset-url';

export function toDisplaySrc(src: string, noteId?: string | null): string {
  return viewerAssetUrl(src, noteId) ?? mossToDisplaySrc(src, noteId);
}
