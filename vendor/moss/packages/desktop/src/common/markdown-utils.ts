// ported-from: packages/desktop/src/common/markdown-utils.ts @ 762abb777
/**
 * Shared markdown utilities used by both main and renderer processes.
 * This is the single source of truth for H1 extraction — do NOT duplicate elsewhere.
 */

const CODE_BLOCK_RE = /(```|~~~)[\s\S]*?\1/g;
const LEADING_H1_RE = /^#(?!#)[^\S\r\n]+(.*?)(?:[^\S\r\n]+#+)?[^\S\r\n]*(?:\r?\n|$)/m;
const CODE_FENCE_RE = /^\s*(```|~~~)/;
const GFM_TABLE_SEPARATOR_RE = /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/;
// Mirror the TABS_MULTILINE_TRANSFORMER fence patterns in
// renderer/editor/MarkdownEditor.tsx so this counter stays in sync with the
// parser. `:::tabs` opens a group, a bare `:::` closes it, and `:::<word>`
// opens a nested colon block (chart/callout/sketch/etc.).
const TABS_FENCE_START_RE = /^:::\s*tabs\s*$/;
const COLON_FENCE_END_RE = /^:::\s*$/;
const COLON_BLOCK_OPEN_RE = /^:::\s*\S/;
// A `=== label` panel header inside a tab group (mirrors the transformer's
// /^===\s+(.+)$/). The parser only emits a TabGroupNode when a group has at
// least one panel header, so a header-less `:::tabs … :::` span is not counted.
const TABS_PANEL_HEADER_CAPTURE_RE = /^===\s+(.+?)\s*$/;

/**
 * Extract the first H1 heading from a markdown string.
 *
 * Returns the title text (trimmed) and the markdown body with the H1 line removed.
 * Code blocks are masked before matching so `# headings` inside fences are ignored.
 *
 * Callers that only need the title can use `.h1Title`.
 * Callers that need the stripped body (editor import pipeline) use `.body`.
 */
export function extractLeadingH1(markdown: string): { h1Title: string | null; body: string } {
  // Replace code blocks with equal-length spaces to preserve character positions
  const withoutCodeBlocks = markdown.replace(CODE_BLOCK_RE, (m) => ' '.repeat(m.length));
  const h1Match = withoutCodeBlocks.match(LEADING_H1_RE);
  if (!h1Match) return { h1Title: null, body: markdown };

  const rawTitle = h1Match[1].trim();
  if (!rawTitle) return { h1Title: null, body: markdown };

  // Use match index to slice the ORIGINAL markdown (not the sanitized version)
  const matchStart = h1Match.index!;
  const matchEnd = matchStart + h1Match[0].length;
  const before = markdown.slice(0, matchStart);
  const after = markdown.slice(matchEnd);
  const body = (
    before.endsWith('\n') ? before + after.replace(/^\r?\n/, '') : before + after
  ).replace(/^\n+/, '');

  return { h1Title: rawTitle, body };
}

/**
 * Count GFM tables in a markdown string by detecting the `| --- | --- |`
 * separator line that immediately follows a header row. Lines inside fenced
 * code blocks are ignored.
 */
export function countMarkdownTables(markdown: string): number {
  if (!markdown) return 0;
  const lines = markdown.split('\n');
  let count = 0;
  let inFence = false;
  let fenceMarker: string | null = null;
  let prevNonFenceLine = '';

  for (const rawLine of lines) {
    const fenceMatch = rawLine.match(CODE_FENCE_RE);
    if (fenceMatch) {
      if (!inFence) {
        inFence = true;
        fenceMarker = fenceMatch[1];
      } else if (fenceMatch[1] === fenceMarker) {
        inFence = false;
        fenceMarker = null;
      }
      prevNonFenceLine = '';
      continue;
    }

    if (inFence) {
      continue;
    }

    if (
      GFM_TABLE_SEPARATOR_RE.test(rawLine) &&
      prevNonFenceLine.includes('|') &&
      prevNonFenceLine.trim().length > 0
    ) {
      count += 1;
    }
    prevNonFenceLine = rawLine;
  }

  return count;
}

/**
 * Count `:::tabs … :::` tab groups in a markdown string so the count matches the
 * TabGroupNodes the editor actually materializes.
 *
 * Only a top-level `:::tabs` becomes a TabGroupNode: panel content is parsed
 * with the TabGroupNode transformer excluded, so nested `:::tabs` spans are
 * swallowed as content rather than counted as nodes.
 */
export interface MarkdownTabGroupShape {
  panelLabels: string[];
}

export function getMarkdownTabGroupShapes(markdown: string): MarkdownTabGroupShape[] {
  if (!markdown) return [];
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const groups: MarkdownTabGroupShape[] = [];
  let inFence = false;
  let fenceMarker: string | null = null;
  const stack: {
    topLevelTabs: boolean;
    sawHeader: boolean;
    refused: boolean;
    panelLabels: string[];
  }[] = [];

  for (const rawLine of lines) {
    const fenceMatch = rawLine.match(CODE_FENCE_RE);
    if (fenceMatch) {
      if (!inFence) {
        inFence = true;
        fenceMarker = fenceMatch[1];
      } else if (fenceMatch[1] === fenceMarker) {
        inFence = false;
        fenceMarker = null;
      }
      continue;
    }

    if (inFence) {
      continue;
    }

    if (COLON_BLOCK_OPEN_RE.test(rawLine)) {
      if (stack.length === 1 && stack[0].topLevelTabs && !stack[0].sawHeader) {
        stack[0].refused = true;
      }
      stack.push({
        topLevelTabs: stack.length === 0 && TABS_FENCE_START_RE.test(rawLine),
        sawHeader: false,
        refused: false,
        panelLabels: []
      });
      continue;
    }

    if (COLON_FENCE_END_RE.test(rawLine)) {
      const frame = stack.pop();
      if (frame && frame.topLevelTabs && frame.sawHeader && !frame.refused) {
        groups.push({ panelLabels: frame.panelLabels });
      }
      continue;
    }

    if (stack.length === 1 && stack[0].topLevelTabs) {
      const frame = stack[0];
      const headerMatch = rawLine.match(TABS_PANEL_HEADER_CAPTURE_RE);
      if (headerMatch) {
        frame.sawHeader = true;
        frame.panelLabels.push(headerMatch[1].trim());
      } else if (!frame.sawHeader && rawLine.trim() !== '') {
        frame.refused = true;
      }
    }
  }

  return groups;
}

export function countMarkdownTabGroups(markdown: string): number {
  return getMarkdownTabGroupShapes(markdown).length;
}
