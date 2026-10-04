// Substituted for moss's editor/utils/media-server-url.ts in the web build (A§2.1, A§16). Moss plays local video
// from a loopback media server because its asset protocol cannot seek; on the web the asset route answers HTTP Range
// itself, so a video plays from the same URL its image siblings load from, and no server info ever arrives.
import { uploadedFilename, webAssetUrl } from '@moss-multi/host/media/web-asset-url';

const noop = () => undefined;

export const onMediaServerReady: (listener: () => void) => () => void = () => noop;

export const refreshMediaServerInfo = (): void => undefined;

export function buildMediaServerUrl(src: string, noteId?: string | null): string | null {
  const filename = noteId ? uploadedFilename(src) : null;
  return noteId && filename ? webAssetUrl(noteId, filename) : null;
}
