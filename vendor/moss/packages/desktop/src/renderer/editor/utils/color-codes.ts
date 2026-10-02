// ported-from: packages/desktop/src/renderer/editor/utils/color-codes.ts @ 762abb777
/**
 * Shared color-literal primitives reused by:
 *  - The prose inline `ColorCodeNode`/`ColorCodePlugin` pipeline
 *
 * Keeping all color parsing, geometry, and presentation tokens here ensures
 * prose pills stay coherent (same regexes, same swatch tokens, same
 * theme-aware fills).
 */

/**
 * Hex literal body lengths Moss turns into a color pill/preview: only the
 * canonical 6-digit `#rrggbb` form. Hex-like strings with 3, 4, 7, or 8 digits
 * stay plain text, so issue/PR-style refs (a hash plus a few digits) and longer
 * hex runs are never interpreted as colors. Functional rgb / rgba / hsl / hsla
 * parsing is unaffected.
 *
 * Single source of truth — every hex regex below derives from this list.
 */
export const HEX_VALID_LENGTHS = [6] as const;
export const HEX_MAX_LENGTH = 6;
const HEX_LIVE_MIN_COMPLETE_LENGTH = 6;

const HEX_BODY = `(?:${[...HEX_VALID_LENGTHS]
  .sort((a, b) => b - a)
  .map((n) => `[0-9a-fA-F]{${n}}`)
  .join('|')})`;
const RGB_BODY = 'rgba?\\(\\s*\\d+\\s*,\\s*\\d+\\s*,\\s*\\d+(?:\\s*,\\s*(?:0|1|0?\\.\\d+))?\\s*\\)';
const HSL_BODY = 'hsla?\\(\\s*\\d+\\s*,\\s*\\d+%\\s*,\\s*\\d+%(?:\\s*,\\s*(?:0|1|0?\\.\\d+))?\\s*\\)';

/**
 * The only character-level color starts Moss accepts:
 *  - `#` followed by parser-valid hex digits
 *  - `rgb(`/`rgba(`
 *  - `hsl(`/`hsla(`
 *
 * CSS named words intentionally do not participate in matching. They do not
 * have an explicit color-start character, so matching them feels like text
 * randomly turning into a pill.
 */
const FUNCTIONAL_PATTERN_BODY = `#${HEX_BODY}\\b|${RGB_BODY}|${HSL_BODY}`;

/**
 * Full pattern body matching every color literal Moss turns into UI.
 */
export const COLOR_PATTERN_BODY = FUNCTIONAL_PATTERN_BODY;

/** Global regex over a string – iterate with `matchAll`. */
export const COLOR_REGEX_GLOBAL = new RegExp(COLOR_PATTERN_BODY, 'gi');

/** Anchored regex to check if an exact string is a complete color literal. */
export const COLOR_COMPLETE_ANCHORED = new RegExp(`^(?:${COLOR_PATTERN_BODY})$`, 'i');

/**
 * Live-typing regex (anchored at end) used by the markdown text-match
 * transformer's trigger path. Captures the matched literal in group 1.
 * Functional/hex-only — see `FUNCTIONAL_PATTERN_BODY` for the rationale.
 */
export const COLOR_TRANSFORMER_REGEXP = new RegExp(`(${FUNCTIONAL_PATTERN_BODY})$`);

/**
 * Import-time regex (not end-anchored) used by the markdown transformer's
 * `importRegExp`. Captures the matched literal in group 1. Functional/hex-only
 * — see `FUNCTIONAL_PATTERN_BODY` for the rationale.
 */
export const COLOR_TRANSFORMER_IMPORT_REGEXP = new RegExp(
  `(${FUNCTIONAL_PATTERN_BODY})`
);

/**
 * Resolves an arbitrary color string into a CSS color (the browser's parsed
 * function-form representation) via a probe element. Returns '' for
 * unparseable input. Pass a reused probe for tight loops.
 */
export function parseColorString(value: string, probe?: HTMLElement): string {
  if (typeof document === 'undefined') return '';
  const el = probe ?? document.createElement('div');
  el.style.backgroundColor = '';
  el.style.backgroundColor = value;
  if (!el.style.backgroundColor) return '';
  return el.style.backgroundColor;
}

export interface CompleteColorMatch {
  /** Start index of the match in the input string. */
  start: number;
  /** End index (exclusive) of the match in the input string. */
  end: number;
  /** The raw color literal text. */
  value: string;
}

const isEscapedBacktick = (text: string, index: number): boolean => {
  let slashCount = 0;
  let cursor = index - 1;
  while (cursor >= 0 && text[cursor] === '\\') {
    slashCount += 1;
    cursor -= 1;
  }
  return slashCount % 2 === 1;
};

const findClosingBacktickRun = (text: string, delimiter: string, start: number): number => {
  let cursor = start;
  while (cursor < text.length) {
    const index = text.indexOf(delimiter, cursor);
    if (index === -1) return -1;
    if (!isEscapedBacktick(text, index)) return index;
    cursor = index + delimiter.length;
  }
  return -1;
};

/**
 * True when `offset` is after an unclosed backtick run in the same text.
 * Color UI treats this as an active code context: a backtick before `#`
 * suppresses pills, picker triggers, and previews until the user closes the
 * backtick span.
 */
export function isAfterUnclosedBacktick(text: string, offset: number): boolean {
  const target = Math.max(0, Math.min(offset, text.length));
  let cursor = 0;

  while (cursor < text.length) {
    if (text[cursor] !== '`') {
      cursor += 1;
      continue;
    }

    let tickCount = 1;
    while (cursor + tickCount < text.length && text[cursor + tickCount] === '`') {
      tickCount += 1;
    }

    const contentStart = cursor + tickCount;
    const delimiter = '`'.repeat(tickCount);
    const closeIndex = findClosingBacktickRun(text, delimiter, contentStart);

    if (closeIndex === -1) {
      if (target >= contentStart) return true;
      cursor = contentStart;
      continue;
    }

    cursor = closeIndex + tickCount;
  }

  return false;
}

/**
 * True when `offset` is inside an unclosed `{{` or `[[` delimiter pair.
 * Suppresses color conversion inside in-progress formula/template or
 * wiki-link syntax.
 *
 * Same-TextNode limitation: if a format split separates the opening
 * delimiter from the color literal, this guard does not see the opener.
 */
export function isInsideUnclosedDelimiter(text: string, offset: number): boolean {
  let braceDepth = 0;
  let bracketDepth = 0;
  for (let i = 0; i < offset && i < text.length - 1; i++) {
    const c = text[i];
    const next = text[i + 1];
    if (c === '{' && next === '{') { braceDepth++; i++; continue; }
    if (c === '}' && next === '}') { if (braceDepth > 0) braceDepth--; i++; continue; }
    if (c === '[' && next === '[') { bracketDepth++; i++; continue; }
    if (c === ']' && next === ']') { if (bracketDepth > 0) bracketDepth--; i++; continue; }
  }
  return braceDepth > 0 || bracketDepth > 0;
}

/**
 * True when `offset` is inside either retired named-color syntax:
 * `[color:value|name]` or `value[label]`.
 *
 * Neither experiment shipped, so both forms must remain wholly plain text
 * instead of letting the generic color matcher convert only the value.
 * In-progress brackets are suppressed too so their picker/conversion behavior
 * stays consistent with the settled syntax.
 */
export function isInsideRetiredNamedColorToken(text: string, offset: number): boolean {
  const target = Math.max(0, Math.min(offset, text.length));
  const lineStart = text.lastIndexOf('\n', Math.max(0, target - 1)) + 1;
  const tokenStart = text.lastIndexOf('[color:', target);
  if (tokenStart >= lineStart) {
    const tokenEnd = text.indexOf(']', tokenStart);
    if (tokenEnd === -1 || target <= tokenEnd) return true;
  }

  const lineEndMatch = text.indexOf('\n', target);
  const lineEnd = lineEndMatch === -1 ? text.length : lineEndMatch;
  const line = text.slice(lineStart, lineEnd);
  const retiredLabelRegex = new RegExp(`(?:${COLOR_PATTERN_BODY})\\[[^\\]\\n]*(?:\\]|$)`, 'gi');
  for (const match of line.matchAll(retiredLabelRegex)) {
    if (match.index === undefined) continue;
    const start = lineStart + match.index;
    const end = start + match[0].length;
    if (target >= start && target <= end) return true;
  }

  return false;
}

/**
 * True when offset is inside a raw markdown inline-code span in the same text.
 * Only closed, matched backtick spans count here. An unmatched literal
 * backtick is ordinary markdown prose once the text is settled.
 */
export function isInsideInlineCodeSpan(text: string, offset: number): boolean {
  const target = Math.max(0, Math.min(offset, text.length));
  let cursor = 0;

  while (cursor < text.length) {
    if (text[cursor] !== '`' || isEscapedBacktick(text, cursor)) {
      cursor += 1;
      continue;
    }

    let tickCount = 1;
    while (cursor + tickCount < text.length && text[cursor + tickCount] === '`') {
      tickCount += 1;
    }

    const contentStart = cursor + tickCount;
    const delimiter = '`'.repeat(tickCount);
    const closeIndex = findClosingBacktickRun(text, delimiter, contentStart);

    if (closeIndex === -1) {
      cursor = contentStart;
      continue;
    }

    if (target >= contentStart && target < closeIndex) {
      return true;
    }

    if (target < closeIndex + tickCount) {
      return false;
    }

    cursor = closeIndex + tickCount;
  }

  return false;
}

/** Find every complete color literal in `text`. Skips invalid hex lengths via the anchored regex. */
export function findCompleteColorMatches(text: string): CompleteColorMatch[] {
  const out: CompleteColorMatch[] = [];
  if (!text) return out;
  COLOR_REGEX_GLOBAL.lastIndex = 0;
  for (const m of text.matchAll(COLOR_REGEX_GLOBAL)) {
    if (m.index === undefined) continue;
    out.push({ start: m.index, end: m.index + m[0].length, value: m[0] });
  }
  return out;
}

/**
 * Variant of `findCompleteColorMatches` used by the live mutation listener.
 *
 * Only the canonical 6-digit `#rrggbb` hex form (plus the functional rgb / hsl
 * forms) is ever a color, so a complete match is already at its final length
 * the moment it forms — there is no shorter valid prefix to defer. The hex
 * regex requires `\b` after the match, so a 6-digit run immediately followed by
 * another hex digit (a 7- or 8-digit string the user is still typing) does not
 * match at all and stays plain text until it settles at exactly six digits.
 *
 * The end-of-text guard below is therefore a defensive floor on hex body length
 * (`HEX_LIVE_MIN_COMPLETE_LENGTH`); functional literals have an unambiguous
 * closing terminator and are always eager. Initial-scan and import paths use
 * `findCompleteColorMatches` directly since they run over settled prose.
 */
export function findLiveCompleteColorMatches(text: string): CompleteColorMatch[] {
  const all = findCompleteColorMatches(text);
  if (all.length === 0) return all;
  return all.filter((m) => {
    if (m.end < text.length) return true;
    if (m.value.startsWith('#') && m.value.length - 1 < HEX_LIVE_MIN_COMPLETE_LENGTH) return false;
    return true;
  });
}
