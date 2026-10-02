// ported-from: packages/desktop/src/renderer/panels/SplitPaneContainer.tsx @ 762abb777
import { type CSSProperties, type ReactNode, type RefObject, useCallback, useRef } from 'react';
import { useAtomValue, useSetAtom, useStore } from 'jotai';
import { TooltipCollisionBoundaryProvider } from '@moss/shared/components/ui/tooltip';
import { cn } from '@moss/shared/lib/utils';
import {
  browserSplitFullPaneAtom,
  browserSplitTargetAtom,
  closeSplitPaneAtom,
  setFocusPaneAtom,
  splitCanGoBackAtom,
  splitCanGoForwardAtom,
  splitGoBackAtom,
  splitGoForwardAtom,
  splitNavigateToNoteAtom,
  splitRatioAtom,
  splitTabNoteIdAtom,
} from '@moss/shared';

import { CanvasAreaContent, type CanvasAreaContentHandle } from './CanvasAreaContent';
import { BrowserSplitPane } from './BrowserSplitPane';

const MIN_RATIO = 0.3;
const MAX_RATIO = 0.7;

type SplitPaneId = 'left' | 'right';

type SplitPaneContainerProps = {
  /** Ref for the left (primary) pane's CanvasAreaContent */
  leftPaneRef: RefObject<CanvasAreaContentHandle | null>;
  /** Ref for the right (split) pane's CanvasAreaContent */
  rightPaneRef: RefObject<CanvasAreaContentHandle | null>;
  /** Props forwarded to both CanvasAreaContent instances */
  onCloseSplitPane?: (paneId: SplitPaneId) => void;
  onDeleteNote?: (noteId: string) => void;
  onRestoreNote?: (noteId: string) => void;
  onNavigateToNote?: (noteId: string, heading?: string | null) => void;
  isActionsPanelHidden?: boolean;
  isNotesPanelHidden?: boolean;
  onExpandNotesPanel?: () => void;
  onExpandActionsPanel?: () => void;
  isAgentStreaming?: () => boolean;
  onCanvasClick?: () => void;
  onActionClick?: () => void;
  leftActionsPanel?: ReactNode;
  /** Left-pane-specific: navigation */
  canGoBack?: boolean;
  canGoForward?: boolean;
  onGoBack?: () => void;
  onGoForward?: () => void;
  /** Left-pane-specific: search */
  showSearchBar?: boolean;
  searchBarAutoFocus?: boolean;
  onCloseSearch?: () => void;
  onOpenSearch?: () => void;
  /** Left single-pane title/focus props. */
  leftAutoFocusTitle?: boolean;
  onLeftTitleFocusComplete?: () => void;
  leftAutoFocusBody?: boolean;
  onLeftBodyFocusComplete?: () => void;
  showFloatingTitleBar?: boolean;
  isFocusMode?: boolean;
};

export function SplitPaneContainer({
  leftPaneRef,
  rightPaneRef,
  onCloseSplitPane,
  onDeleteNote,
  onRestoreNote,
  onNavigateToNote,
  isActionsPanelHidden = false,
  isNotesPanelHidden = false,
  onExpandNotesPanel,
  onExpandActionsPanel,
  isAgentStreaming,
  onCanvasClick,
  onActionClick,
  leftActionsPanel,
  canGoBack,
  canGoForward,
  onGoBack,
  onGoForward,
  showSearchBar,
  searchBarAutoFocus,
  onCloseSearch,
  onOpenSearch,
  leftAutoFocusTitle,
  onLeftTitleFocusComplete,
  leftAutoFocusBody,
  onLeftBodyFocusComplete,
  showFloatingTitleBar,
  isFocusMode,
}: SplitPaneContainerProps) {
  const store = useStore();
  const splitRatio = useAtomValue(splitRatioAtom);
  const splitNoteId = useAtomValue(splitTabNoteIdAtom);
  const browserSplitTarget = useAtomValue(browserSplitTargetAtom);
  const browserSplitFullPane = useAtomValue(browserSplitFullPaneAtom);
  const setFocusPane = useSetAtom(setFocusPaneAtom);
  const setSplitRatio = useSetAtom(splitRatioAtom);
  const closeSplitPane = useSetAtom(closeSplitPaneAtom);

  // Split pane navigation
  const splitCanGoBack = useAtomValue(splitCanGoBackAtom);
  const splitCanGoForward = useAtomValue(splitCanGoForwardAtom);
  const splitGoBack = useSetAtom(splitGoBackAtom);
  const splitGoForward = useSetAtom(splitGoForwardAtom);
  const splitNavigateToNote = useSetAtom(splitNavigateToNoteAtom);

  // --- Resize state ---
  const containerRef = useRef<HTMLDivElement>(null);
  const leftTooltipBoundaryRef = useRef<HTMLDivElement>(null);
  const rightTooltipBoundaryRef = useRef<HTMLDivElement>(null);
  const resizePointerIdRef = useRef<number | null>(null);
  const resizeStartXRef = useRef<number>(0);
  const resizeStartRatioRef = useRef<number>(0.5);

  const handleDividerPointerDown = useCallback(
    (event: React.PointerEvent) => {
      event.preventDefault();
      (event.target as HTMLElement).setPointerCapture(event.pointerId);
      resizePointerIdRef.current = event.pointerId;
      resizeStartXRef.current = event.clientX;
      resizeStartRatioRef.current = store.get(splitRatioAtom);
      document.body.style.cursor = 'col-resize';
    },
    [store]
  );

  const handleDividerPointerMove = useCallback(
    (event: React.PointerEvent) => {
      if (resizePointerIdRef.current !== event.pointerId) return;
      const container = containerRef.current;
      if (!container) return;
      const containerWidth = container.offsetWidth;
      if (containerWidth === 0) return;
      const deltaX = event.clientX - resizeStartXRef.current;
      const deltaRatio = deltaX / containerWidth;
      const newRatio = Math.min(MAX_RATIO, Math.max(MIN_RATIO, resizeStartRatioRef.current + deltaRatio));
      setSplitRatio(newRatio);
    },
    [setSplitRatio]
  );

  const handleDividerPointerUp = useCallback(
    (event: React.PointerEvent) => {
      if (resizePointerIdRef.current !== event.pointerId) return;
      resizePointerIdRef.current = null;
      document.body.style.cursor = '';
    },
    []
  );

  const handleCloseSplitPane = useCallback(
    (targetPaneId: SplitPaneId) => {
      if (onCloseSplitPane) {
        onCloseSplitPane(targetPaneId);
        return;
      }

      closeSplitPane(targetPaneId);
    },
    [closeSplitPane, onCloseSplitPane]
  );

  // Shared props for both panes
  const sharedProps = {
    onDeleteNote,
    onRestoreNote,
    onNavigateToNote,
    isActionsPanelHidden,
    isNotesPanelHidden,
    onExpandNotesPanel,
    onExpandActionsPanel,
    isAgentStreaming,
    onCanvasClick,
    onActionClick,
  };

  const leftPercent = `${(splitRatio * 100).toFixed(1)}%`;
  const rightPercent = `${((1 - splitRatio) * 100).toFixed(1)}%`;
  const hasSplit = Boolean(splitNoteId || browserSplitTarget);
  const isBrowserOnly = Boolean(browserSplitTarget) && browserSplitFullPane;

  return (
    <div ref={containerRef} className="flex h-full w-full min-w-0 overflow-hidden">
      {/* Left (primary) pane */}
      <div
        ref={leftTooltipBoundaryRef}
        key="left-pane"
        className={cn(
          isBrowserOnly ? 'hidden' : 'relative flex h-full min-w-0 overflow-hidden'
        )}
        data-command-palette-note-pane={!isBrowserOnly && browserSplitTarget ? 'true' : undefined}
        data-tooltip-collision-boundary={!isBrowserOnly ? 'true' : undefined}
        style={
          isBrowserOnly
            ? undefined
            : hasSplit
              ? { flexBasis: leftPercent, flexGrow: 0, flexShrink: 0 }
              : { flexBasis: '100%', flexGrow: 1, flexShrink: 1 }
        }
        onFocusCapture={() => setFocusPane('left')}
        onPointerDown={() => setFocusPane('left')}
      >
        {!isBrowserOnly ? (
          <>
            <TooltipCollisionBoundaryProvider boundaryRef={leftTooltipBoundaryRef}>
              <CanvasAreaContent
                ref={leftPaneRef}
                paneId={hasSplit ? 'left' : undefined}
                onCloseSplit={hasSplit ? handleCloseSplitPane : undefined}
                showActionsPanelToggleOnLeft={Boolean(browserSplitTarget)}
                autoFocusTitle={leftAutoFocusTitle}
                onTitleFocusComplete={onLeftTitleFocusComplete}
                autoFocusBody={leftAutoFocusBody}
                onBodyFocusComplete={onLeftBodyFocusComplete}
                {...sharedProps}
                canGoBack={canGoBack}
                canGoForward={canGoForward}
                onGoBack={onGoBack}
                onGoForward={onGoForward}
                showSearchBar={showSearchBar}
                searchBarAutoFocus={searchBarAutoFocus}
                onCloseSearch={onCloseSearch}
                onOpenSearch={onOpenSearch}
                showFloatingTitleBar={showFloatingTitleBar}
                isFocusMode={isFocusMode}
              />
            </TooltipCollisionBoundaryProvider>
            {browserSplitTarget ? (
              <TooltipCollisionBoundaryProvider boundaryRef={leftTooltipBoundaryRef}>
                {leftActionsPanel}
              </TooltipCollisionBoundaryProvider>
            ) : null}
          </>
        ) : null}
      </div>

      {/* Resize divider */}
      {hasSplit ? (
        <div
          key="resize-divider"
          {...(!isBrowserOnly
            ? { role: 'separator', 'aria-orientation': 'vertical' as const }
            : { 'aria-hidden': true })}
          className={cn(
            isBrowserOnly
              ? 'hidden'
              : [
                  'relative h-full w-px shrink-0 cursor-col-resize touch-none select-none bg-surface-glass-border',
                  'before:absolute before:inset-y-0 before:-left-3 before:-right-3 before:content-[""]'
                ]
          )}
          style={{ WebkitAppRegion: 'no-drag' } as CSSProperties}
          onPointerDown={handleDividerPointerDown}
          onPointerMove={handleDividerPointerMove}
          onPointerUp={handleDividerPointerUp}
          onPointerCancel={handleDividerPointerUp}
        />
      ) : null}

      {/* Right (split) pane */}
      {hasSplit ? (
        <div
          ref={rightTooltipBoundaryRef}
          key="right-pane"
          className="relative min-w-0 overflow-hidden"
          data-tooltip-collision-boundary="true"
          style={
            isBrowserOnly
              ? { flexBasis: '100%', flexGrow: 1, flexShrink: 1 }
              : { flexBasis: rightPercent, flexGrow: 0, flexShrink: 0 }
          }
          onFocusCapture={() => setFocusPane('right')}
          onPointerDown={() => setFocusPane('right')}
        >
          {browserSplitTarget ? (
            <TooltipCollisionBoundaryProvider boundaryRef={rightTooltipBoundaryRef}>
              <BrowserSplitPane fullPane={isBrowserOnly} onClose={() => handleCloseSplitPane('right')} />
            </TooltipCollisionBoundaryProvider>
          ) : (
            splitNoteId && (
              <TooltipCollisionBoundaryProvider boundaryRef={rightTooltipBoundaryRef}>
                <CanvasAreaContent
                  ref={rightPaneRef}
                  noteIdOverride={splitNoteId}
                  paneId="right"
                  onCloseSplit={handleCloseSplitPane}
                  {...sharedProps}
                  onNavigateToNote={splitNavigateToNote}
                  canGoBack={splitCanGoBack}
                  canGoForward={splitCanGoForward}
                  onGoBack={splitGoBack}
                  onGoForward={splitGoForward}
                  showSearchBar={showSearchBar}
                  searchBarAutoFocus={searchBarAutoFocus}
                  onCloseSearch={onCloseSearch}
                  onOpenSearch={onOpenSearch}
                />
              </TooltipCollisionBoundaryProvider>
            )
          )}
        </div>
      ) : null}
    </div>
  );
}
