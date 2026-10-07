// ported-from: packages/desktop/src/renderer/editor/MarkdownEditor.tsx @ 762abb777 (extracted)
import { $isListItemNode, $isListNode, type ListNode } from '@lexical/list';
import { $getRoot } from 'lexical';
import type { CommentMetadataMap } from '../../../common/markdown-layers';
import type { NoteLayoutMetadata } from '../../../common/noteTypes';
import { isMossCanvasFenceName, scanMossHtmlFenceBlocks } from '../../../common/markdown-fences';
import { $processCommentMarkers, normalizeCommentWrappedAtxHeadings, normalizeCommentWrappedImages } from '../utils/comment-import';
import { type NestedContentOptions, importMarkdownIntoNestedContent } from '../utils/nested-editable-block';
import { DEFAULT_THEME } from '../plugins/code-block/themes';
import { $createChartNode } from '../nodes/ChartNode';
import { parseChartConfig } from '../utils/chartDefaults';
import { $createSketchNode, parseSketchBlock } from '../nodes/SketchNode';
import { $createVideoNode } from '../nodes/VideoNode';
import { extractYouTubeVideoId, isLocalVideoPath } from '../utils/video-url';
import { normalizeEmbeddableWebUrl } from '../utils/web-embed-classify';
import { $createCodeBlockNode, markCodeBlockForAutoEdit } from '../nodes/CodeBlockNode';
import { $createCalloutNode, CalloutNode, parseCalloutContent } from '../nodes/CalloutNode';
import { $applyTabGroupLayoutMetadata, $applyTableLayoutMetadata, CALLOUT_NESTED_CONTENT_OPTIONS, getCalloutContentTransformers, trimRawWebEmbedUrl } from './transformers';
// moss-multi seam: linear-match (A§12; SP2)
import { escapedBlockquoteSearchEnd, formattedPillTargets, replaceFormattedTargets, stripWikiLinkDelimiters } from './linear-match';

type PostImportNormalizeOptions = Pick<NestedContentOptions, 'excludedDependencies'> & {
  layoutMetadata?: NoteLayoutMetadata;
  // When true, an empty code block produced by this conversion is marked for
  // auto-edit so its decorator mounts in edit mode with the textarea focused.
  // Set only on the live editing path (markdown `\`\`\`` shortcut / pasted
  // empty fence) — never during disk import, which would steal focus on load.
  autoEditEmptyBlocks?: boolean;
};

export function $convertMossCustomCodeNodes(
  root: import('lexical').ElementNode = $getRoot(),
  options: PostImportNormalizeOptions = {}
): void {
  const codeNodes = root.getChildren().filter(
    (node): node is import('@lexical/code').CodeNode =>
      node.getType() === 'code'
  );
  const excludedDependencies = options.excludedDependencies ?? [];
  const shouldConvertCallouts = !excludedDependencies.includes(CalloutNode);
  const autoEditEmptyBlocks = options.autoEditEmptyBlocks ?? false;

  const replaceWithCodeBlock = (codeNode: import('@lexical/code').CodeNode, language?: string | null): void => {
    const code = codeNode.getTextContent();
    let lang = language || 'plaintext';
    let codeTheme = DEFAULT_THEME;
    const themeSep = lang.indexOf('--');
    if (themeSep !== -1) {
      codeTheme = lang.slice(themeSep + 2) || DEFAULT_THEME;
      lang = lang.slice(0, themeSep) || 'plaintext';
    }
    const codeBlockNode = $createCodeBlockNode(code, lang);
    if (codeTheme !== DEFAULT_THEME) {
      codeBlockNode.setTheme(codeTheme);
    }
    // Match slash-command behavior: an empty block typed via the markdown
    // shortcut should open in edit mode with the textarea focused.
    if (autoEditEmptyBlocks && code === '') {
      markCodeBlockForAutoEdit(codeBlockNode.getKey());
    }
    codeNode.replace(codeBlockNode);
  };

  for (const codeNode of codeNodes) {
    const language = codeNode.getLanguage();

    if (language === 'moss-chart') {
      const jsonContent = codeNode.getTextContent();
      const result = parseChartConfig(jsonContent);
      if (result.valid && result.config) {
        const chartNode = $createChartNode(result.config);
        codeNode.replace(chartNode);
      } else {
        // Invalid chart config: convert to CodeBlockNode preserving moss-chart language
        // so fixing the JSON restores the chart on next load
        const codeBlockNode = $createCodeBlockNode(jsonContent, 'moss-chart');
        codeNode.replace(codeBlockNode);
      }
    } else if (language === 'moss-callout') {
      const calloutContent = codeNode.getTextContent();
      if (!shouldConvertCallouts) {
        replaceWithCodeBlock(codeNode, 'moss-callout');
        continue;
      }
      const parsed = parseCalloutContent(calloutContent);
      if (parsed) {
        const calloutNode = $createCalloutNode(parsed.calloutType, undefined, parsed.level);
        importMarkdownIntoNestedContent(
          parsed.content,
          getCalloutContentTransformers(),
          calloutNode,
          (container, options) => $postImportNormalize(undefined, container, options),
          CALLOUT_NESTED_CONTENT_OPTIONS
        );
        codeNode.replace(calloutNode);
      } else {
        // Invalid callout: convert to CodeBlockNode preserving language
        const codeBlockNode = $createCodeBlockNode(calloutContent, 'moss-callout');
        codeNode.replace(codeBlockNode);
      }
    } else if (isMossCanvasFenceName(language)) {
      const gridContent = codeNode.getTextContent();
      if (gridContent.trim()) {
        const { grid, labels } = parseSketchBlock(gridContent);
        const sketchNode = $createSketchNode(grid, labels);
        codeNode.replace(sketchNode);
      } else {
        replaceWithCodeBlock(codeNode, language);
      }
    } else if (language === 'moss-video') {
      const src = codeNode.getTextContent().trim();
      if (extractYouTubeVideoId(src) || isLocalVideoPath(src)) {
        const videoNode = $createVideoNode(src);
        codeNode.replace(videoNode);
      } else {
        const codeBlockNode = $createCodeBlockNode(src, 'moss-video');
        codeNode.replace(codeBlockNode);
      }
    } else {
      // Convert all other CodeNodes to CodeBlockNode for consistent inline toolbar UX
      // Parse optional theme from info string: "language--theme" (e.g., "javascript--solarized")
      replaceWithCodeBlock(codeNode, language);
    }
  }
}

/**
 * Post-import normalization: merges adjacent different-type ListNodes that
 * represent nested lists. Lexical's `listReplace` only merges same-type lists,
 * so a checklist followed by an indented bullet list creates two separate
 * root-level ListNodes. Lexical's `setIndent` (called in `listReplace`) already
 * converts indent into structural nesting via `$handleIndent`, creating the
 * "container" ListItemNode pattern (childrenSize=1, child=ListNode) that
 * `$listExport` expects. We just need to move these container items from the
 * second list into the first list.
 */
function $normalizeIndentedListNesting(parent: import('lexical').ElementNode = $getRoot()): void {
  let node = parent.getFirstChild();
  while (node) {
    if (!$isListNode(node)) {
      node = node.getNextSibling();
      continue;
    }

    const nextSibling = node.getNextSibling();
    if (!$isListNode(nextSibling)) {
      node = node.getNextSibling();
      continue;
    }

    // Check if ALL items in the next list are structural containers
    // (childrenSize=1, child is ListNode) — created by setIndent in listReplace
    const nextItems = nextSibling.getChildren();
    const allContainers = nextItems.length > 0 && nextItems.every(
      (item) => $isListItemNode(item) && item.getChildrenSize() === 1 && $isListNode(item.getFirstChild())
    );

    if (!allContainers) {
      node = node.getNextSibling();
      continue;
    }

    // Move all container items from the next list into the current list
    for (const item of nextItems) {
      (node as ListNode).append(item);
    }
    nextSibling.remove();

    // Don't advance — check if the next sibling also needs merging
    continue;
  }
}

/**
 * Consolidated post-import normalization. Call after $convertFromMarkdownString.
 * Centralizes all tree transforms so each normalizer only needs to be added here.
 */
export function $postImportNormalize(
  commentMetadata?: CommentMetadataMap,
  root?: import('lexical').ElementNode,
  options: PostImportNormalizeOptions = {}
): void {
  $convertMossCustomCodeNodes(root, options);
  $normalizeIndentedListNesting(root);
  if (commentMetadata) {
    $processCommentMarkers(commentMetadata);
  }
  $applyTableLayoutMetadata(options.layoutMetadata, root);
  $applyTabGroupLayoutMetadata(options.layoutMetadata, root);
}

// HTML entity preservation: Lexical's markdown parser interprets HTML entities
// (e.g. &#160;) as their character equivalents, losing the original syntax.
// Escape before import, unescape after export to preserve round-trip fidelity.
const HTML_ENTITY_RE = /&(#\d+|#x[\da-fA-F]+|[a-zA-Z]+);/g;

const ESCAPED_ENTITY_RE = /\u200B&(#\d+|#x[\da-fA-F]+|[a-zA-Z]+);\u200B/g;

const ESCAPED_BLOCKQUOTE_BLOCK_RE = /&lt;blockquote\b[\s\S]*?&lt;\/blockquote&gt;/gi;

const FENCED_CODE_BLOCK_RE = /```[\s\S]*?```/g;

const mapOutsideInlineCodeSpans = (
  segment: string,
  transform: (segment: string) => string
): string => {
  const isEscaped = (index: number): boolean => {
    let slashCount = 0;
    let cursor = index - 1;
    while (cursor >= 0 && segment[cursor] === '\\') {
      slashCount += 1;
      cursor -= 1;
    }
    return slashCount % 2 === 1;
  };

  let cursor = 0;
  let output = '';
  let i = 0;

  while (i < segment.length) {
    if (segment[i] !== '`' || isEscaped(i)) {
      i += 1;
      continue;
    }

    let tickCount = 1;
    while (i + tickCount < segment.length && segment[i + tickCount] === '`') {
      tickCount += 1;
    }

    const delimiter = '`'.repeat(tickCount);
    const closeIndex = segment.indexOf(delimiter, i + tickCount);
    if (closeIndex === -1) {
      i += tickCount;
      continue;
    }

    output += transform(segment.slice(cursor, i));
    output += segment.slice(i, closeIndex + tickCount);
    cursor = closeIndex + tickCount;
    i = cursor;
  }

  if (cursor === 0) {
    return transform(segment);
  }

  output += transform(segment.slice(cursor));
  return output;
};

const escapeHtmlEntitiesOutsideEscapedBlockquotes = (md: string): string => {
  ESCAPED_BLOCKQUOTE_BLOCK_RE.lastIndex = 0;
  let cursor = 0;
  let escaped = '';
  let match: RegExpExecArray | null;
  const searchable = md.slice(0, escapedBlockquoteSearchEnd(md)); // moss-multi seam: linear-match (A§12; SP2)

  while ((match = ESCAPED_BLOCKQUOTE_BLOCK_RE.exec(searchable)) !== null) { // moss-multi seam: linear-match (A§12; SP2)
    const matchStart = match.index;
    const matchEnd = matchStart + match[0].length;

    escaped += md.slice(cursor, matchStart).replace(HTML_ENTITY_RE, '\u200B&$1;\u200B');
    escaped += match[0];
    cursor = matchEnd;
  }

  if (cursor === 0) {
    return md.replace(HTML_ENTITY_RE, '\u200B&$1;\u200B');
  }

  escaped += md.slice(cursor).replace(HTML_ENTITY_RE, '\u200B&$1;\u200B');
  return escaped;
};

export const escapeHtmlEntities = (md: string): string => {
  if (!md.includes('moss-html')) {
    return escapeHtmlEntitiesOutsideEscapedBlockquotes(md);
  }

  const lines = md.split('\n');
  const mossHtmlBlocks = [...scanMossHtmlFenceBlocks(lines)]
    .filter((item) => item.kind === 'block')
    .map(({ block }) => ({
      startLineIndex: block.headerLineIndex,
      endLineIndex: block.closingLineIndex
    }));

  if (mossHtmlBlocks.length === 0) {
    return escapeHtmlEntitiesOutsideEscapedBlockquotes(md);
  }

  const parts: string[] = [];
  let cursorLineIndex = 0;

  for (const block of mossHtmlBlocks) {
    if (cursorLineIndex < block.startLineIndex) {
      parts.push(
        escapeHtmlEntitiesOutsideEscapedBlockquotes(
          lines.slice(cursorLineIndex, block.startLineIndex).join('\n')
        )
      );
    }
    parts.push(lines.slice(block.startLineIndex, block.endLineIndex + 1).join('\n'));
    cursorLineIndex = block.endLineIndex + 1;
  }

  if (cursorLineIndex < lines.length) {
    parts.push(
      escapeHtmlEntitiesOutsideEscapedBlockquotes(lines.slice(cursorLineIndex).join('\n'))
    );
  }

  return parts.join('\n');
};

const mapOutsideFencedCodeBlocks = (
  md: string,
  transform: (segment: string) => string
): string => {
  FENCED_CODE_BLOCK_RE.lastIndex = 0;
  let cursor = 0;
  let output = '';
  let match: RegExpExecArray | null;

  while ((match = FENCED_CODE_BLOCK_RE.exec(md)) !== null) {
    const start = match.index;
    const end = start + match[0].length;
    output += mapOutsideInlineCodeSpans(md.slice(cursor, start), transform);
    output += match[0];
    cursor = end;
  }

  if (cursor === 0) {
    return mapOutsideInlineCodeSpans(md, transform);
  }

  output += mapOutsideInlineCodeSpans(md.slice(cursor), transform);
  return output;
};

// Like mapOutsideFencedCodeBlocks but without the inner mapOutsideInlineCodeSpans
// call, so transforms can see backtick delimiters. Used for inline code span
// merging and (re-exported) as the single fence-walking implementation shared
// with comment-import's image normalization.
export const mapOutsideFencedCodeBlocksOnly = (
  md: string,
  transform: (segment: string) => string
): string => {
  FENCED_CODE_BLOCK_RE.lastIndex = 0;
  let cursor = 0;
  let output = '';
  let match: RegExpExecArray | null;
  while ((match = FENCED_CODE_BLOCK_RE.exec(md)) !== null) {
    output += transform(md.slice(cursor, match.index));
    output += match[0];
    cursor = match.index + match[0].length;
  }
  if (cursor === 0) return transform(md);
  output += transform(md.slice(cursor));
  return output;
};

/**
 * Lexical can emit cross-nested delimiters when inline format spans straddle
 * highlight boundaries (for example `**<mark>text</mark> rest**` becoming
 * `<mark>**text</mark>&#32;rest**`). Normalize these patterns back to a stable,
 * valid markdown shape after export.
 */
export const normalizeHighlightFormattingBoundaries = (md: string): string => {
  return mapOutsideFencedCodeBlocks(md, (segment) => {
    const decodeGeneratedSpaces = (value: string): string => value.replace(/&#32;/g, ' ');
    let normalized = segment;

    // Unescape bold/italic/strike delimiters that Lexical escaped at highlight boundaries.
    // Pattern: `\*\*<mark...>text\*\*` → `**<mark...>text**` (then the next regex normalizes it)
    normalized = normalized.replace(
      /\\(\*{1,2}|~{2})(<mark data-color="\w+"(?:\s+style="[^"]*")?>[^<]*?)\\(\1)/g,
      (_match, open: string, middle: string, close: string) => `${open}${middle}${close}`
    );
    // Reverse: `</mark>\*\*text\*\*<mark` → `</mark>**text**<mark`
    normalized = normalized.replace(
      /<\/mark>\\(\*{1,2}|~{2})(<[^>]*>)?([^<\\]*?)\\(\1)/g,
      (_match, open: string, tag: string | undefined, middle: string, close: string) =>
        `</mark>${open}${tag ?? ''}${middle}${close}`
    );

    normalized = normalized.replace(
      /<mark data-color="(\w+)"((?:\s+style="[^"]*")?)>(\*\*|~~|\*)((?:(?!\3)[^<])*)<\/mark>([^\n]*?)\3/g,
      (_match, colorName: string, styleAttribute: string, delimiter: string, innerText: string, trailing: string) =>
        `${delimiter}<mark data-color="${colorName}"${styleAttribute}>${innerText}</mark>${decodeGeneratedSpaces(trailing)}${delimiter}`
    );

    normalized = normalized.replace(
      /==(\*\*|~~|\*)((?:(?!\1)[^=\n])*)==([^\n]*?)\1/g,
      (_match, delimiter: string, innerText: string, trailing: string) =>
        `${delimiter}==${innerText}==${decodeGeneratedSpaces(trailing)}${delimiter}`
    );

    // Comment anchors can split bold/strike/italic delimiters around highlighted
    // spans, e.g. `%%m:id:start%%**<mark>text**</mark>%%m:id:end%%%% tail**`.
    // Normalize this into a stable shape where the delimiter wraps both the
    // commented highlight and the trailing text.
    normalized = normalized.replace(
      /(\{%c:[^%]+%\}|%%m:[^%]+:start%%)(\*\*|~~|\*)<mark data-color="(\w+)"((?:\s+style="[^"]*")?)>((?:(?!\2)[^<])*)\2<\/mark>(\{%\/c%\}|%%m:[^%]+:end%%)\2([^\n]*?)\2/g,
      (
        _match,
        openComment: string,
        delimiter: string,
        colorName: string,
        styleAttribute: string,
        innerText: string,
        closeComment: string,
        trailing: string
      ) =>
        `${delimiter}${openComment}<mark data-color="${colorName}"${styleAttribute}>${innerText}</mark>${closeComment}${decodeGeneratedSpaces(trailing)}${delimiter}`
    );

    // Equivalent comment-split case for Obsidian highlight syntax, e.g.
    // `%%m:id:start%%**==text**==%%m:id:end%%%% tail**`.
    normalized = normalized.replace(
      /(\{%c:[^%]+%\}|%%m:[^%]+:start%%)(\*\*|~~|\*)==((?:(?!\2)[^=\n])*)\2==(\{%\/c%\}|%%m:[^%]+:end%%)\2([^\n]*?)\2/g,
      (
        _match,
        openComment: string,
        delimiter: string,
        innerText: string,
        closeComment: string,
        trailing: string
      ) =>
        `${delimiter}${openComment}==${innerText}==${closeComment}${decodeGeneratedSpaces(trailing)}${delimiter}`
    );

    // Merge adjacent same-format spans: **A** **B** → **A B**
    // Produced by FormatWhitespaceBoundaryPlugin splitting formatted nodes
    normalized = normalized.replace(/(?<!\*)\*\*([ \t]+)\*\*(?!\*)/g, '$1');
    normalized = normalized.replace(/(?<=\S)(?<!\*)\*([ \t]+)\*(?!\*)/g, '$1');
    normalized = normalized.replace(/(?<!~)~~([ \t]+)~~(?!~)/g, '$1');

    return normalized;
  });
};

/**
 * Find formatting delimiter pairs inside highlight content and rebuild the
 * string with delimiters moved outside their highlight wrappers.
 *
 * Returns `null` when no complete delimiter pairs are found (caller should
 * return the original match unchanged).
 *
 * @param content  The raw text between highlight markers (e.g. between `<mark>` tags)
 * @param wrapSegment  Wraps a plain-text segment in the highlight syntax
 */
const splitFormattingFromHighlightContent = (
  content: string,
  wrapSegment: (text: string) => string
): string | null => {
  // Longest-first alternation so `**` is tried before `*`
  const delimRe = /(\*\*|~~|\*)((?:(?!\1)[^\n])+?)\1/g;
  if (!delimRe.test(content)) return null;
  delimRe.lastIndex = 0;

  let result = '';
  let lastIndex = 0;
  let match;

  while ((match = delimRe.exec(content)) !== null) {
    const [full, delimiter, innerText] = match;
    const before = content.slice(lastIndex, match.index);
    if (before) result += wrapSegment(before);
    result += wrapSegment(`${delimiter}${innerText}${delimiter}`);
    lastIndex = match.index + full.length;
  }

  const after = content.slice(lastIndex);
  if (after) result += wrapSegment(after);

  return result;
};

export const normalizeRichTextInsideHighlightsForImport = (md: string): string => {
  return mapOutsideFencedCodeBlocks(md, (segment) => {
    let normalized = segment;

    // Import-only canonicalization: move rich-text delimiters outside highlight
    // syntax so markdown parsing preserves formatting semantics.
    // Handles both full-wrap (`<mark>**all bold**</mark>`) and partial-wrap
    // (`<mark>**bold** rest</mark>`) by splitting at delimiter boundaries.
    normalized = normalized.replace(
      /<mark data-color="(\w+)"((?:\s+style="[^"]*")?)>([^<\n]+)<\/mark>/g,
      (fullMatch, colorName: string, styleAttribute: string, content: string) =>
        splitFormattingFromHighlightContent(
          content,
          (t) => `<mark data-color="${colorName}"${styleAttribute}>${t}</mark>`
        ) ?? fullMatch
    );

    normalized = normalized.replace(
      /(\{%c:[^%]+%\}|%%m:[^%]+:start%%)<mark data-color="(\w+)"((?:\s+style="[^"]*")?)>([^<\n]+)<\/mark>(\{%\/c%\}|%%m:[^%]+:end%%)/g,
      (fullMatch, openComment: string, colorName: string, styleAttribute: string, content: string, closeComment: string) => {
        const split = splitFormattingFromHighlightContent(
          content,
          (t) => `<mark data-color="${colorName}"${styleAttribute}>${t}</mark>`
        );
        if (!split) return fullMatch;
        return split.replace(
          /(<mark data-color="\w+"(?:\s+style="[^"]*")?>)/,
          `${openComment}$1`
        ).replace(
          /(<\/mark>)(?!.*<\/mark>)/,
          `$1${closeComment}`
        );
      }
    );

    normalized = normalized.replace(
      /==([^=\n]+)==/g,
      (fullMatch, content: string) =>
        splitFormattingFromHighlightContent(content, (t) => `==${t}==`) ?? fullMatch
    );

    normalized = normalized.replace(
      /(\{%c:[^%]+%\}|%%m:[^%]+:start%%)==([^=\n]+)==(\{%\/c%\}|%%m:[^%]+:end%%)/g,
      (fullMatch, openComment: string, content: string, closeComment: string) => {
        const split = splitFormattingFromHighlightContent(content, (t) => `==${t}==`);
        if (!split) return fullMatch;
        return split.replace(
          /(==)/,
          `${openComment}$1`
        ).replace(
          /(==)(?!.*==)/,
          `$1${closeComment}`
        );
      }
    );

    return normalized;
  });
};

/**
 * Recover fully-escaped bold/italic delimiters produced by format-loss corruption.
 *
 * When bold/italic format is lost from a TextNode, the `**`/`*` delimiters become
 * literal text. Lexical's export then escapes them (`\*\*text\*\*`), and on reimport
 * the escaped asterisks are treated as literal characters — permanently losing the
 * formatting. This normalization unescapes symmetric pairs so the import pipeline
 * can re-apply the formatting.
 *
 * Runs inside mapOutsideFencedCodeBlocks (which also excludes inline code spans).
 */
export const recoverEscapedEmphasis = (md: string): string => {
  return mapOutsideFencedCodeBlocks(md, (segment) => {
    let result = segment;
    // Link labels can pick up an extra real bold pair around escaped bold
    // delimiters after repeated comment/edit round-trips:
    // [**\***\*text\*\*](url) -> [**text**](url)
    result = result.replace(
      /\[\*\*\\\*\*\*\\\*((?:\\.|[^\]\\])+?)\\\*\\\*\]\(([^()\s]*(?:\([^()]*\)[^()\s]*)*)\)/g,
      '[**$1**]($2)'
    );
    // Bold: \*\*text\*\* → **text**
    result = result.replace(/\\\*\\\*([^\n]+?)\\\*\\\*/g, '**$1**');
    // Italic: \*text\* → *text* (not preceded/followed by \*)
    result = result.replace(/(?<!\\\*)\\\*([^\n*]+?)\\\*(?!\\\*)/g, '*$1*');
    return result;
  });
};

// Unicode Zs (space separator) characters that Lexical's WHITESPACE regex
// (/[ \t\n\r\f]/) does not recognize. These break emphasis flanking-delimiter
// checks when adjacent to punctuation. CommonMark treats all Zs as whitespace.
const UNICODE_SPACE_SEPARATOR_RE = /[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/g;

/** Strip bold/italic/strikethrough delimiters that solely wrap a wiki-link.
 *  DecoratorNodes can't carry text format, so these delimiters would become
 *  literal text after import. E.g. **[[My Note]]** → [[My Note]]. */
export const stripFormattingAroundIsolatedWikiLinks = (md: string): string => {
  return mapOutsideFencedCodeBlocks(md, (segment) => {
    // moss-multi seam: linear-match (A§12; SP2): segment.replace(/(\*{1,2}|~~)\[\[((?:[^\]]|\](?!\]))+)\]\]\1/g, '[[$2]]')
    return stripWikiLinkDelimiters(segment);
  });
};

const FORMATTED_EMBED_PILL_TARGET_RE =
  /\?\[((?:\\.|[^\]\\])*)\]\(([^()\s]*(?:\([^()]*\)[^()\s]*)*)\)|https?:\/\/[^\s<>{}|\\^[\]`*~]+/g;

const wrapFormattedImportSegment = (value: string, delimiter: string): string => {
  const leading = value.match(/^\s*/)?.[0] ?? '';
  const trailing = value.match(/\s*$/)?.[0] ?? '';
  const core = value.slice(leading.length, value.length - trailing.length);
  return core ? `${leading}${delimiter}${core}${delimiter}${trailing}` : value;
};

const isMarkdownLinkDestination = (value: string, start: number): boolean =>
  start >= 2 && value[start - 1] === '(' && value[start - 2] === ']';

const normalizeFormattedEmbedPillTargetsInContent = (
  content: string,
  delimiter: string
): string | null => {
  let cursor = 0;
  let normalized = '';
  let converted = false;

  // moss-multi seam: linear-match (A§12; SP2): while ((match = FORMATTED_EMBED_PILL_TARGET_RE.exec(content)) !== null), from lastIndex 0
  for (const match of formattedPillTargets(content, FORMATTED_EMBED_PILL_TARGET_RE)) {
    const [rawMatch, _legacyText, legacyUrl] = match;
    const start = match.index;
    const isLegacyPill = rawMatch.startsWith('?[');
    const rawUrl = isLegacyPill ? legacyUrl : rawMatch;
    const url = trimRawWebEmbedUrl(rawUrl);
    const normalizedUrl = normalizeEmbeddableWebUrl(url);

    if (
      !normalizedUrl ||
      (!isLegacyPill && isMarkdownLinkDestination(content, start))
    ) {
      continue;
    }

    normalized += wrapFormattedImportSegment(content.slice(cursor, start), delimiter);
    normalized += `${delimiter}${normalizedUrl}${delimiter}`;
    cursor = start + (isLegacyPill ? rawMatch.length : url.length);
    converted = true;
  }

  if (!converted) {
    return null;
  }

  normalized += wrapFormattedImportSegment(content.slice(cursor), delimiter);
  return normalized;
};

export const normalizeFormattingAroundEmbedPillTargets = (md: string): string => {
  return mapOutsideFencedCodeBlocks(md, (segment) => {
    const normalizeDelimiter = (value: string, delimiter: string): string => {
      const escapedDelimiter =
        delimiter === '*'
          ? '(?<!\\*)\\*(?!\\*)'
          : delimiter === '**'
            ? '(?<!\\*)\\*\\*(?!\\*)'
            : '(?<!~)~~(?!~)';
      const regExp = new RegExp(
        `${escapedDelimiter}([^\\n]*?(?:https?:\\/\\/|\\?\\[)[^\\n]*?)${escapedDelimiter}`,
        'g'
      );
      // moss-multi seam: linear-match (A§12; SP2): value.replace(regExp, ...), line by line up to the last match
      return replaceFormattedTargets(value, delimiter, regExp, (fullMatch, content: string) => {
        const normalized = normalizeFormattedEmbedPillTargetsInContent(content, delimiter);
        return normalized ?? fullMatch;
      });
    };

    return normalizeDelimiter(
      normalizeDelimiter(
        normalizeDelimiter(segment, '**'),
        '~~'
      ),
      '*'
    );
  });
};

export const normalizeMarkdownForImport = (md: string): string => {
  // Replace Unicode space separators (NBSP, thin space, etc.) with regular
  // spaces outside code blocks and inline code spans. Without this, Lexical's
  // emphasis parser rejects closing delimiters preceded by punctuation (e.g.
  // `)**`) when followed by NBSP, because NBSP fails the flanking check.
  const normalized = mapOutsideFencedCodeBlocks(md, (s) =>
    s.replace(UNICODE_SPACE_SEPARATOR_RE, ' ')
  );
  // Merge adjacent inline code spans before the main pipeline
  // (mapOutsideFencedCodeBlocks hides backtick delimiters, so this runs separately)
  const mergedCode = mapOutsideFencedCodeBlocksOnly(normalized, (s) =>
    s.replace(/(?<!`)`([ \t]+)`(?!`)/g, '$1')
  );
  // Recover escaped emphasis before other normalizations so highlight-boundary
  // patterns in normalizeHighlightFormattingBoundaries see clean delimiters.
  const recovered = recoverEscapedEmphasis(mergedCode);
  const strippedWikiLinks = stripFormattingAroundIsolatedWikiLinks(recovered);
  const normalizedRichText = normalizeHighlightFormattingBoundaries(
    normalizeRichTextInsideHighlightsForImport(
      normalizeCommentWrappedImages(normalizeCommentWrappedAtxHeadings(strippedWikiLinks))
    )
  );
  return normalizeFormattingAroundEmbedPillTargets(normalizedRichText);
};

export const unescapeHtmlEntities = (md: string): string =>
  normalizeHighlightFormattingBoundaries(md.replace(ESCAPED_ENTITY_RE, '&$1;'))
    // Lexical escapes boundary whitespace in formatted text to &#32; to keep
    // emphasis delimiters valid (e.g. **text&#32;**). Move the space outside the
    // closing/opening markers so on-disk markdown stays clean while delimiters
    // remain flanking-valid for reimport.
    .replace(/&#32;(\*{1,3}|_{1,3}|~~)(?=[^*_~]|$)/g, '$1 ')
    .replace(/(^|[^*_~])(\*{1,3}|_{1,3}|~~)&#32;/gm, '$1 $2');
