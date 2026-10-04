// ported-from: packages/desktop/src/renderer/editor/utils/remote-image-url.ts @ 762abb777
import { imagesApi } from '../../api/electron';
// moss-multi seam: converter-split (A§12; S-conv §2.3)
import { isHttpsImageUrl } from './https-image-url';
export { HTTPS_IMAGE_URL_PATTERN, extractAltFromUrl, isHttpsImageUrl } from './https-image-url';

type PersistImageResult = {
  relativePath: string;
  absolutePath: string;
  filename: string;
};

type PersistRemoteImageFn = (input: {
  noteId: string;
  url: string;
  filename?: string;
}) => Promise<PersistImageResult>;

/**
 * Preflight and persist a remote image URL into note-local assets.
 * Returns null when URL is invalid, preflight fails, or persistence fails.
 *
 * When `skipUrlCheck` is true, skip the `isHttpsImageUrl` pattern check —
 * the URL came from an HTML <img> tag so we just try to download it.
 * The backend validates Content-Type, so non-images are rejected.
 */
export async function preflightRemoteImageUrl(input: {
  noteId?: string | null;
  url: string;
  filenameHint?: string;
  skipUrlCheck?: boolean;
}, persistRemoteImage: PersistRemoteImageFn = imagesApi.persistUrl.invoke): Promise<PersistImageResult | null> {
  const noteId = input.noteId?.trim();
  const url = input.url.trim();

  if (!noteId || !url.startsWith('https://') || (!input.skipUrlCheck && !isHttpsImageUrl(url))) {
    return null;
  }

  try {
    return await persistRemoteImage({
      noteId,
      url,
      filename: input.filenameHint
    });
  } catch {
    return null;
  }
}
