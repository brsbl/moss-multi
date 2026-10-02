// ported-from: packages/desktop/src/renderer/editor/nodes/WebEmbedNode.tsx @ 762abb777
import React, { useCallback, useMemo, useRef } from 'react';
import type { JSX } from 'react';
import { type NodeKey } from 'lexical';
import { useLexicalNodeSelection } from '@lexical/react/useLexicalNodeSelection';
import { useSetAtom } from 'jotai';
import { Maximize2 } from 'lucide-react';
import { openWebEmbedAtom } from '@moss/shared';

import { useCurrentNoteId } from '../CurrentNoteIdContext';
import {
  MediaHeaderButton,
  MediaNodeHeader,
  useIsEditorEditable,
  useIsNearViewport,
  useMediaNodeActions
} from '../components/media-primitives';
import { isSafeWebBrowserUrl, isTwitterStatusUrl } from '../../../common/web-embed-url';
import { toDisplaySrc } from '../utils/asset-url';
import { DerivedPreviewSurface } from '../preview/DerivedPreviewSurface';
import { SharedPreviewFrame } from '../preview/SharedPreviewFrame';
import { useWebEmbedPreview } from './web-embed/useWebEmbedPreview';
import { TweetEmbedCard } from './web-embed/TweetEmbedCard';
// moss-multi seam: converter-split (A§12; S-conv §2.3)
import { WebEmbedNode } from './WebEmbedNode';
import { registerNodeView } from './node-views';
export { $createWebEmbedNode, $isWebEmbedNode, WebEmbedNode } from './WebEmbedNode';
export type { SerializedWebEmbedNode } from './WebEmbedNode';

const deriveHostname = (url: string): string => {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
};

const WEBPAGE_EMBED_FRAME_SIZE = { width: 360, height: 260 } as const;

/**
 * WebEmbedNode is the visual block web-embed surface for markdown image syntax.
 *
 * Tweet status URLs keep the dedicated Twitter/X card path. Other browser-safe
 * webpage URLs render the shared preview/fallback URL card and expose the same
 * in-app browser opener as compact inline pills.
 *
 * Bare URLs still import as inline `EmbedPillNode`s; named Markdown links stay
 * regular text links. This node exists for `![Title](url)` visual intent.
 */
function WebEmbedComponent({
  url,
  altText,
  nodeKey,
  commentIds: _commentIds = []
}: {
  url: string;
  altText: string;
  nodeKey: NodeKey;
  commentIds?: string[];
}): JSX.Element {
  const noteId = useCurrentNoteId();
  const [isSelected, setSelected, clearSelection] = useLexicalNodeSelection(nodeKey);
  const { handleDelete, handleGapClick } = useMediaNodeActions(nodeKey);
  const openWebEmbed = useSetAtom(openWebEmbedAtom);
  const isTweetEmbed = isTwitterStatusUrl(url);

  // Read-only renders (agent / comment / preview panes) withhold mutating
  // controls + gap cursors; `TweetEmbedCard` re-guards on `editable`.
  const editable = useIsEditorEditable();

  const cardHostRef = useRef<HTMLDivElement | null>(null);

  // Gate preview ensure behind visibility: a note full of embeds must not start
  // preview fetches for every mounted-but-off-screen card just because the note
  // opened. Visible / near-visible cards (generous 600px rootMargin) still
  // preview automatically.
  const isNearViewport = useIsNearViewport(cardHostRef);

  // Cached preview, exact-key subscription only. Tweet cards use resolved oEmbed
  // height; generic webpage cards use cached preview/fallback metadata.
  const { result } = useWebEmbedPreview({ noteId, url, enabled: isNearViewport });

  const hostname = useMemo(() => deriveHostname(url), [url]);
  const metaTitle =
    result?.metadata?.title != null ? String(result.metadata.title) : '';
  const title = altText || metaTitle || hostname;
  const assetUrl =
    result?.assetRelativePath && noteId
      ? toDisplaySrc(result.assetRelativePath, noteId)
      : null;
  const siteIconAssetPath =
    typeof result?.metadata?.siteIconAssetRelativePath === 'string'
      ? result.metadata.siteIconAssetRelativePath.trim()
      : '';
  const siteIconAssetUrl =
    siteIconAssetPath && noteId
      ? toDisplaySrc(siteIconAssetPath, noteId)
      : null;

  const handleOpenInBrowser = useCallback(() => {
    if (!isSafeWebBrowserUrl(url)) {
      return;
    }
    openWebEmbed({ url, title, sourceNoteId: noteId });
  }, [noteId, openWebEmbed, title, url]);

  const handleContainerClick = useCallback(
    (e: React.MouseEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest('button') || target.closest('iframe') || target.closest('a')) {
        return;
      }
      e.preventDefault();
      clearSelection();
      setSelected(true);
    },
    [clearSelection, setSelected]
  );

  if (isTweetEmbed) {
    return (
      <TweetEmbedCard
        nodeKey={nodeKey}
        url={url}
        noteId={noteId}
        result={result ?? null}
        isSelected={isSelected}
        editable={editable}
        onDelete={handleDelete}
        onGapClick={handleGapClick}
        onOpenInBrowser={handleOpenInBrowser}
        onContainerClick={handleContainerClick}
        hostRef={cardHostRef}
      />
    );
  }

  return (
    <SharedPreviewFrame
      nodeKey={nodeKey}
      selected={isSelected}
      frameSize={WEBPAGE_EMBED_FRAME_SIZE}
      beforeLabel="Insert paragraph before embed"
      afterLabel="Insert paragraph after embed"
      onGapClick={editable ? handleGapClick : undefined}
      hostRef={cardHostRef}
      rootClassName="my-4"
      shellClassName="mr-auto"
      rootDataAttributes={{
        'data-web-embed-node': 'true',
        'data-web-embed-kind': 'webpage'
      }}
      onRootClick={handleContainerClick}
      viewportClassName="relative h-full overflow-hidden rounded-lg bg-ink-inverse"
      viewportDataAttributes={{ 'data-web-embed-viewport': 'true' }}
      headerActions={
        <MediaNodeHeader
          nodeKey={nodeKey}
          onDelete={handleDelete}
          editable={editable}
        >
          <MediaHeaderButton
            icon={Maximize2}
            title="Open in browser"
            onClick={handleOpenInBrowser}
          />
        </MediaNodeHeader>
      }
      staticLayer={
        <DerivedPreviewSurface
          result={result ?? null}
          assetUrl={assetUrl}
          siteIconAssetUrl={siteIconAssetUrl}
          title={title}
          url={url}
          variant="hover-card"
          className="absolute inset-0 block h-full w-full border-0 bg-surface-floating"
        />
      }
    />
  );
}

// moss-multi seam: node-views (A§12)
registerNodeView(WebEmbedNode.getType(), function decorate(this: WebEmbedNode): JSX.Element {
    return (
      <WebEmbedComponent
        url={this.__url}
        altText={this.__altText}
        nodeKey={this.__key}
        commentIds={this.__commentIds}
      />
    );
  });
