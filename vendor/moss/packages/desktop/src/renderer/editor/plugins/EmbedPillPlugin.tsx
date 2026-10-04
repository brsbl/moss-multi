// ported-from: packages/desktop/src/renderer/editor/plugins/EmbedPillPlugin.tsx @ 762abb777
/**
 * EmbedPillPlugin
 *
 * Owns interactions for compact web embed pills via editor-root event
 * delegation:
 *   - hover/focus on the pill text shows the rich mini card,
 *   - click or Enter/Space on the pill body opens the web embed browser surface,
 *   - right-click on the pill body opens browser actions,
 *   - click on the left link icon is ignored here because the icon copies the URL.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties, JSX } from 'react';
import { createPortal } from 'react-dom';
import { useSetAtom } from 'jotai';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { $getNodeByKey } from 'lexical';
import { Columns2, ExternalLink } from 'lucide-react';

import { useCurrentNoteId } from '../CurrentNoteIdContext';
import { $isEmbedPillNode, EmbedPillNode } from '../nodes/EmbedPillNode';
import { openBrowserSplitAtom, openWebEmbedAtom } from '@moss/shared';
import { webEmbedPreviewApi } from '../../api/electron';
import { EmbedPillHoverCard } from './EmbedPillHoverCard';
import {
  useInlinePillHoverPreview,
  type InlinePillHoverPosition
} from './useInlinePillHoverPreview';
import { isSafeWebBrowserUrl } from '../../../common/web-embed-url';

// Rich link previews use a slightly longer intent delay than lightweight
// formula/color tooltips, matching wiki-link hover cards.
const HOVER_SHOW_DELAY_MS = 300;
const HOVER_HIDE_DELAY_MS = 0;
const EAGER_WARM_VIEWPORT_MARGIN_PX = 600;

const isElementNearViewport = (element: Element): boolean => {
  if (typeof window === 'undefined' || typeof element.getBoundingClientRect !== 'function') {
    return true;
  }
  const rect = element.getBoundingClientRect();
  const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
  const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0;
  return (
    rect.bottom >= -EAGER_WARM_VIEWPORT_MARGIN_PX &&
    rect.top <= viewportHeight + EAGER_WARM_VIEWPORT_MARGIN_PX &&
    rect.right >= -EAGER_WARM_VIEWPORT_MARGIN_PX &&
    rect.left <= viewportWidth + EAGER_WARM_VIEWPORT_MARGIN_PX
  );
};

interface EmbedPillHoverTarget {
  url: string;
  displayText: string;
  position: InlinePillHoverPosition;
}

interface EmbedPillContextMenuState {
  isVisible: boolean;
  position: { x: number; y: number };
  url: string;
  displayText: string;
}

const initialContextMenuState: EmbedPillContextMenuState = {
  isVisible: false,
  position: { x: 0, y: 0 },
  url: '',
  displayText: ''
};

function EmbedPillContextMenu({
  state,
  onOpenExternalBrowser,
  onOpenSplitView,
  onClose
}: {
  state: EmbedPillContextMenuState;
  onOpenExternalBrowser: (url: string) => void;
  onOpenSplitView: (url: string, title: string) => void;
  onClose: () => void;
}): JSX.Element | null {
  const menuRef = useRef<HTMLDivElement>(null);
  const [resolvedPosition, setResolvedPosition] = useState(state.position);

  // Clamp the menu inside the viewport so a right-click near the right/bottom
  // edge doesn't push items off-screen. Measure the rendered menu and adjust
  // before the browser paints (no visible flash); a no-op in jsdom (0-sized rect).
  useLayoutEffect(() => {
    if (!state.isVisible) {
      return;
    }
    const el = menuRef.current;
    if (!el) {
      return;
    }
    const margin = 8;
    const { width, height } = el.getBoundingClientRect();
    const maxX = window.innerWidth - width - margin;
    const maxY = window.innerHeight - height - margin;
    setResolvedPosition({
      x: Math.max(margin, Math.min(state.position.x, maxX)),
      y: Math.max(margin, Math.min(state.position.y, maxY))
    });
  }, [state.isVisible, state.position.x, state.position.y]);

  useEffect(() => {
    if (!state.isVisible) return;

    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        onClose();
      }
    };
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    const handleScroll = () => onClose();

    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEscape);
    document.addEventListener('scroll', handleScroll, true);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
      document.removeEventListener('scroll', handleScroll, true);
    };
  }, [state.isVisible, onClose]);

  if (!state.isVisible) return null;

  return createPortal(
    <div
      ref={menuRef}
      className="fixed z-50 min-w-40 overflow-hidden rounded-lg border border-border-subtle bg-surface-canvas p-1 text-ink-default shadow-lg animate-in fade-in-0 zoom-in-95"
      data-embed-pill-context-menu="true"
      style={{
        left: resolvedPosition.x,
        top: resolvedPosition.y,
        WebkitAppRegion: 'no-drag'
      } as CSSProperties}
    >
      <button
        className="relative flex w-full cursor-pointer select-none items-center gap-2 rounded-md px-2 py-1.5 text-left text-micro outline-none transition-colors hover:bg-accent-brand/10 hover:text-accent-brand-pressed"
        onClick={() => {
          onOpenExternalBrowser(state.url);
          onClose();
        }}
      >
        <ExternalLink className="h-3.5 w-3.5 text-ink-muted" />
        <span>Open in External Browser</span>
      </button>
      <div className="my-1 h-px bg-border-subtle" />
      <button
        className="relative flex w-full cursor-pointer select-none items-center gap-2 rounded-md px-2 py-1.5 text-left text-micro outline-none transition-colors hover:bg-accent-brand/10 hover:text-accent-brand-pressed"
        onClick={() => {
          onOpenSplitView(state.url, state.displayText);
          onClose();
        }}
      >
        <Columns2 className="h-3.5 w-3.5 text-ink-muted" />
        <span>Open in Split View</span>
      </button>
    </div>,
    document.body
  );
}

export function EmbedPillPlugin({ readOnly = false }: { readOnly?: boolean } = {}): JSX.Element | null {
  const [editor] = useLexicalComposerContext();
  const noteId = useCurrentNoteId();
  const openWebEmbed = useSetAtom(openWebEmbedAtom);
  const openBrowserSplit = useSetAtom(openBrowserSplitAtom);
  const [hoverTarget, setHoverTarget] = useState<EmbedPillHoverTarget | null>(null);
  const [contextMenuState, setContextMenuState] = useState<EmbedPillContextMenuState>(
    initialContextMenuState
  );
  const warmedPreviewKeysRef = useRef<Set<string>>(new Set());
  const previewStatusByKeyRef = useRef<Map<string, string>>(new Map());

  const previewCacheKey = useCallback(
    (url: string): string | null => (noteId ? `${noteId}\u0000${url}` : null),
    [noteId]
  );

  const warmPreview = useCallback((url: string) => {
    if (!noteId) {
      return;
    }
    const cacheKey = previewCacheKey(url);
    if (!cacheKey) {
      return;
    }
    if (warmedPreviewKeysRef.current.has(cacheKey)) {
      return;
    }
    warmedPreviewKeysRef.current.add(cacheKey);
    void webEmbedPreviewApi.ensure.invoke({ noteId, url })
      .then((result) => {
        if (result?.status) {
          previewStatusByKeyRef.current.set(cacheKey, result.status);
        }
      })
      .catch(() => undefined);
  }, [noteId, previewCacheKey]);

  const refreshFailedPreviewOnOpen = useCallback((url: string) => {
    if (!noteId) {
      return;
    }
    const cacheKey = previewCacheKey(url);
    if (!cacheKey) {
      return;
    }
    const maybeForce = (status: unknown): void => {
      if (status === 'fallback' || status === 'failed') {
        void webEmbedPreviewApi.ensure.invoke({ noteId, url, force: true })
          .then((result) => {
            if (result?.status) {
              previewStatusByKeyRef.current.set(cacheKey, result.status);
            }
          })
          .catch(() => undefined);
      }
    };

    const knownStatus = previewStatusByKeyRef.current.get(cacheKey);
    if (knownStatus) {
      maybeForce(knownStatus);
      return;
    }

    void webEmbedPreviewApi.ensure.invoke({ noteId, url })
      .then((result) => {
        if (result?.status) {
          previewStatusByKeyRef.current.set(cacheKey, result.status);
          maybeForce(result.status);
        }
      })
      .catch(() => undefined);
  }, [noteId, previewCacheKey]);

  const handleHoverShow = useCallback(
    ({ nodeKey, position }: { nodeKey: string; position: InlinePillHoverPosition }) => {
      let next: EmbedPillHoverTarget | null = null;
      editor.getEditorState().read(() => {
        const node = $getNodeByKey(nodeKey);
        if ($isEmbedPillNode(node)) {
          next = { url: node.getUrl(), displayText: node.getDisplayText(), position };
        }
      });
      if (next) setHoverTarget(next);
    },
    [editor]
  );

  const handleHoverHide = useCallback(() => setHoverTarget(null), []);

  const { clear: clearHoverPreview } = useInlinePillHoverPreview({
    editor,
    nodeKeyAttribute: 'data-embed-pill-hover-node-key',
    anchorSelector: '[data-embed-pill-node-key]',
    showDelayMs: HOVER_SHOW_DELAY_MS,
    hideDelayMs: HOVER_HIDE_DELAY_MS,
    enableFocus: true,
    isPreviewPopover: () => false,
    onShow: handleHoverShow,
    onHide: handleHoverHide
  });

  const openWebEmbedForNode = useCallback(
    (nodeKey: string) => {
      clearHoverPreview();
      let url: string | null = null;
      editor.getEditorState().read(() => {
        const node = $getNodeByKey(nodeKey);
        if ($isEmbedPillNode(node)) {
          url = node.getUrl();
        }
      });
      if (url && isSafeWebBrowserUrl(url)) {
        refreshFailedPreviewOnOpen(url);
        openWebEmbed({ url, sourceNoteId: noteId });
      }
    },
    [editor, clearHoverPreview, noteId, openWebEmbed, refreshFailedPreviewOnOpen]
  );

  const closeContextMenu = useCallback(() => {
    setContextMenuState(initialContextMenuState);
  }, []);

  const handleOpenExternalBrowser = useCallback((url: string) => {
    if (typeof window !== 'undefined' && isSafeWebBrowserUrl(url)) {
      refreshFailedPreviewOnOpen(url);
      window.open(url, '_blank', 'noopener,noreferrer');
    }
  }, [refreshFailedPreviewOnOpen]);

  const handleOpenSplitView = useCallback(
    (url: string, title: string) => {
      if (isSafeWebBrowserUrl(url)) {
        refreshFailedPreviewOnOpen(url);
        openBrowserSplit({ url, title, sourceNoteId: noteId });
      }
    },
    [noteId, openBrowserSplit, refreshFailedPreviewOnOpen]
  );

  useEffect(() => {
    warmedPreviewKeysRef.current.clear();
    previewStatusByKeyRef.current.clear();
    // Read-only panes (agent diff / comment / preview, PDF export) must issue
    // ZERO preview-ensure IPC on mount: skip the eager note-wide warm and the
    // mutation-listener warming entirely. Hovering a pill still warms lazily via
    // the hover card, so the rich preview stays available on deliberate intent.
    if (readOnly || !noteId) {
      return undefined;
    }

    const observed = new WeakSet<Element>();

    const warmPillElement = (element: Element): void => {
      const nodeKey = element.getAttribute('data-embed-pill-node-key');
      if (!nodeKey) {
        return;
      }
      editor.getEditorState().read(() => {
        const node = $getNodeByKey(nodeKey);
        if ($isEmbedPillNode(node)) {
          warmPreview(node.getUrl());
        }
      });
    };

    // Mirror the card path (WebEmbedNode's useIsNearViewport, 600px rootMargin):
    // only pills within / near the viewport warm eagerly, so opening a note full
    // of pills does not fan out an ensure fetch per off-screen pill on mount.
    // Off-screen pills warm when they scroll into view (or on hover).
    const observer =
      typeof IntersectionObserver !== 'undefined'
        ? new IntersectionObserver(
            (entries, obs) => {
              for (const entry of entries) {
                if (!entry.isIntersecting || !entry.target) {
                  continue;
                }
                obs.unobserve(entry.target);
                warmPillElement(entry.target);
              }
            },
            { rootMargin: '600px' }
          )
        : null;

    const scanPills = (): void => {
      const rootElement = editor.getRootElement();
      if (!rootElement) {
        return;
      }
      rootElement.querySelectorAll('[data-embed-pill-node-key]').forEach((element) => {
        if (observed.has(element)) {
          return;
        }
        observed.add(element);
        if (isElementNearViewport(element)) {
          warmPillElement(element);
          return;
        }
        if (observer) {
          observer.observe(element);
        } else {
          // No IntersectionObserver (e.g. a non-DOM host): fall back to the card
          // path's behavior and warm directly. Read-only panes already returned
          // above, so this never fires for export / diff panes.
          warmPillElement(element);
        }
      });
    };

    // Existing pill decorator DOM is mounted by the time this passive effect
    // runs, so scan it now. Newly created / updated pills (e.g. a pasted URL)
    // mount their decorator DOM after the commit, so re-scan on the next frame.
    scanPills();

    let scheduledScan: ReturnType<typeof requestAnimationFrame> | null = null;
    const timeoutScans: ReturnType<typeof setTimeout>[] = [];
    const scheduleScan = (): void => {
      if (typeof requestAnimationFrame === 'undefined') {
        scanPills();
        return;
      }
      if (scheduledScan !== null) {
        return;
      }
      scheduledScan = requestAnimationFrame(() => {
        scheduledScan = null;
        scanPills();
      });
    };

    const scheduleDelayedScan = (delayMs: number): void => {
      timeoutScans.push(
        setTimeout(() => {
          scheduleScan();
        }, delayMs)
      );
    };

    const unsubscribeMutations = editor.registerMutationListener(EmbedPillNode, (mutations) => {
      let relevant = false;
      for (const [, mutation] of mutations) {
        if (mutation === 'created' || mutation === 'updated') {
          relevant = true;
          break;
        }
      }
      if (!relevant) {
        return;
      }
      scheduleScan();
    });

    // Nested surfaces (tabs, callouts, tables) can mount or reveal their
    // decorator DOM after this plugin's first passive effect. A short burst of
    // viewport-gated scans catches those visible pills without returning to the
    // old note-wide eager warming behavior for off-screen content.
    scheduleScan();
    scheduleDelayedScan(250);
    scheduleDelayedScan(750);
    scheduleDelayedScan(1500);

    const rootElement = editor.getRootElement();
    const handleViewportScan = (): void => scheduleScan();
    rootElement?.addEventListener('scroll', handleViewportScan, true);
    window.addEventListener('scroll', handleViewportScan, true);
    window.addEventListener('resize', handleViewportScan);
    document.addEventListener('visibilitychange', handleViewportScan);
    document.addEventListener('focusin', handleViewportScan);

    return () => {
      if (scheduledScan !== null && typeof cancelAnimationFrame !== 'undefined') {
        cancelAnimationFrame(scheduledScan);
      }
      scheduledScan = null;
      timeoutScans.forEach((id) => clearTimeout(id));
      rootElement?.removeEventListener('scroll', handleViewportScan, true);
      window.removeEventListener('scroll', handleViewportScan, true);
      window.removeEventListener('resize', handleViewportScan);
      document.removeEventListener('visibilitychange', handleViewportScan);
      document.removeEventListener('focusin', handleViewportScan);
      observer?.disconnect();
      unsubscribeMutations();
    };
  }, [editor, noteId, readOnly, warmPreview]);

  useEffect(() => {
    const pillFromEvent = (event: Event): HTMLElement | null =>
      (event.target as HTMLElement | null)?.closest('[data-embed-pill-node-key]') as HTMLElement | null;

    const isCopyIconEvent = (event: Event): boolean =>
      Boolean((event.target as HTMLElement | null)?.closest('[data-embed-pill-copy-node-key]'));

    const bodyNodeKeyFromEvent = (event: Event): string | null => {
      const body = (event.target as HTMLElement | null)?.closest(
        '[data-embed-pill-hover-node-key]'
      ) as HTMLElement | null;
      return body?.getAttribute('data-embed-pill-hover-node-key') ?? null;
    };

    const selectAfterPill = (nodeKey: string): void => {
      editor.update(() => {
        const node = $getNodeByKey(nodeKey);
        if ($isEmbedPillNode(node)) {
          node.selectNext(0, 0);
        }
      });
      editor.focus();
    };

    const handleClick = (event: MouseEvent) => {
      if (isCopyIconEvent(event)) return;
      const pill = pillFromEvent(event);
      if (!pill) return;
      const nodeKey = pill.getAttribute('data-embed-pill-node-key');
      if (!nodeKey) return;
      event.preventDefault();
      event.stopPropagation();
      const bodyNodeKey = bodyNodeKeyFromEvent(event);
      if (bodyNodeKey === nodeKey) {
        openWebEmbedForNode(nodeKey);
        return;
      }
      selectAfterPill(nodeKey);
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Enter' && event.key !== ' ' && event.key !== 'Spacebar') return;
      const pill = pillFromEvent(event);
      if (!pill || isCopyIconEvent(event)) return;
      const nodeKey = pill.getAttribute('data-embed-pill-node-key');
      if (!nodeKey) return;
      event.preventDefault();
      event.stopPropagation();
      openWebEmbedForNode(nodeKey);
    };

    const handleContextMenu = (event: MouseEvent) => {
      if (isCopyIconEvent(event)) return;
      const pill = pillFromEvent(event);
      if (!pill) return;
      const nodeKey = pill.getAttribute('data-embed-pill-node-key');
      if (!nodeKey) return;

      let nextUrl: string | null = null;
      let nextDisplayText = '';
      editor.getEditorState().read(() => {
        const node = $getNodeByKey(nodeKey);
        if ($isEmbedPillNode(node)) {
          nextUrl = node.getUrl();
          nextDisplayText = node.getDisplayText();
        }
      });
      if (!nextUrl) return;

      event.preventDefault();
      event.stopPropagation();
      clearHoverPreview();
      setContextMenuState({
        isVisible: true,
        position: { x: event.clientX, y: event.clientY },
        url: nextUrl,
        displayText: nextDisplayText
      });
    };

    const attach = (rootElement: HTMLElement): void => {
      rootElement.addEventListener('click', handleClick);
      rootElement.addEventListener('keydown', handleKeyDown);
      rootElement.addEventListener('contextmenu', handleContextMenu);
    };

    const detach = (rootElement: HTMLElement): void => {
      rootElement.removeEventListener('click', handleClick);
      rootElement.removeEventListener('keydown', handleKeyDown);
      rootElement.removeEventListener('contextmenu', handleContextMenu);
    };

    return editor.registerRootListener((rootElement, previousRootElement) => {
      if (previousRootElement) detach(previousRootElement);
      if (rootElement) attach(rootElement);
    });
  }, [editor, clearHoverPreview, openWebEmbedForNode]);

  return (
    <>
      {hoverTarget ? (
        <EmbedPillHoverCard
          noteId={noteId}
          url={hoverTarget.url}
          displayText={hoverTarget.displayText}
          position={hoverTarget.position}
        />
      ) : null}
      <EmbedPillContextMenu
        state={contextMenuState}
        onOpenExternalBrowser={handleOpenExternalBrowser}
        onOpenSplitView={handleOpenSplitView}
        onClose={closeContextMenu}
      />
    </>
  );
}

export default EmbedPillPlugin;
