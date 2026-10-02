// ported-from: packages/desktop/src/common/web-embed-preview.ts @ 762abb777
import {
  createDerivedPreviewCacheKey,
  type DerivedPreviewResult,
  type DerivedPreviewStatus
} from './derived-preview';
import { computeContentHash } from './content-hash';
import { getEmbedIframePolicy, type EmbedIframeRiskProfile } from './embed-iframe-policy';
import { extractWebEmbedTitle, isTwitterStatusUrl, normalizeWebEmbedUrl } from './web-embed-url';

export const WEB_EMBED_PREVIEW_KIND = 'web-embed-preview' as const;
export const WEB_EMBED_PREVIEW_IFRAME_RISK_PROFILE: EmbedIframeRiskProfile =
  'remote-oembed-preview';
export const WEB_EMBED_PREVIEW_HTML_RENDER_MODE = 'srcdoc';

export interface EnsureWebEmbedPreviewInput {
  noteId: string;
  url: string;
  force?: boolean;
}

export interface WebEmbedPreviewDescriptor {
  normalizedUrl: string;
  urlHash: string;
  cacheKey: string;
}

export type WebEmbedPreviewMetadata = Record<string, string | number | boolean | null>;

export type WebEmbedPreviewResult = DerivedPreviewResult & {
  kind: typeof WEB_EMBED_PREVIEW_KIND;
  status: Extract<DerivedPreviewStatus, 'resolved' | 'fallback' | 'failed'>;
  metadata?: WebEmbedPreviewMetadata;
};

export function getWebEmbedPreviewDescriptor(url: string): WebEmbedPreviewDescriptor | null {
  const normalizedUrl = normalizeWebEmbedUrl(url);
  if (!normalizedUrl) {
    return null;
  }
  const urlHash = computeContentHash(normalizedUrl);
  return {
    normalizedUrl,
    urlHash,
    cacheKey: createDerivedPreviewCacheKey({
      kind: WEB_EMBED_PREVIEW_KIND,
      sourceSignature: urlHash
    })
  };
}

export function createWebEmbedPreviewResult(input: {
  descriptor: WebEmbedPreviewDescriptor;
  status: WebEmbedPreviewResult['status'];
  assetRelativePath?: string;
  html?: string;
  metadata?: WebEmbedPreviewMetadata;
  generatedAt?: string;
  expiresAt?: string;
  errorCode?: string;
}): WebEmbedPreviewResult {
  return {
    kind: WEB_EMBED_PREVIEW_KIND,
    sourceKey: input.descriptor.normalizedUrl,
    sourceSignature: input.descriptor.normalizedUrl,
    cacheKey: input.descriptor.cacheKey,
    status: input.status,
    assetRelativePath: input.assetRelativePath,
    html: input.html,
    metadata: input.metadata,
    generatedAt: input.generatedAt,
    expiresAt: input.expiresAt,
    errorCode: input.errorCode
  };
}

const TWEET_STATUS_PATH_RE = /^\/([^/]+)\/status\/(\d+)/;

/** Pull `{handle, tweetId}` from a `/<handle>/status/<id>` URL, or null. */
const parseTweetIdentity = (
  normalizedUrl: string
): { handle: string; tweetId: string } | null => {
  try {
    const match = TWEET_STATUS_PATH_RE.exec(new URL(normalizedUrl).pathname);
    return match ? { handle: match[1], tweetId: match[2] } : null;
  } catch {
    return null;
  }
};

export function createWebEmbedFallbackMetadata(
  normalizedUrl: string,
  extras: WebEmbedPreviewMetadata = {}
): WebEmbedPreviewMetadata {
  const title = extractWebEmbedTitle(normalizedUrl);
  const parsed = new URL(normalizedUrl);
  const base: WebEmbedPreviewMetadata = {
    title: typeof extras.title === 'string' && extras.title.trim() ? extras.title : title,
    hostname: parsed.hostname.replace(/^www\./, ''),
    url: normalizedUrl,
    renderMode: 'url-card'
  };
  // Only tweet STATUS urls become tweet cards; other X/Twitter urls stay normal.
  // Stamp a minimal non-blank tweet shape (handle/id + source link) so the tweet
  // worker can render an avatar-placeholder card even when oEmbed is unavailable
  // (the oEmbed resolver layers on richer text/date fields when it succeeds).
  if (isTwitterStatusUrl(normalizedUrl)) {
    const tweet = parseTweetIdentity(normalizedUrl);
    if (tweet) {
      base.embedKind = 'tweet';
      base.authorHandle = `@${tweet.handle}`;
      base.tweetId = tweet.tweetId;
      base.canonicalUrl = normalizedUrl;
    }
  }
  return { ...base, ...extras };
}

export function createWebEmbedHtmlMetadata(
  normalizedUrl: string,
  metadata: WebEmbedPreviewMetadata = {}
): WebEmbedPreviewMetadata {
  const policy = getEmbedIframePolicy(WEB_EMBED_PREVIEW_IFRAME_RISK_PROFILE);
  return {
    ...createWebEmbedFallbackMetadata(normalizedUrl),
    ...metadata,
    iframeRiskProfile: WEB_EMBED_PREVIEW_IFRAME_RISK_PROFILE,
    iframeSandbox: policy.sandbox,
    htmlRenderMode: WEB_EMBED_PREVIEW_HTML_RENDER_MODE
  };
}
