// ported-from: packages/shared/src/components/ui/timeline-popout-modal.tsx @ 762abb777
import { Dialog } from '@/components/primitives';
import { ChevronLeft, ChevronRight, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { ActionTabEntry } from '../../state/atoms';
import { ActionTimelineCard } from './action-timeline-card';
import { useNotePaneDialogPosition } from './use-note-pane-dialog-position';

interface TimelinePopoutModalProps {
  /** The tab to show in the modal */
  tab: ActionTabEntry | null;
  /** Whether the modal is open */
  open: boolean;
  /** Callback to close the modal */
  onClose: () => void;
  /** Navigate to the previous timeline */
  onPrev?: () => void;
  /** Navigate to the next timeline */
  onNext?: () => void;
  /** Whether there is a previous timeline */
  hasPrev: boolean;
  /** Whether there is a next timeline */
  hasNext: boolean;
  /** Whether the agent has finished execution */
  isComplete?: boolean;
  /** Called when the user clicks Stop during streaming */
  onCancel?: () => void;
  /** Called when the user clicks the copy button on a prompt */
  onCopyPrompt?: (prompt: string) => void;
  /** Called to open uploaded prompt images in a lightbox carousel */
  onOpenImages?: (sources: string[], startIndex: number) => void;
}

export function TimelinePopoutModal({
  tab,
  open,
  onClose,
  onPrev,
  onNext,
  hasPrev,
  hasNext,
  isComplete = false,
  onCancel,
  onCopyPrompt,
  onOpenImages
}: TimelinePopoutModalProps) {
  const dialogPositionStyle = useNotePaneDialogPosition({ open, maxWidthPx: 448 });

  if (!tab) return null;

  return (
    <Dialog.Root open={open} onOpenChange={(isOpen) => { if (!isOpen) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay
          className="fixed inset-0 z-[120] bg-surface-modal-overlay-subtle data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0"
          data-moss-modal-overlay="true"
        />
        <Dialog.Content
          data-remote-web-surface-blocking-dialog="true"
          style={dialogPositionStyle}
          className={cn(
            'fixed left-1/2 top-1/2 z-[130] w-full max-w-md -translate-x-1/2 -translate-y-1/2',
            'rounded-xl border border-border-subtle bg-surface-linen shadow-lg',
            'max-h-[80vh] flex flex-col',
            'data-[state=open]:animate-in data-[state=closed]:animate-out',
            'data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
            'data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95'
          )}
        >
          {/* Header with navigation */}
          <div className="flex items-center justify-between border-b border-border-subtle px-4 py-3">
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onPrev}
                disabled={!hasPrev}
                className="rounded p-0.5 text-ink-muted transition-colors hover:text-ink-default disabled:opacity-30 disabled:cursor-not-allowed"
                aria-label="Previous timeline"
              >
                <ChevronLeft className="h-4 w-4" />
              </button>
              <Dialog.Title className="text-sm font-semibold text-ink-default">
                {tab.submittedLabel || 'Action'}
              </Dialog.Title>
              <Dialog.Description className="sr-only">
                Review a full action timeline and move between previous or next actions.
              </Dialog.Description>
              <button
                type="button"
                onClick={onNext}
                disabled={!hasNext}
                className="rounded p-0.5 text-ink-muted transition-colors hover:text-ink-default disabled:opacity-30 disabled:cursor-not-allowed"
                aria-label="Next timeline"
              >
                <ChevronRight className="h-4 w-4" />
              </button>
            </div>
            <Dialog.Close className="rounded-full p-1 text-ink-faint/60 transition-colors hover:bg-border-subtle hover:text-ink-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ink-default/15">
              <X className="h-3.5 w-3.5" strokeWidth={1.75} />
              <span className="sr-only">Close</span>
            </Dialog.Close>
          </div>

          {/* Scrollable timeline content */}
          <div className="flex-1 overflow-y-auto p-3">
            <ActionTimelineCard
              action={tab}
              isExpanded={true}
              onToggle={onClose}
              isComplete={isComplete}
              onCancel={tab.isStreaming ? onCancel : undefined}
              onCopyPrompt={onCopyPrompt}
              onOpenImages={onOpenImages}
            />
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

const BASE_HEIGHT_PX = 220;
const LINE_HEIGHT_PX = 18;
const BUBBLE_PADDING_PX = 28;
const CHARS_PER_LINE = 72;

const FALLBACK_MESSAGE_COUNT_THRESHOLD = 3;
const FALLBACK_CHAR_THRESHOLD = 500;

/** Estimate if a timeline is too long to fit comfortably inline. */
export function isTimelineLong(action: ActionTabEntry, availableHeightPx?: number): boolean {
  const prompt = action.prompt ?? '';
  const streaming = action.streamingText?.trim() ?? '';
  const messages = [
    ...(action.syntheticAck ? [action.syntheticAck] : []),
    ...action.messages,
    ...(streaming ? [streaming] : [])
  ];

  const totalMessageChars = messages.reduce((sum, msg) => sum + msg.length, 0);

  const hasSpaceBudget =
    typeof availableHeightPx === 'number' && Number.isFinite(availableHeightPx) && availableHeightPx > 0;

  if (!hasSpaceBudget) {
    return messages.length >= FALLBACK_MESSAGE_COUNT_THRESHOLD || totalMessageChars > FALLBACK_CHAR_THRESHOLD;
  }

  const allText = [prompt, ...messages].join('\n');
  const explicitLines = allText.length === 0 ? 0 : allText.split('\n').length;
  const wrappedLines = Math.ceil(allText.length / CHARS_PER_LINE);
  const estimatedLines = Math.max(explicitLines, wrappedLines);
  const estimatedHeight = BASE_HEIGHT_PX + estimatedLines * LINE_HEIGHT_PX + messages.length * BUBBLE_PADDING_PX;

  if (estimatedHeight > availableHeightPx) {
    return true;
  }

  // Keep conservative fallbacks for exceptionally dense transcripts.
  return messages.length >= 6 || totalMessageChars > 2000;
}
