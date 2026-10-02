// ported-from: packages/desktop/src/renderer/editor/preview/RemoteWebSurface.tsx @ 762abb777
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { JSX, RefObject } from 'react';

import type { RemoteWebSurfaceBounds } from '../../../common/remote-web-surface';
import { resolveRemoteWebSurfaceUrl } from '../../../common/web-embed-url';
import { remoteWebSurfaceApi } from '../../api/electron';

export interface RemoteWebSurfaceProps {
  id: string;
  noteId: string | null;
  nodeKey: string;
  mode: 'card' | 'fullscreen' | 'split';
  navigationRequestId?: number;
  url: string;
  title: string;
  active: boolean;
  commandPaletteShortcutEnabled?: boolean;
  className?: string;
  dataAttributes?: Record<string, string>;
  onError?: (errorCode: string) => void;
}

interface MeasuredSurfaceBounds {
  bounds: RemoteWebSurfaceBounds;
  visible: boolean;
}

const MIN_VISIBLE_EDGE_PX = 16;
const BLOCKING_DIALOG_SELECTOR = '[data-remote-web-surface-blocking-dialog="true"]';
const boundsKey = (input: MeasuredSurfaceBounds, nativeVisible: boolean): string =>
  `${input.visible && nativeVisible ? '1' : '0'}:${input.bounds.x}:${input.bounds.y}:${input.bounds.width}:${input.bounds.height}`;

const hasOpenAppDialog = (): boolean => {
  if (typeof document === 'undefined') {
    return false;
  }

  for (const element of document.querySelectorAll<HTMLElement>(BLOCKING_DIALOG_SELECTOR)) {
    if (element.dataset.state !== 'closed' && element.getAttribute('aria-hidden') !== 'true') {
      return true;
    }
  }
  return false;
};

const nodeContainsBlockingDialog = (node: Node): boolean =>
  node instanceof Element &&
  (node.matches(BLOCKING_DIALOG_SELECTOR) || node.querySelector(BLOCKING_DIALOG_SELECTOR) !== null);

const mutationTouchesBlockingDialog = (mutation: MutationRecord): boolean => {
  if (mutation.type === 'attributes') {
    return (
      mutation.attributeName === 'data-remote-web-surface-blocking-dialog' ||
      (mutation.target instanceof Element && mutation.target.matches(BLOCKING_DIALOG_SELECTOR))
    );
  }
  return (
    [...mutation.addedNodes].some(nodeContainsBlockingDialog) ||
    [...mutation.removedNodes].some(nodeContainsBlockingDialog)
  );
};

const useSplitSurfaceBlockedByDialog = (enabled: boolean): boolean => {
  const [blocked, setBlocked] = useState(false);

  useLayoutEffect(() => {
    if (!enabled) {
      setBlocked(false);
      return undefined;
    }

    const update = () => {
      const next = hasOpenAppDialog();
      setBlocked((current) => (current === next ? current : next));
    };
    update();

    const observer = new MutationObserver((mutations) => {
      if (mutations.some(mutationTouchesBlockingDialog)) {
        update();
      }
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['aria-hidden', 'data-state', 'data-remote-web-surface-blocking-dialog']
    });

    return () => observer.disconnect();
  }, [enabled]);

  return blocked;
};

const measureSurfaceBounds = (element: HTMLElement): MeasuredSurfaceBounds => {
  const rect = element.getBoundingClientRect();
  let left = Math.max(0, rect.left);
  let top = Math.max(0, rect.top);
  let right = Math.min(window.innerWidth, rect.right);
  let bottom = Math.min(window.innerHeight, rect.bottom);

  // WebContentsView is a native sibling of the renderer, so CSS overflow does
  // not clip it. Intersect with DOM ancestor boxes here so split panes, modal
  // frames, and scroll containers bound the native view exactly.
  let ancestor = element.parentElement;
  while (ancestor && ancestor !== document.body) {
    const ancestorRect = ancestor.getBoundingClientRect();
    if (ancestorRect.width > 0 && ancestorRect.height > 0) {
      left = Math.max(left, ancestorRect.left);
      top = Math.max(top, ancestorRect.top);
      right = Math.min(right, ancestorRect.right);
      bottom = Math.min(bottom, ancestorRect.bottom);
    }
    ancestor = ancestor.parentElement;
  }
  const width = Math.max(0, right - left);
  const height = Math.max(0, bottom - top);
  const visible = width >= MIN_VISIBLE_EDGE_PX && height >= MIN_VISIBLE_EDGE_PX;

  return {
    visible,
    bounds: {
      x: Math.round(left),
      y: Math.round(top),
      width: visible ? Math.round(width) : 0,
      height: visible ? Math.round(height) : 0
    }
  };
};

export function RemoteWebSurface({
  id,
  noteId,
  nodeKey,
  mode,
  navigationRequestId = 0,
  url,
  title,
  active,
  commandPaletteShortcutEnabled = false,
  className,
  dataAttributes,
  onError
}: RemoteWebSurfaceProps): JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const createdRef = useRef(false);
  const generationRef = useRef(0);
  const lastBoundsKeyRef = useRef('');
  const lastSurfaceInputKeyRef = useRef('');
  const animationFrameRef = useRef<number | null>(null);
  const surfaceInputRef = useRef({
    mode,
    navigationRequestId,
    url,
    title: title || url,
    commandPaletteShortcutEnabled
  });
  const [failed, setFailed] = useState<string | null>(null);
  const surfaceTitle = title || url;
  const surfaceUrl = resolveRemoteWebSurfaceUrl(url);
  const blockedByDialog = useSplitSurfaceBlockedByDialog(active && mode === 'split');
  const blockedByDialogRef = useRef(blockedByDialog);
  blockedByDialogRef.current = blockedByDialog;
  surfaceInputRef.current = {
    mode,
    navigationRequestId,
    url: surfaceUrl,
    title: surfaceTitle,
    commandPaletteShortcutEnabled
  };

  const destroySurface = useCallback(() => {
    generationRef.current += 1;
    if (animationFrameRef.current !== null) {
      window.cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }
    lastBoundsKeyRef.current = '';
    lastSurfaceInputKeyRef.current = '';
    if (!createdRef.current) {
      return;
    }
    createdRef.current = false;
    void remoteWebSurfaceApi.destroy.invoke({ id }).catch(() => undefined);
  }, [id]);

  const reportError = useCallback(
    (errorCode: string) => {
      setFailed(errorCode);
      onError?.(errorCode);
    },
    [onError]
  );

  const syncBounds = useCallback(async () => {
    animationFrameRef.current = null;
    if (!active || !noteId) {
      return;
    }
    const host = hostRef.current;
    if (!host) {
      return;
    }

    const measured = measureSurfaceBounds(host);
    const nativeBlocked =
      surfaceInputRef.current.mode === 'split' &&
      (blockedByDialogRef.current || hasOpenAppDialog());
    const nativeVisible = measured.visible && !nativeBlocked;
    const generation = generationRef.current;
    const nextBoundsKey = boundsKey(measured, nativeVisible);
    const input = surfaceInputRef.current;
    const nextSurfaceInputKey = `${input.mode}:${input.navigationRequestId}:${input.url}:${input.title}:${input.commandPaletteShortcutEnabled ? '1' : '0'}`;
    if (
      createdRef.current &&
      nextBoundsKey === lastBoundsKeyRef.current &&
      nextSurfaceInputKey === lastSurfaceInputKeyRef.current
    ) {
      return;
    }
    lastBoundsKeyRef.current = nextBoundsKey;

    if (nativeBlocked) {
      if (!createdRef.current) {
        return;
      }
      const result = await remoteWebSurfaceApi.updateBounds.invoke({
        id,
        bounds: measured.bounds,
        visible: false
      });
      if (generation !== generationRef.current) {
        return;
      }
      if (!result.ok && result.errorCode !== 'invalid-input') {
        reportError(result.errorCode ?? 'update-failed');
      }
      return;
    }

    if (!createdRef.current || nextSurfaceInputKey !== lastSurfaceInputKeyRef.current) {
      const result = await remoteWebSurfaceApi.create.invoke({
        id,
        noteId,
        nodeKey,
        mode: input.mode,
        navigationRequestId: input.navigationRequestId,
        url: input.url,
        title: input.title,
        bounds: measured.bounds,
        commandPaletteShortcutEnabled: input.commandPaletteShortcutEnabled
      });
      if (generation !== generationRef.current) {
        return;
      }
      if (!result.ok) {
        reportError(result.errorCode ?? 'unsupported');
        return;
      }
      createdRef.current = true;
      lastSurfaceInputKeyRef.current = nextSurfaceInputKey;
      setFailed(null);
      return;
    }

    const result = measured.visible
      ? await remoteWebSurfaceApi.updateBounds.invoke({
          id,
          bounds: measured.bounds,
          visible: true
        })
      : await remoteWebSurfaceApi.hide.invoke({ id });
    if (generation !== generationRef.current) {
      return;
    }
    if (!result.ok) {
      if (result.errorCode === 'invalid-input') {
        // The main-process view can disappear independently during HMR, note
        // switches, or a stale cleanup from a previous render of the same
        // surface id. Treat a missing record as recoverable and recreate it on
        // the next frame instead of leaving the split/lightbox stuck on the
        // loading placeholder.
        createdRef.current = false;
        lastBoundsKeyRef.current = '';
        if (animationFrameRef.current === null) {
          animationFrameRef.current = window.requestAnimationFrame(() => {
            void syncBounds();
          });
        }
        return;
      }
      reportError(result.errorCode ?? 'update-failed');
    }
  }, [active, id, nodeKey, noteId, reportError]);

  const scheduleSyncBounds = useCallback(() => {
    if (animationFrameRef.current !== null) {
      return;
    }
    animationFrameRef.current = window.requestAnimationFrame(() => {
      void syncBounds();
    });
  }, [syncBounds]);

  const forceSyncBounds = useCallback(() => {
    lastBoundsKeyRef.current = '';
    scheduleSyncBounds();
  }, [scheduleSyncBounds]);

  useLayoutEffect(() => {
    if (!active || !noteId) {
      destroySurface();
      return undefined;
    }
    setFailed(null);
    scheduleSyncBounds();

    const host = hostRef.current;
    const resizeObserver =
      host && typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver(() => scheduleSyncBounds())
        : null;
    if (host) {
      let observed: HTMLElement | null = host;
      while (observed && observed !== document.body) {
        resizeObserver?.observe(observed);
        observed = observed.parentElement;
      }
    }

    window.addEventListener('resize', scheduleSyncBounds);
    window.addEventListener('focus', forceSyncBounds);
    document.addEventListener('visibilitychange', forceSyncBounds);
    window.visualViewport?.addEventListener('resize', scheduleSyncBounds);
    if (mode === 'card') {
      window.addEventListener('scroll', scheduleSyncBounds, true);
      window.visualViewport?.addEventListener('scroll', scheduleSyncBounds);
    }

    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener('resize', scheduleSyncBounds);
      window.removeEventListener('focus', forceSyncBounds);
      document.removeEventListener('visibilitychange', forceSyncBounds);
      window.visualViewport?.removeEventListener('resize', scheduleSyncBounds);
      if (mode === 'card') {
        window.removeEventListener('scroll', scheduleSyncBounds, true);
        window.visualViewport?.removeEventListener('scroll', scheduleSyncBounds);
      }
      destroySurface();
    };
  }, [active, destroySurface, forceSyncBounds, mode, noteId, scheduleSyncBounds]);

  useEffect(() => {
    if (!active || !noteId) {
      return;
    }
    scheduleSyncBounds();
  }, [
    active,
    blockedByDialog,
    commandPaletteShortcutEnabled,
    mode,
    navigationRequestId,
    noteId,
    scheduleSyncBounds,
    surfaceTitle,
    surfaceUrl
  ]);

  useEffect(() => destroySurface, [destroySurface]);

  return (
    <div
      ref={hostRef as RefObject<HTMLDivElement>}
      className={className}
      data-remote-web-surface-error={failed ?? undefined}
      {...dataAttributes}
    />
  );
}

export default RemoteWebSurface;
