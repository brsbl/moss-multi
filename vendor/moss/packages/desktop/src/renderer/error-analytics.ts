// ported-from: packages/desktop/src/renderer/error-analytics.ts @ 762abb777
const ANALYTICS_ERROR_MESSAGE_MAX_CHARS = 320;
const ANALYTICS_ERROR_STACK_MAX_CHARS = 1000;
const ANALYTICS_ERROR_NAME_MAX_CHARS = 120;
const RENDERER_ERROR_SCOPE = 'window.error';
const RENDERER_REJECTION_SCOPE = 'window.unhandledrejection';

type AnalyticsCapture = (event: string, properties?: Record<string, unknown>) => Promise<void>;

type RendererErrorAnalyticsContext = {
  note_id_hash?: string;
  pane_id?: 'left' | 'right';
  split_view?: boolean;
  editor_mount_version?: number;
  editor_remount_reason?: 'disk_content_changed' | 'in_place_import_failed';
  selection_kind?: 'range' | 'collapsed' | 'node' | 'none';
  selection_text_length?: number;
  selection_block_type?: string;
  active_node_type?: string;
  top_level_node_type?: string;
  selected_node_type?: string;
  selection_is_link?: boolean;
  commentable_node_selected?: boolean;
  last_content_change_tags?: string;
  last_markdown_import_source?: 'disk_reload';
  last_markdown_import_update_tag?: string;
};

type RendererAnalyticsTarget = {
  addEventListener: (eventName: string, listener: (event: Event) => void) => void;
  electronAPI?: {
    analytics?: {
      capture?: AnalyticsCapture;
    };
  };
  location?: {
    href?: string;
  };
  __MOSS_RENDERER_ERROR_ANALYTICS_INSTALLED__?: boolean;
};

let rendererErrorAnalyticsContext: RendererErrorAnalyticsContext = {};
let rendererErrorAnalyticsContextOwner: string | null = null;

const truncateText = (value: string | undefined, maxChars: number): string | undefined => {
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  return trimmed.length <= maxChars ? trimmed : `${trimmed.slice(0, maxChars)}...`;
};

const stringifyUnknown = (value: unknown): string | undefined => {
  if (value instanceof Error) {
    return value.message;
  }
  if (typeof value === 'string') {
    return value;
  }
  if (value === null || typeof value === 'undefined') {
    return undefined;
  }

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

const getErrorName = (value: unknown): string | undefined => {
  return value instanceof Error ? truncateText(value.name, ANALYTICS_ERROR_NAME_MAX_CHARS) : undefined;
};

const getErrorMessage = (value: unknown, fallback?: string): string => {
  return (
    truncateText(stringifyUnknown(value), ANALYTICS_ERROR_MESSAGE_MAX_CHARS)
    ?? truncateText(fallback, ANALYTICS_ERROR_MESSAGE_MAX_CHARS)
    ?? 'Unknown renderer error'
  );
};

const getErrorStack = (value: unknown): string | undefined => {
  return value instanceof Error
    ? truncateText(value.stack ?? value.message, ANALYTICS_ERROR_STACK_MAX_CHARS)
    : undefined;
};

const containsAny = (value: string, patterns: readonly string[]): boolean =>
  patterns.some((pattern) => value.includes(pattern));

const hashNoteIdForAnalytics = (noteId: string): string => {
  let hash = 2166136261;
  for (let index = 0; index < noteId.length; index += 1) {
    hash ^= noteId.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `note_${(hash >>> 0).toString(16).padStart(8, '0')}`;
};

const normalizeFingerprintToken = (value: string | undefined, fallback: string): string => {
  const normalized = (value ?? '')
    .toLowerCase()
    .replace(/\b[0-9a-f]{8,}\b/g, '<hex>')
    .replace(/\b\d+\b/g, '<n>')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');

  return normalized || fallback;
};

const extractLexicalErrorSignature = (
  errorMessage: string | undefined,
  errorStack: string | undefined
): { code: string; version?: string } | null => {
  const combined = `${errorMessage ?? ''}\n${errorStack ?? ''}`;
  const codeMatch = combined.match(/lexical(?:[\s\S]*?)error\s+#(\d+)/i);
  if (!codeMatch) {
    return null;
  }

  const versionMatch = combined.match(/\b(v\d{3,})\b/i);
  return {
    code: codeMatch[1],
    ...(versionMatch ? { version: versionMatch[1].toLowerCase() } : {}),
  };
};

const buildRendererInvestigationMetadata = (input: {
  scope: string;
  errorMessage?: string;
  errorStack?: string;
}): Record<string, unknown> => {
  const lexicalSignature = extractLexicalErrorSignature(input.errorMessage, input.errorStack);
  if (lexicalSignature) {
    const versionSuffix = lexicalSignature.version ? ` ${lexicalSignature.version}` : '';
    const rawCode = `#${lexicalSignature.code}`;
    let investigationLabel = `Renderer: Lexical editor failure (raw ${rawCode}${versionSuffix})`;
    let fixHint = 'Inspect note hash, selection shape, active node types, and remount context.';
    let lexicalFailureClass = 'unknown_lexical_failure';

    if (lexicalSignature.code === '75') {
      investigationLabel = `Renderer: Lexical editor update failure (raw ${rawCode}${versionSuffix})`;
      lexicalFailureClass = 'editor_update_failure';
    } else if (lexicalSignature.code === '66') {
      investigationLabel = `Renderer: Lexical selection/state invariant failed (raw ${rawCode}${versionSuffix})`;
      lexicalFailureClass = 'selection_state_invariant';
    } else if (lexicalSignature.code === '194') {
      investigationLabel = `Renderer: Lexical decorator/render invariant failed (raw ${rawCode}${versionSuffix})`;
      lexicalFailureClass = 'decorator_render_invariant';
    } else if (lexicalSignature.code === '19') {
      investigationLabel = `Renderer: Lexical editor state invariant failed (raw ${rawCode}${versionSuffix})`;
      fixHint = 'Inspect selection shape, node keys, and whether the editor remounted while pending work was still running.';
      lexicalFailureClass = 'editor_state_invariant';
    } else if (lexicalSignature.code === '20') {
      investigationLabel = `Renderer: Lexical update/command invariant failed (raw ${rawCode}${versionSuffix})`;
      fixHint = 'Inspect command handlers, editor.update boundaries, and whether decorator interactions triggered nested updates.';
      lexicalFailureClass = 'update_command_invariant';
    } else if (lexicalSignature.code === '222') {
      investigationLabel = `Renderer: Lexical node/render invariant failed (raw ${rawCode}${versionSuffix})`;
      lexicalFailureClass = 'node_render_invariant';
    } else {
      fixHint = 'Inspect the raw Lexical code, note hash, selection shape, active node types, and remount context.';
    }

    return {
      investigation_area: 'renderer',
      investigation_subarea: 'lexical',
      investigation_label: investigationLabel,
      fix_hint: fixHint,
      error_fingerprint: `renderer:lexical_${lexicalSignature.code}`,
      raw_error_code: rawCode,
      lexical_error_version: lexicalSignature.version,
      lexical_failure_class: lexicalFailureClass,
    };
  }

  const errorText = `${input.errorMessage ?? ''}\n${input.errorStack ?? ''}`.toLowerCase();
  if (input.scope === RENDERER_REJECTION_SCOPE) {
    return {
      investigation_area: 'renderer',
      investigation_label: 'Renderer: unhandled promise rejection',
      fix_hint: 'Inspect the rejected promise source, page_url, note hash, and current selection/remount context.',
      error_fingerprint: 'renderer:unhandled_promise_rejection',
    };
  }

  if (containsAny(errorText, ['resizeobserver loop', 'observer loop limit exceeded'])) {
    return {
      investigation_area: 'renderer',
      investigation_label: 'Renderer: ResizeObserver loop failure',
      fix_hint: 'Inspect recent layout changes, popovers, and remount timing around the active pane.',
      error_fingerprint: 'renderer:resizeobserver_loop_failure',
    };
  }

  return {
    investigation_area: 'renderer',
    investigation_label: 'Renderer: uncaught browser error',
    fix_hint: 'Inspect error_stack, page_url, note hash, and the current selection/remount context.',
    error_fingerprint: `renderer:${normalizeFingerprintToken(input.errorMessage, 'uncaught_browser_error')}`,
  };
};

const getActiveElementAnalytics = (): Record<string, unknown> => {
  if (typeof document === 'undefined') {
    return {};
  }

  const activeElement = document.activeElement;
  if (!activeElement) {
    return {};
  }

  return {
    active_element_tag: activeElement.tagName.toLowerCase(),
    active_element_role: activeElement.getAttribute('role') ?? undefined,
  };
};

export const setRendererErrorAnalyticsContext = (
  context: Partial<RendererErrorAnalyticsContext> & { noteId?: string | null },
  ownerId?: string
): void => {
  const nextContext = { ...rendererErrorAnalyticsContext };

  for (const [key, value] of Object.entries(context)) {
    if (key === 'noteId') {
      if (typeof value === 'string' && value.length > 0) {
        nextContext.note_id_hash = hashNoteIdForAnalytics(value);
      } else {
        delete nextContext.note_id_hash;
      }
      continue;
    }

    if (typeof value === 'undefined') {
      delete nextContext[key as keyof RendererErrorAnalyticsContext];
      continue;
    }

    (nextContext as Record<string, unknown>)[key] = value;
  }

  rendererErrorAnalyticsContext = nextContext;
  if (typeof ownerId === 'string' && ownerId.length > 0) {
    rendererErrorAnalyticsContextOwner = ownerId;
  }
};

export const clearRendererErrorAnalyticsContext = (
  keys?: Array<keyof RendererErrorAnalyticsContext>,
  ownerId?: string
): void => {
  if (
    typeof ownerId === 'string' &&
    ownerId.length > 0 &&
    rendererErrorAnalyticsContextOwner !== null &&
    rendererErrorAnalyticsContextOwner !== ownerId
  ) {
    return;
  }

  if (!keys || keys.length === 0) {
    rendererErrorAnalyticsContext = {};
    rendererErrorAnalyticsContextOwner = null;
    return;
  }

  const nextContext = { ...rendererErrorAnalyticsContext };
  for (const key of keys) {
    delete nextContext[key];
  }
  rendererErrorAnalyticsContext = nextContext;
  if (Object.keys(nextContext).length === 0) {
    rendererErrorAnalyticsContextOwner = null;
  }
};

export const __resetRendererErrorAnalyticsContextForTesting = (): void => {
  rendererErrorAnalyticsContext = {};
  rendererErrorAnalyticsContextOwner = null;
};

const captureRendererEvent = (
  target: RendererAnalyticsTarget,
  eventName: string,
  properties: Record<string, unknown>
): void => {
  try {
    const capturePromise = target.electronAPI?.analytics?.capture?.(eventName, {
      ...rendererErrorAnalyticsContext,
      ...getActiveElementAnalytics(),
      ...properties,
    });
    void capturePromise?.catch(() => {});
  } catch {
    // Ignore analytics bridge failures while reporting renderer failures.
  }
};

export const installRendererErrorAnalytics = (
  target: RendererAnalyticsTarget = window as unknown as RendererAnalyticsTarget
): void => {
  if (!target || target.__MOSS_RENDERER_ERROR_ANALYTICS_INSTALLED__) {
    return;
  }

  target.__MOSS_RENDERER_ERROR_ANALYTICS_INSTALLED__ = true;

  target.addEventListener('error', (event: Event) => {
    const errorEvent = event as ErrorEvent;
    const error = errorEvent.error;
    const errorMessage = getErrorMessage(error, errorEvent.message);
    const errorStack = getErrorStack(error);
    captureRendererEvent(target, 'renderer_unhandled_error', {
      scope: RENDERER_ERROR_SCOPE,
      error_name: getErrorName(error),
      error_message: errorMessage,
      error_stack: errorStack,
      source_url: truncateText(errorEvent.filename, ANALYTICS_ERROR_MESSAGE_MAX_CHARS),
      line: errorEvent.lineno,
      column: errorEvent.colno,
      page_url: truncateText(target.location?.href, ANALYTICS_ERROR_MESSAGE_MAX_CHARS),
      ...buildRendererInvestigationMetadata({
        scope: RENDERER_ERROR_SCOPE,
        errorMessage,
        errorStack,
      }),
    });
  });

  target.addEventListener('unhandledrejection', (event: Event) => {
    const rejectionEvent = event as PromiseRejectionEvent;
    const reason = rejectionEvent.reason;
    const errorMessage = getErrorMessage(reason, 'Unhandled promise rejection');
    const errorStack = getErrorStack(reason);
    captureRendererEvent(target, 'renderer_unhandled_error', {
      scope: RENDERER_REJECTION_SCOPE,
      error_name: getErrorName(reason),
      error_message: errorMessage,
      error_stack: errorStack,
      page_url: truncateText(target.location?.href, ANALYTICS_ERROR_MESSAGE_MAX_CHARS),
      ...buildRendererInvestigationMetadata({
        scope: RENDERER_REJECTION_SCOPE,
        errorMessage,
        errorStack,
      }),
    });
  });
};
