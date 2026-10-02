// ported-from: packages/desktop/src/renderer/prompt/DesktopPromptBox.tsx @ 762abb777
import { useCallback, useRef, useState } from 'react';
import { Command, CornerDownLeft, Loader2 } from 'lucide-react';
import { DraggableModal, DraggableModalHeader } from '@moss/shared';

import { PromptInput, type PromptInputHandle, type PromptSubmitResult } from './PromptInput';

interface DesktopPromptBoxProps {
  onSubmit: (prompt: string, noteIds: string[]) => void;
  onClose?: () => void;
  isSubmitting?: boolean;
}

export function DesktopPromptBox({ onSubmit, onClose, isSubmitting = false }: DesktopPromptBoxProps) {
  const promptRef = useRef<PromptInputHandle>(null);
  // Local draft state - isolated from other prompt boxes
  const [draft, setDraft] = useState('');

  const handleSubmit = useCallback(
    (result: PromptSubmitResult) => {
      if (result.text.trim().length === 0 || isSubmitting) {
        return;
      }
      onSubmit(result.text, result.noteIds);
    },
    [onSubmit, isSubmitting]
  );

  const handleClose = useCallback(() => {
    onClose?.();
  }, [onClose]);

  return (
    <DraggableModal className="w-full max-w-timeline-max overflow-visible sm:max-w-timeline-width">
      {/* Header */}
      <DraggableModalHeader onClose={handleClose} />

      <div className="bg-surface-canvas p-6">
        {/* Lexical-based input */}
        <PromptInput
          ref={promptRef}
          placeholder="Try asking to analyze data, do research, summarize content, or organize your thoughts..."
          onSubmit={handleSubmit}
          isSubmitting={isSubmitting}
          onEscape={handleClose}
          value={draft}
          onChange={setDraft}
        />

        {/* Footer */}
        <div className="mt-4 flex items-center justify-end">
          {/* Cancel and Submit buttons */}
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleClose}
              className="flex items-center gap-1 rounded-md px-3 py-2 text-caption text-ink-subtle transition-colors hover:bg-surface-note-hover hover:text-ink-default"
            >
              <div className="rounded border border-surface-note-hover bg-surface-raised-control px-1.5 py-0.5">
                <span className="text-micro">ESC</span>
              </div>
              <span>Cancel</span>
            </button>
            <button
              type="button"
              onClick={() => promptRef.current?.submit()}
              disabled={isSubmitting}
              className="flex items-center gap-2 rounded-md bg-accent-brand px-4 py-2 text-caption text-ink-on-accent transition-colors hover:bg-accent-brand-pressed disabled:cursor-not-allowed disabled:opacity-60"
            >
              {isSubmitting ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              ) : (
                <div className="flex items-center gap-0.5">
                  <div className="flex items-center justify-center rounded bg-surface-raised-card/40 px-1 py-0.5">
                    <Command className="h-3 w-3" />
                  </div>
                  <div className="flex items-center justify-center rounded bg-surface-raised-card/40 px-1 py-0.5">
                    <CornerDownLeft className="h-3 w-3" />
                  </div>
                </div>
              )}
              <span>{isSubmitting ? 'Submitting' : 'Submit'}</span>
            </button>
          </div>
        </div>
      </div>
    </DraggableModal>
  );
}

export default DesktopPromptBox;
