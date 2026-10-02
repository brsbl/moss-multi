// ported-from: packages/desktop/src/renderer/editor/utils/media-server-url.ts @ 762abb777
import { systemApi } from '../../api/electron';
import {
  normalizeLocalAssetPathForDisplay,
  REMOTE_URL_PATTERN
} from './asset-url';

/**
 * Loopback media-server URLs for <video> playback.
 *
 * Electron's custom-protocol layer cannot serve seekable media (see
 * main/storage/media-server.ts), so local videos play from a token-guarded
 * 127.0.0.1 HTTP server instead of moss-asset://. Info is fetched once and
 * cached module-level so URL building stays synchronous for render paths.
 * Until it arrives callers fall back to moss-asset://, and a null or rejected
 * lookup remains retryable when a later video requests server info.
 */

let info: { port: number; token: string } | null = null;
let requestInFlight = false;
const listeners = new Set<() => void>();

const ensureRequested = (): void => {
  if (info || requestInFlight) return;
  requestInFlight = true;
  void systemApi.getMediaServerInfo
    .invoke()
    .then((result) => {
      if (result && typeof result.port === 'number' && typeof result.token === 'string') {
        info = result;
        for (const listener of listeners) listener();
      }
    })
    .catch(() => {
      // Server unavailable — keep moss-asset fallback and allow a later retry.
    })
    .finally(() => {
      requestInFlight = false;
    });
};

/** Subscribe for media-server info arrivals (for re-render hooks). */
export const onMediaServerReady = (listener: () => void): (() => void) => {
  listeners.add(listener);
  ensureRequested();
  if (info) {
    listener();
  }
  return () => listeners.delete(listener);
};

/** Drop stale connection details and resolve the current server again. */
export const refreshMediaServerInfo = (): void => {
  info = null;
  ensureRequested();
};

/**
 * Build a playable URL for a note-relative (or workspace) media path.
 * Returns null until server info is available.
 */
export const buildMediaServerUrl = (src: string, noteId?: string | null): string | null => {
  if (
    REMOTE_URL_PATTERN.test(src) ||
    /^(?:data|file|moss-asset):/i.test(src)
  ) {
    return null;
  }

  ensureRequested();
  if (!info) return null;
  const params = new URLSearchParams();
  // Encoded twice on purpose, and URLSearchParams adds the second layer on
  // serialize. The server decodes once reading the param and hands the still-
  // encoded value to the moss-asset URL it rebuilds — which is what stops a
  // `?` or `#` in a filename from splitting that URL. Dropping this as
  // redundant breaks containment for those names.
  params.set('path', encodeURIComponent(normalizeLocalAssetPathForDisplay(src)));
  if (noteId) params.set('noteId', noteId);
  params.set('token', info.token);
  return `http://127.0.0.1:${info.port}/media?${params.toString()}`;
};
