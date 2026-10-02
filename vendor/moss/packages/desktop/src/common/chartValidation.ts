// ported-from: packages/desktop/src/common/chartValidation.ts @ 762abb777
/**
 * Chart block validation for markdown content.
 * Prevents invalid chart data from being written to notes.
 *
 * Invalid charts break rendering and fall back to showing raw code blocks,
 * which is a poor user experience. This validation ensures all chart data
 * is valid BEFORE it reaches the note.
 */

import { parseChartConfigBlock } from './chartConfigParser';

// ============================================================================
// Validation Constants
// ============================================================================

/** Maximum number of data points allowed in a chart */
export const MAX_DATA_POINTS = 100;

/** Maximum length for data point labels */
export const MAX_LABEL_LENGTH = 100;

/** Maximum length for chart title */
export const MAX_TITLE_LENGTH = 200;

/** Minimum dimension (width/height) for charts */
export const MIN_DIMENSION = 1;

/** Maximum dimension (width/height) for charts */
export const MAX_DIMENSION = 2000;

// ============================================================================
// Chart Types and Palettes
// ============================================================================

/** Valid chart types - must match ChartNode expectations exactly */
export const VALID_CHART_TYPES = ['bar', 'line', 'stacked-bar', 'area'] as const;

/** Valid palettes - must match chartDefaults.ts exactly */
export const VALID_PALETTES = ['classic', 'accessible', 'mono', 'vibrant', 'cool', 'earthy'] as const;

/** Derived type for valid chart types */
export type ChartType = (typeof VALID_CHART_TYPES)[number];

/** Derived type for valid palettes */
export type ChartPalette = (typeof VALID_PALETTES)[number];

// ============================================================================
// Interfaces
// ============================================================================

export interface ChartValidationError {
  blockIndex: number;
  error: string;
  rawContent: string;
}

export interface ChartValidationResult {
  valid: boolean;
  errors: ChartValidationError[];
}

// Regex to match moss-chart code blocks
const CHART_BLOCK_REGEX = /```moss-chart\s*\n([\s\S]*?)```/g;

// Valid hex color pattern: #RGB, #RRGGBB, or #RRGGBBAA
const HEX_COLOR_REGEX = /^#([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6}|[0-9A-Fa-f]{8})$/;

// Common CSS color names that are safe to use
const VALID_CSS_COLORS = new Set([
  'black', 'white', 'red', 'green', 'blue', 'yellow', 'orange', 'purple',
  'pink', 'brown', 'gray', 'grey', 'cyan', 'magenta', 'lime', 'navy',
  'teal', 'olive', 'maroon', 'aqua', 'silver', 'fuchsia'
]);

/**
 * Validates a color value is safe to use in charts.
 * Accepts hex colors (#RGB, #RRGGBB, #RRGGBBAA) or common CSS color names.
 */
function isValidColor(color: unknown): boolean {
  if (typeof color !== 'string') return false;
  const trimmed = color.trim().toLowerCase();
  return HEX_COLOR_REGEX.test(color) || VALID_CSS_COLORS.has(trimmed);
}

/**
 * Validates a single chart configuration object.
 * Strict validation - rejects any data that could break rendering.
 */
function validateSingleChartConfig(config: unknown): { valid: boolean; error?: string } {
  if (!config || typeof config !== 'object') {
    return { valid: false, error: 'Chart configuration must be an object' };
  }

  const obj = config as Record<string, unknown>;

  // === REQUIRED: type field ===
  if (!obj.type || typeof obj.type !== 'string') {
    return { valid: false, error: 'Missing required "type" field' };
  }
  // Normalize legacy donut → stacked-bar before validation
  if (obj.type === 'donut') {
    obj.type = 'stacked-bar';
  }
  if (!VALID_CHART_TYPES.includes(obj.type as typeof VALID_CHART_TYPES[number])) {
    return {
      valid: false,
      error: `Invalid chart type "${obj.type}". Valid types: ${VALID_CHART_TYPES.join(', ')}`
    };
  }

  // === REQUIRED: data array ===
  if (!obj.data || !Array.isArray(obj.data)) {
    return { valid: false, error: 'Missing required "data" array' };
  }
  if (obj.data.length === 0) {
    return { valid: false, error: 'Chart data array cannot be empty' };
  }
  if (obj.data.length > MAX_DATA_POINTS) {
    return { valid: false, error: `Chart data array exceeds maximum of ${MAX_DATA_POINTS} points` };
  }

  // Validate each data point
  for (let i = 0; i < obj.data.length; i++) {
    const point = obj.data[i];
    if (!point || typeof point !== 'object') {
      return { valid: false, error: `Data point ${i}: must be an object` };
    }

    const p = point as Record<string, unknown>;

    // Required: label (string)
    if (typeof p.label !== 'string') {
      return { valid: false, error: `Data point ${i}: missing required "label" string` };
    }
    if (p.label.length === 0) {
      return { valid: false, error: `Data point ${i}: "label" cannot be empty` };
    }
    if (p.label.length > MAX_LABEL_LENGTH) {
      return { valid: false, error: `Data point ${i}: "label" exceeds maximum length of ${MAX_LABEL_LENGTH}` };
    }

    // Required: value (number)
    if (typeof p.value !== 'number') {
      return { valid: false, error: `Data point ${i}: missing required "value" number` };
    }
    if (!Number.isFinite(p.value)) {
      return { valid: false, error: `Data point ${i}: "value" must be a finite number (not NaN or Infinity)` };
    }

    // Optional: color (must be valid if present)
    if (p.color !== undefined) {
      if (!isValidColor(p.color)) {
        return {
          valid: false,
          error: `Data point ${i}: invalid "color" value "${p.color}". Use hex format (#RGB, #RRGGBB) or common color names.`
        };
      }
    }
  }

  // === OPTIONAL: title ===
  if (obj.title !== undefined) {
    if (typeof obj.title !== 'string') {
      return { valid: false, error: '"title" must be a string' };
    }
    if (obj.title.length > MAX_TITLE_LENGTH) {
      return { valid: false, error: `"title" exceeds maximum length of ${MAX_TITLE_LENGTH}` };
    }
  }

  // === OPTIONAL: options object ===
  if (obj.options !== undefined) {
    if (typeof obj.options !== 'object' || obj.options === null) {
      return { valid: false, error: '"options" must be an object' };
    }

    const opts = obj.options as Record<string, unknown>;

    // width
    if (opts.width !== undefined) {
      if (typeof opts.width !== 'number' || !Number.isFinite(opts.width)) {
        return { valid: false, error: '"options.width" must be a finite number' };
      }
      if (opts.width < MIN_DIMENSION || opts.width > MAX_DIMENSION) {
        return { valid: false, error: `"options.width" must be between ${MIN_DIMENSION} and ${MAX_DIMENSION}` };
      }
    }

    // height
    if (opts.height !== undefined) {
      if (typeof opts.height !== 'number' || !Number.isFinite(opts.height)) {
        return { valid: false, error: '"options.height" must be a finite number' };
      }
      if (opts.height < MIN_DIMENSION || opts.height > MAX_DIMENSION) {
        return { valid: false, error: `"options.height" must be between ${MIN_DIMENSION} and ${MAX_DIMENSION}` };
      }
    }

    // palette - STRICT: only allow known palettes
    if (opts.palette !== undefined) {
      if (typeof opts.palette !== 'string') {
        return { valid: false, error: '"options.palette" must be a string' };
      }
      if (!VALID_PALETTES.includes(opts.palette as typeof VALID_PALETTES[number])) {
        return {
          valid: false,
          error: `Invalid palette "${opts.palette}". Valid palettes: ${VALID_PALETTES.join(', ')}`
        };
      }
    }

    // showLegend
    if (opts.showLegend !== undefined && typeof opts.showLegend !== 'boolean') {
      return { valid: false, error: '"options.showLegend" must be a boolean' };
    }

    // showGrid
    if (opts.showGrid !== undefined && typeof opts.showGrid !== 'boolean') {
      return { valid: false, error: '"options.showGrid" must be a boolean' };
    }

    // xAxisLabel
    if (opts.xAxisLabel !== undefined) {
      if (typeof opts.xAxisLabel !== 'string') {
        return { valid: false, error: '"options.xAxisLabel" must be a string' };
      }
      if (opts.xAxisLabel.length > MAX_LABEL_LENGTH) {
        return { valid: false, error: `"options.xAxisLabel" exceeds maximum length of ${MAX_LABEL_LENGTH}` };
      }
    }

    // yAxisLabel
    if (opts.yAxisLabel !== undefined) {
      if (typeof opts.yAxisLabel !== 'string') {
        return { valid: false, error: '"options.yAxisLabel" must be a string' };
      }
      if (opts.yAxisLabel.length > MAX_LABEL_LENGTH) {
        return { valid: false, error: `"options.yAxisLabel" exceeds maximum length of ${MAX_LABEL_LENGTH}` };
      }
    }
  }

  return { valid: true };
}

/**
 * Validates all moss-chart code blocks in markdown content.
 * Returns validation result - if ANY chart is invalid, the entire write should be rejected.
 */
export function validateChartBlocks(content: string): ChartValidationResult {
  const errors: ChartValidationError[] = [];
  let blockIndex = 0;

  // Reset regex state for fresh matching
  CHART_BLOCK_REGEX.lastIndex = 0;

  let match: RegExpExecArray | null;
  while ((match = CHART_BLOCK_REGEX.exec(content)) !== null) {
    const rawContent = match[1].trim();

    const parsedResult = parseChartConfigBlock(rawContent);
    if (!parsedResult.valid) {
      errors.push({
        blockIndex,
        error: parsedResult.error ?? 'Invalid chart configuration',
        rawContent: rawContent.slice(0, 100) + (rawContent.length > 100 ? '...' : '')
      });
      blockIndex++;
      continue;
    }

    // Validate chart config
    const validation = validateSingleChartConfig(parsedResult.value);
    if (!validation.valid) {
      errors.push({
        blockIndex,
        error: validation.error ?? 'Unknown validation error',
        rawContent: rawContent.slice(0, 100) + (rawContent.length > 100 ? '...' : '')
      });
    }

    blockIndex++;
  }

  return {
    valid: errors.length === 0,
    errors
  };
}

/**
 * Formats validation errors into a clear message for the agent.
 */
export function formatChartValidationErrors(errors: ChartValidationError[]): string {
  if (errors.length === 0) {
    return 'No chart validation errors';
  }

  const lines = [
    'CHART VALIDATION FAILED - Cannot write invalid chart data to note.',
    ''
  ];

  for (const error of errors) {
    lines.push(`Chart ${error.blockIndex + 1}: ${error.error}`);
  }

  lines.push('');
  lines.push('Valid chart types: bar, line, stacked-bar, area');
  lines.push('Valid palettes: classic, accessible, mono (or legacy: vibrant, cool, earthy)');
  lines.push('Colors must be hex (#RGB, #RRGGBB) or common names (red, blue, etc.)');

  return lines.join('\n');
}
