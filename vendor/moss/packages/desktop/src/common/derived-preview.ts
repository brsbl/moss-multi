// ported-from: packages/desktop/src/common/derived-preview.ts @ 762abb777
/**
 * Shared derived-preview contract.
 *
 * This is NOT a universal preview generator. It is one common vocabulary for
 * cache identity, lifecycle status, result shape, and exact-key subscriptions
 * shared by HTML preview PNGs, local video thumbnails, and webpage oEmbed/URL
 * card previews. Kind-specific materializers stay separate; only the contract
 * is shared.
 */

export type DerivedPreviewKind =
  | 'html-preview'
  | 'video-thumbnail'
  | 'web-embed-preview';

export type DerivedPreviewStatus =
  | 'idle'
  | 'resolving'
  | 'resolved'
  | 'fallback'
  | 'failed'
  | 'stale';

export interface DerivedPreviewResult {
  kind: DerivedPreviewKind;
  /** Logical thing being previewed: note-local HTML key, video ref, or normalized URL. */
  sourceKey: string;
  /** Invalidation input for that source. */
  sourceSignature: string;
  /** Stable materialization/subscription key. */
  cacheKey: string;
  status: DerivedPreviewStatus;
  assetRelativePath?: string;
  html?: string;
  metadata?: Record<string, string | number | boolean | null>;
  generatedAt?: string;
  expiresAt?: string;
  errorCode?: string;
}

/** Stable cache/subscription key for a derived preview. */
export function createDerivedPreviewCacheKey(input: {
  kind: DerivedPreviewKind;
  sourceSignature: string;
}): string {
  return `${input.kind}:${input.sourceSignature}`;
}

const TERMINAL_DERIVED_PREVIEW_STATUSES: ReadonlySet<DerivedPreviewStatus> = new Set<
  DerivedPreviewStatus
>(['resolved', 'fallback', 'failed']);

/** Terminal results are cacheable; non-terminal ones are transient/in-flight. */
export function isTerminalDerivedPreviewStatus(status: DerivedPreviewStatus): boolean {
  return TERMINAL_DERIVED_PREVIEW_STATUSES.has(status);
}

/**
 * Whether a known result should be (re)materialized.
 * - idle / stale: always refresh.
 * - resolving: in flight, never refresh.
 * - terminal: refresh only once past `expiresAt` (absent/invalid TTL = keep).
 */
export function shouldRefreshDerivedPreview(result: {
  status: DerivedPreviewStatus;
  expiresAt?: string;
}): boolean {
  if (result.status === 'idle' || result.status === 'stale') {
    return true;
  }
  if (result.status === 'resolving') {
    return false;
  }

  if (!result.expiresAt) {
    return false;
  }
  const expiresAtMs = Date.parse(result.expiresAt);
  if (Number.isNaN(expiresAtMs)) {
    return false;
  }
  return expiresAtMs <= Date.now();
}
