// ported-from: packages/desktop/src/renderer/editor/nodes/VideoNode.tsx @ 762abb777
import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { JSX } from 'react';
import { type NodeKey } from 'lexical';
import { useLexicalNodeSelection } from '@lexical/react/useLexicalNodeSelection';
import { Play, RefreshCw } from 'lucide-react';

import { useCurrentNoteId } from '../CurrentNoteIdContext';
import {
  BLOCK_SURFACE_CLASSNAME,
  BlockNodeShell,
  MediaNodeHeader,
  useMediaNodeActions
} from '../components/media-primitives';
import { toDisplaySrc } from '../utils/asset-url';
import {
  buildMediaServerUrl,
  onMediaServerReady,
  refreshMediaServerInfo
} from '../utils/media-server-url';
import { computeContentHash } from '../../../common/content-hash';
import { videoThumbnailApi } from '../../api/electron';
import { IframeFrame } from '../iframe/IframeFrame';
import { createRemoteVideoIframeModel } from '../iframe/iframe-model';
import {
  extractYouTubeVideoId,
  buildYouTubeThumbnailUrl,
  buildYouTubeThumbnailUrls,
  buildYouTubeEmbedUrl
} from '../utils/video-url';
// moss-multi seam: converter-split (A§12; S-conv §2.3)
import { VideoNode } from './VideoNode';
import { registerNodeView } from './node-views';
export { $createVideoNode, $isVideoNode, VideoNode } from './VideoNode';
export type { SerializedVideoNode } from './VideoNode';

function VideoComponent({
  src,
  altText,
  nodeKey,
  commentIds: _commentIds = []
}: {
  src: string;
  altText: string;
  nodeKey: NodeKey;
  commentIds?: string[];
}): JSX.Element {
  const noteId = useCurrentNoteId();
  const [isSelected, setSelected, clearSelection] = useLexicalNodeSelection(nodeKey);
  const { handleDelete, handleGapClick } = useMediaNodeActions(nodeKey);
  const [hasError, setHasError] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isPlayerReady, setIsPlayerReady] = useState(false);
  const [thumbLoaded, setThumbLoaded] = useState(false);
  const [thumbMissing, setThumbMissing] = useState(false);
  const [thumbVersion, setThumbVersion] = useState(0);
  const [videoVersion, setVideoVersion] = useState(0);
  const [useAssetFallback, setUseAssetFallback] = useState(false);
  const videoRetryCountRef = useRef(0);
  const videoRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearVideoRetryTimer = useCallback(() => {
    if (videoRetryTimerRef.current !== null) {
      clearTimeout(videoRetryTimerRef.current);
      videoRetryTimerRef.current = null;
    }
  }, []);

  // Re-render once the loopback media server reports in, so mounted videos
  // upgrade from the (seek-limited) moss-asset fallback to real HTTP.
  const [, setMediaServerTick] = useState(0);
  useEffect(
    () =>
      onMediaServerReady(() => {
        setMediaServerTick((t) => t + 1);
      }),
    []
  );

  const videoId = extractYouTubeVideoId(src);
  const isYouTube = videoId !== null;
  const assetSrc = isYouTube ? null : toDisplaySrc(src, noteId);
  // Local videos need real HTTP range support for seeking / moov-at-end MP4s;
  // moss-asset:// remains the fallback while the server is unavailable.
  const mediaServerSrc =
    isYouTube || src.startsWith('data:') || /^https?:\/\//i.test(src)
      ? null
      : buildMediaServerUrl(src, noteId);
  const displaySrc =
    isYouTube || useAssetFallback ? assetSrc : mediaServerSrc ?? assetSrc;
  const thumbPath = `assets/video-thumb-${computeContentHash(src)}.png`;
  const thumbBaseSrc = isYouTube ? null : toDisplaySrc(thumbPath, noteId);
  // moss-multi seam: web-assets (A§16): thumbnails are derived by moss desktop only; never request Electron's protocol.
  const thumbSrc = thumbBaseSrc && !thumbBaseSrc.startsWith('moss-asset:')
    ? `${thumbBaseSrc}${thumbBaseSrc.includes('?') ? '&' : '?'}v=${thumbVersion}`
    : null;

  useEffect(() => {
    clearVideoRetryTimer();
    setThumbLoaded(false);
    setThumbMissing(false);
    setThumbVersion(0);
    setHasError(false);
    setVideoVersion(0);
    setUseAssetFallback(false);
    videoRetryCountRef.current = 0;
  }, [clearVideoRetryTimer, src, noteId]);

  useEffect(() => () => clearVideoRetryTimer(), [clearVideoRetryTimer]);

  // Media errors are often transient in dev (main-process restarts abort
  // in-flight moss-asset:// requests) — retry with backoff before declaring
  // the video unavailable, and let the fallback be clicked to try again.
  const handleVideoError = useCallback(() => {
    clearVideoRetryTimer();
    if (mediaServerSrc && displaySrc === mediaServerSrc && !useAssetFallback) {
      setUseAssetFallback(true);
      setVideoVersion((current) => current + 1);
      refreshMediaServerInfo();
      return;
    }
    if (videoRetryCountRef.current < 2) {
      const attempt = ++videoRetryCountRef.current;
      videoRetryTimerRef.current = setTimeout(() => {
        videoRetryTimerRef.current = null;
        setVideoVersion((current) => current + 1);
      }, 400 * attempt);
      return;
    }
    setHasError(true);
  }, [clearVideoRetryTimer, displaySrc, mediaServerSrc, useAssetFallback]);

  const handleRetryAfterError = useCallback(() => {
    clearVideoRetryTimer();
    videoRetryCountRef.current = 0;
    setHasError(false);
    setUseAssetFallback(false);
    setVideoVersion((current) => current + 1);
    refreshMediaServerInfo();
  }, [clearVideoRetryTimer]);

  useEffect(() => {
    if (!noteId || isYouTube || !thumbPath) {
      return undefined;
    }

    return videoThumbnailApi.onMaterialized(noteId, thumbPath, () => {
      setThumbLoaded(false);
      setThumbVersion((current) => current + 1);
      setThumbMissing(false);
    });
  }, [isYouTube, noteId, thumbPath]);

  const handleThumbnailError = useCallback(() => {
    setThumbMissing(true);
  }, []);

  const handleThumbnailLoad = useCallback(() => {
    setThumbLoaded(true);
  }, []);

  // Selection drives playing state — deselecting stops the player and returns
  // to the thumbnail so media doesn't keep running while the user scrolls away.
  useEffect(() => {
    if (!isSelected) {
      setIsPlaying(false);
      setIsPlayerReady(false);
    }
  }, [isSelected]);

  const handleContainerClick = useCallback(
    (e: React.MouseEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest('button') || target.closest('video') || target.closest('iframe')) {
        return;
      }

      e.preventDefault();
      clearSelection();
      setSelected(true);
    },
    [clearSelection, setSelected]
  );

  const handlePlay = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      clearSelection();
      setSelected(true);
      setIsPlaying(true);
    },
    [clearSelection, setSelected]
  );


  // Error fallback — retryable and removable: a missing asset must not leave
  // an undeletable block in the note.
  if (hasError) {
    const label = isYouTube ? src : src.split('/').pop() ?? src;
    return (
      <div
        className="group/decorator relative my-6 w-full"
        data-block-decorator-key={nodeKey}
        onClick={handleContainerClick}
      >
        <BlockNodeShell
          selected={isSelected}
          beforeLabel="Insert paragraph before video"
          afterLabel="Insert paragraph after video"
          onGapClick={handleGapClick}
          className="mx-auto w-full max-w-canvas-prose"
        >
          <div className={BLOCK_SURFACE_CLASSNAME}>
            <MediaNodeHeader nodeKey={nodeKey} onDelete={handleDelete} />
            <div
              className="flex aspect-video items-center justify-center bg-surface-canvas px-6 py-8"
              data-video-error-state="true"
            >
              <div className="flex flex-col items-center gap-3 text-center">
                <div className="space-y-1">
                  <p className="text-sm font-semibold text-ink-default">Video file not found</p>
                  <p className="max-w-md break-words text-xs text-ink-muted">
                    {`“${label}” may have been moved, renamed, or deleted. Restore it to its original location, then retry.`}
                  </p>
                </div>
                <button
                  type="button"
                  aria-label="Retry video"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleRetryAfterError();
                  }}
                  className="inline-flex h-8 items-center gap-2 rounded-full border border-surface-glass-border bg-surface-raised-card px-3 text-xs font-medium text-ink-default transition-colors hover:bg-surface-canvas"
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                  Retry
                </button>
              </div>
            </div>
          </div>
        </BlockNodeShell>
      </div>
    );
  }

  return (
    <div
      className="group/decorator relative my-6 w-full"
      data-block-decorator-key={nodeKey}
      data-video-node-kind={isYouTube ? 'youtube' : 'local'}
      onClick={handleContainerClick}
    >
      <BlockNodeShell
        selected={isSelected}
        beforeLabel="Insert paragraph before video"
        afterLabel="Insert paragraph after video"
        onGapClick={handleGapClick}
        className={`mx-auto w-full max-w-canvas-prose ${
          !isPlaying ? 'cursor-pointer' : ''
        }`}
      >
        <div className={BLOCK_SURFACE_CLASSNAME}>
          <MediaNodeHeader
            nodeKey={nodeKey}
            onDelete={handleDelete}
          />

          {/* Thumbnail — stays mounted until player is ready */}
          <div
            className={isPlaying && isPlayerReady ? 'hidden' : undefined}
            onClick={!isPlaying ? handlePlay : undefined}
          >
            {isYouTube ? (
              <img
                src={buildYouTubeThumbnailUrl(videoId!)}
                alt={altText || 'YouTube video thumbnail'}
                className="block aspect-video w-full object-cover"
                loading="lazy"
                decoding="async"
                onError={(e) => {
                  const img = e.currentTarget;
                  const thumbnailUrls = buildYouTubeThumbnailUrls(videoId!);
                  const currentIndex = thumbnailUrls.indexOf(img.src);
                  const fallback = thumbnailUrls[currentIndex + 1];

                  if (!fallback) {
                    setHasError(true);
                    return;
                  }

                  img.src = fallback;
                }}
                draggable={false}
              />
            ) : thumbSrc && !thumbMissing ? (
              <img
                src={thumbSrc}
                alt={altText || 'Video thumbnail'}
                className={`block aspect-video w-full object-contain ${thumbLoaded ? 'bg-ink-default' : 'bg-ink-default/5'}`}
                loading="lazy"
                decoding="async"
                onLoad={handleThumbnailLoad}
                onError={handleThumbnailError}
                draggable={false}
              />
            ) : (
              <div
                className="aspect-video w-full bg-ink-default/5"
                data-video-thumbnail-state="fallback"
              />
            )}
            {!isPlaying && (
              <div
                className="pointer-events-none absolute inset-0 flex items-center justify-center"
                data-video-play-overlay="true"
              >
                <div className="flex h-14 w-14 items-center justify-center rounded-full bg-ink-default/60 text-ink-inverse shadow-lg transition-transform group-hover/decorator:scale-110">
                  <Play className="ml-1 h-7 w-7" fill="currentColor" />
                </div>
              </div>
            )}
          </div>

          {/* Player — mounts when playing, hidden until ready to prevent layout shift */}
          {isPlaying && (
            <div className={isPlayerReady ? undefined : 'invisible absolute inset-0'}>
              {isYouTube ? (
                <div className="aspect-video w-full bg-ink-default">
                  <IframeFrame
                    model={createRemoteVideoIframeModel({
                      src: buildYouTubeEmbedUrl(videoId!),
                      title: altText || 'YouTube video'
                    })}
                    className="h-full w-full border-0"
                    onLoad={() => setIsPlayerReady(true)}
                  />
                </div>
              ) : displaySrc ? (
                <video
                  key={videoVersion}
                  src={
                    videoVersion > 0
                      ? `${displaySrc}${displaySrc.includes('?') ? '&' : '?'}v=${videoVersion}`
                      : displaySrc
                  }
                  controls
                  autoPlay
                  className="mx-auto block aspect-video w-full bg-ink-default object-contain"
                  onCanPlay={() => setIsPlayerReady(true)}
                  onError={handleVideoError}
                />
              ) : null}
            </div>
          )}
        </div>
      </BlockNodeShell>
    </div>
  );
}

// moss-multi seam: node-views (A§12)
registerNodeView(VideoNode.getType(), function decorate(this: VideoNode): JSX.Element {
    return (
      <VideoComponent
        src={this.__src}
        altText={this.__altText}
        nodeKey={this.__key}
        commentIds={this.__commentIds}
      />
    );
  });
