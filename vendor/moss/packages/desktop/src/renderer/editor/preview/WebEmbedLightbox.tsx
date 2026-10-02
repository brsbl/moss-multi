// ported-from: packages/desktop/src/renderer/editor/preview/WebEmbedLightbox.tsx @ 762abb777
/**
 * App-level web embed browser lightbox (singleton).
 *
 * The single interactive browser surface for the "open a website" flow: any web
 * link surface (the embed pill, etc.) calls `openWebEmbedAtom`, which — when no
 * browser split is open — sets `webEmbedLightboxTargetAtom`, and this component
 * renders the modal browser over the canvas.
 *
 * Sizing is the named 75%-of-visible-canvas web-embed resolver (NOT the
 * moss-html `1200 × 900` intrinsic size). The header carries the title/URL plus
 * right-aligned icon buttons — open in system browser, open as split view, and
 * close — matching the media-node header control language. The interactive page
 * is a native `RemoteWebSurface` (WebContentsView); unsafe/unsupported targets
 * reject to the shared fallback with the system-browser escape.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { JSX } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { Columns2, ExternalLink, X } from 'lucide-react';
import {
  activeNoteIdAtom,
  closeWebEmbedLightboxAtom,
  commandPaletteOriginAtom,
  openBrowserSplitAtom,
  pendingAgentContextAtom,
  pendingAgentContextIconUrlAtom,
  pendingAgentContextSourceUrlAtom,
  showCommandPaletteAtom,
  webEmbedLightboxTargetAtom
} from '@moss/shared';
import { SproutIcon } from '@moss/shared/components/brand/SproutIcon';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger
} from '@moss/shared/components/ui/tooltip';

import { isSafeWebBrowserUrl } from '../../../common/web-embed-url';
import { resolveWebEmbedLightboxSize } from '../../../common/web-embed-dimensions';
import { BrowserSelectionToolbar } from '../../panels/BrowserSelectionToolbar';
import { remoteWebSurfaceApi } from '../../api/electron';
import { TopNavBar, TopNavIconButton, TOP_NAV_ICON_SIZE_CLASSNAMES } from '../../panels/TopNavControls';
import { RemoteWebSurface } from './RemoteWebSurface';
import { useRemoteWebSurfaceSelection } from './useRemoteWebSurfaceSelection';
import { SharedPreviewLightbox } from './SharedPreviewLightbox';
import { SharedOpenInBrowserButton } from './SharedLivePreviewControls';

const LIGHTBOX_SURFACE_ID = 'web-embed:lightbox';

const getBrowserContextFaviconUrl = (rawUrl: string): string | null => {
  try {
    return new URL('/favicon.ico', rawUrl).toString();
  } catch {
    return null;
  }
};

/** Union bounding box of the visible canvas scroll region(s), falling back to the window. */
const readVisibleCanvasSize = (): { width: number; height: number } => {
  if (typeof window === 'undefined') {
    return { width: 0, height: 0 };
  }
  const fallback = { width: window.innerWidth, height: window.innerHeight };
  if (typeof document === 'undefined') {
    return fallback;
  }
  const regions = Array.from(document.querySelectorAll('.canvas-scroll'));
  if (regions.length === 0) {
    return fallback;
  }
  let left = Number.POSITIVE_INFINITY;
  let top = Number.POSITIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY;
  let bottom = Number.NEGATIVE_INFINITY;
  for (const region of regions) {
    const rect = region.getBoundingClientRect();
    left = Math.min(left, rect.left);
    top = Math.min(top, rect.top);
    right = Math.max(right, rect.right);
    bottom = Math.max(bottom, rect.bottom);
  }
  const width = right - left;
  const height = bottom - top;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return fallback;
  }
  return { width, height };
};

function useVisibleCanvasSize(active: boolean): { width: number; height: number } {
  const [size, setSize] = useState(readVisibleCanvasSize);

  useLayoutEffect(() => {
    if (!active || typeof window === 'undefined') {
      return undefined;
    }
    const update = () => {
      const next = readVisibleCanvasSize();
      setSize((prev) => (prev.width === next.width && prev.height === next.height ? prev : next));
    };
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, [active]);

  return size;
}

export function WebEmbedLightbox(): JSX.Element | null {
  const target = useAtomValue(webEmbedLightboxTargetAtom);
  const noteId = useAtomValue(activeNoteIdAtom);
  const closeLightbox = useSetAtom(closeWebEmbedLightboxAtom);
  const openBrowserSplit = useSetAtom(openBrowserSplitAtom);
  const setPendingAgentContext = useSetAtom(pendingAgentContextAtom);
  const setPendingAgentContextIconUrl = useSetAtom(pendingAgentContextIconUrlAtom);
  const setPendingAgentContextSourceUrl = useSetAtom(pendingAgentContextSourceUrlAtom);
  const setCommandPaletteOrigin = useSetAtom(commandPaletteOriginAtom);
  const setShowCommandPalette = useSetAtom(showCommandPaletteAtom);
  const surfaceHostRef = useRef<HTMLDivElement | null>(null);
  const [surfaceReady, setSurfaceReady] = useState(false);

  const open = target !== null;
  const {
    hasSelection,
    text: selectionText,
    rect: selectionRect,
    copySelection
  } = useRemoteWebSurfaceSelection(LIGHTBOX_SURFACE_ID, open, target?.url ?? '');
  const canvasSize = useVisibleCanvasSize(open);
  const frameSize = useMemo(
    () => resolveWebEmbedLightboxSize({ canvasWidth: canvasSize.width, canvasHeight: canvasSize.height }),
    [canvasSize.width, canvasSize.height]
  );

  const isUrlSafe = useMemo(() => (target ? isSafeWebBrowserUrl(target.url) : false), [target]);
  const surfaceNoteId = target?.sourceNoteId ?? noteId;

  useEffect(() => {
    setSurfaceReady(false);
  }, [target?.url]);

  useEffect(() => {
    if (!open) {
      return undefined;
    }
    return remoteWebSurfaceApi.onNavigationState((state) => {
      if (state.id === LIGHTBOX_SURFACE_ID) {
        setSurfaceReady(true);
      }
    });
  }, [open]);

  const handleOpenInBrowser = useCallback(() => {
    if (target && isSafeWebBrowserUrl(target.url) && typeof window !== 'undefined') {
      window.open(target.url, '_blank', 'noopener,noreferrer');
    }
  }, [target]);

  const handleOpenSplit = useCallback(() => {
    if (!target || !isSafeWebBrowserUrl(target.url)) return;
    // openBrowserSplit clears the lightbox target as part of taking the slot.
    openBrowserSplit({ url: target.url, title: target.title, sourceNoteId: target.sourceNoteId ?? noteId });
  }, [noteId, openBrowserSplit, target]);

  const handleSendSelectionToAgent = useCallback((text: string, sourceUrl = target?.url ?? '') => {
    const trimmed = text.trim();
    if (!target || trimmed.length === 0 || !isSafeWebBrowserUrl(sourceUrl)) {
      return;
    }
    setPendingAgentContext(trimmed);
    setPendingAgentContextIconUrl(getBrowserContextFaviconUrl(sourceUrl));
    setPendingAgentContextSourceUrl(sourceUrl);
    setCommandPaletteOrigin('toolbar');
    closeLightbox();
    setShowCommandPalette(true);
  }, [
    closeLightbox,
    setCommandPaletteOrigin,
    setPendingAgentContext,
    setPendingAgentContextIconUrl,
    setPendingAgentContextSourceUrl,
    setShowCommandPalette,
    target
  ]);

  useEffect(() => {
    if (!open) {
      return undefined;
    }
    return remoteWebSurfaceApi.onCommandPaletteShortcut((state) => {
      if (state.id !== LIGHTBOX_SURFACE_ID) {
        return;
      }
      const context = state.selectionText.trim() || state.sourceUrl.trim();
      handleSendSelectionToAgent(context, state.sourceUrl);
    });
  }, [handleSendSelectionToAgent, open]);

  // The lightbox is portaled outside the editor, so close on Escape at the DOM
  // level (the overlay click-to-close is handled by MediaLightbox).
  useEffect(() => {
    if (!open) return undefined;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeLightbox();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [open, closeLightbox]);

  if (!target) {
    return null;
  }

  const header = (
    <TopNavBar tone="focusedSplit" appRegion="no-drag" data-web-embed-lightbox-header="true">
      <div className="relative flex h-8 min-w-0 items-center justify-start">
        <div
          className="group/tab flex h-7 min-w-0 max-w-[34rem] flex-[0_1_auto] items-center gap-1.5 rounded px-2 text-caption text-ink-faint transition-colors hover:bg-surface-note-hover/40 hover:text-ink-muted"
          data-web-embed-lightbox-url-group="true"
          title={target.url}
        >
          <span className="block min-w-0 flex-1 truncate">{target.url}</span>
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={handleOpenInBrowser}
                  aria-label="Open in system browser"
                  className="flex h-4 w-4 shrink-0 cursor-pointer items-center justify-center rounded text-ink-faint opacity-0 transition-colors hover:bg-border-subtle/60 hover:text-ink-default focus-visible:opacity-100 focus-visible:outline-none group-hover/tab:opacity-100"
                >
                  <ExternalLink aria-hidden className="h-3 w-3" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom">Open in system browser</TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>
        <div className="min-w-0 flex-1" />
        <div className="w-2 shrink-0" />
        <div className="flex shrink-0 items-center gap-1.5">
          <TopNavIconButton onClick={handleOpenSplit} aria-label="Open in split view">
            <Columns2 aria-hidden className={TOP_NAV_ICON_SIZE_CLASSNAMES.sm} />
          </TopNavIconButton>
          <TopNavIconButton onClick={() => closeLightbox()} aria-label="Close">
            <X aria-hidden className={TOP_NAV_ICON_SIZE_CLASSNAMES.sm} />
          </TopNavIconButton>
        </div>
      </div>
    </TopNavBar>
  );

  return (
    <SharedPreviewLightbox
      open={open}
      onClose={() => closeLightbox()}
      frameSize={frameSize}
      header={header}
      frameDataAttributes={{ 'data-web-embed-lightbox': 'true' }}
    >
      <div ref={surfaceHostRef} className="relative h-full w-full bg-surface-canvas">
        {isUrlSafe && surfaceNoteId ? (
          <>
            {!surfaceReady ? (
              <div
                className="absolute inset-0 flex items-center justify-center bg-surface-canvas"
                aria-hidden="true"
                data-web-embed-lightbox-loading="true"
              >
                <SproutIcon className="animate-bounce opacity-70" />
              </div>
            ) : null}
            <RemoteWebSurface
              id={LIGHTBOX_SURFACE_ID}
              noteId={surfaceNoteId}
              nodeKey="lightbox"
              mode="fullscreen"
              url={target.url}
              title={target.title}
              active={open}
              commandPaletteShortcutEnabled
              className="absolute inset-0"
              dataAttributes={{ 'data-web-embed-lightbox-live': 'true' }}
            />
            <BrowserSelectionToolbar
              hasSelection={hasSelection}
              text={selectionText}
              rect={selectionRect}
              surfaceHostRef={surfaceHostRef}
              onSendToAgent={handleSendSelectionToAgent}
              onCopy={copySelection}
            />
          </>
        ) : (
          <div
            className="flex h-full w-full flex-col items-center justify-center gap-3 px-6 text-center"
            data-web-embed-lightbox-fallback="true"
          >
            <span className="text-sm text-ink-muted">This site can&apos;t be opened inside Moss.</span>
            <SharedOpenInBrowserButton onClick={handleOpenInBrowser} />
          </div>
        )}
      </div>
    </SharedPreviewLightbox>
  );
}

export default WebEmbedLightbox;
