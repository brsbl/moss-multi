// ported-from: packages/desktop/src/renderer/editor/utils/formula-runtime.ts @ 762abb777
import { normalizeWebBrowserUrl } from '../../../common/web-embed-url';

export const FORMULA_NAME_REGEX = /^[a-zA-Z][a-zA-Z0-9_-]*$/;

const FORMULA_REFERENCE_TOKEN_REGEX =
  /@\(([a-zA-Z][a-zA-Z0-9_-]*)#([0-9a-fA-F-]{36})#([0-9a-fA-F-]{36})\)/g;

// moss-multi seam: linear-numeric-literals. moss's /(\$)?\s*(\d[\d,]*(?:\.\d+)?|\.\d+)\s*([kKmMbB]?)(%?)/g retried
// its leading \s* from every position of a blank run no number follows, quadratic in the run. This scan gives the
// regex's matches and groups in one pass, calling `replace` as String.prototype.replace calls its callback.
const BLANK_REGEX = /\s/;
const isDigit = (char: string | undefined): boolean => char !== undefined && char >= '0' && char <= '9';

function numberEndAt(text: string, start: number): number {
  let end = start;
  if (isDigit(text[end])) {
    end += 1;
    while (isDigit(text[end]) || text[end] === ',') end += 1;
  } else if (!(text[end] === '.' && isDigit(text[end + 1]))) {
    return -1;
  }
  if (text[end] === '.' && isDigit(text[end + 1])) {
    end += 2;
    while (isDigit(text[end])) end += 1;
  }
  return end;
}

export function replaceNumericLiterals(
  text: string,
  replace: (full: string, currency: string | undefined, rawNumber: string, unit: string, percent: string) => string
): string {
  let output = '';
  let copied = 0;
  let index = 0;
  while (index < text.length) {
    let cursor = index;
    const currency = text[cursor] === '$' ? '$' : undefined;
    if (currency) cursor += 1;
    while (cursor < text.length && BLANK_REGEX.test(text[cursor])) cursor += 1;
    const numberStart = cursor;
    const numberEnd = numberEndAt(text, numberStart);
    if (numberEnd < 0) {
      // Every start inside this blank run reaches the same non-number, so none of them matches.
      index = Math.max(cursor, index + 1);
      continue;
    }
    cursor = numberEnd;
    while (cursor < text.length && BLANK_REGEX.test(text[cursor])) cursor += 1;
    const unit = 'kKmMbB'.includes(text[cursor] ?? '-') ? text[cursor] : '';
    cursor += unit.length;
    const percent = text[cursor] === '%' ? '%' : '';
    cursor += percent.length;
    output += text.slice(copied, index) + replace(text.slice(index, cursor), currency, text.slice(numberStart, numberEnd), unit, percent);
    copied = cursor;
    index = cursor;
  }
  return copied === 0 ? text : output + text.slice(copied);
}

const FORMULA_PAYLOAD_REGEX = /\{\{([^{}\n]+)\}\}/g;

type LegacyFormulaIdentityFormat = 'number' | 'decimal' | 'currency' | 'percent';

const LEGACY_FORMULA_IDENTITY_FORMATS = new Set<LegacyFormulaIdentityFormat>([
  'number',
  'decimal',
  'currency',
  'percent'
]);
const DEFAULT_LEGACY_FORMULA_IDENTITY_FORMAT: LegacyFormulaIdentityFormat = 'number';

export type FormulaSourceMode = 'executable' | 'symbolic' | 'invalid';

export interface FormulaReferenceToken {
  name: string;
  noteId: string;
  formulaId: string;
}

export interface FormulaPatternMatch {
  startIndex: number;
  endIndex: number;
  equalsIndex: number;
  name: string | null;
  expression: string;
}

export interface FormulaReferenceQueryMatch {
  pattern: FormulaPatternMatch;
  query: string;
  queryStartIndex: number;
}

export interface FormulaMarkdownPayload {
  expression: string;
  result: string;
  formulaId: string | null;
  name: string | null;
  stale: boolean;
}

export interface FormulaMarkdownMatch {
  startIndex: number;
  endIndex: number;
  raw: string;
  payload: FormulaMarkdownPayload;
}

export interface FormulaWorkspaceFormulaInput {
  noteId: string;
  noteTitle: string;
  formulaId: string;
  name: string | null;
  expression: string;
  result: string;
  stale: boolean;
}

export interface FormulaWorkspaceFormulaRecord
  extends FormulaWorkspaceFormulaInput {
  lookupName: string | null;
  deps: FormulaReferenceToken[];
  value: number | null;
  cycle: boolean;
  sourceMode: FormulaSourceMode;
}

export interface FormulaWorkspaceEvaluation {
  byKey: Map<string, FormulaWorkspaceFormulaRecord>;
  named: FormulaWorkspaceFormulaRecord[];
  cycles: Set<string>;
  byNoteAndName: Map<string, string>;
}

export interface FormulaExpressionEvaluation {
  value: number | null;
  references: FormulaReferenceToken[];
  hasMissingReferences: boolean;
}

const DRAFT_EXECUTABLE_HINT_REGEX = /[@+\-*/()$%]/;
const NUMERIC_DRAFT_EXPRESSION_REGEX =
  /^\s*\$?\s*(?:\d[\d,]*(?:\.\d+)?|\.\d+)\s*[kKmMbB]?\s*%?\s*$/;
const UUID_HASH_OFFSETS = [0x811c9dc5, 0x9e3779b9, 0x85ebca6b, 0xc2b2ae35] as const;

export const createFormulaCompoundKey = (
  noteId: string,
  formulaId: string
): string => `${noteId}:${formulaId}`;

export const getNoteNameKey = (noteId: string, name: string): string =>
  `${noteId}::${name}`;

export const isValidFormulaName = (name: string): boolean =>
  FORMULA_NAME_REGEX.test(name);

function hasFormulaReferenceToken(expression: string): boolean {
  FORMULA_REFERENCE_TOKEN_REGEX.lastIndex = 0;
  const hasReference = FORMULA_REFERENCE_TOKEN_REGEX.test(expression);
  FORMULA_REFERENCE_TOKEN_REGEX.lastIndex = 0;
  return hasReference;
}

function hasNumericDraftSyntax(expression: string): boolean {
  const remainder = replaceNumericLiterals(expression, () => '');
  return /^[\s+\-*/()]*$/.test(remainder);
}

function isEvaluableFormulaExpression(source: string): boolean {
  return evaluateFormulaExpression(source, () => 0).value !== null;
}

export function classifyFormulaSource(
  source: string,
  options?: { storedDisplay?: string | null }
): FormulaSourceMode {
  const trimmedSource = source.trim();
  if (!trimmedSource) {
    return 'invalid';
  }

  const storedDisplay = options?.storedDisplay?.trim() ?? '';
  if (
    storedDisplay.length > 0 &&
    isValidFormulaName(trimmedSource) &&
    !hasFormulaReferenceToken(trimmedSource)
  ) {
    return 'symbolic';
  }

  if (hasFormulaReferenceToken(trimmedSource) || isEvaluableFormulaExpression(trimmedSource)) {
    return 'executable';
  }

  return 'invalid';
}

export function classifyFormulaDraftSource(options: {
  name: string | null;
  expression: string;
  evaluation?: Pick<FormulaExpressionEvaluation, 'value' | 'references' | 'hasMissingReferences'>;
}): FormulaSourceMode {
  const trimmedExpression = options.expression.trim();
  if (!trimmedExpression) {
    return 'invalid';
  }

  if (!options.name || !isValidFormulaName(options.name)) {
    return 'executable';
  }

  if (
    (options.evaluation ? options.evaluation.value !== null : false) ||
    (options.evaluation?.references.length ?? 0) > 0 ||
    options.evaluation?.hasMissingReferences ||
    hasFormulaReferenceToken(trimmedExpression) ||
    (DRAFT_EXECUTABLE_HINT_REGEX.test(trimmedExpression) &&
      hasNumericDraftSyntax(trimmedExpression)) ||
    NUMERIC_DRAFT_EXPRESSION_REGEX.test(trimmedExpression)
  ) {
    return 'executable';
  }

  return 'symbolic';
}

function resolveFormulaLookupName(
  input: FormulaWorkspaceFormulaInput,
  sourceMode: FormulaSourceMode
): string | null {
  if (input.name) {
    return input.name;
  }

  const symbolicName = input.expression.trim();
  if (sourceMode === 'symbolic' && isValidFormulaName(symbolicName)) {
    return symbolicName;
  }

  return null;
}

function hashFormulaFallbackSeed(seed: string, offset: number): number {
  let hash = offset >>> 0;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function createDeterministicFormulaFallbackId(seed: string): string {
  const hex = UUID_HASH_OFFSETS.map((offset) =>
    hashFormulaFallbackSeed(seed, offset).toString(16).padStart(8, '0')
  ).join('');
  const chars = hex.split('');
  chars[12] = '5';
  chars[16] = ((Number.parseInt(chars[16], 16) & 0x3) | 0x8).toString(16);

  return [
    chars.slice(0, 8).join(''),
    chars.slice(8, 12).join(''),
    chars.slice(12, 16).join(''),
    chars.slice(16, 20).join(''),
    chars.slice(20, 32).join('')
  ].join('-');
}

function createFormulaMarkdownFallbackId(
  noteId: string,
  payload: FormulaMarkdownPayload,
  legacyFormat: LegacyFormulaIdentityFormat,
  occurrenceIndex: number
): string {
  return createDeterministicFormulaFallbackId(
    [
      noteId,
      payload.expression,
      payload.result,
      payload.name ?? '',
      legacyFormat,
      payload.stale ? '1' : '0',
      String(occurrenceIndex)
    ].join('\u0000')
  );
}

function getLegacyFormulaIdentityFormat(payload: string): LegacyFormulaIdentityFormat {
  const parts = payload.split('|');
  let format = DEFAULT_LEGACY_FORMULA_IDENTITY_FORMAT;

  if (parts.length <= 2) {
    return format;
  }

  const entries = parts.slice(2).join('|').split(';').map((entry) => entry.trim()).filter(Boolean);
  for (const entry of entries) {
    const separatorIndex = entry.indexOf('=');
    if (separatorIndex === -1) {
      continue;
    }

    const key = entry.slice(0, separatorIndex).trim();
    const value = entry.slice(separatorIndex + 1).trim();
    if (
      key === 'format' &&
      LEGACY_FORMULA_IDENTITY_FORMATS.has(value as LegacyFormulaIdentityFormat)
    ) {
      format = value as LegacyFormulaIdentityFormat;
    }
  }

  return format;
}

export function createFormulaReferenceToken(reference: FormulaReferenceToken): string {
  return `@(${reference.name}#${reference.noteId}#${reference.formulaId})`;
}

export function extractFormulaReferences(
  expression: string
): FormulaReferenceToken[] {
  const refs: FormulaReferenceToken[] = [];
  let match: RegExpExecArray | null;
  FORMULA_REFERENCE_TOKEN_REGEX.lastIndex = 0;

  while ((match = FORMULA_REFERENCE_TOKEN_REGEX.exec(expression)) !== null) {
    refs.push({
      name: match[1],
      noteId: match[2],
      formulaId: match[3]
    });
  }

  return refs;
}

function applyNumericUnit(value: number, unit: string): number {
  const normalized = unit.toLowerCase();
  if (normalized === 'k') return value * 1_000;
  if (normalized === 'm') return value * 1_000_000;
  if (normalized === 'b') return value * 1_000_000_000;
  return value;
}

function roundToTwo(value: number): number {
  return Math.round(value * 100) / 100;
}

// Computed values keep their precision — rounding is a display concern, and a
// formula that rounds on the way out hands the rounded number to whatever
// references it. Only binary-float noise is trimmed, so `0.1 + 0.2 + 0.7`
// still lands on a clean 1.
function trimFloatNoise(value: number): number {
  // Whole and large values cannot carry meaningful user-scale decimal noise;
  // scaling them would instead lose integer precision.
  if (Number.isInteger(value) || Math.abs(value) >= 1e6) {
    return value;
  }
  const scaled = value * 1e10;
  return Number.isFinite(scaled) ? Math.round(scaled) / 1e10 : value;
}

export function formatNumericLiteral(value: number): string {
  const literal = String(value);
  if (!/[eE]/.test(literal)) {
    return literal;
  }

  const [coefficient, rawExponent] = literal.toLowerCase().split('e');
  const exponent = Number(rawExponent);
  const isNegative = coefficient.startsWith('-');
  const unsigned = isNegative ? coefficient.slice(1) : coefficient;
  const decimalIndex = unsigned.indexOf('.');
  const digits = unsigned.replace('.', '');
  const sourceDecimalIndex = decimalIndex === -1 ? digits.length : decimalIndex;
  const targetDecimalIndex = sourceDecimalIndex + exponent;
  const sign = isNegative ? '-' : '';

  if (targetDecimalIndex <= 0) {
    return `${sign}0.${'0'.repeat(-targetDecimalIndex)}${digits}`;
  }
  if (targetDecimalIndex >= digits.length) {
    return `${sign}${digits}${'0'.repeat(targetDecimalIndex - digits.length)}`;
  }
  return `${sign}${digits.slice(0, targetDecimalIndex)}.${digits.slice(targetDecimalIndex)}`;
}

export function parseFormattedNumericResult(result: string): number | null {
  const trimmed = result.trim();
  if (!trimmed) {
    return null;
  }

  const normalized = trimmed
    .replace(/\$/g, '')
    .replace(/%/g, '')
    .replace(/,/g, '')
    .trim();

  if (!normalized || !/^[-+]?\d*\.?\d+$/.test(normalized)) {
    return null;
  }

  const value = Number(normalized);
  if (!Number.isFinite(value)) {
    return null;
  }

  return value;
}

/**
 * Safely evaluates a numeric arithmetic expression.
 * Accepts only digits/operators/parentheses/whitespace and returns null for invalid input.
 */
export function evaluateArithmeticExpression(expression: string): number | null {
  const cleanExpr = expression.replace(/,/g, '').trim();

  if (!cleanExpr) {
    return null;
  }

  if (!/^[\d+\-*/().\s]+$/.test(cleanExpr)) {
    return null;
  }

  try {
    let index = 0;
    const length = cleanExpr.length;

    const skipWhitespace = () => {
      while (index < length && /\s/.test(cleanExpr[index])) {
        index += 1;
      }
    };

    const parseNumber = (): number => {
      skipWhitespace();
      const match = cleanExpr.slice(index).match(/^(\d+(\.\d*)?|\.\d+)/);
      if (!match) {
        throw new Error('Expected number');
      }
      index += match[0].length;
      return Number(match[0]);
    };

    const parseFactor = (): number => {
      skipWhitespace();
      const char = cleanExpr[index];

      if (char === '+') {
        index += 1;
        return parseFactor();
      }

      if (char === '-') {
        index += 1;
        return -parseFactor();
      }

      if (char === '(') {
        index += 1;
        const value = parseExpression();
        skipWhitespace();
        if (cleanExpr[index] !== ')') {
          throw new Error('Expected )');
        }
        index += 1;
        return value;
      }

      return parseNumber();
    };

    const parseTerm = (): number => {
      let value = parseFactor();

      while (true) {
        skipWhitespace();
        const char = cleanExpr[index];
        if (char === '*' || char === '/') {
          index += 1;
          const nextValue = parseFactor();
          if (char === '*') {
            value *= nextValue;
          } else {
            if (nextValue === 0) {
              throw new Error('Division by zero');
            }
            value /= nextValue;
          }
        } else {
          break;
        }
      }

      return value;
    };

    const parseExpression = (): number => {
      let value = parseTerm();

      while (true) {
        skipWhitespace();
        const char = cleanExpr[index];
        if (char === '+' || char === '-') {
          index += 1;
          const nextValue = parseTerm();
          value = char === '+' ? value + nextValue : value - nextValue;
        } else {
          break;
        }
      }

      return value;
    };

    const result = parseExpression();
    skipWhitespace();

    if (index < length) {
      return null;
    }

    if (!Number.isFinite(result)) {
      return null;
    }

    return trimFloatNoise(result);
  } catch {
    return null;
  }
}

function normalizeFormulaExpression(
  expression: string,
  resolveReference: (reference: FormulaReferenceToken) => number | null
): {
  normalizedExpression: string;
  references: FormulaReferenceToken[];
  hasMissingReferences: boolean;
} {
  const references = extractFormulaReferences(expression);
  let hasMissingReferences = false;

  FORMULA_REFERENCE_TOKEN_REGEX.lastIndex = 0;
  const withResolvedReferences = expression.replace(
    FORMULA_REFERENCE_TOKEN_REGEX,
    (_full, name: string, noteId: string, formulaId: string) => {
      const ref: FormulaReferenceToken = { name, noteId, formulaId };
      const resolved = resolveReference(ref);
      if (resolved === null) {
        hasMissingReferences = true;
        return '0';
      }
      return formatNumericLiteral(resolved);
    }
  );

  const normalizedExpression = replaceNumericLiterals(
    withResolvedReferences,
    (_full, _currency: string | undefined, rawNumber: string, unit: string, percent: string) => {
      const parsed = Number(rawNumber.replace(/,/g, ''));
      if (!Number.isFinite(parsed)) {
        return '0';
      }

      const withUnit = applyNumericUnit(parsed, unit);
      return formatNumericLiteral(percent ? withUnit / 100 : withUnit);
    }
  );

  return {
    normalizedExpression,
    references,
    hasMissingReferences
  };
}

export function evaluateFormulaExpression(
  expression: string,
  resolveReference: (reference: FormulaReferenceToken) => number | null
): FormulaExpressionEvaluation {
  const trimmed = expression.trim();
  if (!trimmed) {
    return {
      value: null,
      references: [],
      hasMissingReferences: false
    };
  }

  const normalized = normalizeFormulaExpression(trimmed, resolveReference);

  // If any unresolved identifier-like text remains, reject.
  if (/[A-Za-z]/.test(normalized.normalizedExpression)) {
    return {
      value: null,
      references: normalized.references,
      hasMissingReferences: normalized.hasMissingReferences
    };
  }

  const value = evaluateArithmeticExpression(normalized.normalizedExpression);

  return {
    value,
    references: normalized.references,
    hasMissingReferences: normalized.hasMissingReferences
  };
}

export function formatFormulaValue(value: number): string {
  const rounded = roundToTwo(value);
  return new Intl.NumberFormat('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2
  }).format(Object.is(rounded, -0) ? 0 : rounded);
}

export interface CodeRange {
  start: number;
  end: number;
}

const FORMULA_URL_TOKEN_BOUNDARY_RE = /[\s<>{}|\\^[\]`]/;
const FORMULA_URL_LEADING_PUNCTUATION_RE = /^[('"{]+/;
const FORMULA_URL_PREFIX_RE =
  /^(?:https?:\/\/|www\.|[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?\.)/i;

const isEqualsInsideWebUrl = (
  textContent: string,
  equalsIndex: number,
  cursorOffset: number
): boolean => {
  let tokenStart = equalsIndex;
  while (
    tokenStart > 0 &&
    !FORMULA_URL_TOKEN_BOUNDARY_RE.test(textContent[tokenStart - 1])
  ) {
    tokenStart -= 1;
  }

  const token = textContent
    .slice(tokenStart, cursorOffset)
    .replace(FORMULA_URL_LEADING_PUNCTUATION_RE, '');
  return FORMULA_URL_PREFIX_RE.test(token) && normalizeWebBrowserUrl(token) !== null;
};

export function findFormulaPatternAtCursor(
  textContent: string,
  cursorOffset: number,
  options?: { allowEmptyExpression?: boolean; allowInlineAnonymous?: boolean; codeRanges?: CodeRange[] }
): FormulaPatternMatch | null {
  const allowEmptyExpression = options?.allowEmptyExpression ?? false;
  const allowInlineAnonymous = options?.allowInlineAnonymous ?? false;
  const codeRanges = options?.codeRanges;

  if (cursorOffset <= 0 || cursorOffset > textContent.length) {
    return null;
  }

  for (let equalsIndex = cursorOffset - 1; equalsIndex >= 0; equalsIndex -= 1) {
    if (textContent[equalsIndex] !== '=') {
      continue;
    }

    if (codeRanges?.some(r => equalsIndex >= r.start && equalsIndex < r.end)) {
      continue;
    }

    if (isEqualsInsideWebUrl(textContent, equalsIndex, cursorOffset)) {
      continue;
    }

    const expression = textContent.slice(equalsIndex + 1, cursorOffset);

    if (expression.includes('\n')) {
      continue;
    }

    // Ignore whitespace-only tails like "= " so prose typing does not enter
    // formula-draft mode on space; keep true empty drafts ("=") allowed.
    if (allowEmptyExpression && expression.length > 0 && expression.trim().length === 0) {
      continue;
    }

    if (!allowEmptyExpression && expression.trim().length === 0) {
      continue;
    }

    let tokenStart = equalsIndex;
    while (tokenStart > 0 && /[A-Za-z0-9_-]/.test(textContent[tokenStart - 1])) {
      tokenStart -= 1;
    }

    const candidateName = textContent.slice(tokenStart, equalsIndex);

    if (candidateName.length > 0) {
      if (!isValidFormulaName(candidateName)) {
        continue;
      }
      const beforeName = tokenStart > 0 ? textContent[tokenStart - 1] : '';
      if (tokenStart > 0 && /[A-Za-z0-9_-]/.test(beforeName)) {
        continue;
      }

      return {
        startIndex: tokenStart,
        endIndex: cursorOffset,
        equalsIndex,
        name: candidateName,
        expression
      };
    }

    // Anonymous formula can start at line start, after a single symbolic prefix
    // (e.g. "$=2+2"), or after punctuation boundaries like ":" (e.g.
    // "remaining: =45*45").
    const lineStart = textContent.lastIndexOf('\n', equalsIndex - 1) + 1;
    const trimmedExpression = expression.trim();
    const startsWithWhitespace = expression.length > 0 && /^\s/.test(expression);

    // Prevent accidental triggers for prose/equation typing like "= 4*4".
    if (startsWithWhitespace) {
      continue;
    }

    if (equalsIndex !== lineStart) {
      const prefix = textContent.slice(lineStart, equalsIndex).trimEnd();
      const hasSingleSymbolPrefix =
        prefix.length === 1 && /[^A-Za-z0-9_]/.test(prefix);
      const prefixBoundaryChar = prefix.length > 0 ? prefix[prefix.length - 1] : '';
      const hasPunctuationBoundary = /[:;([{,+\-*/%$]/.test(prefixBoundaryChar);
      const immediateBeforeEquals = equalsIndex > 0 ? textContent[equalsIndex - 1] : '';
      const hasInlineWhitespaceBoundary =
        allowInlineAnonymous && /\s/.test(immediateBeforeEquals);

      if (
        prefix.length > 0 &&
        !hasSingleSymbolPrefix &&
        !hasPunctuationBoundary &&
        !hasInlineWhitespaceBoundary
      ) {
        continue;
      }

      // In inline list-style prose (`foo = bar`), avoid latching formula mode
      // when the right-hand side is only a bare identifier.
      if (
        hasInlineWhitespaceBoundary &&
        trimmedExpression.length > 0 &&
        FORMULA_NAME_REGEX.test(trimmedExpression)
      ) {
        continue;
      }
    }

    return {
      startIndex: equalsIndex,
      endIndex: cursorOffset,
      equalsIndex,
      name: null,
      expression
    };
  }

  return null;
}

export function findFormulaReferenceQueryAtCursor(
  textContent: string,
  cursorOffset: number,
  options?: { allowInlineAnonymous?: boolean; codeRanges?: CodeRange[] }
): FormulaReferenceQueryMatch | null {
  const pattern = findFormulaPatternAtCursor(textContent, cursorOffset, {
    allowEmptyExpression: true,
    allowInlineAnonymous: options?.allowInlineAnonymous ?? false,
    codeRanges: options?.codeRanges
  });

  if (!pattern) {
    return null;
  }

  const expressionBeforeCursor = textContent.slice(pattern.equalsIndex + 1, cursorOffset);
  if (!expressionBeforeCursor) {
    return null;
  }

  // Don't trigger while cursor is inside a reference token.
  const lastReferenceStart = expressionBeforeCursor.lastIndexOf('@(');
  const lastReferenceEnd = expressionBeforeCursor.lastIndexOf(')');
  if (lastReferenceStart > lastReferenceEnd) {
    return null;
  }

  let tokenStart = expressionBeforeCursor.length;
  while (tokenStart > 0 && /[A-Za-z0-9_-]/.test(expressionBeforeCursor[tokenStart - 1])) {
    tokenStart -= 1;
  }

  if (tokenStart === expressionBeforeCursor.length) {
    return null;
  }

  const query = expressionBeforeCursor.slice(tokenStart);
  if (!FORMULA_NAME_REGEX.test(query)) {
    return null;
  }

  const charBeforeToken = tokenStart > 0 ? expressionBeforeCursor[tokenStart - 1] : '';
  const validBoundary =
    tokenStart === 0 || /[+\-*/(,\s]/.test(charBeforeToken);

  if (!validBoundary) {
    return null;
  }

  return {
    pattern,
    query,
    queryStartIndex: pattern.equalsIndex + 1 + tokenStart
  };
}

export function parseFormulaMarkdownPayload(
  payload: string
): FormulaMarkdownPayload | null {
  const parts = payload.split('|');
  if (parts.length < 2) {
    return null;
  }

  const expression = parts[0];
  const result = parts[1];

  let formulaId: string | null = null;
  let name: string | null = null;
  let stale = false;

  if (parts.length > 2) {
    const meta = parts.slice(2).join('|');
    const entries = meta.split(';').map((entry) => entry.trim()).filter(Boolean);

    for (const entry of entries) {
      const separatorIndex = entry.indexOf('=');
      if (separatorIndex === -1) {
        continue;
      }

      const key = entry.slice(0, separatorIndex).trim();
      const value = entry.slice(separatorIndex + 1).trim();

      if (key === 'id' && value) {
        formulaId = value;
      } else if (key === 'name' && value) {
        name = value;
      } else if (key === 'stale') {
        stale = value === '1' || value.toLowerCase() === 'true';
      }
    }
  }

  if (name && !isValidFormulaName(name)) {
    return null;
  }

  const sourceMode = classifyFormulaSource(expression, { storedDisplay: result });
  if (sourceMode === 'invalid') {
    return null;
  }

  if (sourceMode === 'symbolic') {
    stale = false;
  }

  return {
    expression,
    result,
    formulaId,
    name,
    stale
  };
}

export function serializeFormulaMarkdownPayload(
  payload: FormulaMarkdownPayload
): string {
  const base = `${payload.expression}|${payload.result}`;
  const sourceMode = classifyFormulaSource(payload.expression, {
    storedDisplay: payload.result
  });

  // Keep anonymous executable formulas on legacy syntax. Symbolic variables
  // persist their identity so pasted instances remain linked after reload.
  if (!payload.name && sourceMode !== 'symbolic') {
    return base;
  }

  const metadata: string[] = [];
  if (payload.formulaId) {
    metadata.push(`id=${payload.formulaId}`);
  }
  if (payload.name) {
    metadata.push(`name=${payload.name}`);
  }
  if (payload.stale) {
    metadata.push('stale=1');
  }

  if (metadata.length === 0) {
    return base;
  }

  return `${base}|${metadata.join(';')}`;
}

export function extractFormulaMarkdownMatches(
  markdown: string
): FormulaMarkdownMatch[] {
  const matches: FormulaMarkdownMatch[] = [];
  let match: RegExpExecArray | null;

  FORMULA_PAYLOAD_REGEX.lastIndex = 0;
  while ((match = FORMULA_PAYLOAD_REGEX.exec(markdown)) !== null) {
    const parsed = parseFormulaMarkdownPayload(match[1]);
    if (!parsed) {
      continue;
    }

    matches.push({
      startIndex: match.index,
      endIndex: match.index + match[0].length,
      raw: match[0],
      payload: parsed
    });
  }

  return matches;
}

export function extractWorkspaceFormulasFromMarkdown(
  noteId: string,
  noteTitle: string,
  markdown: string
): FormulaWorkspaceFormulaInput[] {
  const matches = extractFormulaMarkdownMatches(markdown);
  const fallbackOccurrences = new Map<string, number>();

  return matches.map((match) => {
    const legacyFormat = getLegacyFormulaIdentityFormat(match.raw.slice(2, -2));
    const fallbackKey = [
      match.payload.expression,
      match.payload.result,
      match.payload.name ?? '',
      legacyFormat,
      match.payload.stale ? '1' : '0'
    ].join('\u0000');
    const occurrenceIndex = fallbackOccurrences.get(fallbackKey) ?? 0;
    fallbackOccurrences.set(fallbackKey, occurrenceIndex + 1);

    return {
      noteId,
      noteTitle,
      formulaId:
        match.payload.formulaId ??
        createFormulaMarkdownFallbackId(noteId, match.payload, legacyFormat, occurrenceIndex),
      name: match.payload.name,
      expression: match.payload.expression,
      result: match.payload.result,
      stale: match.payload.stale
    };
  });
}

export function evaluateWorkspaceFormulas(
  inputs: FormulaWorkspaceFormulaInput[]
): FormulaWorkspaceEvaluation {
  const byKey = new Map<string, FormulaWorkspaceFormulaRecord>();

  for (const input of inputs) {
    const key = createFormulaCompoundKey(input.noteId, input.formulaId);
    const sourceMode = classifyFormulaSource(input.expression, {
      storedDisplay: input.result
    });
    const lookupName = resolveFormulaLookupName(input, sourceMode);
    byKey.set(key, {
      ...input,
      lookupName,
      deps:
        sourceMode === 'symbolic'
          ? []
          : extractFormulaReferences(input.expression),
      value: null,
      cycle: false,
      sourceMode
    });
  }

  const cycles = new Set<string>();
  const visitState = new Map<string, 'visiting' | 'done'>();
  const stack: string[] = [];

  const markCycle = (cycleStartKey: string) => {
    const startIndex = stack.lastIndexOf(cycleStartKey);
    const cycleKeys =
      startIndex >= 0
        ? stack.slice(startIndex)
        : [cycleStartKey];

    for (const key of cycleKeys) {
      cycles.add(key);
      const node = byKey.get(key);
      if (node) {
        node.cycle = true;
      }
    }
  };

  const evaluateNode = (key: string): number | null => {
    const node = byKey.get(key);
    if (!node) {
      return null;
    }

    if (node.sourceMode === 'symbolic') {
      node.value = parseFormattedNumericResult(node.result);
      node.stale = false;
      return node.value;
    }

    if (node.sourceMode === 'invalid') {
      node.value = parseFormattedNumericResult(node.result);
      node.stale = false;
      return node.value;
    }

    const state = visitState.get(key);
    if (state === 'done') {
      return node.value;
    }

    if (state === 'visiting') {
      markCycle(key);
      const frozen = parseFormattedNumericResult(node.result);
      node.value = frozen;
      node.stale = true;
      return frozen;
    }

    visitState.set(key, 'visiting');
    stack.push(key);

    const evaluation = evaluateFormulaExpression(node.expression, (reference) => {
      const depKey = createFormulaCompoundKey(reference.noteId, reference.formulaId);
      if (!byKey.has(depKey)) {
        return null;
      }
      const depValue = evaluateNode(depKey);
      if (depValue !== null) {
        return depValue;
      }
      const depNode = byKey.get(depKey);
      const frozenValue = depNode ? parseFormattedNumericResult(depNode.result) : null;
      return frozenValue ?? Number.NaN;
    });

    stack.pop();
    visitState.set(key, 'done');

    if (node.cycle || cycles.has(key)) {
      const frozen = parseFormattedNumericResult(node.result);
      node.value = frozen;
      node.stale = true;
      return frozen;
    }

    if (evaluation.hasMissingReferences) {
      const frozen = parseFormattedNumericResult(node.result);
      node.value = frozen;
      node.stale = true;
      return frozen;
    }

    if (evaluation.value === null) {
      const frozen = parseFormattedNumericResult(node.result);
      node.value = frozen;
      node.stale = false;
      return frozen;
    }

    node.value = evaluation.value;
    node.stale = false;
    node.result = formatFormulaValue(evaluation.value);

    return node.value;
  };

  for (const key of byKey.keys()) {
    evaluateNode(key);
  }

  const byNoteAndName = new Map<string, string>();
  for (const record of byKey.values()) {
    if (!record.lookupName) {
      continue;
    }
    const key = createFormulaCompoundKey(record.noteId, record.formulaId);
    byNoteAndName.set(getNoteNameKey(record.noteId, record.lookupName), key);
  }

  const named = [...byKey.values()].filter(
    (node) =>
      typeof node.lookupName === 'string' &&
      node.lookupName.length > 0
  );

  return {
    byKey,
    named,
    cycles,
    byNoteAndName
  };
}
