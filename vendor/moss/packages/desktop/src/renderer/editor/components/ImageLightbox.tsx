// ported-from: packages/desktop/src/renderer/editor/components/ImageLightbox.tsx @ 762abb777
import { useCallback, useEffect, type RefObject } from 'react';
import { useAtom } from 'jotai';
import { atom } from 'jotai';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { MediaLightbox } from './media-primitives';

export const GLOBAL_LIGHTBOX_SCOPE = 'global';
export const CANVAS_LIGHTBOX_SCOPE_ATTR = 'data-moss-lightbox-scope';

export type LightboxScope = typeof GLOBAL_LIGHTBOX_SCOPE | `canvas:${string}`;

type ScopedLightboxState = {
  scope?: LightboxScope;
};

export type LightboxState =
  | null
  | ({ kind: 'image'; src: string } & ScopedLightboxState)
  | ({ kind: 'carousel'; sources: string[]; index: number } & ScopedLightboxState);

export const lightboxSrcAtom = atom<LightboxState>(null);

const NAV_BUTTON_CLASSNAME =
  'flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-surface-panel bg-surface-raised-control text-ink-muted shadow-sm transition-colors hover:bg-surface-canvas hover:text-ink-default';

export const getCanvasLightboxScope = (paneId?: 'left' | 'right'): LightboxScope =>
  `canvas:${paneId ?? 'single'}`;

type AnchorLikeRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export function resolveCanvasLightboxScope(anchorRect: AnchorLikeRect | null): LightboxScope | undefined {
  if (typeof document === 'undefined' || !anchorRect) {
    return undefined;
  }

  const canvasElements = Array.from(
    document.querySelectorAll<HTMLElement>(`[${CANVAS_LIGHTBOX_SCOPE_ATTR}]`)
  );
  if (canvasElements.length === 0) {
    return undefined;
  }

  const centerX = anchorRect.x + anchorRect.width / 2;
  const centerY = anchorRect.y + anchorRect.height / 2;
  const containing = canvasElements.find((element) => {
    const rect = element.getBoundingClientRect();
    return centerX >= rect.left && centerX <= rect.right && centerY >= rect.top && centerY <= rect.bottom;
  });
  const scopedElement = containing ?? (canvasElements.length === 1 ? canvasElements[0] : null);
  const scope = scopedElement?.getAttribute(CANVAS_LIGHTBOX_SCOPE_ATTR);
  return scope ? scope as LightboxScope : undefined;
}

type ImageLightboxProps = {
  scope?: LightboxScope;
  anchorRef?: RefObject<HTMLElement | null>;
};

export function ImageLightbox({
  scope = GLOBAL_LIGHTBOX_SCOPE,
  anchorRef,
}: ImageLightboxProps = {}) {
  const [state, setState] = useAtom(lightboxSrcAtom);
  const targetScope = state?.scope ?? GLOBAL_LIGHTBOX_SCOPE;
  const isActiveScope = !!state && targetScope === scope;

  const close = useCallback(() => {
    setState(null);
  }, [setState]);

  // goTo takes an ABSOLUTE target index and wraps it. Using an absolute target
  // (rather than a prev-based delta) keeps navigation idempotent if scoped
  // lightbox instances overlap briefly during pane remounts.
  const goTo = useCallback((targetIndex: number) => {
    setState((prev) => {
      if (!prev || prev.kind !== 'carousel') return prev;
      const count = prev.sources.length;
      if (count === 0) return prev;
      const wrapped = ((targetIndex % count) + count) % count;
      if (wrapped === prev.index) return prev;
      return { ...prev, index: wrapped };
    });
  }, [setState]);

  useEffect(() => {
    if (!isActiveScope || !state) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        close();
        return;
      }
      if (state.kind === 'carousel' && state.sources.length > 1) {
        if (e.key === 'ArrowLeft') {
          e.preventDefault();
          goTo(state.index - 1);
        } else if (e.key === 'ArrowRight') {
          e.preventDefault();
          goTo(state.index + 1);
        }
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isActiveScope, state, close, goTo]);

  if (!state) return null;

  if (!isActiveScope) {
    return null;
  }

  if (state.kind === 'carousel') {
    const { sources, index } = state;
    const count = sources.length;
    if (count === 0) return null;
    const safeIndex = Math.min(Math.max(index, 0), count - 1);
    const hasMultiple = count > 1;

    return (
      <MediaLightbox open onClose={close} anchorRef={anchorRef}>
        <div className="flex items-center justify-center gap-3">
          {hasMultiple && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                goTo(safeIndex - 1);
              }}
              className={NAV_BUTTON_CLASSNAME}
              aria-label="Previous image"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
          )}
          <div className="flex flex-col items-center">
            <img
              src={sources[safeIndex]}
              alt=""
              className="block max-h-[90vh] w-auto max-w-full object-contain"
              draggable={false}
            />
            {hasMultiple && (
              <span className="mt-2 rounded-full bg-ink-default/60 px-2 py-0.5 text-xs text-ink-inverse">
                {safeIndex + 1} / {count}
              </span>
            )}
          </div>
          {hasMultiple && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                goTo(safeIndex + 1);
              }}
              className={NAV_BUTTON_CLASSNAME}
              aria-label="Next image"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          )}
        </div>
      </MediaLightbox>
    );
  }

  return (
    <MediaLightbox open={state !== null} onClose={close} anchorRef={anchorRef}>
      <img
        src={state.src}
        alt=""
        className="mx-auto block max-h-[90vh] w-auto max-w-full object-contain"
        draggable={false}
      />
    </MediaLightbox>
  );
}
