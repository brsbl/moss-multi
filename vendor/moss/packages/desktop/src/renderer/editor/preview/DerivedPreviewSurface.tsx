// ported-from: packages/desktop/src/renderer/editor/preview/DerivedPreviewSurface.tsx @ 762abb777
/**
 * Shared preview/fallback surface. Renders one of three states from a
 * `DerivedPreviewResult`:
 *  - cache image (an asset-backed PNG preview),
 *  - sandboxed HTML (oEmbed preview inside a remote-oembed-preview iframe),
 *  - deterministic URL card (fallback).
 *
 * This is a presentational surface only — it materializes no work during render.
 * Interactive affordances (open-in-browser, click-to-load) are layered on by the
 * consuming node (W3/W5).
 *
 * The asset (thumbnail) tier is preferred over the script/iframe-bearing oEmbed
 * HTML tier. When the HTML tier IS used, its nested remote iframe is gated
 * behind viewport visibility (IntersectionObserver) so a note full of embeds
 * does not eagerly mount remote iframes off-screen before they are seen.
 */
import { useEffect, useRef, useState } from 'react';
import type { CSSProperties, JSX, RefObject } from 'react';
import { Globe2 } from 'lucide-react';

import type { DerivedPreviewResult } from '../../../common/derived-preview';
import { normalizeWebEmbedUrl } from '../../../common/web-embed-url';
import { createRemoteOEmbedPreviewIframeModel } from '../iframe/iframe-model';
import { ScrollClippedIframe } from './ScrollClippedIframe';

export interface DerivedPreviewSurfaceProps {
  /** The derived-preview result. `null`/`undefined` falls back to the URL card. */
  result?: DerivedPreviewResult | null;
  /** Resolved displayable URL for an asset-backed (cache image) preview. */
  assetUrl?: string | null;
  /** Title/alt used by the image and the URL card. */
  title?: string;
  /** Original URL shown on the fallback URL card. */
  url?: string;
  className?: string;
  variant?: 'default' | 'hover-card';
  siteIconAssetUrl?: string | null;
  /** Reserve room for the bottom-left Live badge when this surface is used in an activatable card. */
  reserveBottomLeftBadgeSpace?: boolean;
  onImageLoad?: () => void;
  onImageError?: () => void;
}

/**
 * True once `ref`'s element is at/near the viewport (latches on, never off).
 * When `enabled` is false — or IntersectionObserver is unavailable (jsdom / old
 * runtimes) — it reports `true` so the iframe mounts eagerly as before.
 */
function useNearViewport(enabled: boolean): {
  ref: RefObject<HTMLDivElement | null>;
  isNear: boolean;
} {
  const ref = useRef<HTMLDivElement | null>(null);
  const [isNear, setIsNear] = useState(false);

  useEffect(() => {
    if (!enabled || isNear) {
      return;
    }
    const element = ref.current;
    if (!element || typeof IntersectionObserver === 'undefined') {
      setIsNear(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setIsNear(true);
          observer.disconnect();
        }
      },
      { rootMargin: '200px' }
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [enabled, isNear]);

  return { ref, isNear: enabled ? isNear : true };
}

/**
 * True when `label` is just the URL itself — either identical text or the same
 * URL after canonicalization (e.g. a trailing-slash difference). Lets the URL
 * card avoid printing the URL twice when the title/alt text equals the URL.
 */
function labelIsUrl(label: string, url: string): boolean {
  if (!label || !url) {
    return false;
  }
  if (label === url) {
    return true;
  }
  const normalizedLabel = normalizeWebEmbedUrl(label);
  return normalizedLabel != null && normalizedLabel === normalizeWebEmbedUrl(url);
}

const metadataText = (
  metadata: DerivedPreviewResult['metadata'] | undefined,
  key: string
): string => {
  const value = metadata?.[key];
  return typeof value === 'string' ? value.trim() : '';
};

const hostFromUrl = (url: string): string => {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
};

const isDarkHexColor = (color: string): boolean => {
  const match = /^#([0-9a-f]{6})$/i.exec(color);
  if (!match) {
    return false;
  }
  const value = match[1];
  const red = Number.parseInt(value.slice(0, 2), 16);
  const green = Number.parseInt(value.slice(2, 4), 16);
  const blue = Number.parseInt(value.slice(4, 6), 16);
  return red * 0.299 + green * 0.587 + blue * 0.114 < 128;
};

function PreviewTextBlock({
  result,
  title,
  url,
  centered = false
}: {
  result?: DerivedPreviewResult | null;
  title?: string;
  url?: string;
  centered?: boolean;
}): JSX.Element {
  const trimmedUrl = (url ?? result?.sourceKey ?? '').trim();
  const metadataTitle = metadataText(result?.metadata, 'title');
  const provider = metadataText(result?.metadata, 'providerName');
  const hostname = metadataText(result?.metadata, 'hostname') || hostFromUrl(trimmedUrl);
  const trimmedTitle = (title ?? '').trim();
  const primaryText =
    trimmedTitle && !labelIsUrl(trimmedTitle, trimmedUrl)
      ? trimmedTitle
      : metadataTitle || hostname || trimmedUrl;
  const showHost = hostname && hostname !== primaryText;

  return (
    <div className={centered ? 'w-full max-w-canvas-mobile space-y-1 text-center' : 'space-y-1'}>
      {showHost || provider ? (
        <div className="truncate text-xs font-medium text-ink-muted">
          {provider || hostname}
        </div>
      ) : null}
      <div className="line-clamp-2 text-sm font-semibold text-ink-default">
        {primaryText}
      </div>
    </div>
  );
}

function HoverCardPreviewSurface({
  result,
  assetUrl,
  siteIconAssetUrl,
  title,
  url,
  className
}: {
  result?: DerivedPreviewResult | null;
  assetUrl?: string | null;
  siteIconAssetUrl?: string | null;
  title?: string;
  url?: string;
  className?: string;
}): JSX.Element {
  const metadata = result?.metadata;
  const trimmedUrl = (url ?? result?.sourceKey ?? '').trim();
  const hostname = metadataText(metadata, 'hostname') || hostFromUrl(trimmedUrl);
  const provider = metadataText(metadata, 'providerName') || hostname;
  const author = metadataText(metadata, 'authorName');
  const byline = author && author !== provider ? `${provider} · ${author}` : provider;
  const canonicalUrl = metadataText(metadata, 'canonicalUrl') || metadataText(metadata, 'url') || trimmedUrl;
  const metadataTitle = metadataText(metadata, 'title');
  const trimmedTitle = (title ?? '').trim();
  const primaryTitle =
    trimmedTitle && !labelIsUrl(trimmedTitle, trimmedUrl)
      ? trimmedTitle
      : metadataTitle || hostname || trimmedUrl;
  const description = metadataText(metadata, 'description');
  const showDescription = Boolean(description) && description !== primaryTitle;
  const themeColor = metadataText(metadata, 'themeColor');
  const bandStyle: CSSProperties | undefined = themeColor ? { backgroundColor: themeColor } : undefined;
  const bandClassName =
    siteIconAssetUrl && !assetUrl && !themeColor
      ? 'flex h-32 w-full items-center justify-center overflow-hidden border-b border-border-subtle bg-surface-raised-card'
      : 'flex h-32 w-full items-center justify-center overflow-hidden border-b border-border-subtle bg-surface-panel';
  const globeToneClass =
    themeColor && isDarkHexColor(themeColor) ? 'text-ink-inverse' : 'text-ink-muted';
  const showEyebrowIcon = Boolean(assetUrl && siteIconAssetUrl);

  return (
    <div className={className} data-derived-preview-state="hover-card">
      <div className="flex h-full w-full flex-col overflow-hidden bg-surface-floating">
        <div
          data-embed-pill-hover-media="true"
          className={bandClassName}
          style={bandStyle}
        >
          {assetUrl ? (
            <img
              src={assetUrl}
              alt=""
              className="block h-full w-full object-cover"
              loading="lazy"
              decoding="async"
              draggable={false}
            />
          ) : siteIconAssetUrl ? (
            <span className="flex h-16 w-16 items-center justify-center overflow-hidden rounded-xl border border-border-subtle bg-surface-canvas shadow-sm">
              <img
                src={siteIconAssetUrl}
                alt=""
                className="h-10 w-10 object-contain"
                loading="lazy"
                decoding="async"
                draggable={false}
              />
            </span>
          ) : (
            <Globe2 className={`h-8 w-8 ${globeToneClass}`} aria-hidden />
          )}
        </div>
        <div
          className="min-h-0 flex-1 space-y-1 rounded-b-lg border-t border-surface-glass-border bg-surface-canvas-web px-4 py-3"
          data-web-embed-metadata="true"
        >
          <div className="flex min-w-0 items-center gap-1.5 text-micro text-ink-subtle">
            {showEyebrowIcon ? (
              <img
                src={siteIconAssetUrl ?? undefined}
                alt=""
                className="h-3.5 w-3.5 shrink-0 rounded-sm object-contain"
                loading="lazy"
                decoding="async"
                draggable={false}
              />
            ) : null}
            <span className="truncate">{byline}</span>
          </div>
          <div className="line-clamp-2 text-caption font-medium text-ink-default">{primaryTitle}</div>
          {showDescription ? (
            <div className="line-clamp-2 text-micro text-ink-muted">{description}</div>
          ) : null}
          <div className="truncate text-micro text-ink-faint">{canonicalUrl}</div>
        </div>
      </div>
    </div>
  );
}

export function DerivedPreviewSurface({
  result,
  assetUrl,
  title,
  url,
  className,
  variant = 'default',
  siteIconAssetUrl,
  reserveBottomLeftBadgeSpace = false,
  onImageLoad,
  onImageError
}: DerivedPreviewSurfaceProps): JSX.Element {
  const label = title ?? result?.metadata?.title?.toString() ?? '';
  const hasAssetPreview = Boolean(result?.assetRelativePath && assetUrl);
  const wantsHtmlPreview = variant !== 'hover-card' && !hasAssetPreview && Boolean(result?.html);
  const { ref: htmlRef, isNear } = useNearViewport(wantsHtmlPreview);
  const trimmedUrl = (url ?? '').trim();

  if (variant === 'hover-card') {
    return (
      <HoverCardPreviewSurface
        result={result}
        assetUrl={assetUrl}
        siteIconAssetUrl={siteIconAssetUrl}
        title={title}
        url={url}
        className={className}
      />
    );
  }

  if (hasAssetPreview) {
    return (
      <div className={className} data-derived-preview-state="asset-card">
        <div className="relative h-full w-full overflow-hidden">
          <img
            src={assetUrl ?? undefined}
            alt={label || 'Preview'}
            className="block h-full w-full object-cover"
            loading="lazy"
            decoding="async"
            draggable={false}
            onLoad={onImageLoad}
            onError={onImageError}
          />
          <div
            className={`absolute inset-x-0 bottom-0 border-t border-border-subtle bg-surface-raised-card py-3 pr-5 ${reserveBottomLeftBadgeSpace ? 'pl-16' : 'pl-5'}`}
          >
            <PreviewTextBlock result={result} title={title} url={url} />
          </div>
        </div>
      </div>
    );
  }

  if (wantsHtmlPreview) {
    // Reuse the shared ScrollClippedIframe for the sandboxed oEmbed preview.
    // The nested remote iframe stays gated behind viewport visibility: `htmlRef`
    // is the IntersectionObserver target and `model` is null until it's near.
    return (
      <ScrollClippedIframe
        wrapperRef={htmlRef}
        model={
          isNear
            ? createRemoteOEmbedPreviewIframeModel({
                srcDoc: result!.html!,
                title: label || 'Embed preview'
              })
            : null
        }
        className={className}
        dataAttributes={{ 'data-derived-preview-state': 'oembed-html' }}
      />
    );
  }

  return (
    <div className={className} data-derived-preview-state="url-card">
      <div className="flex h-full w-full flex-col items-center justify-center gap-sm px-lg text-center">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-border-subtle bg-surface-raised-card text-ink-muted shadow-sm">
          <Globe2 className="h-5 w-5" aria-hidden />
        </div>
        <PreviewTextBlock result={result} title={title} url={trimmedUrl} centered />
      </div>
    </div>
  );
}
