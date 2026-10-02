// ported-from: packages/desktop/src/renderer/editor/nodes/EmbedPillNode.tsx @ 762abb777
import { useCallback, useEffect, useRef, useState } from 'react';
import type { JSX, MouseEvent as ReactMouseEvent } from 'react';
import {
  $applyNodeReplacement,
  DecoratorNode,
  IS_BOLD,
  IS_ITALIC,
  IS_STRIKETHROUGH,
  type DOMConversionMap,
  type DOMConversionOutput,
  type DOMExportOutput,
  type EditorConfig,
  type LexicalNode,
  type NodeKey,
  type SerializedLexicalNode,
  type Spread
} from 'lexical';
import { Check, Link } from 'lucide-react';

import { InlinePill } from '../components';
import { useCurrentNoteId } from '../CurrentNoteIdContext';
import { initCommentIds, cloneCommentIds, exportCommentIds, importCommentIds } from '../utils/commentable-node';
import { isBrowserLoopbackHostname, isSafeWebBrowserUrl } from '../../../common/web-embed-url';
import { toDisplaySrc } from '../utils/asset-url';
import { useWebEmbedPreview } from './web-embed/useWebEmbedPreview';

/**
 * Compact webpage embed pill.
 *
 * It is a standard inline `DecoratorNode` (like `FormulaNode` / `FileLinkNode`):
 * `isInline()` and `isIsolated()` are `true`, so it is NOT in the
 * `DecoratorBlockPlugin` allowlist. The left link icon is a self-contained copy
 * button. Hover (mini card) and pill-body click (open the web embed browser
 * surface) are handled by `EmbedPillPlugin` via event delegation.
 *
 * Persisted markdown is the source URL plus optional text emphasis. No preview
 * state, hover content, or metadata is serialized.
 */
export type SerializedEmbedPillNode = Spread<
  {
    url: string;
    displayText?: string;
    textFormat?: number;
    commentIds?: string[];
  },
  SerializedLexicalNode
>;

const decodePathSegment = (segment: string): string => {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
};

const MAX_EMBED_PILL_LABEL_LENGTH = 72;

const truncateEmbedPillLabel = (host: string, segments: string[]): string => {
  const fullLabel = `${host}/${segments.join('/')}`;
  if (fullLabel.length <= MAX_EMBED_PILL_LABEL_LENGTH) {
    return fullLabel;
  }

  let label = host;
  for (const segment of segments) {
    const nextLabel = `${label}/${segment}`;
    if (`${nextLabel}/...`.length > MAX_EMBED_PILL_LABEL_LENGTH) {
      break;
    }
    label = nextLabel;
  }

  if (label !== host) {
    return `${label}/...`;
  }

  return `${fullLabel.slice(0, MAX_EMBED_PILL_LABEL_LENGTH - 3)}...`;
};

export const deriveEmbedPillLabel = (url: string): string => {
  try {
    const parsed = new URL(url);
    const host = isBrowserLoopbackHostname(parsed.hostname)
      ? parsed.host
      : parsed.host.replace(/^www\./, '');
    const segments = parsed.pathname
      .split('/')
      .map((segment) => segment.trim())
      .filter(Boolean);
    if (segments.length === 0) {
      return host;
    }
    return truncateEmbedPillLabel(host, segments.map(decodePathSegment));
  } catch {
    return url;
  }
};

/** Escape display text for the legacy `?[text](url)` markdown form. */
export const escapeEmbedPillDisplayText = (text: string): string =>
  text.replace(/\\/g, '\\\\').replace(/\]/g, '\\]');

/** Reverse of {@link escapeEmbedPillDisplayText}: unescape `\\` and `\]`. */
export const unescapeEmbedPillDisplayText = (text: string): string =>
  text.replace(/\\([\\\]])/g, '$1');

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

function $convertEmbedPillElement(domNode: HTMLElement): DOMConversionOutput | null {
  const url = domNode.getAttribute('data-embed-pill-url');
  const displayText = domNode.getAttribute('data-embed-pill-text') ?? '';
  const textFormat = Number.parseInt(domNode.getAttribute('data-embed-pill-text-format') ?? '0', 10);
  if (url && isSafeWebBrowserUrl(url)) {
    return {
      node: $createEmbedPillNode(
        url,
        displayText,
        [],
        Number.isFinite(textFormat) ? textFormat : 0
      )
    };
  }
  return null;
}

export class EmbedPillNode extends DecoratorNode<JSX.Element> {
  __url: string;
  __displayText: string;
  __textFormat: number;
  __commentIds: string[];

  static getType(): string {
    return 'embed-pill';
  }

  static clone(node: EmbedPillNode): EmbedPillNode {
    return new EmbedPillNode(
      node.__url,
      node.__displayText,
      node.__key,
      cloneCommentIds(node.__commentIds),
      node.__textFormat
    );
  }

  constructor(
    url: string,
    displayText = '',
    key?: NodeKey,
    commentIds?: string[],
    textFormat = 0
  ) {
    super(key);
    this.__url = url;
    this.__displayText = displayText;
    this.__textFormat = textFormat;
    this.__commentIds = initCommentIds(commentIds);
  }

  getUrl(): string {
    return this.__url;
  }

  getDisplayText(): string {
    return this.__displayText;
  }

  getTextContent(): string {
    return this.__url;
  }

  getTextFormat(): number {
    return this.__textFormat;
  }

  setTextFormat(textFormat: number): void {
    const writable = this.getWritable();
    writable.__textFormat = textFormat;
  }

  getCommentIds(): string[] {
    return this.__commentIds;
  }

  setCommentIds(ids: string[]): void {
    const writable = this.getWritable();
    writable.__commentIds = cloneCommentIds(ids);
  }

  addCommentId(commentId: string): void {
    const writable = this.getWritable();
    if (!writable.__commentIds.includes(commentId)) {
      writable.__commentIds = [...writable.__commentIds, commentId];
    }
  }

  removeCommentId(commentId: string): void {
    const writable = this.getWritable();
    writable.__commentIds = writable.__commentIds.filter((id) => id !== commentId);
  }

  isInline(): true {
    return true;
  }

  isIsolated(): true {
    return true;
  }

  createDOM(_config: EditorConfig): HTMLElement {
    const span = document.createElement('span');
    span.setAttribute('data-embed-pill-url', this.__url);
    span.setAttribute('data-embed-pill-text', this.__displayText);
    if (this.__textFormat) {
      span.setAttribute('data-embed-pill-text-format', String(this.__textFormat));
    }
    return span;
  }

  updateDOM(): false {
    return false;
  }

  decorate(): JSX.Element {
    return (
      <EmbedPillComponent
        url={this.__url}
        displayText={this.__displayText}
        textFormat={this.__textFormat}
        nodeKey={this.getKey()}
      />
    );
  }

  exportDOM(): DOMExportOutput {
    const span = document.createElement('span');
    span.setAttribute('data-embed-pill-url', this.__url);
    span.setAttribute('data-embed-pill-text', this.__displayText);
    if (this.__textFormat) {
      span.setAttribute('data-embed-pill-text-format', String(this.__textFormat));
    }
    span.textContent = this.__displayText || deriveEmbedPillLabel(this.__url);
    return { element: span };
  }

  static importDOM(): DOMConversionMap | null {
    return {
      span: (domNode: Node) => {
        if (domNode instanceof HTMLElement && domNode.hasAttribute('data-embed-pill-url')) {
          return { conversion: $convertEmbedPillElement, priority: 2 };
        }
        return null;
      }
    };
  }

  exportJSON(): SerializedEmbedPillNode {
    const json: SerializedEmbedPillNode = {
      type: 'embed-pill',
      version: 1,
      url: this.__url
    };
    if (this.__displayText) {
      json.displayText = this.__displayText;
    }
    if (this.__textFormat) {
      json.textFormat = this.__textFormat;
    }
    return {
      ...json,
      ...exportCommentIds(this.__commentIds)
    };
  }

  static importJSON(serializedNode: SerializedEmbedPillNode): EmbedPillNode {
    const url = isSafeWebBrowserUrl(serializedNode.url) ? serializedNode.url : '';
    return $createEmbedPillNode(
      url,
      serializedNode.displayText ?? '',
      importCommentIds(serializedNode),
      serializedNode.textFormat ?? 0
    );
  }
}

export function $createEmbedPillNode(
  url: string,
  displayText = '',
  commentIds?: string[],
  textFormat = 0
): EmbedPillNode {
  return $applyNodeReplacement(new EmbedPillNode(url, displayText, undefined, commentIds, textFormat));
}

export function $isEmbedPillNode(node: LexicalNode | null | undefined): node is EmbedPillNode {
  return node instanceof EmbedPillNode;
}
