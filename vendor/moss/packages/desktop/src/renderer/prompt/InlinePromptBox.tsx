// ported-from: packages/desktop/src/renderer/prompt/InlinePromptBox.tsx @ 762abb777
import { forwardRef, useCallback, useImperativeHandle, useRef } from 'react';
import { Command, CornerDownLeft } from 'lucide-react';
import { ClaudeIcon } from '@moss/shared/components/brand/ClaudeIcon';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@moss/shared/components/ui/tooltip';

import { ContextPill, type ContextFile } from '@moss/shared';
import { PromptInput, type PromptInputHandle, type PromptMention, type PromptSubmitResult } from './PromptInput';
import { ContextFilePills } from './ContextFilePills';

interface InlinePromptBoxProps {
  onSubmit: (prompt: string, noteIds: string[], mentions: PromptMention[], directoryPaths: string[]) => void;
  onClose?: () => void;
  isSubmitting?: boolean;
  /** Files selected for context (data mode) */
  contextFiles?: ContextFile[];
  /** Callback to remove a context file */
  onRemoveContextFile?: (path: string) => void;
  /** Selected text from editor to include as context */
  selectedContext?: string | null;
  /** Optional icon shown beside selected context */
  selectedContextIconUrl?: string | null;
  /** Callback to clear the selected context */
  onClearSelectedContext?: () => void;
}

export interface InlinePromptBoxHandle {
  focus: () => void;
}

/**
 * Inline prompt box for rendering inside the actions panel.
 * Compact version of DesktopPromptBox without the modal wrapper.
 */
export const InlinePromptBox = forwardRef<InlinePromptBoxHandle, InlinePromptBoxProps>(function InlinePromptBox(
  { onSubmit, onClose, isSubmitting = false, contextFiles = [], onRemoveContextFile, selectedContext, selectedContextIconUrl, onClearSelectedContext },
  ref
) {
  const promptRef = useRef<PromptInputHandle>(null);

  useImperativeHandle(ref, () => ({
    focus: () => promptRef.current?.focus()
  }), []);

  const handleSubmit = useCallback(
    (result: PromptSubmitResult) => {
      if (result.text.trim().length === 0 || isSubmitting) {
        return;
      }
      // Reset textarea to default size before submit
      promptRef.current?.resetHeight();
      onSubmit(result.text, result.noteIds, result.mentions, result.directoryPaths);
    },
    [onSubmit, isSubmitting]
  );

  const handleClose = useCallback(() => {
    // Don't allow closing while agent is running
    if (isSubmitting) return;
    onClose?.();
  }, [onClose, isSubmitting]);

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-surface-glass-border bg-surface-glass p-3">
      {/* Context file pills (data mode) */}
      {contextFiles.length > 0 && onRemoveContextFile && (
        <ContextFilePills
          files={contextFiles}
          onRemove={onRemoveContextFile}
          disabled={isSubmitting}
        />
      )}

      {/* Selected text context pill */}
      {selectedContext && onClearSelectedContext && (
        <div className="flex items-start">
          <ContextPill
            text={selectedContext}
            iconUrl={selectedContextIconUrl}
            onRemove={onClearSelectedContext}
          />
        </div>
      )}

      {/* Prompt input */}
      <PromptInput
        ref={promptRef}
        placeholder="Ask Moss to help..."
        onSubmit={handleSubmit}
        isSubmitting={isSubmitting}
        onEscape={handleClose}
        inline
      />

      {/* Divider */}
      <div className="h-px bg-border-subtle" />

      {/* Footer */}
      <div className="flex items-center justify-end gap-2">
        <TooltipProvider delayDuration={300}>
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="flex items-center justify-center">
                <ClaudeIcon className="h-5 w-5 text-accent-terracotta" />
              </span>
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={6}>
              Powered by Claude Code
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
        <button
          type="button"
          onClick={() => promptRef.current?.submit()}
          disabled={isSubmitting}
          className="flex items-center gap-1.5 rounded-md bg-accent-brand px-2.5 py-1.5 text-micro text-ink-on-accent transition-colors hover:bg-accent-brand-pressed disabled:cursor-not-allowed disabled:opacity-60"
        >
          <div className="flex items-center gap-0.5">
            <div className="flex items-center justify-center rounded bg-surface-raised-card/40 px-0.5 py-0.5">
              <Command className="h-2.5 w-2.5" aria-hidden="true" />
            </div>
            <div className="flex items-center justify-center rounded bg-surface-raised-card/40 px-0.5 py-0.5">
              <CornerDownLeft className="h-2.5 w-2.5" aria-hidden="true" />
            </div>
          </div>
          <span>Enter</span>
        </button>
      </div>
    </div>
  );
});

export default InlinePromptBox;
