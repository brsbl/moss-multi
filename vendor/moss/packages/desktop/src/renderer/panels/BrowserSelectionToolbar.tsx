// ported-from: packages/desktop/src/renderer/panels/BrowserSelectionToolbar.tsx @ 762abb777
/**
 * Floating selection toolbar for native browser surfaces.
 *
 * Browser text selection is reported by the isolated remote-web preload. The
 * toolbar itself stays in Moss renderer chrome so it reuses the same selection
 * toolbar primitives/tokens as note selections; positioning is anchored to the
 * selected text rect inside the browser surface.
 */
import type { CSSProperties, JSX, RefObject } from 'react';
import { Bot, Copy } from 'lucide-react';

import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger
} from '@moss/shared/components/ui/tooltip';

import type { RemoteWebSurfaceSelectionRect } from '../../common/remote-web-surface';
import {
  SELECTION_TOOLBAR_ANCHOR_GAP,
  SELECTION_TOOLBAR_ESTIMATED_HEIGHT,
  SELECTION_TOOLBAR_VIEWPORT_TOP_GUARD,
  SelectionToolbarButton,
  SelectionToolbarDivider,
  SelectionToolbarInner,
  SelectionToolbarShell
} from '../editor/components/SelectionToolbarPrimitives';

export interface BrowserSelectionToolbarProps {
  hasSelection: boolean;
  text: string;
  rect: RemoteWebSurfaceSelectionRect | null;
  surfaceHostRef: RefObject<HTMLElement | null>;
  onSendToAgent: (text: string) => void;
  onCopy: () => void;
}

const resolveBrowserSelectionToolbarStyle = ({
  host,
  rect
}: {
  host: HTMLElement | null;
  rect: RemoteWebSurfaceSelectionRect | null;
}): CSSProperties | undefined => {
  if (!host || !rect) {
    return undefined;
  }
  const hostRect = host.getBoundingClientRect();
  const selectionCenter = hostRect.left + rect.x + rect.width / 2;
  const aboveTop = hostRect.top + rect.y - SELECTION_TOOLBAR_ESTIMATED_HEIGHT - SELECTION_TOOLBAR_ANCHOR_GAP;
  const belowTop = hostRect.top + rect.y + rect.height + SELECTION_TOOLBAR_ANCHOR_GAP;
  const shouldFlipBelow = aboveTop < SELECTION_TOOLBAR_VIEWPORT_TOP_GUARD;

  return {
    position: 'fixed',
    left: selectionCenter,
    top: shouldFlipBelow ? belowTop : aboveTop,
    transform: 'translateX(-50%)',
    zIndex: 50,
    WebkitAppRegion: 'no-drag'
  } as CSSProperties;
};

export function BrowserSelectionToolbar({
  hasSelection,
  text,
  rect,
  surfaceHostRef,
  onSendToAgent,
  onCopy
}: BrowserSelectionToolbarProps): JSX.Element | null {
  const trimmed = text.trim();
  if (!hasSelection || trimmed.length === 0 || !rect) {
    return null;
  }

  const style = resolveBrowserSelectionToolbarStyle({
    host: surfaceHostRef.current,
    rect
  });
  if (!style) {
    return null;
  }

  return (
    <TooltipProvider delayDuration={200}>
      <SelectionToolbarShell
        role="toolbar"
        aria-label="Browser selection actions"
        data-browser-selection-toolbar="true"
        style={style}
      >
        <SelectionToolbarInner>
          <Tooltip>
            <TooltipTrigger asChild>
              <SelectionToolbarButton
                icon={Bot}
                aria-label="Send selection to Agent"
                onClick={() => onSendToAgent(trimmed)}
              />
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={12}>Send selection to Agent</TooltipContent>
          </Tooltip>
          <SelectionToolbarDivider />
          <Tooltip>
            <TooltipTrigger asChild>
              <SelectionToolbarButton icon={Copy} aria-label="Copy selection" onClick={onCopy} />
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={12}>Copy selection</TooltipContent>
          </Tooltip>
        </SelectionToolbarInner>
      </SelectionToolbarShell>
    </TooltipProvider>
  );
}

export default BrowserSelectionToolbar;
