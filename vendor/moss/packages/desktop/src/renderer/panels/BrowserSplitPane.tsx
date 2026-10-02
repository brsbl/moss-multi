// ported-from: packages/desktop/src/renderer/panels/BrowserSplitPane.tsx @ 762abb777
/**
 * Browser split tab.
 *
 * The split slot can hold either a note (`CanvasAreaContent`) or a browser — this
 * is the browser variant. It reuses the existing split-pane chrome but with a
 * simplified browser header: back/forward, an editable URL input to navigate
 * like a normal browser, an "open in system browser" escape (for auth-heavy or
 * unsupported sites), and a close control. The page itself is a native
 * `RemoteWebSurface` (WebContentsView) with scrollbars clipped in the main
 * process.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { CSSProperties, FormEvent, JSX } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { Bot, ChevronLeft, ChevronRight, ExternalLink, Search, X } from 'lucide-react';
import {
  activeNoteIdAtom,
  browserSplitCanGoBackAtom,
  browserSplitCanGoForwardAtom,
  browserSplitCurrentUrlAtom,
  browserSplitFocusRequestIdAtom,
  browserSplitNavigationRequestIdAtom,
  browserSplitTargetAtom,
  commandPaletteOriginAtom,
  focusedPaneAtom,
  navigateBrowserSplitAtom,
  pendingAgentContextAtom,
  pendingAgentContextIconUrlAtom,
  pendingAgentContextSourceUrlAtom,
  setFocusPaneAtom,
  showCommandPaletteAtom,
  syncBrowserSplitNavigationStateAtom
} from '@moss/shared';
import { SproutIcon } from '@moss/shared/components/brand/SproutIcon';
import { cn } from '@moss/shared/lib/utils';

import { isSafeWebBrowserUrl, normalizeWebBrowserUrl } from '../../common/web-embed-url';
import { remoteWebSurfaceApi, webEmbedPreviewApi } from '../api/electron';
import { SearchToolbarInput } from '../components/SearchToolbarInput';
import { RemoteWebSurface } from '../editor/preview/RemoteWebSurface';
import { useRemoteWebSurfaceSelection } from '../editor/preview/useRemoteWebSurfaceSelection';
import { toDisplaySrc } from '../editor/utils/asset-url';
import { TopNavBar, TopNavIconButton, TOP_NAV_ICON_SIZE_CLASSNAMES } from './TopNavControls';

const SPLIT_SURFACE_ID = 'web-embed:browser-split';

/** sr-only description announced for the disabled "Send page to Agent" button in full-pane. */
const SEND_TO_AGENT_UNAVAILABLE_DESC_ID = 'browser-split-send-to-agent-unavailable';

function BrowserTopNavDivider(): JSX.Element {
  return <div aria-hidden="true" className="h-4 w-px shrink-0 bg-border-subtle/80" />;
}

/** Coerce a typed address into a safe browser url (adding the scheme if omitted). */
const coerceToBrowserUrl = (raw: string): string | null => {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return null;
  }
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed);
  const likelyLocalhost = /^(localhost|[^/\s]+\.localhost|127(?:\.\d{1,3}){0,3}|\[::1\])(?::|\/|$)/i.test(trimmed);
  const candidate = hasScheme ? trimmed : `${likelyLocalhost ? 'http' : 'https'}://${trimmed}`;
  const normalized = normalizeWebBrowserUrl(candidate);
  if (!normalized || !isSafeWebBrowserUrl(normalized)) {
    return null;
  }
  return normalized;
};

const getCachedBrowserContextIconUrl = async (
  noteId: string | null,
  rawUrl: string
): Promise<string | null> => {
  if (!noteId) {
    return null;
  }
  try {
    const result = await webEmbedPreviewApi.ensure.invoke({ noteId, url: rawUrl });
    const iconPath = result?.metadata?.siteIconAssetRelativePath;
    return typeof iconPath === 'string' && iconPath.trim().length > 0
      ? toDisplaySrc(iconPath.trim(), noteId)
      : null;
  } catch {
    return null;
  }
};

const browserContextIconCacheKey = (noteId: string | null, rawUrl: string): string | null =>
  noteId ? `${noteId}\u0000${rawUrl}` : null;

const shouldUsePageNativeFind = (rawUrl: string): boolean => {
  try {
    const parsed = new URL(rawUrl);
    return parsed.hostname === 'docs.google.com' && parsed.pathname.startsWith('/spreadsheets/');
  } catch {
    return false;
  }
};

export function BrowserSplitPane({
  onClose,
  fullPane = false
}: {
  onClose: () => void;
  /**
   * Whether the browser split owns the whole canvas (the left note tab was
   * closed). In full-pane the command palette has no note-pane anchor and would
   * render behind the native WebContentsView, so the "Send page to Agent"
   * affordance is shown disabled instead of opening a palette over the surface.
   */
  fullPane?: boolean;
}): JSX.Element | null {
  const target = useAtomValue(browserSplitTargetAtom);
  const currentUrl = useAtomValue(browserSplitCurrentUrlAtom);
  const focusRequestId = useAtomValue(browserSplitFocusRequestIdAtom);
  const navigationRequestId = useAtomValue(browserSplitNavigationRequestIdAtom);
  const activeNoteId = useAtomValue(activeNoteIdAtom);
  const focusedPane = useAtomValue(focusedPaneAtom);
  const canGoBack = useAtomValue(browserSplitCanGoBackAtom);
  const canGoForward = useAtomValue(browserSplitCanGoForwardAtom);
  const navigate = useSetAtom(navigateBrowserSplitAtom);
  const syncNavigationState = useSetAtom(syncBrowserSplitNavigationStateAtom);
  const setPendingAgentContext = useSetAtom(pendingAgentContextAtom);
  const setPendingAgentContextIconUrl = useSetAtom(pendingAgentContextIconUrlAtom);
  const setPendingAgentContextSourceUrl = useSetAtom(pendingAgentContextSourceUrlAtom);
  const setFocusPane = useSetAtom(setFocusPaneAtom);
  const setCommandPaletteOrigin = useSetAtom(commandPaletteOriginAtom);
  const setShowCommandPalette = useSetAtom(showCommandPaletteAtom);
  const showCommandPalette = useAtomValue(showCommandPaletteAtom);

  const requestedUrl = target?.url ?? '';
  const browserUrl = currentUrl || requestedUrl;
  const usePageNativeFind = shouldUsePageNativeFind(browserUrl);
  const stableSurfaceNoteIdRef = useRef<string | null>(null);
  if (!target) {
    stableSurfaceNoteIdRef.current = null;
  } else if (target.sourceNoteId) {
    stableSurfaceNoteIdRef.current = target.sourceNoteId;
  } else if (!stableSurfaceNoteIdRef.current && activeNoteId) {
    stableSurfaceNoteIdRef.current = activeNoteId;
  }
  const surfaceNoteId = target ? stableSurfaceNoteIdRef.current : null;
  const inputRef = useRef<HTMLInputElement | null>(null);
  const addressGroupRef = useRef<HTMLDivElement | null>(null);
  const findInputRef = useRef<HTMLInputElement | null>(null);
  const contextIconRequestSerialRef = useRef(0);
  const browserContextIconCacheRef = useRef<Map<string, string>>(new Map());
  const [showFind, setShowFind] = useState(false);
  const findSerialRef = useRef(0);
  const activeFindRequestIdRef = useRef<number | null>(null);
  const showFindRef = useRef(showFind);
  const [isEditingAddress, setIsEditingAddress] = useState(false);
  const [findQuery, setFindQuery] = useState('');
  const [findMatches, setFindMatches] = useState(0);
  const [findActiveOrdinal, setFindActiveOrdinal] = useState(0);
  const [surfaceReady, setSurfaceReady] = useState(false);
  const isPaneFocused = focusedPane === 'right';
  // Selection lives in the native browser surface. Actions render in browser
  // chrome because renderer overlays cannot reliably float above WebContentsView.
  const {
    hasSelection,
    text: selectionText
  } = useRemoteWebSurfaceSelection(SPLIT_SURFACE_ID, true, browserUrl);
  const trimmedSelectionText = selectionText.trim();

  const handleSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const next = coerceToBrowserUrl(inputRef.current?.value ?? '');
      if (next) {
        navigate({ url: next });
        setIsEditingAddress(false);
      } else if (inputRef.current) {
        // Reject clearly: restore the current address rather than navigating.
        inputRef.current.value = browserUrl;
        setIsEditingAddress(false);
      }
    },
    [browserUrl, navigate]
  );

  const handleOpenInBrowser = useCallback(() => {
    if (browserUrl && typeof window !== 'undefined') {
      window.open(browserUrl, '_blank', 'noopener,noreferrer');
    }
  }, [browserUrl]);

  useEffect(() => {
    showFindRef.current = showFind;
  }, [showFind]);

  const clearBrowserFind = useCallback(() => {
    findSerialRef.current += 1;
    activeFindRequestIdRef.current = null;
    setFindMatches(0);
    setFindActiveOrdinal(0);
    void remoteWebSurfaceApi.stopFindInPage.invoke({ id: SPLIT_SURFACE_ID });
  }, []);

  const restoreFindInputFocus = useCallback(() => {
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        if (!showFindRef.current) {
          return;
        }
        findInputRef.current?.focus();
      });
    });
  }, []);

  const openBrowserFind = useCallback(() => {
    if (usePageNativeFind) {
      clearBrowserFind();
      setFindQuery('');
      setShowFind(false);
      void remoteWebSurfaceApi.openPageFind.invoke({ id: SPLIT_SURFACE_ID });
      return;
    }
    setIsEditingAddress(false);
    clearBrowserFind();
    setFindQuery('');
    setShowFind(true);
    restoreFindInputFocus();
  }, [clearBrowserFind, restoreFindInputFocus, usePageNativeFind]);

  const runFind = useCallback((text: string, findNext = false, forward = true) => {
    const serial = findSerialRef.current + 1;
    findSerialRef.current = serial;
    activeFindRequestIdRef.current = null;
    const query = text.trim();
    if (query.length === 0) {
      clearBrowserFind();
      return;
    }
    void remoteWebSurfaceApi.findInPage.invoke({
      id: SPLIT_SURFACE_ID,
      text: query,
      findNext,
      forward
    }).then((result) => {
      if (findSerialRef.current !== serial || !showFindRef.current || !result.ok) {
        return;
      }
      activeFindRequestIdRef.current =
        typeof result.requestId === 'number' ? result.requestId : null;
    }).finally(() => {
      restoreFindInputFocus();
    });
  }, [clearBrowserFind, restoreFindInputFocus]);

  const handleFindQueryChange = useCallback((next: string) => {
    setFindQuery(next);
    runFind(next);
  }, [runFind]);

  const handleCloseFind = useCallback(() => {
    setShowFind(false);
    setFindQuery('');
    clearBrowserFind();
  }, [clearBrowserFind]);

  const handleBrowserFocus = useCallback(() => {
    setFocusPane('right');
    if (!showCommandPalette) {
      return;
    }
    setShowCommandPalette(false);
    setPendingAgentContext(null);
    setPendingAgentContextIconUrl(null);
    setPendingAgentContextSourceUrl(null);
  }, [
    setFocusPane,
    setPendingAgentContext,
    setPendingAgentContextIconUrl,
    setPendingAgentContextSourceUrl,
    setShowCommandPalette,
    showCommandPalette
  ]);

  const handleSendBrowserContextToAgent = useCallback((shortcutContext?: {
    selectionText: string;
    sourceUrl: string;
  }) => {
    // No command-palette trigger over the full-pane native surface: the palette
    // has no note-pane anchor and would render behind the WebContentsView.
    if (fullPane) {
      return;
    }
    const url = shortcutContext?.sourceUrl.trim() || browserUrl.trim();
    if (url.length === 0) {
      return;
    }
    setIsEditingAddress(false);
    if (showFindRef.current) {
      handleCloseFind();
    }
    const shortcutSelectionText = shortcutContext?.selectionText.trim() ?? '';
    const nextHasSelection = shortcutContext
      ? shortcutSelectionText.length > 0
      : hasSelection && trimmedSelectionText.length > 0;
    const nextContext = nextHasSelection
      ? shortcutContext ? shortcutSelectionText : trimmedSelectionText
      : url;
    const iconRequestSerial = contextIconRequestSerialRef.current + 1;
    contextIconRequestSerialRef.current = iconRequestSerial;
    const iconCacheKey = browserContextIconCacheKey(surfaceNoteId, url);
    setPendingAgentContext(nextContext);
    setPendingAgentContextIconUrl(iconCacheKey ? browserContextIconCacheRef.current.get(iconCacheKey) ?? null : null);
    setPendingAgentContextSourceUrl(url);
    setCommandPaletteOrigin('toolbar');
    setShowCommandPalette(true);
    void getCachedBrowserContextIconUrl(surfaceNoteId, url).then((iconUrl) => {
      if (!iconUrl || contextIconRequestSerialRef.current !== iconRequestSerial) {
        return;
      }
      setPendingAgentContextIconUrl(iconUrl);
    });
  }, [
    fullPane,
    handleCloseFind,
    hasSelection,
    setCommandPaletteOrigin,
    setPendingAgentContext,
    setPendingAgentContextIconUrl,
    setPendingAgentContextSourceUrl,
    setShowCommandPalette,
    surfaceNoteId,
    browserUrl,
    trimmedSelectionText
  ]);

  useEffect(() => {
    const url = browserUrl.trim();
    const iconCacheKey = browserContextIconCacheKey(surfaceNoteId, url);
    if (!surfaceNoteId || !iconCacheKey || url.length === 0) {
      return;
    }
    const iconRequestSerial = contextIconRequestSerialRef.current + 1;
    contextIconRequestSerialRef.current = iconRequestSerial;
    void getCachedBrowserContextIconUrl(surfaceNoteId, url).then((iconUrl) => {
      if (!iconUrl || contextIconRequestSerialRef.current !== iconRequestSerial) {
        return;
      }
      browserContextIconCacheRef.current.set(iconCacheKey, iconUrl);
      if (showCommandPalette) {
        setPendingAgentContextIconUrl(iconUrl);
      }
    });
  }, [browserUrl, setPendingAgentContextIconUrl, showCommandPalette, surfaceNoteId]);

  useEffect(() => {
    if (showFind) {
      window.requestAnimationFrame(() => findInputRef.current?.focus());
    }
  }, [showFind]);

  useEffect(() => {
    return remoteWebSurfaceApi.onFindShortcut((state) => {
      if (state.id !== SPLIT_SURFACE_ID) {
        return;
      }
      openBrowserFind();
    });
  }, [openBrowserFind]);

  useEffect(() => {
    return remoteWebSurfaceApi.onCommandPaletteShortcut((state) => {
      if (state.id !== SPLIT_SURFACE_ID) {
        return;
      }
      handleSendBrowserContextToAgent(state);
    });
  }, [handleSendBrowserContextToAgent]);

  useEffect(() => {
    return remoteWebSurfaceApi.onFocused((state) => {
      if (state.id !== SPLIT_SURFACE_ID) {
        return;
      }
      handleBrowserFocus();
    });
  }, [handleBrowserFocus]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        event.key.toLocaleLowerCase() !== 'f' ||
        (!event.metaKey && !event.ctrlKey) ||
        event.altKey ||
        event.shiftKey
      ) {
        return;
      }
      // Only intercept Cmd/Ctrl+F when the browser owns the canvas (full-pane) or
      // the browser pane is focused. When the note pane is focused in a split,
      // let the event bubble to the app's note search (App.tsx) instead of
      // hijacking it — this capture-phase listener would otherwise swallow note
      // find whenever the split browser is open.
      if (!fullPane && !isPaneFocused) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      openBrowserFind();
    };
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [fullPane, isPaneFocused, openBrowserFind]);

  useEffect(() => {
    setSurfaceReady(false);
  }, [navigationRequestId, requestedUrl]);

  useEffect(() => {
    return remoteWebSurfaceApi.onNavigationState((state) => {
      if (state.id !== SPLIT_SURFACE_ID) {
        return;
      }
      setSurfaceReady(true);
      syncNavigationState(state);
    });
  }, [syncNavigationState]);

  useEffect(() => {
    return remoteWebSurfaceApi.onFindResult((state) => {
      if (state.id !== SPLIT_SURFACE_ID) {
        return;
      }
      const activeRequestId = activeFindRequestIdRef.current;
      if (!showFindRef.current || (activeRequestId !== null && state.requestId !== activeRequestId)) {
        return;
      }
      if (activeRequestId === null) {
        activeFindRequestIdRef.current = state.requestId;
      }
      setFindMatches(state.matches);
      setFindActiveOrdinal(state.activeMatchOrdinal);
    });
  }, []);

  useEffect(() => {
    if (isEditingAddress) {
      window.requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      });
    }
  }, [isEditingAddress]);

  useEffect(() => {
    if (focusRequestId === 0) {
      return;
    }
    const frame = window.requestAnimationFrame(() => {
      const focusTarget = inputRef.current ?? addressGroupRef.current;
      focusTarget?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [focusRequestId]);

  const handleGoBack = useCallback(() => {
    void remoteWebSurfaceApi.goBack.invoke({ id: SPLIT_SURFACE_ID });
  }, []);

  const handleGoForward = useCallback(() => {
    void remoteWebSurfaceApi.goForward.invoke({ id: SPLIT_SURFACE_ID });
  }, []);

  if (!target) {
    return null;
  }

  return (
    <div
      className="flex h-full w-full min-w-0 flex-col overflow-hidden bg-surface-canvas"
      data-browser-split-pane="true"
      onFocusCapture={handleBrowserFocus}
      onPointerDown={handleBrowserFocus}
    >
      <TopNavBar tone={isPaneFocused ? 'focusedSplit' : 'inactiveSplit'} appRegion="drag">
        <div
          className="relative flex h-8 min-w-0 items-center justify-start"
          data-browser-header-content="true"
        >
          <div
            className="flex shrink-0 items-center gap-1"
            style={{ WebkitAppRegion: 'no-drag' } as CSSProperties}
          >
            <TopNavIconButton
              onClick={handleGoBack}
              disabled={!canGoBack}
              tone="default"
              aria-label="Go back"
            >
              <ChevronLeft aria-hidden className={cn(TOP_NAV_ICON_SIZE_CLASSNAMES.md, 'shrink-0')} />
            </TopNavIconButton>
            <TopNavIconButton
              onClick={handleGoForward}
              disabled={!canGoForward}
              tone="default"
              aria-label="Go forward"
            >
              <ChevronRight aria-hidden className={cn(TOP_NAV_ICON_SIZE_CLASSNAMES.md, 'shrink-0')} />
            </TopNavIconButton>
          </div>
          <div className="w-2 shrink-0" />
          {showFind ? (
            <SearchToolbarInput
              value={findQuery}
              onValueChange={handleFindQueryChange}
              matchCount={findMatches}
              currentMatchIndex={Math.max(0, findActiveOrdinal - 1)}
              onPreviousMatch={() => runFind(findQuery, true, false)}
              onNextMatch={() => runFind(findQuery, true, true)}
              onClose={handleCloseFind}
              placeholder="Find on page"
              ariaLabel="Search in browser"
              inputRef={findInputRef}
              fullWidth
              canNavigateEmptyResults
            />
          ) : isEditingAddress ? (
            <form
              className="min-w-0 flex-1"
              data-browser-address-form="true"
              onSubmit={handleSubmit}
              style={{ WebkitAppRegion: 'no-drag' } as CSSProperties}
            >
              {/* Uncontrolled + keyed to the navigation target: each navigation
                  remounts the bar to the current url, while edits stay local DOM
                  state between submits (no atom->local effect copy). */}
              <input
                key={browserUrl}
                ref={inputRef}
                type="text"
                defaultValue={browserUrl}
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                aria-label="Address"
                placeholder="Enter a website address"
                onBlur={() => setIsEditingAddress(false)}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') {
                    setIsEditingAddress(false);
                  }
                }}
                className="h-7 w-full rounded border border-border-subtle bg-surface-raised-control px-2 text-caption text-ink-default placeholder:text-ink-faint focus-visible:outline-none"
              />
            </form>
          ) : (
            <div
              ref={addressGroupRef}
              role="button"
              tabIndex={0}
              className="group/tab flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded px-2 text-left text-caption text-ink-faint transition-colors hover:bg-surface-note-hover/40 hover:text-ink-muted focus-visible:outline-none"
              data-browser-address-group="true"
              aria-label="Edit browser address"
              title={browserUrl}
              onClick={() => {
                if (showFindRef.current) {
                  handleCloseFind();
                }
                setIsEditingAddress(true);
              }}
              onKeyDown={(event) => {
                if (event.key !== 'Enter' && event.key !== ' ' && event.key !== 'Spacebar') {
                  return;
                }
                event.preventDefault();
                if (showFindRef.current) {
                  handleCloseFind();
                }
                setIsEditingAddress(true);
              }}
              style={{ WebkitAppRegion: 'no-drag' } as CSSProperties}
            >
              <span className="block min-w-0 flex-1 truncate">{browserUrl}</span>
              <button
                type="button"
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  handleOpenInBrowser();
                }}
                aria-label="Open in system browser"
                className="flex h-4 w-4 shrink-0 cursor-pointer items-center justify-center rounded text-ink-faint opacity-0 transition-colors hover:bg-border-subtle/60 hover:text-ink-default focus-visible:opacity-100 focus-visible:outline-none group-hover/tab:opacity-100"
              >
                <ExternalLink aria-hidden className="h-3 w-3" />
              </button>
            </div>
          )}
          <div className="w-2 shrink-0" />
          <div
            className="flex shrink-0 items-center gap-1.5"
            data-browser-actions-cluster="true"
            style={{ WebkitAppRegion: 'no-drag' } as CSSProperties}
          >
            <TopNavIconButton
              onClick={openBrowserFind}
              aria-label="Search in browser"
            >
              <Search aria-hidden className={cn(TOP_NAV_ICON_SIZE_CLASSNAMES.sm, 'shrink-0')} />
            </TopNavIconButton>
            <BrowserTopNavDivider />
            {fullPane ? (
              // Full-pane: keep the affordance visible but inert. The command
              // palette would render behind the native WebContentsView, so we
              // do not open it. The unavailable state is conveyed only to
              // assistive tech (no visible tooltip renders reliably over a
              // native surface).
              <>
                <TopNavIconButton
                  aria-disabled="true"
                  aria-label="Send page to Agent (unavailable in full-screen browser)"
                  aria-describedby={SEND_TO_AGENT_UNAVAILABLE_DESC_ID}
                  className="cursor-default opacity-30 hover:bg-surface-transparent"
                  data-send-to-agent-disabled="true"
                  onClick={(event) => {
                    event.preventDefault();
                    handleSendBrowserContextToAgent();
                  }}
                >
                  <Bot aria-hidden className={cn(TOP_NAV_ICON_SIZE_CLASSNAMES.sm, 'shrink-0')} />
                </TopNavIconButton>
                <span id={SEND_TO_AGENT_UNAVAILABLE_DESC_ID} className="sr-only">
                  Sending the page to the agent is unavailable while the browser fills the whole
                  window.
                </span>
              </>
            ) : (
              <TopNavIconButton
                onClick={() => handleSendBrowserContextToAgent()}
                aria-label="Send page to Agent"
              >
                <Bot
                  aria-hidden
                  className={cn(
                    TOP_NAV_ICON_SIZE_CLASSNAMES.sm,
                    'shrink-0'
                  )}
                />
              </TopNavIconButton>
            )}
            <TopNavIconButton onClick={() => onClose()} aria-label="Close browser split tab">
              <X aria-hidden className={cn(TOP_NAV_ICON_SIZE_CLASSNAMES.sm, 'shrink-0')} />
            </TopNavIconButton>
          </div>
        </div>
      </TopNavBar>
      <div className="relative min-h-0 min-w-0 flex-1 overflow-hidden">
        {!surfaceReady ? (
          <div
            className="absolute inset-0 flex items-center justify-center bg-surface-canvas"
            aria-hidden
            data-browser-split-loading="true"
          >
            <SproutIcon className="animate-bounce opacity-70" />
          </div>
        ) : null}
        {isSafeWebBrowserUrl(requestedUrl) && surfaceNoteId ? (
          <RemoteWebSurface
            id={SPLIT_SURFACE_ID}
            noteId={surfaceNoteId}
            nodeKey="browser-split"
            mode="split"
            navigationRequestId={navigationRequestId}
            url={requestedUrl}
            title={target.title}
            active
            commandPaletteShortcutEnabled={!fullPane}
            className="absolute inset-0 overflow-hidden rounded-none"
            dataAttributes={{ 'data-browser-split-live': 'true' }}
          />
        ) : (
          <div
            className="flex h-full w-full flex-col items-center justify-center gap-3 px-6 text-center"
            data-browser-split-fallback="true"
          >
            <span className="text-sm text-ink-muted">This site can&apos;t be opened inside Moss.</span>
            <button
              type="button"
              onClick={handleOpenInBrowser}
              className="inline-flex items-center gap-2 rounded-full border border-border-subtle bg-surface-raised-card px-3 py-1.5 text-xs font-medium text-ink-default transition-colors hover:bg-surface-canvas"
            >
              <ExternalLink className="h-3.5 w-3.5" />
              Open in browser
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

export default BrowserSplitPane;
