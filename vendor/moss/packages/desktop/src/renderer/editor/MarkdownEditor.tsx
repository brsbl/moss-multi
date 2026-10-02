// ported-from: packages/desktop/src/renderer/editor/MarkdownEditor.tsx @ 762abb777
import type { ReactNode } from 'react';
import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useAtomValue, useSetAtom, useStore } from 'jotai';

import { LexicalComposer } from '@lexical/react/LexicalComposer';
import type { InitialConfigType } from '@lexical/react/LexicalComposer';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { ContentEditable } from '@lexical/react/LexicalContentEditable';
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary';
import { HistoryPlugin } from '@lexical/react/LexicalHistoryPlugin';
import { OnChangePlugin } from '@lexical/react/LexicalOnChangePlugin';
import { RichTextPlugin } from '@lexical/react/LexicalRichTextPlugin';
import { MarkdownShortcutPlugin } from '@lexical/react/LexicalMarkdownShortcutPlugin';
import { CheckListPlugin } from '@lexical/react/LexicalCheckListPlugin';
import { HorizontalRulePlugin } from '@lexical/react/LexicalHorizontalRulePlugin';
import { TablePlugin } from '@lexical/react/LexicalTablePlugin';
import { AutoLinkPlugin, createLinkMatcherWithRegExp } from '@lexical/react/LexicalAutoLinkPlugin';
import { $insertGeneratedNodes } from '@lexical/clipboard';
import {
  HorizontalRuleNode,
  $createHorizontalRuleNode,
  $isHorizontalRuleNode
} from '@lexical/react/LexicalHorizontalRuleNode';
import {
  TableNode,
  TableRowNode,
  TableCellNode,
  TableCellHeaderStates,
  $createTableNode,
  $createTableRowNode,
  $createTableCellNode,
  $isTableNode,
  $isTableRowNode,
  $isTableCellNode
} from '@lexical/table';
import {
  ELEMENT_TRANSFORMERS,
  MULTILINE_ELEMENT_TRANSFORMERS,
  TEXT_FORMAT_TRANSFORMERS,
  TEXT_MATCH_TRANSFORMERS,
  CHECK_LIST,
  $convertFromMarkdownString,
  $convertToMarkdownString,
  type TextMatchTransformer,
  type ElementTransformer,
  type MultilineElementTransformer,
  type Transformer
} from '@lexical/markdown';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $isDecoratorNode,
  $isElementNode,
  $isLineBreakNode,
  $isParagraphNode,
  $isTextNode,
  LineBreakNode,
  TextNode
} from 'lexical';
import { CodeNode, CodeHighlightNode } from '@lexical/code';
import { MarkNode, $isMarkNode } from '@lexical/mark';
import { HeadingNode, QuoteNode, $isHeadingNode, $isQuoteNode, $createHeadingNode, type HeadingTagType } from '@lexical/rich-text';
import {
  $insertList,
  $isListItemNode,
  $isListNode,
  INSERT_CHECK_LIST_COMMAND,
  INSERT_ORDERED_LIST_COMMAND,
  INSERT_UNORDERED_LIST_COMMAND,
  ListItemNode,
  ListNode,
  type ListType,
  REMOVE_LIST_COMMAND
} from '@lexical/list';
import { AutoLinkNode, LinkNode, $createLinkNode, $isLinkNode, $toggleLink } from '@lexical/link';
import { ListPlugin } from '@lexical/react/LexicalListPlugin';
import { $getSelectionStyleValueForProperty, $patchStyleText } from '@lexical/selection';
import { objectKlassEquals, $findMatchingParent } from '@lexical/utils';
import type { BaseSelection, DOMConversionMap, DOMConversionOutput, EditorState, LexicalNode, LexicalEditor, SerializedEditorState, TextFormatType } from 'lexical';
import {
  $addUpdateTag,
  $createNodeSelection,
  $createRangeSelection,
  $getNearestNodeFromDOMNode,
  $getNodeByKey,
  $getSelection,
  $isNodeSelection,
  $isRangeSelection,
  $isRootNode,
  $setSelection,
  COMMAND_PRIORITY_CRITICAL,
  COMMAND_PRIORITY_HIGH,
  COMMAND_PRIORITY_LOW,
  COMMAND_PRIORITY_NORMAL,
  CONTROLLED_TEXT_INSERTION_COMMAND,
  FORMAT_TEXT_COMMAND,
  INDENT_CONTENT_COMMAND,
  IS_BOLD,
  IS_ITALIC,
  IS_STRIKETHROUGH,
  KEY_BACKSPACE_COMMAND,
  KEY_DELETE_COMMAND,
  KEY_DOWN_COMMAND,
  OUTDENT_CONTENT_COMMAND,
  PASTE_COMMAND,
  SKIP_DOM_SELECTION_TAG,
  SKIP_SCROLL_INTO_VIEW_TAG,
  SELECTION_CHANGE_COMMAND
} from 'lexical';
import { CLEAR_HISTORY_COMMAND, REDO_COMMAND, UNDO_COMMAND } from 'lexical';
import { ALargeSmall, Bold, Bot, CheckSquare, ChevronDown, Code2, Columns2, CornerDownLeft, Highlighter, IndentDecrease, IndentIncrease, Italic, Link2, List, ListOrdered, SquarePlus, StickyNote, Strikethrough, Unlink } from 'lucide-react';


import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@moss/shared/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@moss/shared/components/ui/tooltip';
import { cn } from '@moss/shared/lib/utils';
import { KeyboardShortcut } from '@moss/shared/components/ui/keyboard-shortcut';
import { actionsPanelHiddenAtom, browserSplitTargetAtom, focusedPaneAtom, notesPanelHiddenAtom, openBrowserSplitAtom, pendingScrollTargetAtom, showCommandPaletteAtom, toolbarPortalTargetAtom } from '@moss/shared/state/atoms';
import { noteCommentsMapAtom } from '@moss/shared/state/note-atoms';
import {
  clearRendererErrorAnalyticsContext,
  setRendererErrorAnalyticsContext
} from '../error-analytics';
import { AutoArrowPlugin } from './AutoArrowPlugin';
import { AutoDividerPlugin } from './AutoDividerPlugin';
import { DoubleEmptyListExitPlugin } from './DoubleEmptyListExitPlugin';
import { ListHotkeyPlugin } from './ListHotkeyPlugin';
import { ChecklistPreservePlugin } from './ChecklistPreservePlugin';
import { ChecklistSortPlugin } from './ChecklistSortPlugin';
import { MathCalculationPlugin } from './MathCalculationPlugin';
import { buildCommentMetadata } from './utils/comment-export';
import {
  buildCommentMetadataSignature,
  containsCommentAnchors,
  hasLegacyCommentFooter,
  parseCommentFooter,
  type CommentMetadataMap
} from './utils/comment-markdown';
import type { NoteLayoutMetadata } from '../../common/noteTypes';
import { extractLeadingH1 } from '../../common/markdown-utils';
import { isSafeWebBrowserUrl, normalizeWebBrowserUrl } from '../../common/web-embed-url';
import {
  MOSS_CANVAS_FENCE_NAME,
  buildMarkdownFence,
  isMossCanvasFenceName,
  scanMossHtmlFenceBlocks
} from '../../common/markdown-fences';
import { computeContentHash } from '../../common/content-hash';
import { splitFrontmatter } from './utils/noteFrontmatter';
import { $processCommentMarkers, normalizeCommentWrappedAtxHeadings, normalizeCommentWrappedImages } from './utils/comment-import';
import { $isCommentableDecorator } from './utils/commentable-node';
import {
  MOSS_NOTE_LINK_CLIPBOARD_MIME,
  type MossNoteLinkClipboardPayload,
  parseMossNoteLinkClipboardPayload,
  parseMossNoteLinkPayloadFromHtml,
  parseWikiLinkTarget
} from './utils/note-link-clipboard';
import {
  parseFormulaMarkdownPayload,
  serializeFormulaMarkdownPayload
} from './utils/formula-runtime';
import {
  createNestedContentTransformers,
  exportNestedContentToMarkdown,
  importMarkdownIntoNestedContent,
  type NestedContentOptions
} from './utils/nested-editable-block';
import { CodeFormatBoundaryPlugin } from './plugins/CodeFormatBoundaryPlugin';
import { FormatWhitespaceBoundaryPlugin } from './plugins/FormatWhitespaceBoundaryPlugin';
import { FocusGuardPlugin } from './plugins/FocusGuardPlugin';
import { FormulaPlugin } from './plugins/FormulaPlugin';
import { TableActionMenuPlugin } from './plugins/TableActionMenuPlugin';
import { TableColumnLayoutPlugin } from './plugins/TableColumnLayoutPlugin';
import { TableColumnResizePlugin } from './plugins/TableColumnResizePlugin';
import { TableExitPlugin } from './plugins/TableExitPlugin';
import { CodeHighlighterPlugin, DEFAULT_THEME } from './plugins/code-block';
import { TabIndentPlugin } from './TabIndentPlugin';
import { SlashCommandPlugin } from './slash-commands';
import { EmojiPickerPlugin } from './emoji-picker';
import {
  FormulaNode,
  $createFormulaNode,
  $isFormulaNode
} from './nodes/FormulaNode';
import {
  FileLinkNode,
  $createFileLinkNode,
  $isFileLinkNode
} from './nodes/FileLinkNode';
import {
  EmbedPillNode,
  $createEmbedPillNode,
  $isEmbedPillNode,
  unescapeEmbedPillDisplayText
} from './nodes/EmbedPillNode';
import {
  ChartNode,
  $createChartNode,
  $isChartNode,
  exportChartToMarkdown
} from './nodes/ChartNode';
import { parseChartConfig } from './utils/chartDefaults';
import {
  ImageNode,
  OPEN_IMAGE_ALT_TEXT_EDITOR_COMMAND,
  $createImageNode,
  $isImageNode
} from './nodes/ImageNode';
import {
  SketchNode,
  $createSketchNode,
  $isSketchNode,
  buildSketchMarkdown,
  parseSketchBlock
} from './nodes/SketchNode';
import {
  VideoNode,
  $createVideoNode,
  $isVideoNode
} from './nodes/VideoNode';
import {
  WebEmbedNode,
  $createWebEmbedNode,
  $isWebEmbedNode
} from './nodes/WebEmbedNode';
import {
  extractYouTubeVideoId,
  isLocalVideoPath,
  isYouTubeUrl
} from './utils/video-url';
import { extractAltFromUrl, isHttpsImageUrl } from './utils/remote-image-url';
import { classifyMarkdownImageLine } from './utils/markdown-image';
import {
  isTwitterStatusUrl,
  normalizeEmbeddableWebUrl
} from './utils/web-embed-classify';
import {
  CodeBlockNode,
  $createCodeBlockNode,
  $isCodeBlockNode,
  markCodeBlockForAutoEdit
} from './nodes/CodeBlockNode';
import {
  CalloutNode,
  $createCalloutNode,
  $isCalloutNode,
  exportCalloutToMarkdown,
  parseCalloutContent
} from './nodes/CalloutNode';
import {
  HtmlBlockquoteNode,
  $createHtmlBlockquoteNode
} from './nodes/HtmlBlockquoteNode';
import {
  TabGroupNode,
  $createTabGroupNode,
  $isTabGroupNode
} from './nodes/TabGroupNode';
import { TabPanelNode, $createTabPanelNode } from './nodes/TabPanelNode';
import { FileLinkPlugin, scrollToHeading } from './plugins/FileLinkPlugin';
import { FileLinkTypeaheadPlugin } from './plugins/FileLinkTypeaheadPlugin';
import {
  clearPendingScrollTargetIfMatch,
  isPendingScrollTargetForNote
} from './utils/pending-scroll-target';
import { buildCommentNodeKeyCandidates } from './utils/comment-node-key';
import { CommentPlugin, CREATE_COMMENT_COMMAND, OPEN_BLOCK_COMMENT_COMMAND, commentInputStateAtom } from './plugins/CommentPlugin';
import { CommentAnchorTrackerPlugin } from './plugins/CommentAnchorTrackerPlugin';
import { Popover } from '@moss/shared/primitives';
import { CommentInputPopover } from './components/CommentInputPopover';
import { CommentUIWrapper } from './components/CommentUIWrapper';
import { DecoratorBlockPlugin } from './plugins/DecoratorBlockPlugin';
import { CalloutControlsPlugin } from './plugins/CalloutControlsPlugin';
import { TabBarPlugin } from './plugins/TabBarPlugin';
import { TabExitPlugin } from './plugins/TabExitPlugin';
import { TabSelectionScopePlugin } from './plugins/TabSelectionScopePlugin';
import { CollapsibleHeadingPlugin } from './plugins/CollapsibleHeadingPlugin';
import { EDITOR_UPDATE_TAGS } from './utils/editorUpdateTags';
import { SafePastePlugin } from './plugins/SafePastePlugin';
import { MediaDropPlugin } from './plugins/MediaDropPlugin';
import { ExternalImagePastePlugin } from './plugins/ExternalImagePastePlugin';
import { VideoPastePlugin } from './plugins/VideoPastePlugin';
import { WebpageEmbedPastePlugin } from './plugins/WebpageEmbedPastePlugin';
import { EmbedPillPlugin } from './plugins/EmbedPillPlugin';
import { SearchPlugin } from './plugins/SearchPlugin';
import { EditorInputSamplingPlugin } from './plugins/EditorInputSamplingPlugin';
import { ColorCodeConversionPlugin, ColorCodePlugin } from './plugins/ColorCodePlugin';
import {
  ColorCodeNode,
  $createColorCodeNode,
  $isColorCodeNode
} from './nodes/ColorCodeNode';
import {
  COLOR_TRANSFORMER_IMPORT_REGEXP,
  COLOR_TRANSFORMER_REGEXP,
  isAfterUnclosedBacktick,
  isInsideUnclosedDelimiter,
  isInsideInlineCodeSpan
} from './utils/color-codes';
import { $isInsideColorSuppressedRawContext } from './utils/colorPickerTriggers';
import { MediaSourceDialog } from './dialogs/MediaSourceDialog';
import { useMediaSourceDialog, setGlobalMediaSourceDialogOpener } from './dialogs/useMediaSourceDialog';
import {
  CurrentNoteIdContext,
  CurrentNoteIdEditorPlugin
} from './CurrentNoteIdContext';
import {
  SELECTION_TOOLBAR_BUTTON_ACCENT_CLASS,
  SELECTION_TOOLBAR_BUTTON_BASE_CLASS,
  SELECTION_TOOLBAR_BUTTON_IDLE_CLASS,
  SELECTION_TOOLBAR_BUTTON_PRESS_CLASS,
  SelectionToolbarDivider,
  SelectionToolbarInner,
  SelectionToolbarShell
} from './components/SelectionToolbarPrimitives';
import './MarkdownEditor.css';

export type EditorRemountReason = 'disk_content_changed' | 'in_place_import_failed';

export interface MarkdownEditorProps {
  noteId: string;
  value: string;
  layoutMetadata?: NoteLayoutMetadata;
  onChange: (editorState: EditorState, tags: Set<string>) => void;
  placeholder?: string;
  readOnly?: boolean;
  initialSerializedState?: SerializedEditorState | null;
  onReady?: (editor: LexicalEditor) => void;
  onBlur?: () => void;
  onNavigateToNote?: (noteId: string, heading?: string | null) => void;
  /** Whether the note is trashed - used to show deletion countdown in toolbar */
  isTrashed?: boolean;
  /** Unix timestamp (seconds) when note was trashed - used to calculate days remaining */
  trashedAt?: number | null;
  /** Callback to open the command palette (cmd+K) */
  onActionClick?: () => void;
  /** Reports whether the current selection can open the native Edit Alt Text action. */
  onSelectedImageAltTextAvailabilityChange?: (enabled: boolean) => void;
  paneId?: 'left' | 'right';
  enableSearchPlugin?: boolean;
  editorMountVersion?: number;
  editorRemountReason?: EditorRemountReason | null;
}

export type MarkdownEditorHandle = {
  /** Focuses the editor and places a collapsed selection at the start of the body. */
  focusStart: () => boolean;
  /** Focuses the editor at the text position nearest a canvas click. */
  focusAtPoint: (clientX: number, clientY: number) => boolean;
  serializeCurrent: () =>
    | {
        markdown: string;
        serializedState: SerializedEditorState | null;
      }
    | null;
  /** Returns the currently selected text in the editor, or empty string if no selection */
  getSelectedText: () => string;
  /** Marks the current selection with a background highlight and returns the selected text.
   * The highlight persists when the editor loses focus, allowing users to see what text
   * was captured for the prompt context. */
  markSelectionAsContext: () => string;
  /** Clears any context selection highlighting from the editor */
  clearContextMark: () => void;
  /** Opens the inline alt-text editor for the currently selected image node. */
  openSelectedImageAltTextEditor: () => boolean;
  /** Update editor content in-place from markdown without remounting.
   * Strips frontmatter and any legacy comment footer internally, then processes comment markers.
   * Returns success status plus extracted layers (frontmatter, body, comments)
   * so the caller can hydrate the corresponding atoms.
   * Pass scrollContainer to preserve scroll position during DOM updates. */
  updateContentFromMarkdown: (
    markdown: string,
    options?: {
      clearHistory?: boolean;
      scrollContainer?: HTMLElement | null;
      commentMetadata?: CommentMetadataMap;
      layoutMetadata?: NoteLayoutMetadata;
    }
  ) => { success: boolean; frontmatter: Record<string, unknown> | null; h1Title: string | null; body: string; comments: CommentMetadataMap };
};

const formatEditorUpdateTagsForAnalytics = (tags: Set<string>): string => {
  const normalizedTags = Array.from(tags).filter(Boolean).sort();
  return normalizedTags.length > 0 ? normalizedTags.join(',') : 'none';
};

const theme = {
  paragraph: 'moss-document-ink mb-2 text-body',
  quote: 'mb-4 border-l-2 border-border-subtle pl-4 italic text-body text-ink-muted',
  code: 'editor-code',
  // Map Lexical's CodeHighlightNode types to Prism-style token classes
  // This allows the CSS rules in MarkdownEditor.css (.editor-code .token.*) to apply
  codeHighlight: {
    atrule: 'token atrule',
    attr: 'token attr-name',
    boolean: 'token boolean',
    builtin: 'token builtin',
    cdata: 'token cdata',
    char: 'token char',
    class: 'token class-name',
    'class-name': 'token class-name',
    comment: 'token comment',
    constant: 'token constant',
    deleted: 'token deleted',
    doctype: 'token doctype',
    entity: 'token entity',
    function: 'token function',
    important: 'token important',
    inserted: 'token inserted',
    keyword: 'token keyword',
    namespace: 'token namespace',
    number: 'token number',
    operator: 'token operator',
    prolog: 'token prolog',
    property: 'token property',
    punctuation: 'token punctuation',
    regex: 'token regex',
    selector: 'token selector',
    string: 'token string',
    symbol: 'token symbol',
    tag: 'token tag',
    url: 'token url',
    variable: 'token variable'
  },
  link: 'cursor-pointer text-action-primary underline underline-offset-2 transition-colors hover:text-action-primary-hover',
  list: {
    nested: {
      listitem: 'moss-nested-listitem'
    },
    ol: 'moss-document-ink mb-2 list-decimal pl-3 text-body',
    ul: 'moss-document-ink mb-2 list-disc pl-3 text-body',
    checklist: 'moss-checklist',
    listitem: 'moss-document-ink mb-1 text-body',
    listitemChecked: 'moss-checklist-item moss-checklist-item--checked',
    listitemUnchecked: 'moss-checklist-item moss-checklist-item--unchecked'
  },
  text: {
    bold: 'font-semibold',
    italic: 'italic',
    underline: 'underline',
    strikethrough: 'moss-strikethrough line-through',
    underlineStrikethrough: 'underline moss-strikethrough line-through',
    code: 'rounded bg-surface-code px-1 py-0.5 font-mono text-[0.95em]'
  },
  heading: {
    h1: 'moss-document-ink mb-3 text-h1 tracking-title',
    h2: 'moss-document-ink mb-2 mt-4 text-h2',
    h3: 'moss-document-ink mb-2 mt-3 text-h3',
    h4: 'moss-document-ink mb-1 mt-3 text-h4'
  },
  formula: 'inline-flex items-center',
  fileLink: 'inline-flex items-center',
  embedPill: 'inline-flex items-center',
  colorCode: 'inline-flex items-center',
  table: 'moss-table',
  tableCell: 'moss-table-cell',
  tableCellHeader: 'moss-table-cell-header',
  tableRow: 'moss-table-row',
  tableScrollableWrapper: 'moss-table-scroll-shell moss-table-scroll-viewport',
  tableSelection: 'moss-table-selection',
  hrSelected: 'moss-divider-selected',
  callout: 'outline-none',
  chart: 'outline-none',
  codeBlock: 'outline-none',
  image: 'outline-none',
  sketch: 'outline-none',
  webEmbed: 'outline-none',
  htmlBlockquote: 'outline-none', htmlBlock: 'outline-none',
  mark: 'comment-mark'
};

type EditorSelectionFontFamily = 'sans' | 'serif';

const STYLE_FONT_FAMILY_PROPERTY = 'font-family';
const SERIF_FONT_FAMILY_VALUE = 'Charter, "Iowan Old Style", Georgia, Cambria, "Times New Roman", Times, serif';
// Charter's x-height is smaller than Inter's (the Sans body font, x-height ≈ 0.55em
// at 1118/2048 upm), so at an equal font-size Serif reads optically smaller than Sans.
// font-size-adjust pins the serif x-height to the same ratio, so Serif and Sans feel
// the same optical size in the editor body and in the toolbar/menu previews. It is
// presentation-only and never serialized — serif still exports as `font-family: serif`
// (see FONT_FAMILY_TRANSFORMER).
const STYLE_FONT_SIZE_ADJUST_PROPERTY = 'font-size-adjust';
const SERIF_OPTICAL_FONT_SIZE_ADJUST = '0.55';
const SERIF_FONT_FAMILY_STYLE = {
  fontFamily: SERIF_FONT_FAMILY_VALUE,
  fontSizeAdjust: SERIF_OPTICAL_FONT_SIZE_ADJUST
};

const EDITOR_FONT_FAMILY_LABELS: Record<EditorSelectionFontFamily, string> = {
  sans: 'Sans',
  serif: 'Serif'
};

const getFontFamilyValueFromStyleString = (value: string): string => {
  const match = value.match(/(?:^|;)\s*font-family\s*:\s*([^;]+)/i);
  return match?.[1]?.trim() ?? value;
};

const isSerifFontFamilyValue = (value: string): boolean => {
  const families = getFontFamilyValueFromStyleString(value)
    .split(',')
    .map((family) => family.trim().replace(/^['"]|['"]$/g, '').toLowerCase())
    .filter(Boolean);
  return families.some((family) =>
    family === 'charter' ||
    family === 'iowan old style' ||
    family === 'ui-serif' ||
    family === 'georgia' ||
    family === 'cambria' ||
    family === 'times new roman' ||
    family === 'times' ||
    family === 'serif'
  );
};

const selectionFontFamilyFromStyleValue = (value: string): EditorSelectionFontFamily =>
  isSerifFontFamilyValue(value) ? 'serif' : 'sans';

const SERIF_FONT_FAMILY_MARKDOWN_STYLE_ATTRIBUTE = ' style="font-family: serif"';
const SERIF_FONT_FAMILY_MARKDOWN_SPAN_OPEN = '<span style="font-family: serif">';
const SERIF_FONT_FAMILY_MARKDOWN_SPAN_CLOSE = '</span>';
const SERIF_FONT_FAMILY_MARKDOWN_STYLE_PATTERN =
  '[^"]*font-family\\s*:\\s*[^"]*(?:Charter|Iowan Old Style|ui-serif|Georgia|Cambria|Times New Roman|Times|(?:^|[^-])serif)[^"]*';

const Placeholder = ({ children }: { children: ReactNode }) => (
  <div className="pointer-events-none absolute inset-x-0 top-4 mx-auto w-full max-w-canvas-prose select-none text-left text-body text-ink-faint">
    {children}
  </div>
);

const HIGHLIGHT_YELLOW_VAR = '--color-highlight-yellow';
const HIGHLIGHT_YELLOW_VALUE = `var(${HIGHLIGHT_YELLOW_VAR})`;

/** All known highlight CSS variable names — used for backward-compat import of old multi-color highlights. */
const HIGHLIGHT_COLOR_VARIABLES: Record<string, string> = {
  green: '--color-highlight-green',
  yellow: HIGHLIGHT_YELLOW_VAR,
  orange: '--color-highlight-orange',
  blue: '--color-highlight-blue',
  red: '--color-highlight-red',
  purple: '--color-highlight-purple'
};

const STYLE_HIGHLIGHT_PROPERTY = 'background-color';

const HIGHLIGHT_COLOR_BY_VARIABLE = Object.fromEntries(
  Object.entries(HIGHLIGHT_COLOR_VARIABLES).map(([colorName, variable]) => [variable, colorName])
) as Record<string, string>;

const getRawInlineStyleProperty = (element: HTMLElement, property: string): string => {
  const directValue = element.style.getPropertyValue(property).trim();
  if (directValue) {
    return directValue;
  }

  const rawStyle = element.getAttribute('style') ?? '';
  const match = rawStyle.match(new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;]+)`, 'i'));
  return match?.[1]?.trim() ?? '';
};

const highlightVariableFromBackground = (backgroundColor: string): string | null => {
  if (!backgroundColor) {
    return null;
  }

  return Object.values(HIGHLIGHT_COLOR_VARIABLES).find(
    (variable) => backgroundColor === `var(${variable})` || backgroundColor.includes(variable)
  ) ?? null;
};

const highlightVariableFromElement = (element: HTMLElement): string | null => {
  const colorName = element.getAttribute('data-color') ?? '';
  if (colorName in HIGHLIGHT_COLOR_VARIABLES) {
    return HIGHLIGHT_COLOR_VARIABLES[colorName];
  }

  return highlightVariableFromBackground(getRawInlineStyleProperty(element, STYLE_HIGHLIGHT_PROPERTY));
};

const highlightColorNameFromStyle = (style: string): string | null => {
  const bgColor = style.match(/background-color:\s*([^;]+)/)?.[1]?.trim();
  const variable = bgColor ? highlightVariableFromBackground(bgColor) : null;
  return variable ? HIGHLIGHT_COLOR_BY_VARIABLE[variable] ?? null : null;
};

const hasMossHighlightHtml = (element: HTMLElement): boolean =>
  highlightVariableFromElement(element) !== null;

const getMossHtmlClassSet = (element: HTMLElement): Set<string> =>
  new Set((element.getAttribute('class') ?? '').split(/\s+/).filter(Boolean));

const hasAnyMossHtmlClass = (classSet: Set<string>, classes: string[]): boolean =>
  classes.some((className) => classSet.has(className));

const getMossHtmlTextDecoration = (element: HTMLElement): string => [
  element.style.textDecoration,
  element.style.textDecorationLine,
  getRawInlineStyleProperty(element, 'text-decoration'),
  getRawInlineStyleProperty(element, 'text-decoration-line')
].join(' ').toLowerCase();

const hasMossHtmlBoldFontWeight = (element: HTMLElement, classSet: Set<string>): boolean => {
  const fontWeight = (
    element.style.fontWeight ||
    getRawInlineStyleProperty(element, 'font-weight')
  ).trim().toLowerCase();
  const numericFontWeight = Number.parseInt(fontWeight, 10);

  return (
    fontWeight === 'bold' ||
    (Number.isFinite(numericFontWeight) && numericFontWeight >= 600) ||
    hasAnyMossHtmlClass(classSet, ['font-semibold', 'font-bold', 'font-extrabold', 'font-black'])
  );
};

const hasMossTextFormattingHtml = (element: HTMLElement): boolean => {
  const classSet = getMossHtmlClassSet(element);
  const textDecoration = getMossHtmlTextDecoration(element);
  const fontStyle = (
    element.style.fontStyle ||
    getRawInlineStyleProperty(element, 'font-style')
  ).trim().toLowerCase();
  const fontFamily = getRawInlineStyleProperty(element, STYLE_FONT_FAMILY_PROPERTY);
  const verticalAlign = (
    element.style.verticalAlign ||
    getRawInlineStyleProperty(element, 'vertical-align')
  ).trim().toLowerCase();

  return (
    hasMossHighlightHtml(element) ||
    hasMossHtmlBoldFontWeight(element, classSet) ||
    isSerifFontFamilyValue(fontFamily) ||
    fontStyle === 'italic' ||
    textDecoration.includes('underline') ||
    textDecoration.includes('line-through') ||
    verticalAlign === 'sub' ||
    verticalAlign === 'super' ||
    hasAnyMossHtmlClass(classSet, ['italic', 'underline', 'line-through', 'bg-code-surface'])
  );
};

const parseStyleObjectFromCSS = (style: string): Record<string, string> => {
  const styleObject: Record<string, string> = {};
  for (const declaration of style.split(';')) {
    const separatorIndex = declaration.indexOf(':');
    if (separatorIndex === -1) {
      continue;
    }
    const styleName = declaration.slice(0, separatorIndex).trim();
    const styleValue = declaration.slice(separatorIndex + 1).trim();
    if (styleName) {
      styleObject[styleName] = styleValue;
    }
  }
  return styleObject;
};

const setTextStyleProperty = (node: TextNode, property: string, value: string): void => {
  const styleObject = parseStyleObjectFromCSS(node.getStyle());
  styleObject[property] = value;
  node.setStyle(
    Object.entries(styleObject)
      .filter(([, styleValue]) => styleValue)
      .map(([styleName, styleValue]) => `${styleName}: ${styleValue}`)
      .join('; ')
  );
};

const setTextNodeFontFamily = (
  node: TextNode,
  fontFamily: EditorSelectionFontFamily
): void => {
  const isSerif = fontFamily === 'serif';
  setTextStyleProperty(
    node,
    STYLE_FONT_FAMILY_PROPERTY,
    isSerif ? SERIF_FONT_FAMILY_VALUE : ''
  );
  setTextStyleProperty(
    node,
    STYLE_FONT_SIZE_ADJUST_PROPERTY,
    isSerif ? SERIF_OPTICAL_FONT_SIZE_ADJUST : ''
  );
};

const getSerifFontFamilyMarkdownStyleAttribute = (node: TextNode): string =>
  isSerifFontFamilyValue(node.getStyle()) ? SERIF_FONT_FAMILY_MARKDOWN_STYLE_ATTRIBUTE : '';

const wrapSerifFontFamilyMarkdownSpan = (text: string): string =>
  `${SERIF_FONT_FAMILY_MARKDOWN_SPAN_OPEN}${text}${SERIF_FONT_FAMILY_MARKDOWN_SPAN_CLOSE}`;

const markdownStyleAttributeHasSerifFontFamily = (styleAttribute: string | undefined): boolean =>
  isSerifFontFamilyValue(
    parseStyleObjectFromCSS(styleAttribute ?? '')[STYLE_FONT_FAMILY_PROPERTY] ?? ''
  );

const unescapeInlineMarkdownText = (text: string): string =>
  text.replace(/\\([\\`*_[\]{}()#+\-.!|>])/g, '$1');

const applyMossHtmlTextFormatting = (
  element: HTMLElement,
  explicitFormat?: TextFormatType,
  forceHighlight = false
) => (lexicalNode: LexicalNode): LexicalNode => {
  if (!$isTextNode(lexicalNode)) {
    return lexicalNode;
  }

  const style = element.style;
  const classSet = getMossHtmlClassSet(element);
  const textDecoration = getMossHtmlTextDecoration(element);
  const hasBoldFontWeight = hasMossHtmlBoldFontWeight(element, classSet);
  const hasLinethroughTextDecoration =
    textDecoration.includes('line-through') || classSet.has('line-through');
  const fontStyle = (style.fontStyle || getRawInlineStyleProperty(element, 'font-style')).trim().toLowerCase();
  const fontFamily = getRawInlineStyleProperty(element, STYLE_FONT_FAMILY_PROPERTY);
  const hasItalicFontStyle = fontStyle === 'italic' || classSet.has('italic');
  const hasUnderlineTextDecoration = textDecoration.includes('underline') || classSet.has('underline');
  const verticalAlign = (style.verticalAlign || getRawInlineStyleProperty(element, 'vertical-align')).trim().toLowerCase();
  const hasInlineCode = classSet.has('bg-code-surface');

  if (hasBoldFontWeight && !lexicalNode.hasFormat('bold')) {
    lexicalNode.toggleFormat('bold');
  }
  if (hasLinethroughTextDecoration && !lexicalNode.hasFormat('strikethrough')) {
    lexicalNode.toggleFormat('strikethrough');
  }
  if (hasItalicFontStyle && !lexicalNode.hasFormat('italic')) {
    lexicalNode.toggleFormat('italic');
  }
  if (hasUnderlineTextDecoration && !lexicalNode.hasFormat('underline')) {
    lexicalNode.toggleFormat('underline');
  }
  if (verticalAlign === 'sub' && !lexicalNode.hasFormat('subscript')) {
    lexicalNode.toggleFormat('subscript');
  }
  if (verticalAlign === 'super' && !lexicalNode.hasFormat('superscript')) {
    lexicalNode.toggleFormat('superscript');
  }
  if (hasInlineCode && !lexicalNode.hasFormat('code')) {
    lexicalNode.toggleFormat('code');
  }
  if (isSerifFontFamilyValue(fontFamily)) {
    setTextNodeFontFamily(lexicalNode, 'serif');
  }
  if (explicitFormat && !lexicalNode.hasFormat(explicitFormat)) {
    lexicalNode.toggleFormat(explicitFormat);
  }
  if (forceHighlight || hasMossHighlightHtml(element)) {
    const highlightVariable = highlightVariableFromElement(element) ?? HIGHLIGHT_YELLOW_VAR;
    setTextStyleProperty(lexicalNode, STYLE_HIGHLIGHT_PROPERTY, `var(${highlightVariable})`);
  }

  return lexicalNode;
};

const convertMossHtmlTextElement = (
  element: HTMLElement,
  explicitFormat?: TextFormatType,
  forceHighlight = false
): DOMConversionOutput => ({
  forChild: applyMossHtmlTextFormatting(element, explicitFormat, forceHighlight),
  node: null
});

const MARKDOWN_EDITOR_HTML_IMPORT: DOMConversionMap = {
  mark: () => ({
    conversion: (element) => convertMossHtmlTextElement(element, undefined, true),
    priority: 1
  }),
  span: (element) => {
    if (!hasMossTextFormattingHtml(element)) {
      return null;
    }

    return {
      conversion: (node) => convertMossHtmlTextElement(node),
      priority: 1
    };
  }
};


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
      ...(parsed.formulaId ? { formulaId: parsed.formulaId } : {}),
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
    let resolutionState: import('../../common/noteTypes').LinkResolutionState;
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
          return;
        }

        const headerCells = mapToTableCells(previousText.getTextContent());
        if (headerCells == null) {
          return;
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
        return;
      }
    }

    const mergedRowText = consumeBrokenTableLineContinuations(parentNode, match[0]);
    const matchCells = mapToTableCells(mergedRowText);
    if (matchCells == null) {
      return;
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
      return;
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

/**
 * Converts newly created Lexical CodeNodes into Moss custom code nodes in real time.
 * This covers editor-native creation paths (e.g. markdown shortcuts / pasted fences)
 * that happen after the initial markdown import pipeline has already run.
 */
function CodeNodeNormalizationPlugin(): null {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    // Normalize any pre-existing CodeNodes (e.g. from older sessions/state)
    // so custom code block UI appears without requiring a reload.
    editor.update(() => {
      $convertMossCustomCodeNodes();
    }, { tag: 'skip-dirty' });

    return editor.registerMutationListener(CodeNode, (mutations) => {
      let hasNewCodeNode = false;
      for (const [, mutation] of mutations) {
        if (mutation === 'created') {
          hasNewCodeNode = true;
          break;
        }
      }

      if (!hasNewCodeNode) {
        return;
      }

      editor.update(() => {
        $convertMossCustomCodeNodes(undefined, { autoEditEmptyBlocks: true });
      }, { tag: 'skip-dirty' });
    });
  }, [editor]);

  return null;
}

function TableCellListNormalizationPlugin(): null {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    const normalizeBeforeListInsert = () => {
      $normalizeSelectionTableCells($getSelection());
      return false;
    };

    const unregisterUnordered = editor.registerCommand(
      INSERT_UNORDERED_LIST_COMMAND,
      normalizeBeforeListInsert,
      COMMAND_PRIORITY_HIGH
    );
    const unregisterOrdered = editor.registerCommand(
      INSERT_ORDERED_LIST_COMMAND,
      normalizeBeforeListInsert,
      COMMAND_PRIORITY_HIGH
    );
    const unregisterCheck = editor.registerCommand(
      INSERT_CHECK_LIST_COMMAND,
      normalizeBeforeListInsert,
      COMMAND_PRIORITY_HIGH
    );

    return () => {
      unregisterUnordered();
      unregisterOrdered();
      unregisterCheck();
    };
  }, [editor]);

  return null;
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

  while ((match = ESCAPED_BLOCKQUOTE_BLOCK_RE.exec(md)) !== null) {
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
    return segment.replace(
      /(\*{1,2}|~~)\[\[((?:[^\]]|\](?!\]))+)\]\]\1/g,
      '[[$2]]'
    );
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
  FORMATTED_EMBED_PILL_TARGET_RE.lastIndex = 0;
  let cursor = 0;
  let normalized = '';
  let converted = false;
  let match: RegExpExecArray | null;

  while ((match = FORMATTED_EMBED_PILL_TARGET_RE.exec(content)) !== null) {
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
      return value.replace(regExp, (fullMatch, content: string) => {
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

// URL regex for AutoLinkPlugin: matches http(s), ftp, and www. prefixed URLs
const URL_REGEX =
  /((https?:\/\/|ftp:\/\/|www\.)[^\s<>{}|\\^[\]`]+)/;

// Email regex for AutoLinkPlugin
const EMAIL_REGEX =
  /(([^<>()[\]\\.,;:\s@"]+(\.[^<>()[\]\\.,;:\s@"]+)*)|(".+"))@((\[[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\])|(([a-zA-Z\-0-9]+\.)+[a-zA-Z]{2,}))/;

const SCHEMELESS_URL_REGEX =
  /(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?\.)+[a-zA-Z][a-zA-Z0-9-]{1,23}(?::\d{1,5})?(?:[/?#][^\s<>{}|\\^[\]`]*)?/g;

const matchSchemelessUrl = (text: string) => {
  for (const match of text.matchAll(SCHEMELESS_URL_REGEX)) {
    const url = normalizeWebBrowserUrl(match[0]);
    if (url && !normalizeEmbeddableWebUrl(match[0])) {
      return {
        index: match.index,
        length: match[0].length,
        text: match[0],
        url
      };
    }
  }
  return null;
};

const AUTOLINK_URL_MATCHER = createLinkMatcherWithRegExp(URL_REGEX, (text) =>
  text.startsWith('http') || text.startsWith('ftp') ? text : `https://${text}`
);

export const AUTOLINK_MATCHERS = [
  (text: string) => {
    const match = AUTOLINK_URL_MATCHER(text);
    return match && normalizeEmbeddableWebUrl(match.text) ? null : match;
  },
  createLinkMatcherWithRegExp(EMAIL_REGEX, (text) => `mailto:${text}`),
  matchSchemelessUrl
];

const getPlatformIsMac = () =>
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.platform);

const MARKDOWN_EDITOR_STATE_CACHE_LIMIT = 24;
const markdownEditorStateCache = new Map<string, string>();

const buildMarkdownEditorStateCacheKey = (
  noteId: string,
  value: string,
  commentSignature: string,
  layoutComparison: string
): string =>
  `${noteId}:${computeContentHash(value)}:${computeContentHash(commentSignature)}:${layoutComparison}`;

const readMarkdownEditorStateCache = (key: string): string | undefined => {
  const cached = markdownEditorStateCache.get(key);
  if (!cached) {
    return undefined;
  }

  markdownEditorStateCache.delete(key);
  markdownEditorStateCache.set(key, cached);
  return cached;
};

const rememberMarkdownEditorStateCache = (key: string, serializedState: string): void => {
  markdownEditorStateCache.delete(key);
  markdownEditorStateCache.set(key, serializedState);

  while (markdownEditorStateCache.size > MARKDOWN_EDITOR_STATE_CACHE_LIMIT) {
    const oldestKey = markdownEditorStateCache.keys().next().value;
    if (!oldestKey) {
      break;
    }
    markdownEditorStateCache.delete(oldestKey);
  }
};


const EditorReadyPlugin = ({ onReady }: { onReady?: (editor: LexicalEditor) => void }) => {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    if (onReady) {
      onReady(editor);
    }
  }, [editor, onReady]);

  return null;
};

/**
 * Plugin that handles scrolling to a heading after cross-note navigation.
 * Checks for a pending scroll target set by FileLinkPlugin when clicking a cross-note anchor.
 */
const PendingScrollPlugin = ({ noteId }: { noteId: string }) => {
  const [editor] = useLexicalComposerContext();
  const pendingTarget = useAtomValue(pendingScrollTargetAtom);
  const setPendingTarget = useSetAtom(pendingScrollTargetAtom);

  useEffect(() => {
    if (!isPendingScrollTargetForNote(pendingTarget, noteId)) return;

    const targetHeading = pendingTarget.heading;
    const clearIfCurrent = () => {
      setPendingTarget((current) => clearPendingScrollTargetIfMatch(current, noteId, targetHeading));
    };

    if (!targetHeading) {
      const scrollContainer = editor.getRootElement()?.closest('.canvas-scroll');
      if (scrollContainer instanceof HTMLElement) {
        scrollContainer.scrollTo({ top: 0, behavior: 'auto' });
      }
      clearIfCurrent();
      return;
    }

    // Try immediately — content may already be reconciled
    if (scrollToHeading(editor, targetHeading)) {
      clearIfCurrent();
      return;
    }

    // Not yet in DOM — wait for Lexical reconciliation via update listener
    let unregister: (() => void) | null = null;
    const timeoutId = setTimeout(() => {
      // Give up after 2 seconds (heading truly doesn't exist)
      unregister?.();
      clearIfCurrent();
    }, 2000);

    unregister = editor.registerUpdateListener(() => {
      if (scrollToHeading(editor, targetHeading)) {
        clearTimeout(timeoutId);
        clearIfCurrent();
        unregister?.();
      }
    });

    return () => {
      clearTimeout(timeoutId);
      unregister?.();
    };
  }, [editor, pendingTarget, setPendingTarget, noteId]);

  return null;
};

const UndoRedoPlugin = () => {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    return editor.registerCommand(
      KEY_DOWN_COMMAND,
      (event: KeyboardEvent) => {
        if (!event) {
          return false;
        }

        const hasPrimaryModifier = event.metaKey || event.ctrlKey;
        if (!hasPrimaryModifier) {
          return false;
        }

        const key = event.key.toLowerCase();
        const isRedo =
          key === 'y' ||
          (key === 'z' && event.shiftKey) ||
          (key === 'z' && event.metaKey && event.ctrlKey); // rare case with both modifiers

        if (isRedo) {
          event.preventDefault();
          editor.dispatchCommand(REDO_COMMAND, undefined);
          return true;
        }

        if (key === 'z' && !event.shiftKey) {
          event.preventDefault();
          editor.dispatchCommand(UNDO_COMMAND, undefined);
          return true;
        }

        return false;
      },
      COMMAND_PRIORITY_CRITICAL
    );
  }, [editor]);

  return null;
};

function FormulaAwareMarkdownShortcutsPlugin({
  enabled
}: {
  enabled: boolean;
}) {
  if (!enabled) {
    return null;
  }
  return <MarkdownShortcutPlugin transformers={MARKDOWN_EDITOR_TRANSFORMERS} />;
}

type FloatingSelectionState = {
  isActive: boolean;
  isBold: boolean;
  isItalic: boolean;
  isStrikethrough: boolean;
  isCode: boolean;
  fontFamily: EditorSelectionFontFamily;
  /** True when at least one text node in the selection has a highlight background */
  selectionHasAnyHighlight: boolean;
  blockType: string;
  /** Set when a single commentable decorator node is selected (NodeSelection) */
  commentableNodeKey: string | null;
  /** Set when a single ImageNode is selected and can open alt-text editing. */
  selectedImageNodeKey: string | null;
  isLink: boolean;
  linkUrl: string | null;
};

const getDefaultSelectionState = (): FloatingSelectionState => ({
  isActive: false,
  isBold: false,
  isItalic: false,
  isStrikethrough: false,
  isCode: false,
  fontFamily: 'sans',
  selectionHasAnyHighlight: false,
  blockType: 'paragraph',
  commentableNodeKey: null,
  selectedImageNodeKey: null,
  isLink: false,
  linkUrl: null
});

/** Simple URL validation for paste-as-link */
const isUrl = (text: string): boolean => {
  try {
    const url = new URL(text);
    return url.protocol === 'http:' || url.protocol === 'https:' || url.protocol === 'ftp:';
  } catch {
    return false;
  }
};

const normalizeClipboardLineEndings = (text: string): string => text.replace(/\r\n?/g, '\n');

const URL_LIST_MARKER_RE = /^(?:[-*+]\s+|\d+\.\s+)?(.+)$/;

const isUrlListPaste = (rawText: string): boolean => {
  const lines = normalizeClipboardLineEndings(rawText)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length < 2) {
    return false;
  }
  return lines.every((line) => {
    const candidate = URL_LIST_MARKER_RE.exec(line)?.[1]?.trim() ?? '';
    return candidate.length > 0 && !/\s/.test(candidate) && isUrl(candidate);
  });
};

const MARKDOWN_BLOCK_LINE_RE =
  /(^|\n)(?:\s{0,3}(?:#{1,6}\s+\S|>\s+\S|[-*+]\s+\[(?:\s|x|X)\]\s*\S|[-*+]\s+\S|\d+\.\s+\S|```|~~~|\|.+\|))/;
const SINGLE_LINE_BLOCK_MARKDOWN_RE =
  /^\s{0,3}(?:#{1,6}\s+\S|>\s+\S|[-*+]\s+\[(?:\s|x|X)\]\s*\S|[-*+]\s+\S|\d+\.\s+\S|```|~~~|\|.+\|)/;
const LEXICAL_CLIPBOARD_MIME = 'application/x-lexical-editor';
const MOSS_ASSET_URL_IN_HTML_RE = /moss-asset:\/\/[^"'\s>]+/i;
const STRONG_INLINE_MARKDOWN_RE =
  /(\[\[[^\]\n]+\]\]|\{\{[^|\n}]+\|[^}\n]+\}\}|<mark data-color="(?:yellow|green|orange|blue)"(?:\s+style="[^"]*font-family\s*:[^"]*serif[^"]*")?>[\s\S]*?<\/mark>|<u(?:\s+style="[^"]*font-family\s*:[^"]*serif[^"]*")?>[\s\S]*?<\/u>|==<span style="[^"]*font-family\s*:[^"]*serif[^"]*">[\s\S]*?<\/span>==|==[^=\n]+==)/i;
const GENERIC_INLINE_MARKDOWN_PATTERNS = [
  /\*\*[^*\n]+?\*\*/,
  /~~[^~\n]+?~~/,
  /`[^`\n]+`/,
  /\[[^\]\n]+\]\(([^)\n]+)\)/
];
const MARKDOWN_PASTE_HEURISTIC_SAMPLE_CHARS = 16_000;
const LARGE_MARKDOWN_PASTE_CHAR_THRESHOLD = 40_000;
const LARGE_MARKDOWN_PASTE_LINE_THRESHOLD = 800;
const MARKDOWN_PASTE_CHUNK_TARGET_CHARS = 12_000;
const MAX_TABLE_ROW_CHARS_FOR_MARKDOWN_PASTE = 400;
const MAX_TABLE_CELL_CHARS_FOR_MARKDOWN_PASTE = 350;
const RICH_HTML_PASTE_RE =
  /<(?:h[1-6]|ul|ol|li|blockquote|table|thead|tbody|tr|td|th|pre|code|strong|b|em|i|u|s|mark)\b|data-(?:callout-type|tab-group|tab-panel|lexical)|__(?:lexicallisttype)|class=["'][^"']*(?:font-semibold|font-bold|italic|line-through|underline|bg-code-surface|highlight)[^"']*["']|style=["'][^"']*(?:font-weight|font-style|font-family|text-decoration|background-color)[^"']*["']/i;

type SavedPasteSelection =
  | {
      kind: 'range';
      anchorKey: string;
      anchorOffset: number;
      anchorType: 'text' | 'element';
      focusKey: string;
      focusOffset: number;
      focusType: 'text' | 'element';
    }
  | {
      kind: 'node';
      nodeKeys: string[];
    };

export const shouldForcePlainTextMarkdownPaste = (rawText: string): boolean => {
  const text = normalizeClipboardLineEndings(rawText).trim();
  if (!text.includes('|')) {
    return false;
  }

  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    const rowContent = extractTableRowContent(trimmed);
    if (!rowContent) {
      continue;
    }

    if (trimmed.length > MAX_TABLE_ROW_CHARS_FOR_MARKDOWN_PASTE) {
      return true;
    }

    if (isTableDividerRow(trimmed)) {
      continue;
    }

    if (splitTableRow(rowContent).some((cell) => cell.trim().length > MAX_TABLE_CELL_CHARS_FOR_MARKDOWN_PASTE)) {
      return true;
    }
  }

  return false;
};

/**
 * Heuristic for deciding whether plain clipboard text should be parsed as markdown.
 * We intentionally require stronger markdown signals to avoid surprising formatting
 * when users paste plain prose containing incidental symbols.
 */
export const shouldImportMarkdownFromPaste = (rawText: string): boolean => {
  const text = normalizeClipboardLineEndings(rawText).trim();
  if (!text) {
    return false;
  }

  if (isUrl(text)) {
    return false;
  }

  if (isUrlListPaste(text)) {
    return false;
  }

  // Comment anchor/footer syntax is handled by full-note import, not ad-hoc paste.
  if (containsCommentAnchors(text) || hasLegacyCommentFooter(text)) {
    return false;
  }

  const analyzedText =
    text.length > MARKDOWN_PASTE_HEURISTIC_SAMPLE_CHARS
      ? `${text.slice(0, MARKDOWN_PASTE_HEURISTIC_SAMPLE_CHARS / 2)}\n${text.slice(-MARKDOWN_PASTE_HEURISTIC_SAMPLE_CHARS / 2)}`
      : text;

  if (STRONG_INLINE_MARKDOWN_RE.test(analyzedText)) {
    return true;
  }

  if (
    MARKDOWN_BLOCK_LINE_RE.test(analyzedText) &&
    (analyzedText.includes('\n') || SINGLE_LINE_BLOCK_MARKDOWN_RE.test(analyzedText))
  ) {
    return true;
  }

  let inlineMatchCount = 0;
  for (const pattern of GENERIC_INLINE_MARKDOWN_PATTERNS) {
    if (pattern.test(analyzedText)) {
      inlineMatchCount += 1;
    }
  }

  return inlineMatchCount >= 2 || (inlineMatchCount >= 1 && analyzedText.includes('\n'));
};

export const shouldChunkMarkdownPaste = (rawText: string): boolean => {
  const text = normalizeClipboardLineEndings(rawText).trim();
  if (!text) {
    return false;
  }

  return (
    text.length >= LARGE_MARKDOWN_PASTE_CHAR_THRESHOLD ||
    text.split('\n').length >= LARGE_MARKDOWN_PASTE_LINE_THRESHOLD
  );
};

export const shouldDeferToRichClipboardPaste = (
  htmlPayload: string,
  lexicalPayload: string,
  markdownPayload: string
): boolean => {
  if (markdownPayload.trim().length > 0) {
    return false;
  }
  if (lexicalPayload.trim().length > 0) {
    return true;
  }
  return RICH_HTML_PASTE_RE.test(htmlPayload);
};

const captureSelectionForPaste = (editor: LexicalEditor): SavedPasteSelection | null => {
  let saved: SavedPasteSelection | null = null;

  editor.getEditorState().read(() => {
    const selection = $getSelection();
    if ($isRangeSelection(selection)) {
      saved = {
        kind: 'range',
        anchorKey: selection.anchor.key,
        anchorOffset: selection.anchor.offset,
        anchorType: selection.anchor.type,
        focusKey: selection.focus.key,
        focusOffset: selection.focus.offset,
        focusType: selection.focus.type
      };
      return;
    }

    if ($isNodeSelection(selection)) {
      const nodeKeys = selection.getNodes().map((node) => node.getKey());
      if (nodeKeys.length > 0) {
        saved = {
          kind: 'node',
          nodeKeys
        };
      }
    }
  });

  return saved;
};

const restoreSelectionForPaste = (saved: SavedPasteSelection): boolean => {
  if (saved.kind === 'range') {
    const anchorNode = $getNodeByKey(saved.anchorKey);
    const focusNode = $getNodeByKey(saved.focusKey);
    if (!anchorNode || !focusNode) {
      return false;
    }

    const selection = $createRangeSelection();
    selection.anchor.set(saved.anchorKey, saved.anchorOffset, saved.anchorType);
    selection.focus.set(saved.focusKey, saved.focusOffset, saved.focusType);
    $setSelection(selection);
    return true;
  }

  const selection = $createNodeSelection();
  for (const nodeKey of saved.nodeKeys) {
    const node = $getNodeByKey(nodeKey);
    if (!node) {
      return false;
    }
    selection.add(nodeKey);
  }
  $setSelection(selection);
  return true;
};

const convertMarkdownPasteToNodes = (markdown: string): LexicalNode[] => {
  // Prevent selection rescue side-effects during tree manipulation
  $setSelection(null);

  // We must use the real root — `new RootNode()` reuses key 'root' which
  // collides with the editor's root in the node map. Any mutation on the temp
  // root (e.g. clear()) actually mutates the real tree via getWritable().
  // Instead: save existing children, let $convertFromMarkdownString populate
  // the real root with parsed nodes, extract them, then restore originals.
  const root = $getRoot();
  const savedChildren = root.getChildren();

  $convertFromMarkdownString(
    escapeHtmlEntities(normalizeMarkdownForImport(markdown)),
    MARKDOWN_EDITOR_TRANSFORMERS
  );
  $postImportNormalize();

  // Clear selection created by conversion before detaching nodes
  $setSelection(null);

  const nodesToInsert = root.getChildren();
  for (const node of nodesToInsert) {
    node.remove();
  }

  // Restore original children
  for (const child of savedChildren) {
    root.append(child);
  }

  return nodesToInsert;
};

const unwrapSingleParagraphInlineNodes = (nodesToInsert: LexicalNode[]): LexicalNode[] | null => {
  if (
    nodesToInsert.length !== 1 ||
    !$isParagraphNode(nodesToInsert[0])
  ) {
    return null;
  }

  const children = nodesToInsert[0].getChildren();
  if (children.length === 0 || !children.every((child) => !$isElementNode(child) || $isLinkNode(child))) {
    return null;
  }

  for (const child of children) {
    child.remove();
  }

  return children;
};

const insertMarkdownChunk = (
  editor: LexicalEditor,
  markdown: string,
  savedSelection?: SavedPasteSelection
): void => {
  editor.update(
    () => {
      if (savedSelection && !restoreSelectionForPaste(savedSelection)) {
        return;
      }

      // convertMarkdownPasteToNodes nulls the selection to prevent temp root
      // corruption, so we re-restore the saved selection after conversion.
      const nodesToInsert = convertMarkdownPasteToNodes(markdown);
      if (nodesToInsert.length === 0) {
        return;
      }

      if (savedSelection) {
        restoreSelectionForPaste(savedSelection);
      }
      const selection = $getSelection();
      if (!selection) {
        return;
      }

      // Unwrap single-paragraph inline content (e.g. wiki links, plain links)
      // so it inserts inline rather than replacing the current block.
      const inlineNodes = unwrapSingleParagraphInlineNodes(nodesToInsert);
      if (inlineNodes) {
        $insertGeneratedNodes(editor, inlineNodes, selection);
        return;
      }

      $insertGeneratedNodes(editor, nodesToInsert, selection);
    },
    { discrete: true }
  );
};

export const splitLargeMarkdownPaste = (rawMarkdown: string): string[] => {
  const markdown = normalizeClipboardLineEndings(rawMarkdown);
  if (markdown.length <= MARKDOWN_PASTE_CHUNK_TARGET_CHARS) {
    return [markdown];
  }

  const lines = markdown.split('\n');
  const chunks: string[] = [];
  const currentChunk: string[] = [];
  let currentSize = 0;
  let inFence = false;

  const pushCurrentChunk = () => {
    if (currentChunk.length === 0) {
      return;
    }
    chunks.push(currentChunk.join('\n'));
    currentChunk.length = 0;
    currentSize = 0;
  };

  for (const line of lines) {
    const trimmed = line.trimStart();
    if (trimmed.startsWith('```') || trimmed.startsWith('~~~')) {
      inFence = !inFence;
    }

    const projectedSize = currentSize + line.length + 1;
    const shouldSplitBeforeLine =
      currentChunk.length > 0 &&
      !inFence &&
      (projectedSize > MARKDOWN_PASTE_CHUNK_TARGET_CHARS && line.trim().length === 0);

    if (shouldSplitBeforeLine) {
      pushCurrentChunk();
    }

    if (
      currentChunk.length > 0 &&
      !inFence &&
      projectedSize > MARKDOWN_PASTE_CHUNK_TARGET_CHARS &&
      line.trim().length > 0
    ) {
      pushCurrentChunk();
    }

    currentChunk.push(line);
    currentSize += line.length + 1;
  }

  pushCurrentChunk();
  return chunks.filter((chunk) => chunk.length > 0);
};

const insertMarkdownFromPaste = (editor: LexicalEditor, markdown: string): boolean => {
  const savedSelection = captureSelectionForPaste(editor);
  if (!savedSelection) {
    return false;
  }

  insertMarkdownChunk(editor, normalizeClipboardLineEndings(markdown), savedSelection);
  return true;
};

const insertPlainTextFromPaste = (editor: LexicalEditor, text: string): boolean => {
  let canInsert = false;

  editor.getEditorState().read(() => {
    canInsert = $isRangeSelection($getSelection());
  });

  if (!canInsert) {
    return false;
  }

  editor.update(
    () => {
      const selection = $getSelection();
      if (!$isRangeSelection(selection)) {
        return;
      }

      selection.insertRawText(normalizeClipboardLineEndings(text));
    },
    { discrete: true }
  );

  return true;
};

const WIKI_LINK_ONLY_RE = /^\[\[([^\]\n]+)\]\]$/;

const parseWikiLinkFromPlainText = (text: string): MossNoteLinkClipboardPayload | null => {
  const trimmed = text.trim();
  const match = trimmed.match(WIKI_LINK_ONLY_RE);
  if (!match) return null;
  const title = match[1].trim();
  if (!title) return null;
  return { noteId: '', noteTitle: title, wikiLink: trimmed };
};

const $insertFileLinkInline = (editor: LexicalEditor, payload: MossNoteLinkClipboardPayload): void => {
  editor.update(() => {
    const selection = $getSelection();
    const parsedTarget = parseWikiLinkTarget(
      payload.wikiLink,
      payload.noteId || undefined
    );
    const noteId = (parsedTarget?.noteId ?? payload.noteId) || null;
    const noteTitle = parsedTarget?.noteTitle ?? payload.noteTitle;
    const headingText = parsedTarget?.headingText ?? null;
    const fileLinkNode = $createFileLinkNode(
      noteId,
      noteTitle,
      !!noteId,
      headingText,
      noteId ? 'note_resolved' : 'unresolved',
      parsedTarget?.displayText ?? null
    );

    if (selection) {
      $insertGeneratedNodes(editor, [fileLinkNode], selection);
      return;
    }

    const paragraphNode = $createParagraphNode();
    paragraphNode.append(fileLinkNode);
    $getRoot().append(paragraphNode);
  });
};

export const registerPasteFormattingHandlers = (editor: LexicalEditor): (() => void) => {
  let activeChunkedPasteJobId = 0;

  const unregister = editor.registerCommand(
    PASTE_COMMAND,
    (event) => {
      // Only handle ClipboardEvents
      const isClipboardEvent =
        (typeof ClipboardEvent !== 'undefined' && objectKlassEquals(event, ClipboardEvent)) ||
        (event && typeof event === 'object' && 'clipboardData' in event);
      if (!isClipboardEvent) return false;

      // Block paste when selection is at root level — root-level selections
      // arise from edge cases in Lexical's selection management, not from
      // intentional user actions. Trying to handle them led to overwrites.
      {
        let atRoot = false;
        editor.getEditorState().read(() => {
          const selection = $getSelection();
          if ($isRangeSelection(selection)) {
            const root = $getRoot();
            atRoot =
              (selection.anchor.type === 'element' && selection.anchor.getNode() === root) ||
              (selection.focus.type === 'element' && selection.focus.getNode() === root);
          }
        });
        if (atRoot) {
          console.warn('[paste] Blocked paste at root-level selection — this is a Lexical edge case, not a user error');
          event.preventDefault();
          return true;
        }
      }

      const clipboardData = (event as ClipboardEvent).clipboardData;
      if (!clipboardData) return false;

      const mossLinkPayload = parseMossNoteLinkClipboardPayload(
        clipboardData.getData(MOSS_NOTE_LINK_CLIPBOARD_MIME) ?? ''
      );
      const htmlLinkPayload =
        mossLinkPayload ?? parseMossNoteLinkPayloadFromHtml(clipboardData.getData('text/html') ?? '');
      if (htmlLinkPayload) {
        event.preventDefault();
        $insertFileLinkInline(editor, htmlLinkPayload);
        return true;
      }

      const htmlPayload = clipboardData.getData('text/html') ?? '';
      if (MOSS_ASSET_URL_IN_HTML_RE.test(htmlPayload)) {
        // Let ExternalImagePastePlugin own moss-asset:// copy/rewrites.
        return false;
      }

      const lexicalPayload = clipboardData.getData(LEXICAL_CLIPBOARD_MIME) ?? '';
      const markdownPayload = clipboardData.getData('text/markdown') ?? '';
      if (shouldDeferToRichClipboardPaste(htmlPayload, lexicalPayload, markdownPayload)) {
        return false;
      }

      const plainTextPayload = clipboardData.getData('text/plain') ?? '';
      const hasExplicitMarkdownPayload = markdownPayload.trim().length > 0;
      const pastedMarkdownCandidate = hasExplicitMarkdownPayload ? markdownPayload : plainTextPayload;

      // Plain text wiki link (e.g. copied from editor content) — insert inline
      // like the custom MIME path does, instead of routing through markdown paste
      // which wraps in a ParagraphNode and replaces the block.
      const plainWikiLink = parseWikiLinkFromPlainText(pastedMarkdownCandidate);
      if (plainWikiLink) {
        event.preventDefault();
        $insertFileLinkInline(editor, plainWikiLink);
        return true;
      }

      if (shouldForcePlainTextMarkdownPaste(pastedMarkdownCandidate)) {
        const handled = insertPlainTextFromPaste(editor, pastedMarkdownCandidate);
        if (!handled) {
          return false;
        }

        event.preventDefault();
        event.stopPropagation();
        return true;
      }

      if (hasExplicitMarkdownPayload || shouldImportMarkdownFromPaste(pastedMarkdownCandidate)) {
        event.preventDefault();
        event.stopPropagation();
        if (shouldChunkMarkdownPaste(pastedMarkdownCandidate)) {
          const savedSelection = captureSelectionForPaste(editor);
          if (!savedSelection) {
            return false;
          }

          const jobId = ++activeChunkedPasteJobId;
          const chunks = splitLargeMarkdownPaste(pastedMarkdownCandidate);
          let chunkIndex = 0;

          const runNextChunk = () => {
            if (jobId !== activeChunkedPasteJobId) {
              return;
            }

            const chunk = chunks[chunkIndex];
            if (typeof chunk !== 'string') {
              return;
            }

            insertMarkdownChunk(
              editor,
              chunk,
              chunkIndex === 0 ? savedSelection : undefined
            );

            chunkIndex += 1;
            if (chunkIndex < chunks.length) {
              window.setTimeout(runNextChunk, 0);
            }
          };

          window.setTimeout(runNextChunk, 0);
          return true;
        }
        return insertMarkdownFromPaste(editor, pastedMarkdownCandidate);
      }

      const pastedText = plainTextPayload.trim();
      if (!pastedText || !isUrl(pastedText)) return false;

      // Check if there's a non-collapsed text selection
      let hasTextSelection = false;
      editor.getEditorState().read(() => {
        const selection = $getSelection();
        hasTextSelection = $isRangeSelection(selection) && !selection.isCollapsed() && trimSelectionText(selection).length > 0;
      });

      if (!hasTextSelection) return false;

      // Wrap selection in link
      event.preventDefault();
      editor.update(() => {
        $toggleLink(pastedText);
      });
      return true;
    },
    COMMAND_PRIORITY_HIGH
  );

  return () => {
    activeChunkedPasteJobId += 1;
    unregister();
  };
};

const TOOL_BUTTON_BASE_CLASSES = SELECTION_TOOLBAR_BUTTON_BASE_CLASS;
const TOOL_BUTTON_PRESS_CLASS = SELECTION_TOOLBAR_BUTTON_PRESS_CLASS;

type ToolbarTool = 'bold' | 'italic' | 'heading1' | 'heading2' | 'heading3' | 'heading4' | 'highlight' | 'indent' | 'outdent' | 'checkbox' | 'bulletList' | 'numberedList' | 'strikethrough' | 'code' | 'comment' | 'quote' | 'slash' | 'link';
type HeadingLevel = 'h1' | 'h2' | 'h3' | 'h4';

const ToolbarDivider = SelectionToolbarDivider;

function HeadingLevelBadge({
  level,
  className
}: {
  level: HeadingLevel;
  className?: string;
}) {
  const numeral = level.slice(1);

  return (
    <span
      aria-hidden
      className={cn(
        'inline-flex min-w-4 items-center justify-center gap-px text-sm font-medium leading-none tracking-tight tabular-nums',
        className
      )}
    >
      <span className="text-ink-default">H</span>
      <span className="text-ink-muted">{numeral}</span>
    </span>
  );
}

function ToolbarTooltip({ label, keys, children }: { label: string; keys?: string[]; children: React.ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side="top" sideOffset={12} className="flex items-center gap-2 px-2 py-1">
        <span className="text-sm font-normal leading-none">{label}</span>
        {keys && <KeyboardShortcut keys={keys} size="compact" />}
      </TooltipContent>
    </Tooltip>
  );
}

const trimSelectionText = (selection: ReturnType<typeof $getSelection>): string => {
  if (!$isRangeSelection(selection)) {
    return '';
  }

  return selection.getTextContent().trim();
};

const findContainingListItem = (node: LexicalNode | null): ListItemNode | null => {
  let current: LexicalNode | null = node;
  while (current) {
    if ($isListItemNode(current)) {
      return current;
    }
    current = current.getParent();
  }
  return null;
};

const TRASH_RETENTION_DAYS = 30;
const MS_IN_DAY = 24 * 60 * 60 * 1000;
const LINK_INPUT_SIDE_OFFSET = 8;
const LINK_INPUT_ESTIMATED_HEIGHT = 56;
const LINK_INPUT_EDITOR_TOP_GAP = 8;

type LinkInputPopoverSide = 'top' | 'bottom';

export const resolveLinkInputPopoverSide = ({
  anchorRect,
  editorRootRect
}: {
  anchorRect: Pick<DOMRect, 'top'>;
  editorRootRect: Pick<DOMRect, 'top'> | null;
}): LinkInputPopoverSide => {
  if (!editorRootRect) {
    return 'top';
  }

  const topPlacementTop =
    anchorRect.top - LINK_INPUT_SIDE_OFFSET - LINK_INPUT_ESTIMATED_HEIGHT;
  const safeEditorTop = editorRootRect.top + LINK_INPUT_EDITOR_TOP_GAP;

  return topPlacementTop < safeEditorTop ? 'bottom' : 'top';
};

function LinkInputPopover({
  open,
  mode,
  initialUrl,
  anchorRect,
  anchorSide,
  collisionBoundary,
  onApply,
  onRemove,
  onClose,
}: {
  open: boolean;
  mode: 'create' | 'edit';
  initialUrl: string;
  anchorRect: { x: number; y: number; width: number; height: number } | null;
  anchorSide: LinkInputPopoverSide;
  collisionBoundary: Element | null;
  onApply: (url: string) => void;
  onRemove: () => void;
  onClose: () => void;
}) {
  const [url, setUrl] = useState(initialUrl);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  useEffect(() => {
    if (!open) {
      return;
    }

    setUrl(initialUrl);
  }, [initialUrl, open]);

  const virtualRef = useRef<{ getBoundingClientRect: () => DOMRect }>({
    getBoundingClientRect: () => new DOMRect(),
  });

  if (anchorRect) {
    virtualRef.current = {
      getBoundingClientRect: () =>
        new DOMRect(anchorRect.x, anchorRect.y, anchorRect.width, anchorRect.height),
    };
  }

  const handleSubmit = () => {
    const trimmed = url.trim();
    if (!trimmed) return;
    // Auto-add https:// if no protocol
    const finalUrl = /^https?:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`;
    onApply(finalUrl);
  };

  const inputClassName =
    'min-h-6 min-w-0 flex-1 bg-surface-transparent py-0.5 pl-0 pr-1 text-small leading-relaxed text-ink-default outline-none placeholder:text-ink-faint/50';
  const actionButtonClassName =
    'flex h-5 shrink-0 items-center justify-center gap-0.5 rounded-md px-1 text-ink-faint transition-colors hover:bg-surface-panel hover:text-ink-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ink-default/15 disabled:cursor-not-allowed disabled:opacity-30';

  return (
    <Popover.Root open={open && !!anchorRect} onOpenChange={(o) => { if (!o) onClose(); }}>
      <Popover.Anchor virtualRef={virtualRef} />
      <Popover.Portal>
        <Popover.Content
          role="dialog"
          aria-label={mode === 'create' ? 'Add link' : 'Edit link'}
          side={anchorSide}
          sideOffset={LINK_INPUT_SIDE_OFFSET}
          collisionBoundary={collisionBoundary ? [collisionBoundary] : undefined}
          collisionPadding={16}
          positionerClassName="z-[51]"
          className="app-region-no-drag z-[51] w-comment-input-popover max-w-floating-popover-viewport rounded-xl border border-border-subtle bg-surface-floating shadow-sm data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95"
          onOpenAutoFocus={(e) => e.preventDefault()}
          onCloseAutoFocus={(e) => e.preventDefault()}
        >
          <div className="px-2 py-1.5">
            <div className="relative flex min-h-6 min-w-0 items-center gap-1">
              <input
                ref={inputRef}
                type="url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    handleSubmit();
                  } else if (e.key === 'Escape') {
                    e.preventDefault();
                    onClose();
                  }
                }}
                placeholder="Paste or type a URL..."
                className={inputClassName}
              />
              <button
                type="button"
                aria-label={mode === 'create' ? 'Add link' : 'Apply link changes'}
                disabled={!url.trim()}
                onClick={handleSubmit}
                className={actionButtonClassName}
              >
                <CornerDownLeft aria-hidden className="h-3 w-3" strokeWidth={1.5} />
              </button>
              {mode === 'edit' ? (
                <button
                  type="button"
                  aria-label="Remove link"
                  onClick={onRemove}
                  className={actionButtonClassName}
                >
                  <Unlink aria-hidden className="h-3 w-3" strokeWidth={1.5} />
                </button>
              ) : null}
            </div>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

type HyperlinkContextMenuState = {
  isVisible: boolean;
  position: { x: number; y: number };
  nodeKey: string;
  url: string;
  displayText: string;
  anchorRect: { x: number; y: number; width: number; height: number };
};

const initialHyperlinkContextMenuState: HyperlinkContextMenuState = {
  isVisible: false,
  position: { x: 0, y: 0 },
  nodeKey: '',
  url: '',
  displayText: '',
  anchorRect: { x: 0, y: 0, width: 0, height: 0 }
};

function HyperlinkContextMenu({
  state,
  onClose,
  onEditLink,
  onOpenSplitView
}: {
  state: HyperlinkContextMenuState;
  onClose: () => void;
  onEditLink: (state: HyperlinkContextMenuState) => void;
  onOpenSplitView: (state: HyperlinkContextMenuState) => void;
}) {
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!state.isVisible) return;

    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        onClose();
      }
    };
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    const handleScroll = () => onClose();

    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEscape);
    document.addEventListener('scroll', handleScroll, true);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
      document.removeEventListener('scroll', handleScroll, true);
    };
  }, [state.isVisible, onClose]);

  if (!state.isVisible) return null;

  return createPortal(
    <div
      ref={menuRef}
      className="fixed z-50 min-w-40 overflow-hidden rounded-lg border border-border-subtle bg-surface-canvas p-1 text-ink-default shadow-lg animate-in fade-in-0 zoom-in-95"
      data-hyperlink-context-menu="true"
      style={{
        left: state.position.x,
        top: state.position.y,
        WebkitAppRegion: 'no-drag'
      } as React.CSSProperties}
    >
      <button
        className="relative flex w-full cursor-pointer select-none items-center gap-2 rounded-md px-2 py-1.5 text-left text-micro outline-none transition-colors hover:bg-accent-brand/10 hover:text-accent-brand-pressed"
        onClick={() => {
          onEditLink(state);
          onClose();
        }}
      >
        <Link2 className="h-3.5 w-3.5 text-ink-muted" />
        <span>Edit Link</span>
      </button>
      <div className="my-1 h-px bg-border-subtle" />
      <button
        className="relative flex w-full cursor-pointer select-none items-center gap-2 rounded-md px-2 py-1.5 text-left text-micro outline-none transition-colors hover:bg-accent-brand/10 hover:text-accent-brand-pressed disabled:cursor-default disabled:opacity-45 disabled:hover:bg-surface-transparent disabled:hover:text-ink-default"
        disabled={!isSafeWebBrowserUrl(state.url)}
        onClick={() => {
          onOpenSplitView(state);
          onClose();
        }}
      >
        <Columns2 className="h-3.5 w-3.5 text-ink-muted" />
        <span>Open in Split View</span>
      </button>
    </div>,
    document.body
  );
}

type HyperlinkClickTarget = {
  url: string;
  title: string;
};

function findAnchorForLinkActivation(
  eventTarget: EventTarget | null,
  rootElement: HTMLElement
): HTMLAnchorElement | null {
  if (!(eventTarget instanceof Node) || !rootElement.contains(eventTarget)) {
    return null;
  }

  const targetElement =
    eventTarget instanceof Element ? eventTarget : eventTarget.parentElement;
  const anchorElement = targetElement?.closest('a[href]') ?? null;
  if (!(anchorElement instanceof HTMLAnchorElement) || !rootElement.contains(anchorElement)) {
    return null;
  }

  return anchorElement;
}

function readHyperlinkClickTarget(
  editor: LexicalEditor,
  anchorElement: HTMLAnchorElement
): { target: HyperlinkClickTarget | null; hasTextSelection: boolean } {
  let target: HyperlinkClickTarget | null = null;
  let hasTextSelection = false;

  editor.update(() => {
    const selection = $getSelection();
    hasTextSelection = $isRangeSelection(selection) && !selection.isCollapsed();

    const nearestNode = $getNearestNodeFromDOMNode(anchorElement);
    const linkNode = $isLinkNode(nearestNode)
      ? nearestNode
      : nearestNode
        ? $findMatchingParent(nearestNode, $isLinkNode)
        : null;

    if ($isLinkNode(linkNode)) {
      target = {
        url: linkNode.getURL(),
        title: linkNode.getTextContent()
      };
      return;
    }

    target = {
      url: anchorElement.getAttribute('href') ?? anchorElement.href,
      title: anchorElement.textContent?.trim() ?? ''
    };
  }, { discrete: true });

  return { target, hasTextSelection };
}

function InAppHyperlinkPlugin({ noteId }: { noteId: string }) {
  const [editor] = useLexicalComposerContext();
  const openBrowserSplit = useSetAtom(openBrowserSplitAtom);

  const handleLinkActivation = useCallback((event: MouseEvent) => {
    if (event.defaultPrevented) {
      return;
    }
    if (event.type === 'click' && event.button !== 0) {
      return;
    }
    if (event.type === 'auxclick' && event.button !== 1) {
      return;
    }
    if (event.detail > 1) {
      return;
    }

    const rootElement = editor.getRootElement();
    if (!rootElement) {
      return;
    }

    const anchorElement = findAnchorForLinkActivation(event.target, rootElement);
    if (!anchorElement) {
      return;
    }

    const { target, hasTextSelection } = readHyperlinkClickTarget(editor, anchorElement);
    if (hasTextSelection) {
      event.preventDefault();
      return;
    }
    if (!target) {
      return;
    }

    const normalizedUrl = normalizeWebBrowserUrl(target.url);
    event.preventDefault();
    event.stopPropagation();
    if (!normalizedUrl) {
      let fallbackUrl: string | null = null;
      try {
        const parsedUrl = new URL(target.url);
        if (parsedUrl.protocol === 'http:' || parsedUrl.protocol === 'https:') {
          fallbackUrl = parsedUrl.href;
        }
      } catch {
        fallbackUrl = null;
      }

      if (fallbackUrl) {
        event.preventDefault();
        event.stopPropagation();
        window.open(fallbackUrl, '_blank', 'noopener,noreferrer');
      }
      return;
    }

    const title = target.title.trim();
    openBrowserSplit({
      url: normalizedUrl,
      title: title.length > 0 ? title : normalizedUrl,
      sourceNoteId: noteId
    });
  }, [editor, noteId, openBrowserSplit]);

  useEffect(() => {
    const attach = (rootElement: HTMLElement): void => {
      rootElement.addEventListener('click', handleLinkActivation);
      rootElement.addEventListener('auxclick', handleLinkActivation);
    };
    const detach = (rootElement: HTMLElement): void => {
      rootElement.removeEventListener('click', handleLinkActivation);
      rootElement.removeEventListener('auxclick', handleLinkActivation);
    };

    return editor.registerRootListener((rootElement, previousRootElement) => {
      if (previousRootElement) detach(previousRootElement);
      if (rootElement) attach(rootElement);
    });
  }, [editor, handleLinkActivation]);

  return null;
}

const selectLinkNodeContents = (linkNode: LinkNode): BaseSelection | null => {
  const textNodes: TextNode[] = [];
  const collectTextNodes = (node: LexicalNode): void => {
    if ($isTextNode(node)) {
      textNodes.push(node);
    } else if ($isElementNode(node)) {
      node.getChildren().forEach(collectTextNodes);
    }
  };
  collectTextNodes(linkNode);

  const firstTextNode = textNodes[0];
  const lastTextNode = textNodes[textNodes.length - 1];
  if (!firstTextNode || !lastTextNode) {
    return null;
  }

  const selection = $createRangeSelection();
  selection.anchor.set(firstTextNode.getKey(), 0, 'text');
  selection.focus.set(lastTextNode.getKey(), lastTextNode.getTextContent().length, 'text');
  $setSelection(selection);
  return selection;
};

interface FloatingSelectionToolsProps {
  noteId: string;
  isTrashed?: boolean;
  trashedAt?: number | null;
  onActionClick?: () => void;
  onSelectedImageNodeKeyChange?: (nodeKey: string | null) => void;
  paneId?: 'left' | 'right';
  editorMountVersion?: number;
  analyticsOwnerId: string;
}

const MULTI_CLICK_TOOLBAR_SETTLE_MS = 150;

function FloatingSelectionTools({
  noteId,
  isTrashed = false,
  trashedAt,
  onActionClick,
  onSelectedImageNodeKeyChange,
  paneId,
  editorMountVersion,
  analyticsOwnerId
}: FloatingSelectionToolsProps) {
  const [editor] = useLexicalComposerContext();
  const store = useStore();
  const isPaletteOpen = useAtomValue(showCommandPaletteAtom);
  const openBrowserSplit = useSetAtom(openBrowserSplitAtom);
  const portalRef = useCallback((node: HTMLDivElement | null) => {
    store.set(toolbarPortalTargetAtom, node);
  }, [store]);
  const [selectionState, setSelectionState] = useState<FloatingSelectionState>(() =>
    getDefaultSelectionState()
  );
  const [isMacPlatform] = useState(() => getPlatformIsMac());
  const [listContext, setListContext] = useState<{ listType: ListType | null; depth: number }>({
    listType: null,
    depth: 0
  });
  const [fontDropdownOpen, setFontDropdownOpen] = useState(false);
  const [headingDropdownOpen, setHeadingDropdownOpen] = useState(false);
  const [highlightDropdownOpen, setHighlightDropdownOpen] = useState(false);
  const [listDropdownOpen, setListDropdownOpen] = useState(false);
  // Gate for SELECTION_CHANGE_COMMAND — skip syncToolbarState when selection unchanged
  const lastToolbarSelectionRef = useRef<BaseSelection | null>(null);
  // Selection rect for floating toolbar positioning
  const selectionRectRef = useRef<DOMRect | null>(null);
  const [selectionRectVersion, setSelectionRectVersion] = useState(0);
  const [isMouseSelecting, setIsMouseSelecting] = useState(false);
  const mouseSelectionRevealTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isPaletteOpenRef = useRef(isPaletteOpen);
  isPaletteOpenRef.current = isPaletteOpen;

  useEffect(() => {
    onSelectedImageNodeKeyChange?.(selectionState.selectedImageNodeKey);
  }, [onSelectedImageNodeKeyChange, selectionState.selectedImageNodeKey]);

  useEffect(() => {
    return () => {
      onSelectedImageNodeKeyChange?.(null);
    };
  }, [onSelectedImageNodeKeyChange]);
  const floatingToolbarRef = useRef<HTMLDivElement | null>(null);
  // Scroll tracking — hide floating bar while scrolling
  const [isScrolling, setIsScrolling] = useState(false);
  const scrollTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Current time for countdown calculations - refreshes every minute
  const [currentTime, setCurrentTime] = useState(() => Date.now());
  useEffect(() => {
    // Only run interval for trashed notes
    if (trashedAt == null) return;
    const id = setInterval(() => setCurrentTime(Date.now()), 60_000);
    return () => clearInterval(id);
  }, [trashedAt]);

  // Do not mount the floating toolbar while a mouse selection gesture is in
  // progress. A double-click may be the middle of a triple-click, so hold the
  // toolbar briefly after click two rather than flashing it between clicks.
  useEffect(() => {
    const rootElement = editor.getRootElement();
    if (!rootElement) return;

    const clearRevealTimeout = () => {
      if (!mouseSelectionRevealTimeoutRef.current) return;
      clearTimeout(mouseSelectionRevealTimeoutRef.current);
      mouseSelectionRevealTimeoutRef.current = null;
    };
    const revealToolbar = () => {
      clearRevealTimeout();
      setIsMouseSelecting(false);
    };
    const scheduleReveal = (delay: number) => {
      clearRevealTimeout();
      mouseSelectionRevealTimeoutRef.current = setTimeout(() => {
        mouseSelectionRevealTimeoutRef.current = null;
        setIsMouseSelecting(false);
      }, delay);
    };
    const handlePointerDown = (event: PointerEvent) => {
      if (event.button !== 0) return;
      clearRevealTimeout();
      setIsMouseSelecting(true);
    };
    const handlePointerUp = () => {
      // A click event follows pointerup and supplies the click count. This
      // zero-delay fallback still reveals drag selections that emit no click.
      scheduleReveal(0);
    };
    const handleClick = (event: MouseEvent) => {
      if (event.button !== 0) return;
      if (event.detail === 2) {
        scheduleReveal(MULTI_CLICK_TOOLBAR_SETTLE_MS);
        return;
      }
      revealToolbar();
    };

    rootElement.addEventListener('pointerdown', handlePointerDown);
    rootElement.addEventListener('click', handleClick);
    window.addEventListener('pointerup', handlePointerUp);
    window.addEventListener('pointercancel', revealToolbar);
    window.addEventListener('blur', revealToolbar);

    return () => {
      clearRevealTimeout();
      rootElement.removeEventListener('pointerdown', handlePointerDown);
      rootElement.removeEventListener('click', handleClick);
      window.removeEventListener('pointerup', handlePointerUp);
      window.removeEventListener('pointercancel', revealToolbar);
      window.removeEventListener('blur', revealToolbar);
    };
  }, [editor]);

  // Hide floating bar during scroll so it doesn't lag behind selection
  useEffect(() => {
    const rootElement = editor.getRootElement();
    if (!rootElement) return;
    const scrollContainer = rootElement.closest('.canvas-scroll');
    if (!scrollContainer) return;

    const handleScroll = () => {
      setIsScrolling(true);
      if (scrollTimeoutRef.current) clearTimeout(scrollTimeoutRef.current);
      scrollTimeoutRef.current = setTimeout(() => setIsScrolling(false), 400);
    };

    scrollContainer.addEventListener('scroll', handleScroll, { passive: true });
    return () => {
      scrollContainer.removeEventListener('scroll', handleScroll);
      if (scrollTimeoutRef.current) clearTimeout(scrollTimeoutRef.current);
    };
  }, [editor]);

  // Panel visibility — used to center toolbar on the canvas area, not the viewport
  const isActionsPanelHidden = useAtomValue(actionsPanelHiddenAtom);
  const isNotesPanelHidden = useAtomValue(notesPanelHiddenAtom);
  const focusedPane = useAtomValue(focusedPaneAtom);
  const browserSplitTarget = useAtomValue(browserSplitTargetAtom);
  const isCurrentPaneActive = !paneId || focusedPane === paneId;
  const isBrowserPaneActive = browserSplitTarget !== null && focusedPane === 'right';
  const shouldRenderToolbarForPane = isCurrentPaneActive && !isBrowserPaneActive;
  const [toolbarCanvasCenterLeft, setToolbarCanvasCenterLeft] = useState<number | null>(null);
  const [toolbarCanvasBounds, setToolbarCanvasBounds] = useState<{ left: number; right: number } | null>(null);

  useLayoutEffect(() => {
    if (!shouldRenderToolbarForPane) {
      setToolbarCanvasCenterLeft(null);
      setToolbarCanvasBounds(null);
      return;
    }

    const updateToolbarAnchor = () => {
      const rootElement = editor.getRootElement();
      const canvasScroll = rootElement?.closest('.canvas-scroll') as HTMLElement | null;
      if (!canvasScroll) {
        setToolbarCanvasCenterLeft(null);
        return;
      }

      const rect = canvasScroll.getBoundingClientRect();
      if (
        !Number.isFinite(rect.left) ||
        !Number.isFinite(rect.width) ||
        rect.width <= 0
      ) {
        setToolbarCanvasCenterLeft(null);
        return;
      }

      const nextCenter = Math.round(rect.left + rect.width / 2);
      setToolbarCanvasCenterLeft((prev) => (prev === nextCenter ? prev : nextCenter));
      const nextBounds = {
        left: Math.round(rect.left),
        right: Math.round(rect.right),
      };
      setToolbarCanvasBounds((prev) => (
        prev?.left === nextBounds.left && prev?.right === nextBounds.right ? prev : nextBounds
      ));
    };

    updateToolbarAnchor();
    const deferredUpdate = window.setTimeout(updateToolbarAnchor, 0);
    const rootElement = editor.getRootElement();
    const canvasScroll = rootElement?.closest('.canvas-scroll') as HTMLElement | null;
    const resizeObserver = canvasScroll && typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver(updateToolbarAnchor)
      : null;
    if (resizeObserver && canvasScroll) {
      resizeObserver.observe(canvasScroll);
    }

    window.addEventListener('resize', updateToolbarAnchor);
    window.addEventListener('scroll', updateToolbarAnchor, true);
    return () => {
      window.clearTimeout(deferredUpdate);
      resizeObserver?.disconnect();
      window.removeEventListener('resize', updateToolbarAnchor);
      window.removeEventListener('scroll', updateToolbarAnchor, true);
    };
  }, [editor, shouldRenderToolbarForPane]);

  // Comment input popover state (shared with CommentPlugin keyboard shortcuts)
  const commentInputState = useAtomValue(commentInputStateAtom(noteId));
  const setCommentInputState = useSetAtom(commentInputStateAtom(noteId));


  // Recompute toolbar state from the current selection.
  // Called on SELECTION_CHANGE_COMMAND and FORMAT_TEXT_COMMAND — NOT on every
  // editor update — so normal typing doesn't trigger expensive lookups.
  const syncToolbarState = useCallback(() => {
    const selection = $getSelection();
    const anchor = $isRangeSelection(selection) ? selection.anchor.getNode() : null;
    const listItem = findContainingListItem(anchor);
    const parentList = listItem?.getParent();
    const nextListType = $isListNode(parentList) ? parentList.getListType() : null;
    const nextDepth = typeof listItem?.getIndent === 'function' ? listItem.getIndent() : 0;

    setListContext((prev) => {
      if (prev.listType === nextListType && prev.depth === nextDepth) {
        return prev;
      }
      return { listType: nextListType, depth: nextDepth };
    });

    if ($isRangeSelection(selection)) {
      const isBold = selection.hasFormat('bold');
      const isItalic = selection.hasFormat('italic');
      const isStrikethrough = selection.hasFormat('strikethrough');
      const isCode = selection.hasFormat('code');
      const fontFamily = selectionFontFamilyFromStyleValue(
        $getSelectionStyleValueForProperty(selection, STYLE_FONT_FAMILY_PROPERTY, '')
      );

      const anchorNode = selection.anchor.getNode();
      const anchorParent = getTopLevelElementOrNull(anchorNode);
      const blockType = anchorParent && $isHeadingNode(anchorParent) ? anchorParent.getTag() : anchorParent && $isQuoteNode(anchorParent) ? 'quote' : 'paragraph';

      // Detect if selection is inside a LinkNode
      const linkParent = $findMatchingParent(anchorNode, $isLinkNode);
      const isLink = linkParent !== null;
      const linkUrl = isLink ? (linkParent as LinkNode).getURL() : null;

      const hasTextSelected = !selection.isCollapsed() && !!trimSelectionText(selection);
      const topLevelNodeType = anchorParent?.getType();
      const selectionKind = selection.isCollapsed() ? 'collapsed' : 'range';

      // Check if ANY text node in the selection has a highlight background
      let selectionHasAnyHighlight = false;
      if (hasTextSelected) {
        const nodes = selection.getNodes();
        for (const node of nodes) {
          if ($isTextNode(node)) {
            const style = node.getStyle();
            if (style && (style.includes(HIGHLIGHT_YELLOW_VAR) || Object.values(HIGHLIGHT_COLOR_VARIABLES).some(v => style.includes(v)))) {
              selectionHasAnyHighlight = true;
              break;
            }
          }
        }
      }

      const nextState: FloatingSelectionState = {
        isActive: hasTextSelected,
        isBold, isItalic, isStrikethrough, isCode, fontFamily,
        selectionHasAnyHighlight, blockType,
        commentableNodeKey: null,
        selectedImageNodeKey: null,
        isLink, linkUrl
      };
      onSelectedImageNodeKeyChange?.(nextState.selectedImageNodeKey);
      setSelectionState((previous) => {
        if (
          previous.isActive === nextState.isActive &&
          previous.isBold === nextState.isBold &&
          previous.isItalic === nextState.isItalic &&
          previous.isStrikethrough === nextState.isStrikethrough &&
          previous.isCode === nextState.isCode &&
          previous.fontFamily === nextState.fontFamily &&
          previous.selectionHasAnyHighlight === nextState.selectionHasAnyHighlight &&
          previous.blockType === nextState.blockType &&
          previous.commentableNodeKey === nextState.commentableNodeKey &&
          previous.selectedImageNodeKey === nextState.selectedImageNodeKey &&
          previous.isLink === nextState.isLink &&
          previous.linkUrl === nextState.linkUrl
        ) {
          return previous;
        }
        return nextState;
      });

      setRendererErrorAnalyticsContext({
        noteId,
        pane_id: paneId,
        split_view: Boolean(paneId),
        editor_mount_version: editorMountVersion,
        selection_kind: selectionKind,
        selection_text_length: selection.getTextContent().length,
        selection_block_type: blockType,
        active_node_type: anchorNode.getType(),
        top_level_node_type: topLevelNodeType,
        selected_node_type: undefined,
        selection_is_link: isLink,
        commentable_node_selected: false,
      }, analyticsOwnerId);
    } else if ($isNodeSelection(selection) && selection.getNodes().length === 1) {
      const selectedNode = selection.getNodes()[0];
      if ($isCommentableDecorator(selectedNode)) {
        const nextState: FloatingSelectionState = {
          isActive: true, isBold: false, isItalic: false,
          isStrikethrough: false, isCode: false, fontFamily: 'sans',
          selectionHasAnyHighlight: false, blockType: 'paragraph',
          commentableNodeKey: selectedNode.getKey(),
          selectedImageNodeKey: $isImageNode(selectedNode) ? selectedNode.getKey() : null,
          isLink: false, linkUrl: null
        };
        onSelectedImageNodeKeyChange?.(nextState.selectedImageNodeKey);
        setSelectionState((previous) => {
          if (
            previous.isActive === nextState.isActive &&
            previous.commentableNodeKey === nextState.commentableNodeKey &&
            previous.selectedImageNodeKey === nextState.selectedImageNodeKey
          ) {
            return previous;
          }
          return nextState;
        });
      } else {
        onSelectedImageNodeKeyChange?.(null);
        setSelectionState((previous) => {
          if (
            !previous.isActive &&
            !previous.isBold &&
            !previous.isItalic &&
            !previous.isStrikethrough &&
            !previous.isCode &&
            previous.fontFamily === 'sans' &&
            !previous.selectionHasAnyHighlight &&
            previous.selectedImageNodeKey === null
          ) {
            return previous;
          }
          return getDefaultSelectionState();
        });
      }

      setRendererErrorAnalyticsContext({
        noteId,
        pane_id: paneId,
        split_view: Boolean(paneId),
        editor_mount_version: editorMountVersion,
        selection_kind: 'node',
        selection_text_length: 0,
        selection_block_type: undefined,
        active_node_type: selectedNode.getType(),
        top_level_node_type: getTopLevelElementOrNull(selectedNode)?.getType(),
        selected_node_type: selectedNode.getType(),
        selection_is_link: false,
        commentable_node_selected: $isCommentableDecorator(selectedNode),
      }, analyticsOwnerId);
    } else {
      onSelectedImageNodeKeyChange?.(null);
      setSelectionState((previous) => {
        if (
          !previous.isActive &&
          !previous.isBold &&
          !previous.isItalic &&
          !previous.isStrikethrough &&
          !previous.isCode &&
          previous.fontFamily === 'sans' &&
          !previous.selectionHasAnyHighlight &&
          previous.selectedImageNodeKey === null
        ) {
          return previous;
        }
        return getDefaultSelectionState();
      });

      setRendererErrorAnalyticsContext({
        noteId,
        pane_id: paneId,
        split_view: Boolean(paneId),
        editor_mount_version: editorMountVersion,
        selection_kind: 'none',
        selection_text_length: 0,
        selection_block_type: undefined,
        active_node_type: undefined,
        top_level_node_type: undefined,
        selected_node_type: undefined,
        selection_is_link: false,
        commentable_node_selected: false,
      }, analyticsOwnerId);
    }
  }, [analyticsOwnerId, editorMountVersion, noteId, onSelectedImageNodeKeyChange, paneId, setListContext, setSelectionState]);

  // Selection change: fires when cursor moves, text is selected, or focus changes.
  // Does NOT fire on every keystroke within the same position.
  // Gated with selection.is() so repeated clicks at the same position skip all work.
  useEffect(() => {
    return editor.registerCommand(
      SELECTION_CHANGE_COMMAND,
      () => {
        const selection = $getSelection();
        $normalizeSelectionTableCells(selection);
        if (
          selection !== null &&
          lastToolbarSelectionRef.current !== null &&
          selection.is(lastToolbarSelectionRef.current)
        ) {
          return false;
        }
        lastToolbarSelectionRef.current = selection?.clone() ?? null;
        syncToolbarState();
        // Capture selection rect for floating toolbar positioning
        const domSelection = window.getSelection();
        if (domSelection && domSelection.rangeCount > 0 && !domSelection.isCollapsed) {
          const range = domSelection.getRangeAt(0);
          selectionRectRef.current = range.getBoundingClientRect();
          setSelectionRectVersion(v => v + 1);
        } else if (!linkInputStateRef.current?.open && !isPaletteOpenRef.current) {
          // Don't clear selection rect while link input or the command palette
          // is open. Those popovers steal focus and collapse the DOM
          // selection, but keeping the rect lets the selection toolbar restore
          // in the right place if focus returns to the editor.
          if (selectionRectRef.current !== null) {
            selectionRectRef.current = null;
            setSelectionRectVersion(v => v + 1);
          }
        }
        setHeadingDropdownOpen(false);
        setFontDropdownOpen(false);
        setHighlightDropdownOpen(false);
        setListDropdownOpen(false);
        return false;
      },
      COMMAND_PRIORITY_NORMAL
    );
  }, [editor, syncToolbarState]);

  // Track editor focus state for toolbar visibility.
  // Uses relatedTarget for fast intra-editor short-circuit, then a rAF-deferred
  // activeElement check so Radix portal interactions (dropdowns, tooltips) don't
  // dismiss the toolbar.


  // Format change: fires when bold/italic/etc. is toggled via shortcuts.
  // SELECTION_CHANGE_COMMAND doesn't fire for format-only changes.
  useEffect(() => {
    let stale = false;
    const unregister = editor.registerCommand(
      FORMAT_TEXT_COMMAND,
      () => {
        // Defer read until after Lexical applies the format. At LOW priority
        // the format is already applied, so setTimeout(0) is sufficient.
        setTimeout(() => {
          if (stale) return;
          editor.getEditorState().read(() => {
            syncToolbarState();
          });
        }, 0);
        return false;
      },
      COMMAND_PRIORITY_LOW
    );
    return () => {
      stale = true;
      unregister();
    };
  }, [editor, syncToolbarState]);

  // Deleting or typing over a selected range collapses the selection without
  // firing SELECTION_CHANGE_COMMAND (keystroke-driven selection moves are
  // internal to Lexical), which left the floating toolbar showing with a stale
  // rect. Targeted commands only — registered solely while a range is tracked.
  useEffect(() => {
    let stale = false;
    const syncAfterRangeCollapse = () => {
      if (selectionRectRef.current === null) {
        return false;
      }
      setTimeout(() => {
        if (stale) return;
        editor.getEditorState().read(() => {
          const selection = $getSelection();
          lastToolbarSelectionRef.current = selection?.clone() ?? null;
          syncToolbarState();
        });
        const domSelection = window.getSelection();
        if (
          (!domSelection || domSelection.rangeCount === 0 || domSelection.isCollapsed) &&
          !linkInputStateRef.current?.open &&
          !isPaletteOpenRef.current &&
          selectionRectRef.current !== null
        ) {
          selectionRectRef.current = null;
          setSelectionRectVersion(v => v + 1);
        }
      }, 0);
      return false;
    };
    const unregisters = [
      editor.registerCommand(KEY_BACKSPACE_COMMAND, syncAfterRangeCollapse, COMMAND_PRIORITY_LOW),
      editor.registerCommand(KEY_DELETE_COMMAND, syncAfterRangeCollapse, COMMAND_PRIORITY_LOW),
      editor.registerCommand(CONTROLLED_TEXT_INSERTION_COMMAND, syncAfterRangeCollapse, COMMAND_PRIORITY_LOW)
    ];
    return () => {
      stale = true;
      for (const unregister of unregisters) {
        unregister();
      }
    };
  }, [editor, syncToolbarState]);

  const applyHighlight = useCallback(() => {
    editor.update(() => {
      const selection = $getSelection();
      if ($isRangeSelection(selection) && !selection.isCollapsed()) {
        $patchStyleText(selection, {
          'background-color': HIGHLIGHT_YELLOW_VALUE
        });
      }
    }, { tag: 'history-push' });
  }, [editor]);

  const clearHighlight = useCallback(() => {
    editor.update(() => {
      const selection = $getSelection();
      if ($isRangeSelection(selection) && !selection.isCollapsed()) {
        $patchStyleText(selection, {
          'background-color': ''
        });
      }
    }, { tag: 'history-push' });
  }, [editor]);

  /** Toggle yellow highlight on/off. */
  const toggleHighlight = useCallback(() => {
    editor.getEditorState().read(() => {
      const selection = $getSelection();
      if (!$isRangeSelection(selection) || selection.isCollapsed()) return;

      // Check if any selected text node already has a highlight
      let hasHighlight = false;
      const nodes = selection.getNodes();
      for (const node of nodes) {
        if ($isTextNode(node)) {
          const style = node.getStyle();
          if (style && (style.includes(HIGHLIGHT_YELLOW_VAR) || Object.values(HIGHLIGHT_COLOR_VARIABLES).some(v => style.includes(v)))) {
            hasHighlight = true;
            break;
          }
        }
      }

      if (hasHighlight) {
        clearHighlight();
      } else {
        applyHighlight();
      }
      // Re-sync toolbar after highlight change (not a FORMAT_TEXT_COMMAND, so
      // the format listener won't catch it). rAF ensures Lexical reconciled.
      highlightSyncRafRef.current = requestAnimationFrame(() => {
        highlightSyncRafRef.current = null;
        editor.getEditorState().read(() => { syncToolbarState(); });
      });
    });
  }, [applyHighlight, clearHighlight, editor, syncToolbarState]);

  const applyFontFamily = useCallback((fontFamily: EditorSelectionFontFamily) => {
    editor.update(() => {
      const savedSelection = lastToolbarSelectionRef.current;
      if ($isRangeSelection(savedSelection)) {
        const anchorNode = $getNodeByKey(savedSelection.anchor.key);
        const focusNode = $getNodeByKey(savedSelection.focus.key);
        if (anchorNode && focusNode) {
          $setSelection(savedSelection.clone());
        }
      }

      const selection = $getSelection();
      if ($isRangeSelection(selection)) {
        $patchStyleText(selection, {
          [STYLE_FONT_FAMILY_PROPERTY]: fontFamily === 'serif' ? SERIF_FONT_FAMILY_VALUE : null,
          [STYLE_FONT_SIZE_ADJUST_PROPERTY]: fontFamily === 'serif' ? SERIF_OPTICAL_FONT_SIZE_ADJUST : null
        });
      }
    }, { tag: ['history-push', EDITOR_UPDATE_TAGS.content.fontFamilyStyle] });

    highlightSyncRafRef.current = requestAnimationFrame(() => {
      highlightSyncRafRef.current = null;
      editor.getEditorState().read(() => { syncToolbarState(); });
    });
  }, [editor, syncToolbarState]);

  // List type behaviors (number→bullet on indent, preserve check on outdent)
  // are handled globally by ChecklistPreservePlugin
  // Cancel highlight sync rAF on unmount (component remounts per note via key)
  useEffect(() => {
    return () => {
      if (highlightSyncRafRef.current) { cancelAnimationFrame(highlightSyncRafRef.current); highlightSyncRafRef.current = null; }
    };
  }, []);

  const indentSelection = useCallback(() => {
    editor.update(() => {
      editor.dispatchCommand(INDENT_CONTENT_COMMAND, undefined);
    }, { tag: 'history-push' });
  }, [editor]);

  const outdentSelection = useCallback(() => {
    editor.update(() => {
      editor.dispatchCommand(OUTDENT_CONTENT_COMMAND, undefined);
    }, { tag: 'history-push' });
  }, [editor]);

  const focusListItem = useCallback((target: ListItemNode | null) => {
    if (!target) {
      return;
    }

    const hasTextChild = target.getChildren().some((child) => $isTextNode(child));
    if (!hasTextChild) {
      target.append($createTextNode(''));
    }

    target.selectEnd();
  }, []);

  const insertCheckbox = useCallback(() => {
    editor.update(() => {
      let selection = $getSelection();
      if (!$isRangeSelection(selection)) {
        const root = $getRoot();
        let paragraph = root.getLastChild();

        if (!paragraph || !$isParagraphNode(paragraph)) {
          paragraph = $createParagraphNode();
          root.append(paragraph);
        }

        if (!$isParagraphNode(paragraph)) {
          return;
        }

        if (!paragraph.getChildren().some((child: LexicalNode) => $isTextNode(child))) {
          paragraph.append($createTextNode(''));
        }

        paragraph.selectEnd();
        selection = $getSelection();
      }

      if (!$isRangeSelection(selection)) {
        return;
      }

      const anchor = selection.anchor.getNode();
      const existingListItem = findContainingListItem(anchor);

      if (existingListItem) {
        const parentList = existingListItem.getParent();
        if ($isListNode(parentList)) {
          if (parentList.getListType() === 'check') {
            editor.dispatchCommand(REMOVE_LIST_COMMAND, undefined);
            return;
          }
          parentList.setListType('check');
        }
        focusListItem(existingListItem);
        return;
      }

      $normalizeSelectionTableCells(selection);
      $insertList('check');
      const nextSelection = $getSelection();
      const nextAnchor = $isRangeSelection(nextSelection) ? nextSelection.anchor.getNode() : null;
      focusListItem(findContainingListItem(nextAnchor));
    }, { tag: 'history-push' });
  }, [editor, focusListItem]);

  const toggleStrikethrough = useCallback(() => {
    editor.update(() => {
      editor.dispatchCommand(FORMAT_TEXT_COMMAND, 'strikethrough');
    }, { tag: 'history-push' });
  }, [editor]);

  const toggleInlineCode = useCallback(() => {
    editor.update(() => {
      const selection = $getSelection();
      if (!$isRangeSelection(selection)) return;
      const wasCode = selection.hasFormat('code');
      editor.dispatchCommand(FORMAT_TEXT_COMMAND, 'code');
      // When applying code (not removing), insert a boundary text node after
      // the formatted range so the cursor exits the code span — matching the
      // behavior of typing backticks directly.
      if (!wasCode) {
        const sel = $getSelection();
        if (!$isRangeSelection(sel)) return;
        const focusNode = sel.focus.getNode();
        if ($isTextNode(focusNode) && focusNode.hasFormat('code')) {
          // Insert an unformatted boundary node after the code span so the
          // next keystroke exits the code format.
          const boundary = $createTextNode('');
          focusNode.insertAfter(boundary);
          boundary.select();
          // Mark selection format as non-code so typing continues unformatted
          const newSel = $getSelection();
          if ($isRangeSelection(newSel)) {
            newSel.format = 0;
          }
        }
      }
    }, { tag: 'history-push' });
  }, [editor]);

  const toggleBold = useCallback(() => {
    editor.update(() => {
      editor.dispatchCommand(FORMAT_TEXT_COMMAND, 'bold');
    }, { tag: 'history-push' });
  }, [editor]);

  const toggleItalic = useCallback(() => {
    editor.update(() => {
      editor.dispatchCommand(FORMAT_TEXT_COMMAND, 'italic');
    }, { tag: 'history-push' });
  }, [editor]);

  const toggleHeading = useCallback((tag: HeadingTagType) => {
    editor.update(() => {
      const selection = $getSelection();
      if (!$isRangeSelection(selection)) return;

      // Save selection points so we can restore the range after the node swap
      const anchor = { key: selection.anchor.key, offset: selection.anchor.offset, type: selection.anchor.type };
      const focus = { key: selection.focus.key, offset: selection.focus.offset, type: selection.focus.type };

      const anchorNode = selection.anchor.getNode();
      const element = getTopLevelElementOrNull(anchorNode);
      if (!element) return;
      if ($isHeadingNode(element) && element.getTag() === tag) {
        const paragraph = $createParagraphNode();
        element.getChildren().forEach((child) => paragraph.append(child));
        element.replace(paragraph);
      } else {
        const heading = $createHeadingNode(tag);
        if ($isElementNode(element)) {
          element.getChildren().forEach((child) => heading.append(child));
        }
        element.replace(heading);
      }

      // Restore the original selection range (children were moved, keys are still valid)
      const restored = $getSelection();
      if ($isRangeSelection(restored)) {
        restored.anchor.set(anchor.key, anchor.offset, anchor.type as 'text' | 'element');
        restored.focus.set(focus.key, focus.offset, focus.type as 'text' | 'element');
      }
    }, { tag: 'history-push' });
    // Refocus editor after Radix dropdown closes and steals focus
    requestAnimationFrame(() => editor.focus());
  }, [editor]);


  const insertSlashCommand = useCallback(() => {
    editor.focus();
    // Small delay to ensure editor has focus before inserting
    requestAnimationFrame(() => {
      editor.update(() => {
        const selection = $getSelection();
        if (!$isRangeSelection(selection)) return;
        const textNode = $createTextNode('/');
        selection.insertNodes([textNode]);
        textNode.selectEnd();
      });
    });
  }, [editor]);

  const pastePlainText = useCallback(() => {
    if (typeof navigator === 'undefined' || !navigator.clipboard?.readText) {
      return;
    }

    void navigator.clipboard.readText().then((plainText) => {
      if (!plainText) {
        return;
      }

      editor.update(() => {
        const selection = $getSelection();
        if ($isRangeSelection(selection)) {
          selection.insertText(plainText);
          return;
        }

        const paragraphNode = $createParagraphNode();
        paragraphNode.append($createTextNode(plainText));
        $getRoot().append(paragraphNode);
      });
    }).catch(() => {});
  }, [editor]);

  const toggleBulletList = useCallback(() => {
    editor.update(() => {
      if (listContext.listType === 'bullet') {
        editor.dispatchCommand(REMOVE_LIST_COMMAND, undefined);
      } else {
        editor.dispatchCommand(INSERT_UNORDERED_LIST_COMMAND, undefined);
      }
    }, { tag: 'history-push' });
  }, [editor, listContext.listType]);

  const toggleNumberedList = useCallback(() => {
    editor.update(() => {
      if (listContext.listType === 'number') {
        editor.dispatchCommand(REMOVE_LIST_COMMAND, undefined);
      } else {
        editor.dispatchCommand(INSERT_ORDERED_LIST_COMMAND, undefined);
      }
    }, { tag: 'history-push' });
  }, [editor, listContext.listType]);

  // ---- Link input state ----
  const [linkInputState, setLinkInputState] = useState<{
    open: boolean;
    mode: 'create' | 'edit';
    initialUrl: string;
    anchorRect: { x: number; y: number; width: number; height: number } | null;
    anchorSide: LinkInputPopoverSide;
    collisionBoundary: Element | null;
  } | null>(null);
  const [hyperlinkContextMenuState, setHyperlinkContextMenuState] =
    useState<HyperlinkContextMenuState>(initialHyperlinkContextMenuState);
  const linkInputStateRef = useRef(linkInputState);
  linkInputStateRef.current = linkInputState;

  // Clear the temporary visual highlight applied while the link popover is open
  const clearLinkSelectionMark = useCallback(() => {
    editor.update(() => {
      const root = $getRoot();
      const textNodes: TextNode[] = [];
      const collectTextNodes = (node: LexicalNode) => {
        if ($isTextNode(node)) {
          const style = node.getStyle();
          if (style.includes('--link-selection')) {
            textNodes.push(node);
          }
        } else if ($isElementNode(node)) {
          node.getChildren().forEach(collectTextNodes);
        }
      };
      root.getChildren().forEach(collectTextNodes);
      for (const node of textNodes) {
        const style = node.getStyle();
        const cleaned = style
          .split(';')
          .map(s => s.trim())
          .filter(s => s && !s.includes('--link-selection'))
          .join('; ');
        node.setStyle(cleaned);
      }
    }, { tag: ['history-merge', EDITOR_UPDATE_TAGS.ignored.skipDirty] });
  }, [editor]);

  const closeHyperlinkContextMenu = useCallback(() => {
    setHyperlinkContextMenuState(initialHyperlinkContextMenuState);
  }, []);

  const openExistingLinkInput = useCallback((state: HyperlinkContextMenuState) => {
    const anchorSide = resolveLinkInputPopoverSide({
      anchorRect: { top: state.anchorRect.y },
      editorRootRect: editor.getRootElement()?.getBoundingClientRect() ?? null
    });

    clearLinkSelectionMark();
    editor.update(() => {
      const node = $getNodeByKey(state.nodeKey);
      if (!$isLinkNode(node)) return;

      const selection = selectLinkNodeContents(node);
      if ($isRangeSelection(selection) && !selection.isCollapsed()) {
        $patchStyleText(selection, { '--link-selection': 'true' });
      }

      setLinkInputState({
        open: true,
        mode: 'edit',
        initialUrl: node.getURL(),
        anchorRect: state.anchorRect,
        anchorSide,
        collisionBoundary: editor.getRootElement()?.closest('.canvas-scroll') ?? null
      });
    }, { tag: ['history-merge', EDITOR_UPDATE_TAGS.ignored.skipDirty] });
  }, [clearLinkSelectionMark, editor]);

  const openHyperlinkSplitView = useCallback((state: HyperlinkContextMenuState) => {
    const normalizedUrl = normalizeWebBrowserUrl(state.url);
    if (!normalizedUrl) return;

    openBrowserSplit({
      url: normalizedUrl,
      title: state.displayText || normalizedUrl,
      sourceNoteId: noteId
    });
  }, [noteId, openBrowserSplit]);

  useEffect(() => {
    const handleContextMenu = (event: MouseEvent) => {
      const rootElement = editor.getRootElement();
      if (!rootElement) return;

      const target = event.target as HTMLElement | null;
      const anchorElement = target?.closest('a[href]') as HTMLAnchorElement | null;
      if (!anchorElement || !rootElement.contains(anchorElement)) {
        return;
      }

      let nextState: HyperlinkContextMenuState | null = null;
      editor.read(() => {
        const nearestNode = $getNearestNodeFromDOMNode(anchorElement);
        if (!nearestNode) {
          return;
        }
        const linkNode = $isLinkNode(nearestNode)
          ? nearestNode
          : $findMatchingParent(nearestNode, $isLinkNode);
        if (!$isLinkNode(linkNode)) {
          return;
        }

        const rect = anchorElement.getBoundingClientRect();
        nextState = {
          isVisible: true,
          position: { x: event.clientX, y: event.clientY },
          nodeKey: linkNode.getKey(),
          url: linkNode.getURL(),
          displayText: linkNode.getTextContent(),
          anchorRect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
        };
      });

      if (!nextState) return;

      event.preventDefault();
      event.stopPropagation();
      setHyperlinkContextMenuState(nextState);
    };

    const attach = (rootElement: HTMLElement): void => {
      rootElement.addEventListener('contextmenu', handleContextMenu);
    };
    const detach = (rootElement: HTMLElement): void => {
      rootElement.removeEventListener('contextmenu', handleContextMenu);
    };

    return editor.registerRootListener((rootElement, previousRootElement) => {
      if (previousRootElement) detach(previousRootElement);
      if (rootElement) attach(rootElement);
    });
  }, [editor]);

  const openLinkInput = useCallback(() => {
    // Anchor the link popover to the floating toolbar element while allowing
    // it to flip below when the top placement would run into the title area.
    const toolbarEl = floatingToolbarRef.current;
    const anchorRect = toolbarEl
      ? toolbarEl.getBoundingClientRect()
      : selectionRectRef.current;
    if (!anchorRect) return;
    const rect = { x: anchorRect.x, y: anchorRect.y, width: anchorRect.width, height: anchorRect.height };
    const anchorSide = resolveLinkInputPopoverSide({
      anchorRect,
      editorRootRect: editor.getRootElement()?.getBoundingClientRect() ?? null
    });

    editor.update(() => {
      const selection = $getSelection();
      if (!$isRangeSelection(selection)) return;
      const anchorNode = selection.anchor.getNode();
      const linkParent = $findMatchingParent(anchorNode, $isLinkNode);

      // Apply a temporary visual highlight so the selected text stays visible
      // when the link popover steals focus. Uses a CSS custom property that
      // won't serialize to markdown.
      if (!selection.isCollapsed()) {
        $patchStyleText(selection, { '--link-selection': 'true' });
      }

      if (linkParent) {
        setLinkInputState({
          open: true,
          mode: 'edit',
          initialUrl: (linkParent as LinkNode).getURL(),
          anchorRect: rect,
          anchorSide,
          collisionBoundary: editor.getRootElement()?.closest('.canvas-scroll') ?? null
        });
      } else {
        setLinkInputState({
          open: true,
          mode: 'create',
          initialUrl: '',
          anchorRect: rect,
          anchorSide,
          collisionBoundary: editor.getRootElement()?.closest('.canvas-scroll') ?? null
        });
      }
    }, { tag: ['history-merge', EDITOR_UPDATE_TAGS.ignored.skipDirty] });
  }, [editor]);

  const applyLink = useCallback((url: string) => {
    editor.update(() => {
      // Inline link-selection cleanup to avoid a separate update cycle
      const root = $getRoot();
      const collectAndClean = (node: LexicalNode) => {
        if ($isTextNode(node)) {
          const style = node.getStyle();
          if (style.includes('--link-selection')) {
            const cleaned = style
              .split(';')
              .map(s => s.trim())
              .filter(s => s && !s.includes('--link-selection'))
              .join('; ');
            node.setStyle(cleaned);
          }
        } else if ($isElementNode(node)) {
          node.getChildren().forEach(collectAndClean);
        }
      };
      root.getChildren().forEach(collectAndClean);
      const shouldCreateWebEmbed =
        linkInputStateRef.current?.mode === 'create' &&
        $tryCreateWebEmbedFromBangLinkSelection(url);
      if (!shouldCreateWebEmbed) {
        $toggleLink(url);
      }
    }, { tag: 'history-push' });
    setLinkInputState(null);
    editor.focus();
  }, [editor]);

  const removeLink = useCallback(() => {
    editor.update(() => {
      // Inline link-selection cleanup to avoid a separate update cycle
      const root = $getRoot();
      const collectAndClean = (node: LexicalNode) => {
        if ($isTextNode(node)) {
          const style = node.getStyle();
          if (style.includes('--link-selection')) {
            const cleaned = style
              .split(';')
              .map(s => s.trim())
              .filter(s => s && !s.includes('--link-selection'))
              .join('; ');
            node.setStyle(cleaned);
          }
        } else if ($isElementNode(node)) {
          node.getChildren().forEach(collectAndClean);
        }
      };
      root.getChildren().forEach(collectAndClean);
      $toggleLink(null);
    }, { tag: 'history-push' });
    setLinkInputState(null);
    setSelectionState(previous => (previous.isLink || previous.linkUrl !== null ? { ...previous, isLink: false, linkUrl: null } : previous));
    editor.focus();
  }, [editor, setSelectionState]);

  // rAF handle for toolbar sync after highlight toggle
  const highlightSyncRafRef = useRef<number | null>(null);

  // Saved Lexical selection for restoring after comment input popover takes focus
  const savedSelectionRef = useRef<{anchorKey: string; anchorOffset: number; anchorType: 'text' | 'element'; focusKey: string; focusOffset: number; focusType: 'text' | 'element'} | null>(null);
  // Saved node key for block-level comment creation (no DOM Range for decorators)
  const savedNodeKeyRef = useRef<string | null>(null);

  // Open comment input popover with current selection
  // Show a persistent CSS highlight over the selected text while the annotation input is open
  const showSelectionHighlight = useCallback((range: Range) => {
    if (typeof CSS === 'undefined' || !CSS.highlights) return;
    CSS.highlights.set('comment-selection', new Highlight(range));
  }, []);

  const clearSelectionHighlight = useCallback(() => {
    if (typeof CSS === 'undefined') return;
    CSS.highlights?.delete('comment-selection');
  }, []);

  const resolveCommentableNodeKeyFromElement = useCallback((target: Element | null): string | null => {
    if (!(target instanceof HTMLElement)) {
      return null;
    }

    const keyCarrier = target.closest(
      '[data-block-decorator-key], [data-file-link-node-key], [data-formula-node-key]'
    ) as HTMLElement | null;
    if (!keyCarrier) {
      return null;
    }

    const candidateKey =
      keyCarrier.getAttribute('data-block-decorator-key')
      ?? keyCarrier.getAttribute('data-file-link-node-key')
      ?? keyCarrier.getAttribute('data-formula-node-key');
    if (!candidateKey) {
      return null;
    }

    let isCommentable = false;
    editor.getEditorState().read(() => {
      const node = $getNodeByKey(candidateKey);
      isCommentable = !!node && $isCommentableDecorator(node);
    });

    return isCommentable ? candidateKey : null;
  }, [editor]);


  const openCommentInput = useCallback(() => {
    // Block-level decorator path: use the node's DOM element for positioning.
    // Fallback to reading the live NodeSelection so keyboard-triggered annotate
    // on decorator blocks works even if selectionState lags by one frame.
    let commentableNodeKey = selectionState.commentableNodeKey;
    if (!commentableNodeKey) {
      editor.getEditorState().read(() => {
        const selection = $getSelection();
        if ($isNodeSelection(selection)) {
          const nodes = selection.getNodes();
          if (nodes.length === 1 && $isCommentableDecorator(nodes[0])) {
            commentableNodeKey = nodes[0].getKey();
          }
        }
      });
    }

    // Fallback for decorator-owned form controls (e.g. code block textarea):
    // they don't produce Lexical RangeSelection, so resolve from focused element.
    if (!commentableNodeKey && typeof document !== 'undefined') {
      commentableNodeKey = resolveCommentableNodeKeyFromElement(document.activeElement);
    }

    if (commentableNodeKey) {
      savedNodeKeyRef.current = commentableNodeKey;
      const el = editor.getElementByKey(commentableNodeKey);
      if (el) {
        const rect = el.getBoundingClientRect();
        setCommentInputState({
          open: true,
          anchorRect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
          targetNodeKey: commentableNodeKey,
        });
      }
      return;
    }

    // Text selection path
    savedNodeKeyRef.current = null;
    const domSelection = window.getSelection();

    // No selection or collapsed: auto-select the current paragraph node
    if (!domSelection || domSelection.rangeCount === 0 || domSelection.isCollapsed) {
      editor.update(() => {
        const selection = $getSelection();
        if (!$isRangeSelection(selection)) return;
        const anchorNode = selection.anchor.getNode();
        const topLevel = getTopLevelElementOrNull(anchorNode);
        if (!topLevel) return;
        topLevel.selectStart();
        const newSel = topLevel.select(0, topLevel.getChildrenSize());
        $setSelection(newSel);
      }, { discrete: true });
      // Re-read DOM selection after Lexical update
      const updatedDomSelection = window.getSelection();
      if (!updatedDomSelection || updatedDomSelection.rangeCount === 0 || updatedDomSelection.isCollapsed) {
        return;
      }
    }

    // Save Lexical selection before popover steals focus
    editor.getEditorState().read(() => {
      const selection = $getSelection();
      if ($isRangeSelection(selection)) {
        savedSelectionRef.current = {
          anchorKey: selection.anchor.key,
          anchorOffset: selection.anchor.offset,
          anchorType: selection.anchor.type,
          focusKey: selection.focus.key,
          focusOffset: selection.focus.offset,
          focusType: selection.focus.type,
        };
      }
    });

    // Get selection rect from DOM and show persistent highlight
    if (domSelection && domSelection.rangeCount > 0) {
      const range = domSelection.getRangeAt(0);
      const rect = range.getBoundingClientRect();

      // Clone the range so the highlight persists after focus moves to the textarea
      showSelectionHighlight(range.cloneRange());

      setCommentInputState({
        open: true,
        anchorRect: {
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
        },
        selectedText: domSelection.toString().slice(0, 50),
      });
    }
  }, [
    editor,
    resolveCommentableNodeKeyFromElement,
    selectionState.commentableNodeKey,
    setCommentInputState,
    showSelectionHighlight
  ]);


  // Handle OPEN_BLOCK_COMMENT_COMMAND from decorator toolbar comment button
  useEffect(() => {
    return editor.registerCommand(
      OPEN_BLOCK_COMMENT_COMMAND,
      ({ nodeKey }) => {
        const rootElement = editor.getRootElement();
        if (!rootElement) return false;
        const el = rootElement.querySelector(`[data-block-decorator-key="${nodeKey}"]`);
        if (!el) return false;
        // Anchor to the top-right corner of the decorator element
        const rect = el.getBoundingClientRect();
        savedNodeKeyRef.current = nodeKey;
        setCommentInputState({
          open: true,
          anchorRect: { x: rect.right, y: rect.top, width: 0, height: 0 },
          targetNodeKey: nodeKey,
          anchorSide: 'top',
          anchorAlign: 'end',
        });
        return true;
      },
      COMMAND_PRIORITY_NORMAL
    );
  }, [editor, setCommentInputState]);

  // Handle comment creation from CommentInputPopover
  const handleCommentCreate = useCallback((text: string, imageUrls?: string[]): boolean => {
    clearSelectionHighlight();

    // Lock scroll position during Lexical reconciliation — MarkNode wrapping
    // triggers auto-scroll that jumps the canvas. Same pattern as updateContentFromMarkdown.
    const scrollContainer = editor.getRootElement()?.closest('.canvas-scroll') as HTMLElement | null;
    const savedScrollTop = scrollContainer?.scrollTop ?? 0;
    let scrollLockActive = true;
    const lockScroll = () => {
      if (scrollLockActive && scrollContainer) {
        scrollContainer.scrollTop = savedScrollTop;
      }
    };
    if (scrollContainer) {
      scrollContainer.addEventListener('scroll', lockScroll);
    }
    const releaseScrollLock = () => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          scrollLockActive = false;
          if (scrollContainer) {
            scrollContainer.removeEventListener('scroll', lockScroll);
            scrollContainer.scrollTop = savedScrollTop;
          }
        });
      });
    };
    const abortScrollLock = () => {
      scrollLockActive = false;
      if (scrollContainer) {
        scrollContainer.removeEventListener('scroll', lockScroll);
      }
    };

    // Resolve a live commentable decorator selection key if available.
    const resolveLiveCommentableNodeKey = (): string | null => {
      let resolved: string | null = null;
      editor.getEditorState().read(() => {
        const selection = $getSelection();
        if ($isNodeSelection(selection)) {
          const nodes = selection.getNodes();
          if (nodes.length === 1 && $isCommentableDecorator(nodes[0])) {
            resolved = nodes[0].getKey();
          }
        }
      });
      return resolved;
    };

    // Block-level decorator path: use saved key first, then fallback to live selection key.
    // dispatchCommand creates its own update context, so no editor.update() wrapper needed.
    if (savedNodeKeyRef.current) {
      const liveKey = resolveLiveCommentableNodeKey();
      const candidateKeys = buildCommentNodeKeyCandidates(
        savedNodeKeyRef.current,
        liveKey
      );

      let created = false;
      for (const nodeKey of candidateKeys) {
        created = editor.dispatchCommand(CREATE_COMMENT_COMMAND, { text, nodeKey, imageUrls });
        if (created) {
          break;
        }
      }
      if (!created) {
        abortScrollLock();
        return false;
      }
      savedNodeKeyRef.current = null;

      releaseScrollLock();
      requestAnimationFrame(() => {
        const root = editor.getRootElement();
        if (root) root.focus({ preventScroll: true });
      });
      return true;
    }

    // Text selection path: restore the saved Lexical selection inside editor.update()
    // before dispatching, because the popover textarea stole focus and the Lexical range was lost.
    let created = false;
    editor.update(() => {
      const saved = savedSelectionRef.current;
      if (saved) {
        const anchorNode = $getNodeByKey(saved.anchorKey);
        const focusNode = $getNodeByKey(saved.focusKey);
        if (anchorNode && focusNode) {
          const selection = $createRangeSelection();
          selection.anchor.set(saved.anchorKey, saved.anchorOffset, saved.anchorType);
          selection.focus.set(saved.focusKey, saved.focusOffset, saved.focusType);
          $setSelection(selection);
        }
        savedSelectionRef.current = null;
      }
      created = editor.dispatchCommand(CREATE_COMMENT_COMMAND, { text, imageUrls });
    }, { discrete: true });
    if (!created) {
      abortScrollLock();
      return false;
    }
    // Don't call setCommentInputState here - the popover's onOpenChange handles closing
    releaseScrollLock();
    requestAnimationFrame(() => {
      const root = editor.getRootElement();
      if (root) root.focus({ preventScroll: true });
    });
    return true;
  }, [editor, clearSelectionHighlight]);

  // Handle comment popover close
  const handleCommentPopoverChange = useCallback((open: boolean) => {
    if (!open) {
      clearSelectionHighlight();
      savedNodeKeyRef.current = null;
      savedSelectionRef.current = null;
      setCommentInputState({ open: false, anchorRect: null });
    }
  }, [setCommentInputState, clearSelectionHighlight]);

  useEffect(() => {
    return editor.registerCommand(
      KEY_DOWN_COMMAND,
      (event) => {
        if (!event) {
          return false;
        }

        const hasPrimaryModifier = isMacPlatform ? event.metaKey : event.ctrlKey;
        const hasSecondaryModifier = isMacPlatform ? event.ctrlKey : event.metaKey;

        if (!hasPrimaryModifier || hasSecondaryModifier || !event.shiftKey) {
          return false;
        }

        const key = event.key.toLowerCase();

        if (key === 'h' && !event.altKey) {
          event.preventDefault();
          toggleHighlight();
          return true;
        }

        if (key === 's' && !event.altKey) {
          event.preventDefault();
          toggleStrikethrough();
          return true;
        }

        // Cmd+Shift+C for checkbox
        if (key === 'c' && !event.altKey) {
          event.preventDefault();
          insertCheckbox();
          return true;
        }

        // Cmd+Shift+V for plain-text paste
        if (key === 'v' && !event.altKey) {
          event.preventDefault();
          pastePlainText();
          return true;
        }

        // Cmd+Shift+A for comment annotation
        if (key === 'a' && !event.altKey) {
          event.preventDefault();
          openCommentInput();
          return true;
        }

        // Cmd+Shift+L for numbered list
        if (key === 'l' && !event.altKey) {
          event.preventDefault();
          toggleNumberedList();
          return true;
        }

        return false;
      },
      COMMAND_PRIORITY_NORMAL
    );
  }, [toggleHighlight, editor, isMacPlatform, toggleStrikethrough, insertCheckbox, pastePlainText, openCommentInput, toggleNumberedList]);

  // Cmd+L for bullet list, Cmd+E for inline code
  useEffect(() => {
    return editor.registerCommand(
      KEY_DOWN_COMMAND,
      (event) => {
        if (!event) return false;
        const hasPrimaryModifier = isMacPlatform ? event.metaKey : event.ctrlKey;
        if (!hasPrimaryModifier || event.shiftKey || event.altKey) return false;
        const key = event.key.toLowerCase();
        if (key === 'l') {
          event.preventDefault();
          toggleBulletList();
          return true;
        }
        if (key === 'e') {
          event.preventDefault();
          toggleInlineCode();
          return true;
        }
        return false;
      },
      COMMAND_PRIORITY_NORMAL
    );
  }, [editor, isMacPlatform, toggleBulletList, toggleInlineCode]);

  // Link payload + URL paste-as-link + markdown-aware plain-text paste.
  useEffect(() => {
    return registerPasteFormattingHandlers(editor);
  }, [editor]);

  const boldActive = selectionState.isBold;
  const italicActive = selectionState.isItalic;
  const heading1Active = selectionState.blockType === 'h1';
  const heading2Active = selectionState.blockType === 'h2';
  const heading3Active = selectionState.blockType === 'h3';
  const heading4Active = selectionState.blockType === 'h4';
  const highlightActive = selectionState.selectionHasAnyHighlight;
  const strikethroughActive = selectionState.isStrikethrough;
  const codeActive = selectionState.isCode;
  const indentActive = listContext.depth > 0;
  const canOutdent = listContext.depth > 0;
  const checkboxActive = listContext.listType === 'check';
  const bulletListActive = listContext.listType === 'bullet';
  const numberedListActive = listContext.listType === 'number';

  const accentClasses = SELECTION_TOOLBAR_BUTTON_ACCENT_CLASS;
  const idleButtonClasses = SELECTION_TOOLBAR_BUTTON_IDLE_CLASS;
  const accentMap: Record<ToolbarTool, boolean> = {
    bold: boldActive,
    italic: italicActive,
    heading1: heading1Active,
    heading2: heading2Active,
    heading3: heading3Active,
    heading4: heading4Active,
    highlight: highlightActive,
    strikethrough: strikethroughActive,
    code: codeActive,
    indent: indentActive,
    outdent: false,
    checkbox: checkboxActive,
    bulletList: bulletListActive,
    numberedList: numberedListActive,
    comment: commentInputState.open,
    quote: false,
    slash: false,
    link: selectionState.isActive && selectionState.isLink
  };
  const getButtonClasses = (tool: ToolbarTool, { forceAccent = false, press = true } = {}) =>
    [TOOL_BUTTON_BASE_CLASSES, press ? TOOL_BUTTON_PRESS_CLASS : '', !isPaletteOpen && (forceAccent || accentMap[tool]) ? accentClasses : idleButtonClasses].filter(Boolean).join(
      ' '
    );

  // ---- Toolbar groups (inline → block → list → selection-only) ----

  const anyHeadingActive = heading1Active || heading2Active || heading3Active || heading4Active;
  const activeHeadingLevel: HeadingLevel =
    heading1Active ? 'h1' : heading2Active ? 'h2' : heading3Active ? 'h3' : heading4Active ? 'h4' : 'h1';

  // ---- Unified toolbar layout ----
  // B I S | Highlight+Code dropdown | Font+H1 dropdowns | Checkbox | List dropdown [Indent Outdent] | Insert | Comment | Actions

  const inlineControls = (
    <div className="flex items-center gap-1">
      <ToolbarTooltip label="Bold" keys={['⌘', 'B']}>
        <button
          type="button"
          aria-label="Toggle bold"
          onMouseDown={(event) => event.preventDefault()}
          onClick={toggleBold}
          className={getButtonClasses('bold')}
        >
          <Bold aria-hidden className="h-4 w-4" />
        </button>
      </ToolbarTooltip>
      <ToolbarTooltip label="Italic" keys={['⌘', 'I']}>
        <button
          type="button"
          aria-label="Toggle italic"
          onMouseDown={(event) => event.preventDefault()}
          onClick={toggleItalic}
          className={getButtonClasses('italic')}
        >
          <Italic aria-hidden className="h-4 w-4" />
        </button>
      </ToolbarTooltip>
      <ToolbarTooltip label="Strikethrough" keys={['⌘', '⇧', 'S']}>
        <button
          type="button"
          aria-label="Toggle strikethrough"
          onMouseDown={(event) => event.preventDefault()}
          onClick={toggleStrikethrough}
          className={getButtonClasses('strikethrough')}
        >
          <Strikethrough aria-hidden className="h-4 w-4" />
        </button>
      </ToolbarTooltip>
      <DropdownMenu modal={false} open={highlightDropdownOpen} onOpenChange={(open) => { setHighlightDropdownOpen(open); if (!open) requestAnimationFrame(() => editor.focus()); }}>
        <ToolbarTooltip label="Highlight" keys={['⌘', '⇧', 'H']}>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label="Highlight and code"
              onMouseDown={(event) => event.preventDefault()}
              className={[
                TOOL_BUTTON_BASE_CLASSES,
                'w-auto gap-0.5 px-1.5',
                (highlightActive || codeActive) ? accentClasses : idleButtonClasses,
              ].join(' ')}
            >
              <span className="relative">
                <Highlighter aria-hidden className="h-4 w-4" />
                <span className="absolute -bottom-0.5 left-0.5 right-0.5 h-0.5 rounded-full bg-highlight-yellow" />
              </span>
              <ChevronDown aria-hidden className="h-3 w-3 opacity-50" />
            </button>
          </DropdownMenuTrigger>
        </ToolbarTooltip>
        <DropdownMenuContent side="top" align="start" className="w-auto min-w-0 p-1">
          <DropdownMenuItem
            className="gap-2"
            onSelect={() => { toggleHighlight(); }}
            onMouseDown={(event) => event.preventDefault()}
          >
            <Highlighter aria-hidden className="h-4 w-4" />
            Highlight
            <KeyboardShortcut keys={['⌘', '⇧', 'H']} size="compact" className="ml-auto" />
          </DropdownMenuItem>
          <DropdownMenuItem
            className="gap-2"
            onSelect={() => { toggleInlineCode(); }}
            onMouseDown={(event) => event.preventDefault()}
          >
            <Code2 aria-hidden className="h-4 w-4" />
            Inline code
            <KeyboardShortcut keys={['⌘', 'E']} size="compact" className="ml-auto" />
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );

  const blockControls = (
    <div className="flex items-center gap-1">
      <DropdownMenu modal={false} open={fontDropdownOpen} onOpenChange={setFontDropdownOpen}>
        <ToolbarTooltip label="Editor font">
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label="Editor font family"
              onMouseDown={(event) => event.preventDefault()}
              className={[
                TOOL_BUTTON_BASE_CLASSES,
                'w-auto gap-1 px-1.5',
                !isPaletteOpen && selectionState.fontFamily === 'serif' ? accentClasses : idleButtonClasses,
              ].join(' ')}
            >
              <ALargeSmall aria-hidden className="h-4 w-4" />
              <span
                className={cn('min-w-8 text-left text-xs font-medium', selectionState.fontFamily === 'sans' && 'font-sans')}
                style={selectionState.fontFamily === 'serif' ? SERIF_FONT_FAMILY_STYLE : undefined}
              >
                {EDITOR_FONT_FAMILY_LABELS[selectionState.fontFamily]}
              </span>
              <ChevronDown aria-hidden className="h-3 w-3 opacity-50" />
            </button>
          </DropdownMenuTrigger>
        </ToolbarTooltip>
        <DropdownMenuContent side="top" align="start" className="w-auto min-w-0 p-1">
          <DropdownMenuItem
            className={cn('gap-2', selectionState.fontFamily === 'sans' && 'bg-surface-panel')}
            onSelect={() => applyFontFamily('sans')}
            onMouseDown={(event) => event.preventDefault()}
          >
            <ALargeSmall aria-hidden className="h-4 w-4" />
            <span className="min-w-12 font-sans">Sans</span>
          </DropdownMenuItem>
          <DropdownMenuItem
            className={cn('gap-2', selectionState.fontFamily === 'serif' && 'bg-surface-panel')}
            onSelect={() => applyFontFamily('serif')}
            onMouseDown={(event) => event.preventDefault()}
          >
            <ALargeSmall aria-hidden className="h-4 w-4" />
            <span className="min-w-12" style={SERIF_FONT_FAMILY_STYLE}>Serif</span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <DropdownMenu modal={false} open={headingDropdownOpen} onOpenChange={setHeadingDropdownOpen}>
        <ToolbarTooltip label="Heading">
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label="Heading level"
              onMouseDown={(event) => event.preventDefault()}
              className={[
                TOOL_BUTTON_BASE_CLASSES,
                'w-auto gap-0.5 px-1.5',
                anyHeadingActive ? accentClasses : idleButtonClasses,
              ].join(' ')}
            >
              <HeadingLevelBadge level={activeHeadingLevel} className="min-w-0 gap-0 text-xs" />
              <ChevronDown aria-hidden className="h-3 w-3 opacity-50" />
            </button>
          </DropdownMenuTrigger>
        </ToolbarTooltip>
        <DropdownMenuContent side="top" align="start" className="w-auto min-w-0 p-1">
          <DropdownMenuItem
            className={cn('gap-2', heading1Active && 'bg-surface-panel')}
            onSelect={() => toggleHeading('h1')}
            onMouseDown={(event) => event.preventDefault()}
          >
            <HeadingLevelBadge level="h1" />
            Heading 1
            <code className="ml-auto shrink-0 rounded bg-surface-code px-1 py-0.5 font-mono text-[0.875em] leading-none text-ink-default">
              #
            </code>
          </DropdownMenuItem>
          <DropdownMenuItem
            className={cn('gap-2', heading2Active && 'bg-surface-panel')}
            onSelect={() => toggleHeading('h2')}
            onMouseDown={(event) => event.preventDefault()}
          >
            <HeadingLevelBadge level="h2" />
            Heading 2
            <code className="ml-auto shrink-0 rounded bg-surface-code px-1 py-0.5 font-mono text-[0.875em] leading-none text-ink-default">
              ##
            </code>
          </DropdownMenuItem>
          <DropdownMenuItem
            className={cn('gap-2', heading3Active && 'bg-surface-panel')}
            onSelect={() => toggleHeading('h3')}
            onMouseDown={(event) => event.preventDefault()}
          >
            <HeadingLevelBadge level="h3" />
            Heading 3
            <code className="ml-auto shrink-0 rounded bg-surface-code px-1 py-0.5 font-mono text-[0.875em] leading-none text-ink-default">
              ###
            </code>
          </DropdownMenuItem>
          <DropdownMenuItem
            className={cn('gap-2', heading4Active && 'bg-surface-panel')}
            onSelect={() => toggleHeading('h4')}
            onMouseDown={(event) => event.preventDefault()}
          >
            <HeadingLevelBadge level="h4" />
            Heading 4
            <code className="ml-auto shrink-0 rounded bg-surface-code px-1 py-0.5 font-mono text-[0.875em] leading-none text-ink-default">
              ####
            </code>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );

  const listControls = (
    <div className="flex items-center gap-1">
      <ToolbarTooltip label="Checklist" keys={['⌘', '⇧', 'C']}>
        <button
          type="button"
          aria-label="Insert checkbox"
          onMouseDown={(event) => event.preventDefault()}
          onClick={insertCheckbox}
          className={getButtonClasses('checkbox')}
        >
          <CheckSquare aria-hidden className="h-4 w-4" />
        </button>
      </ToolbarTooltip>
      <DropdownMenu modal={false} open={listDropdownOpen} onOpenChange={(open) => { setListDropdownOpen(open); if (!open) requestAnimationFrame(() => editor.focus()); }}>
        <ToolbarTooltip label="List" keys={['⌘', 'L']}>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label="List type"
              onMouseDown={(event) => event.preventDefault()}
              className={[
                TOOL_BUTTON_BASE_CLASSES,
                'w-auto gap-0.5 px-1.5',
                (bulletListActive || numberedListActive) ? accentClasses : idleButtonClasses,
              ].join(' ')}
            >
              <List aria-hidden className="h-4 w-4" />
              <ChevronDown aria-hidden className="h-3 w-3 opacity-50" />
            </button>
          </DropdownMenuTrigger>
        </ToolbarTooltip>
        <DropdownMenuContent side="top" align="start" className="w-auto min-w-0 p-1">
          <DropdownMenuItem
            className="gap-2"
            onSelect={() => { toggleBulletList(); }}
            onMouseDown={(event) => event.preventDefault()}
          >
            <List aria-hidden className="h-4 w-4" />
            Bullet
            <KeyboardShortcut keys={['⌘', 'L']} size="compact" className="ml-auto" />
          </DropdownMenuItem>
          <DropdownMenuItem
            className="gap-2"
            onSelect={() => { toggleNumberedList(); }}
            onMouseDown={(event) => event.preventDefault()}
          >
            <ListOrdered aria-hidden className="h-4 w-4" />
            Numbered
            <KeyboardShortcut keys={['⌘', '⇧', 'L']} size="compact" className="ml-auto" />
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {listContext.listType !== null && (
        <ToolbarTooltip label="Indent" keys={['Tab']}>
          <button
            type="button"
            aria-label="Indent selection"
            onMouseDown={(event) => event.preventDefault()}
            onClick={indentSelection}
            className={getButtonClasses('indent')}
          >
            <IndentIncrease aria-hidden className="h-4 w-4" />
          </button>
        </ToolbarTooltip>
      )}
      {canOutdent && (
        <ToolbarTooltip label="Outdent" keys={['⇧', 'Tab']}>
          <button
            type="button"
            aria-label="Outdent selection"
            onMouseDown={(event) => event.preventDefault()}
            onClick={outdentSelection}
            className={getButtonClasses('outdent')}
          >
            <IndentDecrease aria-hidden className="h-4 w-4" />
          </button>
        </ToolbarTooltip>
      )}
    </div>
  );

  const insertButton = (
    <ToolbarTooltip label="Insert" keys={['/']} >
      <button
        type="button"
        aria-label="Insert slash command"
        onMouseDown={(event) => event.preventDefault()}
        onClick={insertSlashCommand}
        className={getButtonClasses('slash')}
      >
        <SquarePlus aria-hidden className="h-4 w-4" />
      </button>
    </ToolbarTooltip>
  );

  const commentButton = (
    <ToolbarTooltip label="Comment" keys={['⌘', '⇧', 'A']}>
      <button
        type="button"
        aria-label="Add comment"
        onMouseDown={(event) => event.preventDefault()}
        onClick={openCommentInput}
        className={getButtonClasses('comment')}
      >
        <StickyNote aria-hidden className="h-4 w-4" />
      </button>
    </ToolbarTooltip>
  );

  const actionsButton = onActionClick ? (
    <ToolbarTooltip label="Actions" keys={['⌘', 'K']}>
      <button
        type="button"
        aria-label="Open command palette"
        onMouseDown={(e) => e.preventDefault()}
        onClick={(e) => { e.stopPropagation(); onActionClick?.(); }}
        className={cn(TOOL_BUTTON_BASE_CLASSES, idleButtonClasses)}
      >
        <Bot aria-hidden className="h-4 w-4" />
      </button>
    </ToolbarTooltip>
  ) : null;

  // Calculate days remaining for trashed notes
  const trashCountdownDays = useMemo(() => {
    if (typeof trashedAt !== 'number' || !Number.isFinite(trashedAt)) {
      return TRASH_RETENTION_DAYS;
    }
    // trashedAt is Unix seconds, convert to milliseconds
    const trashedTimestampMs = trashedAt * 1000;
    const expiresAt = trashedTimestampMs + TRASH_RETENTION_DAYS * MS_IN_DAY;
    const diffDays = Math.floor((expiresAt - currentTime) / MS_IN_DAY);
    return diffDays > 0 ? diffDays : 0;
  }, [trashedAt, currentTime]);

  const trashedToolbar = (
    <div className="px-3 py-2 text-sm text-ink-muted">
      Note will be deleted in {trashCountdownDays} {trashCountdownDays === 1 ? 'day' : 'days'}
    </div>
  );

  // Floating bar shows when text is selected (mutually exclusive with bottom bar AND comment popover)
  // Link popover shows ABOVE the floating bar, so floating bar stays visible during link editing.
  // Link input steals focus and collapses the DOM selection, so we preserve the
  // last non-collapsed anchor rect while it is open. The command palette also
  // preserves that rect, but intentionally hides the selection toolbar while
  // the palette owns focus.
  const hasActiveSelection = selectionState.isActive && !selectionState.commentableNodeKey;
  const showFloatingBar = (
    hasActiveSelection
    || !!linkInputState?.open
  ) && shouldRenderToolbarForPane && selectionRectRef.current !== null && !isPaletteOpen && !isTrashed && !isScrolling && !isMouseSelecting && !commentInputState.open;

  // Calculate floating bar position from selection rect
  // Clamp below the topnav (~48px from viewport top) to avoid overlap
  const NAV_BAR_BOTTOM = 48;
  const TOOLBAR_HEIGHT = 40;
  const TOOLBAR_CANVAS_GUTTER = 12;
  const TOOLBAR_FALLBACK_WIDTH = 500;
  const floatingBarStyle: React.CSSProperties | undefined = showFloatingBar && selectionRectRef.current ? (() => {
    const rect = selectionRectRef.current!;
    const centerX = rect.left + rect.width / 2;
    const toolbarWidth = floatingToolbarRef.current?.offsetWidth || TOOLBAR_FALLBACK_WIDTH;
    const halfToolbarWidth = toolbarWidth / 2;
    const boundedCenterX = toolbarCanvasBounds
      ? Math.min(
        Math.max(centerX, toolbarCanvasBounds.left + halfToolbarWidth + TOOLBAR_CANVAS_GUTTER),
        toolbarCanvasBounds.right - halfToolbarWidth - TOOLBAR_CANVAS_GUTTER
      )
      : centerX;
    const topPos = rect.top - TOOLBAR_HEIGHT - 8;
    const flipped = topPos < NAV_BAR_BOTTOM;
    return {
      position: 'fixed' as const,
      left: boundedCenterX,
      top: flipped ? rect.bottom + 8 : topPos,
      transform: 'translateX(-50%)',
      zIndex: 50,
      WebkitAppRegion: 'no-drag' as unknown as string,
    };
  })() : undefined;

  // Suppress unused variable warning — selectionRectVersion triggers re-render so floatingBarStyle recalculates
  void selectionRectVersion;

  const fallbackToolbarLeft = `calc((${isNotesPanelHidden ? '0px' : 'var(--notes-panel-width, 14rem)'} + 100vw - ${isActionsPanelHidden ? '0px' : 'var(--actions-panel-width, 14rem)'}) / 2)`;
  const bottomToolbarStyle = {
    left: toolbarCanvasCenterLeft === null ? fallbackToolbarLeft : `${toolbarCanvasCenterLeft}px`,
    WebkitAppRegion: 'no-drag',
    visibility: 'visible'
  } as React.CSSProperties;

  const toolbarContent = (
    <>
      {/* Floating selection bar — shown when text is selected */}
      {showFloatingBar && (
        <TooltipProvider delayDuration={200}>
          <SelectionToolbarShell
            ref={floatingToolbarRef}
            style={floatingBarStyle}
            data-floating-selection-toolbar="true"
          >
            <SelectionToolbarInner>
              {inlineControls}
              <ToolbarDivider />
              {blockControls}
              {listControls}
              <ToolbarDivider />
              <div className="flex items-center gap-1">
                {!selectionState.isCode && (
                  <ToolbarTooltip label="Link">
                    <button
                      type="button"
                      aria-label="Add link"
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={openLinkInput}
                      className={getButtonClasses('link')}
                    >
                      <Link2 aria-hidden className="h-4 w-4" />
                    </button>
                  </ToolbarTooltip>
                )}
                {commentButton}
                {actionsButton}
              </div>
            </SelectionToolbarInner>
          </SelectionToolbarShell>
        </TooltipProvider>
      )}
      {/* Bottom bar — shown when NO text is selected (also hidden during scroll with active selection to prevent flash) */}
      {shouldRenderToolbarForPane && !showFloatingBar && !(selectionState.isActive && isScrolling) && (
        <TooltipProvider delayDuration={200}>
          <div
            className="pointer-events-none fixed bottom-6 z-50 -translate-x-1/2 flex flex-col items-center gap-2 px-4"
            style={bottomToolbarStyle}
          >
            <div ref={portalRef} className="w-full max-w-lg empty:hidden" />
            <SelectionToolbarShell
              className="flex-col"
              style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
            >
              <SelectionToolbarInner>
                {isTrashed ? trashedToolbar : (
                  <>
                    {blockControls}
                    {listControls}
                    <ToolbarDivider />
                    <div className="flex items-center gap-1">
                      {insertButton}
                      {commentButton}
                      {actionsButton}
                    </div>
                  </>
                )}
              </SelectionToolbarInner>
            </SelectionToolbarShell>
          </div>
        </TooltipProvider>
      )}
    </>
  );

  // CommentInputPopover is rendered outside the toolbar conditional so it persists
  // even when the selection collapses (which happens when the popover steals focus).
  const commentInputPopover = (
    <CommentInputPopover
      open={commentInputState.open}
      onOpenChange={handleCommentPopoverChange}
      anchorRect={commentInputState.anchorRect}
      anchorSide={commentInputState.anchorSide}
      anchorAlign={commentInputState.anchorAlign}
      onCreate={handleCommentCreate}
      noteId={noteId}
      collisionBoundary={editor.getRootElement()?.closest('.canvas-scroll') ?? null}
    />
  );

  const linkPopover = linkInputState?.open ? (
    <LinkInputPopover
      key={linkInputState.initialUrl}
      open={linkInputState.open}
      mode={linkInputState.mode}
      initialUrl={linkInputState.initialUrl}
      anchorRect={linkInputState.anchorRect}
      anchorSide={linkInputState.anchorSide}
      collisionBoundary={linkInputState.collisionBoundary}
      onApply={applyLink}
      onRemove={removeLink}
      onClose={() => { clearLinkSelectionMark(); setLinkInputState(null); editor.focus(); }}
    />
  ) : null;

  const hyperlinkContextMenu = (
    <HyperlinkContextMenu
      state={hyperlinkContextMenuState}
      onClose={closeHyperlinkContextMenu}
      onEditLink={openExistingLinkInput}
      onOpenSplitView={openHyperlinkSplitView}
    />
  );

  // Use portal to render at body level, escaping @container containment context
  // that would otherwise make fixed positioning relative to the scroll container
  // SSR safety: only use portal when document is available
  if (typeof document !== 'undefined') {
    return createPortal(
      <>
        {toolbarContent}
        {commentInputPopover}
        {linkPopover}
        {hyperlinkContextMenu}
      </>,
      document.body
    );
  }

  return (
    <>
      {toolbarContent}
      {commentInputPopover}
      {linkPopover}
      {hyperlinkContextMenu}
    </>
  );
}

export const MarkdownEditor = forwardRef<MarkdownEditorHandle, MarkdownEditorProps>(
  function MarkdownEditor(
    {
      noteId,
      value,
      layoutMetadata,
      onChange,
      placeholder,
      readOnly = false,
      initialSerializedState,
      onReady,
      onBlur,
      onNavigateToNote,
      isTrashed = false,
      trashedAt,
      onActionClick,
      onSelectedImageAltTextAvailabilityChange,
      paneId,
      enableSearchPlugin = true,
      editorMountVersion,
      editorRemountReason = null
    }: MarkdownEditorProps,
    ref
  ) {
  const store = useStore();
  const latestEditorStateRef = useRef<EditorState | null>(null);
  const editorRef = useRef<LexicalEditor | null>(null);
  const lastContentChangeTagsRef = useRef<string | null>(null);
  const [isFormulaDraftPillActive, setIsFormulaDraftPillActive] = useState(false);
  const [selectedImageNodeKey, setSelectedImageNodeKey] = useState<string | null>(null);
  const hasInitialSerializedStateProp = initialSerializedState !== undefined;

  // Media source dialog state for /media slash command
  const { dialogProps: mediaSourceDialogProps, open: openMediaSourceDialog } = useMediaSourceDialog();

  // Register global dialog opener for slash command access
  useEffect(() => {
    setGlobalMediaSourceDialogOpener(openMediaSourceDialog);
    return () => setGlobalMediaSourceDialogOpener(null);
  }, [openMediaSourceDialog]);

  const editorStateCacheKey = useMemo(() => {
    const commentMetadata = buildCommentMetadata(store.get(noteCommentsMapAtom(noteId)));
    return buildMarkdownEditorStateCacheKey(
      noteId,
      value,
      buildCommentMetadataSignature(commentMetadata),
      serializeNoteLayoutMetadataForComparison(layoutMetadata)
    );
  }, [layoutMetadata, noteId, store, value]);
  const editorStateCacheKeyRef = useRef(editorStateCacheKey);
  editorStateCacheKeyRef.current = editorStateCacheKey;

  // Capture editor instance when ready
  const handleEditorReady = useCallback((editor: LexicalEditor) => {
    editorRef.current = editor;
    if (hasInitialSerializedStateProp) {
      onReady?.(editor);
      return;
    }

    const cacheKey = editorStateCacheKeyRef.current;
    requestAnimationFrame(() => {
      if (editorRef.current !== editor || editorStateCacheKeyRef.current !== cacheKey) {
        return;
      }

      rememberMarkdownEditorStateCache(
        cacheKey,
        JSON.stringify(editor.getEditorState().toJSON())
      );
    });
    onReady?.(editor);
  }, [hasInitialSerializedStateProp, onReady]);

  const analyticsOwnerId = `${paneId ?? 'single'}:${noteId}:${editorMountVersion ?? 0}`;

  useEffect(() => {
    setRendererErrorAnalyticsContext({
      noteId,
      pane_id: paneId,
      split_view: Boolean(paneId),
      editor_mount_version: editorMountVersion,
      editor_remount_reason: editorRemountReason ?? undefined,
    }, analyticsOwnerId);

    return () => {
      clearRendererErrorAnalyticsContext([
        'note_id_hash',
        'pane_id',
        'split_view',
        'editor_mount_version',
        'editor_remount_reason',
        'selection_kind',
        'selection_text_length',
        'selection_block_type',
        'active_node_type',
        'top_level_node_type',
        'selected_node_type',
        'selection_is_link',
        'commentable_node_selected',
        'last_content_change_tags',
        'last_markdown_import_source',
        'last_markdown_import_update_tag',
      ], analyticsOwnerId);
    };
  }, [analyticsOwnerId, editorMountVersion, editorRemountReason, noteId, paneId]);

  const initialConfig = useMemo<InitialConfigType>(
    () => {
      const cachedEditorState = readMarkdownEditorStateCache(editorStateCacheKey);

      const importMarkdownValue = (editor: LexicalEditor): void => {
        // Strip any residual comment footer from the value (defensive —
        // the content atom should already be footer-free, but external
        // code paths may still include one).
        const strippedContent = hasLegacyCommentFooter(value)
          ? parseCommentFooter(value).strippedContent
          : value;

        // Read comment metadata from the authoritative atom rather than
        // parsing it from the content string. This avoids the bug where
        // handleEditorChange strips the footer from the content atom,
        // causing $processCommentMarkers to receive empty metadata on
        // subsequent editor mounts (cached switch-back).
        const commentMetadata = buildCommentMetadata(store.get(noteCommentsMapAtom(noteId)));

        // Strip leading H1 from body — it lives in the dedicated title field
        let bodyForEditor = strippedContent;
        const h1Match = bodyForEditor.match(/^#(?!#)\s+(.*?)(?:\s*#*)?\s*(?:\n|$)/);
        if (h1Match) {
          bodyForEditor = bodyForEditor.slice(h1Match[0].length).replace(/^\n+/, '');
        }

        const normalizedBody = normalizeMarkdownForImport(bodyForEditor);

        $convertFromMarkdownString(escapeHtmlEntities(normalizedBody), MARKDOWN_EDITOR_TRANSFORMERS);
        $postImportNormalize(commentMetadata, undefined, { layoutMetadata });
        editor.getRootElement()?.scrollTo({ top: 0 });
      };

      const editorState = hasInitialSerializedStateProp
        ? (editor: LexicalEditor) => {
            if (initialSerializedState) {
              try {
                editor.setEditorState(editor.parseEditorState(initialSerializedState));
                editor.getRootElement()?.scrollTo({ top: 0 });
                return;
              } catch (error) {
                console.warn('[MarkdownEditor] Failed to parse initial serialized state:', error);
              }
            }

            importMarkdownValue(editor);
          }
        : cachedEditorState ?? importMarkdownValue;

      return {
        namespace: 'moss-markdown-editor',
        theme,
        html: {
          import: MARKDOWN_EDITOR_HTML_IMPORT
        },
        editable: !readOnly,
        nodes: MARKDOWN_EDITOR_NODES,
        onError(error) {
          throw error;
        },
        editorState
      };
    },
    [
      editorStateCacheKey,
      hasInitialSerializedStateProp,
      initialSerializedState,
      readOnly,
      value,
      store,
      noteId,
      layoutMetadata
    ]
  );

  const serializeCurrent = useCallback(() => {
    const stateToSerialize = latestEditorStateRef.current ?? editorRef.current?.getEditorState();

    if (!stateToSerialize) {
      return {
        markdown: value,
        serializedState: null
      };
    }

    const serializedState = stateToSerialize.toJSON();
    let markdown = value;

    stateToSerialize.read(() => {
      markdown = unescapeHtmlEntities($convertToMarkdownString(MARKDOWN_EDITOR_TRANSFORMERS));
    });

    return { markdown, serializedState };
  }, [value]);

  const getSelectedText = useCallback((): string => {
    const editor = editorRef.current;
    if (!editor) {
      return '';
    }

    let selectedText = '';
    editor.getEditorState().read(() => {
      const selection = $getSelection();
      if ($isRangeSelection(selection) && !selection.isCollapsed()) {
        selectedText = selection.getTextContent();
      }
    });

    return selectedText;
  }, []);

  const markSelectionAsContext = useCallback((): string => {
    const editor = editorRef.current;
    if (!editor) {
      return '';
    }

    let selectedText = '';
    editor.update(() => {
      const selection = $getSelection();
      if ($isRangeSelection(selection) && !selection.isCollapsed()) {
        selectedText = selection.getTextContent();
        // Apply CSS custom property flag to persist the visual highlight when editor loses focus.
        // Using a custom property instead of inline background-color ensures this is NOT
        // serialized to markdown (HIGHLIGHT_TRANSFORMER only exports known highlight colors).
        // Use $patchStyleText to properly handle partial text selections - it splits
        // text nodes as needed so only the selected portion is styled.
        $patchStyleText(selection, { '--context-selection': 'true' });
      }
    }, { tag: ['history-merge', EDITOR_UPDATE_TAGS.ignored.skipDirty] });

    return selectedText;
  }, []);

  const clearContextMark = useCallback((): void => {
    const editor = editorRef.current;
    if (!editor) {
      return;
    }

    editor.update(() => {
      const root = $getRoot();
      const textNodes: TextNode[] = [];

      // Collect all text nodes with the context selection flag
      const collectTextNodes = (node: LexicalNode) => {
        if ($isTextNode(node)) {
          const style = node.getStyle();
          if (style.includes('--context-selection')) {
            textNodes.push(node);
          }
        }
        if ('getChildren' in node && typeof node.getChildren === 'function') {
          const children = node.getChildren() as LexicalNode[];
          children.forEach(collectTextNodes);
        }
      };

      collectTextNodes(root);

      // Remove the context selection flag, preserving other styles
      for (const textNode of textNodes) {
        const style = textNode.getStyle();
        const newStyle = style
          .split(';')
          .filter(s => !s.includes('--context-selection'))
          .join(';')
          .trim();
        textNode.setStyle(newStyle);
      }
    }, { tag: ['history-merge', EDITOR_UPDATE_TAGS.ignored.skipDirty] });
  }, []);

  useEffect(() => {
    onSelectedImageAltTextAvailabilityChange?.(
      !readOnly && selectedImageNodeKey !== null
    );
  }, [
    onSelectedImageAltTextAvailabilityChange,
    readOnly,
    selectedImageNodeKey
  ]);

  useEffect(() => {
    return () => {
      onSelectedImageAltTextAvailabilityChange?.(false);
    };
  }, [onSelectedImageAltTextAvailabilityChange]);

  const openSelectedImageAltTextEditor = useCallback((): boolean => {
    const editor = editorRef.current;
    if (!editor || readOnly) {
      return false;
    }

    let targetImageNodeKey = selectedImageNodeKey;
    if (!targetImageNodeKey) {
      editor.getEditorState().read(() => {
        const selection = $getSelection();
        if (!$isNodeSelection(selection)) {
          return;
        }

        const selectedNodes = selection.getNodes();
        if (selectedNodes.length === 1 && $isImageNode(selectedNodes[0])) {
          targetImageNodeKey = selectedNodes[0].getKey();
        }
      });
    }

    if (!targetImageNodeKey) {
      return false;
    }

    editor.dispatchCommand(OPEN_IMAGE_ALT_TEXT_EDITOR_COMMAND, {
      nodeKey: targetImageNodeKey
    });
    return true;
  }, [readOnly, selectedImageNodeKey]);

  const focusStart = useCallback((): boolean => {
    const editor = editorRef.current;
    if (!editor) {
      return false;
    }

    editor.focus(() => {
      editor.update(() => {
        $addUpdateTag(SKIP_SCROLL_INTO_VIEW_TAG);
        $getRoot().selectStart();
      }, { discrete: true });
    }, { defaultSelection: 'rootStart' });
    return true;
  }, []);

  const focusAtPoint = useCallback((clientX: number, clientY: number): boolean => {
    const editor = editorRef.current;
    const rootElement = editor?.getRootElement();
    if (!editor || !rootElement) {
      return false;
    }

    const rootRect = rootElement.getBoundingClientRect();
    if (clientY < rootRect.top || clientY > rootRect.bottom) {
      return false;
    }

    const clampedX = Math.min(
      Math.max(clientX, rootRect.left + 1),
      rootRect.right - 1
    );
    let caretRange = document.caretRangeFromPoint?.(clampedX, clientY) ?? null;
    if (!caretRange) {
      const caretPosition = document.caretPositionFromPoint?.(clampedX, clientY);
      if (caretPosition) {
        caretRange = document.createRange();
        caretRange.setStart(caretPosition.offsetNode, caretPosition.offset);
        caretRange.collapse(true);
      }
    }
    if (!caretRange || !rootElement.contains(caretRange.startContainer)) {
      return false;
    }

    editor.update(() => {
      $addUpdateTag(SKIP_SCROLL_INTO_VIEW_TAG);
      const selection = $createRangeSelection();
      selection.applyDOMRange(caretRange);
      $setSelection(selection);
    }, { discrete: true });
    rootElement.focus({ preventScroll: true });
    return true;
  }, []);

  const updateContentFromMarkdown = useCallback((
    markdown: string,
    options?: {
      clearHistory?: boolean;
      scrollContainer?: HTMLElement | null;
      commentMetadata?: CommentMetadataMap;
      layoutMetadata?: NoteLayoutMetadata;
    }
  ): { success: boolean; frontmatter: Record<string, unknown> | null; h1Title: string | null; body: string; comments: CommentMetadataMap } => {
    const editor = editorRef.current;
    if (!editor) {
      return { success: false, frontmatter: null, h1Title: null, body: markdown, comments: {} };
    }

    // Strip frontmatter so raw YAML never renders as body text
    const fmResult = splitFrontmatter(markdown);
    markdown = fmResult.body;

    // Strip comment footer and extract metadata (before try/catch so both paths can return it)
    const footerResult = hasLegacyCommentFooter(markdown)
      ? parseCommentFooter(markdown)
      : { strippedContent: markdown, metadata: {} as CommentMetadataMap };
    const strippedContent = footerResult.strippedContent;
    const commentMetadata = options?.commentMetadata ?? footerResult.metadata;

    // Strip leading H1 from body — it lives in the dedicated title field
    const h1Result = extractLeadingH1(strippedContent);

    const normalizedBody = normalizeMarkdownForImport(h1Result.body);

    const scrollContainer = options?.scrollContainer;
    const savedScrollTop = scrollContainer?.scrollTop ?? 0;

    // Create a scroll lock that forcibly maintains position during DOM mutation
    let scrollLockActive = true;
    const lockScroll = () => {
      if (scrollLockActive && scrollContainer) {
        scrollContainer.scrollTop = savedScrollTop;
      }
    };

    try {
      // Attach listener to fight any browser scroll adjustment
      if (scrollContainer) {
        scrollContainer.addEventListener('scroll', lockScroll);
      }

      editor.update(() => {
        $addUpdateTag(SKIP_DOM_SELECTION_TAG);
        $addUpdateTag(SKIP_SCROLL_INTO_VIEW_TAG);
        if ($getSelection() !== null) {
          $setSelection(null);
        }
        const root = $getRoot();
        root.clear();
        $convertFromMarkdownString(escapeHtmlEntities(normalizedBody), MARKDOWN_EDITOR_TRANSFORMERS);
        $postImportNormalize(commentMetadata, undefined, {
          layoutMetadata: options?.layoutMetadata
        });
      }, { tag: 'agent-content-update' });

      // Release lock after DOM reconciliation (double rAF ensures paint complete)
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          scrollLockActive = false;
          if (scrollContainer) {
            scrollContainer.removeEventListener('scroll', lockScroll);
            // Final position enforcement
            scrollContainer.scrollTop = savedScrollTop;
          }
        });
      });

      if (options?.clearHistory) {
        editor.dispatchCommand(CLEAR_HISTORY_COMMAND, undefined);
      }

      return { success: true, frontmatter: fmResult.data, h1Title: h1Result.h1Title, body: h1Result.body, comments: commentMetadata };
    } catch (error) {
      scrollLockActive = false;
      if (scrollContainer) {
        scrollContainer.removeEventListener('scroll', lockScroll);
      }
      console.error('[MarkdownEditor] In-place update failed:', error);
      return { success: false, frontmatter: fmResult.data, h1Title: h1Result.h1Title, body: h1Result.body, comments: commentMetadata };
    }
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      focusStart,
      focusAtPoint,
      serializeCurrent,
      getSelectedText,
      markSelectionAsContext,
      clearContextMark,
      openSelectedImageAltTextEditor,
      updateContentFromMarkdown
    }),
    [
      focusStart,
      focusAtPoint,
      serializeCurrent,
      getSelectedText,
      markSelectionAsContext,
      clearContextMark,
      openSelectedImageAltTextEditor,
      updateContentFromMarkdown
    ]
  );

  return (
    <CurrentNoteIdContext.Provider value={noteId}>
      <LexicalComposer key={`${noteId}-${readOnly ? 'locked' : 'edit'}`} initialConfig={initialConfig}>
      <CurrentNoteIdEditorPlugin />
      <div className="relative animate-[fadeIn_150ms_ease-out]" data-lexical-editor>
        <RichTextPlugin
          contentEditable={
            <ContentEditable
              data-moss-note-editor-root="true"
              className="min-h-72 w-full whitespace-pre-wrap pt-4 focus:outline-none"
              spellCheck
              onFocus={() => {
                setRendererErrorAnalyticsContext({
                  noteId,
                  pane_id: paneId,
                  split_view: Boolean(paneId),
                  editor_mount_version: editorMountVersion,
                }, analyticsOwnerId);
              }}
              onBlur={onBlur}
            />
          }
          placeholder={<Placeholder>{placeholder ?? 'Start typing...'}</Placeholder>}
          ErrorBoundary={LexicalErrorBoundary}
        />
        <HistoryPlugin />
        {!readOnly && <SafePastePlugin />}
        {!readOnly && <UndoRedoPlugin />}
        <TableCellListNormalizationPlugin />
        <ListPlugin hasStrictIndent />
        <CheckListPlugin />
        {!readOnly && <ChecklistPreservePlugin />}
        {!readOnly && <ChecklistSortPlugin />}
        <HorizontalRulePlugin />
        <TablePlugin hasCellMerge={false} hasHorizontalScroll />
        <TableColumnLayoutPlugin />
        {!readOnly && <TableColumnResizePlugin />}
        {!readOnly && <TableActionMenuPlugin noteId={noteId} />}
        {!readOnly && <TableExitPlugin />}
        <CodeHighlighterPlugin />
        {!readOnly && <CodeNodeNormalizationPlugin />}
        {!readOnly && <AutoArrowPlugin />}
        {!readOnly && <AutoDividerPlugin />}
        <FormulaAwareMarkdownShortcutsPlugin enabled={!isFormulaDraftPillActive} />
        {!readOnly && <TabIndentPlugin />}
        {!readOnly && <ListHotkeyPlugin />}
        {!readOnly && <DoubleEmptyListExitPlugin />}
        {!readOnly && (
          <MathCalculationPlugin
            noteId={noteId}
            onDraftPillActiveChange={setIsFormulaDraftPillActive}
          />
        )}
        <FormulaPlugin noteId={noteId} />
        {!readOnly && !isFormulaDraftPillActive && <SlashCommandPlugin noteId={noteId} />}
        {!readOnly && <EmojiPickerPlugin />}
        <FileLinkPlugin onNavigateToNote={onNavigateToNote} />
        {!readOnly && <FileLinkTypeaheadPlugin />}
        {!readOnly && <AutoLinkPlugin matchers={AUTOLINK_MATCHERS} />}
        <InAppHyperlinkPlugin noteId={noteId} />
        <CommentPlugin noteId={noteId} />
        <CommentAnchorTrackerPlugin noteId={noteId} />
        {!readOnly && (
          <CommentUIWrapper
            noteId={noteId}
            paneId={paneId}
            onNavigateToNote={onNavigateToNote}
          />
        )}
        <CollapsibleHeadingPlugin noteId={noteId} />
        {enableSearchPlugin ? <SearchPlugin /> : null}
        {!readOnly && <CodeFormatBoundaryPlugin />}
        {!readOnly && <FormatWhitespaceBoundaryPlugin />}
        {!readOnly && <DecoratorBlockPlugin />}
        <CalloutControlsPlugin />
        <TabBarPlugin />
        <TabSelectionScopePlugin />
        {!readOnly && <TabExitPlugin />}
        {!readOnly && <MediaDropPlugin noteId={noteId} />}
        {!readOnly && <VideoPastePlugin />}
        {!readOnly && <ExternalImagePastePlugin />}
        {!readOnly && <WebpageEmbedPastePlugin />}
        {!readOnly && <EditorInputSamplingPlugin />}
        {!readOnly && <FocusGuardPlugin />}
        <ColorCodeConversionPlugin />
        {!readOnly && <ColorCodePlugin />}
        <EmbedPillPlugin readOnly={readOnly} />
        {!hasInitialSerializedStateProp && (
          <OnChangePlugin
            ignoreSelectionChange
            onChange={(editorState, _editor, tags) => {
              latestEditorStateRef.current = editorState;
              const normalizedTags = formatEditorUpdateTagsForAnalytics(tags);
              if (lastContentChangeTagsRef.current !== normalizedTags) {
                lastContentChangeTagsRef.current = normalizedTags;
                const importedFromDisk = tags.has('agent-content-update');
                setRendererErrorAnalyticsContext({
                  noteId,
                  pane_id: paneId,
                  split_view: Boolean(paneId),
                  editor_mount_version: editorMountVersion,
                  last_content_change_tags: normalizedTags,
                  last_markdown_import_source: importedFromDisk ? 'disk_reload' : undefined,
                  last_markdown_import_update_tag: importedFromDisk ? 'agent-content-update' : undefined,
                }, analyticsOwnerId);
              }
              onChange(editorState, tags);
            }}
          />
        )}
        {!readOnly && (
          <FloatingSelectionTools
            noteId={noteId}
            isTrashed={isTrashed}
            trashedAt={trashedAt}
            onActionClick={onActionClick}
            onSelectedImageNodeKeyChange={setSelectedImageNodeKey}
            paneId={paneId}
            editorMountVersion={editorMountVersion}
            analyticsOwnerId={analyticsOwnerId}
          />
        )}
        <EditorReadyPlugin onReady={handleEditorReady} />
        <PendingScrollPlugin noteId={noteId} />
      </div>
      {!readOnly && (
        <MediaSourceDialog
          {...mediaSourceDialogProps}
          collisionBoundary={editorRef.current?.getRootElement()?.closest('.canvas-scroll') ?? null}
        />
      )}
      </LexicalComposer>
    </CurrentNoteIdContext.Provider>
  );
});

export default MarkdownEditor;
