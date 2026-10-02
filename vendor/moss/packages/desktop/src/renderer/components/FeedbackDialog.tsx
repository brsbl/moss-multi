// ported-from: packages/desktop/src/renderer/components/FeedbackDialog.tsx @ 762abb777
import { useCallback, useRef, useState } from 'react';
import { useNotePaneDialogPosition } from '@moss/shared';
import { Dialog } from '@moss/shared/primitives';
import { X } from 'lucide-react';
import { DialogDimOverlay } from './DialogDimOverlay';

interface FeedbackDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type SubmitStatus = 'idle' | 'submitting' | 'sent';

export function FeedbackDialog({ open, onOpenChange }: FeedbackDialogProps) {
  const dialogPositionStyle = useNotePaneDialogPosition({ open, maxWidthPx: 384 });
  const [text, setText] = useState('');
  const [email, setEmail] = useState('');
  const [status, setStatus] = useState<SubmitStatus>('idle');
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const resetForm = useCallback(() => {
    setText('');
    setEmail('');
    setStatus('idle');
    if (closeTimerRef.current) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  }, []);

  const handleOpenChange = useCallback((next: boolean) => {
    if (!next) resetForm();
    onOpenChange(next);
  }, [onOpenChange, resetForm]);

  const handleSubmit = useCallback(async () => {
    if (!text.trim() || status === 'submitting') return;
    setStatus('submitting');
    try {
      const properties: Record<string, unknown> = { feedback_text: text.trim() };
      if (email.trim()) properties.email = email.trim();
      await window.electronAPI.analytics.capture('feedback_submitted', properties);
      setStatus('sent');
      closeTimerRef.current = setTimeout(() => {
        handleOpenChange(false);
      }, 1200);
    } catch {
      // Silently fail — feedback is best-effort
      setStatus('idle');
    }
  }, [text, email, status, handleOpenChange]);

  return (
    <Dialog.Root open={open} onOpenChange={handleOpenChange}>
      <Dialog.Portal>
        <DialogDimOverlay />
        <Dialog.Content
          data-remote-web-surface-blocking-dialog="true"
          style={dialogPositionStyle}
          className="fixed left-1/2 top-1/2 z-dialog-content w-full max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border-subtle bg-surface-linen shadow-lg outline-none data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[state=closed]:slide-out-to-left-1/2 data-[state=closed]:slide-out-to-top-[48%] data-[state=open]:slide-in-from-left-1/2 data-[state=open]:slide-in-from-top-[48%]"
        >
          <Dialog.Title className="sr-only">Send Feedback</Dialog.Title>
          <Dialog.Description className="sr-only">
            Send feedback about Moss.
          </Dialog.Description>

          <Dialog.Close className="absolute right-3 top-3 rounded-full p-1 text-ink-faint/60 transition-colors hover:bg-border-subtle hover:text-ink-muted focus:outline-none focus-visible:ring-1 focus-visible:ring-ink-default/15">
            <X className="h-3.5 w-3.5" strokeWidth={1.75} />
          </Dialog.Close>

          <div className="flex flex-col gap-2.5 p-3.5">
            <h2 className="text-micro font-medium uppercase tracking-wider text-ink-faint">Feedback</h2>

            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="Email (optional, for follow-up)"
              disabled={status !== 'idle'}
              className="w-full rounded-md border border-border-subtle bg-surface-raised-control px-2.5 py-1.5 text-xs text-ink-default placeholder:text-ink-default/30 focus:border-border-default focus:outline-none focus-visible:ring-1 focus-visible:ring-ink-default/15 disabled:opacity-50"
            />
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="What's on your mind?"
              maxLength={2000}
              rows={3}
              disabled={status !== 'idle'}
              autoFocus
              className="w-full resize-none rounded-md border border-border-subtle bg-surface-raised-control px-2.5 py-1.5 text-xs text-ink-default placeholder:text-ink-default/30 focus:border-border-default focus:outline-none focus-visible:ring-1 focus-visible:ring-ink-default/15 disabled:opacity-50"
            />

            <div className="flex items-center justify-end">
              <button
                type="button"
                onClick={handleSubmit}
                disabled={!text.trim() || status !== 'idle'}
                className="rounded-md bg-accent-brand px-2.5 py-1.5 text-micro text-ink-on-accent transition-colors hover:bg-accent-brand-pressed disabled:cursor-not-allowed disabled:opacity-50"
              >
                {status === 'submitting' ? 'Sending...' : status === 'sent' ? 'Sent!' : 'Send'}
              </button>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
