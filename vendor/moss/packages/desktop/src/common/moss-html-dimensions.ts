// ported-from: packages/desktop/src/common/moss-html-dimensions.ts @ 762abb777
/**
 * Shared moss-html sizing utilities.
 *
 * Saved HTML can declare its intrinsic size. Moss then constrains how that
 * intrinsic size is displayed in note view and fullscreen.
 */

export const DEFAULT_MOSS_HTML_WIDTH = 1200;
export const DEFAULT_MOSS_HTML_HEIGHT = 900;
export const MOSS_HTML_NOTE_MEDIUM_WIDTH = 1200;
export const MOSS_HTML_NOTE_MEDIUM_HEIGHT = 900;
export const MOSS_HTML_NOTE_SMALL_WIDTH = 600;
export const MOSS_HTML_NOTE_SMALL_HEIGHT = 450;
export const MOSS_HTML_NOTE_SMALL_BREAKPOINT = 760;
export const MOSS_HTML_NOTE_MAX_HEIGHT = 720;
export const MOSS_HTML_FULLSCREEN_PADDING = 24;
export const MOSS_HTML_FULLSCREEN_FIT_OVERFLOW_RATIO = 1.25;

export interface MossHtmlIntrinsicSize {
  width: number;
  height: number;
  hasExplicitWidth: boolean;
  hasExplicitHeight: boolean;
  heightSource: 'height' | 'min-height' | 'default';
}

export interface MossHtmlDisplaySize {
  width: number;
  height: number;
  scale: number;
}

export interface MossHtmlFullscreenDisplaySize extends MossHtmlDisplaySize {
  mode: 'fit' | 'scroll';
  viewportWidth: number;
  viewportHeight: number;
}

export interface MossHtmlDisplayBounds {
  maxWidth?: number;
  maxHeight?: number;
  allowUpscale?: boolean;
}

const STYLE_TAG_RE = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;
const CSS_RULE_RE = /([^{}]+)\{([^{}]+)\}/g;
const BODY_STYLE_ATTR_RE = /<body\b[^>]*\bstyle=(["'])([\s\S]*?)\1/i;
const HTML_STYLE_ATTR_RE = /<html\b[^>]*\bstyle=(["'])([\s\S]*?)\1/i;

const selectorTargetsTag = (selector: string, tag: 'html' | 'body'): boolean =>
  new RegExp(`(^|[\\s>+~,])${tag}(?=($|[\\s>+~.#:[,]))`, 'i').test(selector.trim());

const extractTagStyleDeclarations = (
  rawHtml: string,
  tag: 'html' | 'body'
): string[] => {
  const declarations: string[] = [];

  for (const match of rawHtml.matchAll(STYLE_TAG_RE)) {
    const css = match[1] ?? '';
    CSS_RULE_RE.lastIndex = 0;
    let ruleMatch: RegExpExecArray | null;
    while ((ruleMatch = CSS_RULE_RE.exec(css)) !== null) {
      const selectors = (ruleMatch[1] ?? '').split(',');
      if (selectors.some((selector) => selectorTargetsTag(selector, tag))) {
        declarations.push(ruleMatch[2] ?? '');
      }
    }
  }

  const inlineStyle = (tag === 'body'
    ? rawHtml.match(BODY_STYLE_ATTR_RE)?.[2]
    : rawHtml.match(HTML_STYLE_ATTR_RE)?.[2])?.trim();
  if (inlineStyle) {
    declarations.push(inlineStyle);
  }

  return declarations;
};

const readLastPixelDeclaration = (
  declarations: string[],
  property: 'width' | 'height' | 'min-height'
): number | null => {
  let value: number | null = null;
  const propertyPattern = property.replace('-', '\\s*-\\s*');
  const regex = new RegExp(
    `(?:^|;)\\s*${propertyPattern}\\s*:\\s*(\\d+(?:\\.\\d+)?)px\\b`,
    'gi'
  );

  for (const declarationBlock of declarations) {
    let match: RegExpExecArray | null;
    while ((match = regex.exec(declarationBlock)) !== null) {
      const nextValue = Number.parseFloat(match[1] ?? '');
      if (Number.isFinite(nextValue) && nextValue > 0) {
        value = nextValue;
      }
    }
    regex.lastIndex = 0;
  }

  return value;
};

export function resolveMossHtmlIntrinsicSize(
  rawHtml: string
): MossHtmlIntrinsicSize {
  const htmlDeclarations = extractTagStyleDeclarations(rawHtml, 'html');
  const bodyDeclarations = extractTagStyleDeclarations(rawHtml, 'body');

  const explicitWidth =
    readLastPixelDeclaration(bodyDeclarations, 'width') ??
    readLastPixelDeclaration(htmlDeclarations, 'width');
  const bodyHeight = readLastPixelDeclaration(bodyDeclarations, 'height');
  const bodyMinHeight = readLastPixelDeclaration(bodyDeclarations, 'min-height');
  const htmlHeight = readLastPixelDeclaration(htmlDeclarations, 'height');
  const htmlMinHeight = readLastPixelDeclaration(htmlDeclarations, 'min-height');
  const explicitHeight = bodyHeight ?? bodyMinHeight ?? htmlHeight ?? htmlMinHeight;
  const heightSource = bodyHeight !== null
    ? 'height'
    : bodyMinHeight !== null
      ? 'min-height'
      : htmlHeight !== null
        ? 'height'
        : htmlMinHeight !== null
          ? 'min-height'
          : 'default';

  return {
    width: explicitWidth ?? DEFAULT_MOSS_HTML_WIDTH,
    height: explicitHeight ?? DEFAULT_MOSS_HTML_HEIGHT,
    hasExplicitWidth: explicitWidth !== null,
    hasExplicitHeight: explicitHeight !== null,
    heightSource
  };
}

export function hasExplicitMossHtmlIntrinsicSize(
  intrinsicSize: Pick<MossHtmlIntrinsicSize, 'hasExplicitWidth' | 'hasExplicitHeight'>
): boolean {
  return intrinsicSize.hasExplicitWidth || intrinsicSize.hasExplicitHeight;
}

export function fitMossHtmlSizeWithinBounds(
  intrinsic: Pick<MossHtmlIntrinsicSize, 'width' | 'height'>,
  bounds: MossHtmlDisplayBounds = {}
): MossHtmlDisplaySize {
  const maxWidth = bounds.maxWidth ?? Number.POSITIVE_INFINITY;
  const maxHeight = bounds.maxHeight ?? Number.POSITIVE_INFINITY;
  const allowUpscale = bounds.allowUpscale ?? false;

  const widthScale = maxWidth / intrinsic.width;
  const heightScale = maxHeight / intrinsic.height;
  const rawScale = Math.min(widthScale, heightScale);
  const scale = allowUpscale ? rawScale : Math.min(rawScale, 1);

  return {
    width: Math.max(1, Math.round(intrinsic.width * scale)),
    height: Math.max(1, Math.round(intrinsic.height * scale)),
    scale
  };
}

export function resolveMossHtmlNoteDisplaySize(
  options: {
    availableWidth?: number | null;
    intrinsicSize?: Pick<MossHtmlIntrinsicSize, 'width' | 'height'>;
  } = {}
): MossHtmlDisplaySize {
  const availableWidth = options.availableWidth;
  const hasAvailableWidth =
    typeof availableWidth === 'number' && Number.isFinite(availableWidth) && availableWidth > 0;
  const intrinsicSize = options.intrinsicSize ?? {
    width: MOSS_HTML_NOTE_MEDIUM_WIDTH,
    height: MOSS_HTML_NOTE_MEDIUM_HEIGHT
  };
  const maxFrameWidth = hasAvailableWidth && availableWidth < MOSS_HTML_NOTE_SMALL_BREAKPOINT
    ? MOSS_HTML_NOTE_SMALL_WIDTH
    : MOSS_HTML_NOTE_MEDIUM_WIDTH;
  const maxWidth = hasAvailableWidth ? Math.min(availableWidth, maxFrameWidth) : maxFrameWidth;

  const fittedSize = fitMossHtmlSizeWithinBounds(intrinsicSize, {
    maxWidth
  });

  return {
    ...fittedSize,
    height: Math.min(fittedSize.height, MOSS_HTML_NOTE_MAX_HEIGHT)
  };
}

export function resolveMossHtmlFullscreenDisplaySize({
  intrinsicSize,
  availableWidth,
  availableHeight
}: {
  intrinsicSize: Pick<MossHtmlIntrinsicSize, 'width' | 'height'>;
  availableWidth: number;
  availableHeight: number;
}): MossHtmlFullscreenDisplaySize {
  const maxWidth = Math.max(1, availableWidth);
  const maxHeight = Math.max(1, availableHeight);
  const canFitWithModestScale =
    intrinsicSize.width <= maxWidth * MOSS_HTML_FULLSCREEN_FIT_OVERFLOW_RATIO &&
    intrinsicSize.height <= maxHeight * MOSS_HTML_FULLSCREEN_FIT_OVERFLOW_RATIO;

  if (canFitWithModestScale) {
    const fittedSize = fitMossHtmlSizeWithinBounds(intrinsicSize, {
      maxWidth,
      maxHeight
    });

    return {
      width: fittedSize.width,
      height: fittedSize.height,
      scale: fittedSize.scale,
      mode: 'fit',
      viewportWidth: intrinsicSize.width,
      viewportHeight: intrinsicSize.height
    };
  }

  return {
    width: Math.min(intrinsicSize.width, maxWidth),
    height: Math.min(intrinsicSize.height, maxHeight),
    scale: 1,
    mode: 'scroll',
    viewportWidth: intrinsicSize.width,
    viewportHeight: intrinsicSize.height
  };
}
