// Moss's "Share with Agent" header button (CanvasAreaContent.tsx:4663-4687 at the pin, the full-width pane's form),
// for the viewer and the editor when their host supplies `services.shareWithAgent` (feature `share-with-agent-1`).
// The press hands the host the current selection; mousedown keeps the selection, as moss's header buttons do.
import type { ReactNode } from 'react';
import { Upload } from 'lucide-react';

export function ShareWithAgentBar({ onShare }: { onShare: () => void }): ReactNode {
  return (
    <div data-moss-share-with-agent="" className="flex h-10 shrink-0 items-center justify-end px-3">
      <button
        type="button"
        onMouseDown={(event) => event.preventDefault()}
        onClick={onShare}
        className="flex h-7 cursor-pointer items-center gap-1.5 rounded-md border border-surface-glass-border bg-surface-raised-control px-3 text-ink-faint shadow-none transition-colors hover:bg-surface-raised-control-hover hover:text-ink-muted focus-visible:outline-none"
        aria-label="Share with Agent"
      >
        <Upload aria-hidden className="h-3.5 w-3.5" />
        <span className="text-xs">Share with Agent</span>
      </button>
    </div>
  );
}
