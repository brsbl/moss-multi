// Moss's media set (P:Notes; A§16): exactly these extensions upload, each served as one content type. The client
// names an upload's type from here and the server accepts nothing else.

export type MediaKind = 'image' | 'video';

export const MEDIA_TYPES = {
  png: { contentType: 'image/png', kind: 'image' },
  jpg: { contentType: 'image/jpeg', kind: 'image' },
  jpeg: { contentType: 'image/jpeg', kind: 'image' },
  gif: { contentType: 'image/gif', kind: 'image' },
  webp: { contentType: 'image/webp', kind: 'image' },
  svg: { contentType: 'image/svg+xml', kind: 'image' },
  mp4: { contentType: 'video/mp4', kind: 'video' },
  webm: { contentType: 'video/webm', kind: 'video' },
  mov: { contentType: 'video/quicktime', kind: 'video' },
} as const satisfies Record<string, { contentType: string; kind: MediaKind }>;

export type MediaExtension = keyof typeof MEDIA_TYPES;

/** Upload caps through the Worker (SP9). */
export const MEDIA_CAP_BYTES: Record<MediaKind, number> = { image: 10 * 1024 * 1024, video: 95 * 1024 * 1024 };

/** The folder-relative path markdown keeps for an uploaded file, moss's own form. */
export const ASSET_DIR = 'assets/';

const extensionOf = (filename: string): string => /\.([^./\\]+)$/.exec(filename)?.[1]?.toLowerCase() ?? '';

/** The media type a filename names, or null for anything outside moss's set. */
export function mediaTypeOf(filename: string): { extension: MediaExtension; contentType: string; kind: MediaKind } | null {
  const extension = extensionOf(filename);
  if (!Object.hasOwn(MEDIA_TYPES, extension)) return null;
  const type = MEDIA_TYPES[extension as MediaExtension];
  return { extension: extension as MediaExtension, contentType: type.contentType, kind: type.kind };
}

const STEM_MAX = 100;

/**
 * The stored name for an uploaded file: its last path segment, with every character outside letters, digits, `.`,
 * `_` and `-` folded to `-` and a lowercase extension, so a markdown reference never needs escaping. Null when the
 * extension is not media.
 */
export function mediaFilename(raw: string): string | null {
  const base = raw.split(/[/\\]/).pop() ?? '';
  const type = mediaTypeOf(base);
  if (!type) return null;
  const stem = base
    .slice(0, base.length - type.extension.length - 1)
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .slice(0, STEM_MAX)
    // Trimmed after the cap, which can leave a separator last, so the result folds to itself.
    .replace(/^[-.]+|[-.]+$/g, '');
  return `${stem || 'media'}.${type.extension}`;
}

/** The stored names of the uploaded files markdown references in moss's relative form, `assets/<file>`. */
export function assetNamesIn(markdown: string): Set<string> {
  const names = new Set<string>();
  for (const match of markdown.matchAll(/(?:^|[(<"'\s])\.?\/?assets\/([^)\s>"'?#]+)/g)) {
    try {
      const name = mediaFilename(decodeURIComponent(match[1]));
      if (name) names.add(name);
    } catch {
      // a malformed escape names no file
    }
  }
  return names;
}

/**
 * `name.ext` → `name-n.ext`, the next candidate after a collision. The stem gives way to the suffix at the length cap,
 * so the result folds to itself and a read finds this file, not the first.
 */
export function suffixedFilename(filename: string, n: number): string {
  const dot = filename.lastIndexOf('.');
  const suffix = `-${n}`;
  const stem = filename.slice(0, dot).slice(0, STEM_MAX - suffix.length).replace(/[-.]+$/, '') || 'media';
  return `${stem}${suffix}${filename.slice(dot)}`;
}

/** Moss desktop's derived video thumbnails (`assets/video-thumb-<hash>.png`), which only moss desktop makes. */
export const isDesktopDerived = (filename: string): boolean => filename.startsWith('video-thumb-');
