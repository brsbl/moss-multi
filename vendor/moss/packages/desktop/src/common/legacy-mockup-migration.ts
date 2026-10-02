// ported-from: packages/desktop/src/common/legacy-mockup-migration.ts @ 762abb777
import {
  buildFencedCodeBlock,
  isMarkdownClosingFence,
  parseMarkdownOpeningFence,
  type MarkdownFenceState
} from './markdown-fences';

export interface LegacyMockupMigrationResult {
  markdown: string;
  warnings: string[];
  changed: boolean;
}

export type MockupHtmlFetcher = (assetsRelativePath: string) => Promise<string | null>;

export function buildMossHtmlFenceForMigration(
  rawHtml: string
): string {
  return buildFencedCodeBlock({ rawContent: rawHtml, info: 'moss-html' });
}

// Matches `![alt](assets/<name>-mockup.png)` image references. The alt text
// may be empty. The `assets/` prefix is required because migration only targets
// note-local legacy mockups. The name is permissive (anything except `)` or
// path separators) so user-renamed mockups with spaces or unicode still match.
const MOCKUP_IMAGE_RE = /!\[([^\]]*)\]\(assets\/([^/)]+?)-mockup\.png\)/;

// Comment markers wrap the mockup image. Format: `%%m:<id>:start%% ... %%m:<id>:end%%`
const COMMENT_START_RE = /%%m:[^:]+:start%%/g;
const COMMENT_END_RE = /%%m:[^:]+:end%%/g;

/**
 * Return true if the line is inside a list item, blockquote, or indented-code
 * context. The migration skips these so we don't break nested Markdown.
 *
 * Uses CommonMark's 4-space threshold for "indented code block". Shorter
 * indents can still be list continuations after a list starts, so the caller
 * passes container context while scanning.
 */
function lineStartsListContext(line: string): boolean {
  return /^ {0,3}(?:[-*+]|\d+[.)])\s/.test(line);
}

function lineStartsBlockquoteContext(line: string): boolean {
  return /^ {0,3}>/.test(line);
}

function lineLooksLikeIndentedContinuation(line: string): boolean {
  return /^ {1,3}\S/.test(line);
}

function lineIsNested(
  line: string,
  context: { activeList: boolean; activeBlockquote: boolean } = {
    activeList: false,
    activeBlockquote: false
  }
): boolean {
  if (line.length === 0) return false;
  if (/^\t/.test(line)) return true; // Tab indent = indented code / list continuation
  if (/^ {4,}/.test(line)) return true; // 4+ spaces = indented code block
  if (lineStartsListContext(line)) return true; // List markers (with optional leading spaces)
  if (lineStartsBlockquoteContext(line)) return true; // Blockquote
  if (context.activeList && lineLooksLikeIndentedContinuation(line)) return true;
  if (context.activeBlockquote && line.trim().length > 0) return true;
  return false;
}

function findClosingBacktickRun(
  line: string,
  startIndex: number,
  tickCount: number
): number {
  for (let i = startIndex; i < line.length; i += 1) {
    if (line.charCodeAt(i) !== 96) continue;

    let runLength = 1;
    while (i + runLength < line.length && line.charCodeAt(i + runLength) === 96) {
      runLength += 1;
    }

    const previousIsBacktick = i > 0 && line.charCodeAt(i - 1) === 96;
    const nextIsBacktick =
      i + runLength < line.length && line.charCodeAt(i + runLength) === 96;
    if (runLength === tickCount && !previousIsBacktick && !nextIsBacktick) {
      return i;
    }

    i += runLength - 1;
  }

  return -1;
}

function maskInlineCodeSpans(line: string): string {
  if (!line.includes('`')) return line;

  const masked = line.split('');
  for (let i = 0; i < line.length; i += 1) {
    if (line.charCodeAt(i) !== 96) continue;

    let tickCount = 1;
    while (i + tickCount < line.length && line.charCodeAt(i + tickCount) === 96) {
      tickCount += 1;
    }

    const closingIndex = findClosingBacktickRun(line, i + tickCount, tickCount);
    if (closingIndex === -1) {
      i += tickCount - 1;
      continue;
    }

    for (let j = i; j < closingIndex + tickCount; j += 1) {
      masked[j] = ' ';
    }

    i = closingIndex + tickCount - 1;
  }

  return masked.join('');
}

/**
 * Run migration across the markdown. For each legacy mockup ref, fetch the
 * paired HTML via `fetchHtml(assetsRelativePath)`, then rewrite the ref and
 * surrounding comment markers to a moss-html fence.
 */
export async function migrateLegacyMockupRefs(
  markdown: string,
  fetchHtml: MockupHtmlFetcher
): Promise<LegacyMockupMigrationResult> {
  if (!markdown.includes('-mockup.png')) {
    return { markdown, warnings: [], changed: false };
  }

  const lines = markdown.split('\n');
  const warnings: string[] = [];
  let changed = false;
  let activeFence: MarkdownFenceState | null = null;
  let activeListContext = false;
  let activeBlockquoteContext = false;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (activeFence !== null) {
      if (isMarkdownClosingFence(line, activeFence)) {
        activeFence = null;
      }
      continue;
    }

    if (line.trim().length === 0) {
      activeBlockquoteContext = false;
      continue;
    }

    const openingFence = parseMarkdownOpeningFence(line);
    if (openingFence !== null) {
      activeFence = openingFence;
      if (!lineLooksLikeIndentedContinuation(line)) {
        activeListContext = false;
        activeBlockquoteContext = false;
      }
      continue;
    }

    const startsListContext = lineStartsListContext(line);
    const startsBlockquoteContext = lineStartsBlockquoteContext(line);
    const isIndentedContinuation = lineLooksLikeIndentedContinuation(line);
    const isNested = lineIsNested(line, {
      activeList: activeListContext,
      activeBlockquote: activeBlockquoteContext
    });

    if (startsListContext) {
      activeListContext = true;
    } else if (activeListContext && !isIndentedContinuation && !lineIsNested(line)) {
      activeListContext = false;
    }

    if (startsBlockquoteContext || (activeBlockquoteContext && line.trim().length > 0)) {
      activeBlockquoteContext = true;
    }

    const searchableLine = maskInlineCodeSpans(line);
    if (!searchableLine.includes('-mockup.png')) continue;

    const imgMatch = searchableLine.match(MOCKUP_IMAGE_RE);
    if (!imgMatch) continue;

    if (isNested) {
      warnings.push(
        `[legacy-mockup-migration] skipping nested mockup ref at line ${i + 1}: ${line.trim()}`
      );
      continue;
    }

    const startMarkers = [...line.matchAll(COMMENT_START_RE)].map((m) => m[0]);
    const endMarkers = [...line.matchAll(COMMENT_END_RE)].map((m) => m[0]);
    if (startMarkers.length !== endMarkers.length) {
      warnings.push(
        `[legacy-mockup-migration] skipping mockup ref with mismatched comment markers at line ${i + 1}`
      );
      continue;
    }

    const imageName = imgMatch[2];
    const htmlRelativePath = `assets/${imageName}-mockup.html`;

    let html: string | null;
    try {
      html = await fetchHtml(htmlRelativePath);
    } catch (err) {
      warnings.push(
        `[legacy-mockup-migration] failed to read ${htmlRelativePath}: ${(err as Error).message}`
      );
      continue;
    }

    if (html === null) {
      // No sibling .html file - can't migrate. Warn so the user has traceability;
      // the rendered note will show the PNG as a plain image.
      warnings.push(
        `[legacy-mockup-migration] no sibling HTML for ${htmlRelativePath} at line ${i + 1}; rendering PNG as plain image`
      );
      continue;
    }

    const fence = buildMossHtmlFenceForMigration(html);

    // Preserve surrounding comment markers on their own lines around the
    // generated fence so block comments still anchor correctly.
    const prefix = line.slice(0, imgMatch.index);
    const suffix = line.slice(imgMatch.index! + imgMatch[0].length);

    const prefixTrim = prefix.trim();
    const suffixTrim = suffix.trim();

    const replacementLines: string[] = [];
    if (prefixTrim.length > 0) replacementLines.push(prefixTrim);
    replacementLines.push(...fence.split('\n'));
    if (suffixTrim.length > 0) replacementLines.push(suffixTrim);

    lines.splice(i, 1, ...replacementLines);
    changed = true;
    // Advance past the inserted fence, but let a suffix line be scanned. A
    // top-level line can contain multiple legacy refs.
    i += suffixTrim.length > 0 ? replacementLines.length - 2 : replacementLines.length - 1;
  }

  return {
    markdown: changed ? lines.join('\n') : markdown,
    warnings,
    changed
  };
}
