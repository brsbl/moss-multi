// ported-from: packages/desktop/src/renderer/editor/nodes/HtmlBlockquoteNode.tsx @ 762abb777
// moss-multi seam: publish decorator drafts as register edits.
import { resumeField, useRegisterDraft } from '@moss-multi/host/collab/register-input';
import { registerDoc } from '@moss-multi/host/collab/registers';
// moss-multi seam: capabilities (T2.6): Edit and Delete only while the editor may write.
import { useBlockCanEdit } from '@moss-multi/host/capabilities';
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { JSX } from 'react';
import { $createNodeSelection, $getNodeByKey, $setSelection, type NodeKey } from 'lexical';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { useLexicalNodeSelection } from '@lexical/react/useLexicalNodeSelection';
import { Check, Maximize2, Pencil, RefreshCw, Trash2, X } from 'lucide-react';
import { KeyboardShortcut } from '@moss/shared/components/ui/keyboard-shortcut';
import {
  registerDecoratorDraftFlusher,
  unregisterDecoratorDraftFlusher
} from '../utils/decoratorDraftRegistry';
import {
  BLOCK_HEADER_CLASSNAME,
  BLOCK_SURFACE_CLASSNAME,
  BlockNodeShell,
  MediaHeaderButton,
  MediaNodeHeader,
  useIsEditorEditable,
  useMediaFullscreen,
  useMediaNodeActions
} from '../components/media-primitives';
import { useCurrentNoteId } from '../CurrentNoteIdContext';
import {
  MOSS_HIDE_SCROLLBARS_CSS,
  wrapWithMossHtmlRuntime as sharedWrapWithMossHtmlRuntime
} from '../../../common/moss-html-runtime';
import { DEFAULT_THEME, getThemeById } from '../plugins/code-block/themes';
import { highlightCodeToHtml } from '../utils/code-highlighting';
import { HtmlPreviewIframe } from './html/HtmlPreviewIframe';
import type { HtmlPreviewRenderedSize } from './html/HtmlPreviewIframe';
import { resolveHtmlPreviewSizing } from './html/htmlPreviewSizing';
import { useHtmlPreviewImage } from './html/useHtmlPreviewImage';
import { SharedPreviewFrame } from '../preview/SharedPreviewFrame';
import { SharedPreviewLightbox } from '../preview/SharedPreviewLightbox';
import { SharedLivePreviewActivationOverlay } from '../preview/SharedLivePreviewControls';
import {
  useAnchoredViewportSize,
  useObservedElementWidth
} from '../preview/usePreviewFrameSizing';
// moss-multi seam: converter-split (A§12; S-conv §2.3)
import { $isHtmlBlockquoteNode, type HtmlBlockSource, HtmlBlockquoteNode, extractHtmlBlockquoteText, normalizeExtractedText } from './HtmlBlockquoteNode';
import { registerNodeView } from './node-views';
export { $createHtmlBlockquoteNode, $isHtmlBlockquoteNode, HtmlBlockquoteNode, extractHtmlBlockquoteText } from './HtmlBlockquoteNode';
export type { HtmlBlockSource, SerializedHtmlBlockquoteNode } from './HtmlBlockquoteNode';

// See docs/html-node-architecture.md for the HTML preview/cache/fullscreen contract.
const LIVE_PREVIEW_SCROLL_CSS = `html,body{overflow:auto !important}
${MOSS_HIDE_SCROLLBARS_CSS}`;
const CANVAS_PREVIEW_SHRINK_WRAP_CSS = 'html,body{min-height:0 !important}';
const HTML_PREVIEW_SKELETON_WIDTHS = ['80%', '100%', '60%', '90%', '45%'] as const;
const HTML_BLOCKQUOTE_LINK_CLASSNAME =
  'font-medium text-ink-accent underline decoration-border-default underline-offset-2 transition-colors hover:text-accent-brand hover:decoration-accent-brand';
const HTML_BLOCKQUOTE_ALLOWED_LINK_PROTOCOLS = new Set(['http:', 'https:']);

export type HtmlBlockquotePreviewMode = 'interactive' | 'static-image' | 'static-placeholder';

export const resolveHtmlBlockquotePreviewMode = ({
  isInteractive,
  previewImageFailed
}: {
  isInteractive: boolean;
  previewImageFailed: boolean;
}): HtmlBlockquotePreviewMode => {
  if (isInteractive) {
    return 'interactive';
  }
  return previewImageFailed ? 'static-placeholder' : 'static-image';
};

export const resolveStableHtmlPreviewLayerVisibilityClass = ({
  isInteractive,
  interactivePreviewReady
}: {
  isInteractive: boolean;
  interactivePreviewReady: boolean;
}): string => {
  if (!isInteractive) {
    return 'opacity-100';
  }
  return `transition-opacity duration-100 ${interactivePreviewReady ? 'opacity-0' : 'opacity-100'}`;
};

export interface HtmlBlockquotePreviewLink {
  href: string;
  text: string;
}

export interface HtmlBlockquotePreviewContent {
  paragraphs: string[];
  attribution: string | null;
  links: HtmlBlockquotePreviewLink[];
}

const sanitizeHtmlBlockquotePreviewHref = (href: string): string | null => {
  try {
    const parsed = new URL(href);
    return HTML_BLOCKQUOTE_ALLOWED_LINK_PROTOCOLS.has(parsed.protocol) ? parsed.href : null;
  } catch {
    return null;
  }
};

const TEXT_NODE_TYPE = 3;
const ELEMENT_NODE_TYPE = 1;

const extractDomText = (node: ChildNode | HTMLElement): string => {
  if (node.nodeType === TEXT_NODE_TYPE) {
    return node.textContent ?? '';
  }
  if (node.nodeType !== ELEMENT_NODE_TYPE) {
    return '';
  }

  const element = node as HTMLElement;
  if (element.tagName.toLowerCase() === 'br') {
    return '\n';
  }

  return Array.from(element.childNodes).map(extractDomText).join('');
};

const normalizeAttributionText = (text: string): string | null => {
  const normalized = normalizeExtractedText(text).replace(/^[\s\u2013\u2014-]+/, '');
  return normalized || null;
};

export const parseHtmlBlockquotePreviewContent = (
  rawHtml: string
): HtmlBlockquotePreviewContent => {
  if (typeof DOMParser === 'undefined') {
    const fallbackText = extractHtmlBlockquoteText(rawHtml);
    return {
      paragraphs: fallbackText ? [fallbackText] : [],
      attribution: null,
      links: []
    };
  }

  const parser = new DOMParser();
  const doc = parser.parseFromString(rawHtml, 'text/html');
  const blockquote = doc.querySelector('blockquote') ?? doc.body;
  const paragraphElements = Array.from(blockquote.querySelectorAll('p'));
  const paragraphs = paragraphElements
    .map((paragraph) => normalizeExtractedText(extractDomText(paragraph)))
    .filter((text) => text.length > 0);
  const links = Array.from(blockquote.querySelectorAll<HTMLAnchorElement>('a[href]'))
    .map((link) => {
      const rawHref = link.getAttribute('href')?.trim() ?? '';
      const href = sanitizeHtmlBlockquotePreviewHref(rawHref);
      const text = normalizeExtractedText(extractDomText(link)) || rawHref;
      return href ? { href, text } : null;
    })
    .filter((link): link is HtmlBlockquotePreviewLink => (
      link !== null && link.text.length > 0
    ));

  const attributionClone = blockquote.cloneNode(true) as HTMLElement;
  attributionClone.querySelectorAll('p,a,script,style').forEach((element) => element.remove());
  const attribution = normalizeAttributionText(extractDomText(attributionClone));
  const fallbackText = extractHtmlBlockquoteText(rawHtml);

  return {
    paragraphs: paragraphs.length > 0
      ? paragraphs
      : fallbackText
        ? [fallbackText]
        : [],
    attribution,
    links
  };
};

// Re-export for consumers that import HTML runtime helpers from this node file.
export { wrapWithMossHtmlRuntime } from '../../../common/moss-html-runtime';

const wrapWithMossHtmlRuntimeLocal = sharedWrapWithMossHtmlRuntime;

type HtmlBlockquoteComponentProps = {
  rawHtml: string;
  source: HtmlBlockSource;
  commentIds?: string[];
  nodeKey: NodeKey;
};

function HtmlBlockquoteComponent(props: HtmlBlockquoteComponentProps): JSX.Element {
  if (props.source === 'blockquote') {
    return <RawHtmlBlockquoteComponent {...props} />;
  }

  return <MossHtmlPreviewComponent {...props} />;
}

function RawHtmlBlockquoteComponent({
  rawHtml,
  nodeKey
}: HtmlBlockquoteComponentProps): JSX.Element {
  const [editor] = useLexicalComposerContext();
  const canEdit = useBlockCanEdit(); // moss-multi seam: capabilities (T2.6)
  const [isSelected, setSelected, clearSelection] = useLexicalNodeSelection(nodeKey);
  const { handleDelete, handleGapClick } = useMediaNodeActions(nodeKey);
  // moss-multi seam: read-only-decorators (T3.8): a read-only HTML block opens no source editor and offers no Edit,
  // Delete or Fullscreen.
  const [isEditing, setEditing] = useState(() => resumeField(editor, nodeKey) && editor.isEditable());
  const setIsEditing = useCallback((next: boolean) => setEditing(next && editor.isEditable()), [editor]);
  const [hasTextSelection, setHasTextSelection] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [localRawHtml, setLocalRawHtml, writable] = useRegisterDraft(editor, nodeKey, rawHtml, textareaRef, isEditing);
  const highlightedPreRef = useRef<HTMLPreElement>(null);
  const previewContent = useMemo(
    () => parseHtmlBlockquotePreviewContent(rawHtml),
    [rawHtml]
  );
  const highlightedHtml = useMemo(
    () => highlightCodeToHtml(localRawHtml, 'html'),
    [localRawHtml]
  );
  const editorThemeStyles = useMemo(() => {
    const theme = getThemeById(DEFAULT_THEME);
    return {
      '--cb-bg': theme.colors.bg,
      '--cb-header': theme.colors.header,
      '--cb-border': theme.colors.border,
      '--cb-text': theme.colors.text,
      '--cb-comment': theme.colors.comment,
      '--cb-punctuation': theme.colors.punctuation,
      '--cb-property': theme.colors.property,
      '--cb-string': theme.colors.string,
      '--cb-operator': theme.colors.operator,
      '--cb-keyword': theme.colors.keyword,
      '--cb-function': theme.colors.function,
      '--cb-variable': theme.colors.variable,
    } as React.CSSProperties;
  }, []);

  useEffect(() => {
    if (!isEditing && !registerDoc(editor)) {
      setLocalRawHtml(rawHtml);
    }
  }, [rawHtml, isEditing]);

  useEffect(() => {
    if (!isEditing) {
      return;
    }

    const textarea = textareaRef.current;
    if (!textarea) {
      return;
    }

    textarea.focus();
    const cursor = textarea.value.length;
    textarea.setSelectionRange(cursor, cursor);
    setHasTextSelection(false);
  }, [isEditing]);

  const syncHighlightedScroll = useCallback((target: HTMLTextAreaElement) => {
    if (!highlightedPreRef.current) {
      return;
    }

    highlightedPreRef.current.scrollTop = target.scrollTop;
    highlightedPreRef.current.scrollLeft = target.scrollLeft;
  }, []);

  const syncSelectionPresentation = useCallback((target: HTMLTextAreaElement) => {
    setHasTextSelection(target.selectionStart !== target.selectionEnd);
  }, []);

  const selectNode = useCallback(() => {
    clearSelection();
    setSelected(true);
  }, [clearSelection, setSelected]);

  const handleContainerClick = useCallback((e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    if (target.closest('button') || target.closest('textarea') || target.closest('a')) {
      return;
    }
    if (e.shiftKey) {
      setSelected(!isSelected);
    } else {
      selectNode();
    }
  }, [isSelected, selectNode, setSelected]);

  const commitRawHtml = useCallback(() => {
    const trimmed = localRawHtml.trim();
    if (!trimmed) {
      return;
    }

    editor.update(() => {
      const node = $getNodeByKey(nodeKey);
      if (node && $isHtmlBlockquoteNode(node)) {
        if (!registerDoc(editor)) node.setRawHtml(trimmed);
      }
    });
    setHasTextSelection(false);
    setIsEditing(false);
  }, [editor, localRawHtml, nodeKey]);

  useEffect(() => {
    if (!isEditing) {
      return;
    }

    const flushDraft = () => {
      commitRawHtml();
    };

    const editorId = editor._key;
    registerDecoratorDraftFlusher(editorId, nodeKey, flushDraft);
    return () => {
      unregisterDecoratorDraftFlusher(editorId, nodeKey, flushDraft);
    };
  }, [commitRawHtml, editor._key, isEditing, nodeKey]);

  const cancelEdit = useCallback(() => {
    if (!registerDoc(editor)) setLocalRawHtml(rawHtml);
    setHasTextSelection(false);
    setIsEditing(false);
  }, [rawHtml]);

  const handleEditorKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    e.stopPropagation();
    if (e.key === 'Escape') {
      e.preventDefault();
      cancelEdit();
      return;
    }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      commitRawHtml();
    }
  }, [cancelEdit, commitRawHtml]);

  const handlePreviewLinkClick = useCallback((
    event: React.MouseEvent<HTMLAnchorElement>,
    href: string
  ) => {
    event.preventDefault();
    event.stopPropagation();
    window.open(href, '_blank', 'noopener,noreferrer');
  }, []);

  return (
    <div
      className="group/decorator relative my-4"
      data-block-decorator-key={nodeKey}
      onClick={handleContainerClick}
      onDoubleClick={() => { if (canEdit) setIsEditing(true); } /* moss-multi seam: capabilities (T2.6) */}
    >
      <div className="mx-auto w-full max-w-canvas-prose">
        <BlockNodeShell
          selected={isSelected}
          beforeLabel="Insert paragraph before HTML blockquote"
          afterLabel="Insert paragraph after HTML blockquote"
          onGapClick={handleGapClick}
          className="mx-auto"
        >
          {isEditing ? (
            <div className={`${BLOCK_SURFACE_CLASSNAME} h-80`}>
              <div className="flex h-full w-full flex-col">
                <div
                  className={`flex h-10 flex-shrink-0 items-center justify-between px-canvas-surface-pad ${BLOCK_HEADER_CLASSNAME}`}
                  style={{ ...editorThemeStyles, backgroundColor: 'var(--cb-header)' }}
                >
                  <div className="font-mono text-xs" style={{ color: 'var(--cb-text)' }}>
                    HTML
                  </div>
                  <div className="flex items-center gap-1">
                    <MediaHeaderButton
                      icon={X}
                      title={registerDoc(editor) ? "Close" : "Cancel"}
                      onClick={() => cancelEdit()}
                    />
                    <MediaHeaderButton
                      icon={Check}
                      title="Apply"
                      onClick={() => commitRawHtml()}
                    />
                  </div>
                </div>
                <div
                  className="relative min-h-0 flex-1 overflow-hidden"
                  style={{ ...editorThemeStyles, backgroundColor: 'var(--cb-bg)' }}
                >
                  <pre
                    ref={highlightedPreRef}
                    aria-hidden
                    className={`moss-codeblock-pre pointer-events-none absolute inset-0 overflow-auto p-canvas-surface-pad font-mono text-code transition-opacity ${
                      hasTextSelection ? 'opacity-0' : 'opacity-100'
                    }`}
                    style={{ color: 'var(--cb-text)' }}
                  >
                    <code
                      className="moss-codeblock-code"
                      dangerouslySetInnerHTML={{ __html: highlightedHtml || '&nbsp;' }}
                    />
                  </pre>
                  <textarea
                    ref={textareaRef}
                    readOnly={!editor.isEditable() || !writable}
                    value={localRawHtml}
                    onChange={(e) => {
                      setLocalRawHtml(e.target.value);
                      syncSelectionPresentation(e.currentTarget);
                    }}
                    onKeyDown={handleEditorKeyDown}
                    onScroll={(e) => syncHighlightedScroll(e.currentTarget)}
                    onSelect={(e) => syncSelectionPresentation(e.currentTarget)}
                    onClick={(e) => syncSelectionPresentation(e.currentTarget)}
                    onPaste={(e) => e.stopPropagation()}
                    onCopy={(e) => e.stopPropagation()}
                    onCut={(e) => e.stopPropagation()}
                    onBlur={() => setHasTextSelection(false)}
                    className="moss-codeblock-textarea absolute inset-0 h-full w-full resize-none overflow-auto bg-surface-transparent p-canvas-surface-pad font-mono text-code outline-none"
                    style={{ color: hasTextSelection ? 'var(--cb-text)' : 'transparent', caretColor: 'var(--cb-text)' }}
                    spellCheck={false}
                    autoCapitalize="off"
                    autoCorrect="off"
                  />
                </div>
                <div
                  className="flex-shrink-0 border-t px-3 py-1.5 text-xs text-ink-muted"
                  style={{ ...editorThemeStyles, backgroundColor: 'var(--cb-bg)', borderColor: 'var(--cb-border)' }}
                >
                  <span className="inline-flex items-center gap-1 align-middle">
                    <KeyboardShortcut keys={['⌘', '⏎']} size="compact" />
                  </span>{' '}
                  {registerDoc(editor) ? 'to finish' : 'to save'} &middot;{' '}
                  <span className="inline-flex items-center gap-1 align-middle">
                    <KeyboardShortcut keys={['Esc']} size="compact" />
                  </span>{' '}
                  {registerDoc(editor) ? 'to close' : 'to cancel'}
                </div>
              </div>
            </div>
          ) : (
            <div
              data-testid="html-blockquote-readable-preview"
              className="relative rounded-lg border border-border-subtle bg-surface-raised-card px-5 py-4 shadow-sm"
            >
              <div
                className="absolute right-2 top-2 z-10 flex items-center gap-1 opacity-0 transition-opacity group-hover/decorator:opacity-100 group-focus-within/decorator:opacity-100"
                onClick={(e) => e.stopPropagation()}
              >
                {/* moss-multi seam: capabilities (T2.6) */}
                {canEdit && (
                <>
                <MediaHeaderButton
                  icon={Pencil}
                  title="Edit HTML"
                  onClick={() => setIsEditing(true)}
                />
                <MediaHeaderButton
                  icon={Trash2}
                  title="Delete HTML block"
                  onClick={handleDelete}
                />
                </>
                )}
              </div>
              <blockquote className="border-l-2 border-border-default pl-4 pr-10">
                <div className="space-y-3 text-body text-ink-default">
                  {previewContent.paragraphs.map((paragraph, index) => (
                    <p key={`${index}-${paragraph}`} className="whitespace-pre-wrap break-words">
                      {paragraph}
                    </p>
                  ))}
                </div>
                {(previewContent.attribution || previewContent.links.length > 0) ? (
                  <footer className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-detail text-ink-muted">
                    {previewContent.attribution ? <span>{previewContent.attribution}</span> : null}
                    {previewContent.links.map((link) => (
                      <a
                        key={`${link.href}-${link.text}`}
                        href={link.href}
                        target="_blank"
                        rel="noopener noreferrer"
                        className={HTML_BLOCKQUOTE_LINK_CLASSNAME}
                        onClick={(e) => handlePreviewLinkClick(e, link.href)}
                      >
                        {link.text}
                      </a>
                    ))}
                  </footer>
                ) : null}
              </blockquote>
            </div>
          )}
        </BlockNodeShell>
      </div>
    </div>
  );
}

function MossHtmlPreviewComponent({
  rawHtml,
  source: _source,
  commentIds: _commentIds = [],
  nodeKey
}: HtmlBlockquoteComponentProps): JSX.Element {
  const [editor] = useLexicalComposerContext();
  const canEdit = useBlockCanEdit(); // moss-multi seam: capabilities (T2.6)
  const noteId = useCurrentNoteId();
  const [isSelected, setSelected, clearSelection] = useLexicalNodeSelection(nodeKey);
  const { handleDelete, handleGapClick } = useMediaNodeActions(nodeKey);
  // moss-multi seam: read-only-decorators (T3.8): a read-only HTML block opens no source editor and offers no Edit,
  // Delete or Fullscreen.
  const [isEditing, setEditing] = useState(() => resumeField(editor, nodeKey) && editor.isEditable());
  const editable = useIsEditorEditable();
  const setIsEditing = useCallback((next: boolean) => setEditing(next && editor.isEditable()), [editor]);
  const [hasTextSelection, setHasTextSelection] = useState(false);
  const [isInteractive, setIsInteractive] = useState(false);
  const { isFullscreen, enterFullscreen, exitFullscreen } = useMediaFullscreen();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [localRawHtml, setLocalRawHtml, writable] = useRegisterDraft(editor, nodeKey, rawHtml, textareaRef, isEditing);
  const highlightedPreRef = useRef<HTMLPreElement>(null);

  const [interactivePreviewReady, setInteractivePreviewReady] = useState(false);
  const [previewImageIntrinsicSize, setPreviewImageIntrinsicSize] = useState<{
    width: number;
    height: number;
  } | null>(null);
  const [renderedContentSize, setRenderedContentSize] =
    useState<HtmlPreviewRenderedSize | null>(null);
  const noteFrameHostRef = useRef<HTMLDivElement | null>(null);
  const notePreviewViewportRef = useRef<HTMLDivElement | null>(null);

  const previewRawHtml = rawHtml;
  const availableNoteWidth = useObservedElementWidth(noteFrameHostRef);
  const notePreviewViewportWidth = useObservedElementWidth(notePreviewViewportRef);
  const viewportSize = useAnchoredViewportSize(noteFrameHostRef);
  const {
    htmlIntrinsicSize,
    htmlDisplayIntrinsicSize,
    noteFrameSize,
    noteIframeMode,
    fullscreenFrameSize
  } = useMemo(
    () => resolveHtmlPreviewSizing({
      rawHtml: previewRawHtml,
      availableNoteWidth,
      viewportSize,
      previewImageIntrinsicSize,
      renderedContentSize
    }),
    [availableNoteWidth, previewImageIntrinsicSize, previewRawHtml, renderedContentSize, viewportSize]
  );
  const {
    livePreview,
    previewImageUrl,
    preloadImageUrl,
    previewImageFailed,
    shouldRenderPreviewImage,
    status: previewImageStatus,
    retryPreviewImage,
    handlePreviewImageLoad,
    handlePreviewImageError,
    handlePendingPreviewImageLoad,
    handlePendingPreviewImageError
  } = useHtmlPreviewImage({
    noteId,
    rawHtml: previewRawHtml
  });

  useLayoutEffect(() => {
    setInteractivePreviewReady(false);
  }, [previewRawHtml, isInteractive]);

  useEffect(() => {
    setPreviewImageIntrinsicSize(null);
  }, [previewRawHtml]);

  useEffect(() => {
    setRenderedContentSize(null);
  }, [previewRawHtml]);

  const handleStaticPreviewImageLoad = useCallback((
    event: React.SyntheticEvent<HTMLImageElement>
  ) => {
    const { naturalWidth, naturalHeight } = event.currentTarget;
    if (naturalWidth > 0 && naturalHeight > 0) {
      setPreviewImageIntrinsicSize({
        width: naturalWidth,
        height: naturalHeight
      });
    }
    handlePreviewImageLoad();
  }, [handlePreviewImageLoad]);

  const handlePreloadPreviewImageLoad = useCallback((
    event: React.SyntheticEvent<HTMLImageElement>
  ) => {
    const { naturalWidth, naturalHeight } = event.currentTarget;
    if (naturalWidth > 0 && naturalHeight > 0) {
      setPreviewImageIntrinsicSize({
        width: naturalWidth,
        height: naturalHeight
      });
    }
    handlePendingPreviewImageLoad();
  }, [handlePendingPreviewImageLoad]);

  const previewSrcDoc = useMemo(
    () =>
      wrapWithMossHtmlRuntimeLocal(previewRawHtml, {
        trailingHeadCss: LIVE_PREVIEW_SCROLL_CSS,
        dimensionReportId: nodeKey
      }),
    [nodeKey, previewRawHtml]
  );
  const canvasPreviewSrcDoc = useMemo(() => {
    const shouldShrinkWrapMinHeight =
      htmlIntrinsicSize.heightSource === 'min-height' &&
      htmlDisplayIntrinsicSize.height < htmlIntrinsicSize.height;
    const trailingHeadCss = shouldShrinkWrapMinHeight
      ? `${LIVE_PREVIEW_SCROLL_CSS}\n${CANVAS_PREVIEW_SHRINK_WRAP_CSS}`
      : LIVE_PREVIEW_SCROLL_CSS;

    return wrapWithMossHtmlRuntimeLocal(previewRawHtml, { trailingHeadCss });
  }, [
    htmlDisplayIntrinsicSize.height,
    htmlIntrinsicSize.height,
    htmlIntrinsicSize.heightSource,
    previewRawHtml
  ]);
  const noteDisplayScale = Math.max(
    0.001,
    (notePreviewViewportWidth ?? noteFrameSize.width) / htmlDisplayIntrinsicSize.width
  );
  const handleRenderedContentSize = useCallback((size: HtmlPreviewRenderedSize) => {
    setRenderedContentSize((current) =>
      current?.width === size.width && current.height === size.height
        ? current
        : size
    );
  }, []);
  const highlightedHtml = useMemo(
    () => highlightCodeToHtml(localRawHtml, 'html'),
    [localRawHtml]
  );
  const editorThemeStyles = useMemo(() => {
    const theme = getThemeById(DEFAULT_THEME);
    return {
      '--cb-bg': theme.colors.bg,
      '--cb-header': theme.colors.header,
      '--cb-border': theme.colors.border,
      '--cb-text': theme.colors.text,
      '--cb-comment': theme.colors.comment,
      '--cb-punctuation': theme.colors.punctuation,
      '--cb-property': theme.colors.property,
      '--cb-string': theme.colors.string,
      '--cb-operator': theme.colors.operator,
      '--cb-keyword': theme.colors.keyword,
      '--cb-function': theme.colors.function,
      '--cb-variable': theme.colors.variable,
    } as React.CSSProperties;
  }, []);
  const previewMode = resolveHtmlBlockquotePreviewMode({
    isInteractive,
    previewImageFailed
  });
  const stablePreviewLayerVisibilityClass = resolveStableHtmlPreviewLayerVisibilityClass({
    isInteractive,
    interactivePreviewReady
  });

  const handleRetryPreview = useCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    e.preventDefault();
    e.stopPropagation();
    retryPreviewImage();
  }, [retryPreviewImage]);

  useEffect(() => {
    if (!isEditing && !registerDoc(editor)) {
      setLocalRawHtml(rawHtml);
    }
  }, [rawHtml, isEditing]);

  useEffect(() => {
    if (isEditing) {
      const textarea = textareaRef.current;
      if (!textarea) {
        return;
      }

      textarea.focus();
      const cursor = textarea.value.length;
      textarea.setSelectionRange(cursor, cursor);
      setHasTextSelection(false);
    }
  }, [isEditing]);

  const syncHighlightedScroll = useCallback((target: HTMLTextAreaElement) => {
    if (!highlightedPreRef.current) {
      return;
    }

    highlightedPreRef.current.scrollTop = target.scrollTop;
    highlightedPreRef.current.scrollLeft = target.scrollLeft;
  }, []);

  const syncSelectionPresentation = useCallback((target: HTMLTextAreaElement) => {
    setHasTextSelection(target.selectionStart !== target.selectionEnd);
  }, []);

  const activatePreview = useCallback(() => {
    editor.update(() => {
      const selection = $createNodeSelection();
      selection.add(nodeKey);
      $setSelection(selection);
    });
    setIsInteractive(true);
  }, [editor, nodeKey]);

  const handleActivatePreviewClick = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    activatePreview();
  }, [activatePreview]);

  const handleActivatePreviewDoubleClick = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    activatePreview();
    if (canEdit) setIsEditing(true); // moss-multi seam: capabilities (T2.6)
  }, [activatePreview, canEdit]);

  const selectNode = useCallback(() => {
    clearSelection();
    setSelected(true);
  }, [clearSelection, setSelected]);

  useEffect(() => {
    if (!isSelected) {
      setIsInteractive(false);
    }
  }, [isSelected]);

  const handleContainerClick = useCallback((e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    if (target.closest('button') || target.closest('textarea')) {
      return;
    }
    if (e.shiftKey) {
      setSelected(!isSelected);
    } else {
      selectNode();
    }
  }, [isSelected, selectNode, setSelected]);

  const commitRawHtml = useCallback(() => {
    const trimmed = localRawHtml.trim();
    if (!trimmed) {
      return;
    }

    editor.update(() => {
      const node = $getNodeByKey(nodeKey);
      if (node && $isHtmlBlockquoteNode(node)) {
        if (!registerDoc(editor)) node.setRawHtml(trimmed);
      }
    });
    setHasTextSelection(false);
    setIsEditing(false);
  }, [editor, localRawHtml, nodeKey]);

  useEffect(() => {
    if (!isEditing) {
      return;
    }

    const flushDraft = () => {
      commitRawHtml();
    };

    const editorId = editor._key;
    registerDecoratorDraftFlusher(editorId, nodeKey, flushDraft);
    return () => {
      unregisterDecoratorDraftFlusher(editorId, nodeKey, flushDraft);
    };
  }, [commitRawHtml, editor._key, isEditing, nodeKey]);

  const cancelEdit = useCallback(() => {
    if (!registerDoc(editor)) setLocalRawHtml(rawHtml);
    setHasTextSelection(false);
    setIsEditing(false);
  }, [rawHtml]);

  const handleEditorKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    e.stopPropagation();
    if (e.key === 'Escape') {
      e.preventDefault();
      cancelEdit();
      return;
    }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      commitRawHtml();
    }
  }, [cancelEdit, commitRawHtml]);

  const editorPanel = (
    <div className="flex h-full w-full flex-col">
      <div
        className={`flex h-10 flex-shrink-0 items-center justify-between px-canvas-surface-pad ${BLOCK_HEADER_CLASSNAME}`}
        style={{ ...editorThemeStyles, backgroundColor: 'var(--cb-header)' }}
      >
        <div className="font-mono text-xs" style={{ color: 'var(--cb-text)' }}>
          HTML
        </div>
        <div className="flex items-center gap-1">
          <MediaHeaderButton
            icon={X}
            title={registerDoc(editor) ? "Close" : "Cancel"}
            onClick={() => cancelEdit()}
          />
          <MediaHeaderButton
            icon={Check}
            title="Apply"
            onClick={() => commitRawHtml()}
          />
        </div>
      </div>
      <div
        className="relative min-h-0 flex-1 overflow-hidden"
        style={{ ...editorThemeStyles, backgroundColor: 'var(--cb-bg)' }}
      >
        <pre
          ref={highlightedPreRef}
          aria-hidden
          className={`moss-codeblock-pre pointer-events-none absolute inset-0 overflow-auto p-canvas-surface-pad font-mono text-code transition-opacity ${
            hasTextSelection ? 'opacity-0' : 'opacity-100'
          }`}
          style={{ color: 'var(--cb-text)' }}
        >
          <code
            className="moss-codeblock-code"
            dangerouslySetInnerHTML={{ __html: highlightedHtml || '&nbsp;' }}
          />
        </pre>
        <textarea
          ref={textareaRef}
          readOnly={!editor.isEditable() || !writable}
          value={localRawHtml}
          onChange={(e) => {
            setLocalRawHtml(e.target.value);
            syncSelectionPresentation(e.currentTarget);
          }}
          onKeyDown={handleEditorKeyDown}
          onScroll={(e) => syncHighlightedScroll(e.currentTarget)}
          onSelect={(e) => syncSelectionPresentation(e.currentTarget)}
          onClick={(e) => syncSelectionPresentation(e.currentTarget)}
          onPaste={(e) => e.stopPropagation()}
          onCopy={(e) => e.stopPropagation()}
          onCut={(e) => e.stopPropagation()}
          onBlur={() => setHasTextSelection(false)}
          className="moss-codeblock-textarea absolute inset-0 h-full w-full resize-none overflow-auto bg-surface-transparent p-canvas-surface-pad font-mono text-code outline-none"
          style={{ color: hasTextSelection ? 'var(--cb-text)' : 'transparent', caretColor: 'var(--cb-text)' }}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
        />
      </div>
      <div
        className="flex-shrink-0 border-t px-3 py-1.5 text-xs text-ink-muted"
        style={{ ...editorThemeStyles, backgroundColor: 'var(--cb-bg)', borderColor: 'var(--cb-border)' }}
      >
        <span className="inline-flex items-center gap-1 align-middle">
          <KeyboardShortcut keys={['⌘', '⏎']} size="compact" />
        </span>{' '}
        {registerDoc(editor) ? 'to finish' : 'to save'} &middot;{' '}
        <span className="inline-flex items-center gap-1 align-middle">
          <KeyboardShortcut keys={['Esc']} size="compact" />
        </span>{' '}
        {registerDoc(editor) ? 'to close' : 'to cancel'}
      </div>
    </div>
  );

  const previewStaticLayer = (
    <div
      className={`moss-html-preview-scroll absolute inset-0 overflow-auto bg-ink-inverse ${stablePreviewLayerVisibilityClass}`}
    >
      {/* moss-multi seam: html-preview (A§16): no screenshot on the web; the static preview is the live sandboxed
          frame, inert until the block is activated, sized as moss sizes its screenshot: the default viewport grown to
          what renders. */}
      {livePreview ? (
        <div className="pointer-events-none absolute inset-0" data-moss-html-live-preview="static">
          <HtmlPreviewIframe
            srcDoc={previewSrcDoc}
            title="HTML preview"
            viewportWidth={htmlDisplayIntrinsicSize.width}
            viewportHeight={htmlDisplayIntrinsicSize.height}
            displayScale={noteDisplayScale}
            dimensionReportId={nodeKey}
            className="h-full w-full"
            mode={noteIframeMode}
            onRenderedSize={htmlIntrinsicSize.heightSource === 'default' ? setPreviewImageIntrinsicSize : undefined}
          />
        </div>
      ) : null}

      {shouldRenderPreviewImage ? (
        <img
          src={previewImageUrl}
          alt="HTML preview"
          className="block h-auto w-full bg-ink-inverse opacity-100 transition-opacity duration-100"
          loading="lazy"
          decoding="async"
          onLoad={handleStaticPreviewImageLoad}
          onError={handlePreviewImageError}
          draggable={false}
        />
      ) : null}

      {preloadImageUrl ? (
        <img
          src={preloadImageUrl}
          alt=""
          data-testid="html-preview-preload"
          className="hidden"
          loading="eager"
          decoding="async"
          onLoad={handlePreloadPreviewImageLoad}
          onError={handlePendingPreviewImageError}
          draggable={false}
          aria-hidden="true"
        />
      ) : null}

      {previewImageStatus === 'loading' ? (
        <div
          data-testid="html-preview-loading"
          className="absolute inset-x-0 bottom-0 top-10 bg-ink-inverse"
        >
          <div className="flex h-full flex-col gap-2 px-6 pb-8 pt-4">
            {[...HTML_PREVIEW_SKELETON_WIDTHS, ...HTML_PREVIEW_SKELETON_WIDTHS].map(
              (width, index) => (
                <div
                  key={`${width}-${index}`}
                  data-testid="html-preview-loading-bar"
                  className="agent-skeleton-line agent-skeleton-line--empty"
                  style={{ width }}
                />
              )
            )}
          </div>
        </div>
      ) : null}

      {previewImageStatus === 'error' ? (
        <div
          data-testid="html-preview-error"
          className="absolute inset-0 z-20 flex items-center justify-center bg-surface-canvas px-6 py-8"
        >
          <div className="flex flex-col items-center gap-3 text-center">
            <div className="space-y-1">
              <p className="text-sm font-semibold text-ink-default">Preview unavailable</p>
              <p className="text-xs text-ink-muted">
                The HTML preview could not be generated right now.
              </p>
            </div>
            <button
              type="button"
              aria-label="Retry preview"
              onClick={handleRetryPreview}
              className="inline-flex h-8 items-center gap-2 rounded-full border border-surface-glass-border bg-surface-raised-card px-3 text-xs font-medium text-ink-default transition-colors hover:bg-surface-canvas"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              Retry
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );

  const previewInteractiveLayer =
    previewMode === 'interactive' ? (
      <div
        className={`absolute inset-0 z-10 transition-opacity duration-100 ${
          interactivePreviewReady ? 'opacity-100' : 'opacity-0'
        }`}
      >
        <HtmlPreviewIframe
          srcDoc={canvasPreviewSrcDoc}
          title="HTML preview (interactive)"
          viewportWidth={htmlDisplayIntrinsicSize.width}
          viewportHeight={htmlDisplayIntrinsicSize.height}
          displayScale={noteDisplayScale}
          className="h-full w-full"
          mode={noteIframeMode}
          onLoad={() => setInteractivePreviewReady(true)}
        />
      </div>
    ) : null;

  const previewOverlay = (
    <>
      {isInteractive && editable ? (
        <div
          className="pointer-events-none absolute left-0 right-0 top-0 z-20 flex items-center justify-end px-2 py-1.5 opacity-0 transition-opacity group-hover/decorator:pointer-events-auto group-hover/decorator:opacity-100 group-focus-within/decorator:pointer-events-auto group-focus-within/decorator:opacity-100"
          onClick={(e) => e.stopPropagation()}
        >
          <MediaHeaderButton
            icon={Maximize2}
            title="Fullscreen"
            onClick={enterFullscreen}
          />
        </div>
      ) : null}

    </>
  );

  const previewLightbox = (
    <SharedPreviewLightbox
      open={isFullscreen}
      onClose={exitFullscreen}
      anchorRef={noteFrameHostRef}
      frameSize={fullscreenFrameSize}
    >
      <HtmlPreviewIframe
        srcDoc={previewSrcDoc}
        title="HTML preview (fullscreen)"
        viewportWidth={fullscreenFrameSize.viewportWidth}
        viewportHeight={fullscreenFrameSize.viewportHeight}
        displayScale={fullscreenFrameSize.scale}
        dimensionReportId={nodeKey}
        className="h-full w-full"
        mode={fullscreenFrameSize.mode}
        onRenderedSize={handleRenderedContentSize}
      />
    </SharedPreviewLightbox>
  );

  return (
    <SharedPreviewFrame
      nodeKey={nodeKey}
      selected={isSelected}
      frameSize={noteFrameSize}
      beforeLabel="Insert paragraph before HTML block"
      afterLabel="Insert paragraph after HTML block"
      onGapClick={handleGapClick}
      hostRef={noteFrameHostRef}
      rootClassName="my-4"
      onRootClick={handleContainerClick}
      onRootDoubleClick={() => { if (canEdit) setIsEditing(true); } /* moss-multi seam: capabilities (T2.6) */}
      {...(isEditing
        ? { children: editorPanel }
        : {
            viewportRef: notePreviewViewportRef,
            viewportClassName: `relative isolate h-full overflow-hidden bg-ink-inverse ${
              !isInteractive ? 'cursor-pointer' : ''
            }`,
            viewportDataAttributes: { 'data-moss-html-preview-viewport': 'true' },
            headerActions: !isInteractive ? (
              <MediaNodeHeader
                nodeKey={nodeKey}
                onDelete={handleDelete}
                onFullscreen={enterFullscreen}
              >
                {/* moss-multi seam: capabilities (T2.6) */}
                {canEdit && (
                <MediaHeaderButton
                  icon={Pencil}
                  title="Edit HTML"
                  onClick={() => setIsEditing(true)}
                />
                )}
              </MediaNodeHeader>
            ) : null,
            activationBadge: !isInteractive ? (
              <SharedLivePreviewActivationOverlay
                ariaLabel="Activate live HTML preview"
                onActivate={handleActivatePreviewClick}
                onDoubleClick={handleActivatePreviewDoubleClick}
                dataAttributes={{ 'data-moss-html-activation': 'pending' }}
              />
            ) : null,
            staticLayer: previewStaticLayer,
            interactiveLayer: previewInteractiveLayer,
            overlay: previewOverlay,
            afterSurface: previewLightbox
          })}
    />
  );
}

// moss-multi seam: node-views (A§12)
registerNodeView(HtmlBlockquoteNode.getType(), function decorate(this: HtmlBlockquoteNode): JSX.Element {
    return (
      <HtmlBlockquoteComponent
        rawHtml={this.getRawHtml()}
        source={this.__source}
        commentIds={this.__commentIds}
        nodeKey={this.__key}
      />
    );
  });
