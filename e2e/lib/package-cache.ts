// How the fixture servers serve a built package directory (T3.12). `no-store` is what they did before and what a
// host without caching does: every load fetches every byte. `host` is what editor-embed.md §13 asks of a host: files
// under assets/ have content-hashed names and are cached immutably; the rest (the entry, the stylesheet, the
// manifests and the frame document) are revalidated by ETag, so an unchanged file answers 304 with no body.
import { statSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';

export type CacheMode = 'no-store' | 'host';

export const IMMUTABLE = 'public, max-age=31536000, immutable';

/** The status and caching headers for `file`, served at `relative` (its path inside the package directory). */
export function packageCaching(mode: CacheMode, relative: string, file: string, request: IncomingMessage): { status: 200 | 304; headers: Record<string, string> } {
  if (mode === 'no-store') return { status: 200, headers: { 'cache-control': 'no-store' } };
  if (relative.startsWith('assets/')) return { status: 200, headers: { 'cache-control': IMMUTABLE } };
  const stat = statSync(file);
  const etag = `"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
  const headers = { 'cache-control': 'no-cache', etag };
  return { status: request.headers['if-none-match'] === etag ? 304 : 200, headers };
}

export interface Served {
  path: string;
  status: number;
  bytes: number;
}
