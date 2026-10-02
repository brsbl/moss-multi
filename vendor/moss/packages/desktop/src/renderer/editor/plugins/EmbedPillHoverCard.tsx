// ported-from: packages/desktop/src/renderer/editor/plugins/EmbedPillHoverCard.tsx @ 762abb777
/**
 * Read-only rich mini card shown when hovering a normal web embed pill.
 *
 * Layered "social card" layout (the shape Slack / Discord / Notion use for link
 * unfurls): a website-visual top band over a glass info panel that layers the
 * page metadata at descending hierarchy. The visual band falls back in order —
 * cached hero image → theme-colored placeholder carrying the cached site icon →
 * neutral globe — so the favicon and the globe never render at the same time
 * (no overlapping icons). The info panel uses every text field the extractor
 * already gathered: provider/author eyebrow, title, description, canonical URL.
 *
 * All imagery is a LOCAL cached asset (hero / site icon); the renderer never
 * remote-loads a favicon or OG image directly (SSRF/privacy guard).
 */
import type { CSSProperties, JSX } from 'react';
import { Globe } from 'lucide-react';

import { HoverCard } from '../typeahead';
import { toDisplaySrc } from '../utils/asset-url';
import { useWebEmbedPreview } from '../nodes/web-embed/useWebEmbedPreview';

export interface EmbedPillHoverCardProps {
  noteId: string | null;
  url: string;
  displayText: string;
  position: { x: number; y: number; anchorHeight?: number };
}

const metadataText = (metadata: Record<string, unknown> | undefined, key: string): string => {
  const value = metadata?.[key];
  return typeof value === 'string' ? value.trim() : '';
};

const deriveHostname = (url: string): string => {
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

export function EmbedPillHoverCard({
  noteId,
  url,
  displayText,
  position
}: EmbedPillHoverCardProps): JSX.Element {
  const { result } = useWebEmbedPreview({ noteId, url });
  const metadata = result?.metadata as Record<string, unknown> | undefined;

  const hostname = metadataText(metadata, 'hostname') || deriveHostname(url);
  const provider = metadataText(metadata, 'providerName') || hostname;
  const author = metadataText(metadata, 'authorName');
  // Eyebrow byline stays low-hierarchy: provider, then author only when it adds
  // information beyond the provider name.
  const byline = author && author !== provider ? `${provider} · ${author}` : provider;
  const canonicalUrl = metadataText(metadata, 'canonicalUrl') || metadataText(metadata, 'url') || url;
  const title = metadataText(metadata, 'title') || displayText.trim() || hostname;
  const description = metadataText(metadata, 'description');
  const showDescription = Boolean(description) && description !== title;

  const heroAssetUrl = result?.assetRelativePath
    ? toDisplaySrc(result.assetRelativePath, noteId)
    : null;
  const siteIconAssetPath = metadataText(metadata, 'siteIconAssetRelativePath');
  const siteIconAssetUrl = siteIconAssetPath ? toDisplaySrc(siteIconAssetPath, noteId) : null;

  const themeColor = metadataText(metadata, 'themeColor');
  const bandStyle: CSSProperties | undefined = themeColor
    ? { backgroundColor: themeColor }
    : undefined;
  const bandClassName =
    siteIconAssetUrl && !heroAssetUrl && !themeColor
      ? 'flex h-32 w-full items-center justify-center overflow-hidden border-b border-border-subtle bg-surface-raised-card'
      : 'flex h-32 w-full items-center justify-center overflow-hidden border-b border-border-subtle bg-surface-panel';
  const globeToneClass =
    themeColor && isDarkHexColor(themeColor) ? 'text-ink-inverse' : 'text-ink-muted';
  // The site icon is the band centerpiece when there is no hero, so it only
  // doubles as a small eyebrow site-icon when a hero already fills the band.
  const showEyebrowIcon = Boolean(heroAssetUrl && siteIconAssetUrl);

  return (
    <HoverCard isVisible position={position}>
      <div data-embed-pill-hover-card="true" className="w-80 overflow-hidden rounded-lg">
        <div
          data-embed-pill-hover-media="true"
          className={bandClassName}
          style={bandStyle}
        >
          {heroAssetUrl ? (
            <img
              src={heroAssetUrl}
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
            <Globe className={`h-8 w-8 ${globeToneClass}`} aria-hidden />
          )}
        </div>
        <div className="space-y-1 border-t border-surface-glass-border bg-surface-glass px-4 py-3 backdrop-blur-sm">
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
          <div className="line-clamp-2 text-caption font-medium text-ink-default">{title}</div>
          {showDescription ? (
            <div className="line-clamp-2 text-micro text-ink-muted">{description}</div>
          ) : null}
          <div className="truncate text-micro text-ink-faint">{canonicalUrl}</div>
        </div>
      </div>
    </HoverCard>
  );
}

export default EmbedPillHoverCard;
