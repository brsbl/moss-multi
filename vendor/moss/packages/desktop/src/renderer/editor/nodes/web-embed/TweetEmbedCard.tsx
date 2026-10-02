// ported-from: packages/desktop/src/renderer/editor/nodes/web-embed/TweetEmbedCard.tsx @ 762abb777
/**
 * Twitter/X exception to the compact-pill default.
 *
 * Tweets are a standard web embed surface, so the render path loads Twitter/X's
 * official embed iframe for the status ID. Moss only contributes the existing
 * media-node chrome around that provider-owned frame (selection, comments,
 * click-to-open lightbox, trash). There is no `[Live]` badge and no hand-built tweet
 * clone.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, JSX, Ref } from 'react';
import type { NodeKey } from 'lexical';
import { CircleAlert } from 'lucide-react';

import type { DerivedPreviewResult } from '../../../../common/derived-preview';
import {
  BlockNodeShell,
  MediaNodeHeader
} from '../../components/media-primitives';
import { IframeFrame } from '../../iframe/IframeFrame';
import { createRemoteSocialEmbedIframeModel } from '../../iframe/iframe-model';
import { parseTweetUrlParts } from './tweet-preview';
import xLogoBlackUrl from '../../../assets/x-logo-black.png';

export interface TweetEmbedCardProps {
  nodeKey: NodeKey;
  url: string;
  noteId: string | null;
  result: DerivedPreviewResult | null;
  isSelected: boolean;
  /** False in read-only renders — withholds mutating controls + gap cursors. */
  editable: boolean;
  onDelete: () => void;
  onGapClick: (position: 'before' | 'after') => (e: React.MouseEvent) => void;
  onOpenInBrowser: () => void;
  onContainerClick: (e: React.MouseEvent) => void;
  hostRef: Ref<HTMLDivElement>;
}

const TWEET_EMBED_SCALE = 1;
const TWEET_EMBED_FALLBACK_HEIGHT = 280;
const UNAVAILABLE_TWEET_COPY =
  "This post isn't available. It may have been deleted or the link may be incorrect.";

const metadataNumber = (
  metadata: DerivedPreviewResult['metadata'] | undefined,
  key: string
): number | null => {
  const value = metadata?.[key];
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
};

const getTwitterEmbedUrl = (statusId: string): string => {
  const params = new URLSearchParams({
    dnt: 'true',
    id: statusId,
    theme: 'light'
  });
  return `https://platform.twitter.com/embed/Tweet.html?${params.toString()}`;
};

const getTwitterEmbedResizeHeight = (data: unknown, statusId: string): number | null => {
  if (!data || typeof data !== 'object') {
    return null;
  }
  const message = data as {
    'twttr.embed'?: {
      method?: unknown;
      params?: unknown;
    };
  };
  const embed = message['twttr.embed'];
  if (!embed || embed.method !== 'twttr.private.resize' || !Array.isArray(embed.params)) {
    return null;
  }
  const [payload] = embed.params as Array<{
    height?: unknown;
    data?: { tweet_id?: unknown };
  }>;
  if (
    !payload ||
    payload.data?.tweet_id !== statusId ||
    typeof payload.height !== 'number' ||
    !Number.isFinite(payload.height) ||
    payload.height <= 0
  ) {
    return null;
  }
  return Math.ceil(payload.height);
};

function TwitterOEmbedFrame({
  statusId,
  title,
  preferredHeight
}: {
  statusId: string;
  title: string;
  preferredHeight: number | null;
}): JSX.Element {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [measuredHeight, setMeasuredHeight] = useState<number | null>(preferredHeight);
  const model = useMemo(
    () =>
      createRemoteSocialEmbedIframeModel({
        src: getTwitterEmbedUrl(statusId),
        title
      }),
    [statusId, title]
  );

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (event.source !== iframeRef.current?.contentWindow) {
        return;
      }
      if (event.origin !== 'https://platform.twitter.com') {
        return;
      }
      const height = getTwitterEmbedResizeHeight(event.data, statusId);
      if (!height) {
        return;
      }
      setMeasuredHeight(height);
    };

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [statusId]);

  const unscaledHeight = measuredHeight ?? TWEET_EMBED_FALLBACK_HEIGHT;
  const wrapperStyle: CSSProperties = {
    height: `${Math.ceil(unscaledHeight * TWEET_EMBED_SCALE)}px`,
    overflow: 'hidden',
    width: '100%'
  };
  const iframeStyle: CSSProperties = {
    display: 'block',
    height: `${unscaledHeight}px`,
    overflow: 'hidden',
    transform: `scale(${TWEET_EMBED_SCALE})`,
    transformOrigin: '0 0',
    width: `${100 / TWEET_EMBED_SCALE}%`
  };

  return (
    <div
      data-tweet-oembed-frame="true"
      data-tweet-oembed-scale={String(TWEET_EMBED_SCALE)}
      style={wrapperStyle}
    >
      <IframeFrame
        ref={iframeRef}
        model={model}
        className="block w-full border-0"
        style={iframeStyle}
        scrolling="no"
      />
    </div>
  );
}

function TweetFallback({ url }: { url: string }): JSX.Element {
  const { handle, statusId } = parseTweetUrlParts(url);
  const handleLabel = handle ? `@${handle}` : null;
  const sourceLabel = url.replace(/^https?:\/\//, '');

  return (
    <div
      className="rounded-xl border border-border-subtle bg-surface-raised-card px-4 py-3 text-caption text-ink-muted"
      data-tweet-oembed-fallback="true"
    >
      Tweet embed preview unavailable.
      <div className="mt-1 space-y-0.5">
        {handleLabel ? (
          <div className="font-medium text-ink-default">{handleLabel}</div>
        ) : null}
        <div className="truncate">{statusId ? sourceLabel : url}</div>
      </div>
    </div>
  );
}

function TweetUnavailable(): JSX.Element {
  return (
    <div
      className="relative flex min-h-40 flex-col items-center justify-center gap-3 rounded-xl border border-border-subtle bg-surface-raised-card px-6 py-8 text-center text-caption text-ink-muted"
      data-tweet-oembed-unavailable="true"
    >
      <img
        src={xLogoBlackUrl}
        alt=""
        className="absolute right-5 top-5 h-5 w-5 object-contain"
        data-tweet-unavailable-x-logo="true"
        aria-hidden
        decoding="async"
        draggable={false}
      />
      <CircleAlert className="h-6 w-6 text-ink-faint" aria-hidden />
      <p className="max-w-xs">{UNAVAILABLE_TWEET_COPY}</p>
    </div>
  );
}

export function TweetEmbedCard({
  nodeKey,
  url,
  result,
  isSelected,
  editable,
  onDelete,
  onGapClick,
  onOpenInBrowser,
  onContainerClick,
  hostRef
}: TweetEmbedCardProps): JSX.Element {
  const sourceLabel = url.replace(/^https?:\/\//, '');
  const { statusId } = parseTweetUrlParts(url);
  const tweetStatusId = statusId ?? '';
  const preferredHeight = metadataNumber(result?.metadata, 'height');
  const isUnavailable = result?.status === 'failed';
  const canRenderWidget = tweetStatusId.length > 0 && !isUnavailable;

  return (
    <div
      className="group/decorator relative my-6"
      data-block-decorator-key={nodeKey}
      data-web-embed-node="true"
      data-tweet-embed-card="true"
      data-tweet-embed-state={isUnavailable ? 'unavailable' : canRenderWidget ? 'widget' : 'fallback'}
      onClick={onContainerClick}
    >
      <div ref={hostRef} className="mx-auto w-full max-w-canvas-prose">
        <BlockNodeShell
          selected={isSelected}
          beforeLabel="Insert paragraph before tweet"
          afterLabel="Insert paragraph after tweet"
          onGapClick={editable ? onGapClick : undefined}
          className="mr-auto w-full max-w-tweet-embed"
        >
          <div
            className="relative"
            data-tweet-embed-shell="oembed"
          >
            <MediaNodeHeader nodeKey={nodeKey} onDelete={onDelete} editable={editable} />
            {isUnavailable ? (
              <TweetUnavailable />
            ) : canRenderWidget ? (
              <TwitterOEmbedFrame
                statusId={tweetStatusId}
                title={`Tweet embed: ${sourceLabel}`}
                preferredHeight={preferredHeight}
              />
            ) : (
              <TweetFallback url={url} />
            )}
            <button
              type="button"
              aria-label="Open tweet"
              className="absolute inset-0 z-10 cursor-pointer bg-surface-transparent"
              data-tweet-open-overlay="true"
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onOpenInBrowser();
              }}
            />
          </div>
        </BlockNodeShell>
      </div>
    </div>
  );
}

export default TweetEmbedCard;
