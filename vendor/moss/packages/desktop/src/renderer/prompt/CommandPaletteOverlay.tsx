// ported-from: packages/desktop/src/renderer/prompt/CommandPaletteOverlay.tsx @ 762abb777
// moss-multi seam: local-view (A§10): an empty prompt routes undo to the focused note.
import { undoFromEmptyPrompt } from '@moss-multi/host/collab/undo';
import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { Dialog } from '@moss/shared/primitives';
import { useAtom, useAtomValue, useSetAtom, useStore } from 'jotai';
import { ChevronUp, Command, CornerDownLeft, FileText, Folder, Grip, MessageSquareText, PanelsTopLeft, SquareArrowOutUpLeft, SquareArrowOutUpRight, X } from 'lucide-react';
import { $nodesOfType, type LexicalEditor } from 'lexical';
import { ClaudeIcon } from '@moss/shared/components/brand/ClaudeIcon';
import { KeyboardShortcut } from '@moss/shared/components/ui/keyboard-shortcut';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@moss/shared/components/ui/tooltip';

import { ContextPill } from '@moss/shared';
import {
  activeExpandedActionTabIdsAtom,
  actionsPanelHiddenAtom,
  browserSplitTargetAtom,
  webEmbedLightboxTargetAtom,
  commandPaletteDockedAtom,
  commandPaletteDockHostAtom,
  commandPaletteDockPreviewAtom,
  focusedNoteIdAtom,
  pendingAgentCommentContextAtom,
  promptDraftAtom,
  toggleZenModeAtom,
  zenModeAtom
} from '@moss/shared/state/atoms';
import {
  actionsPanelActiveTabAtom,
  noteCommentAnchorIdsAtom,
  noteCommentAnchorIdsSyncedAtom,
  noteCommentsMapAtom,
  noteContentAtom,
  noteEntityAtom,
  noteIdsAtom
} from '@moss/shared/state/note-atoms';
import type { PromptMention, PromptSubmitResult } from './PromptInput';
import { MentionNode } from './MentionNode';
import type { MentionState } from './MentionPlugin';
import { MentionInput } from '../editor/components/MentionInput';
import { serializeCommentEditor, deserializeCommentEditor } from '../editor/utils/comment-mentions';
import { imagesApi } from '../api/electron';
import { toDisplaySrc } from '../editor/utils/asset-url';
import { lightboxSrcAtom } from '../editor/components/ImageLightbox';
import { contextPillsAtom, dismissPillAtom } from '../state/granted-dirs-atoms';
import { countReachableCommentsInThreads } from '../editor/utils/comment-thread-count';
import {
  ADDRESS_ALL_OPEN_COMMENTS_PROMPT,
  buildPendingCommentContext,
  clearPendingCommentAgentContext,
  collectReachableCommentThreadsForAgent,
  formatAddressOpenCommentsLabel
} from '../editor/utils/comment-agent-context';
import { getCommentAttributionTextClassForColor } from '../editor/utils/comment-author-display';
import { CommentTextContent } from '../editor/components/CommentTextContent';

export interface CommandPaletteOverlayProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (prompt: string, noteIds: string[], mentions: PromptMention[], directoryPaths: string[], imageUrls: string[], skills?: string[]) => void;
  isSubmitting?: boolean;
  selectedContext?: string | null;
  selectedContextIconUrl?: string | null;
  onClearSelectedContext?: () => void;
  anchorSelector?: string;
  isActionsPanelHidden?: boolean;
  isNotesPanelHidden?: boolean;
}

export interface CommandPaletteOverlayHandle {
  focus: () => void;
  undock: () => void;
}

type PalettePosition = { left: number; top: number };

const PALETTE_POSITION_STORAGE_KEY = 'moss.commandPalette.position';
const PALETTE_VIEWPORT_MARGIN_PX = 12;
const PALETTE_FALLBACK_WIDTH_PX = 512;
const PALETTE_FALLBACK_HEIGHT_PX = 280;
const PALETTE_FALLBACK_PANEL_WIDTH_PX = 224;
const PALETTE_DRAG_ACTIVATION_DISTANCE_PX = 4;
const MAX_COLLAPSED_CONTEXT_ITEMS = {
  docked: 1,
  floating: 3
} as const;
const PALETTE_FLOATING_WIDTH_STYLE = {
  width: `calc(100vw - ${PALETTE_VIEWPORT_MARGIN_PX * 2}px)`,
  maxWidth: PALETTE_FALLBACK_WIDTH_PX
} satisfies CSSProperties;

const PALETTE_HEADER_BUTTON_CLASS =
  'flex h-6 w-6 items-center justify-center rounded text-ink-faint transition-colors hover:bg-surface-panel/50 hover:text-ink-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ink-default/15';
const PALETTE_FRAME_RADIUS_CLASS = 'rounded-lg';

function readStoredPalettePosition(): PalettePosition | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(PALETTE_POSITION_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PalettePosition>;
    return typeof parsed.left === 'number' && typeof parsed.top === 'number'
      ? parsed as PalettePosition
      : null;
  } catch {
    return null;
  }
}

function clampPalettePosition(
  left: number,
  top: number,
  width: number,
  height: number
): PalettePosition {
  if (typeof window === 'undefined') {
    return { left, top };
  }
  const maxLeft = Math.max(PALETTE_VIEWPORT_MARGIN_PX, window.innerWidth - width - PALETTE_VIEWPORT_MARGIN_PX);
  const maxTop = Math.max(PALETTE_VIEWPORT_MARGIN_PX, window.innerHeight - height - PALETTE_VIEWPORT_MARGIN_PX);
  return {
    left: Math.min(Math.max(PALETTE_VIEWPORT_MARGIN_PX, left), maxLeft),
    top: Math.min(Math.max(PALETTE_VIEWPORT_MARGIN_PX, top), maxTop)
  };
}

export interface PaletteObstacleRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * The browser split shares the canvas with the note, so the floating palette
 * moves clear of it. The web-embed lightbox is modal and leaves no gap wide
 * enough for the palette, so the palette is suppressed there instead.
 */
const BROWSER_SPLIT_SELECTOR = '[data-browser-split-pane="true"]';

function readBrowserSplitRect(): PaletteObstacleRect | null {
  const element = document.querySelector<HTMLElement>(BROWSER_SPLIT_SELECTOR);
  if (!element) return null;
  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;
  return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
}

function rectsIntersect(
  position: PalettePosition,
  width: number,
  height: number,
  obstacle: PaletteObstacleRect
): boolean {
  return (
    position.left < obstacle.right &&
    obstacle.left < position.left + width &&
    position.top < obstacle.bottom &&
    obstacle.top < position.top + height
  );
}

/**
 * Move the palette clear of an occupied region (the browser split pane or the
 * web-embed lightbox) without changing its size. Tries the gap on each side in
 * turn and keeps the original position when nothing fits, so a cramped window
 * never lands the palette somewhere worse than where it started.
 */
export function clampPaletteClearOfObstacle(
  position: PalettePosition,
  width: number,
  height: number,
  obstacle: PaletteObstacleRect | null,
  viewport: { width: number; height: number },
  margin: number = PALETTE_VIEWPORT_MARGIN_PX
): PalettePosition {
  if (!obstacle || !rectsIntersect(position, width, height, obstacle)) {
    return position;
  }

  const leftOfObstacle = obstacle.left - width - margin;
  if (leftOfObstacle >= margin) {
    return { left: leftOfObstacle, top: position.top };
  }

  const rightOfObstacle = obstacle.right + margin;
  if (rightOfObstacle + width <= viewport.width - margin) {
    return { left: rightOfObstacle, top: position.top };
  }

  const aboveObstacle = obstacle.top - height - margin;
  if (aboveObstacle >= margin) {
    return { left: position.left, top: aboveObstacle };
  }

  const belowObstacle = obstacle.bottom + margin;
  if (belowObstacle + height <= viewport.height - margin) {
    return { left: position.left, top: belowObstacle };
  }

  return position;
}

function getPaletteViewportSize(element: HTMLElement | null): { width: number; height: number } {
  const rect = element?.getBoundingClientRect();
  return {
    width: rect && rect.width > 0 ? rect.width : PALETTE_FALLBACK_WIDTH_PX,
    height: rect && rect.height > 0 ? rect.height : PALETTE_FALLBACK_HEIGHT_PX
  };
}

function readPanelWidth(customProperty: string): number {
  if (typeof window === 'undefined') {
    return PALETTE_FALLBACK_PANEL_WIDTH_PX;
  }
  const value = Number.parseFloat(
    window.getComputedStyle(document.documentElement).getPropertyValue(customProperty)
  );
  return Number.isFinite(value) && value >= 0
    ? value
    : PALETTE_FALLBACK_PANEL_WIDTH_PX;
}

export const CommandPaletteOverlay = forwardRef<CommandPaletteOverlayHandle, CommandPaletteOverlayProps>(
  function CommandPaletteOverlay(
    {
      open,
      onOpenChange,
      onSubmit,
      isSubmitting = false,
      selectedContext,
      selectedContextIconUrl,
      onClearSelectedContext,
      anchorSelector,
      isActionsPanelHidden = false,
      isNotesPanelHidden = false
    },
    ref
  ) {
    const contentRef = useRef<HTMLDivElement>(null);
    const dockedSectionRef = useRef<HTMLElement>(null);
    const composerEditorRef = useRef<LexicalEditor | null>(null);
    const dockToggleButtonRef = useRef<HTMLButtonElement>(null);
    const moveButtonRef = useRef<HTMLButtonElement>(null);
    const centerOnUndockRef = useRef(false);
    const store = useStore();

    const [mentionState, setMentionState] = useState<MentionState | null>(null);
    const [imageUrls, setImageUrls] = useState<string[]>([]);
    const [mockupActive, setMockupActive] = useState(false);
    const [contextTrayExpanded, setContextTrayExpanded] = useState(false);
    const [dockDropIndicatorStyle, setDockDropIndicatorStyle] = useState<CSSProperties | null>(null);
    const [anchorStyle, setAnchorStyle] = useState<CSSProperties | null>(null);
    const [defaultPosition, setDefaultPosition] = useState<PalettePosition | null>(null);
    const [floatingPosition, setFloatingPosition] = useState<PalettePosition | null>(() => readStoredPalettePosition());
    const [isDocked, setIsDocked] = useAtom(commandPaletteDockedAtom);
    const [isDockPreviewing, setIsDockPreviewing] = useAtom(commandPaletteDockPreviewAtom);
    const dockHost = useAtomValue(commandPaletteDockHostAtom);
    const [composerResetSignal, setComposerResetSignal] = useState(0);
    const dragStateRef = useRef<{
      pointerId: number;
      startX: number;
      startY: number;
      startLeft: number;
      startTop: number;
      width: number;
      height: number;
      activated: boolean;
      startedDocked: boolean;
    } | null>(null);

    // Auto-activate mockup mode when opened from a mockup image's "Send to Agent"
    useEffect(() => {
      if (selectedContext?.startsWith('[Mockup:')) {
        setMockupActive(true);
      }
    }, [selectedContext]);

    const focusedNoteId = useAtomValue(focusedNoteIdAtom);
    const focusedNoteKey = focusedNoteId ?? '__no-focused-note__';
    const commentsMap = useAtomValue(noteCommentsMapAtom(focusedNoteKey));
    const noteContent = useAtomValue(noteContentAtom(focusedNoteKey));
    const liveCommentAnchorIds = useAtomValue(noteCommentAnchorIdsAtom(focusedNoteKey));
    const liveCommentAnchorIdsSynced = useAtomValue(noteCommentAnchorIdsSyncedAtom(focusedNoteKey));
    const commentAnchorOptions = useMemo(
      () => liveCommentAnchorIdsSynced
        ? { anchorIdsOverride: liveCommentAnchorIds }
        : { extraAnchorIds: liveCommentAnchorIds },
      [liveCommentAnchorIds, liveCommentAnchorIdsSynced]
    );
    // Counts every open comment, replies included — not threads. The button
    // addresses all open comments, so resolved threads must not contribute.
    const commentCount = useMemo(
      () => focusedNoteId
        ? countReachableCommentsInThreads(commentsMap, noteContent.content, {
            status: 'open',
            ...commentAnchorOptions
          })
        : 0,
      [commentAnchorOptions, commentsMap, focusedNoteId, noteContent.content]
    );
    const addressOpenCommentsLabel = formatAddressOpenCommentsLabel(commentCount);
    const commentContext = useAtomValue(pendingAgentCommentContextAtom);
    const promptDraft = useAtomValue(promptDraftAtom);
    const setPromptDraft = useSetAtom(promptDraftAtom);
    const setLightboxSrc = useSetAtom(lightboxSrcAtom);


    // Context pills from workspace-wide atom (persistent across open/close)
    const pills = useAtomValue(contextPillsAtom);
    const dismissPill = useSetAtom(dismissPillAtom);
    const addressAllCommentContext = useMemo(() => {
      if (commentCount === 0) return null;
      return buildPendingCommentContext({
        scope: 'all',
        threads: collectReachableCommentThreadsForAgent(commentsMap, noteContent.content, commentAnchorOptions),
        promptText: ADDRESS_ALL_OPEN_COMMENTS_PROMPT
      });
    }, [commentAnchorOptions, commentCount, commentsMap, noteContent.content]);

    const visibleCommentContext =
      commentContext ??
      (promptDraft === ADDRESS_ALL_OPEN_COMMENTS_PROMPT ? addressAllCommentContext : null);

    useEffect(() => {
      if (!open || commentContext || promptDraft !== ADDRESS_ALL_OPEN_COMMENTS_PROMPT || !addressAllCommentContext) {
        return;
      }
      store.set(pendingAgentCommentContextAtom, addressAllCommentContext);
    }, [addressAllCommentContext, commentContext, open, promptDraft, store]);

    const focusComposer = useCallback(() => {
      composerEditorRef.current?.focus();
    }, []);

    const handleAddressAllComments = useCallback(() => {
      if (!addressAllCommentContext) return;
      const nextContext = addressAllCommentContext;
      setContextTrayExpanded(false);
      store.set(pendingAgentCommentContextAtom, nextContext);
      store.set(promptDraftAtom, ADDRESS_ALL_OPEN_COMMENTS_PROMPT);
      focusComposer();
    }, [addressAllCommentContext, focusComposer, store]);

    const handleRemoveCommentContext = useCallback(() => {
      const contextPromptText = visibleCommentContext?.promptText;
      setContextTrayExpanded(false);
      clearPendingCommentAgentContext(store);
      if (contextPromptText && store.get(promptDraftAtom) === contextPromptText) {
        store.set(promptDraftAtom, '');
        setComposerResetSignal((value) => value + 1);
      }
      focusComposer();
    }, [focusComposer, store, visibleCommentContext?.promptText]);

    const handleImageAttach = useCallback(async () => {
      if (!focusedNoteId) return;
      const results = await imagesApi.pick.invoke({ noteId: focusedNoteId });
      if (results.length > 0) {
        setImageUrls((prev) => [...prev, ...results.map(r => r.absolutePath)]);
      }
      focusComposer();
    }, [focusComposer, focusedNoteId]);

    const handleImageRemove = useCallback((index: number) => {
      setImageUrls((prev) => prev.filter((_, i) => i !== index));
    }, []);

    const handleImageOpen = useCallback((startIndex: number) => {
      const displaySources = imageUrls.map((url) => toDisplaySrc(url, focusedNoteId));
      if (displaySources.length === 0) return;
      const index = Math.min(Math.max(startIndex, 0), displaySources.length - 1);
      setLightboxSrc({ kind: 'carousel', sources: displaySources, index });
    }, [focusedNoteId, imageUrls, setLightboxSrc]);

    const focusActionableFallback = useCallback((): boolean => {
      const target = [
        dockToggleButtonRef.current,
        moveButtonRef.current
      ].find((candidate) => candidate != null && !candidate.disabled) ?? null;
      target?.focus({ preventScroll: true });
      return target != null;
    }, []);

    const prepareDockDestination = useCallback(() => {
      if (store.get(zenModeAtom)) {
        store.set(toggleZenModeAtom);
      }
      store.set(actionsPanelHiddenAtom, false);
      store.set(actionsPanelActiveTabAtom, 'actions');
      store.set(activeExpandedActionTabIdsAtom, new Set());
    }, [store]);

    const focusPaletteTarget = useCallback(() => {
      if (isDocked) {
        // The dock host may be hidden (panel collapsed, Properties tab) —
        // reveal it before trying to focus the composer.
        prepareDockDestination();
        focusComposer();
        queueMicrotask(() => {
          focusComposer();
          requestAnimationFrame(() => {
            if (composerEditorRef.current) {
              composerEditorRef.current.focus();
              return;
            }
            focusActionableFallback();
          });
        });
        return;
      }

      const content = contentRef.current;
      if (composerEditorRef.current) {
        composerEditorRef.current.focus();
        queueMicrotask(() => {
          composerEditorRef.current?.focus();
          requestAnimationFrame(() => {
            composerEditorRef.current?.focus();
            if (!content || content.contains(document.activeElement)) {
              return;
            }
            focusActionableFallback();
          });
        });
        return;
      }

      focusActionableFallback();
    }, [focusActionableFallback, focusComposer, isDocked, prepareDockDestination]);

    const focusPaletteTargetRef = useRef(focusPaletteTarget);
    focusPaletteTargetRef.current = focusPaletteTarget;

    // Focus the docked composer when the palette is (re)opened while docked.
    const prevOpenRef = useRef(open);
    useEffect(() => {
      const wasOpen = prevOpenRef.current;
      prevOpenRef.current = open;
      if (!isDocked || !open || wasOpen) return;
      focusPaletteTargetRef.current();
    }, [isDocked, open]);

    // Cmd+I keyboard shortcut for image attach. The docked palette is a
    // persistent panel fixture, so only intercept when focus is inside it —
    // otherwise Cmd+I must keep meaning italic in the note editor.
    useEffect(() => {
      if (!open && !isDocked) return;
      const handler = (e: KeyboardEvent) => {
        if ((e.metaKey || e.ctrlKey) && e.key === 'i') {
          const container: HTMLElement | null = isDocked
            ? dockedSectionRef.current
            : contentRef.current;
          if (isDocked && (!container || !container.contains(document.activeElement))) {
            return;
          }
          e.preventDefault();
          handleImageAttach();
        }
      };
      window.addEventListener('keydown', handler);
      return () => window.removeEventListener('keydown', handler);
    }, [open, isDocked, handleImageAttach]);

    const sendDisabledReason = isSubmitting
      ? 'An action is already running on this note'
      : promptDraft.trim().length === 0
        ? 'Write an action to send'
        : null;
    const sendDisabled = sendDisabledReason !== null;
    const palettePositionStyle = {
      left: `calc((${isNotesPanelHidden ? '0px' : 'var(--notes-panel-width, 14rem)'} + 100vw - ${isActionsPanelHidden ? '0px' : 'var(--actions-panel-width, 14rem)'}) / 2)`
    } satisfies CSSProperties;

    const updateDefaultPosition = useCallback(() => {
      if (!open || isDocked || floatingPosition !== null) return;
      const { width, height } = getPaletteViewportSize(contentRef.current);
      const notesPanelWidth = isNotesPanelHidden ? 0 : readPanelWidth('--notes-panel-width');
      const actionsPanelWidth = isActionsPanelHidden ? 0 : readPanelWidth('--actions-panel-width');
      const centerX = (notesPanelWidth + window.innerWidth - actionsPanelWidth) / 2;
      const next = clampPalettePosition(
        centerX - width / 2,
        window.innerHeight * 0.2,
        width,
        height
      );
      setDefaultPosition((previous) =>
        previous?.left === next.left && previous.top === next.top ? previous : next
      );
    }, [floatingPosition, isActionsPanelHidden, isDocked, isNotesPanelHidden, open]);

    useLayoutEffect(() => {
      updateDefaultPosition();
    }, [updateDefaultPosition]);

    useEffect(() => {
      if (!open || isDocked || floatingPosition !== null) return;
      window.addEventListener('resize', updateDefaultPosition);

      const resizeObserver = typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver(updateDefaultPosition)
        : null;
      const observedElements = [
        contentRef.current,
        document.querySelector('[data-notes-panel]'),
        document.querySelector('[data-actions-panel-wrapper="true"]')
      ].filter((element): element is Element => element instanceof Element);
      observedElements.forEach((element) => resizeObserver?.observe(element));

      return () => {
        window.removeEventListener('resize', updateDefaultPosition);
        resizeObserver?.disconnect();
      };
    }, [floatingPosition, isDocked, open, updateDefaultPosition]);

    useEffect(() => {
      if (typeof window === 'undefined' || floatingPosition === null) return;
      window.localStorage.setItem(PALETTE_POSITION_STORAGE_KEY, JSON.stringify(floatingPosition));
    }, [floatingPosition]);

    const clampFloatingPositionToViewport = useCallback(() => {
      if (!open || isDocked) return;
      const { width, height } = getPaletteViewportSize(contentRef.current);
      setFloatingPosition((previous) => {
        if (!previous) return previous;
        const next = clampPalettePosition(previous.left, previous.top, width, height);
        return next.left === previous.left && next.top === previous.top ? previous : next;
      });
    }, [isDocked, open]);

    useLayoutEffect(() => {
      clampFloatingPositionToViewport();
    }, [clampFloatingPositionToViewport]);

    useEffect(() => {
      if (!open || isDocked || floatingPosition === null) return;
      window.addEventListener('resize', clampFloatingPositionToViewport);
      return () => {
        window.removeEventListener('resize', clampFloatingPositionToViewport);
      };
    }, [clampFloatingPositionToViewport, floatingPosition, isDocked, open]);

    useLayoutEffect(() => {
      if (!open || !isDocked) return;
      prepareDockDestination();
    }, [isDocked, open, prepareDockDestination]);

    useEffect(() => {
      if (!open || !anchorSelector) {
        setAnchorStyle(null);
        return;
      }

      const updateAnchorStyle = () => {
        const anchor = document.querySelector(anchorSelector);
        if (!(anchor instanceof HTMLElement)) {
          setAnchorStyle(null);
          return;
        }
        const rect = anchor.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) {
          setAnchorStyle(null);
          return;
        }
        const measuredSize = getPaletteViewportSize(contentRef.current);
        const width = Math.min(
          measuredSize.width,
          Math.max(0, rect.width - PALETTE_VIEWPORT_MARGIN_PX * 2)
        );
        const next = clampPalettePosition(
          rect.left + rect.width / 2 - width / 2,
          rect.top + Math.min(Math.max(rect.height * 0.2, 96), 180),
          width,
          measuredSize.height
        );
        const minPaneLeft = rect.left + PALETTE_VIEWPORT_MARGIN_PX;
        const maxPaneLeft = rect.right - width - PALETTE_VIEWPORT_MARGIN_PX;
        const left = maxPaneLeft >= minPaneLeft
          ? Math.min(Math.max(next.left, minPaneLeft), maxPaneLeft)
          : next.left;
        const nextStyle = {
          left,
          top: next.top,
          width,
          maxWidth: width,
          transform: 'none'
        } satisfies CSSProperties;
        setAnchorStyle((previous) =>
          previous?.left === nextStyle.left &&
          previous.top === nextStyle.top &&
          previous.width === nextStyle.width
            ? previous
            : nextStyle
        );
      };

      updateAnchorStyle();
      window.addEventListener('resize', updateAnchorStyle);

      // Dragging the split divider resizes the note pane without firing a window
      // 'resize', so observe the anchor element directly to keep the palette
      // pinned over it.
      const anchor = document.querySelector(anchorSelector);
      const resizeObserver =
        anchor instanceof HTMLElement && typeof ResizeObserver !== 'undefined'
          ? new ResizeObserver(updateAnchorStyle)
          : null;
      if (resizeObserver && anchor instanceof HTMLElement) {
        resizeObserver.observe(anchor);
        if (contentRef.current) {
          resizeObserver.observe(contentRef.current);
        }
      }

      return () => {
        window.removeEventListener('resize', updateAnchorStyle);
        resizeObserver?.disconnect();
      };
    }, [anchorSelector, open]);

    const handleSubmitResult = useCallback(
      (result: PromptSubmitResult) => {
        if (result.text.trim().length === 0 || sendDisabled) {
          return;
        }
        const attachedImages = imageUrls;
        const skills = mockupActive ? ['html'] : undefined;
        setImageUrls([]);
        setMockupActive(false);
        onSubmit(result.text, result.noteIds, result.mentions, result.directoryPaths, attachedImages, skills);
      },
      [onSubmit, sendDisabled, imageUrls, mockupActive]
    );

    // Both palette locations submit through the same controlled composer so
    // moving it never changes mention, draft, or keyboard behavior.
    const handleComposerSubmit = useCallback(() => {
      const editor = composerEditorRef.current;
      if (!editor || sendDisabled) return;
      let text = '';
      let mentions: PromptMention[] = [];
      editor.getEditorState().read(() => {
        mentions = $nodesOfType(MentionNode).map((node) => ({
          id: node.getMentionId(),
          title: node.getMentionTitle(),
          type: node.getMentionType()
        }));
      });
      text = serializeCommentEditor(editor, {
        simpleMarkdown: true,
        mentionsAsText: true
      }).trim();
      if (text.length === 0) return;
      const noteIds = mentions
        .filter((mention) => mention.type === 'note')
        .map((mention) => mention.id);
      const directoryPaths = mentions
        .filter((mention) => mention.type === 'directory')
        .map((mention) => mention.id);
      handleSubmitResult({ text, noteIds, directoryPaths, mentions, imageUrls: [] });
      setPromptDraft('');
      setContextTrayExpanded(false);
      setComposerResetSignal((value) => value + 1);
    }, [handleSubmitResult, sendDisabled, setPromptDraft]);

    const resolveNoteIdByTitle = useCallback((title: string): string | null => {
      const ids = store.get(noteIdsAtom);
      const titleLower = title.toLowerCase();
      for (const id of ids) {
        const entity = store.get(noteEntityAtom(id));
        if (entity && entity.title.toLowerCase() === titleLower) {
          return id;
        }
      }
      return null;
    }, [store]);

    const serializeDockedDraft = useCallback(
      (editor: LexicalEditor) => serializeCommentEditor(editor, {
        preserveMentionIds: true,
        simpleMarkdown: true
      }),
      []
    );

    const deserializeDockedDraft = useCallback(
      (editor: LexicalEditor, text: string) =>
        deserializeCommentEditor(editor, text, {
          resolveNoteId: resolveNoteIdByTitle,
          simpleMarkdown: true
        }),
      [resolveNoteIdByTitle]
    );

    const handleClose = useCallback(() => {
      if (isSubmitting) return;
      setImageUrls([]);
      setMockupActive(false);
      setContextTrayExpanded(false);
      onOpenChange(false);
    }, [onOpenChange, isSubmitting]);

    // Escape inside the docked composer just returns focus to the app — the
    // docked palette itself never closes.
    const handleDockedKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key !== 'Escape' || mentionState?.isOpen) return;
      const active = document.activeElement;
      if (active instanceof HTMLElement) {
        active.blur();
      }
    }, [mentionState?.isOpen]);

    const clearPaletteDrag = useCallback(() => {
      dragStateRef.current = null;
      setDockDropIndicatorStyle(null);
      setIsDockPreviewing(false);
      document.body.style.removeProperty('cursor');
      document.body.style.removeProperty('user-select');
    }, [setIsDockPreviewing]);

    const isPointerOverActionsPanel = useCallback((
      clientX: number,
      clientY: number,
      floatingRect?: { left: number; top: number; right: number; bottom: number }
    ) => {
      const panel = document.querySelector<HTMLElement>('[data-actions-panel-wrapper="true"]');
      const rect = panel?.getBoundingClientRect();
      if (!panel || !rect || rect.width <= 0 || rect.height <= 0) {
        setDockDropIndicatorStyle(null);
        setIsDockPreviewing(false);
        return false;
      }
      const isOver = clientX >= rect.left && clientX <= rect.right
        && clientY >= rect.top && clientY <= rect.bottom;
      const isOverlapping = floatingRect
        ? floatingRect.right >= rect.left
          && floatingRect.left <= rect.right
          && floatingRect.bottom >= rect.top
          && floatingRect.top <= rect.bottom
        : false;
      setDockDropIndicatorStyle(
        isOverlapping && !isOver
          ? { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
          : null
      );
      if (!isOver) {
        setIsDockPreviewing(false);
        return false;
      }
      setIsDockPreviewing(dockHost !== null);
      return isOver;
    }, [dockHost, setIsDockPreviewing]);

    const beginPaletteDrag = useCallback((event: ReactPointerEvent<HTMLElement>) => {
      if (event.button !== 0) return;
      const sourceRect = isDocked
        ? dockedSectionRef.current?.getBoundingClientRect()
        : contentRef.current?.getBoundingClientRect();
      if (!sourceRect) return;

      event.preventDefault();
      event.stopPropagation();
      const width = isDocked
        ? Math.min(PALETTE_FALLBACK_WIDTH_PX, window.innerWidth - PALETTE_VIEWPORT_MARGIN_PX * 2)
        : sourceRect.width;
      const height = isDocked ? PALETTE_FALLBACK_HEIGHT_PX : sourceRect.height;
      const clamped = isDocked
        ? clampPalettePosition(
            event.clientX - 20,
            event.clientY - 18,
            width,
            height
          )
        : clampPalettePosition(sourceRect.left, sourceRect.top, width, height);
      dragStateRef.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        startLeft: clamped.left,
        startTop: clamped.top,
        width,
        height,
        activated: false,
        startedDocked: isDocked
      };
    }, [isDocked]);

    useEffect(() => {
      const handlePointerMove = (event: PointerEvent) => {
        const drag = dragStateRef.current;
        if (!drag || event.pointerId !== drag.pointerId) return;
        const deltaX = event.clientX - drag.startX;
        const deltaY = event.clientY - drag.startY;
        if (!drag.activated) {
          if (Math.hypot(deltaX, deltaY) < PALETTE_DRAG_ACTIVATION_DISTANCE_PX) return;
          drag.activated = true;
          document.body.style.cursor = 'grabbing';
          document.body.style.userSelect = 'none';
          if (drag.startedDocked) {
            setFloatingPosition({ left: drag.startLeft, top: drag.startTop });
            setIsDocked(false);
            if (!open) onOpenChange(true);
          }
        }
        event.preventDefault();
        const nextPosition = clampPalettePosition(
          drag.startLeft + deltaX,
          drag.startTop + deltaY,
          drag.width,
          drag.height
        );
        setFloatingPosition(nextPosition);
        isPointerOverActionsPanel(event.clientX, event.clientY, {
          left: nextPosition.left,
          top: nextPosition.top,
          right: nextPosition.left + drag.width,
          bottom: nextPosition.top + drag.height
        });
      };

      const handlePointerEnd = (event: PointerEvent) => {
        const drag = dragStateRef.current;
        if (!drag || event.pointerId !== drag.pointerId) return;
        const shouldDock = drag.activated && isPointerOverActionsPanel(event.clientX, event.clientY);
        clearPaletteDrag();
        if (!shouldDock) return;
        prepareDockDestination();
        setIsDocked(true);
        requestAnimationFrame(() => focusPaletteTargetRef.current());
      };

      const handlePointerCancel = (event: PointerEvent) => {
        const drag = dragStateRef.current;
        if (!drag || event.pointerId !== drag.pointerId) return;
        clearPaletteDrag();
      };

      window.addEventListener('pointermove', handlePointerMove, { capture: true });
      window.addEventListener('pointerup', handlePointerEnd, { capture: true });
      window.addEventListener('pointercancel', handlePointerCancel, { capture: true });
      return () => {
        window.removeEventListener('pointermove', handlePointerMove, { capture: true });
        window.removeEventListener('pointerup', handlePointerEnd, { capture: true });
        window.removeEventListener('pointercancel', handlePointerCancel, { capture: true });
      };
    }, [
      clearPaletteDrag,
      isPointerOverActionsPanel,
      onOpenChange,
      open,
      prepareDockDestination,
      setIsDocked
    ]);

    useEffect(() => () => {
      dragStateRef.current = null;
      setIsDockPreviewing(false);
      document.body.style.removeProperty('cursor');
      document.body.style.removeProperty('user-select');
    }, [setIsDockPreviewing]);

    const undockPalette = useCallback(() => {
      if (!isDocked) return;
      centerOnUndockRef.current = true;
      setFloatingPosition(null);
      setIsDocked(false);
      if (!open) {
        onOpenChange(true);
      }
    }, [isDocked, onOpenChange, open, setIsDocked]);

    const handleDockToggle = useCallback(() => {
      if (isDocked) {
        undockPalette();
        return;
      }
      prepareDockDestination();
      setIsDocked(true);
      requestAnimationFrame(() => focusPaletteTargetRef.current());
    }, [isDocked, prepareDockDestination, setIsDocked, undockPalette]);

    useImperativeHandle(ref, () => ({
      focus: focusPaletteTarget,
      undock: undockPalette
    }), [focusPaletteTarget, undockPalette]);

    useLayoutEffect(() => {
      if (!open || isDocked || !centerOnUndockRef.current) return;
      centerOnUndockRef.current = false;
      const { width, height } = getPaletteViewportSize(contentRef.current);
      setFloatingPosition(clampPalettePosition(
        (window.innerWidth - width) / 2,
        (window.innerHeight - height) / 2,
        width,
        height
      ));
    }, [isDocked, open]);

    // Open-state comes from the browser atoms (the single source of truth);
    // the rect is measured from the surface those atoms render. Measuring runs
    // when open-state flips and when the surface resizes — never per render or
    // per keystroke.
    const browserSplitOpen = useAtomValue(browserSplitTargetAtom) !== null;
    const webEmbedLightboxOpen = useAtomValue(webEmbedLightboxTargetAtom) !== null;

    useEffect(() => {
      if (!open || isDocked || !browserSplitOpen) return;

      const moveClearOfBrowser = () => {
        const obstacle = readBrowserSplitRect();
        if (!obstacle) return;
        const element = contentRef.current;
        if (!element) return;
        const rect = element.getBoundingClientRect();
        const current = { left: rect.left, top: rect.top };
        const next = clampPaletteClearOfObstacle(
          current,
          rect.width,
          rect.height,
          obstacle,
          { width: window.innerWidth, height: window.innerHeight }
        );
        if (next.left === current.left && next.top === current.top) return;
        setFloatingPosition(clampPalettePosition(next.left, next.top, rect.width, rect.height));
      };

      moveClearOfBrowser();

      if (typeof ResizeObserver === 'undefined') return;
      const element = document.querySelector<HTMLElement>(BROWSER_SPLIT_SELECTOR);
      if (!element) return;
      const observer = new ResizeObserver(moveClearOfBrowser);
      observer.observe(element);
      return () => observer.disconnect();
    }, [browserSplitOpen, isDocked, open]);

    const anchoredPalettePositionStyle = anchorStyle ?? palettePositionStyle;
    const unresolvedPalettePositionStyle = anchorStyle ?? (
      defaultPosition
        ? { ...defaultPosition, transform: 'none' }
        : anchoredPalettePositionStyle
    );
    const paletteSurfaceStyle = {
      ...PALETTE_FLOATING_WIDTH_STYLE,
      ...(floatingPosition
        ? { left: floatingPosition.left, top: floatingPosition.top, transform: 'none' }
        : unresolvedPalettePositionStyle)
    } satisfies CSSProperties;

    const paletteGripControl = (
      <TooltipProvider delayDuration={300}>
        <div className="flex items-center text-ink-faint" data-command-palette-controls="true">
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                ref={moveButtonRef}
                type="button"
                className="flex h-6 w-6 cursor-grab items-center justify-center rounded text-ink-faint transition-colors hover:bg-surface-panel/50 hover:text-ink-muted active:cursor-grabbing focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-brand forced-colors:focus-visible:outline forced-colors:focus-visible:outline-2 forced-colors:focus-visible:outline-offset-2"
                aria-label="Move command palette"
                onPointerDown={beginPaletteDrag}
              >
                <Grip className="h-3.5 w-3.5" aria-hidden />
              </button>
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={6}>Move palette</TooltipContent>
          </Tooltip>
        </div>
      </TooltipProvider>
    );

    const floatingDockControl = (
      <TooltipProvider delayDuration={300}>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              ref={dockToggleButtonRef}
              type="button"
              onPointerDown={(event) => event.stopPropagation()}
              onClick={handleDockToggle}
              className={PALETTE_HEADER_BUTTON_CLASS}
              aria-label="Dock command palette"
              aria-pressed={false}
            >
              <SquareArrowOutUpRight className="h-3.5 w-3.5" aria-hidden />
            </button>
          </TooltipTrigger>
          <TooltipContent side="top" sideOffset={6}>Dock to actions panel</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );

    const dockedFloatControl = (
      <TooltipProvider delayDuration={300}>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={undockPalette}
              className={PALETTE_HEADER_BUTTON_CLASS}
              aria-label="Float command palette"
            >
              <SquareArrowOutUpLeft className="h-3.5 w-3.5" aria-hidden />
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">Float command palette</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );

    const mentionHints = (
      <div className="flex items-center gap-3 text-nano text-ink-faint">
        <span className="flex items-center gap-1.5">
          <KeyboardShortcut keys={['⏎']} size="compact" />
          <span>Select</span>
        </span>
        {mentionState?.selectedIsDrillable && (
          <span className="flex items-center gap-1.5">
            <KeyboardShortcut keys={['Tab']} size="compact" />
            <span>Open</span>
          </span>
        )}
      </div>
    );

    const htmlModeButton = () => (
      <TooltipProvider delayDuration={300}>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={() => setMockupActive((value) => !value)}
              disabled={isSubmitting}
              className={`group/mockup flex h-7 shrink-0 items-center justify-center rounded-md transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ink-default/15 disabled:cursor-not-allowed disabled:opacity-60 ${
                mockupActive
                  ? 'relative gap-1 bg-border-subtle py-0 pl-2 pr-4 text-ink-muted'
                  : 'w-7 text-ink-faint hover:bg-surface-panel/50 hover:text-ink-muted'
              }`}
              aria-pressed={mockupActive}
              aria-label="HTML mode"
            >
              <PanelsTopLeft className="h-3.5 w-3.5" />
              {mockupActive && (
                <>
                  <span className="text-micro">HTML</span>
                  <X className="pointer-events-none absolute right-1 top-1/2 h-2 w-2 -translate-y-1/2 opacity-0 transition-opacity group-hover/mockup:opacity-50 group-focus-visible/mockup:opacity-50" />
                </>
              )}
            </button>
          </TooltipTrigger>
          <TooltipContent side="top" sideOffset={6}>Generate embedded HTML</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );

    const commentCountButton = (compact: boolean) => commentCount > 0 && (
      <TooltipProvider delayDuration={300}>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={handleAddressAllComments}
              aria-label={addressOpenCommentsLabel}
              className={`flex h-7 min-w-7 shrink-0 items-center justify-center gap-1 rounded-md ${compact ? 'px-1' : 'px-2'} text-ink-faint transition-colors hover:bg-surface-panel/50 hover:text-ink-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ink-default/15`}
            >
              <MessageSquareText className="h-3.5 w-3.5" />
              <span className="text-micro tabular-nums">{commentCount}</span>
            </button>
          </TooltipTrigger>
          <TooltipContent side="top" sideOffset={6}>{addressOpenCommentsLabel}</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );

    const submitButton = (
      <TooltipProvider delayDuration={300}>
        <Tooltip>
          <TooltipTrigger asChild>
            {/* Wrapper keeps hover events alive so the disabled Send can explain itself. */}
            <span className="inline-flex">
              <button
                type="button"
                onClick={handleComposerSubmit}
                disabled={sendDisabled}
                aria-label="Send Action"
                className="flex h-7 shrink-0 items-center gap-1.5 rounded-md bg-accent-brand px-2.5 text-micro text-ink-on-accent transition-colors hover:bg-accent-brand-pressed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-brand disabled:cursor-not-allowed disabled:opacity-60"
              >
                <span>Send</span>
                <span className="flex items-center gap-0.5" aria-hidden>
                  <span className="flex items-center justify-center rounded bg-surface-raised-card/40 p-0.5">
                    <Command className="h-2.5 w-2.5" />
                  </span>
                  <span className="flex items-center justify-center rounded bg-surface-raised-card/40 p-0.5">
                    <CornerDownLeft className="h-2.5 w-2.5" />
                  </span>
                </span>
              </button>
            </span>
          </TooltipTrigger>
          <TooltipContent side="top" sideOffset={6}>{sendDisabledReason ?? 'Send action'}</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );

    const claudeAttribution = (
      <TooltipProvider delayDuration={400}>
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              aria-label="Actions run with Claude Code"
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-ink-muted"
              data-command-palette-claude-attribution="true"
            >
              <ClaudeIcon className="h-3.5 w-3.5 text-accent-terracotta" />
            </span>
          </TooltipTrigger>
          <TooltipContent side="top" sideOffset={6}>Actions run with Claude Code</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );

    const selectedContextPill = selectedContext && onClearSelectedContext
      ? selectedContext.startsWith('[Mockup:')
        ? (
            <button
              key="selected-html-context"
              type="button"
              onClick={onClearSelectedContext}
              className="group/pill relative flex min-w-0 max-w-full items-center gap-1 overflow-hidden rounded-md bg-ink-default/5 py-0.5 pl-1.5 pr-4 text-micro text-ink-default transition-colors hover:bg-ink-default/10"
            >
              <PanelsTopLeft className="h-2.5 w-2.5 text-ink-muted" />
              <span>HTML</span>
              <X className="pointer-events-none absolute right-1 top-1/2 h-2 w-2 -translate-y-1/2 opacity-0 transition-opacity group-hover/pill:opacity-50 group-focus-visible/pill:opacity-50" />
            </button>
          )
        : (
            <ContextPill
              key="selected-text-context"
              text={selectedContext}
              iconUrl={selectedContextIconUrl}
              onRemove={onClearSelectedContext}
            />
          )
      : null;
    const contextPillButtons = [
      ...(selectedContextPill ? [selectedContextPill] : []),
      ...pills.map((pill) => (
        <button
          key={pill.id}
          type="button"
          onClick={() => dismissPill(pill.id)}
          title={pill.title}
          className="group/pill flex min-w-0 max-w-full items-center gap-1 overflow-hidden rounded-md bg-ink-default/5 px-1.5 py-0.5 text-micro text-ink-default transition-colors hover:bg-ink-default/10"
        >
          {pill.type === 'note' ? (
            <FileText className="h-2.5 w-2.5 shrink-0 text-file-link-primary" />
          ) : (
            <Folder className="h-2.5 w-2.5 shrink-0 fill-file-link-primary/20 text-file-link-primary" strokeWidth={1.5} />
          )}
          <span className="min-w-0 truncate">{pill.title}</span>
          <X className="h-3 w-3 shrink-0 text-ink-muted transition-colors group-hover/pill:text-ink-default" />
        </button>
      ))
    ];

    const commentContextBlock = visibleCommentContext ? (
      <div
        className="relative max-h-48 w-full overflow-y-auto rounded-md border border-border-subtle bg-surface-raised-card py-2 pl-3 pr-9"
        data-prompt-comment-context
      >
        <TooltipProvider delayDuration={300}>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={() => setContextTrayExpanded(false)}
                className={`${PALETTE_HEADER_BUTTON_CLASS} absolute -top-px right-1.5`}
                aria-label="Show less context"
                data-command-palette-context-collapse="true"
              >
                <ChevronUp className="h-3.5 w-3.5" aria-hidden />
              </button>
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={6}>Show less context</TooltipContent>
          </Tooltip>
        </TooltipProvider>
        <div className="space-y-2">
          {visibleCommentContext.threads.map((thread) => (
            <div key={thread.rootId} className="space-y-1.5">
              {thread.messages.map((message) => (
                <blockquote
                  key={message.id}
                  className="border-l border-border-subtle/70 pl-2 text-caption leading-relaxed text-ink-muted"
                >
                  <div className={`mb-0.5 text-micro font-medium ${getCommentAttributionTextClassForColor(message.color, message.source)}`}>
                    {message.authorLabel}
                  </div>
                  <div className="whitespace-pre-wrap break-words">
                    <CommentTextContent text={message.text} />
                  </div>
                </blockquote>
              ))}
            </div>
          ))}
        </div>
      </div>
    ) : null;

    const commentContextLabel = visibleCommentContext
      ? visibleCommentContext.scope === 'all'
        ? visibleCommentContext.title
        : visibleCommentContext.scope === 'thread'
          ? 'Comment thread'
          : 'Comment'
      : null;
    const commentContextSummary = visibleCommentContext && commentContextLabel ? (
      <div
        key="comment-context-summary"
        className="group/pill flex min-w-0 max-w-full items-center overflow-hidden rounded-md bg-ink-default/5 text-micro text-ink-default transition-colors hover:bg-ink-default/10"
        data-prompt-comment-context-summary
      >
        <button
          type="button"
          onClick={() => setContextTrayExpanded(true)}
          className="flex min-w-0 items-center gap-1 py-0.5 pl-1.5"
          aria-label={`Show ${commentContextLabel.toLowerCase()} context`}
        >
          <MessageSquareText className="h-2.5 w-2.5 shrink-0 text-ink-muted" />
          <span className="min-w-0 truncate">{commentContextLabel}</span>
        </button>
        <button
          type="button"
          onClick={handleRemoveCommentContext}
          className="flex h-5 w-5 shrink-0 items-center justify-center text-ink-muted transition-colors hover:text-ink-default focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ink-default/15"
          aria-label="Remove comment context"
        >
          <X className="h-3 w-3" />
        </button>
      </div>
    ) : null;

    const hasPromptContextItems = contextPillButtons.length > 0;
    const displaySrcs = imageUrls.map((url) => toDisplaySrc(url, focusedNoteId));
    const renderComposerContext = (location: 'docked' | 'floating') => {
      if (!visibleCommentContext && !hasPromptContextItems) return null;
      const maxCollapsedItems = MAX_COLLAPSED_CONTEXT_ITEMS[location];
      const collapsedContextItems = [
        ...(commentContextSummary ? [commentContextSummary] : []),
        ...contextPillButtons
      ];
      const visibleCollapsedContextItems = collapsedContextItems.slice(0, maxCollapsedItems);
      const hiddenContextCount = Math.max(
        0,
        collapsedContextItems.length - visibleCollapsedContextItems.length
      );

      return (
        <div
          className={`flex min-w-0 flex-1 flex-col gap-2 ${
            contextTrayExpanded && visibleCommentContext ? '-mr-2' : ''
          }`}
          data-command-palette-context="true"
        >
          {contextTrayExpanded ? commentContextBlock : null}
          {collapsedContextItems.length > 0 ? (
            <div
              className={`flex min-w-0 items-center gap-1 ${
                contextTrayExpanded
                  ? 'flex-wrap'
                  : 'flex-nowrap overflow-hidden'
              }`}
              data-command-palette-pills="true"
            >
              {contextTrayExpanded ? contextPillButtons : visibleCollapsedContextItems}
              {!contextTrayExpanded && hiddenContextCount > 0 ? (
                <button
                  type="button"
                  onClick={() => setContextTrayExpanded(true)}
                  className="flex shrink-0 items-center rounded-md bg-ink-default/5 px-1.5 py-0.5 text-micro text-ink-muted transition-colors hover:bg-ink-default/10 hover:text-ink-default"
                  aria-label={`Show ${hiddenContextCount} more context ${hiddenContextCount === 1 ? 'item' : 'items'}`}
                  data-command-palette-context-expand="true"
                >
                  +{hiddenContextCount}
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      );
    };

    const renderComposer = (
      location: 'docked' | 'floating',
      contextIsEmpty: boolean
    ) => {
      const compact = location === 'docked';
      return (
        <div
          className={`${PALETTE_FRAME_RADIUS_CLASS} overflow-hidden rounded-t-none ${
            contextIsEmpty ? 'bg-surface-raised-control' : 'bg-surface-panel/50'
          }`}
          onKeyDownCapture={event => { if (!promptDraft.trim()) undoFromEmptyPrompt(event); }}
          data-command-palette-composer={location}
          data-command-palette-docked-composer={compact ? 'true' : undefined}
        >
          <MentionInput
            namespace={`moss-${location}-prompt`}
            value={promptDraft}
            onChange={setPromptDraft}
            onSubmit={handleComposerSubmit}
            placeholder="Ask Moss to help..."
            autoFocus={!compact}
            resetSignal={composerResetSignal}
            contentEditableClassName={`min-h-14 max-h-40 w-full resize-none overflow-y-auto py-2 leading-relaxed text-ink-default outline-none ${compact ? 'text-caption' : 'text-small'}`}
            showOverflowFade
            placeholderClassName={`pointer-events-none absolute left-0 top-2 select-none leading-relaxed text-ink-faint ${compact ? 'text-caption' : 'text-small'}`}
            paragraphClassName={`mb-0 ${compact ? 'text-caption' : 'text-small'}`}
            serialize={serializeDockedDraft}
            deserialize={deserializeDockedDraft}
            simpleMarkdown
            editorRef={composerEditorRef}
            mentionRequireWordBoundary={false}
            onMentionStateChange={setMentionState}
            imageAttachments={{
              imageUrls,
              onAttach: handleImageAttach,
              onRemove: handleImageRemove,
              onOpen: handleImageOpen,
              displaySrcs
            }}
            actionsPlacement="footer"
            footerClassName="border-t-0 bg-surface-raised-control"
            footerControlsClassName={compact ? 'items-end flex-wrap gap-y-1 px-1.5 py-1.5' : 'items-end px-1.5 py-1.5'}
            footerActionButtonClassName="h-7 w-7 text-ink-faint"
            inputSurfaceClassName={`${PALETTE_FRAME_RADIUS_CLASS} rounded-b-none bg-surface-raised-control px-4 pt-2`}
            footerLeadingActions={
              <div className="flex shrink-0 items-center gap-1">
                {htmlModeButton()}
                {commentCountButton(compact)}
              </div>
            }
            submitButton={
              <div className="flex items-center gap-1">
                {claudeAttribution}
                {submitButton}
              </div>
            }
          />
        </div>
      );
    };

    const renderPaletteFrame = (location: 'docked' | 'floating') => {
      const compact = location === 'docked';
      const composerContext = renderComposerContext(location);
      const contextIsEmpty = composerContext === null;
      const contextCanCollapse = Boolean(visibleCommentContext)
        || contextPillButtons.length > MAX_COLLAPSED_CONTEXT_ITEMS[location];
      return (
        <div
          className={`overflow-hidden ${PALETTE_FRAME_RADIUS_CLASS} ${
            compact
              ? 'border border-surface-glass-border bg-surface-glass p-0.5'
              : 'bg-surface-raised-control'
          }`}
          data-command-palette-frame={location}
        >
          <div
            className={`${PALETTE_FRAME_RADIUS_CLASS} flex gap-2 rounded-b-none px-1.5 ${
              contextIsEmpty
                ? 'min-h-9 bg-surface-raised-control py-1.5'
                : 'min-h-9 bg-surface-panel/50 py-1.5'
            } ${
              contextTrayExpanded ? 'items-start' : 'items-center'
            }`}
            data-command-palette-docked-header={compact ? 'true' : undefined}
            data-command-palette-context-tray="true"
            data-command-palette-context-empty={contextIsEmpty ? 'true' : undefined}
          >
            {paletteGripControl}
            {composerContext ?? <div className="min-w-0 flex-1" />}
            {contextTrayExpanded && !visibleCommentContext && contextCanCollapse ? (
              <TooltipProvider delayDuration={300}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      onClick={() => setContextTrayExpanded(false)}
                      className={PALETTE_HEADER_BUTTON_CLASS}
                      aria-label="Show less context"
                      data-command-palette-context-collapse="true"
                    >
                      <ChevronUp className="h-3.5 w-3.5" aria-hidden />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="top" sideOffset={6}>Show less context</TooltipContent>
                </Tooltip>
              </TooltipProvider>
            ) : null}
            {compact ? dockedFloatControl : floatingDockControl}
          </div>
          {renderComposer(location, contextIsEmpty)}
        </div>
      );
    };

    const dockedPalette = (
      <>
        <section
          ref={dockedSectionRef}
          aria-label="Command palette"
          data-command-palette-docked="true"
          data-command-palette-drop-preview={isDockPreviewing ? 'true' : undefined}
          className="flex w-full flex-col gap-1.5"
          onKeyDown={handleDockedKeyDown}
        >
          <div className="flex flex-col gap-1.5">
            {renderPaletteFrame('docked')}
            {mentionState?.isOpen ? mentionHints : null}
          </div>
        </section>
        <div
          className="mt-panel-section-gap flex shrink-0 items-center border-t border-border-subtle/40 px-0 pb-panel-section-gap pt-panel-section-gap"
          data-command-palette-timeline-header="true"
        >
          <span className="text-micro font-medium uppercase tracking-wider text-ink-faint">Recent Actions</span>
        </div>
      </>
    );

    if (isDocked || isDockPreviewing) {
      // The docked palette is a persistent Actions-panel fixture — no dialog
      // semantics, no dismissal. It renders whenever the panel provides a
      // host and only an explicit undock turns it back into the overlay.
      return (
        dockHost ? createPortal(dockedPalette, dockHost) : null
      );
    }

    // The lightbox is a modal browser surface covering most of the canvas, with
    // no gap the floating palette could occupy. Yield to it rather than overlap
    // it; closing the lightbox brings the palette back in place.
    if (webEmbedLightboxOpen) {
      return null;
    }

    return (
      <Dialog.Root open={open} onOpenChange={handleClose}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-dialog-overlay data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
          {dockDropIndicatorStyle ? (
            <div
              aria-hidden
              className="pointer-events-none fixed z-dialog-content rounded-r-xl border border-accent-brand/30 bg-accent-brand/5"
              data-command-palette-drop-indicator="true"
              style={dockDropIndicatorStyle}
            />
          ) : null}
          <Dialog.Content
            ref={contentRef}
            className="fixed left-1/2 top-1/5 z-dialog-content -translate-x-1/2 rounded-xl border border-surface-glass-border bg-surface-notes-list shadow-none data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95"
            style={paletteSurfaceStyle}
            onOpenAutoFocus={(e) => {
              e.preventDefault();
              focusPaletteTarget();
            }}
          >
            <Dialog.Title className="sr-only">Command palette</Dialog.Title>
            <Dialog.Description className="sr-only">Type a prompt to send to the AI assistant</Dialog.Description>

            <div className="flex flex-col gap-2.5 p-2">
              {renderPaletteFrame('floating')}
              {mentionState?.isOpen ? mentionHints : null}
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    );
  }
);

export default CommandPaletteOverlay;
