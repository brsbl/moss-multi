// ported-from: packages/desktop/src/renderer/editor/components/MentionInput.tsx @ 762abb777
/**
 * MentionInput - Shared Lexical-based input with inline @mention support.
 *
 * Extracted from PromptInput to be reusable across both the actions prompt
 * and comment inputs. Uses real MentionNodes for cursor-accurate pill rendering.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { LexicalComposer } from '@lexical/react/LexicalComposer';
import type { InitialConfigType } from '@lexical/react/LexicalComposer';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { ContentEditable } from '@lexical/react/LexicalContentEditable';
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary';
import { HistoryPlugin } from '@lexical/react/LexicalHistoryPlugin';
import { OnChangePlugin } from '@lexical/react/LexicalOnChangePlugin';
import { MarkdownShortcutPlugin } from '@lexical/react/LexicalMarkdownShortcutPlugin';
import { PlainTextPlugin } from '@lexical/react/LexicalPlainTextPlugin';
import { RichTextPlugin } from '@lexical/react/LexicalRichTextPlugin';
import {
  $createParagraphNode,
  $createTextNode,
  $getSelection,
  $getRoot,
  $isRangeSelection,
  $setSelection,
  COMMAND_PRIORITY_HIGH,
  KEY_ENTER_COMMAND,
  SKIP_SCROLL_INTO_VIEW_TAG,
  type EditorState,
  type LexicalEditor
} from 'lexical';

import { AtSign, ImagePlus, Plus, X } from 'lucide-react';

import { cn } from '@moss/shared/lib/utils';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@moss/shared/components/ui/dropdown-menu';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger
} from '@moss/shared/components/ui/tooltip';

import { MentionNode } from '../../prompt/MentionNode';
import { MentionPlugin, type MentionState } from '../../prompt/MentionPlugin';
import { SIMPLE_ACTION_MARKDOWN_TRANSFORMERS } from '../utils/comment-mentions';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MentionInputProps {
  namespace: string;
  ariaLabel?: string;
  value?: string;
  onChange?: (value: string) => void;
  onSubmit?: () => void;
  placeholder?: string;
  autoFocus?: boolean;
  /** Focus without moving an enclosing scroll viewport. */
  preventAutoFocusScroll?: boolean;
  externalFocusLock?: boolean;
  /**
   * Bump this number to force-clear the editor to the current `value`, bypassing
   * the anti-echo guard. Used to empty a persistent composer right after a send.
   */
  resetSignal?: number;
  contentEditableClassName?: string;
  /** Show a non-interactive bottom fade while editable content remains below the viewport. */
  showOverflowFade?: boolean;
  placeholderClassName?: string;
  paragraphClassName?: string;
  submitButton?: React.ReactNode;
  /** Keep controls inline, in a footer, or move them into a footer when content wraps. */
  actionsPlacement?: 'inline' | 'footer' | 'responsive';
  /** Additional controls rendered beside mention and image actions in footer mode. */
  footerLeadingActions?: React.ReactNode;
  footerActionButtonClassName?: string;
  /** Content rendered inside the writing surface before attachments and text. */
  inputLeadingContent?: React.ReactNode;
  inputSurfaceClassName?: string;
  inputRowClassName?: string;
  footerClassName?: string;
  footerControlsClassName?: string;
  /** Render the persistent footer into a stable external host. */
  footerPortalTarget?: HTMLElement | null;
  /** Seed Lexical synchronously before its first layout measurement. */
  initialEditorState?: InitialConfigType['editorState'];
  serialize?: (editor: LexicalEditor) => string;
  deserialize?: (editor: LexicalEditor, text: string) => void;
  /** Enable basic inline Markdown shortcuts and rich-text rendering. */
  simpleMarkdown?: boolean;
  editorRef?: React.RefObject<LexicalEditor | null>;
  mentionRequireWordBoundary?: boolean;
  /** Callback for mention typeahead state changes (open/close, selection). */
  onMentionStateChange?: (state: MentionState | null) => void;
  imageAttachments?: {
    imageUrls: string[];
    onAttach: () => void;
    onRemove: (index: number) => void;
    onOpen?: (index: number) => void;
    displaySrcs: (string | null)[];
    previewClassName?: string;
  };
}

const DEFAULT_PARAGRAPH_CLASS_NAME = 'mb-0 text-small';

// ---------------------------------------------------------------------------
// MentionInputSyncPlugin — bidirectional sync between Lexical and controlled value
// ---------------------------------------------------------------------------

function MentionInputSyncPlugin({
  value,
  onChange,
  serialize,
  deserialize,
  resetSignal
}: {
  value?: string;
  onChange?: (value: string) => void;
  serialize?: (editor: LexicalEditor) => string;
  deserialize?: (editor: LexicalEditor, text: string) => void;
  resetSignal?: number;
}) {
  const [editor] = useLexicalComposerContext();

  // Anti-loop refs: prevent external→editor→onChange→external cycles
  const isExternalUpdateRef = useRef(false);
  const lastExternalTextRef = useRef<string | null>(null);
  const internalWriteCountRef = useRef(0);
  const lastConsumedWriteRef = useRef(0);

  const getText = useCallback(
    (ed: LexicalEditor): string => {
      if (serialize) return serialize(ed);
      let text = '';
      ed.getEditorState().read(() => {
        text = $getRoot().getTextContent();
      });
      return text;
    },
    [serialize]
  );

  const setText = useCallback(
    (ed: LexicalEditor, text: string) => {
      if (deserialize) {
        deserialize(ed, text);
        return;
      }
      ed.update(() => {
        const root = $getRoot();
        root.clear();
        const paragraph = $createParagraphNode();
        if (text) paragraph.append($createTextNode(text));
        root.append(paragraph);
        paragraph.selectEnd();
      });
    },
    [deserialize]
  );

  // Sync external value → editor
  useEffect(() => {
    if (value === undefined) return;
    if (lastExternalTextRef.current === value) return;

    if (internalWriteCountRef.current > lastConsumedWriteRef.current) {
      lastConsumedWriteRef.current = internalWriteCountRef.current;
      lastExternalTextRef.current = value;
      return;
    }

    const editorText = getText(editor);
    if (editorText === value) {
      lastExternalTextRef.current = value;
      return;
    }

    isExternalUpdateRef.current = true;
    lastExternalTextRef.current = value;
    setText(editor, value);

    queueMicrotask(() => {
      isExternalUpdateRef.current = false;
    });
  }, [editor, value, getText, setText]);

  // Forced reset: bumping `resetSignal` clears the editor to the current `value`
  // even when the anti-echo guard above would otherwise swallow it. The reply
  // composer uses this to empty itself right after a send (the user typed, so the
  // write counter would consume a value='' reset). Resetting the counters keeps
  // subsequent typing in sync.
  const didMountResetRef = useRef(false);
  useEffect(() => {
    if (resetSignal === undefined) return;
    if (!didMountResetRef.current) {
      didMountResetRef.current = true;
      return;
    }
    const nextText = value ?? '';
    isExternalUpdateRef.current = true;
    lastExternalTextRef.current = nextText;
    internalWriteCountRef.current = 0;
    lastConsumedWriteRef.current = 0;
    setText(editor, nextText);
    queueMicrotask(() => {
      isExternalUpdateRef.current = false;
    });
    // Only re-run when the reset signal changes, not when value updates.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetSignal]);

  // Sync editor → external value
  const handleChange = useCallback(
    (editorState: EditorState) => {
      if (isExternalUpdateRef.current) return;

      editorState.read(() => {
        const text = serialize ? serialize(editor) : $getRoot().getTextContent();
        lastExternalTextRef.current = text;
        internalWriteCountRef.current += 1;
        onChange?.(text);
      });
    },
    [editor, onChange, serialize]
  );

  return <OnChangePlugin onChange={handleChange} ignoreSelectionChange />;
}

function insertMentionTrigger(editor: LexicalEditor) {
  editor.focus(() => {
    editor.update(() => {
      const selection = $getSelection();
      if ($isRangeSelection(selection)) {
        selection.insertText('@');
        return;
      }
      $getRoot().selectEnd();
      const nextSelection = $getSelection();
      if ($isRangeSelection(nextSelection)) {
        nextSelection.insertText('@');
      }
    });
  });
}

function InsertMentionButton({ className }: { className?: string }) {
  const [editor] = useLexicalComposerContext();

  const handleClick = useCallback(() => {
    insertMentionTrigger(editor);
  }, [editor]);

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={handleClick}
            className={cn(
              'flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-ink-faint transition-colors hover:bg-surface-panel hover:text-ink-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ink-default/15',
              className
            )}
            aria-label="Mention files & folders"
          >
            <AtSign className="h-3.5 w-3.5" aria-hidden />
          </button>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={6}>
          Mention files &amp; folders
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

function AttachImageButton({ onAttach, className }: { onAttach: () => void; className?: string }) {
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={onAttach}
            className={cn(
              'flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-ink-faint transition-colors hover:bg-surface-panel hover:text-ink-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ink-default/15',
              className
            )}
            aria-label="Attach image"
          >
            <ImagePlus className="h-3.5 w-3.5" aria-hidden />
          </button>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={6}>
          Attach image
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

function AddCommentContextMenu({ onAttachImage }: { onAttachImage?: () => void }) {
  const [editor] = useLexicalComposerContext();
  const [open, setOpen] = useState(false);
  const insertMentionAfterCloseRef = useRef(false);
  const focusFrameRef = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (focusFrameRef.current !== null) {
        window.cancelAnimationFrame(focusFrameRef.current);
      }
    },
    []
  );

  const handleMention = useCallback(() => {
    insertMentionAfterCloseRef.current = true;
  }, []);

  const handleCloseAutoFocus = useCallback(
    (event: Event) => {
      if (!insertMentionAfterCloseRef.current) return;
      insertMentionAfterCloseRef.current = false;
      event.preventDefault();
      focusFrameRef.current = window.requestAnimationFrame(() => {
        focusFrameRef.current = null;
        insertMentionTrigger(editor);
        editor.getRootElement()?.focus({ preventScroll: true });
      });
    },
    [editor]
  );

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-ink-faint transition-colors hover:bg-surface-panel hover:text-ink-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ink-default/15"
                aria-label="Add comment context"
              >
                <Plus className="h-3.5 w-3.5" aria-hidden />
              </button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          {!open && (
            <TooltipContent side="top" sideOffset={6}>
              Add context
            </TooltipContent>
          )}
        </Tooltip>
      </TooltipProvider>
      <DropdownMenuContent
        align="start"
        side="top"
        sideOffset={6}
        className="min-w-40"
        onCloseAutoFocus={handleCloseAutoFocus}
      >
        <DropdownMenuItem className="gap-2 text-xs" onSelect={handleMention}>
          <AtSign className="h-3.5 w-3.5" aria-hidden />
          Mention files &amp; folders
        </DropdownMenuItem>
        {onAttachImage && (
          <DropdownMenuItem className="gap-2 text-xs" onSelect={onAttachImage}>
            <ImagePlus className="h-3.5 w-3.5" aria-hidden />
            Attach image
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// ---------------------------------------------------------------------------
// MentionInputCommandsPlugin — Cmd+Enter submit
// ---------------------------------------------------------------------------

function MentionInputCommandsPlugin({ onSubmit }: { onSubmit?: () => void }) {
  const [editor] = useLexicalComposerContext();
  const onSubmitRef = useRef(onSubmit);
  onSubmitRef.current = onSubmit;

  useEffect(() => {
    return editor.registerCommand(
      KEY_ENTER_COMMAND,
      event => {
        if (!event) return false;
        if (event.metaKey || event.ctrlKey) {
          event.preventDefault();
          onSubmitRef.current?.();
          return true;
        }
        return false;
      },
      COMMAND_PRIORITY_HIGH
    );
  }, [editor]);

  return null;
}

// ---------------------------------------------------------------------------
// AutoFocus inline plugin
// ---------------------------------------------------------------------------

function AutoFocusOnMount({ preventScroll }: { preventScroll: boolean }) {
  const [editor] = useLexicalComposerContext();
  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      if (!preventScroll) {
        editor.focus();
        return;
      }

      const rootElement = editor.getRootElement();
      if (!rootElement) return;
      rootElement.focus({ preventScroll: true });
      editor.update(
        () => {
          const selection = $getSelection();
          if (selection) {
            $setSelection(selection.clone());
          } else {
            $getRoot().selectEnd();
          }
        },
        { tag: SKIP_SCROLL_INTO_VIEW_TAG }
      );
    });
    return () => cancelAnimationFrame(raf);
  }, [editor, preventScroll]);
  return null;
}

// ---------------------------------------------------------------------------
// EditorRefPlugin — exposes editor instance to parent
// ---------------------------------------------------------------------------

function EditorRefPlugin({ editorRef }: { editorRef: React.RefObject<LexicalEditor | null> }) {
  const [editor] = useLexicalComposerContext();
  useEffect(() => {
    (editorRef as React.MutableRefObject<LexicalEditor | null>).current = editor;
    return () => {
      (editorRef as React.MutableRefObject<LexicalEditor | null>).current = null;
    };
  }, [editor, editorRef]);
  return null;
}

// ---------------------------------------------------------------------------
// MentionInput
// ---------------------------------------------------------------------------

export function MentionInput({
  namespace,
  ariaLabel,
  value,
  onChange,
  onSubmit,
  placeholder = 'Type something...',
  autoFocus = false,
  preventAutoFocusScroll = false,
  externalFocusLock = false,
  resetSignal,
  contentEditableClassName,
  showOverflowFade = false,
  placeholderClassName,
  paragraphClassName = DEFAULT_PARAGRAPH_CLASS_NAME,
  submitButton,
  actionsPlacement = 'inline',
  footerLeadingActions,
  footerActionButtonClassName,
  inputLeadingContent,
  inputSurfaceClassName,
  inputRowClassName,
  footerClassName,
  footerControlsClassName,
  footerPortalTarget,
  initialEditorState,
  serialize,
  deserialize,
  simpleMarkdown = false,
  editorRef,
  mentionRequireWordBoundary = true,
  onMentionStateChange,
  imageAttachments
}: MentionInputProps) {
  // No cleanup effect needed — the DOM attribute is self-cleaning on unmount
  // (element removed from DOM → querySelector returns null).

  const initialConfig = useMemo<InitialConfigType>(
    () => ({
      namespace,
      theme: {
        paragraph: paragraphClassName,
        text: simpleMarkdown
          ? {
              bold: 'font-semibold',
              italic: 'italic',
              strikethrough: 'moss-strikethrough line-through',
              code: 'rounded bg-surface-code px-1 py-0.5 font-mono text-[0.95em]'
            }
          : undefined
      },
      nodes: [MentionNode],
      editorState: initialEditorState,
      onError(error: Error) {
        console.error(`MentionInput [${namespace}] error:`, error);
      }
    }),
    [initialEditorState, namespace, paragraphClassName, simpleMarkdown]
  );

  const defaultEditableClass =
    'min-h-8 max-h-32 w-full resize-none overflow-y-auto text-sm leading-relaxed text-ink-default outline-none';
  const defaultPlaceholderClass =
    'pointer-events-none absolute left-0 top-0 select-none text-caption font-light text-ink-faint';
  const responsiveRootRef = useRef<HTMLDivElement | null>(null);
  const inputContentRef = useRef<HTMLDivElement | null>(null);
  const contentEditableRef = useRef<HTMLDivElement | null>(null);
  const [hasContentBelow, setHasContentBelow] = useState(false);
  const previousFooterVisibleRef = useRef(false);
  const compactHeightRef = useRef<number | null>(null);
  const compactContentOffsetRef = useRef<number | null>(null);
  const expandedHeightRef = useRef<number | null>(null);
  const responsiveHeightAnimationRef = useRef<Animation | null>(null);
  const responsiveContentAnimationRef = useRef<Animation | null>(null);
  const responsiveAnimationCleanupTimerRef = useRef<number | null>(null);
  const responsiveMeasurementFrameRef = useRef<number | null>(null);
  const [responsiveFooterLatched, setResponsiveFooterLatched] = useState(false);
  const hasExplicitLineBreak = value?.includes('\n') ?? false;
  const hasAttachments = Boolean(imageAttachments?.imageUrls.length);
  const responsiveExpansionRequested =
    hasExplicitLineBreak || hasAttachments || responsiveFooterLatched;
  const responsiveFooterVisible = actionsPlacement === 'responsive' && responsiveExpansionRequested;
  const footerVisible = actionsPlacement === 'footer' || responsiveFooterVisible;
  const responsiveCompact = actionsPlacement === 'responsive' && !footerVisible;

  const updateOverflowFade = useCallback(() => {
    const element = contentEditableRef.current;
    const nextHasContentBelow = Boolean(
      element && element.scrollHeight - element.scrollTop - element.clientHeight > 1
    );
    setHasContentBelow((current) => (
      current === nextHasContentBelow ? current : nextHasContentBelow
    ));
  }, []);

  useLayoutEffect(() => {
    if (!showOverflowFade) {
      setHasContentBelow(false);
      return;
    }

    const element = contentEditableRef.current;
    if (!element) return;

    updateOverflowFade();
    element.addEventListener('scroll', updateOverflowFade, { passive: true });

    const resizeObserver = typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(updateOverflowFade);
    const mutationObserver = typeof MutationObserver === 'undefined'
      ? null
      : new MutationObserver(updateOverflowFade);
    resizeObserver?.observe(element);
    mutationObserver?.observe(element, {
      childList: true,
      characterData: true,
      subtree: true
    });

    return () => {
      element.removeEventListener('scroll', updateOverflowFade);
      resizeObserver?.disconnect();
      mutationObserver?.disconnect();
    };
  }, [showOverflowFade, updateOverflowFade]);

  const animateResponsiveHeightToNaturalSize = useCallback(() => {
    const root = responsiveRootRef.current;
    const previousNaturalHeight = expandedHeightRef.current;
    if (!root || previousNaturalHeight === null) return;

    const naturalHeight = Array.from(root.children).reduce((height, child) => {
      if (
        !(child instanceof HTMLElement) ||
        window.getComputedStyle(child).position === 'absolute'
      ) {
        return height;
      }
      return height + child.getBoundingClientRect().height;
    }, 0);
    if (Math.abs(naturalHeight - previousNaturalHeight) < 0.5) return;
    expandedHeightRef.current = naturalHeight;

    const runningAnimation = responsiveHeightAnimationRef.current;
    const startHeight = runningAnimation
      ? root.getBoundingClientRect().height
      : previousNaturalHeight;
    responsiveHeightAnimationRef.current = null;
    runningAnimation?.cancel();
    if (responsiveAnimationCleanupTimerRef.current !== null) {
      window.clearTimeout(responsiveAnimationCleanupTimerRef.current);
      responsiveAnimationCleanupTimerRef.current = null;
    }

    if (
      typeof root.animate !== 'function' ||
      (typeof window.matchMedia === 'function' &&
        window.matchMedia('(prefers-reduced-motion: reduce)').matches) ||
      Math.abs(naturalHeight - startHeight) < 0.5
    ) {
      root.style.removeProperty('overflow');
      return;
    }

    root.style.overflow = 'hidden';
    const heightAnimation = root.animate(
      [{ height: `${startHeight}px` }, { height: `${naturalHeight}px` }],
      {
        duration: 150,
        easing: 'cubic-bezier(0.22, 1, 0.36, 1)'
      }
    );
    responsiveHeightAnimationRef.current = heightAnimation;

    const finishTransition = () => {
      if (responsiveHeightAnimationRef.current !== heightAnimation) return;
      responsiveHeightAnimationRef.current = null;
      if (responsiveAnimationCleanupTimerRef.current !== null) {
        window.clearTimeout(responsiveAnimationCleanupTimerRef.current);
        responsiveAnimationCleanupTimerRef.current = null;
      }
      root.style.removeProperty('overflow');
    };
    heightAnimation.addEventListener('finish', finishTransition, {
      once: true
    });
    responsiveAnimationCleanupTimerRef.current = window.setTimeout(() => {
      if (responsiveHeightAnimationRef.current === heightAnimation) {
        responsiveHeightAnimationRef.current = null;
        heightAnimation.cancel();
        root.style.removeProperty('overflow');
      }
      responsiveAnimationCleanupTimerRef.current = null;
    }, 200);
  }, []);

  useLayoutEffect(() => {
    if (actionsPlacement !== 'responsive') {
      previousFooterVisibleRef.current = footerVisible;
      return;
    }
    const root = responsiveRootRef.current;
    const content = inputContentRef.current;
    const row = root?.querySelector<HTMLElement>('[data-mention-input-row="true"]');
    if (!root || !content || !row) return;

    const wasVisible = previousFooterVisibleRef.current;
    previousFooterVisibleRef.current = footerVisible;
    const currentNaturalHeight = root.offsetHeight || root.getBoundingClientRect().height;
    const currentContentOffset = Number.parseFloat(window.getComputedStyle(row).paddingLeft) || 0;

    if (wasVisible === footerVisible) {
      if (!footerVisible) {
        const previousCompactHeight = compactHeightRef.current;
        if (previousCompactHeight === null || currentNaturalHeight <= previousCompactHeight + 0.5) {
          compactHeightRef.current = currentNaturalHeight;
          compactContentOffsetRef.current = currentContentOffset;
        }
      } else if (!responsiveHeightAnimationRef.current) {
        expandedHeightRef.current = currentNaturalHeight;
      }
      return;
    }

    const runningHeightAnimation = responsiveHeightAnimationRef.current;
    const animatedStartHeight = runningHeightAnimation ? root.getBoundingClientRect().height : null;
    responsiveHeightAnimationRef.current = null;
    runningHeightAnimation?.cancel();
    responsiveContentAnimationRef.current?.cancel();
    responsiveContentAnimationRef.current = null;
    if (responsiveAnimationCleanupTimerRef.current !== null) {
      window.clearTimeout(responsiveAnimationCleanupTimerRef.current);
      responsiveAnimationCleanupTimerRef.current = null;
    }
    root.style.removeProperty('overflow');

    const endHeight = root.offsetHeight || root.getBoundingClientRect().height;
    const startHeight =
      animatedStartHeight ??
      (footerVisible ? compactHeightRef.current : expandedHeightRef.current) ??
      endHeight;
    if (footerVisible) {
      expandedHeightRef.current = endHeight;
    } else {
      compactHeightRef.current = endHeight;
      compactContentOffsetRef.current = currentContentOffset;
    }

    if (
      typeof root.animate !== 'function' ||
      (typeof window.matchMedia === 'function' &&
        window.matchMedia('(prefers-reduced-motion: reduce)').matches) ||
      Math.abs(endHeight - startHeight) < 0.5
    ) {
      return;
    }

    root.style.overflow = 'hidden';
    const animationOptions: KeyframeAnimationOptions = {
      duration: 150,
      easing: 'cubic-bezier(0.22, 1, 0.36, 1)'
    };
    const heightAnimation = root.animate(
      [{ height: `${startHeight}px` }, { height: `${endHeight}px` }],
      animationOptions
    );
    responsiveHeightAnimationRef.current = heightAnimation;

    if (footerVisible) {
      const compactContentOffset = compactContentOffsetRef.current;
      const contentOffset =
        compactContentOffset === null ? 0 : compactContentOffset - currentContentOffset;
      if (Math.abs(contentOffset) >= 0.5) {
        const contentAnimation = content.animate(
          [{ transform: `translateX(${contentOffset}px)` }, { transform: 'translateX(0)' }],
          animationOptions
        );
        responsiveContentAnimationRef.current = contentAnimation;
        contentAnimation.addEventListener(
          'finish',
          () => {
            if (responsiveContentAnimationRef.current === contentAnimation) {
              responsiveContentAnimationRef.current = null;
            }
          },
          { once: true }
        );
      }
    }

    const finishTransition = () => {
      if (responsiveHeightAnimationRef.current !== heightAnimation) return;
      responsiveHeightAnimationRef.current = null;
      if (responsiveAnimationCleanupTimerRef.current !== null) {
        window.clearTimeout(responsiveAnimationCleanupTimerRef.current);
        responsiveAnimationCleanupTimerRef.current = null;
      }
      root.style.removeProperty('overflow');
    };
    heightAnimation.addEventListener('finish', finishTransition, {
      once: true
    });
    responsiveAnimationCleanupTimerRef.current = window.setTimeout(() => {
      if (responsiveHeightAnimationRef.current === heightAnimation) {
        responsiveHeightAnimationRef.current = null;
        heightAnimation.cancel();
        root.style.removeProperty('overflow');
      }
      responsiveAnimationCleanupTimerRef.current = null;
    }, 200);
  }, [actionsPlacement, footerVisible]);

  useEffect(
    () => () => {
      if (responsiveMeasurementFrameRef.current !== null) {
        window.cancelAnimationFrame(responsiveMeasurementFrameRef.current);
        responsiveMeasurementFrameRef.current = null;
      }
      if (responsiveAnimationCleanupTimerRef.current !== null) {
        window.clearTimeout(responsiveAnimationCleanupTimerRef.current);
        responsiveAnimationCleanupTimerRef.current = null;
      }
      responsiveHeightAnimationRef.current?.cancel();
      responsiveContentAnimationRef.current?.cancel();
      responsiveHeightAnimationRef.current = null;
      responsiveContentAnimationRef.current = null;
      responsiveRootRef.current?.style.removeProperty('overflow');
    },
    []
  );

  const shouldExpandResponsiveFooter = useCallback(() => {
    const element = contentEditableRef.current;
    if (!element) return false;

    const computedLineHeight = Number.parseFloat(window.getComputedStyle(element).lineHeight);
    const singleLineHeight = Number.isFinite(computedLineHeight) ? computedLineHeight : 20;
    const contentHeight = Math.max(element.scrollHeight, element.getBoundingClientRect().height);
    const singleLineOverflow = element.scrollWidth > element.clientWidth + 0.5;
    return (
      Boolean(element.textContent?.trim()) &&
      (singleLineOverflow || contentHeight > singleLineHeight * 1.5)
    );
  }, []);

  const cancelResponsiveFooterMeasurement = useCallback(() => {
    if (responsiveMeasurementFrameRef.current === null) return;
    window.cancelAnimationFrame(responsiveMeasurementFrameRef.current);
    responsiveMeasurementFrameRef.current = null;
  }, []);

  const scheduleResponsiveFooterMeasurement = useCallback(() => {
    if (responsiveMeasurementFrameRef.current !== null) return;
    responsiveMeasurementFrameRef.current = window.requestAnimationFrame(() => {
      responsiveMeasurementFrameRef.current = null;
      if (shouldExpandResponsiveFooter()) {
        setResponsiveFooterLatched(true);
      }
    });
  }, [shouldExpandResponsiveFooter]);

  useLayoutEffect(() => {
    if (actionsPlacement !== 'responsive') {
      cancelResponsiveFooterMeasurement();
      return;
    }
    if (!value?.trim() && !hasAttachments) {
      cancelResponsiveFooterMeasurement();
      setResponsiveFooterLatched(false);
      return;
    }
    if (responsiveFooterLatched) {
      cancelResponsiveFooterMeasurement();
      return;
    }
    if (hasExplicitLineBreak || hasAttachments) {
      cancelResponsiveFooterMeasurement();
      setResponsiveFooterLatched(true);
      return;
    }
    scheduleResponsiveFooterMeasurement();
  }, [
    actionsPlacement,
    cancelResponsiveFooterMeasurement,
    hasAttachments,
    hasExplicitLineBreak,
    responsiveFooterLatched,
    scheduleResponsiveFooterMeasurement,
    value
  ]);

  useLayoutEffect(() => {
    if (actionsPlacement !== 'responsive' || typeof ResizeObserver === 'undefined') {
      return;
    }
    const element = contentEditableRef.current;
    if (!element) return;

    const handleResize = () => {
      if (responsiveFooterLatched) {
        animateResponsiveHeightToNaturalSize();
      } else {
        scheduleResponsiveFooterMeasurement();
      }
    };
    const resizeObserver = new ResizeObserver(handleResize);
    const mutationObserver =
      responsiveFooterLatched || typeof MutationObserver === 'undefined'
        ? null
        : new MutationObserver(scheduleResponsiveFooterMeasurement);
    resizeObserver.observe(element);
    mutationObserver?.observe(element, {
      childList: true,
      characterData: true,
      subtree: true
    });
    return () => {
      resizeObserver.disconnect();
      mutationObserver?.disconnect();
    };
  }, [
    actionsPlacement,
    animateResponsiveHeightToNaturalSize,
    responsiveFooterLatched,
    scheduleResponsiveFooterMeasurement
  ]);

  const persistentFooterContent =
    actionsPlacement === 'footer' ? (
      <div
        className={cn('border-t border-surface-glass-border', footerClassName)}
        data-mention-input-footer="true"
        data-mention-input-footer-state="expanded"
        data-persistent-footer="true"
      >
        <div
          className={cn('flex min-h-9 items-center px-2 py-1.5', footerControlsClassName)}
          data-mention-input-footer-controls="true"
        >
          <div className="flex min-w-0 items-end gap-1">
            <InsertMentionButton className={footerActionButtonClassName} />
            {imageAttachments && (
              <AttachImageButton onAttach={imageAttachments.onAttach} className={footerActionButtonClassName} />
            )}
            {footerLeadingActions}
          </div>
          <div className="ml-auto flex shrink-0 items-center">{submitButton}</div>
        </div>
      </div>
    ) : null;

  const editorContentEditable = (
    <ContentEditable
      ref={contentEditableRef}
      className={cn(
        contentEditableClassName ?? defaultEditableClass,
        responsiveCompact && '!whitespace-nowrap !break-normal overflow-x-hidden'
      )}
      aria-label={ariaLabel}
      aria-placeholder={placeholder}
      placeholder={() => null}
    />
  );
  const editorPlaceholder = (
    <div className={placeholderClassName ?? defaultPlaceholderClass}>{placeholder}</div>
  );

  return (
    <LexicalComposer initialConfig={initialConfig}>
      <div
        ref={responsiveRootRef}
        className={cn(
          'relative flex min-w-0 flex-col',
          actionsPlacement === 'responsive' && !footerVisible && 'h-10 overflow-hidden'
        )}
        data-mention-input-expanded={footerVisible ? 'true' : 'false'}
      >
        <div
          className={cn(
            inputSurfaceClassName,
            actionsPlacement === 'responsive' && 'shrink-0 overflow-hidden pt-1'
          )}
          data-mention-input-surface="true"
        >
          {inputLeadingContent}
          {imageAttachments && imageAttachments.imageUrls.length > 0 && (
            <div className="mb-2.5 flex flex-wrap gap-1.5">
              {imageAttachments.imageUrls.map((url, index) => {
                const displaySrc = imageAttachments.displaySrcs[index];
                if (!url || !displaySrc) return null;
                return (
                  <div
                    key={`${url}-${index}`}
                    className={cn(
                      'group relative h-10 w-10 shrink-0 overflow-hidden rounded border border-ink-default/10',
                      imageAttachments.previewClassName
                    )}
                  >
                    <button
                      type="button"
                      onClick={() => imageAttachments.onOpen?.(index)}
                      className="block h-full w-full cursor-zoom-in"
                      aria-label={`View attachment ${index + 1}`}
                    >
                      <img
                        src={displaySrc}
                        alt="Attachment"
                        className="h-full w-full object-cover object-left-top"
                      />
                    </button>
                    <button
                      type="button"
                      onClick={() => imageAttachments.onRemove(index)}
                      className="absolute right-0 top-0 flex h-3.5 w-3.5 items-center justify-center rounded-bl bg-ink-default/60 text-ink-inverse opacity-0 transition-opacity group-hover:opacity-100"
                      aria-label="Remove attachment"
                    >
                      <X className="h-2 w-2" />
                    </button>
                  </div>
                );
              })}
            </div>
          )}
          {/* Focus guard: see PromptInput.tsx for full explanation.
              Skipped when externalFocusLock is true (parent popover handles it).
              INVARIANT: all interactive children must be focusable (<button>, etc.). */}
          <div
            className={cn(
              'relative flex min-w-0 gap-1',
              actionsPlacement === 'responsive'
                ? footerVisible
                  ? 'min-h-8 items-center'
                  : 'min-h-8 items-center pl-7 pr-10'
                : footerVisible || value
                  ? 'min-h-7 items-end'
                  : 'min-h-7 items-center',
              inputRowClassName
            )}
            data-mention-input-row="true"
            {...(!externalFocusLock
              ? {
                  'data-focus-guard': '',
                  onFocusCapture: (e: React.FocusEvent<HTMLDivElement>) => {
                    e.currentTarget.setAttribute('data-focus-guard', 'active');
                  },
                  onBlurCapture: (e: React.FocusEvent<HTMLDivElement>) => {
                    const next = e.relatedTarget;
                    if (next instanceof Node && e.currentTarget.contains(next)) return;
                    e.currentTarget.setAttribute('data-focus-guard', '');
                  }
                }
              : {})}
          >
            <div
              ref={inputContentRef}
              className="relative min-w-0 flex-1"
              data-mention-input-content="true"
            >
              {simpleMarkdown ? (
                <RichTextPlugin
                  contentEditable={editorContentEditable}
                  placeholder={editorPlaceholder}
                  ErrorBoundary={LexicalErrorBoundary}
                />
              ) : (
                <PlainTextPlugin
                  contentEditable={editorContentEditable}
                  placeholder={editorPlaceholder}
                  ErrorBoundary={LexicalErrorBoundary}
                />
              )}
              {showOverflowFade ? (
                <div
                  aria-hidden="true"
                  className={cn(
                    'pointer-events-none absolute inset-x-0 bottom-0 z-10 h-6 bg-gradient-to-b from-transparent to-surface-raised-control transition-opacity duration-150 motion-reduce:transition-none',
                    hasContentBelow ? 'opacity-100' : 'opacity-0'
                  )}
                  data-mention-input-overflow-fade="true"
                  data-mention-input-overflow-fade-visible={hasContentBelow ? 'true' : 'false'}
                />
              ) : null}
            </div>
            {actionsPlacement === 'inline' ? (
              <>
                <InsertMentionButton />
                {imageAttachments && <AttachImageButton onAttach={imageAttachments.onAttach} />}
                {submitButton}
              </>
            ) : null}
          </div>
        </div>
        {actionsPlacement === 'footer' ? (
          footerPortalTarget && persistentFooterContent ? (
            createPortal(persistentFooterContent, footerPortalTarget)
          ) : (
            persistentFooterContent
          )
        ) : actionsPlacement === 'responsive' ? (
          <>
            <div
              className={cn(
                'comment-responsive-footer h-1 shrink-0 overflow-hidden',
                footerVisible && 'h-10'
              )}
              aria-hidden="true"
              data-mention-input-footer="true"
              data-mention-input-footer-state={footerVisible ? 'expanded' : 'collapsed'}
            >
              <div
                className={cn(footerVisible && 'border-t border-border-control-divider')}
                data-mention-input-footer-divider="true"
              />
            </div>
            <div
              className={cn(
                'comment-responsive-actions pointer-events-none absolute inset-x-0 flex h-6 items-center pl-2 pr-2.5',
                'bottom-2'
              )}
              data-mention-input-responsive-actions="true"
            >
              <div className="relative h-6 w-14 shrink-0">
                <div
                  className={cn(
                    'pointer-events-auto absolute inset-y-0 left-0 flex transition-opacity duration-150 ease-out motion-reduce:transition-none',
                    footerVisible && 'pointer-events-none opacity-0'
                  )}
                  aria-hidden={footerVisible}
                  inert={footerVisible || undefined}
                  data-mention-input-compact-actions="true"
                >
                  <AddCommentContextMenu onAttachImage={imageAttachments?.onAttach} />
                </div>
                <div
                  className={cn(
                    'pointer-events-none absolute inset-y-0 left-0 flex items-center gap-1 opacity-0 transition-opacity duration-150 ease-out motion-reduce:transition-none',
                    footerVisible && 'pointer-events-auto opacity-100'
                  )}
                  aria-hidden={!footerVisible}
                  inert={!footerVisible || undefined}
                  data-mention-input-expanded-actions="true"
                >
                  <InsertMentionButton />
                  {imageAttachments && <AttachImageButton onAttach={imageAttachments.onAttach} />}
                </div>
              </div>
              <div
                className="pointer-events-auto ml-auto flex shrink-0 items-center"
                data-mention-input-responsive-submit="true"
              >
                {submitButton}
              </div>
            </div>
          </>
        ) : null}
      </div>
      <HistoryPlugin />
      {simpleMarkdown && (
        <MarkdownShortcutPlugin transformers={SIMPLE_ACTION_MARKDOWN_TRANSFORMERS} />
      )}
      {autoFocus && <AutoFocusOnMount preventScroll={preventAutoFocusScroll} />}
      <MentionInputCommandsPlugin onSubmit={onSubmit} />
      <MentionPlugin
        inline
        requireWordBoundary={mentionRequireWordBoundary}
        onMentionStateChange={onMentionStateChange}
      />
      <MentionInputSyncPlugin
        value={value}
        onChange={onChange}
        serialize={serialize}
        deserialize={deserialize}
        resetSignal={resetSignal}
      />
      {editorRef && <EditorRefPlugin editorRef={editorRef} />}
    </LexicalComposer>
  );
}
