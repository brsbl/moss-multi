// ported-from: packages/desktop/src/renderer/editor/nodes/web-embed/useWebEmbedPreview.ts @ 762abb777
/**
 * Thin wrapper over the shared `useDerivedPreview` (W1) for `WebEmbedNode`.
 *
 * It owns NO preview generation. It only:
 *  - derives the stable web-embed cache key from the raw URL (W2 descriptor), and
 *  - wires the exact-key `webEmbedPreviewApi.ensure` / `subscribe` pair (W2).
 *
 * Stale-result guards, unsubscribe cleanup, and note-switch teardown all live in
 * `useDerivedPreview` (keyed to `cacheKey`), so this hook introduces no new effect
 * class and no new timers.
 */
import { useCallback } from 'react';

import type { DerivedPreviewResult } from '../../../../common/derived-preview';
import { WEB_EMBED_PREVIEW_KIND, getWebEmbedPreviewDescriptor } from '../../../../common/web-embed-preview';
import { webEmbedPreviewApi } from '../../../api/electron';
import {
  useDerivedPreview,
  type UseDerivedPreviewState
} from '../../preview/useDerivedPreview';

export interface UseWebEmbedPreviewInput {
  noteId: string | null;
  url: string;
  /** Skip ensure/subscribe when false. */
  enabled?: boolean;
  /** Subscribe to cached updates without triggering generation. */
  ensureOnMount?: boolean;
}

export function useWebEmbedPreview({
  noteId,
  url,
  enabled = true,
  ensureOnMount = true
}: UseWebEmbedPreviewInput): UseDerivedPreviewState {
  const descriptor = getWebEmbedPreviewDescriptor(url);
  const cacheKey = descriptor?.cacheKey ?? '';

  const ensure = useCallback(
    async (): Promise<DerivedPreviewResult | null> => {
      if (!noteId || !ensureOnMount) {
        return null;
      }
      return webEmbedPreviewApi.ensure.invoke({ noteId, url });
    },
    [ensureOnMount, noteId, url]
  );

  const subscribe = useCallback(
    (key: string, onResult: (result: DerivedPreviewResult) => void): (() => void) => {
      if (!noteId) {
        return () => {};
      }
      return webEmbedPreviewApi.subscribe(noteId, key, onResult);
    },
    [noteId]
  );

  return useDerivedPreview({
    kind: WEB_EMBED_PREVIEW_KIND,
    cacheKey,
    ensure,
    subscribe,
    enabled: enabled && Boolean(noteId) && descriptor !== null
  });
}
