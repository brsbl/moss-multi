// ported-from: packages/desktop/src/common/moss-asset-url.ts @ 762abb777
const MOSS_ASSET_SCHEME_PREFIX = 'moss-asset://';

export interface ParsedMossAssetRequestUrl {
  encodedPath: string;
  noteId: string | null;
}

export const parseMossAssetRequestUrl = (
  requestUrl: string
): ParsedMossAssetRequestUrl | null => {
  if (!requestUrl.startsWith(MOSS_ASSET_SCHEME_PREFIX)) {
    return null;
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(requestUrl);
  } catch {
    return null;
  }

  const rawPath = requestUrl.slice(MOSS_ASSET_SCHEME_PREFIX.length);
  const queryIndex = rawPath.indexOf('?');
  const encodedPath = queryIndex >= 0 ? rawPath.slice(0, queryIndex) : rawPath;
  if (encodedPath.length === 0) {
    return null;
  }

  return {
    encodedPath,
    noteId: parsedUrl.searchParams.get('noteId')?.trim() || null
  };
};
