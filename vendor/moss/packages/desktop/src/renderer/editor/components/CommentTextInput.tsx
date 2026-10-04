// ported-from: packages/desktop/src/renderer/editor/components/CommentTextInput.tsx @ 762abb777
/**
 * CommentTextInput - Lexical-based input for creating and editing comments.
 *
 * Uses MentionInput with custom serialize/deserialize that converts between
 * the encoded Unicode comment mention format and real MentionNodes.
 * Replaces the old textarea+overlay approach for accurate cursor/pill alignment.
 */
import { useCallback, useRef } from 'react';

import { Command, CornerDownLeft } from 'lucide-react';
import type { LexicalEditor } from 'lexical';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@moss/shared/components/ui/tooltip';

import { MentionInput } from './MentionInput';
import {
  $deserializeCommentEditor,
  serializeCommentEditor,
  deserializeCommentEditor
} from '../utils/comment-mentions';

export interface CommentTextInputProps {
  value: string;
  onChange: (encoded: string) => void;
  onSubmit: (currentValue?: string) => void;
  submitDisabled?: boolean;
  ariaLabel?: string;
  placeholder?: string;
  autoFocus?: boolean;
  externalFocusLock?: boolean;
  /** Keep comment actions in a stable footer instead of adapting to content height. */
  persistentFooter?: boolean;
  /** Bump to force-clear the input while it stays mounted (e.g. after sending a reply). */
  resetSignal?: number;
  footerPortalTarget?: HTMLElement | null;
  imageAttachments?: {
    imageUrls: string[];
    onAttach: () => void;
    onRemove: (index: number) => void;
    onOpen?: (index: number) => void;
    displaySrcs: (string | null)[];
  };
}

export const COMMENT_CANCEL_BUTTON_CLASS =
  'flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-ink-faint transition-colors hover:bg-surface-panel hover:text-ink-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ink-default/15 disabled:pointer-events-none disabled:opacity-30';

export function CommentTextInput({
  value,
  onChange,
  onSubmit,
  submitDisabled = false,
  ariaLabel = 'comment editor',
  placeholder = 'Add a comment…',
  autoFocus = true,
  externalFocusLock,
  persistentFooter = false,
  resetSignal,
  footerPortalTarget,
  imageAttachments
}: CommentTextInputProps) {
  const editorRef = useRef<LexicalEditor | null>(null);
  const initialValueRef = useRef(value);

  const initialEditorState = useCallback(() => {
    $deserializeCommentEditor(initialValueRef.current);
  }, []);

  const serialize = useCallback((editor: LexicalEditor): string => {
    return serializeCommentEditor(editor, { preserveMentionIds: true });
  }, []);

  const deserialize = useCallback((editor: LexicalEditor, text: string): void => {
    deserializeCommentEditor(editor, text);
  }, []);

  const submitCurrentValue = useCallback(() => {
    const editor = editorRef.current;
    if (!editor) {
      if (value.trim() || imageAttachments?.imageUrls.length) {
        onSubmit();
      }
      return;
    }
    let currentValue = value;
    currentValue = serializeCommentEditor(editor, { preserveMentionIds: true });
    if (!currentValue.trim() && !imageAttachments?.imageUrls.length) return;
    onChange(currentValue);
    onSubmit(currentValue);
  }, [imageAttachments?.imageUrls.length, onChange, onSubmit, value]);

  return (
    <MentionInput
      namespace="moss-comment-input"
      ariaLabel={ariaLabel}
      value={value}
      onChange={onChange}
      onSubmit={submitCurrentValue}
      placeholder={placeholder}
      autoFocus={autoFocus}
      preventAutoFocusScroll={persistentFooter}
      externalFocusLock={externalFocusLock}
      resetSignal={resetSignal}
      contentEditableClassName={`min-h-6 w-full resize-none text-small leading-relaxed text-ink-default outline-none ${persistentFooter ? 'overflow-visible pb-2 pt-1' : 'max-h-32 overflow-y-auto py-1'}`}
      placeholderClassName="pointer-events-none absolute left-0 top-1/2 -translate-y-1/2 select-none text-small leading-relaxed text-ink-faint/80"
      paragraphClassName="mb-0 text-small leading-relaxed"
      actionsPlacement={persistentFooter ? 'footer' : 'responsive'}
      inputSurfaceClassName="px-3"
      footerClassName={
        persistentFooter
          ? footerPortalTarget
            ? 'border-t-0'
            : 'border-border-control-divider'
          : undefined
      }
      footerControlsClassName={persistentFooter ? 'min-h-10 py-2 pl-2 pr-2.5' : undefined}
      footerPortalTarget={footerPortalTarget}
      initialEditorState={initialEditorState}
      serialize={serialize}
      deserialize={deserialize}
      editorRef={editorRef}
      mentionRequireWordBoundary={false}
      imageAttachments={
        imageAttachments
          ? {
              ...imageAttachments,
              previewClassName: 'h-8 w-8'
            }
          : undefined
      }
      submitButton={
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onMouseDown={event => event.preventDefault()}
                onClick={submitCurrentValue}
                disabled={submitDisabled}
                className="flex h-6 shrink-0 items-center justify-center gap-0.5 rounded-md px-0.5 text-ink-faint transition-colors hover:bg-surface-panel hover:text-ink-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ink-default/15 disabled:pointer-events-none disabled:opacity-30"
                aria-label="Submit comment"
              >
                <Command className="h-3.5 w-3.5" strokeWidth={1.5} />
                <CornerDownLeft className="h-3.5 w-3.5" strokeWidth={1.5} />
              </button>
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={6}>
              Submit comment
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      }
    />
  );
}
