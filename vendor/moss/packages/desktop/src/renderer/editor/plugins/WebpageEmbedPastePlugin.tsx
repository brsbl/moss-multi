// ported-from: packages/desktop/src/renderer/editor/plugins/WebpageEmbedPastePlugin.tsx @ 762abb777
/**
 * WebpageEmbedPastePlugin
 *
 * LOW-priority paste handler for standalone browser-safe webpage content. Bare
 * URLs become compact `EmbedPillNode`s (except tweet status URLs), while
 * `![alt](url)` webpage syntax becomes a visual `WebEmbedNode`.
 *
 * Ordering: registered AFTER `SafePastePlugin` (HIGH), `VideoPastePlugin`
 * (NORMAL), and `ExternalImagePastePlugin` (NORMAL). Lexical runs handlers
 * highest-priority first and stops at the first that returns `true`, so this
 * LOW handler only sees clipboard text those plugins declined. As belt-and-
 * suspenders it also re-checks classification via the shared `isEmbeddableWebUrl`
 * and defers on image / YouTube / local-video, matching the `IMAGE_TRANSFORMER`
 * dispatch in MarkdownEditor.
 *
 * It claims only supported bare URLs and visual webpage syntax in an empty
 * paragraph. Named Markdown links, media URLs, unsafe URLs, and surrounding
 * prose stay untouched.
 */
import { useEffect } from 'react';

import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { objectKlassEquals } from '@lexical/utils';
import {
  $createParagraphNode,
  $createTextNode,
  $getSelection,
  $isParagraphNode,
  $isRangeSelection,
  COMMAND_PRIORITY_LOW,
  PASTE_COMMAND,
  type LexicalEditor,
  type LexicalNode
} from 'lexical';

import { $createEmbedPillNode } from '../nodes/EmbedPillNode';
import { $createImageNode } from '../nodes/ImageNode';
import { $createVideoNode } from '../nodes/VideoNode';
import { $createWebEmbedNode } from '../nodes/WebEmbedNode';
import {
  isEmbeddableWebUrl,
  isTwitterStatusUrl,
  normalizeEmbeddableWebUrl
} from '../utils/web-embed-classify';
import { extractAltFromUrl, isHttpsImageUrl } from '../utils/remote-image-url';
import { isYouTubeUrl } from '../utils/video-url';
import { classifyMarkdownImageLine } from '../utils/markdown-image';
import { normalizeWebBrowserUrl } from '../../../common/web-embed-url';

/**
 * True when pasted clipboard text should become a web embed: a single,
 * whitespace-free, embeddable webpage URL (public HTTPS or local/private
 * browser HTTP(S), not image/YouTube/local video). Classification is delegated to the
 * shared `isEmbeddableWebUrl` so the paste path agrees with the markdown
 * import dispatch.
 */
export function isStandaloneWebEmbedPaste(plainText: string): boolean {
  const text = plainText.trim();
  if (text.length === 0) {
    return false;
  }
  // Standalone URL only: any internal whitespace means prose or a multi-line
  // paste, and markdown links carry brackets that fail isEmbeddableWebUrl anyway.
  if (/\s/.test(text)) {
    return false;
  }
  return isTwitterStatusUrl(text) || isEmbeddableWebUrl(text);
}

const URL_LIST_MARKER_RE = /^(?:[-*+]\s+|\d+\.\s+)?(.+)$/;

const parseUrlListPaste = (plainText: string): string[] | null => {
  const lines = plainText
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length < 2) {
    return null;
  }

  const urls: string[] = [];
  for (const line of lines) {
    const candidate = URL_LIST_MARKER_RE.exec(line)?.[1]?.trim() ?? '';
    if (!candidate || /\s/.test(candidate)) {
      return null;
    }
    try {
      const parsed = new URL(candidate);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return null;
      }
      urls.push(candidate);
    } catch {
      return null;
    }
  }
  return urls.length > 0 ? urls : null;
};

const createUrlPasteNode = (url: string): LexicalNode => {
  const browserUrl = normalizeWebBrowserUrl(url) ?? url;
  if (isTwitterStatusUrl(browserUrl)) {
    return $createWebEmbedNode(browserUrl);
  }
  if (isYouTubeUrl(browserUrl)) {
    return $createVideoNode(browserUrl, 'YouTube video');
  }
  if (isHttpsImageUrl(browserUrl)) {
    return $createImageNode(browserUrl, extractAltFromUrl(browserUrl));
  }
  const embedUrl = normalizeEmbeddableWebUrl(url);
  if (embedUrl) {
    const paragraph = $createParagraphNode();
    paragraph.append($createEmbedPillNode(embedUrl));
    return paragraph;
  }
  const paragraph = $createParagraphNode();
  paragraph.append($createTextNode(url));
  return paragraph;
};

const isSelectionInEmptyParagraph = (): boolean => {
  const selection = $getSelection();
  if (!$isRangeSelection(selection) || !selection.isCollapsed()) {
    return false;
  }
  const anchorNode = selection.anchor.getNode();
  const topLevel = $isParagraphNode(anchorNode)
    ? anchorNode
    : anchorNode.getTopLevelElementOrThrow();
  return $isParagraphNode(topLevel) && topLevel.getTextContent().trim().length === 0;
};

export function registerWebpageEmbedPaste(editor: LexicalEditor): () => void {
  return editor.registerCommand(
    PASTE_COMMAND,
    (event) => {
      const isClipboardEvent =
        typeof ClipboardEvent !== 'undefined'
          ? objectKlassEquals(event, ClipboardEvent)
          : event && typeof event === 'object' && 'clipboardData' in event;

      if (!isClipboardEvent) {
        return false;
      }

      const clipboardData = (event as ClipboardEvent).clipboardData;
      if (!clipboardData) {
        return false;
      }

      const plainText = clipboardData.getData('text/plain')?.trim() ?? '';
      const markdownImage = classifyMarkdownImageLine(plainText);
      if (markdownImage?.kind === 'web-embed') {
        let shouldInsertEmbed = false;
        editor.getEditorState().read(() => {
          shouldInsertEmbed = isSelectionInEmptyParagraph();
        });
        if (!shouldInsertEmbed) {
          return false;
        }

        event.preventDefault();
        (event as ClipboardEvent).stopPropagation();
        editor.update(() => {
          const selection = $getSelection();
          if (!$isRangeSelection(selection)) {
            return;
          }
          selection.insertNodes([
            $createWebEmbedNode(markdownImage.src, markdownImage.altText)
          ]);
        });
        return true;
      }

      const urlList = parseUrlListPaste(plainText);
      if (urlList) {
        event.preventDefault();
        (event as ClipboardEvent).stopPropagation();

        editor.update(() => {
          const selection = $getSelection();
          if (!$isRangeSelection(selection)) {
            return;
          }
          selection.insertNodes(urlList.map(createUrlPasteNode));
        });

        return true;
      }

      if (!isStandaloneWebEmbedPaste(plainText)) {
        return false;
      }

      let shouldInsertEmbed = false;
      editor.getEditorState().read(() => {
        shouldInsertEmbed = isSelectionInEmptyParagraph();
      });
      if (!shouldInsertEmbed) {
        return false;
      }

      event.preventDefault();
      (event as ClipboardEvent).stopPropagation();

      editor.update(() => {
        const selection = $getSelection();
        if (!$isRangeSelection(selection)) {
          return;
        }
        const browserUrl = normalizeWebBrowserUrl(plainText) ?? plainText;
        const embedUrl = normalizeEmbeddableWebUrl(plainText);
        selection.insertNodes([
          isTwitterStatusUrl(browserUrl)
            ? $createWebEmbedNode(browserUrl)
            : $createEmbedPillNode(embedUrl ?? browserUrl)
        ]);
      });

      return true;
    },
    COMMAND_PRIORITY_LOW
  );
}

export function WebpageEmbedPastePlugin(): null {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    return registerWebpageEmbedPaste(editor);
  }, [editor]);

  return null;
}
