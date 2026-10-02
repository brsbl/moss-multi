// ported-from: packages/shared/src/components/ui/action-timeline-card.tsx @ 762abb777
import { useState, useEffect, useMemo, useRef, useCallback, type ReactNode } from 'react';
import {
  AlignCenter,
  AlignJustify,
  AlignLeft,
  AlignRight,
  Check,
  CheckCircle2,
  ChevronRight,
  ChevronUp,
  ChevronDown,
  CircleAlert,
  Copy,
  ExternalLink,
  FileText,
  Info,
  Folder,
  Image as ImageIcon,
  MessageSquareText,
  PanelsTopLeft,
  ListFilter,
  ListMinus,
  ListOrdered,
  ListPlus,
  ListTodo,
  ListTree,
  Logs,
  RotateCcw,
  Square,
  TextQuote
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Collapsible } from '@/components/primitives';
import { cn } from '@/lib/utils';
import { renderInlineMarkdown } from '../../lib/markdown-inline';
import {
  CLAUDE_CODE_AUTH_COMMAND,
  CLAUDE_CODE_AUTH_REQUIRED_MESSAGE,
  CLAUDE_CODE_INSTALL_COMMAND,
  CLAUDE_CODE_NOT_INSTALLED_MESSAGE
} from '../../lib/claude-code';
import type { ActionPromptMention, ActionTabEntry } from '../../state/atoms';
import type { ActionTabSdkMetrics } from '../../types/action-tab-metrics';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './tooltip';

function formatTokenCount(sdk?: ActionTabSdkMetrics): string | null {
  if (!sdk) return null;
  const { inputTokens, outputTokens } = sdk;
  if (typeof inputTokens !== 'number' || !Number.isFinite(inputTokens)) return null;
  if (typeof outputTokens !== 'number' || !Number.isFinite(outputTokens)) return null;
  const total = inputTokens + outputTokens;
  if (!(total > 0)) return null;
  return `${total.toLocaleString('en-US')} tokens`;
}

export interface ActionTimelineCardProps {
  action: ActionTabEntry;
  isExpanded: boolean;
  onToggle: () => void;
  className?: string;
  isLast?: boolean;
  isComplete?: boolean;
  /** Called when the user clicks Stop during streaming */
  onCancel?: () => void;
  /** Called when the user clicks the copy button on a prompt */
  onCopyPrompt?: (prompt: string) => void;
  /** Called to open uploaded prompt images in a lightbox carousel */
  onOpenImages?: (sources: string[], startIndex: number) => void;
  /**
   * Called when the user clicks "Retry" on a retryable error/neutral
   * outcome. Should re-run the action's original prompt for this tab.
   */
  onRetry?: (action: ActionTabEntry) => void;
  /**
   * Disables the Retry button (without hiding it) while the note already has
   * an active run, since the App's busy guard would silently drop the retry.
   */
  retryDisabled?: boolean;
}

function formatTimestamp(isoString: string | null): string {
  if (!isoString) return '';
  const parsed = Date.parse(isoString);
  if (Number.isNaN(parsed)) return '';

  const date = new Date(parsed);
  const now = new Date();
  const monthName = date.toLocaleString('en-US', { month: 'short' });
  const day = date.getDate();
  const ordinalSuffix = (n: number): string => {
    const s = ['th', 'st', 'nd', 'rd'];
    const v = n % 100;
    return s[(v - 20) % 10] || s[v] || s[0];
  };
  const dayWithSuffix = `${day}${ordinalSuffix(day)}`;
  const dateStr = date.getFullYear() === now.getFullYear()
    ? `${monthName} ${dayWithSuffix}`
    : `${monthName} ${dayWithSuffix}, ${date.getFullYear()}`;
  const timeStr = date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
  return `${dateStr} · ${timeStr}`;
}

const STATUS_ACTIVITY_ICONS: LucideIcon[] = [
  AlignLeft,
  AlignCenter,
  AlignRight,
  AlignJustify,
  TextQuote,
  ListMinus,
  ListFilter,
  Logs,
  ListOrdered,
  ListPlus,
  ListTree,
  ListTodo
];

const ICON_CYCLE_MS = 600;

/**
 * External support URL opened by the default secondary link on error cards.
 * Follows the same external-link convention the card previously used for the
 * troubleshooting guide (anchor with target="_blank" rel="noopener noreferrer").
 */
const SUPPORT_URL = 'https://mossnotes.app/support';

// ---------------------------------------------------------------------------
// Error / outcome action model
// ---------------------------------------------------------------------------

/**
 * Data-driven action descriptor for the outcome card (error or neutral).
 *
 * The card renders whatever actions this descriptor carries rather than
 * hardcoding them, so a later fix (Fix 3) can assign different actions per
 * classified error simply by building a different descriptor — the card's
 * rendering does not need to change.
 *
 *   - `primary`        → a button (e.g. "Retry"), optionally icon-led
 *   - `secondaryLink`  → an optional contextual external recovery link
 *   - `inlineCommands` → one or more ordered Terminal recovery commands
 *
 * `primary.icon` lets a descriptor carry its own leading icon (Fix 3 may map a
 * different icon per classified error); when omitted the card falls back to the
 * default refresh icon for the retry affordance.
 */
export interface ActionCardActionDescriptor {
  primary?: { label: string; onClick: () => void; icon?: LucideIcon; disabled?: boolean };
  secondaryLink?: { label: string; href: string };
  inlineCommands?: Array<{
    label: string;
    command: string;
    copyLabel: string;
    copiedLabel: string;
  }>;
}

/**
 * Visual tone for the outcome card.
 * - 'error'   → red error card (alert icon, error tokens)
 * - 'neutral' → muted/informational or setup card (no red styling or alert icon)
 */
export type ActionCardTone = 'error' | 'neutral';

/**
 * Builds the outcome descriptor + tone for an errored/neutral action from its
 * stored `streamError` (which carries the main-process `retryable` and
 * `severity` flags). Centralizing this keeps the card's JSX dumb and gives
 * Fix 3 a single place to branch per classified error.
 */
function getOutcomeActions(
  action: ActionTabEntry,
  onRetry?: (action: ActionTabEntry) => void,
  retryDisabled?: boolean
): { tone: ActionCardTone; descriptor: ActionCardActionDescriptor; message?: string } {
  const isMissingInstallation = action.streamError?.classification === 'runtime_not_found';
  const isAuthenticationSetup =
    action.streamError?.classification === 'auth_required' ||
    action.streamError?.classification === 'auth_invalid';
  const tone: ActionCardTone = isMissingInstallation || isAuthenticationSetup
    ? 'neutral'
    : action.streamError?.severity ?? 'error';
  const retryable = action.streamError?.retryable ?? false;
  const canRetry = retryable && !!onRetry && !!action.prompt && action.retryInputs !== undefined;

  const descriptor: ActionCardActionDescriptor = {};
  if (canRetry) {
    // Disabled (not hidden) while the note already has an active run — the
    // busy guard in executeAgentForNote would otherwise silently no-op.
    // retryInputs is an in-memory replay marker; without it, a reloaded tab
    // cannot prove it can reproduce the original request faithfully.
    descriptor.primary = {
      label: 'Retry',
      onClick: () => onRetry?.(action),
      icon: RotateCcw,
      disabled: retryDisabled
    };
  }
  // Missing Claude Code is a recoverable setup state, so it gets a neutral
  // card with the install command inline. Other neutral outcomes have no link;
  // red errors retain the support affordance.
  if (isMissingInstallation) {
    descriptor.inlineCommands = [
      {
        label: 'Run this in your Terminal app:',
        command: CLAUDE_CODE_INSTALL_COMMAND,
        copyLabel: 'Copy Claude Code install command',
        copiedLabel: 'Claude Code install command copied'
      },
      {
        label: 'After it installs, run:',
        command: CLAUDE_CODE_AUTH_COMMAND,
        copyLabel: 'Copy Claude Code sign-in command',
        copiedLabel: 'Claude Code sign-in command copied'
      }
    ];
  } else if (isAuthenticationSetup) {
    descriptor.inlineCommands = [
      {
        label: 'Run this in your Terminal app:',
        command: CLAUDE_CODE_AUTH_COMMAND,
        copyLabel: 'Copy Claude Code sign-in command',
        copiedLabel: 'Claude Code sign-in command copied'
      }
    ];
  } else if (tone === 'error') {
    descriptor.secondaryLink = { label: 'Contact support', href: SUPPORT_URL };
  }
  return {
    tone,
    descriptor,
    ...(isMissingInstallation ? { message: CLAUDE_CODE_NOT_INSTALLED_MESSAGE } : {}),
    ...(isAuthenticationSetup ? { message: CLAUDE_CODE_AUTH_REQUIRED_MESSAGE } : {})
  };
}

const isSnapshotModeActive = (): boolean =>
  typeof document !== 'undefined' &&
  document.documentElement.getAttribute('data-moss-snapshot') === 'true';

/** Flat string list per tool — callCount indexes in. */
const TOOL_STATUS_TEXT: Record<string, string[]> = {
  Edit: ['Updating your note...', 'Reworking structure...', 'Refining wording...', 'Applying edits...'],
  Read: ['Reviewing your notes...', 'Scanning context...', 'Checking details...', 'Cross-referencing...'],
  WebFetch: ['Gathering sources...', 'Reading pages...', 'Pulling key details...'],
  WebSearch: ['Searching for sources...', 'Comparing results...', 'Checking relevance...'],
  Bash: ['Tinkering behind the scenes...', 'Crunching some numbers...', 'Piecing it all together...'],
  TodoWrite: ['Planning the work...', 'Breaking tasks down...', 'Updating the checklist...'],
  Agent: ['Calling in backup...', 'Coordinating the team...', 'Gathering intel...', 'Pulling threads together...']
};

const UNKNOWN_TOOL_TEXT = [
  'Doing a bit of magic...',
  'Working behind the curtain...',
  'Figuring it out...',
  'Hang tight...',
  'Almost there...'
];

const THINKING_TEXT = ['Thinking through this...', 'Planning the approach...', 'Working out the details...'];
const POST_TOOL_TEXT = ['Finishing up...', 'Putting everything together...', 'Preparing the final update...'];

/** Simple hash to pick a deterministic index from a string. */
const hashPick = (id: string, arr: string[]): string => {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = ((h << 5) - h + id.charCodeAt(i)) | 0;
  return arr[((h % arr.length) + arr.length) % arr.length];
};

function getStatusText(action: ActionTabEntry): { key: string; text: string } {
  const activeTool = action.activeTools[0];
  if (activeTool) {
    const callCount = action.toolCallCounts[activeTool.toolName] ?? 1;
    const strings = TOOL_STATUS_TEXT[activeTool.toolName];
    const text = strings
      ? strings[(callCount - 1) % strings.length]
      : UNKNOWN_TOOL_TEXT[(callCount - 1) % UNKNOWN_TOOL_TEXT.length];
    return { key: activeTool.toolId, text };
  }
  // Between tool_end and next tool_start, keep showing the last tool's text
  // to avoid a brief flash of "Wrapping up..." between consecutive tool calls.
  // Only fall through to post-tool text when text is actually being streamed.
  if (action.lastToolName && !action.streamingText?.trim()) {
    const callCount = action.toolCallCounts[action.lastToolName] ?? 1;
    const strings = TOOL_STATUS_TEXT[action.lastToolName];
    const text = strings
      ? strings[(callCount - 1) % strings.length]
      : UNKNOWN_TOOL_TEXT[(callCount - 1) % UNKNOWN_TOOL_TEXT.length];
    return { key: `last-${action.lastToolName}`, text };
  }
  const hasResponded = (action.messages?.length ?? 0) > 0 || !!action.streamingText?.trim();
  if (action.lastToolName || hasResponded) {
    return { key: 'post-tool', text: hashPick(action.id, POST_TOOL_TEXT) };
  }
  return { key: 'thinking', text: hashPick(action.id, THINKING_TEXT) };
}

/**
 * Parses a prompt to extract selected text context and strip agent-only prefixes.
 * Format: [HTML mode — ...]\n\n[Selected text: "...content..."]\n\n<actual message>
 * Browser format: [Browser context:\nURL: ...\nSelected text: "...content..."]\n\n<actual message>
 * Page-only browser format: [Browser context:\nURL: ...]\n\n<actual message>
 */
function parsePromptContext(prompt: string): { context: string | null; message: string } {
  let remaining = prompt;

  // Strip HTML/mockup prefix (injected for agent, not for display)
  const modeMatch = remaining.match(/^\[(?:HTML|Mockup) mode[^\]]*\]\n\n([\s\S]*)$/);
  if (modeMatch) {
    remaining = modeMatch[1];
  }

  const browserContextMatch = remaining.match(
    /^\[Browser context:\nURL: ([^\n]+)\nSelected text: "([\s\S]*?)"\n?\]\n\n([\s\S]*)$/
  );
  if (browserContextMatch) {
    const url = browserContextMatch[1];
    const selected = browserContextMatch[2];
    return { context: selected || url, message: browserContextMatch[3] };
  }

  const browserPageContextMatch = remaining.match(
    /^\[Browser context:\nURL: ([^\n]+)\]\n\n([\s\S]*)$/
  );
  if (browserPageContextMatch) {
    return { context: browserPageContextMatch[1], message: browserPageContextMatch[2] };
  }

  // Strip selected text context
  const contextMatch = remaining.match(/^\[Selected text: "([\s\S]*?)"\]\n\n([\s\S]*)$/);
  if (contextMatch) {
    return { context: contextMatch[1], message: contextMatch[2] };
  }

  return { context: null, message: remaining };
}

/**
 * Read-only context pill for displaying selected text in submitted messages.
 * Truncates to maxLength and shows full text in tooltip.
 */
function ContextPillReadOnly({
  text,
  iconUrl = null,
  maxLength = 50
}: {
  text: string;
  iconUrl?: string | null;
  maxLength?: number;
}) {
  const needsTruncation = text.length > maxLength;
  const displayText = needsTruncation ? `${text.slice(0, maxLength)}...` : text;

  const pillContent = (
    <span className="inline-flex min-w-0 max-w-full items-center gap-1 overflow-hidden rounded-md bg-ink-default/5 px-1.5 py-0.5 text-micro text-ink-default">
      {iconUrl ? (
        <img
          src={iconUrl}
          alt=""
          className="h-2.5 w-2.5 shrink-0 rounded-sm"
          onError={(event) => {
            event.currentTarget.style.display = 'none';
          }}
        />
      ) : null}
      <span className="truncate">{displayText}</span>
    </span>
  );

  if (needsTruncation) {
    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>{pillContent}</TooltipTrigger>
          <TooltipContent side="top" className="max-w-xs">
            <p className="whitespace-pre-wrap break-words text-xs">{text}</p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }
  return pillContent;
}

function PromptMentionPillReadOnly({ mention }: { mention: ActionPromptMention }) {
  const isFolderMention = mention.type === 'directory' || mention.type === 'folder';
  const Icon = isFolderMention ? Folder : FileText;

  return (
    <span className="inline-flex min-w-0 max-w-full items-center gap-1 overflow-hidden rounded-md bg-ink-default/5 px-1.5 py-0.5 text-micro text-ink-default align-baseline">
      <Icon className={cn(
        'h-2.5 w-2.5 shrink-0 text-file-link-primary',
        isFolderMention && 'fill-file-link-primary/20'
      )} />
      <span className="truncate">{mention.title}</span>
    </span>
  );
}

function renderPromptWithMentionPills(
  text: string,
  mentions?: ActionPromptMention[]
): ReactNode {
  const resolvedMentions = mentions ?? [];
  if (resolvedMentions.length === 0) return text;

  const fragments: ReactNode[] = [];
  let cursor = 0;
  let renderedMentions = 0;
  const haystack = text.toLowerCase();

  resolvedMentions.forEach((mention, index) => {
    const mentionTitle = mention.title.trim();
    if (mentionTitle.length === 0) return;

    const mentionToken = `@${mentionTitle}`.toLowerCase();
    const mentionIndex = haystack.indexOf(mentionToken, cursor);
    if (mentionIndex < 0) return;

    if (mentionIndex > cursor) {
      fragments.push(text.slice(cursor, mentionIndex));
    }

    fragments.push(
      <PromptMentionPillReadOnly
        key={`mention-${index}-${mentionIndex}`}
        mention={mention}
      />
    );
    renderedMentions += 1;
    cursor = mentionIndex + mentionToken.length;
  });

  if (cursor < text.length) {
    fragments.push(text.slice(cursor));
  }

  return renderedMentions > 0 ? fragments : text;
}

const COMMENT_MENTION_START = '\u2063';
const COMMENT_MENTION_END = '\u2064';
const COMMENT_MENTION_ID_SEPARATOR = '\u2062';

type CommentMentionSegment =
  | { type: 'text'; value: string }
  | { type: 'mention'; value: string; mentionType: 'folder' | 'note' };

function stripCommentMentionMarkers(text: string): string {
  return text
    .replace(/\u2063([^\u2064]*?)(?:\u2062[^\u2064]*)?\u2064/g, '$1')
    .split(COMMENT_MENTION_START).join('')
    .split(COMMENT_MENTION_END).join('');
}

function splitCommentMentionSegments(text: string): CommentMentionSegment[] {
  if (!text.includes(COMMENT_MENTION_START)) {
    return [{ type: 'text', value: text }];
  }

  const segments: CommentMentionSegment[] = [];
  let cursor = 0;

  while (cursor < text.length) {
    const mentionStart = text.indexOf(COMMENT_MENTION_START, cursor);
    if (mentionStart < 0) {
      const tail = text.slice(cursor);
      if (tail) {
        segments.push({ type: 'text', value: tail });
      }
      break;
    }

    if (mentionStart > cursor) {
      segments.push({ type: 'text', value: text.slice(cursor, mentionStart) });
    }

    const mentionEnd = text.indexOf(COMMENT_MENTION_END, mentionStart + COMMENT_MENTION_START.length);
    if (mentionEnd < 0) {
      segments.push({ type: 'text', value: text.slice(mentionStart) });
      break;
    }

    const rawMentionContent = text
      .slice(mentionStart + COMMENT_MENTION_START.length, mentionEnd)
      .trim();
    const idSeparatorIndex = rawMentionContent.indexOf(COMMENT_MENTION_ID_SEPARATOR);
    const mentionContent =
      idSeparatorIndex >= 0 ? rawMentionContent.slice(0, idSeparatorIndex) : rawMentionContent;
    if (mentionContent) {
      const isFolder = mentionContent.startsWith('@folder:');
      const value = isFolder ? mentionContent.replace('@folder:', '@') : mentionContent;
      segments.push({ type: 'mention', value, mentionType: isFolder ? 'folder' : 'note' });
    }

    cursor = mentionEnd + COMMENT_MENTION_END.length;
  }

  return segments.length > 0 ? segments : [{ type: 'text', value: '' }];
}

function CommentQuoteText({ text }: { text: string }) {
  return (
    <>
      {splitCommentMentionSegments(text).map((segment, index) => {
        if (segment.type === 'mention') {
          const mentionText = segment.value.startsWith('@') ? segment.value.slice(1) : segment.value;
          const Icon = segment.mentionType === 'folder' ? Folder : FileText;

          return (
            <span
              key={`mention-${index}`}
              className="inline-flex min-w-0 max-w-full items-center gap-1 overflow-hidden whitespace-nowrap rounded-md bg-ink-default/5 px-1 py-px text-xs text-ink-default align-baseline transition-colors"
            >
              <Icon className={cn(
                'h-2.5 w-2.5 shrink-0 text-file-link-primary',
                segment.mentionType === 'folder' && 'fill-file-link-primary/20'
              )} />
              <span className="min-w-0 overflow-hidden text-ellipsis">{mentionText}</span>
            </span>
          );
        }

        return <span key={`text-${index}`}>{stripCommentMentionMarkers(segment.value)}</span>;
      })}
    </>
  );
}

function getCommentAttributionTextClassForColor(
  color?: number,
  source?: NonNullable<ActionTabEntry['commentContext']>['threads'][number]['messages'][number]['source']
): string {
  if (color === 3) return 'text-comment-author-agent';
  if (color === 4) return 'text-comment-author-external';
  if (color === 0 || color === 1 || color === 2) return 'text-comment-author-user';
  if (source === 'agent') return 'text-comment-author-agent';
  if (source === 'external') return 'text-comment-author-external';
  return 'text-comment-author-user';
}

function CommentContextReadOnly({ context }: { context: NonNullable<ActionTabEntry['commentContext']> }) {
  return (
    <div className="relative max-h-48 min-w-full overflow-y-auto">
      <div className="space-y-2">
        {context.threads.map((thread) => (
          <div key={thread.rootId} className="space-y-1.5">
            {thread.messages.map((message) => (
              <blockquote
                key={message.id}
                className="border-l border-border-subtle/70 pl-2 text-caption leading-relaxed text-ink-muted"
              >
                <div className={cn('mb-0.5 text-micro font-medium', getCommentAttributionTextClassForColor(message.color, message.source))}>
                  {message.authorLabel}
                </div>
                <div className="whitespace-pre-wrap break-words">
                  <CommentQuoteText text={message.text} />
                </div>
              </blockquote>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

function stripAgentCommentContextFromPrompt(text: string): string {
  return text.replace(
    /^Comment (?:root IDs|thread IDs|ID) to address and resolve:\n[\s\S]*?\n\n/,
    ''
  );
}

// ---------------------------------------------------------------------------
// Extracted Components
// ---------------------------------------------------------------------------

interface TimelineStep {
  id: string;
  dotClass: string;
  dotPulse?: boolean;
  content: ReactNode;
}

function TimelineDot({ className, pulse }: { className: string; pulse?: boolean }) {
  return (
    <div
      className="relative z-10 flex h-1.5 w-2 shrink-0 justify-center"
      data-action-timeline-dot="true"
    >
      <div className={cn('h-1.5 w-1.5 shrink-0 rounded-full aspect-square', className, pulse && 'animate-pulse')} />
    </div>
  );
}

function TimelineSequence({ steps }: { steps: TimelineStep[] }) {
  const terminalStep = steps.at(-1);

  if (!terminalStep) {
    return null;
  }

  if (steps.length === 1) {
    return (
      <div className="flex gap-3">
        <TimelineDot className={terminalStep.dotClass} pulse={terminalStep.dotPulse} />
        <div className="min-w-0 flex-1">{terminalStep.content}</div>
      </div>
    );
  }

  return (
    <div data-action-timeline-sequence="true">
      <div className="relative">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute bottom-0.5 left-1 top-0.5 w-px bg-border-subtle"
          data-action-timeline-rail="true"
        />
        {steps.slice(0, -1).map((step) => (
          <div key={step.id} className="relative flex gap-3 pb-3">
            <TimelineDot className={step.dotClass} pulse={step.dotPulse} />
            <div className="min-w-0 flex-1">{step.content}</div>
          </div>
        ))}
        <TimelineDot className={terminalStep.dotClass} pulse={terminalStep.dotPulse} />
      </div>
      <div className="-mt-1.5 ml-5 min-w-0">{terminalStep.content}</div>
    </div>
  );
}

function TimelineSupplement({ children }: { children: ReactNode }) {
  return <div className="ml-5 min-w-0">{children}</div>;
}

interface MessageBubbleProps {
  children: ReactNode;
  variant?: 'user' | 'agent' | 'error' | 'status' | 'muted';
}

function MessageBubble({ children, variant = 'agent' }: MessageBubbleProps) {
  const variantClasses = {
    user: 'border-border-subtle bg-surface-raised-card',
    agent: 'border-border-subtle bg-surface-canvas',
    error: 'border-status-error-border bg-status-error-surface',
    status: 'border-action-tab-pending-honey/30 bg-action-tab-pending-honey/5',
    muted: 'border-border-subtle/50 bg-surface-panel/50'
  };

  return (
    <div className={cn('overflow-hidden rounded-md border px-3 py-2', variantClasses[variant])}>
      <div className="max-w-full overflow-hidden">
        {children}
      </div>
    </div>
  );
}

/**
 * Get user-friendly message for interrupt reason.
 */
function getInterruptReasonMessage(reason?: string): string {
  switch (reason) {
    case 'trashed':
      return 'This note moved to Trash.';
    case 'user-cancelled':
      return 'Stopped by you.';
    case 'app-reload':
      return 'The app reloaded.';
    default:
      return 'Stopped before completion.';
  }
}

// ---------------------------------------------------------------------------
// Display message helper
// ---------------------------------------------------------------------------

interface DisplayMessage {
  text: string;
  isLive: boolean;
}

const COMPLETION_SUCCESS_MESSAGE = 'Note updated';

const TOOL_USE_ERROR_BLOCK_REGEX = /<tool_use_error>([\s\S]*?)<\/tool_use_error>/gi;
const TOOL_USE_ERROR_TAG_REGEX = /<\/?tool_use_error>/gi;

// Transient/internal tool errors that should not be displayed in timeline bubbles.
const TRANSIENT_ERROR_SUBSTRINGS = [
  'file has not been read yet',
  'read it first before writing',
  'file has been modified since read',
  'tool is not available',
  'tool not available',
  'exceeds maximum allowed tokens',
  'sibling tool call errored',
  'tool call errored',
  'request failed with status code',
  'agent stopped by user'
];

function normalizeLineForMatch(line: string): string {
  return line
    .trim()
    .replace(/^[\-*+\d.)\s]+/, '')
    .replace(/[.:]+$/, '')
    .toLowerCase();
}

function isTransientErrorLine(line: string): boolean {
  const normalized = normalizeLineForMatch(line);
  if (!normalized) {
    return false;
  }

  // Keep longer explanatory text and only suppress concise error fragments.
  if (normalized.length > 140) {
    return false;
  }

  return TRANSIENT_ERROR_SUBSTRINGS.some((pattern) => normalized.includes(pattern));
}

// Parse message, filtering transient/internal tool errors while preserving useful text.
function parseMessage(text: string): string | null {
  const trimmed = text.replace(/\r\n/g, '\n').trim();
  if (!trimmed) {
    return null;
  }

  const withoutErrorBlocks = trimmed
    .replace(TOOL_USE_ERROR_BLOCK_REGEX, (_match, errorContent: string) =>
      isTransientErrorLine(errorContent) ? '\n' : errorContent.trim()
    )
    .replace(TOOL_USE_ERROR_TAG_REGEX, '\n');

  const filteredLines = withoutErrorBlocks
    .split('\n')
    .filter((line) => !isTransientErrorLine(line));

  const sanitized = filteredLines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return sanitized.length > 0 ? sanitized : null;
}

function getDisplayMessages(action: ActionTabEntry): DisplayMessage[] {
  const messages: DisplayMessage[] = [];

  if (action.syntheticAck) {
    messages.push({ text: action.syntheticAck, isLive: action.isStreaming && action.messages.length === 0 });
  }

  for (const text of action.messages ?? []) {
    const parsed = parseMessage(text);
    if (parsed) {
      messages.push({ text: parsed, isLive: false });
    }
  }

  // If streaming, add the current streaming text as a live message
  if (action.streamingText?.trim()) {
    const parsed = parseMessage(action.streamingText.trim());
    if (parsed) {
      messages.push({ text: parsed, isLive: true });
    }
  }

  return messages;
}

/**
 * Renders the data-driven actions for an outcome card (Variant B — "primary +
 * muted tertiary"):
 *
 *   - PRIMARY ("Retry"): a quiet outline button, icon-led. On an error card it
 *     keeps a light status-error tint; on a neutral card it's a muted ink tint.
 *   - SECONDARY on an error card (for example, "Contact support"): a quiet,
 *     non-underlined tertiary text action.
 *   - SECONDARY on a neutral setup card ("Install Claude Code"): a compact
 *     outline button that reads as the recovery step without looking alarming.
 *
 * Tone is passed in by the caller (derived from the card's severity) and the
 * descriptor stays the source of truth for WHICH actions render, so Fix 3 can
 * vary the actions per classified error without touching this rendering.
 */
function ActionCardActions({
  descriptor,
  tone
}: {
  descriptor: ActionCardActionDescriptor;
  tone: ActionCardTone;
}) {
  if (!descriptor.primary && !descriptor.secondaryLink && !descriptor.inlineCommands?.length) {
    return null;
  }

  const primaryClasses = tone === 'error'
    ? cn(
        'inline-flex h-7 shrink-0 items-center gap-1 rounded-md px-2 text-xs font-normal transition-colors',
        'border border-status-error-border/50 bg-transparent text-status-error-text/90',
        'hover:bg-status-error-text/10 hover:text-status-error-text',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-status-error-border'
      )
    : cn(
        'inline-flex h-7 shrink-0 items-center gap-1 rounded-md px-2 text-xs font-normal transition-colors',
        'border border-border-subtle bg-transparent text-ink-muted',
        'hover:bg-border-subtle hover:text-ink-default',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink-default/20'
      );

  const PrimaryIcon = descriptor.primary?.icon ?? RotateCcw;
  const secondaryLinkClasses = tone === 'neutral'
    ? cn(
        'inline-flex h-7 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-2 text-xs font-normal transition-colors',
        'border border-border-subtle bg-surface-raised-control text-ink-muted',
        'hover:bg-surface-raised-control-hover hover:text-ink-default',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink-default/20'
      )
    : 'inline-flex h-7 shrink-0 items-center whitespace-nowrap rounded-md px-1.5 text-xs font-normal text-ink-muted transition-colors hover:bg-surface-sidebar/80 hover:text-ink-default focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink-default/20';

  return (
    <div className="space-y-1.5 pt-0.5">
      {descriptor.inlineCommands?.map((inlineCommand) => (
        <InlineCommand key={inlineCommand.command} {...inlineCommand} />
      ))}
      {(descriptor.primary || descriptor.secondaryLink) && (
        <div className="flex flex-nowrap items-center gap-1">
          {descriptor.primary && (
            <button
              type="button"
              onClick={descriptor.primary.onClick}
              disabled={descriptor.primary.disabled}
              className={cn(primaryClasses, 'disabled:cursor-not-allowed disabled:opacity-50')}
            >
              <PrimaryIcon className="h-3 w-3" strokeWidth={1.75} aria-hidden />
              {descriptor.primary.label}
            </button>
          )}
          {descriptor.secondaryLink && (
            <a
              href={descriptor.secondaryLink.href}
              target="_blank"
              rel="noopener noreferrer"
              className={secondaryLinkClasses}
            >
              {descriptor.secondaryLink.label}
              {tone === 'neutral' ? (
                <ExternalLink className="h-3 w-3" strokeWidth={1.75} aria-hidden="true" />
              ) : null}
            </a>
          )}
        </div>
      )}
    </div>
  );
}

function InlineCommand({
  label,
  command,
  copyLabel,
  copiedLabel
}: {
  label: string;
  command: string;
  copyLabel: string;
  copiedLabel: string;
}) {
  const [copied, setCopied] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleCopy = useCallback(() => {
    if (typeof navigator === 'undefined' || !navigator.clipboard?.writeText) return;

    void navigator.clipboard.writeText(command).then(() => {
      setCopied(true);
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      timeoutRef.current = setTimeout(() => setCopied(false), 2000);
    }).catch(() => undefined);
  }, [command]);

  useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, []);

  return (
    <div className="space-y-1">
      <p className="text-micro text-ink-muted">{label}</p>
      <div className="flex items-start gap-1.5 rounded-md border border-border-subtle bg-surface-raised-control px-2 py-1.5">
        <code className="min-w-0 flex-1 select-text break-all font-mono text-nano leading-4 text-ink-default">
          {command}
        </code>
        <button
          type="button"
          onClick={handleCopy}
          className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-ink-faint transition-colors hover:bg-surface-raised-control-hover hover:text-ink-default focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink-default/20"
          aria-label={copied ? copiedLabel : copyLabel}
          title={copied ? 'Copied' : 'Copy command'}
        >
          {copied ? <Check className="h-3 w-3" aria-hidden /> : <Copy className="h-3 w-3" aria-hidden />}
        </button>
      </div>
    </div>
  );
}

function PromptCopyButton({ prompt, onCopy }: { prompt: string; onCopy: (prompt: string) => void }) {
  const [copied, setCopied] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleCopy = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onCopy(prompt);
    setCopied(true);
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(() => setCopied(false), 2000);
  }, [prompt, onCopy]);

  useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, []);

  return (
    <button
      type="button"
      onClick={handleCopy}
      className="flex h-5 w-5 items-center justify-center rounded text-ink-faint hover:text-ink-muted"
      aria-label="Copy prompt"
    >
      {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
    </button>
  );
}

export function ActionTimelineCard({
  action,
  isExpanded,
  onToggle,
  className,
  isLast = false,
  isComplete = false,
  onCancel,
  onCopyPrompt,
  onOpenImages,
  onRetry,
  retryDisabled
}: ActionTimelineCardProps) {
  // Track auto-collapse by completion timestamp to avoid re-collapsing on re-render
  const [autoCollapsedAt, setAutoCollapsedAt] = useState<string | null>(null);

  // Auto-collapse when last action completes (only once per completion)
  useEffect(() => {
    if (isLast && isComplete && isExpanded && action.completedAt && action.completedAt !== autoCollapsedAt) {
      setAutoCollapsedAt(action.completedAt);
      onToggle();
    }
  }, [isLast, isComplete, isExpanded, action.completedAt, autoCollapsedAt, onToggle]);

  const handleToggle = onToggle;

  const label = action.submittedLabel || 'Action';
  const isStreaming = action.isStreaming;
  const rawPrompt = action.prompt ?? 'No message provided';
  const displayPrompt = useMemo(
    () => stripAgentCommentContextFromPrompt(rawPrompt),
    [rawPrompt]
  );
  const { context: selectedContext, message: promptText } = useMemo(
    () => parsePromptContext(displayPrompt),
    [displayPrompt]
  );
  const htmlMode = (action.mockupMode ?? false) || /^\[(?:HTML|Mockup) mode/i.test(displayPrompt);
  const contextMentions = action.contextMentions ?? [];
  const imageUrls = action.imageUrls ?? [];
  const commentContext = action.commentContext;
  const hasInlineContext =
    htmlMode || !!selectedContext || contextMentions.length > 0 || imageUrls.length > 0;
  const hasCommentContext =
    !!commentContext && commentContext.threads.some((thread) => thread.messages.length > 0);
  const hasPromptHeader =
    hasInlineContext || hasCommentContext;
  const renderedPrompt = useMemo(
    () => renderPromptWithMentionPills(promptText, action.promptMentions),
    [action.promptMentions, promptText]
  );
  const contextItemCount =
    contextMentions.length
    + (htmlMode ? 1 : 0)
    + (selectedContext ? 1 : 0)
    + (imageUrls.length > 0 ? 1 : 0)
    + (hasCommentContext ? 1 : 0);

  // Unified message source for both streaming and completed states
  const displayMessages = getDisplayMessages(action);

  // Aggregate collapse: show last N messages, collapse the rest behind a toggle
  const [showEarlier, setShowEarlier] = useState(false);
  const [showContext, setShowContext] = useState(false);
  const renderContextPills = (imagesAreInteractive: boolean): ReactNode[] => {
    const items: ReactNode[] = [];

    if (selectedContext) {
      items.push(
        <ContextPillReadOnly
          key="selected-context"
          text={selectedContext}
          iconUrl={action.sourceContextIconUrl ?? null}
        />
      );
    }

    for (const mention of contextMentions) {
      items.push(
        <PromptMentionPillReadOnly
          key={`context-${mention.type}-${mention.id}`}
          mention={mention}
        />
      );
    }

    if (htmlMode) {
      items.push(
        <span
          key="html-context"
          className="inline-flex items-center gap-1 rounded-md bg-ink-default/5 px-1.5 py-0.5 text-micro text-ink-default"
        >
          <PanelsTopLeft className="h-2.5 w-2.5 shrink-0 text-ink-muted" />
          HTML
        </span>
      );
    }

    if (imageUrls.length > 0) {
      const imageContent = (
        <>
          <ImageIcon className="h-2.5 w-2.5 shrink-0 text-ink-muted" />
          <span>{imageUrls.length === 1 ? 'Image' : `${imageUrls.length} images`}</span>
        </>
      );
      items.push(
        imagesAreInteractive && onOpenImages ? (
          <button
            key="image-context"
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onOpenImages(imageUrls, 0);
            }}
            className="inline-flex items-center gap-1 rounded-md bg-ink-default/5 px-1.5 py-0.5 text-micro text-ink-default transition-colors hover:bg-ink-default/10"
            aria-label={`View ${imageUrls.length} uploaded image${imageUrls.length === 1 ? '' : 's'}`}
          >
            {imageContent}
          </button>
        ) : (
          <span
            key="image-context"
            className="inline-flex items-center gap-1 rounded-md bg-ink-default/5 px-1.5 py-0.5 text-micro text-ink-default"
          >
            {imageContent}
          </span>
        )
      );
    }

    if (hasCommentContext) {
      items.push(
        <span
          key="comment-context"
          className="inline-flex items-center gap-1 rounded-md bg-ink-default/5 px-1.5 py-0.5 text-micro text-ink-default"
        >
          <MessageSquareText className="h-2.5 w-2.5 shrink-0 text-ink-muted" />
          Comments
        </span>
      );
    }

    return items;
  };
  const collapsedContextPills = renderContextPills(false);
  const expandedContextPills = renderContextPills(true);
  const visibleCount = isStreaming ? 2 : 1;
  const collapsedCount = Math.max(0, displayMessages.length - visibleCount);
  const showCompletionSuccessRow = action.status === 'completed' && displayMessages.length > 0 && !isStreaming;
  const tokenCount = useMemo(
    () => formatTokenCount(action.metrics?.sdk),
    [action.metrics?.sdk]
  );
  const triggerLabel = `${isExpanded ? 'Collapse' : 'Expand'} ${label} timeline${tokenCount ? `, ${tokenCount}` : ''}`;

  // Determine if we need to show the streaming indicator.
  // Show during both the pending phase (after submit, before stream start)
  // and the streaming phase (until the complete event arrives).
  const showStreamingIndicator = isStreaming || action.status === 'pending';
  const rawStatusText = getStatusText(action).text;

  const [iconIndex, setIconIndex] = useState(0);
  const snapshotModeActive = isSnapshotModeActive();

  useEffect(() => {
    if (snapshotModeActive) return;
    if (!showStreamingIndicator) return;
    const id = setInterval(() => setIconIndex(i => i + 1), ICON_CYCLE_MS);
    return () => clearInterval(id);
  }, [showStreamingIndicator, snapshotModeActive]);

  // "Daydreaming..." → "Just kidding..." flash, then settle to real thinking text
  const streamingStatusText = rawStatusText === 'Daydreaming...' && iconIndex >= 3
    ? iconIndex < 6 ? 'Just kidding...' : 'Thinking it through...'
    : rawStatusText;

  const StreamingStatusIcon = STATUS_ACTIVITY_ICONS[iconIndex % STATUS_ACTIVITY_ICONS.length] ?? AlignLeft;

  // Outcome card actions (error or neutral). Derived from the stored streamError
  // flags surfaced by the main process; the card just renders the descriptor.
  const outcome = useMemo(
    () => getOutcomeActions(action, onRetry, retryDisabled),
    [action, onRetry, retryDisabled]
  );

  return (
    <Collapsible.Root open={isExpanded} onOpenChange={handleToggle} className={cn('flex w-full flex-col', className)}>
      <Collapsible.Trigger asChild>
        <button
          type="button"
          aria-label={triggerLabel}
          className={cn(
            'group/card -mx-xs flex self-stretch items-center gap-2 rounded-md bg-surface-transparent px-xs py-sidebar-row-y',
            'text-left transition-colors hover:bg-surface-sidebar',
            'focus-visible:outline-none',
            isLast && isExpanded && 'bg-surface-notes-list'
          )}
        >
          <span className="flex min-w-0 flex-1 items-center gap-1">
            <span className="min-w-0 truncate text-caption font-normal tabular-nums text-ink-muted opacity-60">
              {label}
            </span>
            {tokenCount && (
              <TooltipProvider delayDuration={200}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span
                      className="flex shrink-0 items-center text-ink-subtle opacity-0 transition-opacity group-hover/card:opacity-60 group-focus-visible/card:opacity-60"
                      aria-label={tokenCount}
                    >
                      <Info className="h-3 w-3" aria-hidden />
                    </span>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">
                    <span className="flex items-center gap-1.5 font-mono tabular-nums text-nano">
                      <span>{tokenCount}</span>
                    </span>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            )}
          </span>
          {isExpanded ? (
            <ChevronUp className="h-3 w-3 shrink-0 text-ink-subtle" />
          ) : (
            <ChevronDown className={cn('h-3 w-3 shrink-0 text-ink-subtle opacity-0 transition-opacity group-hover/card:opacity-100')} />
          )}
        </button>
      </Collapsible.Trigger>

      <Collapsible.Content>
        <div className="relative z-0 rounded-lg border border-surface-glass-border bg-surface-glass p-3">
          {/* Screen reader announcement for streaming progress */}
          {isStreaming && (
            <div role="status" aria-live="polite" className="sr-only">
              {displayMessages.length
                ? `${displayMessages.length} responses received`
                : streamingStatusText}
            </div>
          )}

          <TimelineSequence
            steps={[
              {
                id: 'prompt',
                dotClass: 'bg-accent-brand',
                content: (
                  <>
                    <MessageBubble variant="user">
                      {hasPromptHeader && (
                        <Collapsible.Root open={showContext} onOpenChange={setShowContext}>
                          <div
                            className={cn(
                              renderedPrompt && 'mb-2 border-b border-border-subtle/40 pb-2'
                            )}
                            data-action-context-disclosure="true"
                          >
                            <Collapsible.Trigger asChild>
                              <button
                                type="button"
                                className="group/context flex min-h-6 w-full items-center text-left text-micro text-ink-muted transition-colors hover:text-ink-default focus:outline-none"
                                aria-label={showContext ? 'Hide context' : 'Show context'}
                              >
                                <span className="inline-flex min-w-0 max-w-full items-center gap-1 overflow-hidden rounded-md group-focus-visible/context:ring-1 group-focus-visible/context:ring-ink-default/15">
                                  {showContext ? (
                                    <span className="text-ink-faint">Context</span>
                                  ) : (
                                    collapsedContextPills[0]
                                  )}
                                  {!showContext && contextItemCount > 1 ? (
                                    <span className="shrink-0 rounded-md bg-ink-default/5 px-1.5 py-0.5 text-micro text-ink-muted">
                                      +{contextItemCount - 1}
                                    </span>
                                  ) : null}
                                  {showContext ? (
                                    <ChevronDown className="h-3 w-3 shrink-0 text-ink-faint" />
                                  ) : (
                                    <ChevronRight className="h-3 w-3 shrink-0 text-ink-faint" />
                                  )}
                                </span>
                              </button>
                            </Collapsible.Trigger>
                            <Collapsible.Content>
                              <div className="mt-1.5 flex flex-col gap-1.5">
                                {expandedContextPills.length > 0 ? (
                                  <div className="flex flex-wrap items-center gap-1" data-action-context-items="true">
                                    {expandedContextPills}
                                  </div>
                                ) : null}
                                {hasCommentContext && <CommentContextReadOnly context={commentContext} />}
                              </div>
                            </Collapsible.Content>
                          </div>
                        </Collapsible.Root>
                      )}
                      {renderedPrompt ? (
                        <p className="break-words text-xs leading-relaxed text-ink-default">
                          {renderedPrompt}
                        </p>
                      ) : null}
                    </MessageBubble>
                    <div className="mt-1 flex items-center justify-end gap-2">
                      <span className="text-micro font-light text-ink-faint opacity-60">{formatTimestamp(action.createdAt)}</span>
                      {onCopyPrompt && action.prompt && <PromptCopyButton prompt={displayPrompt} onCopy={onCopyPrompt} />}
                    </div>
                  </>
                )
              },
              ...(collapsedCount >= 2 ? [{
                id: 'earlier-steps',
                dotClass: 'bg-accent-brand',
                content: (
                  <>
                    <button
                      type="button"
                      onClick={() => setShowEarlier(prev => !prev)}
                      className="flex w-full items-center gap-1 py-0.5 text-left text-micro font-medium uppercase tracking-wider text-ink-faint/80 transition-colors hover:text-ink-muted"
                      aria-label={showEarlier ? 'Hide earlier steps' : `Show ${collapsedCount} earlier steps`}
                    >
                      <span>{collapsedCount} earlier step{collapsedCount !== 1 ? 's' : ''}</span>
                      {showEarlier ? (
                        <ChevronDown className="h-2.5 w-2.5 shrink-0" />
                      ) : (
                        <ChevronRight className="h-2.5 w-2.5 shrink-0" />
                      )}
                    </button>
                    {showEarlier && (
                      <div className="mt-2 flex flex-col gap-2">
                        {displayMessages.slice(0, collapsedCount).map((msg, idx) => (
                          <MessageBubble key={`collapsed-${idx}`} variant="agent">
                            <div className="whitespace-pre-wrap break-words text-xs text-ink-default leading-relaxed">
                              {renderInlineMarkdown(msg.text, { tables: !msg.isLive })}
                            </div>
                          </MessageBubble>
                        ))}
                      </div>
                    )}
                  </>
                )
              }] : []),
              ...displayMessages.flatMap((msg, idx) => {
                if (idx < collapsedCount && collapsedCount >= 2) return [];
                return [{
                  id: `message-${idx}`,
                  dotClass: msg.isLive ? 'bg-action-tab-pending-honey' : 'bg-accent-brand',
                  dotPulse: msg.isLive,
                  content: (
                    <MessageBubble variant="agent">
                      <div className="whitespace-pre-wrap break-words text-xs text-ink-default leading-relaxed">
                        {renderInlineMarkdown(msg.text, { tables: !msg.isLive })}
                      </div>
                    </MessageBubble>
                  )
                }];
              }),
              ...(action.status === 'error' ? [{
                id: 'error',
                dotClass: outcome.tone === 'error' ? 'bg-status-error-text' : 'bg-ink-faint',
                content: (
                  <>
                    <MessageBubble variant={outcome.tone === 'error' ? 'error' : 'muted'}>
                      <div className="space-y-2" data-action-outcome-tone={outcome.tone}>
                        {outcome.tone === 'error' ? (
                          <p className="flex items-start gap-1.5 break-words text-xs text-status-error-text">
                            <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                            <span className="min-w-0 flex-1">
                              {renderInlineMarkdown(outcome.message ?? action.errorMessage ?? 'An error occurred')}
                            </span>
                          </p>
                        ) : (
                          <p className="break-words text-xs text-ink-muted">
                            {renderInlineMarkdown(
                              outcome.message ?? action.errorMessage ?? "The agent didn't return a response."
                            )}
                          </p>
                        )}
                        <ActionCardActions descriptor={outcome.descriptor} tone={outcome.tone} />
                      </div>
                    </MessageBubble>
                    <div className="mt-1 text-micro font-light text-ink-faint opacity-60">{formatTimestamp(action.completedAt)}</div>
                  </>
                )
              }] : []),
              ...(action.status === 'interrupted' ? [{
                id: 'interrupted',
                dotClass: 'bg-status-error-text',
                content: (
                  <div
                    className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1"
                    data-action-timeline-interrupted="true"
                  >
                    <span className="text-micro font-light text-ink-faint opacity-60">{formatTimestamp(action.completedAt)}</span>
                    <span className="flex items-center gap-1 text-right text-status-error-text">
                      <CircleAlert className="h-3 w-3 shrink-0" aria-hidden="true" />
                      <span className="text-micro leading-snug">
                        {getInterruptReasonMessage(action.interruptReason)}
                      </span>
                    </span>
                  </div>
                )
              }] : [])
            ]}
          />

          {/* Completed success row after the final agent message */}
          {showCompletionSuccessRow && (
            <TimelineSupplement>
              <div className="mt-1 text-micro font-light text-ink-faint opacity-60">{formatTimestamp(action.completedAt)}</div>
              <div className="mt-3 flex items-center justify-end gap-1.5 text-accent-brand text-right">
                <span className="text-micro leading-snug">
                  {COMPLETION_SUCCESS_MESSAGE}
                </span>
                <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
              </div>
            </TimelineSupplement>
          )}

          {/* Streaming indicator + Stop button */}
          {showStreamingIndicator && (
            <TimelineSupplement>
              <div className={cn('space-y-2.5', displayMessages.length > 0 && 'mt-3')}>
                <div className="flex items-center gap-2">
                  <StreamingStatusIcon className="h-3 w-3 shrink-0 text-ink-faint" />
                  <span className="min-w-0 flex-1 text-xs text-ink-muted leading-relaxed">
                    {streamingStatusText}
                  </span>
                </div>
                {onCancel && (
                  <div className="flex justify-end">
                    <button
                      type="button"
                      onClick={onCancel}
                      className="flex h-7 shrink-0 items-center gap-1 rounded-md border border-border-default/30 bg-surface-panel/85 px-2 py-1 text-micro leading-none text-ink-muted transition-colors hover:bg-surface-sidebar/95 hover:text-ink-default"
                    >
                      <Square className="h-2 w-2 fill-ink-muted" />
                      <span className="leading-none">Stop</span>
                    </button>
                  </div>
                )}
              </div>
            </TimelineSupplement>
          )}

          {/* Show completion timestamp when no messages (timestamp already shown on user prompt item) */}
          {action.status === 'completed' && displayMessages.length === 0 && (
            <div className="mt-1 pl-4 text-micro font-light text-ink-faint opacity-60">{formatTimestamp(action.completedAt)}</div>
          )}
        </div>
      </Collapsible.Content>
    </Collapsible.Root>
  );
}

export default ActionTimelineCard;
