// ported-from: packages/desktop/src/renderer/editor/MarkdownEditor.tsx @ 762abb777 (extracted)
import { $isTextNode, type DOMConversionMap, type DOMConversionOutput, type LexicalNode, type TextFormatType, type TextNode } from 'lexical';

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

export { EDITOR_FONT_FAMILY_LABELS, HIGHLIGHT_COLOR_VARIABLES, HIGHLIGHT_YELLOW_VALUE, HIGHLIGHT_YELLOW_VAR, MARKDOWN_EDITOR_HTML_IMPORT, SERIF_FONT_FAMILY_MARKDOWN_STYLE_PATTERN, SERIF_FONT_FAMILY_STYLE, SERIF_FONT_FAMILY_VALUE, SERIF_OPTICAL_FONT_SIZE_ADJUST, STYLE_FONT_FAMILY_PROPERTY, STYLE_FONT_SIZE_ADJUST_PROPERTY, getSerifFontFamilyMarkdownStyleAttribute, highlightColorNameFromStyle, isSerifFontFamilyValue, markdownStyleAttributeHasSerifFontFamily, selectionFontFamilyFromStyleValue, setTextNodeFontFamily, unescapeInlineMarkdownText, wrapSerifFontFamilyMarkdownSpan };
export type { EditorSelectionFontFamily };
