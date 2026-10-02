// ported-from: packages/shared/src/components/ui/message-viewer.tsx @ 762abb777
import { X } from 'lucide-react';

interface MessageViewerProps {
  prompt?: string | null;
  response?: string | null;
  status?: 'draft' | 'pending' | 'completed' | 'error';
  timestamp?: string | null;
  onClose: () => void;
}

export function MessageViewer({ prompt, response, status, timestamp, onClose }: MessageViewerProps) {
  const title = status === 'error' ? 'Error' : 'Response';
  const formattedTimestamp = (() => {
    if (!timestamp) {
      return null;
    }

    const parsed = Date.parse(timestamp);
    if (Number.isNaN(parsed)) {
      return null;
    }

    return new Date(parsed).toLocaleString();
  })();

  return (
    <div className="fixed bottom-10 left-1/2 z-50 w-full max-w-timeline-max -translate-x-1/2 rounded-3xl bg-ink-accent/95 p-6 shadow-2xl backdrop-blur sm:w-[640px]">
      <div className="flex flex-col gap-5 text-ink-inverse">
        <div className="flex items-start justify-between gap-4">
          <div className="flex flex-col gap-2">
            <p className="text-xs font-medium uppercase tracking-wide text-ink-inverse/60">Prompt</p>
            <p className="whitespace-pre-wrap text-sm leading-relaxed">{prompt ?? 'No prompt recorded.'}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md transition-colors hover:bg-ink-default/20"
            aria-label="Close response viewer"
          >
            <X className="h-4 w-4 text-ink-inverse" />
          </button>
        </div>
        <div className="flex justify-end">
          <div className="max-w-chat-message rounded-2xl bg-ink-default/25 p-4 text-right">
            <p className="text-xs font-medium uppercase tracking-wide text-ink-inverse/60">{title}</p>
            <p className="whitespace-pre-wrap text-sm leading-relaxed">
              {response ?? (status === 'error' ? 'No error details available.' : 'No response recorded yet.')}
            </p>
          </div>
        </div>
        {formattedTimestamp ? (
          <div className="text-xs text-ink-inverse/60">{formattedTimestamp}</div>
        ) : null}
      </div>
    </div>
  );
}

export default MessageViewer;
