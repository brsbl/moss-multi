// ported-from: packages/desktop/src/renderer/panels/NotesPanelFooter.tsx @ 762abb777
import { CircleHelp, FileText, Settings, Trash2 } from 'lucide-react';

import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger
} from '@moss/shared/components/ui/tooltip';
// moss-multi seam: hide-registry (A§9)
import { hidden } from '@moss-multi/host/affordances';

export type NotesPanelMode = 'notes' | 'trash';

type NotesPanelFooterProps = {
  feedbackTooltipOpen?: boolean;
  mode: NotesPanelMode;
  onModeChange: (mode: NotesPanelMode) => void;
  onOpenFeedback: () => void;
  onOpenSettings: () => void;
};

const footerButtonClass = 'flex h-7 w-7 items-center justify-center rounded text-ink-faint transition-colors hover:bg-surface-note-hover/40 hover:text-ink-muted';

export function NotesPanelFooter({
  feedbackTooltipOpen = false,
  mode,
  onModeChange,
  onOpenFeedback,
  onOpenSettings
}: NotesPanelFooterProps) {
  const isTrashMode = mode === 'trash';

  return (
    <TooltipProvider delayDuration={400}>
      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={onOpenSettings}
          className="flex h-7 items-center gap-1.5 rounded -ml-1.5 px-1.5 text-ink-faint transition-colors hover:bg-surface-note-hover/40 hover:text-ink-muted"
          aria-label="Settings"
        >
          <Settings className="h-3.5 w-3.5" strokeWidth={1.5} aria-hidden />
          <span className="text-xs font-light">Settings</span>
        </button>
        <div className="flex items-center gap-1">
          <Tooltip
            open={feedbackTooltipOpen ? true : undefined}
            triggerId={feedbackTooltipOpen ? 'feedback-tooltip-trigger' : undefined}
          >
            <TooltipTrigger asChild>
              <button
                id="feedback-tooltip-trigger"
                type="button"
                onClick={onOpenFeedback}
                className={
                  feedbackTooltipOpen
                    ? `${footerButtonClass} bg-surface-note-hover/40 text-ink-muted`
                    : footerButtonClass
                }
                aria-label="Send feedback"
              >
                <CircleHelp className="h-3.5 w-3.5" strokeWidth={1.5} aria-hidden />
              </button>
            </TooltipTrigger>
            <TooltipContent side="top">Feedback</TooltipContent>
          </Tooltip>
          {/* moss-multi seam: hide-registry (A§9) */}
          {hidden('trash') ? null : (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={() => onModeChange(isTrashMode ? 'notes' : 'trash')}
                className={footerButtonClass}
                aria-label={isTrashMode ? 'Back to notes' : 'Trash'}
              >
                {isTrashMode
                  ? <FileText className="h-3.5 w-3.5" strokeWidth={1.5} aria-hidden />
                  : <Trash2 className="h-3.5 w-3.5" strokeWidth={1.5} aria-hidden />
                }
              </button>
            </TooltipTrigger>
            <TooltipContent side="top">{isTrashMode ? 'Back to Notes' : 'Trash'}</TooltipContent>
          </Tooltip>
          )}
        </div>
      </div>
    </TooltipProvider>
  );
}
