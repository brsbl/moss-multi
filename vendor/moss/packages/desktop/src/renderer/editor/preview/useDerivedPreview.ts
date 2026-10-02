// ported-from: packages/desktop/src/renderer/editor/preview/useDerivedPreview.ts @ 762abb777
/**
 * Exact-key derived-preview subscription hook shared by HTML, video, and web
 * embed consumers.
 *
 * It owns stale-result guards and unsubscribe cleanup; it does NOT know how to
 * generate HTML screenshots, video thumbnails, or oEmbed responses. Callers
 * pass node-specific `ensure` + exact-key `subscribe` functions. The effect is
 * keyed to `cacheKey`, so a note switch (which changes the consuming node's
 * cacheKey or unmounts it) tears down the subscription and cancels the in-flight
 * ensure — satisfying the note-switch cleanup rule without a parallel lifecycle.
 */
import { useEffect, useRef, useState } from 'react';

import type {
  DerivedPreviewKind,
  DerivedPreviewResult,
  DerivedPreviewStatus
} from '../../../common/derived-preview';

export interface UseDerivedPreviewInput {
  kind: DerivedPreviewKind;
  cacheKey: string;
  ensure: (cacheKey: string) => Promise<DerivedPreviewResult | null>;
  subscribe: (
    cacheKey: string,
    onResult: (result: DerivedPreviewResult) => void
  ) => () => void;
  /** Skip ensure/subscribe when false (e.g. no note id / not near viewport). */
  enabled?: boolean;
}

export interface UseDerivedPreviewState {
  result: DerivedPreviewResult | null;
  status: DerivedPreviewStatus;
}

export function useDerivedPreview({
  kind,
  cacheKey,
  ensure,
  subscribe,
  enabled = true
}: UseDerivedPreviewInput): UseDerivedPreviewState {
  const [result, setResult] = useState<DerivedPreviewResult | null>(null);

  // Hold the latest callbacks so unstable identities don't retrigger the effect.
  const ensureRef = useRef(ensure);
  ensureRef.current = ensure;
  const subscribeRef = useRef(subscribe);
  subscribeRef.current = subscribe;

  // Derive (not effect-copy): only surface a result for the current cacheKey,
  // and suppress it entirely while disabled (e.g. not near viewport / note
  // switched) so a stale result never leaks to a disabled consumer.
  const activeResult =
    enabled && result && result.cacheKey === cacheKey ? result : null;

  useEffect(() => {
    if (!enabled || cacheKey.length === 0) {
      return undefined;
    }

    let cancelled = false;

    const handleResult = (next: DerivedPreviewResult) => {
      if (cancelled || next.cacheKey !== cacheKey || next.kind !== kind) {
        return;
      }
      setResult(next);
    };

    const unsubscribe = subscribeRef.current(cacheKey, handleResult);

    void ensureRef.current(cacheKey)
      .then((ensured) => {
        if (cancelled || !ensured || ensured.cacheKey !== cacheKey || ensured.kind !== kind) {
          return;
        }
        setResult(ensured);
      })
      .catch(() => {
        // Failures surface through the subscription or the consumer's own policy
        // (e.g. no automatic retry in the same session).
      });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [kind, cacheKey, enabled]);

  return {
    result: activeResult,
    status: activeResult?.status ?? 'idle'
  };
}
