// ported-from: packages/desktop/src/renderer/utils/action-tab-utils.ts @ 762abb777
/**
 * Shared utilities for ActionTabEntry manipulation.
 *
 * These functions are used by App.tsx and other modules to manage
 * action tabs, avoiding code duplication across the codebase.
 */

import type {
  ActionPromptMention,
  ActionTabEntry,
  ActionPlanTodo,
  ActionPlanChange,
  AgentStreamEvent
} from '@moss/shared';
import { deriveSubmittedLabel, getSyntheticAck } from '@moss/shared';
import type { StickyTabRecord } from '../../common/noteTypes';
import {
  classifyNormalizedAgentExecuteErrorMessage,
  normalizeAgentErrorMessageText
} from './agent-error-message';

// ---------------------------------------------------------------------------
// Type aliases for input flexibility
// ---------------------------------------------------------------------------

/**
 * Input type for todos - accepts both ActionTabEntry format and StickyTabRecord format.
 * This allows the cloneTodos function to work with data from atoms or disk records.
 */
type TodosInput = ActionTabEntry['todos'] | StickyTabRecord['todos'];

/**
 * Input type for changes - accepts both ActionTabEntry format and StickyTabRecord format.
 * This allows the cloneChanges function to work with data from atoms or disk records.
 */
type ChangesInput = ActionTabEntry['changes'] | StickyTabRecord['changes'];

// ---------------------------------------------------------------------------
// Clone utilities
// ---------------------------------------------------------------------------

/**
 * Shallow clones an array of TodoItem objects.
 * Returns an empty array if input is undefined or null.
 *
 * @param todos - Array of todo items to clone (from atom or disk record)
 * @returns A new array with cloned todo objects
 */
export const cloneTodos = (todos?: TodosInput): ActionPlanTodo[] =>
  todos ? todos.map((todo) => ({ ...todo })) : [];

/**
 * Shallow clones an array of FileChange objects.
 * Returns an empty array if input is undefined or null.
 *
 * @param changes - Array of file changes to clone (from atom or disk record)
 * @returns A new array with cloned change objects
 */
export const cloneChanges = (changes?: ChangesInput): ActionPlanChange[] =>
  changes ? changes.map((change) => ({ ...change })) : [];

const cloneTiming = (timing?: ActionTabEntry['timing']): ActionTabEntry['timing'] =>
  timing ? { ...timing } : undefined;

const cloneMetrics = (metrics?: ActionTabEntry['metrics']): ActionTabEntry['metrics'] => {
  if (!metrics) {
    return undefined;
  }

  const cloned = {
    stage: metrics.stage ? { ...metrics.stage } : undefined,
    sdk: metrics.sdk ? { ...metrics.sdk } : undefined,
    context: metrics.context ? { ...metrics.context } : undefined,
    derived: metrics.derived ? { ...metrics.derived } : undefined,
  };

  return cloned.stage || cloned.sdk || cloned.context || cloned.derived
    ? cloned
    : undefined;
};

const cloneCommentContext = (context?: ActionTabEntry['commentContext']): ActionTabEntry['commentContext'] =>
  context
    ? {
        ...context,
        threads: context.threads.map((thread) => ({
          ...thread,
          messages: thread.messages.map((message) => ({ ...message }))
        }))
      }
    : undefined;

// ---------------------------------------------------------------------------
// ID generation
// ---------------------------------------------------------------------------

/**
 * Generates a unique identifier string.
 * Uses crypto.randomUUID() when available, falls back to Math.random().
 *
 * @returns A unique identifier string
 */
export const generateId = (): string => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `id-${Math.random().toString(36).slice(2, 10)}`;
};

// ---------------------------------------------------------------------------
// Draft action entry management
// ---------------------------------------------------------------------------

/**
 * Creates a new draft ActionTabEntry with default values.
 * Used when initializing a new action tab or resetting to draft state.
 *
 * @returns A new ActionTabEntry in draft status
 * @deprecated Use createPendingActionEntry instead. Draft tabs are being removed.
 */
export const createDraftActionEntry = (): ActionTabEntry => ({
  id: generateId(),
  status: 'draft',
  prompt: null,
  responseSummary: null,
  errorMessage: null,
  createdAt: new Date().toISOString(),
  completedAt: null,
  submittedLabel: null,
  todos: [],
  changes: [],
  messages: [],
  streamingText: '',
  isStreaming: false,
  activeTools: [],
  lastToolName: null,
  streamError: null,
  toolCallCounts: {},
  syntheticAck: null
});

/**
 * Creates a new pending ActionTabEntry with the given prompt.
 * Used when submitting a new action - creates a pending tab directly
 * without the draft -> pending transition.
 *
 * @param prompt - The user's prompt text
 * @returns A new ActionTabEntry in pending status
 */
export const createPendingActionEntry = (
  prompt: string,
  promptMentions: ActionPromptMention[] = []
): ActionTabEntry => {
  const createdAt = new Date().toISOString();
  return {
    id: generateId(),
    status: 'pending',
    prompt,
    promptMentions: promptMentions.length > 0 ? promptMentions.map((mention) => ({ ...mention })) : undefined,
    responseSummary: null,
    errorMessage: null,
    createdAt,
    completedAt: null,
    submittedLabel: deriveSubmittedLabel('pending', createdAt) ?? 'Unknown time',
    todos: [],
    changes: [],
    messages: [],
    streamingText: '',
    isStreaming: false,
    activeTools: [],
    lastToolName: null,
    streamError: null,
    toolCallCounts: {},
    syntheticAck: null
  };
};

/**
 * Ensures at least one draft action tab exists in the tabs array.
 * - If no drafts exist, appends a new draft tab
 * - If multiple drafts exist, keeps only the first one
 * - If exactly one draft exists, returns the array unchanged
 *
 * @param tabs - Current array of ActionTabEntry objects
 * @returns Updated array with exactly one draft tab
 */
export const ensureDraftActionExists = (tabs: ActionTabEntry[]): ActionTabEntry[] => {
  const drafts = tabs.filter((tab) => tab.status === 'draft');

  if (drafts.length === 0) {
    return [...tabs, createDraftActionEntry()];
  }

  if (drafts.length === 1) {
    return tabs;
  }

  // Multiple drafts - keep only the first one
  const [firstDraft] = drafts;
  return tabs.filter((tab) => tab.status !== 'draft' || tab.id === firstDraft.id);
};

// ---------------------------------------------------------------------------
// Stream event transformation
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Timestamp conversion utilities
// ---------------------------------------------------------------------------

const nowInSeconds = (): number => Math.floor(Date.now() / 1000);

/**
 * Converts Unix timestamp (seconds) to ISO 8601 string.
 * Returns current timestamp if input is invalid.
 */
const toIsoTimestamp = (seconds?: number): string => {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds)) {
    return new Date().toISOString();
  }
  return new Date(seconds * 1000).toISOString();
};

/**
 * Parses ISO timestamp string to Unix seconds.
 * Returns current time if input is invalid.
 */
const parseTimestampToSeconds = (value: string | null): number => {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return nowInSeconds();
  }
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    return nowInSeconds();
  }
  return Math.floor(parsed / 1000);
};

// ---------------------------------------------------------------------------
// ActionTabEntry helpers (with submittedLabel management)
// ---------------------------------------------------------------------------

type ActionTabEntryBase = Omit<ActionTabEntry, 'submittedLabel'>;

const finalizeSubmittedLabel = (
  base: Pick<ActionTabEntryBase, 'status' | 'createdAt'>,
  existingLabel: string | null = null
): string | null => {
  if (base.status === 'draft') {
    return null;
  }
  if (existingLabel) {
    return existingLabel;
  }
  return deriveSubmittedLabel(base.status, base.createdAt) ?? 'Unknown time';
};

/**
 * Creates an ActionTabEntry from a base object, computing submittedLabel.
 */
export const createActionTabEntry = (base: ActionTabEntryBase): ActionTabEntry => ({
  ...base,
  submittedLabel: finalizeSubmittedLabel(base)
});

/**
 * Updates an ActionTabEntry, recomputing submittedLabel as needed.
 */
export const updateActionTabEntry = (
  entry: ActionTabEntry,
  updates: Partial<Omit<ActionTabEntry, 'submittedLabel'>>
): ActionTabEntry => {
  const { submittedLabel: _ignored, ...rest } = entry;
  const merged = { ...rest, ...updates };
  return {
    ...merged,
    submittedLabel: finalizeSubmittedLabel(merged, entry.submittedLabel)
  };
};

/**
 * Strips the submittedLabel from an ActionTabEntry, returning a base object
 * that can be passed to createActionTabEntry for fresh label computation.
 */
export const stripSubmittedLabel = (entry: ActionTabEntry): ActionTabEntryBase => {
  const { submittedLabel: _ignored, ...rest } = entry;
  return rest;
};

// ---------------------------------------------------------------------------
// StickyTabRecord <-> ActionTabEntry mapping
// ---------------------------------------------------------------------------

/**
 * Maps a persisted StickyTabRecord to an in-memory ActionTabEntry.
 * Handles timestamp conversion and field normalization.
 *
 * Note: Recovery of orphaned 'pending' tabs happens in the main process
 * (note-store.ts cleanupOrphanedAgentTabs) which checks the agent session
 * registry. This function should NOT convert pending→interrupted since it
 * runs on every tab load, not just app startup.
 */
export const mapActionTabRecordToEntry = (record: StickyTabRecord): ActionTabEntry => {
  const createdAt = toIsoTimestamp(record.createdAt);
  const errorMessage = record.errorMessage
    ? normalizeAgentErrorMessageText(record.errorMessage)
    : record.errorMessage;
  const inferredErrorClassification = errorMessage
    ? classifyNormalizedAgentExecuteErrorMessage(errorMessage)
    : undefined;

  // Normalize: prefer messages[], fallback to responseSummary for old notes
  const messages = record.messages?.length
    ? [...record.messages]
    : record.responseSummary
      ? [record.responseSummary]
      : [];

  const completedAt = record.completedAt ? toIsoTimestamp(record.completedAt) : null;

  return createActionTabEntry({
    id: record.id,
    status: record.status,
    prompt: record.prompt,
    promptMentions: record.promptMentions ? record.promptMentions.map((mention) => ({ ...mention })) : undefined,
    contextMentions: record.contextMentions ? record.contextMentions.map((mention) => ({ ...mention })) : undefined,
    commentContext: cloneCommentContext(record.commentContext),
    imageUrls: record.imageUrls && record.imageUrls.length > 0 ? [...record.imageUrls] : undefined,
    interruptReason: record.interruptReason,
    responseSummary: null, // Don't propagate deprecated field
    errorMessage,
    createdAt,
    completedAt,
    todos: cloneTodos(record.todos),
    changes: cloneChanges(record.changes),
    trigger: record.trigger,
    model: record.model,
    profile: record.profile,
    timing: record.timing ? { ...record.timing } : undefined,
    metrics: cloneMetrics(record.metrics),
    completionText: undefined, // Don't propagate deprecated field
    messages,
    scratchPadContent: record.scratchPadContent,
    contentSnapshot: record.contentSnapshot,
    sourceContextIconUrl: record.sourceContextIconUrl,
    // Initialize streaming fields with defaults (not persisted)
    streamingText: '',
    isStreaming: false,
    activeTools: [],
    lastToolName: null,
    // Reconstruct streamError for a persisted error tab so it reloads with the
    // correct card treatment (neutral vs red). message is reused from
    // errorMessage; older records without errorCode reload as null (prior
    // behaviour).
    streamError:
      record.status === 'error' && (record.errorCode || inferredErrorClassification)
        ? {
            code: record.errorCode ?? 'SDK_ERROR',
            message: errorMessage ?? '',
            classification: record.errorClassification ?? inferredErrorClassification,
            retryable: record.errorRetryable ?? false,
            severity:
              record.errorSeverity ??
              (inferredErrorClassification === 'runtime_not_found' ||
              inferredErrorClassification === 'auth_required'
                ? 'neutral'
                : 'error')
          }
        : null,
    toolCallCounts: {},
    syntheticAck: record.syntheticAck ?? null
  });
};

/**
 * Maps an in-memory ActionTabEntry to a persistable StickyTabRecord.
 * Handles timestamp conversion and omits runtime-only fields.
 */
export const mapActionTabEntryToRecord = (entry: ActionTabEntry): StickyTabRecord => ({
  id: entry.id,
  status: entry.status,
  prompt: entry.prompt ?? null,
  promptMentions:
    entry.promptMentions && entry.promptMentions.length > 0
      ? entry.promptMentions.map((mention) => ({ ...mention }))
      : undefined,
  contextMentions:
    entry.contextMentions && entry.contextMentions.length > 0
      ? entry.contextMentions.map((mention) => ({ ...mention }))
      : undefined,
  commentContext: cloneCommentContext(entry.commentContext),
  imageUrls: entry.imageUrls && entry.imageUrls.length > 0 ? [...entry.imageUrls] : undefined,
  responseSummary: null, // Stop writing to deprecated field
  errorMessage: entry.errorMessage ?? null,
  createdAt: parseTimestampToSeconds(entry.createdAt),
  completedAt: entry.completedAt ? parseTimestampToSeconds(entry.completedAt) : null,
  todos: entry.todos.length > 0 ? cloneTodos(entry.todos) : undefined,
  changes: entry.changes.length > 0 ? cloneChanges(entry.changes) : undefined,
  trigger: entry.trigger,
  model: entry.model,
  profile: entry.profile,
  timing: cloneTiming(entry.timing),
  metrics: cloneMetrics(entry.metrics),
  completionText: undefined, // Stop writing to deprecated field
  messages: entry.messages.length > 0 ? [...entry.messages] : undefined,
  scratchPadContent: entry.scratchPadContent,
  interruptReason: entry.interruptReason,
  syntheticAck: entry.syntheticAck ?? undefined,
  sourceContextIconUrl: entry.sourceContextIconUrl,
  contentSnapshot: entry.contentSnapshot,
  // Persist the error classification so a reloaded error tab keeps its severity
  // (neutral empty_success stays muted, not red). The message is already
  // persisted via errorMessage.
  errorCode: entry.streamError?.code,
  errorClassification: entry.streamError?.classification,
  errorRetryable: entry.streamError?.retryable,
  errorSeverity: entry.streamError?.severity
});

// ---------------------------------------------------------------------------
// Stream event transformation
// ---------------------------------------------------------------------------

export const applyStreamEventToTab = (
  tab: ActionTabEntry,
  event: AgentStreamEvent
): ActionTabEntry => {
  if (tab.id !== event.tabId) return tab;

  const nowSeconds = nowInSeconds();

  switch (event.type) {
    case 'start':
      return {
        ...tab,
        isStreaming: true,
        streamingText: '',
        activeTools: [],
        lastToolName: null,
        streamError: null,
        toolCallCounts: {},
        timing: { startedAt: nowSeconds },
        syntheticAck: getSyntheticAck(tab.prompt)
      };

    case 'text':
      return {
        ...tab,
        streamingText: tab.streamingText + event.text,
        timing: {
          ...tab.timing,
          firstTextAt: tab.timing?.firstTextAt ?? nowSeconds,
          lastTextAt: nowSeconds
        }
      };

    case 'tool_start': {
      // Prevent duplicate entries if tool_start is received multiple times
      if (tab.activeTools.some((t) => t.toolId === event.toolId)) return tab;
      const currentCount = tab.toolCallCounts[event.toolName] ?? 0;
      return {
        ...tab,
        activeTools: [
          ...tab.activeTools,
          { toolId: event.toolId, toolName: event.toolName, startedAt: Date.now() }
        ],
        lastToolName: event.toolName,
        toolCallCounts: {
          ...tab.toolCallCounts,
          [event.toolName]: currentCount + 1
        }
      };
    }

    case 'tool_end':
      return {
        ...tab,
        activeTools: tab.activeTools.filter((t) => t.toolId !== event.toolId)
      };

    case 'turn_end':
      // Move streamingText to messages, reset for next turn
      return {
        ...tab,
        messages: tab.streamingText.trim() ? [...tab.messages, tab.streamingText.trim()] : tab.messages,
        streamingText: ''
      };

    case 'complete':
      // Finalize: move any remaining streamingText to messages
      return {
        ...tab,
        isStreaming: false,
        status: tab.status === 'pending' ? 'completed' : tab.status,
        completedAt: tab.status === 'pending' ? new Date().toISOString() : tab.completedAt,
        messages: tab.streamingText.trim() ? [...tab.messages, tab.streamingText.trim()] : tab.messages,
        streamingText: '',
        activeTools: [],
        lastToolName: null,
        toolCallCounts: {},
        timing: {
          ...tab.timing,
          completedAt: nowSeconds
        }
      };

    case 'error':
      return {
        ...tab,
        isStreaming: false,
        status: 'error',
        streamError: {
          code: event.code,
          message: event.message,
          retryable: event.retryable ?? false,
          severity: event.severity ?? 'error'
        },
        errorMessage: event.message,
        activeTools: [],
        lastToolName: null,
        toolCallCounts: {},
        timing: {
          ...tab.timing,
          completedAt: nowSeconds
        }
      };

    case 'editor_update':
      // Editor updates are handled separately by CanvasAreaContent, not stored in tab
      return tab;

    default:
      return tab;
  }
};
