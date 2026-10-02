// ported-from: packages/desktop/src/common/markdown-fences.ts @ 762abb777
export interface MarkdownFenceState {
  marker: '`' | '~';
  length: number;
}

export const MOSS_CANVAS_FENCE_NAME = 'moss-canvas';
export const MOSS_LEGACY_SKETCH_FENCE_NAME = 'moss-sketch';
export const MOSS_CANVAS_FENCE_NAMES = [
  MOSS_CANVAS_FENCE_NAME,
  MOSS_LEGACY_SKETCH_FENCE_NAME
] as const;
export type MossCanvasFenceName = (typeof MOSS_CANVAS_FENCE_NAMES)[number];

export const MOSS_CANVAS_SLASH_COMMAND_ID = 'canvas';
export const MOSS_CANVAS_SLASH_ALIASES = [
  MOSS_CANVAS_SLASH_COMMAND_ID,
  'sketch',
  'diagram',
  'flow',
  'wireframe',
  'whiteboard'
] as const;

const escapeRegExpLiteral = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const MOSS_CANVAS_FENCE_PATTERN_SOURCE = MOSS_CANVAS_FENCE_NAMES
  .map(escapeRegExpLiteral)
  .join('|');

export const isMossCanvasFenceName = (
  value: string | null | undefined
): value is MossCanvasFenceName =>
  MOSS_CANVAS_FENCE_NAMES.includes(value as MossCanvasFenceName);

export interface MossHtmlFenceBlock {
  headerLineIndex: number;
  closingLineIndex: number;
  indent: string;
  fenceLength: number;
  headerOptions?: string;
  rawHtml: string;
}

export type MossHtmlFenceScanItem =
  | { kind: 'block'; block: MossHtmlFenceBlock }
  | { kind: 'unterminated'; headerLineIndex: number };

export const resolveMarkdownFenceLength = (
  rawContent: string,
  minimumFenceLength = 3,
  marker: '`' | '~' = '`'
): number => {
  const markerCode = marker.charCodeAt(0);
  let longestRun = 0;
  let currentRun = 0;

  for (let i = 0; i < rawContent.length; i += 1) {
    if (rawContent.charCodeAt(i) === markerCode) {
      currentRun += 1;
      if (currentRun > longestRun) {
        longestRun = currentRun;
      }
    } else {
      currentRun = 0;
    }
  }

  return Math.max(minimumFenceLength, Math.max(3, longestRun + 1));
};

export const buildMarkdownFence = (
  rawContent: string,
  minimumFenceLength = 3,
  marker: '`' | '~' = '`'
): string => marker.repeat(resolveMarkdownFenceLength(rawContent, minimumFenceLength, marker));

export const buildFencedCodeBlock = ({
  rawContent,
  info,
  minimumFenceLength = 3,
  indent = '',
  marker = '`'
}: {
  rawContent: string;
  info: string;
  minimumFenceLength?: number;
  indent?: string;
  marker?: '`' | '~';
}): string => {
  const fence = buildMarkdownFence(rawContent, minimumFenceLength, marker);
  return `${indent}${fence}${info}\n${rawContent}\n${indent}${fence}`;
};

const stripTrailingCarriageReturn = (line: string): string =>
  line.endsWith('\r') ? line.slice(0, -1) : line;

export const parseMarkdownOpeningFence = (line: string): MarkdownFenceState | null => {
  const normalizedLine = stripTrailingCarriageReturn(line);
  const match = normalizedLine.match(/^( {0,3})(`{3,}|~{3,})(.*)$/);
  if (!match) return null;

  const run = match[2];
  if (run.startsWith('`') && match[3].includes('`')) {
    return null;
  }

  return {
    marker: run[0] as '`' | '~',
    length: run.length
  };
};

export const isMarkdownClosingFence = (
  line: string,
  activeFence: MarkdownFenceState
): boolean => {
  const normalizedLine = stripTrailingCarriageReturn(line);
  const match = normalizedLine.match(/^( {0,3})(`{3,}|~{3,})([ \t]*)$/);
  if (!match) return false;

  const run = match[2];
  return run[0] === activeFence.marker && run.length >= activeFence.length;
};

const MOSS_HTML_FENCE_HEADER_RE = /^( {0,3})(`{3,})moss-html(?:\s+(.*))?$/;

const findClosingFenceLine = (
  lines: string[],
  startLineIndex: number,
  activeFence: MarkdownFenceState
): number => {
  for (let i = startLineIndex; i < lines.length; i += 1) {
    if (isMarkdownClosingFence(lines[i] ?? '', activeFence)) {
      return i;
    }
  }
  return -1;
};

export function* scanMossHtmlFenceBlocks(
  lines: string[]
): Generator<MossHtmlFenceScanItem> {
  let activeFence: MarkdownFenceState | null = null;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';

    if (activeFence !== null) {
      if (isMarkdownClosingFence(line, activeFence)) {
        activeFence = null;
      }
      continue;
    }

    const mossHtmlHeaderMatch = line.match(MOSS_HTML_FENCE_HEADER_RE);
    if (mossHtmlHeaderMatch) {
      const indent = mossHtmlHeaderMatch[1] ?? '';
      const fenceLength = mossHtmlHeaderMatch[2]?.length ?? 3;
      const closingLineIndex = findClosingFenceLine(lines, i + 1, {
        marker: '`',
        length: fenceLength
      });

      if (closingLineIndex === -1) {
        yield { kind: 'unterminated', headerLineIndex: i };
        return;
      }

      yield {
        kind: 'block',
        block: {
          headerLineIndex: i,
          closingLineIndex,
          indent,
          fenceLength,
          headerOptions: mossHtmlHeaderMatch[3],
          rawHtml: lines.slice(i + 1, closingLineIndex).join('\n')
        }
      };

      i = closingLineIndex;
      continue;
    }

    const openingFence = parseMarkdownOpeningFence(line);
    if (openingFence !== null) {
      activeFence = openingFence;
    }
  }
}
