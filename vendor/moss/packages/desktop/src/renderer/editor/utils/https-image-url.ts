// ported-from: packages/desktop/src/renderer/editor/utils/remote-image-url.ts @ 762abb777 (extracted)
/** Supported image extensions for external URLs */
const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'];

/**
 * Pattern to match HTTPS URLs with image extensions.
 * Matches extension anywhere in the path (before query string).
 */
export const HTTPS_IMAGE_URL_PATTERN = new RegExp(
  `^https://[^\\s]+\\.(${IMAGE_EXTENSIONS.join('|')})(?:\\?[^\\s]*)?$`,
  'i'
);

/**
 * Known image hosting domains that serve images without file extensions.
 * These URLs are trusted to be images based on the domain.
 */
const IMAGE_HOSTING_DOMAINS = [
  'images.unsplash.com',
  'i.imgur.com',
  'pbs.twimg.com',
  'media.giphy.com',
  'i.giphy.com',
  'cdn.discordapp.com',
  'media.discordapp.net'
];

function isKnownImageHost(url: string): boolean {
  try {
    const hostname = new URL(url).hostname;
    return IMAGE_HOSTING_DOMAINS.some(
      (domain) => hostname === domain || hostname.endsWith(`.${domain}`)
    );
  } catch {
    return false;
  }
}

/**
 * Check if a string is a valid HTTPS image URL.
 * Accepts extension-based URLs and known image-host domains.
 * For plain-text pastes only — HTML clipboard images use a separate path
 * that tries to download any <img> src and lets the backend validate Content-Type.
 */
export function isHttpsImageUrl(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed.startsWith('https://')) {
    return false;
  }
  return HTTPS_IMAGE_URL_PATTERN.test(trimmed) || isKnownImageHost(trimmed);
}

/**
 * Extract alt text from URL filename.
 * Converts "my-image_name.png" -> "my image name"
 */
export function extractAltFromUrl(url: string): string {
  try {
    const pathname = new URL(url).pathname;
    const filename = pathname.split('/').pop() || '';
    return filename.replace(/\.[^.]+$/, '').replace(/[-_]/g, ' ');
  } catch {
    return '';
  }
}
