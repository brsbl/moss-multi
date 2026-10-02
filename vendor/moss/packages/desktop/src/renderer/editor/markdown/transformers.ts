// ported-from: packages/desktop/src/renderer/editor/MarkdownEditor.tsx @ 762abb777 (extracted)
import { $createHorizontalRuleNode, $isHorizontalRuleNode, HorizontalRuleNode } from '@lexical/react/LexicalHorizontalRuleNode';
import { $createTableCellNode, $createTableNode, $createTableRowNode, $isTableCellNode, $isTableNode, $isTableRowNode, TableCellHeaderStates, TableCellNode, TableNode, TableRowNode } from '@lexical/table';
import { $convertFromMarkdownString, $convertToMarkdownString, CHECK_LIST, ELEMENT_TRANSFORMERS, type ElementTransformer, MULTILINE_ELEMENT_TRANSFORMERS, type MultilineElementTransformer, TEXT_FORMAT_TRANSFORMERS, TEXT_MATCH_TRANSFORMERS, type TextMatchTransformer, type Transformer } from '@lexical/markdown';
import { CodeHighlightNode, CodeNode } from '@lexical/code-core';
import { $isMarkNode, MarkNode } from '@lexical/mark';
import { HeadingNode, QuoteNode } from '@lexical/rich-text';
import { $isListItemNode, ListItemNode, ListNode } from '@lexical/list';
import { $createLinkNode, $isLinkNode, AutoLinkNode, LinkNode } from '@lexical/link';
import { $findMatchingParent } from '@lexical/utils';
import { $createParagraphNode, $createTextNode, $getRoot, $getSelection, $isDecoratorNode, $isElementNode, $isLineBreakNode, $isParagraphNode, $isRangeSelection, $isRootNode, $isTextNode, $setSelection, type BaseSelection, IS_BOLD, IS_ITALIC, IS_STRIKETHROUGH, type LexicalNode, LineBreakNode, TextNode } from 'lexical';
import type { NoteLayoutMetadata } from '../../../common/noteTypes';
import { MOSS_CANVAS_FENCE_NAME, buildMarkdownFence } from '../../../common/markdown-fences';
import { $isCommentableDecorator } from '../utils/commentable-node';
import { parseFormulaMarkdownPayload, serializeFormulaMarkdownPayload } from '../utils/formula-runtime';
import { type NestedContentOptions, createNestedContentTransformers, exportNestedContentToMarkdown, importMarkdownIntoNestedContent } from '../utils/nested-editable-block';
import { DEFAULT_THEME } from '../plugins/code-block/themes';
import { $createFormulaNode, $isFormulaNode, FormulaNode } from '../nodes/FormulaNode';
import { $createFileLinkNode, $isFileLinkNode, FileLinkNode } from '../nodes/FileLinkNode';
import { $createEmbedPillNode, $isEmbedPillNode, EmbedPillNode, unescapeEmbedPillDisplayText } from '../nodes/EmbedPillNode';
import { $isChartNode, ChartNode, exportChartToMarkdown } from '../nodes/ChartNode';
import { $createImageNode, $isImageNode, ImageNode } from '../nodes/ImageNode';
import { $isSketchNode, SketchNode, buildSketchMarkdown } from '../nodes/SketchNode';
import { $createVideoNode, $isVideoNode, VideoNode } from '../nodes/VideoNode';
import { $createWebEmbedNode, $isWebEmbedNode, WebEmbedNode } from '../nodes/WebEmbedNode';
import { isYouTubeUrl } from '../utils/video-url';
import { extractAltFromUrl, isHttpsImageUrl } from '../utils/https-image-url';
import { classifyMarkdownImageLine } from '../utils/markdown-image';
import { isTwitterStatusUrl } from '../../../common/web-embed-url';
import { normalizeEmbeddableWebUrl } from '../utils/web-embed-classify';
import { $isCodeBlockNode, CodeBlockNode } from '../nodes/CodeBlockNode';
import { $isCalloutNode, CalloutNode, exportCalloutToMarkdown } from '../nodes/CalloutNode';
import { $createHtmlBlockquoteNode, HtmlBlockquoteNode } from '../nodes/HtmlBlockquoteNode';
import { $createTabGroupNode, $isTabGroupNode, TabGroupNode } from '../nodes/TabGroupNode';
import { $createTabPanelNode, TabPanelNode } from '../nodes/TabPanelNode';
import { $createColorCodeNode, $isColorCodeNode, ColorCodeNode } from '../nodes/ColorCodeNode';
import { COLOR_TRANSFORMER_IMPORT_REGEXP, COLOR_TRANSFORMER_REGEXP, isAfterUnclosedBacktick, isInsideInlineCodeSpan, isInsideUnclosedDelimiter } from '../utils/color-codes';
import { $isInsideColorSuppressedRawContext } from '../utils/colorPickerTriggers';
import { $postImportNormalize, unescapeHtmlEntities } from './normalize';
import { HIGHLIGHT_COLOR_VARIABLES, HIGHLIGHT_YELLOW_VALUE, HIGHLIGHT_YELLOW_VAR, SERIF_FONT_FAMILY_MARKDOWN_STYLE_PATTERN, getSerifFontFamilyMarkdownStyleAttribute, highlightColorNameFromStyle, isSerifFontFamilyValue, markdownStyleAttributeHasSerifFontFamily, setTextNodeFontFamily, unescapeInlineMarkdownText, wrapSerifFontFamilyMarkdownSpan } from './text-style';
// moss-multi seam: formula-ids, line-loss (A§12; S-conv B9, §1.2)
import { $rejectLine, importFormulaId } from './fixes';

// Custom transformer to preserve underlines in markdown
const UNDERLINE_TRANSFORMER: TextMatchTransformer = {
  dependencies: [TextNode],
  export: (node, _exportChildren, exportFormat) => {
    if (!$isTextNode(node)) {
      return null;
    }

    if (!node.hasFormat('underline')) {
      return null;
    }

    const text = node.getTextContent();
    const formatted = exportFormat ? exportFormat(node, text) : text;
    return `<u${getSerifFontFamilyMarkdownStyleAttribute(node)}>${formatted}</u>`;
  },
  importRegExp: /<u(?:\s+style="([^"]*font-family\s*:[^"]*serif[^"]*)")?>([^<]+)<\/u>/,
  regExp: /<u(?:\s+style="([^"]*font-family\s*:[^"]*serif[^"]*)")?>([^<]+)<\/u>$/,
  replace: (textNode, match) => {
    const [, styleAttribute, rawText] = match;
    const underlinedNode = $createTextNode(unescapeInlineMarkdownText(rawText));
    underlinedNode.setFormat(textNode.getFormat());
    underlinedNode.toggleFormat('underline');
    if (markdownStyleAttributeHasSerifFontFamily(styleAttribute)) {
      setTextNodeFontFamily(underlinedNode, 'serif');
    }
    textNode.replace(underlinedNode);
    return underlinedNode;
  },
  trigger: '>',
  type: 'text-match'
};

const HIGHLIGHT_TRANSFORMER: TextMatchTransformer = {
  dependencies: [TextNode],
  export: (node, _exportChildren, exportFormat) => {
    if (!$isTextNode(node)) {
      return null;
    }

    const style = node.getStyle();
    const colorName = highlightColorNameFromStyle(style);

    if (!colorName && !node.hasFormat('highlight')) {
      return null;
    }

    const text = node.getTextContent();
    const formatted = exportFormat ? exportFormat(node, text) : text;
    return `<mark data-color="${colorName ?? 'yellow'}"${getSerifFontFamilyMarkdownStyleAttribute(node)}>${formatted}</mark>`;
  },
  importRegExp: /<mark data-color="(\w+)"(?:\s+style="([^"]*font-family\s*:[^"]*serif[^"]*)")?>([^<]+)<\/mark>/,
  regExp: /<mark data-color="(\w+)"(?:\s+style="([^"]*font-family\s*:[^"]*serif[^"]*)")?>([^<]+)<\/mark>$/,
  replace: (textNode, match) => {
    const [, colorName, styleAttribute, rawText] = match;
    const highlightVariable = HIGHLIGHT_COLOR_VARIABLES[colorName] ?? HIGHLIGHT_YELLOW_VAR;

    const highlightedNode = $createTextNode(unescapeInlineMarkdownText(rawText));
    highlightedNode.setFormat(textNode.getFormat());
    highlightedNode.setStyle(`background-color: var(${highlightVariable})`);
    if (markdownStyleAttributeHasSerifFontFamily(styleAttribute)) {
      setTextNodeFontFamily(highlightedNode, 'serif');
    }
    textNode.replace(highlightedNode);
    return highlightedNode;
  },
  trigger: '>',
  type: 'text-match'
};

const FONT_FAMILY_TRANSFORMER: TextMatchTransformer = {
  dependencies: [TextNode],
  export: (node, _exportChildren, exportFormat) => {
    if (!$isTextNode(node)) {
      return null;
    }

    if (!isSerifFontFamilyValue(node.getStyle())) {
      return null;
    }

    const text = node.getTextContent();
    const formatted = exportFormat ? exportFormat(node, text) : text;
    return `<span style="font-family: serif">${formatted}</span>`;
  },
  importRegExp: new RegExp(`<span style="(${SERIF_FONT_FAMILY_MARKDOWN_STYLE_PATTERN})">([^<]+)<\\/span>`, 'i'),
  regExp: new RegExp(`<span style="(${SERIF_FONT_FAMILY_MARKDOWN_STYLE_PATTERN})">([^<]+)<\\/span>$`, 'i'),
  replace: (textNode, match) => {
    const [, styleAttribute, rawText] = match;
    if (!markdownStyleAttributeHasSerifFontFamily(styleAttribute)) {
      return;
    }
    const serifNode = $createTextNode(unescapeInlineMarkdownText(rawText));
    serifNode.setFormat(textNode.getFormat());
    setTextNodeFontFamily(serifNode, 'serif');
    textNode.replace(serifNode);
    return serifNode;
  },
  trigger: '>',
  type: 'text-match'
};

/**
 * Obsidian highlight syntax: ==text==
 * Preserves source syntax losslessly while rendering as a yellow highlight.
 */
const OBSIDIAN_HIGHLIGHT_TRANSFORMER: TextMatchTransformer = {
  dependencies: [TextNode],
  export: (node, _exportChildren, exportFormat) => {
    if (!$isTextNode(node)) {
      return null;
    }

    const style = node.getStyle();
    if (!style.includes('--obsidian-highlight')) {
      return null;
    }

    const text = node.getTextContent();
    const formatted = exportFormat ? exportFormat(node, text) : text;
    return `==${isSerifFontFamilyValue(style) ? wrapSerifFontFamilyMarkdownSpan(formatted) : formatted}==`;
  },
  importRegExp: /==(?:<span style="([^"]*font-family\s*:[^"]*serif[^"]*)">([^<]+)<\/span>|([^=\n]+))==/,
  regExp: /==(?:<span style="([^"]*font-family\s*:[^"]*serif[^"]*)">([^<]+)<\/span>|([^=\n]+))==$/,
  replace: (textNode, match) => {
    const [, styleAttribute, styledText, plainText] = match;
    const text = unescapeInlineMarkdownText(styledText ?? plainText);
    const highlightedNode = $createTextNode(text);
    highlightedNode.setFormat(textNode.getFormat());
    highlightedNode.setStyle(
      `background-color: ${HIGHLIGHT_YELLOW_VALUE}; --obsidian-highlight: true`
    );
    if (markdownStyleAttributeHasSerifFontFamily(styleAttribute)) {
      setTextNodeFontFamily(highlightedNode, 'serif');
    }
    textNode.replace(highlightedNode);
    return highlightedNode;
  },
  trigger: '=',
  type: 'text-match'
};

// Horizontal rule transformer for ---
const HORIZONTAL_RULE_TRANSFORMER: ElementTransformer = {
  dependencies: [HorizontalRuleNode],
  export: (node) => {
    if ($isHorizontalRuleNode(node)) {
      return '---';
    }
    return null;
  },
  // Match --- at start of line, optionally followed by whitespace
  regExp: /^-{3,}\s*$/,
  replace: (parentNode) => {
    const hrNode = $createHorizontalRuleNode();
    parentNode.replace(hrNode);
  },
  type: 'element'
};

// Formula transformer:
// - Legacy: {{formula|result}}
// - Extended: {{formula|result|id=...;name=...;stale=1}}
// Uses double-braces to avoid conflicts with inline markdown syntax.
const FORMULA_TRANSFORMER: TextMatchTransformer = {
  dependencies: [FormulaNode],
  export: (node) => {
    if (!$isFormulaNode(node)) {
      return null;
    }
    const payload = serializeFormulaMarkdownPayload({
      expression: node.getFormula(),
      result: node.getResult(),
      formulaId: node.getFormulaId(),
      name: node.getName(),
      stale: node.isStale()
    });
    return wrapInlineWithCommentMarkers(node, `{{${payload}}}`);
  },
  // Match {{payload}} and parse both legacy (formula|result) and metadata payloads
  importRegExp: /\{\{([^{}\n]+)\}\}/,
  // Match same pattern during live editing (must end with }})
  regExp: /\{\{([^{}\n]+)\}\}$/,
  replace: (textNode, match) => {
    if (textNode.hasFormat('code')) return;
    const [, payload] = match;
    const parsed = parseFormulaMarkdownPayload(payload);
    if (!parsed) {
      return;
    }
    const formulaNode = $createFormulaNode(parsed.expression, parsed.result, {
      // moss-multi seam: formula-ids (A§12; S-conv B9)
      ...(parsed.formulaId ? { formulaId: parsed.formulaId } : importFormulaId(payload)),
      ...(parsed.name ? { name: parsed.name } : {}),
      ...(parsed.stale ? { stale: true } : {})
    });
    textNode.replace(formulaNode);
  },
  trigger: '}',
  type: 'text-match'
};

/**
 * Color literal transformer: round-trips raw color values (hex bodies and the
 * functional rgb / hsl forms) between markdown text and inline
 * `ColorCodeNode` pills. Exports as the plain literal so persisted markdown
 * stays standard. Imports via `importRegExp` so initial markdown parsing
 * converts literals directly without waiting on the runtime mutation listener.
 *
 * The live `trigger` is `)` so a functional literal commits to a pill the
 * moment the closing paren is typed. Hex literals (no closing char) are
 * handled by `ColorCodePlugin`'s mutation listener or the typeahead path.
 */
const COLOR_TRANSFORMER: TextMatchTransformer = {
  dependencies: [ColorCodeNode],
  export: (node) => {
    if (!$isColorCodeNode(node)) return null;
    // getTextContent() yields the plain color literal so disk markdown stays
    // standard CSS.
    return node.getTextContent();
  },
  importRegExp: COLOR_TRANSFORMER_IMPORT_REGEXP,
  regExp: COLOR_TRANSFORMER_REGEXP,
  replace: (textNode, match) => {
    const value = match[1];
    if (!value) return;
    // Inline code keeps its literal characters — colors typed in `code`
    // spans stay raw text with no color UI.
    if (textNode.hasFormat('code')) return;
    const text = match.input ?? textNode.getTextContent();
    const offset = typeof match.index === 'number' ? match.index : text.lastIndexOf(value);
    if (offset >= 0 && isInsideInlineCodeSpan(text, offset)) return;
    if (offset >= 0 && isAfterUnclosedBacktick(text, offset)) return;
    if (offset >= 0 && isInsideUnclosedDelimiter(text, offset)) return;
    if (offset >= 0 && $isInsideColorSuppressedRawContext(textNode, offset)) return;
    textNode.replace($createColorCodeNode(value));
  },
  trigger: ')',
  type: 'text-match'
};

/**
 * Legacy embed-pill transformer: imports the pre-ship `?[displayText](url)`
 * syntax, but exports pills as raw URLs so Moss-specific rendering remains a
 * code-level enhancement over portable Markdown.
 */
const EMBED_PILL_SUPPORTED_TEXT_FORMAT = IS_BOLD | IS_ITALIC | IS_STRIKETHROUGH;

const markdownDelimiterToTextFormat = (delimiter: string): number => {
  if (delimiter === '***') {
    return IS_BOLD | IS_ITALIC;
  }
  if (delimiter === '**') {
    return IS_BOLD;
  }
  if (delimiter === '*') {
    return IS_ITALIC;
  }
  if (delimiter === '~~') {
    return IS_STRIKETHROUGH;
  }
  return 0;
};

const markdownWrapperPairToTextFormat = (opening: string, closing: string): number => {
  if (opening === closing) {
    return markdownDelimiterToTextFormat(opening);
  }
  const pairs = new Map<string, number>([
    ['~~**\0**~~', IS_STRIKETHROUGH | IS_BOLD],
    ['**~~\0~~**', IS_STRIKETHROUGH | IS_BOLD],
    ['~~*\0*~~', IS_STRIKETHROUGH | IS_ITALIC],
    ['*~~\0~~*', IS_STRIKETHROUGH | IS_ITALIC],
    ['~~***\0***~~', IS_STRIKETHROUGH | IS_BOLD | IS_ITALIC],
    ['***~~\0~~***', IS_STRIKETHROUGH | IS_BOLD | IS_ITALIC],
  ]);
  return pairs.get(`${opening}\0${closing}`) ?? 0;
};

const formatEmbedPillMarkdown = (markdown: string, textFormat: number): string => {
  let formatted = markdown;
  if (textFormat & IS_BOLD) {
    formatted = `**${formatted}**`;
  }
  if (textFormat & IS_ITALIC) {
    formatted = `*${formatted}*`;
  }
  if (textFormat & IS_STRIKETHROUGH) {
    formatted = `~~${formatted}~~`;
  }
  return formatted;
};

const EMBED_PILL_TRANSFORMER: TextMatchTransformer = {
  dependencies: [EmbedPillNode],
  export: (node) => {
    if (!$isEmbedPillNode(node)) {
      return null;
    }
    return wrapInlineWithCommentMarkers(
      node,
      formatEmbedPillMarkdown(node.getUrl(), node.getTextFormat() & EMBED_PILL_SUPPORTED_TEXT_FORMAT)
    );
  },
  importRegExp: /\?\[((?:\\.|[^\]\\])*)\]\(([^()\s]*(?:\([^()]*\)[^()\s]*)*)\)/,
  regExp: /\?\[((?:\\.|[^\]\\])*)\]\(([^()\s]*(?:\([^()]*\)[^()\s]*)*)\)$/,
  replace: (textNode, match) => {
    if (textNode.hasFormat('code')) return;
    const [, rawText, url] = match;
    if (!url) {
      return;
    }
    // Apply the shared classifier so an unsafe / non-embeddable target
    // (`?[x](https://127.0.0.1/)`, `?[x](file:///etc/passwd)`, image/YouTube
    // URLs) never becomes an EmbedPillNode — it is left as plain text, matching
    // the card path's `isEmbeddableWebUrl` dispatch. An unsafe URL can never
    // mount a live/preview frame because no embed node is created.
    const normalizedUrl = normalizeEmbeddableWebUrl(url);
    if (!normalizedUrl) {
      return;
    }
    const displayText = unescapeEmbedPillDisplayText(rawText ?? '');
    textNode.replace($createEmbedPillNode(normalizedUrl, displayText, [], textNode.getFormat()));
  },
  trigger: ')',
  type: 'text-match'
};

const FORMATTED_EMBED_PILL_TRANSFORMER: TextMatchTransformer = {
  dependencies: [EmbedPillNode],
  importRegExp: /(~~\*\*\*|\*\*\*~~|~~\*\*|\*\*~~|~~\*|\*~~|\*\*\*|\*\*|~~|\*)(?:(\?\[((?:\\.|[^\]\\])*)\]\(([^()\s]*(?:\([^()]*\)[^()\s]*)*)\))|(https?:\/\/[^\s<>{}|\\^[\]`*~]+))(~~\*\*\*|\*\*\*~~|~~\*\*|\*\*~~|~~\*|\*~~|\*\*\*|\*\*|~~|\*)/,
  regExp: /(~~\*\*\*|\*\*\*~~|~~\*\*|\*\*~~|~~\*|\*~~|\*\*\*|\*\*|~~|\*)(?:(\?\[((?:\\.|[^\]\\])*)\]\(([^()\s]*(?:\([^()]*\)[^()\s]*)*)\))|(https?:\/\/[^\s<>{}|\\^[\]`*~]+))(~~\*\*\*|\*\*\*~~|~~\*\*|\*\*~~|~~\*|\*~~|\*\*\*|\*\*|~~|\*)$/,
  replace: (textNode, match) => {
    if (textNode.hasFormat('code')) return;
    const [, opening, _legacyMarkdown, rawLegacyText, legacyUrl, rawUrl, closing] = match;
    const textFormat = markdownWrapperPairToTextFormat(opening, closing);
    if (textFormat === 0) {
      return;
    }
    const isLegacyPill = Boolean(legacyUrl);
    const url = trimRawWebEmbedUrl(legacyUrl || rawUrl || '');
    const normalizedUrl = normalizeEmbeddableWebUrl(url);
    if (!normalizedUrl) {
      return;
    }
    const displayText = isLegacyPill ? unescapeEmbedPillDisplayText(rawLegacyText ?? '') : '';
    textNode.replace(
      $createEmbedPillNode(
        normalizedUrl,
        displayText,
        [],
        textFormat | textNode.getFormat()
      )
    );
  },
  trigger: ')',
  type: 'text-match'
};

const SELF_REFERENTIAL_LINK_EMBED_PILL_TRANSFORMER: TextMatchTransformer = {
  dependencies: [EmbedPillNode],
  importRegExp: /\[((?:https?:\/\/[^\]\s]+))\]\(([^()\s]*(?:\([^()]*\)[^()\s]*)*)\)/,
  regExp: /\[((?:https?:\/\/[^\]\s]+))\]\(([^()\s]*(?:\([^()]*\)[^()\s]*)*)\)$/,
  replace: (textNode, match) => {
    if (textNode.hasFormat('code')) return;
    const [, linkText, url] = match;
    const normalizedUrl = normalizeEmbeddableWebUrl(url);
    if (!linkText || !url || linkText !== url || !normalizedUrl) {
      return;
    }
    textNode.replace($createEmbedPillNode(normalizedUrl, '', [], textNode.getFormat()));
  },
  trigger: ')',
  type: 'text-match'
};

const trimRawWebEmbedUrl = (value: string): string => {
  let url = value.replace(/[.,;:!?]+$/, '');
  while (/[)\]}>"']$/.test(url)) {
    const trailing = url[url.length - 1];
    const opening =
      trailing === ')' ? '(' :
        trailing === ']' ? '[' :
          trailing === '}' ? '{' :
            trailing === '>' ? '<' :
              trailing;
    const trailingCount = [...url].filter((char) => char === trailing).length;
    const openingCount = [...url].filter((char) => char === opening).length;
    if (opening !== trailing && trailingCount <= openingCount) {
      break;
    }
    url = url.slice(0, -1);
  }
  return url;
};

const RAW_WEB_EMBED_URL_IMPORT_RE = /https?:\/\/[^\s<>{}|\\^[\]`]+/;

const RAW_WEB_EMBED_URL_CANDIDATE_RE = /https?:\/\/[^\s<>{}|\\^[\]`]+/g;

const RAW_WEB_EMBED_URL_LIVE_RE =
  /((?:https?:\/\/[^\s<>{}|\\^[\]`]+|(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?\.)+[a-zA-Z][a-zA-Z0-9-]{1,23}(?::\d{1,5})?(?:[/?#][^\s<>{}|\\^[\]`]*)?))(\s)$/;

const copyTextNodeFormat = (source: TextNode, target: TextNode): TextNode => {
  target.setFormat(source.getFormat());
  target.setStyle(source.getStyle());
  return target;
};

const $replaceTextNodeWebEmbedUrls = (textNode: TextNode): void => {
  if (textNode.hasFormat('code') || $findMatchingParent(textNode, $isLinkNode)) {
    return;
  }
  const text = textNode.getTextContent();
  const nodes: LexicalNode[] = [];
  let cursor = 0;
  let converted = false;

  for (const match of text.matchAll(RAW_WEB_EMBED_URL_CANDIDATE_RE)) {
    const rawUrl = match[0] ?? '';
    const start = match.index ?? 0;
    const url = trimRawWebEmbedUrl(rawUrl);
    const normalizedUrl = normalizeEmbeddableWebUrl(url);
    if (!normalizedUrl) {
      continue;
    }
    if (start > cursor) {
      nodes.push(copyTextNodeFormat(textNode, $createTextNode(text.slice(cursor, start))));
    }
    nodes.push($createEmbedPillNode(normalizedUrl, '', [], textNode.getFormat()));
    cursor = start + url.length;
    converted = true;
  }

  if (!converted) {
    return;
  }
  if (cursor < text.length) {
    nodes.push(copyTextNodeFormat(textNode, $createTextNode(text.slice(cursor))));
  }
  const [firstNode, ...remainingNodes] = nodes;
  if (!firstNode) {
    return;
  }
  textNode.replace(firstNode);
  let previousNode = firstNode;
  for (const node of remainingNodes) {
    previousNode.insertAfter(node);
    previousNode = node;
  }
};

const RAW_WEB_EMBED_URL_TEXT_TRANSFORMER: TextMatchTransformer = {
  dependencies: [EmbedPillNode],
  importRegExp: RAW_WEB_EMBED_URL_IMPORT_RE,
  regExp: RAW_WEB_EMBED_URL_LIVE_RE,
  getEndIndex: (_textNode, match) => {
    const start = match.index ?? 0;
    const matchedText = match[0] ?? '';
    const url = trimRawWebEmbedUrl(matchedText);
    return url.length > 0 ? start + url.length : false;
  },
  replace: (textNode, match) => {
    if (textNode.hasFormat('code')) return;
    const rawUrl = match[1] ?? textNode.getTextContent();
    const url = trimRawWebEmbedUrl(rawUrl);
    const normalizedUrl = normalizeEmbeddableWebUrl(url);
    if (!normalizedUrl) {
      return;
    }
    const text = match.input ?? textNode.getTextContent();
    const offset = typeof match.index === 'number' ? match.index : text.lastIndexOf(url);
    if (offset >= 0 && isInsideInlineCodeSpan(text, offset)) return;
    if (offset >= 0 && isAfterUnclosedBacktick(text, offset)) return;
    const suffix = `${rawUrl.slice(url.length)}${match[2] ?? ''}`;
    const pill = $createEmbedPillNode(normalizedUrl, '', [], textNode.getFormat());
    textNode.replace(pill);
    if (suffix) {
      const suffixNode = copyTextNodeFormat(textNode, $createTextNode(suffix));
      pill.insertAfter(suffixNode);
      suffixNode.selectEnd();
    }
  },
  trigger: ' ',
  type: 'text-match'
};

// UUID pattern for distinguishing resolved noteId from heading text containing |
const UUID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

const unescapeWikiLinkHash = (value: string): string =>
  value.replace(/\\([#\\])/g, '$1');

const hashLooksLikeHeadingDelimiter = (value: string, index: number): boolean => {
  if (index === 0) {
    return true;
  }
  const previous = value[index - 1];
  const next = value[index + 1];
  if (!previous || !next) {
    return false;
  }
  return !/\s/.test(previous) && !/\s/.test(next);
};

const findWikiLinkHeadingDelimiter = (value: string): number => {
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char === '\\') {
      index += 1;
      continue;
    }
    if (char === '#' && hashLooksLikeHeadingDelimiter(value, index)) {
      return index;
    }
  }
  return -1;
};

const escapeWikiLinkTitleHash = (value: string, hasHeading: boolean): string => {
  let escaped = '';
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char === '\\') {
      escaped += '\\\\';
      continue;
    }
    if (char === '#' && (hasHeading || hashLooksLikeHeadingDelimiter(value, index))) {
      escaped += '\\#';
      continue;
    }
    escaped += char;
  }
  return escaped;
};

// File link transformer: wiki-link syntax with optional anchor support
// Supports:
// - [[note title]] - basic wiki link
// - [[note title|noteId]] - resolved wiki link
// - [[#Heading]] - same-note anchor (noteTitle empty)
// - [[Note Title#Heading]] - cross-note anchor
// - [[Note Title#Heading|noteId]] - resolved cross-note anchor
// Serializes FileLinkNodes to/from markdown, preserving resolved state
const FILE_LINK_TRANSFORMER: TextMatchTransformer = {
  dependencies: [FileLinkNode],
  export: (node) => {
    if (!$isFileLinkNode(node)) {
      return null;
    }
    const noteId = node.getNoteId();
    const noteTitle = node.getNoteTitle();
    const headingText = node.getHeadingText();
    const displayText = node.getDisplayText();

    // Build the link content. Escape title hashes only when they would be
    // ambiguous with the anchor delimiter.
    const escapedNoteTitle = escapeWikiLinkTitleHash(noteTitle, Boolean(headingText));
    let content = escapedNoteTitle;
    if (headingText) {
      content = `${escapedNoteTitle}#${headingText}`;
    }

    // Preserve user-facing alias text over resolution metadata. Resolution can be rebuilt
    // on load, but once an alias is replaced with a note id the display text is lost.
    if (displayText && displayText.trim().length > 0) {
      return wrapInlineWithCommentMarkers(node, `[[${content}|${displayText}]]`);
    }
    if (node.isResolved() && noteId) {
      return wrapInlineWithCommentMarkers(node, `[[${content}|${noteId}]]`);
    }
    return wrapInlineWithCommentMarkers(node, `[[${content}]]`);
  },
  // Match full wiki-link payload; parse title/heading/suffix in replace().
  importRegExp: /\[\[((?:[^\]]|\](?!\]))+)\]\]/,
  regExp: /\[\[((?:[^\]]|\](?!\]))+)\]\]$/,
  replace: (textNode, match) => {
    if (textNode.hasFormat('code')) return;
    const [, rawContent] = match;
    const trimmed = rawContent?.trim() || '';
    if (!trimmed) {
      return;
    }

    // Split on the last pipe:
    // - UUID suffix => Moss resolved noteId
    // - Non-UUID suffix => Obsidian alias/display text
    const pipeIndex = trimmed.lastIndexOf('|');
    const primary = pipeIndex >= 0 ? trimmed.slice(0, pipeIndex).trim() : trimmed;
    const suffix = pipeIndex >= 0 ? trimmed.slice(pipeIndex + 1).trim() : '';

    const hashIndex = findWikiLinkHeadingDelimiter(primary);
    const noteTitle =
      hashIndex >= 0
        ? unescapeWikiLinkHash(primary.slice(0, hashIndex).trim())
        : unescapeWikiLinkHash(primary);
    const headingText =
      hashIndex >= 0 ? unescapeWikiLinkHash(primary.slice(hashIndex + 1).trim()) || null : null;

    let noteId: string | null = null;
    let displayText: string | null = null;
    let isResolved = false;

    if (suffix.length > 0 && UUID_PATTERN.test(suffix)) {
      noteId = suffix;
      isResolved = true;
    } else if (suffix.length > 0) {
      displayText = suffix;
    }

    // Determine resolution state
    // Note: When headingText is present, we use 'note_resolved' (not 'fully_resolved')
    // because heading existence must be validated asynchronously in FileLinkPlugin.
    // For same-note anchors (no noteTitle), we also start with 'note_resolved'.
    let resolutionState: import('../../../common/noteTypes').LinkResolutionState;
    if (isResolved) {
      resolutionState = 'note_resolved';
    } else if (!noteTitle && headingText) {
      // Same-note anchor: needs validation against current editor headings
      resolutionState = 'unresolved';
    } else {
      resolutionState = 'unresolved';
    }

    const fileLinkNode = $createFileLinkNode(
      noteId,
      noteTitle,
      isResolved,
      headingText,
      resolutionState,
      displayText
    );
    textNode.replace(fileLinkNode);
  },
  trigger: ']',
  type: 'text-match'
};

/**
 * Custom LINK transformer that handles URLs with parentheses.
 * Overrides Lexical's built-in LINK transformer which uses `[^()\s]+` for URLs,
 * breaking URLs like `https://en.wikipedia.org/wiki/Obsidian_(software)`.
 *
 * This version allows one level of balanced parentheses in URLs.
 */
const appendFormattedLinkText = (
  linkNode: LinkNode,
  linkText: string,
  inheritedFormat: number
): void => {
  const appendText = (text: string, format?: 'bold' | 'italic' | 'strikethrough' | 'code') => {
    if (!text) return;
    const textNode = $createTextNode(text);
    textNode.setFormat(inheritedFormat);
    if (format) {
      textNode.toggleFormat(format);
    }
    linkNode.append(textNode);
  };

  let cursor = 0;
  let matchedAny = false;
  const formatRegExp = /(\*\*|~~|`|\*)([^\n]+?)\1/g;
  let match: RegExpExecArray | null;

  while ((match = formatRegExp.exec(linkText)) !== null) {
    const [fullMatch, delimiter, content] = match;
    // Avoid treating the middle of a bold delimiter as an italic delimiter.
    if (
      delimiter === '*' &&
      (linkText[match.index - 1] === '*' || linkText[match.index + fullMatch.length] === '*')
    ) {
      continue;
    }

    appendText(linkText.slice(cursor, match.index));
    const format =
      delimiter === '**'
        ? 'bold'
        : delimiter === '~~'
          ? 'strikethrough'
          : delimiter === '`'
            ? 'code'
            : 'italic';
    appendText(content, format);
    cursor = match.index + fullMatch.length;
    matchedAny = true;
  }

  if (!matchedAny) {
    appendText(linkText);
    return;
  }
  appendText(linkText.slice(cursor));
};

const LINK_TRANSFORMER: TextMatchTransformer = {
  dependencies: [LinkNode],
  export: (node, exportChildren) => {
    if (!$isLinkNode(node)) {
      return null;
    }
    const title = node.getTitle();
    // Serialize child content via markdown callbacks so nested MarkNodes
    // are emitted as comment anchors instead of being flattened away.
    const textContent = exportChildren(node);
    return title
      ? `[${textContent}](${node.getURL()} "${title}")`
      : `[${textContent}](${node.getURL()})`;
  },
  // Allow URLs with one level of balanced parentheses: url_part(nested)_more
  // Pattern breakdown:
  // - [^()\s]* - characters that aren't parens or whitespace
  // - (?:\([^()]*\)[^()\s]*)* - zero or more groups of (nested content) followed by non-paren chars
  importRegExp: /(?:\[([^[\]]+)\])(?:\(([^()\s]*(?:\([^()]*\)[^()\s]*)*)(?:\s"((?:[^"]*\\")*[^"]*)")?\))/,
  regExp: /(?:\[([^[\]]+)\])(?:\(([^()\s]*(?:\([^()]*\)[^()\s]*)*)(?:\s"((?:[^"]*\\")*[^"]*)")?\))$/,
  replace: (textNode, match) => {
    const [fullMatch, linkText, linkUrl, linkTitle] = match;
    if (!linkText || !linkUrl) {
      return;
    }
    const text = match.input ?? textNode.getTextContent();
    const matchStart = typeof match.index === 'number' ? match.index : text.lastIndexOf(fullMatch);
    if (matchStart > 0 && text[matchStart - 1] === '!') {
      return;
    }
    const linkNode = $createLinkNode(linkUrl, { title: linkTitle || undefined });
    appendFormattedLinkText(linkNode, linkText, textNode.getFormat());
    textNode.replace(linkNode);
  },
  trigger: ')',
  type: 'text-match'
};

// GFM table transformer - exports canonical GitHub Flavored Markdown tables
// and imports GFM tables back into Lexical TableNode structure.
const TABLE_LEADING_PIPE_ROW_REG_EXP = /^\s*\|.*\|?\s*$/;

const TABLE_DIVIDER_ROW_REG_EXP = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)+\|?\s*$/;

const TABLE_ROW_REG_EXP = new RegExp(
  `(?:${TABLE_LEADING_PIPE_ROW_REG_EXP.source}|${TABLE_DIVIDER_ROW_REG_EXP.source})`
);

const TABLE_DIVIDER_CELL_REG_EXP = /^:?-+:?$/;

const TABLE_COLUMN_WIDTHS_COMMENT_RE =
  /^<!--\s*moss-table-column-widths:\s*([0-9.,\s]+)\s*-->$/i;

// Forward-declared reference to transformers for cell content processing
let TABLE_TRANSFORMERS: typeof MARKDOWN_EDITOR_TRANSFORMERS;

const getTableColumnsSize = (table: TableNode): number => {
  const row = table.getFirstChild();
  return $isTableRowNode(row) ? row.getChildrenSize() : 0;
};

const normalizeTableColumnWidths = (
  widths: readonly number[] | null | undefined,
  columnCount: number
): number[] | null => {
  if (!widths || widths.length === 0 || columnCount <= 0) {
    return null;
  }

  const sanitized = widths
    .map((width) => Math.round(width))
    .filter((width) => Number.isFinite(width) && width > 0);
  if (sanitized.length === 0) {
    return null;
  }

  if (sanitized.length >= columnCount) {
    return sanitized.slice(0, columnCount);
  }

  const fillWidth = sanitized[sanitized.length - 1];
  return [
    ...sanitized,
    ...Array.from({ length: columnCount - sanitized.length }, () => fillWidth)
  ];
};

const collectTableNodesInOrder = (
  root: import('lexical').ElementNode = $getRoot()
): TableNode[] => {
  const tables: TableNode[] = [];
  const visit = (node: LexicalNode): void => {
    if ($isTableNode(node)) {
      tables.push(node);
      return;
    }
    if (!$isElementNode(node)) {
      return;
    }
    for (const child of node.getChildren()) {
      visit(child);
    }
  };

  visit(root);
  return tables;
};

export const noteLayoutMetadataHasColumnWidths = (
  layoutMetadata: NoteLayoutMetadata | null | undefined
): boolean =>
  Boolean(
    layoutMetadata?.tables.some(
      (table) => Array.isArray(table.columnWidths) && table.columnWidths.length > 0
    ) ||
    layoutMetadata?.tabGroups?.some(
      (tabGroup) =>
        Array.isArray(tabGroup.tabWidths) &&
        tabGroup.tabWidths.some((width) => typeof width === 'number')
    )
  );

export const serializeNoteLayoutMetadataForComparison = (
  layoutMetadata: NoteLayoutMetadata | null | undefined
): string => {
  if (!layoutMetadata || !noteLayoutMetadataHasColumnWidths(layoutMetadata)) {
    return '';
  }

  const tabGroups = (layoutMetadata.tabGroups ?? [])
    .map((tabGroup, index): [number, (number | null)[]] => [index, tabGroup.tabWidths ?? []])
    .filter(([, tabWidths]) => tabWidths.some((width) => typeof width === 'number'));

  return JSON.stringify({
    version: layoutMetadata.version,
    tableCount: layoutMetadata.tableCount,
    tables: layoutMetadata.tables.map((table) => table.columnWidths ?? []),
    tabGroups
  });
};

export const $collectTableLayoutMetadata = (
  root: import('lexical').ElementNode = $getRoot()
): NoteLayoutMetadata => {
  const tables = collectTableNodesInOrder(root);
  return {
    version: 1,
    tableCount: tables.length,
    tables: tables.map((table) => {
      const widths = normalizeTableColumnWidths(
        table.getColWidths() ?? null,
        getTableColumnsSize(table)
      );
      return widths ? { columnWidths: widths } : {};
    })
  };
};

export const $applyTableLayoutMetadata = (
  layoutMetadata: NoteLayoutMetadata | null | undefined,
  root: import('lexical').ElementNode = $getRoot()
): boolean => {
  if (!layoutMetadata || layoutMetadata.version !== 1) {
    return false;
  }

  const tables = collectTableNodesInOrder(root);
  if (tables.length !== layoutMetadata.tableCount) {
    return false;
  }

  tables.forEach((table, index) => {
    const widths = normalizeTableColumnWidths(
      layoutMetadata.tables[index]?.columnWidths,
      getTableColumnsSize(table)
    );
    table.setColWidths(widths ?? undefined);
  });

  return true;
};

const collectTabGroupNodesInOrder = (
  root: import('lexical').ElementNode = $getRoot()
): TabGroupNode[] => {
  const tabGroups: TabGroupNode[] = [];
  const visit = (node: LexicalNode): void => {
    if ($isTabGroupNode(node)) {
      tabGroups.push(node);
    }
    if (!$isElementNode(node)) {
      return;
    }
    for (const child of node.getChildren()) {
      visit(child);
    }
  };

  visit(root);
  return tabGroups;
};

const normalizeTabWidths = (
  widths: readonly (number | null)[] | null | undefined,
  panelCount: number
): (number | null)[] | null => {
  if (!widths || widths.length === 0 || panelCount <= 0) {
    return null;
  }

  const sanitized = widths
    .slice(0, panelCount)
    .map((width) =>
      typeof width === 'number' && Number.isFinite(width) && width > 0
        ? Math.round(width)
        : null
    );

  let lastPinned = -1;
  for (let i = 0; i < sanitized.length; i += 1) {
    if (sanitized[i] !== null) {
      lastPinned = i;
    }
  }
  if (lastPinned < 0) {
    return null;
  }

  return sanitized.slice(0, lastPinned + 1);
};

export const $collectTabGroupLayoutMetadata = (
  root: import('lexical').ElementNode = $getRoot()
): Pick<NoteLayoutMetadata, 'tabGroupCount' | 'tabGroups'> => {
  const tabGroups = collectTabGroupNodesInOrder(root);
  return {
    tabGroupCount: tabGroups.length,
    tabGroups: tabGroups.map((tabGroup) => {
      const panelLabels = tabGroup.getTabPanels().map((panel) => panel.getLabel());
      const widths = normalizeTabWidths(
        tabGroup.getTabWidths(),
        panelLabels.length
      );
      return {
        panelLabels,
        ...(widths ? { tabWidths: widths } : {})
      };
    })
  };
};

export const $applyTabGroupLayoutMetadata = (
  layoutMetadata: NoteLayoutMetadata | null | undefined,
  root: import('lexical').ElementNode = $getRoot()
): boolean => {
  if (!layoutMetadata || layoutMetadata.version !== 1) {
    return false;
  }

  const tabGroups = collectTabGroupNodesInOrder(root);
  if (tabGroups.length !== (layoutMetadata.tabGroupCount ?? 0)) {
    return false;
  }

  tabGroups.forEach((tabGroup, index) => {
    const widths = normalizeTabWidths(
      layoutMetadata.tabGroups?.[index]?.tabWidths,
      tabGroup.getTabPanels().length
    );
    tabGroup.setTabWidths(widths ?? []);
  });

  return true;
};

export const parseTableColumnWidthsComment = (value: string): number[] | null => {
  const match = value.trim().match(TABLE_COLUMN_WIDTHS_COMMENT_RE);
  if (!match) {
    return null;
  }

  const widths = match[1]
    .split(',')
    .map((part) => Number.parseFloat(part.trim()))
    .filter((width) => Number.isFinite(width) && width > 0);

  return widths.length > 0 ? widths : null;
};

export const formatTableColumnWidthsComment = (widths: readonly number[]): string | null => {
  const normalizedWidths = normalizeTableColumnWidths(widths, widths.length);
  if (!normalizedWidths || normalizedWidths.length === 0) {
    return null;
  }

  return `<!-- moss-table-column-widths: ${normalizedWidths.join(', ')} -->`;
};

const $findContainingTableCell = (node: LexicalNode | null): TableCellNode | null => {
  let current: LexicalNode | null = node;
  while (current) {
    if ($isTableCellNode(current)) {
      return current;
    }
    current = current.getParent();
  }
  return null;
};

const $isInlineTableCellChild = (node: LexicalNode): boolean =>
  $isTextNode(node) ||
  $isLineBreakNode(node) ||
  ($isElementNode(node) && node.isInline()) ||
  ($isDecoratorNode(node) && node.isInline());

const $normalizeTableCellBlockChildren = (cell: TableCellNode): boolean => {
  let normalized = false;
  let paragraph: ReturnType<typeof $createParagraphNode> | null = null;

  for (const child of cell.getChildren()) {
    if (!$isInlineTableCellChild(child)) {
      paragraph = null;
      continue;
    }

    if (!paragraph) {
      paragraph = $createParagraphNode();
      child.insertBefore(paragraph);
      normalized = true;
    }

    paragraph.append(child);
  }

  if (cell.getChildrenSize() === 0) {
    cell.append($createParagraphNode());
    normalized = true;
  }

  return normalized;
};

const $normalizeSelectionTableCells = (selection: BaseSelection | null): boolean => {
  if (!$isRangeSelection(selection)) {
    return false;
  }

  const cells = new Map<string, TableCellNode>();
  for (const point of [selection.anchor, selection.focus]) {
    const cell = $findContainingTableCell(point.getNode());
    if (cell) {
      cells.set(cell.getKey(), cell);
    }
  }

  let normalized = false;
  for (const cell of cells.values()) {
    normalized = $normalizeTableCellBlockChildren(cell) || normalized;
  }
  return normalized;
};

const getTopLevelElementOrNull = (node: LexicalNode | null): import('lexical').ElementNode | null => {
  let current = node;
  while (current) {
    const parent = current.getParent();
    if (!parent) {
      return null;
    }

    if ($isRootNode(parent) || ($isElementNode(parent) && parent.isShadowRoot())) {
      return $isElementNode(current) && !current.isInline() ? current : null;
    }

    current = parent;
  }
  return null;
};

export const $tryCreateWebEmbedFromBangLinkSelection = (url: string): boolean => {
  const normalizedUrl = normalizeEmbeddableWebUrl(url);
  if (!normalizedUrl) {
    return false;
  }

  const selection = $getSelection();
  if (!$isRangeSelection(selection) || selection.isCollapsed()) {
    return false;
  }

  const selectedText = selection.getTextContent().trim();
  if (!selectedText || selectedText.includes('\n')) {
    return false;
  }

  const anchorBlock = getTopLevelElementOrNull(selection.anchor.getNode());
  const focusBlock = getTopLevelElementOrNull(selection.focus.getNode());
  if (!anchorBlock || anchorBlock !== focusBlock || !$isParagraphNode(anchorBlock)) {
    return false;
  }

  const paragraphText = anchorBlock.getTextContent().trim();
  let title: string | null = null;
  if (selectedText.startsWith('!')) {
    if (paragraphText !== selectedText) {
      return false;
    }
    title = selectedText.slice(1).trim();
  } else if (paragraphText === `!${selectedText}`) {
    title = selectedText;
  }

  if (!title) {
    return false;
  }

  $setSelection(null);
  anchorBlock.replace($createWebEmbedNode(normalizedUrl, title));
  return true;
};

const $createTableCell = (textContent: string): TableCellNode => {
  // Unescape newlines and escaped pipes
  const unescaped = textContent.replace(/\\n/g, '\n').replace(/\\\|/g, '|');
  const cell = $createTableCellNode(TableCellHeaderStates.NO_STATUS);
  // Process markdown within the cell
  $convertFromMarkdownString(unescaped.trim(), TABLE_TRANSFORMERS, cell);
  const convertCellText = (node: LexicalNode): void => {
    if ($isTextNode(node)) {
      $replaceTextNodeWebEmbedUrls(node);
      return;
    }
    if ($isElementNode(node)) {
      for (const child of node.getChildren()) {
        convertCellText(child);
      }
    }
  };
  convertCellText(cell);
  $normalizeTableCellBlockChildren(cell);
  return cell;
};

type TableParseState = {
  formulaDepth: number;
  wikiLinkDepth: number;
  /** Number of backticks in the opening inline-code delimiter (0 = not in code). */
  inlineCodeBackticks: number;
};

const isEscapedTableChar = (content: string, index: number): boolean => {
  let backslashCount = 0;
  for (let i = index - 1; i >= 0 && content[i] === '\\'; i--) {
    backslashCount++;
  }
  return backslashCount % 2 === 1;
};

/**
 * Count the length of a backtick run starting at `index`.
 */
const backtickRunLength = (content: string, index: number): number => {
  let len = 0;
  while (index + len < content.length && content[index + len] === '`') {
    len++;
  }
  return len;
};

/**
 * Track table-aware syntax regions so we don't split/escape `|` that belong to:
 * - formulas: `{{expr|result}}`
 * - wiki links: `[[Note|id]]` and `[[Target|Alias]]`
 * - inline code: `` `code with | pipe` `` (GFM spec: pipes inside code spans are literal)
 */
const advanceTableParseState = (
  content: string,
  index: number,
  state: TableParseState
): number => {
  const char = content[index];

  // --- Inline code tracking (highest priority — nothing is parsed inside code spans) ---
  // When already inside a code span, backslashes are literal (GFM spec) and
  // must not prevent a matching backtick run from closing the span.
  if (char === '`' && (state.inlineCodeBackticks > 0 || !isEscapedTableChar(content, index))) {
    const runLen = backtickRunLength(content, index);
    if (state.inlineCodeBackticks === 0) {
      // Opening a code span
      state.inlineCodeBackticks = runLen;
      return runLen - 1;
    } else if (runLen === state.inlineCodeBackticks) {
      // Closing the code span (matching backtick count)
      state.inlineCodeBackticks = 0;
      return runLen - 1;
    }
    // Non-matching backtick run inside code span — treat as literal
    return runLen - 1;
  }

  // Inside inline code, nothing else is parsed
  if (state.inlineCodeBackticks > 0) {
    return 0;
  }

  const nextChar = content[index + 1];
  if (!nextChar || isEscapedTableChar(content, index)) {
    return 0;
  }

  if (state.formulaDepth === 0 && char === '[' && nextChar === '[') {
    state.wikiLinkDepth++;
    return 1;
  }

  if (state.wikiLinkDepth > 0 && char === ']' && nextChar === ']') {
    state.wikiLinkDepth = Math.max(0, state.wikiLinkDepth - 1);
    return 1;
  }

  if (state.wikiLinkDepth === 0 && char === '{' && nextChar === '{') {
    state.formulaDepth++;
    return 1;
  }

  if (state.formulaDepth > 0 && char === '}' && nextChar === '}') {
    state.formulaDepth = Math.max(0, state.formulaDepth - 1);
    return 1;
  }

  return 0;
};

const isTableCellSeparator = (content: string, index: number, state: TableParseState): boolean =>
  content[index] === '|' &&
  !isEscapedTableChar(content, index) &&
  state.formulaDepth === 0 &&
  state.wikiLinkDepth === 0 &&
  state.inlineCodeBackticks === 0;

const isTablePipeToEscape = (content: string, index: number, state: TableParseState): boolean =>
  content[index] === '|' &&
  !isEscapedTableChar(content, index) &&
  state.formulaDepth === 0;

/**
 * Split table row content by `|` while respecting protected regions:
 * formulas (`{{...}}`) and wiki links (`[[...]]`).
 */
const splitTableRow = (content: string): string[] => {
  const cells: string[] = [];
  let current = '';
  let endedWithSeparator = false;
  const state: TableParseState = { formulaDepth: 0, wikiLinkDepth: 0, inlineCodeBackticks: 0 };

  for (let i = 0; i < content.length; i++) {
    const tokenExtraChars = advanceTableParseState(content, i, state);

    if (isTableCellSeparator(content, i, state)) {
      cells.push(current);
      current = '';
      endedWithSeparator = true;
      continue;
    }

    current += content[i];
    endedWithSeparator = false;

    if (tokenExtraChars > 0) {
      current += content[i + 1];
      i += tokenExtraChars;
      endedWithSeparator = false;
    }
  }

  if (current || endedWithSeparator) {
    cells.push(current);
  }

  return cells;
};

const countTableCellSeparators = (content: string): number => {
  let separators = 0;
  const state: TableParseState = { formulaDepth: 0, wikiLinkDepth: 0, inlineCodeBackticks: 0 };

  for (let i = 0; i < content.length; i++) {
    const tokenExtraChars = advanceTableParseState(content, i, state);

    if (isTableCellSeparator(content, i, state)) {
      separators += 1;
      continue;
    }

    if (tokenExtraChars > 0) {
      i += tokenExtraChars;
    }
  }

  return separators;
};

const countWikiLinkDelimiters = (content: string): { open: number; close: number } => ({
  open: (content.match(/\[\[/g) || []).length,
  close: (content.match(/\]\]/g) || []).length
});

const extractTableRowContent = (value: string): string | null => {
  const trimmed = value.trim();
  if (!trimmed.includes('|')) {
    return null;
  }

  let content = trimmed;
  if (content.startsWith('|')) {
    content = content.slice(1);
  }
  if (content.endsWith('|')) {
    content = content.slice(0, -1);
  }

  return content.trim().length > 0 ? content : null;
};

const isTableDividerRow = (value: string): boolean => {
  if (!TABLE_DIVIDER_ROW_REG_EXP.test(value.trim())) {
    return false;
  }

  const content = extractTableRowContent(value);
  if (!content) {
    return false;
  }

  const cells = content.split('|').map((cell) => cell.trim());
  return cells.length > 0 && cells.every((cell) => TABLE_DIVIDER_CELL_REG_EXP.test(cell));
};

const hasUnclosedWikiLink = (content: string): boolean => {
  const { open, close } = countWikiLinkDelimiters(content);
  return open > close;
};

const hasUnclosedFormula = (content: string): boolean => {
  const open = (content.match(/\{\{/g) || []).length;
  const close = (content.match(/\}\}/g) || []).length;
  return open > close;
};

const hasMissingTrailingPipeContinuation = (rowText: string): boolean => {
  const trimmed = rowText.trimEnd();
  if (trimmed.endsWith('|')) {
    return false;
  }
  // Treat as a broken row only when the line already looks like a table row
  // with at least one internal cell separator (`| col | value`).
  return countTableCellSeparators(trimmed) >= 2;
};

const isTableBodyRowCandidate = (value: string): boolean => {
  const content = extractTableRowContent(value);
  if (!content || isTableDividerRow(value)) {
    return false;
  }

  return mergeBrokenWikiLinkCells(splitTableRow(content)).length >= 2;
};

const isValidTableContinuationLine = (lineText: string): boolean => {
  const trimmed = lineText.trim();
  if (!trimmed.startsWith('|')) {
    return false;
  }
  if (hasUnclosedWikiLink(trimmed) || hasUnclosedFormula(trimmed)) {
    return true;
  }
  return countTableCellSeparators(trimmed) >= 2;
};

const rowNeedsContinuation = (rowText: string): boolean => {
  return hasUnclosedWikiLink(rowText) || hasUnclosedFormula(rowText) || hasMissingTrailingPipeContinuation(rowText);
};

const consumeBrokenTableLineContinuations = (parentNode: LexicalNode, rowText: string): string => {
  let merged = rowText;
  let sibling = parentNode.getNextSibling();

  while (rowNeedsContinuation(merged) && sibling) {
    if (!$isParagraphNode(sibling)) {
      break;
    }

    const nextText = sibling.getTextContent().trim();
    const nextSibling = sibling.getNextSibling();
    if (!nextText) {
      sibling.remove();
      sibling = nextSibling;
      continue;
    }

    const needsSyntaxContinuation = hasUnclosedWikiLink(merged) || hasUnclosedFormula(merged);
    if (!needsSyntaxContinuation && !isValidTableContinuationLine(nextText)) {
      break;
    }

    merged = `${merged.trimEnd()} ${nextText}`;
    sibling.remove();
    sibling = nextSibling;
  }

  return merged;
};

const normalizeBrokenMultilineTableRow = (textContent: string): string | null => {
  if (!textContent.includes('\n')) {
    return textContent;
  }

  const lines = textContent
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (lines.length === 0) {
    return textContent;
  }

  // Only normalize wrapped table rows when all continuation lines still
  // look table-like (`| ...`), otherwise leave as non-table content.
  if (lines.some((line) => !line.startsWith('|'))) {
    return null;
  }

  return lines.join(' ');
};

/**
 * Heals legacy rows that were previously split at `|` inside wiki links.
 * Example:
 * `[[Spec: In-line prompts | uuid]]` -> `[[Spec: In-line prompts|uuid]]`
 */
const mergeBrokenWikiLinkCells = (cells: string[]): string[] => {
  const healed: string[] = [];

  for (let i = 0; i < cells.length; i++) {
    const current = cells[i];

    if (!hasUnclosedWikiLink(current)) {
      healed.push(current);
      continue;
    }

    let mergedCandidate = current;
    let endIndex = i;
    while (endIndex + 1 < cells.length && hasUnclosedWikiLink(mergedCandidate)) {
      endIndex += 1;
      mergedCandidate += `|${cells[endIndex]}`;
    }

    if (!hasUnclosedWikiLink(mergedCandidate)) {
      healed.push(mergedCandidate);
      i = endIndex;
      continue;
    }

    healed.push(current);
  }

  return healed;
};

/**
 * Repair a common AI-generated table-cell mistake:
 * wrapping an entire sentence in single backticks while also trying to nest
 * escaped single-backtick code spans inside it, e.g.
 * `Run \`claude\` in Terminal`
 *
 * That is not valid Markdown and can poison table-row splitting. Normalize it
 * to plain text with valid inner inline-code spans instead:
 * Run `claude` in Terminal
 */
const repairMalformedSingleBacktickWrappedTableCells = (rowContent: string): string =>
  rowContent.replace(
    /(^|\|\s*)`([^|\n]*\\`[^|\n]*\\`[^|\n]*)`(?=\s*\||$)/g,
    (_match, prefix: string, inner: string) => `${prefix}${inner.replace(/\\`/g, '`')}`
  );

/** Escapes `|` as `\|` in cell content, except inside formulas. */
const escapeTableCellPipes = (content: string): string => {
  let result = '';
  const state: TableParseState = { formulaDepth: 0, wikiLinkDepth: 0, inlineCodeBackticks: 0 };

  for (let i = 0; i < content.length; i++) {
    const tokenExtraChars = advanceTableParseState(content, i, state);

    if (isTablePipeToEscape(content, i, state)) {
      result += '\\|';
      continue;
    }

    result += content[i];

    if (tokenExtraChars > 0) {
      result += content[i + 1];
      i += tokenExtraChars;
    }
  }

  return result;
};

const mapToTableCells = (textContent: string): TableCellNode[] | null => {
  const normalized = normalizeBrokenMultilineTableRow(textContent);
  if (normalized == null) {
    return null;
  }

  const rowContent = extractTableRowContent(
    repairMalformedSingleBacktickWrappedTableCells(normalized)
  );
  if (!rowContent) {
    return null;
  }

  const rawCells = splitTableRow(rowContent);
  const healedCells = mergeBrokenWikiLinkCells(rawCells);
  return healedCells.map((text) => $createTableCell(text));
};

const getSingleParagraphTextChild = (node: LexicalNode | null): TextNode | null => {
  if (!$isParagraphNode(node) || node.getChildrenSize() !== 1) {
    return null;
  }

  const firstChild = node.getFirstChild();
  return $isTextNode(firstChild) ? firstChild : null;
};

const markTableRowAsHeader = (row: TableRowNode): void => {
  row.getChildren().forEach((cell) => {
    if (!$isTableCellNode(cell)) {
      return;
    }
    cell.setHeaderStyles(TableCellHeaderStates.ROW, TableCellHeaderStates.ROW);
  });
};

const ensureTableColumnCount = (table: TableNode, columnCount: number): void => {
  const currentColumnCount = getTableColumnsSize(table);
  if (currentColumnCount >= columnCount) {
    return;
  }

  for (const row of table.getChildren()) {
    if (!$isTableRowNode(row)) {
      continue;
    }

    for (let index = currentColumnCount; index < columnCount; index++) {
      row.append($createTableCell(''));
    }
  }
};

const appendTableRow = (table: TableNode, cells: TableCellNode[]): number => {
  const columnCount = Math.max(getTableColumnsSize(table), cells.length);
  ensureTableColumnCount(table, columnCount);

  const tableRow = $createTableRowNode();
  for (let index = 0; index < columnCount; index++) {
    tableRow.append(index < cells.length ? cells[index] : $createTableCell(''));
  }
  table.append(tableRow);

  return columnCount;
};

const absorbFollowingOptionalPipeTableRows = (table: TableNode, startSibling: LexicalNode | null): void => {
  let sibling = startSibling;

  while (sibling) {
    const textChild = getSingleParagraphTextChild(sibling);
    if (!textChild) {
      break;
    }

    const textContent = textChild.getTextContent();
    if (!isTableBodyRowCandidate(textContent)) {
      break;
    }

    const cells = mapToTableCells(textContent);
    if (cells == null) {
      break;
    }

    const nextSibling = sibling.getNextSibling();
    appendTableRow(table, cells);
    sibling.remove();
    sibling = nextSibling;
  }
};

const GFM_TABLE_MULTILINE_TRANSFORMER: MultilineElementTransformer = {
  dependencies: [TableNode, TableRowNode, TableCellNode],
  regExpStart: /^\s*(?:\|.*\|?|.*\s\|\s.*)\s*$/,
  regExpEnd: /^$/,
  replace: (_rootNode, _children, _startMatch, _endMatch, _linesInBetween, isImport) => {
    if (!isImport) {
      return false;
    }

    return false;
  },
  handleImportAfterStartMatch: ({ lines, startLineIndex, rootNode }) => {
    const headerLine = lines[startLineIndex] ?? '';
    const dividerLine = lines[startLineIndex + 1] ?? '';

    if (!isTableBodyRowCandidate(headerLine) || !isTableDividerRow(dividerLine)) {
      return null;
    }

    const headerCells = mapToTableCells(headerLine);
    if (headerCells == null || headerCells.length < 2) {
      return null;
    }

    const table = $createTableNode();
    let maxCells = appendTableRow(table, headerCells);

    const previousNode = rootNode.getLastChild();
    const previousText = getSingleParagraphTextChild(previousNode);
    if (previousText) {
      const manualColWidths = parseTableColumnWidthsComment(previousText.getTextContent());
      if (manualColWidths) {
        previousNode?.remove();
        const normalizedManualColWidths = normalizeTableColumnWidths(manualColWidths, maxCells);
        if (normalizedManualColWidths) {
          table.setColWidths(normalizedManualColWidths);
        }
      }
    }

    const firstRow = table.getFirstChild();
    if ($isTableRowNode(firstRow)) {
      markTableRowAsHeader(firstRow);
    }

    let endLineIndex = startLineIndex + 1;
    for (let lineIndex = startLineIndex + 2; lineIndex < lines.length; lineIndex += 1) {
      const line = lines[lineIndex] ?? '';
      if (!isTableBodyRowCandidate(line)) {
        break;
      }

      const rowCells = mapToTableCells(line);
      if (rowCells == null || rowCells.length < 2) {
        break;
      }

      maxCells = appendTableRow(table, rowCells);
      endLineIndex = lineIndex;
    }

    rootNode.append(table);
    return [true, endLineIndex];
  },
  type: 'multiline-element'
};

const tryAbsorbTableContinuationRow = (table: TableNode, continuationCell: TableCellNode): boolean => {
  const continuationText = continuationCell.getTextContent().trim();
  if (!continuationText) {
    return false;
  }

  const lastRow = table.getLastChild();
  if (!lastRow || !$isTableRowNode(lastRow)) {
    return false;
  }

  const lastCell = lastRow.getLastChild();
  if (!lastCell || !$isTableCellNode(lastCell)) {
    return false;
  }

  const lastCellMarkdown = $convertToMarkdownString(TABLE_TRANSFORMERS, lastCell).trim();
  if (!hasUnclosedWikiLink(lastCellMarkdown) && !hasUnclosedFormula(lastCellMarkdown)) {
    return false;
  }

  const mergedCellMarkdown = `${lastCellMarkdown}|${continuationText}`;
  lastCell.clear();
  $convertFromMarkdownString(mergedCellMarkdown, TABLE_TRANSFORMERS, lastCell);
  return true;
};

const TABLE_TRANSFORMER: ElementTransformer = {
  dependencies: [TableNode, TableRowNode, TableCellNode],
  export: (node) => {
    if (!$isTableNode(node)) {
      return null;
    }

    const output: string[] = [];

    for (const row of node.getChildren()) {
      const rowOutput: string[] = [];
      if (!$isTableRowNode(row)) {
        continue;
      }

      let isHeaderRow = false;
      for (const cell of row.getChildren()) {
        if ($isTableCellNode(cell)) {
          // Convert cell content to markdown, escape pipes (outside formulas) and newlines
          const cellMarkdown = escapeTableCellPipes(
            $convertToMarkdownString(TABLE_TRANSFORMERS, cell)
          )
            .replace(/\n/g, '\\n')
            .trim();
          rowOutput.push(cellMarkdown);
          if (cell.__headerState === TableCellHeaderStates.ROW) {
            isHeaderRow = true;
          }
        }
      }

      output.push(`| ${rowOutput.join(' | ')} |`);
      if (isHeaderRow) {
        output.push(`| ${rowOutput.map(() => '---').join(' | ')} |`);
      }
    }

    return output.join('\n');
  },
  regExp: TABLE_ROW_REG_EXP,
  replace: (parentNode, _1, match) => {
    // Handle divider row - marks previous row as header
    if (isTableDividerRow(match[0])) {
      const nextSibling = parentNode.getNextSibling();
      const previousSibling = parentNode.getPreviousSibling();
      let table = $isTableNode(previousSibling) ? previousSibling : null;

      if (!table) {
        const previousText = getSingleParagraphTextChild(previousSibling);
        if (!previousText || !isTableBodyRowCandidate(previousText.getTextContent())) {
          return $rejectLine(_1, match); // moss-multi seam: line-loss (A§12; S-conv §1.2)
        }

        const headerCells = mapToTableCells(previousText.getTextContent());
        if (headerCells == null) {
          return $rejectLine(_1, match); // moss-multi seam: line-loss (A§12; S-conv §1.2)
        }

        table = $createTableNode();
        appendTableRow(table, headerCells);
        if (!previousSibling) {
          return;
        }

        previousSibling.replace(table);
      }

      if (!$isTableNode(table)) {
        return;
      }

      const rows = table.getChildren();
      const lastRow = rows[rows.length - 1];
      if (!lastRow || !$isTableRowNode(lastRow)) {
        return;
      }

      markTableRowAsHeader(lastRow);
      parentNode.remove();
      absorbFollowingOptionalPipeTableRows(table, nextSibling);
      return;
    }

    const trimmedMatch = match[0].trim();
    if (!trimmedMatch.startsWith('|')) {
      const previousSibling = parentNode.getPreviousSibling();
      const nextSibling = parentNode.getNextSibling();
      const nextSiblingText = getSingleParagraphTextChild(nextSibling);
      const nextIsDivider =
        $isTextNode(nextSiblingText) &&
        isTableDividerRow(nextSiblingText.getTextContent());

      if (!$isTableNode(previousSibling) && !nextIsDivider) {
        return $rejectLine(_1, match); // moss-multi seam: line-loss (A§12; S-conv §1.2)
      }
    }

    const mergedRowText = consumeBrokenTableLineContinuations(parentNode, match[0]);
    const matchCells = mapToTableCells(mergedRowText);
    if (matchCells == null) {
      return $rejectLine(_1, match); // moss-multi seam: line-loss (A§12; S-conv §1.2)
    }

    const immediatePrevious = parentNode.getPreviousSibling();
    if (
      $isTableNode(immediatePrevious) &&
      matchCells.length === 1 &&
      tryAbsorbTableContinuationRow(immediatePrevious, matchCells[0])
    ) {
      parentNode.remove();
      return;
    }

    const rows: TableCellNode[][] = [matchCells];
    let sibling = parentNode.getPreviousSibling();
    let maxCells = matchCells.length;

    // Collect preceding rows
    while (sibling) {
      if (!$isParagraphNode(sibling)) {
        break;
      }

      const firstChild = getSingleParagraphTextChild(sibling);
      if (!firstChild) {
        break;
      }

      if (!firstChild.getTextContent().trim().startsWith('|')) {
        break;
      }

      const cells = mapToTableCells(firstChild.getTextContent());
      if (cells == null) {
        break;
      }

      maxCells = Math.max(maxCells, cells.length);
      rows.unshift(cells);
      const previousSibling = sibling.getPreviousSibling();
      sibling.remove();
      sibling = previousSibling;
    }

    let manualColWidths: number[] | null = null;
    const firstChild = getSingleParagraphTextChild(sibling);
    if (firstChild) {
      manualColWidths = parseTableColumnWidthsComment(firstChild.getTextContent());
      if (manualColWidths && sibling) {
        const previousSibling = sibling.getPreviousSibling();
        sibling.remove();
        sibling = previousSibling;
      }
    }

    const table = $createTableNode();
    const normalizedManualColWidths = normalizeTableColumnWidths(manualColWidths, maxCells);
    if (normalizedManualColWidths) {
      table.setColWidths(normalizedManualColWidths);
    }

    for (const cells of rows) {
      const tableRow = $createTableRowNode();
      table.append(tableRow);

      // Pad rows to have consistent column count
      for (let i = 0; i < maxCells; i++) {
        tableRow.append(i < cells.length ? cells[i] : $createTableCell(''));
      }
    }

    // Merge with preceding table if same column count
    const previousSibling = parentNode.getPreviousSibling();
    if (
      !normalizedManualColWidths &&
      $isTableNode(previousSibling) &&
      getTableColumnsSize(previousSibling) === maxCells
    ) {
      previousSibling.append(...table.getChildren());
      parentNode.remove();
    } else {
      parentNode.replace(table);
    }

    table.selectEnd();
  },
  type: 'element'
};

// Filter out Lexical's built-in HIGHLIGHT (uses ==text== syntax which conflicts with our formula).
// Move INLINE_CODE (tag '`') to the end so that on export, code backticks nest inside emphasis
// markers (e.g. **`code`** not `**code**`). CommonMark treats backtick content as literal, so
// code-wrapping-bold would lose the bold format on reimport. Import is unaffected because
// Lexical's findOutermostTextFormatTransformer resolves nesting by position, not array order.
const FILTERED_TEXT_FORMAT_TRANSFORMERS = [
  ...TEXT_FORMAT_TRANSFORMERS.filter((t) => !('tag' in t && (t.tag === '==' || t.tag === '`'))),
  ...TEXT_FORMAT_TRANSFORMERS.filter((t) => 'tag' in t && t.tag === '`'),
];

/**
 * Comment marker transformer — handles export of MarkNode to inline markers.
 *
 * Export: When $convertToMarkdownString encounters a MarkNode child, this
 * transformer's export() intercepts it, serializes its children via the
 * callback, and wraps the result with %%m:ids:start%%...%%m:ids:end%% anchors.
 * For nested MarkNodes, all IDs are merged into the outermost marker.
 *
 * Import: Handled by $processCommentMarkers in comment-import.ts (post-processing
 * after $convertFromMarkdownString), since markers span across TextNode boundaries
 * and can't be matched by a single regex within one text node.
 */
const COMMENT_MARKER_TRANSFORMER: TextMatchTransformer = {
  dependencies: [MarkNode],
  export: (node, exportChildren) => {
    if (!$isMarkNode(node)) {
      return null;
    }

    // Collect all IDs from this MarkNode and any nested MarkNodes.
    // This handles overlapping comments: MarkNode(a) > MarkNode(b) > Text
    // becomes %%m:a,b:start%%text%%m:a,b:end%% rather than nested anchors.
    const allIds = new Set<string>();

    const collectIds = (n: import('lexical').LexicalNode) => {
      if ($isMarkNode(n)) {
        for (const id of n.getIDs()) {
          allIds.add(id);
        }
        for (const child of n.getChildren()) {
          collectIds(child);
        }
      }
    };
    collectIds(node);

    if (allIds.size === 0) {
      return null;
    }

    // Serialize children via the callback (handles text formatting, nested nodes, etc.)
    const innerContent = exportChildren(node);
    const idStr = Array.from(allIds).join(',');

    return `%%m:${idStr}:start%%${innerContent}%%m:${idStr}:end%%`;
  },
  // Import is handled by $processCommentMarkers post-processing, not by this regex.
  // These patterns are set to never match during import/live-editing.
  importRegExp: /(?!)/,
  regExp: /(?!)$/,
  replace: () => {
    // Never called — import is handled by $processCommentMarkers
  },
  trigger: '',
  type: 'text-match'
};

/**
 * Wraps block-level markdown with comment anchors if the source node has comment IDs.
 */
function wrapWithCommentMarkers(node: LexicalNode, md: string): string {
  if ($isCommentableDecorator(node)) {
    const ids = node.getCommentIds();
    if (ids.length > 0) {
      const idList = ids.join(',');
      return `%%m:${idList}:start%%\n${md}\n%%m:${idList}:end%%`;
    }
  }
  return md;
}

/**
 * Wraps inline markdown with comment anchors if the source node has comment IDs.
 */
function wrapInlineWithCommentMarkers(node: LexicalNode, md: string): string {
  if ($isCommentableDecorator(node)) {
    const ids = node.getCommentIds();
    if (ids.length > 0) {
      const idList = ids.join(',');
      return `%%m:${idList}:start%%${md}%%m:${idList}:end%%`;
    }
  }
  return md;
}

// Chart transformer - exports ChartNodes to ```moss-chart code blocks
// Import is handled via $convertMossCustomCodeNodes post-processing
const CHART_TRANSFORMER: ElementTransformer = {
  dependencies: [ChartNode],
  export: (node) => {
    if (!$isChartNode(node)) {
      return null;
    }
    const md = exportChartToMarkdown(node.getConfig());
    return wrapWithCommentMarkers(node, md);
  },
  // This regex won't match during import (code blocks are handled by MULTILINE_ELEMENT_TRANSFORMERS)
  // We use post-processing to convert CodeNodes with moss-chart language to ChartNodes
  regExp: /^$/,
  replace: () => {
    // Never called - import is handled by $convertMossCustomCodeNodes
  },
  type: 'element'
};

/**
 * Sketch transformer - exports SketchNodes to fenced code blocks with grid text
 * Uses canonical ```moss-canvas format with 120x60 ASCII grid and [moss:grid:v2] header
 * Import is handled via $convertMossCustomCodeNodes post-processing
 */
const SKETCH_TRANSFORMER: ElementTransformer = {
  dependencies: [SketchNode],
  export: (node) => {
    if (!$isSketchNode(node)) {
      return null;
    }
    const md =
      '```' +
      MOSS_CANVAS_FENCE_NAME +
      '\n' +
      buildSketchMarkdown(node.getGrid(), node.getLabels()) +
      '\n```';
    return wrapWithCommentMarkers(node, md);
  },
  // This regex won't match during import (code blocks are handled by MULTILINE_ELEMENT_TRANSFORMERS)
  // We use post-processing to convert CodeNodes with canvas/sketch languages to SketchNodes
  regExp: /^$/,
  replace: () => {
    // Never called - import is handled by $convertMossCustomCodeNodes
  },
  type: 'element'
};

/**
 * Video transformer - exports VideoNodes to markdown image syntax.
 * Import is handled by IMAGE_TRANSFORMER, while legacy moss-video blocks
 * remain supported via $convertMossCustomCodeNodes during migration.
 */
const VIDEO_TRANSFORMER: ElementTransformer = {
  dependencies: [VideoNode],
  export: (node) => {
    if (!$isVideoNode(node)) {
      return null;
    }
    const altText = node.getAltText().replace(/\\/g, '\\\\').replace(/\]/g, '\\]');
    const md = `![${altText}](${node.getSrc()})`;
    return wrapWithCommentMarkers(node, md);
  },
  regExp: /^$/,
  replace: () => {},
  type: 'element'
};

/**
 * Web embed transformer - exports WebEmbedNodes to markdown image syntax.
 * Import is handled by IMAGE_TRANSFORMER (safe HTTPS non-image URL branch); this
 * transformer only owns export, mirroring VIDEO_TRANSFORMER. Alt-text escaping is
 * identical to IMAGE_TRANSFORMER so round-trip is byte-identical.
 */
const WEB_EMBED_TRANSFORMER: ElementTransformer = {
  dependencies: [WebEmbedNode],
  export: (node) => {
    if (!$isWebEmbedNode(node)) {
      return null;
    }
    const altText = node.getAltText().replace(/\\/g, '\\\\').replace(/\]/g, '\\]');
    const md = `![${altText}](${node.getUrl()})`;
    return wrapWithCommentMarkers(node, md);
  },
  regExp: /^$/,
  replace: () => {},
  type: 'element'
};

/**
 * CodeBlock transformer - exports CodeBlockNodes to fenced code blocks
 * Import: handled via $convertMossCustomCodeNodes post-processing (converts CodeNode → CodeBlockNode)
 * Export: converts CodeBlockNode → standard markdown fenced code block
 */
const CODE_BLOCK_TRANSFORMER: ElementTransformer = {
  dependencies: [CodeBlockNode],
  export: (node) => {
    if (!$isCodeBlockNode(node)) {
      return null;
    }
    const rawLanguage = node.getLanguage().trim();
    const language =
      rawLanguage.length > 0 &&
      rawLanguage !== 'undefined' &&
      rawLanguage !== 'null' &&
      rawLanguage !== 'none'
        ? rawLanguage
        : 'plaintext';
    const nodeTheme = node.getTheme();
    const infoString = nodeTheme && nodeTheme !== DEFAULT_THEME
      ? `${language}--${nodeTheme}`
      : language;
    const code = node.getCode();
    const md = '```' + infoString + '\n' + code + '\n```';
    return wrapWithCommentMarkers(node, md);
  },
  // This regex won't match during import - code blocks are handled by MULTILINE_ELEMENT_TRANSFORMERS
  // which creates CodeNode. We convert CodeNode → CodeBlockNode in $convertMossCustomCodeNodes
  regExp: /^$/,
  replace: () => {
    // Never called - import is handled by $convertMossCustomCodeNodes
  },
  type: 'element'
};

// Callout transformer - exports CalloutNodes to ```moss-callout code blocks
// Import is handled via $convertMossCustomCodeNodes post-processing
const CALLOUT_TRANSFORMER: ElementTransformer = {
  dependencies: [CalloutNode],
  export: (node) => {
    if (!$isCalloutNode(node)) {
      return null;
    }
    const content = exportNestedContentToMarkdown(
      getCalloutContentTransformers(),
      node,
      CALLOUT_NESTED_CONTENT_OPTIONS
    );
    return exportCalloutToMarkdown(node.getCalloutType(), content, node.getLevel());
  },
  // This regex won't match during import (code blocks are handled by MULTILINE_ELEMENT_TRANSFORMERS)
  // We use post-processing to convert CodeNodes with moss-callout language to CalloutNodes
  regExp: /^$/,
  replace: () => {
    // Never called - import is handled by $convertMossCustomCodeNodes
  },
  type: 'element'
};

const createMediaNodeFromMarkdownImage = (
  line: string
): LexicalNode | null => {
  const classified = classifyMarkdownImageLine(line);
  if (!classified || classified.kind === 'unsupported-remote-video') {
    return null;
  }
  if (classified.kind === 'video') {
    return $createVideoNode(classified.src, classified.altText);
  }
  if (classified.kind === 'web-embed') {
    return $createWebEmbedNode(classified.src, classified.altText);
  }
  return $createImageNode(classified.src, classified.altText);
};

/**
 * Media transformer for markdown image syntax
 * Markdown syntax: ![alt text](path/to/asset.ext)
 *
 * Uses ElementTransformer because images are block-level content.
 * TextMatchTransformers only work for inline content within paragraphs,
 * but a standalone image on its own line needs to replace the entire
 * paragraph element.
 */
const IMAGE_TRANSFORMER: ElementTransformer = {
  dependencies: [ImageNode, VideoNode, WebEmbedNode],
  export: (node) => {
    if (!$isImageNode(node)) {
      return null;
    }
    // Preserve Obsidian embed syntax on round-trip
    const obsRef = node.getObsidianRef();
    if (obsRef) {
      return wrapWithCommentMarkers(node, `![[${obsRef}]]`);
    }
    const altText = node.getAltText().replace(/\\/g, '\\\\').replace(/\]/g, '\\]');
    const src = node.getSrc();
    const md = `![${altText}](${src})`;
    return wrapWithCommentMarkers(node, md);
  },
  // Match whole candidate markdown image lines and parse with a balanced parser.
  // Matching only `![` can truncate content before replace() runs.
  regExp: /^!\[.*\]\(.*\)\s*$/,
  replace: (parentNode, _children, match) => {
    const mediaNode = createMediaNodeFromMarkdownImage(match[0]);
    if (!mediaNode) {
      return $rejectLine(_children, match); // moss-multi seam: line-loss (A§12; S-conv §1.2)
    }
    parentNode.replace(mediaNode);
  },
  type: 'element'
};

const IMAGE_TEXT_MATCH_TRANSFORMER: TextMatchTransformer = {
  dependencies: [ImageNode, VideoNode, WebEmbedNode],
  importRegExp: /^!\[.*\]\(.*\)$/,
  regExp: /^!\[.*\]\(.*\)$/,
  replace: (textNode, match) => {
    if (textNode.hasFormat('code')) {
      return;
    }
    const parent = textNode.getParent();
    if (
      (!$isParagraphNode(parent) && !$isListItemNode(parent)) ||
      parent.getTextContent().trim() !== match[0]
    ) {
      return;
    }
    const mediaNode = createMediaNodeFromMarkdownImage(match[0]);
    if (!mediaNode) {
      return;
    }
    if ($isParagraphNode(parent)) {
      parent.replace(mediaNode);
      return;
    }
    textNode.replace(mediaNode);
  },
  trigger: ')',
  type: 'text-match'
};

/**
 * Raw URL lines are Moss embed candidates. This keeps persisted Markdown
 * portable (the file contains a normal URL) while letting Moss enhance safe,
 * supported standalone URLs into inline pills or tweet cards on import.
 */
const RAW_WEB_EMBED_URL_TRANSFORMER: ElementTransformer = {
  dependencies: [EmbedPillNode, ImageNode, VideoNode, WebEmbedNode],
  export: () => null,
  regExp: /^\s*(https?:\/\/[^\s<>{}|\\^[\]`]+)([\s\S]*)$/,
  replace: (parentNode, _children, match) => {
    const url = match[1];
    if (!url) {
      return;
    }
    const trailingText = match[2] ?? '';
    const hasTrailingText = trailingText.trim().length > 0;
    const embedUrl = normalizeEmbeddableWebUrl(url);
    if (hasTrailingText) {
      const paragraph = $createParagraphNode();
      if (embedUrl) {
        paragraph.append($createEmbedPillNode(embedUrl), $createTextNode(trailingText));
      } else {
        paragraph.append($createTextNode(`${url}${trailingText}`));
      }
      parentNode.replace(paragraph);
      return;
    }
    if (isTwitterStatusUrl(url)) {
      parentNode.replace($createWebEmbedNode(url));
      return;
    }
    if (isYouTubeUrl(url)) {
      parentNode.replace($createVideoNode(url, 'YouTube video'));
      return;
    }
    if (isHttpsImageUrl(url)) {
      parentNode.replace($createImageNode(url, extractAltFromUrl(url)));
      return;
    }
    if (!embedUrl) {
      const paragraph = $createParagraphNode();
      paragraph.append($createTextNode(url));
      parentNode.replace(paragraph);
      return;
    }
    const paragraph = $createParagraphNode();
    paragraph.append($createEmbedPillNode(embedUrl));
    parentNode.replace(paragraph);
  },
  type: 'element'
};

/** Obsidian wiki-link embed: ![[image.png]] */
const OBSIDIAN_EMBED_TRANSFORMER: ElementTransformer = {
  dependencies: [ImageNode],
  export: () => null, // IMAGE_TRANSFORMER handles export via __obsidianRef
  regExp: /^!\[\[([^\]]+)\]\]\s*$/,
  replace: (parentNode, _children, match) => {
    const [, ref] = match;
    // Obsidian embed refs can include optional display params (e.g. |100x200).
    // For rendering, resolve only the target path portion before metadata.
    const target = ref.split('|', 1)[0]?.trim() ?? ref;
    const imageNode = $createImageNode(target, '');
    imageNode.setObsidianRef(ref);
    parentNode.replace(imageNode);
  },
  type: 'element'
};

/**
 * Raw HTML blockquote transformer.
 *
 * Obsidian renders `<blockquote ...>...</blockquote>` in reading view as quote
 * content. We preserve the original HTML verbatim for lossless export while
 * rendering a readable quote preview in the editor.
 */
const HTML_BLOCKQUOTE_TRANSFORMER: ElementTransformer = {
  dependencies: [HtmlBlockquoteNode],
  export: (node) => {
    if (node.getType() !== 'html-block') {
      return null;
    }
    const htmlNode = node as HtmlBlockquoteNode;
    if (htmlNode.getSource() === 'fenced') {
      const rawHtml = htmlNode.getRawHtml();
      const fence = buildMossHtmlFence(rawHtml);
      return wrapWithCommentMarkers(
        node,
        buildMossHtmlFenceStart(htmlNode, fence) + '\n' + rawHtml + '\n' + fence
      );
    }
    return wrapWithCommentMarkers(node, htmlNode.getRawHtml());
  },
  regExp: /^(<blockquote\b[\s\S]*<\/blockquote>|&lt;blockquote\b[\s\S]*&lt;\/blockquote&gt;)\s*$/i,
  replace: (parentNode, _children, match) => {
    const matched = match[1] ?? match[0];
    const rawHtml = normalizeRawHtmlBlockquote(matched);
    parentNode.replace($createHtmlBlockquoteNode(rawHtml, 'blockquote'));
  },
  type: 'element'
};

const normalizeRawHtmlBlockquote = (value: string): string =>
  value.startsWith('&lt;') || value.startsWith('&LT;')
    ? unescapeHtmlEntities(value)
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/gi, "'")
        .replace(/&amp;/gi, '&')
    : value;

const buildMossHtmlFenceStart = (_node: HtmlBlockquoteNode, fence: string): string =>
  `${fence}moss-html`;

const buildMossHtmlFence = (rawHtml: string): string => buildMarkdownFence(rawHtml);

const CALLOUT_NESTED_CONTENT_OPTIONS: NestedContentOptions = {
  excludedDependencies: [CalloutNode],
  preserveNewLines: true
};

const TAB_NESTED_CONTENT_OPTIONS: NestedContentOptions = {
  excludedDependencies: [TabGroupNode]
};

export function getCalloutContentTransformers(): Transformer[] {
  return createNestedContentTransformers(
    MARKDOWN_EDITOR_TRANSFORMERS,
    CALLOUT_NESTED_CONTENT_OPTIONS
  );
}

export function getTabContentTransformers(): Transformer[] {
  return createNestedContentTransformers(
    MARKDOWN_EDITOR_TRANSFORMERS,
    TAB_NESTED_CONTENT_OPTIONS
  );
}

const TABS_MULTILINE_TRANSFORMER: MultilineElementTransformer = {
  dependencies: [TabGroupNode],
  regExpStart: /^:::\s*tabs\s*$/,
  regExpEnd: /^:::\s*$/,
  replace: (_rootNode, _children, _startMatch, _endMatch, _linesInBetween, isImport) => {
    if (!isImport) {
      return false;
    }
    return false;
  },
  export: (node: LexicalNode) => {
    if (!$isTabGroupNode(node)) {
      return null;
    }
    const lines: string[] = [':::tabs'];
    for (const panel of node.getTabPanels()) {
      lines.push(`=== ${panel.getLabel()}`);
      const content = exportNestedContentToMarkdown(
        getTabContentTransformers(),
        panel,
        TAB_NESTED_CONTENT_OPTIONS
      );
      if (content) lines.push(content);
      lines.push('');
    }
    lines.push(':::');
    lines.push('');
    return lines.join('\n');
  },
  handleImportAfterStartMatch: ({ lines, startLineIndex, rootNode }) => {
    const endRegExp = /^:::\s*$/;
    const tabHeaderRegExp = /^===\s+(.+)$/;
    const codeFenceRegExp = /^(`{3,}|~{3,})/;
    // Matches opening ::: blocks like :::chart, :::callout, :::sketch, etc.
    const colonBlockOpenRegExp = /^:::\s*\S/;

    let inCodeFence = false;
    let codeFenceMarker = '';
    let colonBlockDepth = 0;
    const tabs: Array<{ label: string; contentLines: string[] }> = [];
    let currentTab: { label: string; contentLines: string[] } | null = null;

    for (let i = startLineIndex + 1; i < lines.length; i += 1) {
      const line = lines[i];

      // Track code fence state
      const fenceMatch = line.match(codeFenceRegExp);
      if (fenceMatch) {
        if (!inCodeFence) {
          inCodeFence = true;
          codeFenceMarker = fenceMatch[1]; // e.g. "```" or "~~~"
        } else {
          // Closing fence: same char, at least as many repetitions, nothing else on the line
          const char = codeFenceMarker[0];
          const trimmed = line.trim();
          if (
            trimmed.length >= codeFenceMarker.length &&
            trimmed === char.repeat(trimmed.length)
          ) {
            inCodeFence = false;
            codeFenceMarker = '';
          }
        }
      }

      // Only match delimiters outside code fences
      if (!inCodeFence) {
        // Track nested ::: blocks (chart, callout, sketch, etc.)
        if (colonBlockOpenRegExp.test(line)) {
          colonBlockDepth++;
          if (currentTab) {
            currentTab.contentLines.push(line);
          }
          continue;
        }

        // Check for closing :::
        if (endRegExp.test(line)) {
          // If inside a nested ::: block, close that block instead
          if (colonBlockDepth > 0) {
            colonBlockDepth--;
            if (currentTab) {
              currentTab.contentLines.push(line);
            }
            continue;
          }
          // Finalize current tab
          if (currentTab) {
            // Trim trailing empty lines from tab content
            while (currentTab.contentLines.length > 0 && currentTab.contentLines[currentTab.contentLines.length - 1] === '') {
              currentTab.contentLines.pop();
            }
            currentTab = null;
          }

          if (tabs.length > 0) {
            const tabGroupNode = $createTabGroupNode();
            for (const tab of tabs) {
              const panel = $createTabPanelNode(tab.label);
              const content = tab.contentLines.join('\n');
              importMarkdownIntoNestedContent(
                content,
                getTabContentTransformers(),
                panel,
                (container, options) => $postImportNormalize(undefined, container, options),
                TAB_NESTED_CONTENT_OPTIONS
              );
              tabGroupNode.append(panel);
            }
            rootNode.append(tabGroupNode);
            return [true, i] as [boolean, number];
          }
          return null;
        }

        // Check for tab header
        const tabMatch = colonBlockDepth === 0 ? line.match(tabHeaderRegExp) : null;
        if (tabMatch) {
          // Finalize previous tab
          if (currentTab) {
            while (currentTab.contentLines.length > 0 && currentTab.contentLines[currentTab.contentLines.length - 1] === '') {
              currentTab.contentLines.pop();
            }
          }
          currentTab = {
            label: tabMatch[1].trim(),
            contentLines: []
          };
          tabs.push(currentTab);
          continue;
        }
      }

      // Accumulate content into current tab
      if (currentTab) {
        currentTab.contentLines.push(line);
      } else if (line.trim() !== '') {
        // Non-blank content before first === header — refuse to parse
        return null;
      }
    }

    // No closing ::: found
    return null;
  },
  type: 'multiline-element'
};

const HTML_BLOCKQUOTE_MULTILINE_TRANSFORMER: MultilineElementTransformer = {
  dependencies: [HtmlBlockquoteNode],
  regExpStart: /^\s*(<blockquote\b[^>]*>|&lt;blockquote\b[\s\S]*&gt;)\s*$/i,
  regExpEnd: /^\s*(<\/blockquote>|&lt;\/blockquote&gt;)\s*$/i,
  replace: (_rootNode, _children, _startMatch, _endMatch, _linesInBetween, isImport) => {
    if (!isImport) {
      return false;
    }

    return false;
  },
  handleImportAfterStartMatch: ({ lines, startLineIndex, startMatch, rootNode }) => {
    const endRegExp = /^\s*(<\/blockquote>|&lt;\/blockquote&gt;)\s*$/i;

    for (let endLineIndex = startLineIndex + 1; endLineIndex < lines.length; endLineIndex += 1) {
      if (!endRegExp.test(lines[endLineIndex])) {
        continue;
      }

      const rawHtml = normalizeRawHtmlBlockquote(
        [
          startMatch[0],
          ...lines.slice(startLineIndex + 1, endLineIndex),
          lines[endLineIndex]
        ].join('\n')
      );

      rootNode.append($createHtmlBlockquoteNode(rawHtml, 'blockquote'));
      return [true, endLineIndex];
    }

    return null;
  },
  type: 'multiline-element'
};

const MOSS_HTML_FENCE_START_RE = /^ {0,3}(`{3,})moss-html(?:\s+.*)?$/;

const MOSS_HTML_MULTILINE_TRANSFORMER: MultilineElementTransformer = {
  dependencies: [HtmlBlockquoteNode],
  regExpStart: MOSS_HTML_FENCE_START_RE,
  regExpEnd: /^ {0,3}`{3,}\s*$/,
  replace: (_rootNode, _children, _startMatch, _endMatch, _linesInBetween, isImport) => {
    if (!isImport) {
      return false;
    }
    return false;
  },
  handleImportAfterStartMatch: ({ lines, startLineIndex, rootNode }) => {
    const startLine = lines[startLineIndex] ?? '';
    const startMatch = startLine.match(MOSS_HTML_FENCE_START_RE);
    if (!startMatch) return null;
    const fence = startMatch[1];
    const endRegExp = new RegExp(`^ {0,3}\`{${fence.length},}\\s*$`);

    for (let endLineIndex = startLineIndex + 1; endLineIndex < lines.length; endLineIndex += 1) {
      if (!endRegExp.test(lines[endLineIndex])) {
        continue;
      }

      const rawHtml = lines.slice(startLineIndex + 1, endLineIndex).join('\n');
      rootNode.append($createHtmlBlockquoteNode(rawHtml, 'fenced'));
      return [true, endLineIndex];
    }

    return null;
  },
  type: 'multiline-element'
};

// Accept empty checklist lines without a trailing space ("- [ ]") so reload
// doesn't split mixed checklists into separate list nodes.
const CHECK_LIST_WITH_OPTIONAL_TRAILING_SPACE: ElementTransformer = {
  ...CHECK_LIST,
  regExp: /^(\s*)(?:[-*+]\s)?\s?(\[(\s|x)?\])(?:\s|$)/i
};

export const MARKDOWN_EDITOR_TRANSFORMERS: Transformer[] = [
  // Custom element transformers for block-level content
  // Obsidian embed must come before standard image so ![[ref]] is matched first
  OBSIDIAN_EMBED_TRANSFORMER,
  HTML_BLOCKQUOTE_TRANSFORMER,
  IMAGE_TRANSFORMER,
  RAW_WEB_EMBED_URL_TRANSFORMER,
  SKETCH_TRANSFORMER,
  CHART_TRANSFORMER,
  VIDEO_TRANSFORMER,
  WEB_EMBED_TRANSFORMER,
  CALLOUT_TRANSFORMER,
  CODE_BLOCK_TRANSFORMER,
  GFM_TABLE_MULTILINE_TRANSFORMER,
  TABLE_TRANSFORMER,
  HORIZONTAL_RULE_TRANSFORMER,
  CHECK_LIST_WITH_OPTIONAL_TRAILING_SPACE,
  ...ELEMENT_TRANSFORMERS,
  TABS_MULTILINE_TRANSFORMER,
  MOSS_HTML_MULTILINE_TRANSFORMER,
  HTML_BLOCKQUOTE_MULTILINE_TRANSFORMER,
  ...MULTILINE_ELEMENT_TRANSFORMERS,
  // Custom text-match transformers for inline content (patterns within paragraphs)
  // COMMENT_MARKER_TRANSFORMER must be first — it intercepts MarkNode children
  // before other transformers process them, wrapping with %%m:ID:start%%...%%m:ID:end%%
  COMMENT_MARKER_TRANSFORMER,
  FORMULA_TRANSFORMER,
  IMAGE_TEXT_MATCH_TRANSFORMER,
  FORMATTED_EMBED_PILL_TRANSFORMER,
  // EMBED_PILL_TRANSFORMER must come BEFORE LINK_TRANSFORMER so legacy
  // ?[text](url) pills are claimed before the [text](url) link match.
  EMBED_PILL_TRANSFORMER,
  SELF_REFERENTIAL_LINK_EMBED_PILL_TRANSFORMER,
  // LINK_TRANSFORMER must come BEFORE FILE_LINK_TRANSFORMER so [text](url)
  // is matched before [[wiki]] syntax during import
  LINK_TRANSFORMER,
  RAW_WEB_EMBED_URL_TEXT_TRANSFORMER,
  FILE_LINK_TRANSFORMER,
  COLOR_TRANSFORMER,
  OBSIDIAN_HIGHLIGHT_TRANSFORMER,
  ...FILTERED_TEXT_FORMAT_TRANSFORMERS,
  ...TEXT_MATCH_TRANSFORMERS,
  // Our custom HTML-based highlight, underline, and font-family transformers
  HIGHLIGHT_TRANSFORMER,
  UNDERLINE_TRANSFORMER,
  FONT_FAMILY_TRANSFORMER
];

// Initialize circular reference after MARKDOWN_EDITOR_TRANSFORMERS is defined
TABLE_TRANSFORMERS = MARKDOWN_EDITOR_TRANSFORMERS;

export const MARKDOWN_EDITOR_NODES = [
  HeadingNode,
  QuoteNode,
  ListNode,
  ListItemNode,
  CodeNode,
  CodeHighlightNode,
  CalloutNode,
  CodeBlockNode,
  LinkNode,
  AutoLinkNode,
  LineBreakNode,
  HorizontalRuleNode,
  FormulaNode,
  FileLinkNode,
  EmbedPillNode,
  ColorCodeNode,
  ChartNode,
  ImageNode,
  SketchNode,
  VideoNode,
  WebEmbedNode,
  HtmlBlockquoteNode,
  TabGroupNode,
  TabPanelNode,
  TableNode,
  TableRowNode,
  TableCellNode,
  MarkNode
];

export { $normalizeSelectionTableCells, CALLOUT_NESTED_CONTENT_OPTIONS, extractTableRowContent, getTopLevelElementOrNull, isTableDividerRow, splitTableRow, trimRawWebEmbedUrl };
