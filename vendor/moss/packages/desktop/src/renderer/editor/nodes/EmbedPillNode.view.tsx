// ported-from: packages/desktop/src/renderer/editor/nodes/EmbedPillNode.tsx @ 762abb777
import { useCallback, useEffect, useRef, useState } from 'react';
import type { JSX, MouseEvent as ReactMouseEvent } from 'react';
import { IS_BOLD, IS_ITALIC, IS_STRIKETHROUGH, type NodeKey } from 'lexical';
import { Check, Link } from 'lucide-react';

import { InlinePill } from '../components';
import { useCurrentNoteId } from '../CurrentNoteIdContext';
import { toDisplaySrc } from '../utils/asset-url';
import { useWebEmbedPreview } from './web-embed/useWebEmbedPreview';
// moss-multi seam: converter-split (A§12; S-conv §2.3)
import { EmbedPillNode, deriveEmbedPillLabel } from './EmbedPillNode';
import { registerNodeView } from './node-views';
export { $createEmbedPillNode, $isEmbedPillNode, EmbedPillNode, deriveEmbedPillLabel, escapeEmbedPillDisplayText, unescapeEmbedPillDisplayText } from './EmbedPillNode';
export type { SerializedEmbedPillNode } from './EmbedPillNode';

function EmbedPillCopyButton({
  url,
  nodeKey,
  siteIconUrl
}: {
  url: string;
  nodeKey: NodeKey;
  siteIconUrl: string | null;
}): JSX.Element {
  const [copied, setCopied] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    },
    []
  );

  const handleCopy = useCallback(
    (event: ReactMouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        void navigator.clipboard.writeText(url).catch(() => undefined);
      }
      setCopied(true);
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
      timeoutRef.current = setTimeout(() => setCopied(false), 2000);
    },
    [url]
  );

  const actionLabel = copied ? 'Link copied' : 'Copy link';

  return (
    <button
      type="button"
      data-embed-pill-copy-node-key={nodeKey}
      onClick={handleCopy}
      aria-label={actionLabel}
      className="inline-flex h-4 w-4 items-center justify-center rounded text-ink-muted transition-colors hover:text-ink-default"
    >
      {copied ? (
        <Check className="h-3 w-3" aria-hidden />
      ) : siteIconUrl ? (
        <img
          src={siteIconUrl}
          alt=""
          className="h-3 w-3 rounded-[2px] object-contain"
          loading="lazy"
          decoding="async"
          draggable={false}
        />
      ) : (
        <Link className="h-3 w-3" aria-hidden />
      )}
    </button>
  );
}

function EmbedPillComponent({
  url,
  displayText,
  textFormat,
  nodeKey
}: {
  url: string;
  displayText: string;
  textFormat: number;
  nodeKey: NodeKey;
}): JSX.Element {
  const noteId = useCurrentNoteId();
  const { result } = useWebEmbedPreview({
    noteId,
    url,
    ensureOnMount: false
  });
  const metadata = result?.metadata as Record<string, unknown> | undefined;
  const siteIconAssetPath =
    typeof metadata?.siteIconAssetRelativePath === 'string'
      ? metadata.siteIconAssetRelativePath.trim()
      : '';
  const siteIconUrl = siteIconAssetPath && noteId ? toDisplaySrc(siteIconAssetPath, noteId) : null;
  const label = displayText.trim().length > 0 ? displayText : deriveEmbedPillLabel(url);
  const formatStyle = {
    ...(textFormat & IS_BOLD ? { fontWeight: 600 } : {}),
    ...(textFormat & IS_ITALIC ? { fontStyle: 'italic' as const } : {}),
    ...(textFormat & IS_STRIKETHROUGH ? { textDecorationLine: 'line-through' } : {})
  };

  return (
    <InlinePill
      variant="embed-pill"
      size="compact"
      iconElement={<EmbedPillCopyButton url={url} nodeKey={nodeKey} siteIconUrl={siteIconUrl} />}
      nodeKey={nodeKey}
      nodeKeyAttribute="data-embed-pill-node-key"
      dataAttributes={{ 'data-block-decorator-key': nodeKey }}
      contentAttributes={{ 'data-embed-pill-hover-node-key': nodeKey }}
      role="button"
      tabIndex={0}
      style={Object.keys(formatStyle).length > 0 ? formatStyle : undefined}
    >
      {label}
    </InlinePill>
  );
}

// moss-multi seam: node-views (A§12)
registerNodeView(EmbedPillNode.getType(), function decorate(this: EmbedPillNode): JSX.Element {
    return (
      <EmbedPillComponent
        url={this.__url}
        displayText={this.__displayText}
        textFormat={this.__textFormat}
        nodeKey={this.getKey()}
      />
    );
  });
