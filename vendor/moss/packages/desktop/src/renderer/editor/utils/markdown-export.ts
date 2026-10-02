// ported-from: packages/desktop/src/renderer/editor/utils/markdown-export.ts @ 762abb777
/**
 * Strips Moss-specific syntax from serialized markdown, producing clean
 * portable markdown suitable for export.
 *
 * Transformations (applied in order):
 * - Comment anchors -> text
 * - Comment footer <!--moss:comments ... --> -> removed
 * - Wiki-links [[Title|uuid]] -> Title, [[Title|alias]] -> alias
 * - Wiki-links [[Title]] -> Title, [[#Heading]] -> Heading
 * - Formulas {{expr|result|meta}} -> result
 * - moss-chart / moss-canvas / moss-sketch code blocks -> removed
 */

import { MOSS_CANVAS_FENCE_PATTERN_SOURCE } from '../../../common/markdown-fences';

const UUID_PATTERN =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

// {%c:id1,id2%}text{%/c%} -> text
// %%m:id1,id2:start%%text%%m:id1,id2:end%% -> text
const COMMENT_MARKERS_RE =
  /(?:\{%c:[^%]+%\}|%%m:[^%]+:start%%)([\s\S]*?)(?:\{%\/c%\}|%%m:[^%]+:end%%)/g;

// <!--moss:comments\n{...}\n--> at end of file (consume preceding blank lines)
const COMMENT_FOOTER_RE = /\n*<!--moss:comments\n[\s\S]*?-->\s*$/;

// <!-- moss-table-column-widths: 120, 240, 360 -->
const TABLE_WIDTH_COMMENT_RE = /^<!--\s*moss-table-column-widths:\s*[\d.,\s]+\s*-->\n?/gm;

// [[content|suffix]] — wiki-link with pipe
const WIKI_LINK_PIPE_RE = /\[\[([^\]|]+)\|([^\]]+)\]\]/g;

// [[content]] — wiki-link without pipe
const WIKI_LINK_PLAIN_RE = /\[\[([^\]]+)\]\]/g;

// {{expr|result}} or {{expr|result|metadata}} -> result
const FORMULA_RE = /\{\{[^{}|]+\|([^{}|]+)(?:\|[^{}]*)?\}\}/g;

// Moss chart, canvas, legacy sketch, and video fences.
const MOSS_CODE_BLOCK_RE = new RegExp(
  '```(?:moss-chart|moss-video|' +
    MOSS_CANVAS_FENCE_PATTERN_SOURCE +
    ')\\b[^\\n]*\\n[\\s\\S]*?```\\n?',
  'g'
);

export function stripMossSyntax(markdown: string): string {
  // 1. Remove Moss custom blocks first (they ARE code fences, so must
  //    be stripped before we split by fences to protect other code blocks).
  let cleaned = markdown.replace(MOSS_CODE_BLOCK_RE, '');

  // 2. Split into alternating [outside, fence, outside, fence, ...] segments
  //    to avoid stripping Moss syntax inside code blocks.
  const segments = splitByCodeFences(cleaned);
  const result = segments
    .map((seg, i) => (i % 2 === 0 ? stripMossSyntaxInSegment(seg) : seg))
    .join('');

  return result.replace(/\s+$/, '');
}

export function stripTableColumnWidthComments(markdown: string): string {
  TABLE_WIDTH_COMMENT_RE.lastIndex = 0;
  if (!TABLE_WIDTH_COMMENT_RE.test(markdown)) {
    return markdown;
  }
  TABLE_WIDTH_COMMENT_RE.lastIndex = 0;
  const hadTrailingNewline = markdown.endsWith('\n');
  const cleaned = splitByCodeFences(markdown)
    .map((seg, i) => (i % 2 === 0 ? seg.replace(TABLE_WIDTH_COMMENT_RE, '') : seg))
    .join('');
  return hadTrailingNewline ? cleaned : cleaned.replace(/\n$/, '');
}

/** Split markdown into alternating non-fence / fence segments. */
function splitByCodeFences(markdown: string): string[] {
  const segments: string[] = [];
  let current = '';
  let fenceChar: string | null = null;
  let fenceLen = 0;

  for (const line of markdown.split('\n')) {
    const trimmed = line.trimStart();
    if (fenceChar === null) {
      // Not inside a fence — check for opening
      const match = trimmed.match(/^(`{3,}|~{3,})/);
      if (match) {
        segments.push(current);
        current = line + '\n';
        fenceChar = match[1][0];
        fenceLen = match[1].length;
      } else {
        current += line + '\n';
      }
    } else {
      // Inside a fence — check for closing
      current += line + '\n';
      const match = trimmed.match(/^(`{3,}|~{3,})\s*$/);
      if (match && match[1][0] === fenceChar && match[1].length >= fenceLen) {
        segments.push(current);
        current = '';
        fenceChar = null;
        fenceLen = 0;
      }
    }
  }
  // Remaining content (unclosed fence or trailing non-fence text)
  if (current) segments.push(current);
  return segments;
}

/** Apply Moss syntax stripping to a non-fence segment. */
function stripMossSyntaxInSegment(segment: string): string {
  let result = segment;

  // 1. Strip comment markers (keep annotated text)
  result = result.replace(COMMENT_MARKERS_RE, '$1');

  // 2. Remove comment footer
  result = result.replace(COMMENT_FOOTER_RE, '');

  // 2b. Remove persisted table width metadata comments
  result = result.replace(TABLE_WIDTH_COMMENT_RE, '');

  // 3. Wiki-links with pipe — disambiguate UUID vs alias
  result = result.replace(WIKI_LINK_PIPE_RE, (_match, content: string, suffix: string) => {
    if (UUID_PATTERN.test(suffix)) {
      return content.includes('#')
        ? content.replace('#', ' > ')
        : content;
    }
    return suffix;
  });

  // 4. Wiki-links without pipe
  result = result.replace(WIKI_LINK_PLAIN_RE, (_match, content: string) => {
    if (content.startsWith('#')) {
      return content.slice(1);
    }
    return content;
  });

  // 5. Formulas -> result value
  result = result.replace(FORMULA_RE, '$1');

  return result;
}
