// ported-from: packages/desktop/src/renderer/editor/utils/chartDefaults.ts @ 762abb777
/**
 * Chart configuration types and validation utilities for ChartNode
 */

// moss-multi seam: converter-split (A§12; S-conv §2.3)
import {
  CHART_PALETTE_VIBRANT,
  CHART_PALETTE_COOL,
  CHART_PALETTE_EARTHY
} from '@moss/shared/lib/colors';
import { parseChartConfigBlock } from '../../../common/chartConfigParser';

export type ChartType = 'bar' | 'line' | 'stacked-bar' | 'area';

export type ChartPalette = 'classic' | 'accessible' | 'mono' | 'vibrant' | 'cool' | 'earthy';

export interface ChartDataPoint {
  label: string;
  value: number;
  color?: string;
}

export interface ChartOptions {
  width?: number;
  height?: number;
  xAxisLabel?: string;
  yAxisLabel?: string;
  showLegend?: boolean;
  showGrid?: boolean;
  palette?: ChartPalette;
}

export interface ChartSeries {
  name: string;
  data: ChartDataPoint[];
  color?: string;
}

export interface ChartConfig {
  type: ChartType;
  title?: string;
  data: ChartDataPoint[];
  series?: ChartSeries[];
  options?: ChartOptions;
  /** Internal: stores parse error when chart data is invalid */
  _parseError?: string;
  /** Internal: stores raw JSON for error recovery */
  _rawJson?: string;
}

export const CHART_TYPES: ChartType[] = ['bar', 'line', 'stacked-bar', 'area'];

/** Display names for chart types */
export const CHART_TYPE_LABELS: Record<ChartType, string> = {
  bar: 'Bar',
  line: 'Line',
  'stacked-bar': 'Stacked Bar',
  area: 'Area'
};

export const DEFAULT_CHART_OPTIONS: ChartOptions = {
  height: 300,
  showLegend: true,
  showGrid: true
};

/**
 * Chart color palettes following the moss design system.
 * Colors are defined in @moss/shared/lib/colors.ts
 */
export const CHART_PALETTES: Record<ChartPalette, { name: string; colors: string[] }> = {
  classic: {
    name: 'Classic',
    colors: [...CHART_PALETTE_VIBRANT]
  },
  accessible: {
    name: 'Accessible',
    colors: [...CHART_PALETTE_COOL]
  },
  mono: {
    name: 'Mono',
    colors: [...CHART_PALETTE_EARTHY]
  },
  // Legacy aliases — map old keys to new palettes
  vibrant: { name: 'Classic', colors: [...CHART_PALETTE_VIBRANT] },
  cool: { name: 'Accessible', colors: [...CHART_PALETTE_COOL] },
  earthy: { name: 'Mono', colors: [...CHART_PALETTE_EARTHY] },
};

export const DEFAULT_PALETTE: ChartPalette = 'classic';

/** Palettes shown in the UI dropdown (excludes legacy aliases) */
export const DISPLAY_PALETTES: ChartPalette[] = ['classic', 'accessible', 'mono'];

/** Valid palette keys for runtime validation */
const VALID_PALETTES: readonly ChartPalette[] = ['classic', 'accessible', 'mono', 'vibrant', 'cool', 'earthy'] as const;

/**
 * Type guard to check if a value is a valid ChartPalette
 */
export function isValidPalette(value: unknown): value is ChartPalette {
  return typeof value === 'string' && VALID_PALETTES.includes(value as ChartPalette);
}

/**
 * Validates and returns a safe palette value, defaulting to DEFAULT_PALETTE if invalid
 */
export function getSafePalette(value: unknown): ChartPalette {
  return isValidPalette(value) ? value : DEFAULT_PALETTE;
}

/** @deprecated Use CHART_PALETTES instead */
export const CHART_COLORS = CHART_PALETTES.classic.colors;

/**
 * Convert hex color to HSL components
 */
function hexToHsl(hex: string): { h: number; s: number; l: number } {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;

  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;

  if (max === min) {
    return { h: 0, s: 0, l };
  }

  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);

  let h = 0;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (max === g) h = ((b - r) / d + 2) / 6;
  else h = ((r - g) / d + 4) / 6;

  return { h, s, l };
}

/**
 * Convert HSL components to hex color
 */
function hslToHex(h: number, s: number, l: number): string {
  const hueToRgb = (p: number, q: number, t: number): number => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };

  let r: number, g: number, b: number;

  if (s === 0) {
    r = g = b = l;
  } else {
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hueToRgb(p, q, h + 1 / 3);
    g = hueToRgb(p, q, h);
    b = hueToRgb(p, q, h - 1 / 3);
  }

  const toHex = (c: number) =>
    Math.round(c * 255)
      .toString(16)
      .padStart(2, '0');

  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function resolveCssColor(color: string): string {
  const match = color.match(/^var\((--[^,\s)]+)\)$/);
  if (!match || typeof window === 'undefined') return color;
  const resolved = window.getComputedStyle(document.documentElement).getPropertyValue(match[1]).trim();
  return resolved || color;
}

/**
 * Adjust lightness of a hex color
 * @param hex - The hex color string
 * @param amount - Lightness adjustment (-1 to 1, negative = darker)
 */
function adjustLightness(hex: string, amount: number): string {
  const resolvedHex = resolveCssColor(hex);
  if (!/^#[0-9a-f]{6}$/i.test(resolvedHex)) return hex;
  const { h, s, l } = hexToHsl(resolvedHex);
  const newL = Math.max(0.15, Math.min(0.85, l + amount));
  return hslToHex(h, s, newL);
}

/**
 * Validates a chart configuration object
 */
export function validateChartConfig(config: unknown): {
  valid: boolean;
  error?: string;
  config?: ChartConfig;
} {
  if (!config || typeof config !== 'object') {
    return { valid: false, error: 'Configuration must be an object' };
  }

  const obj = { ...config } as Record<string, unknown>;
  if (obj.options && typeof obj.options === 'object') {
    obj.options = { ...obj.options };
  }

  // Validate type — normalize legacy donut → stacked-bar BEFORE the includes check
  if (!obj.type || typeof obj.type !== 'string') {
    return { valid: false, error: 'Missing or invalid "type" field' };
  }
  if (obj.type === 'donut') {
    obj.type = 'stacked-bar';
  }
  if (!CHART_TYPES.includes(obj.type as ChartType)) {
    return {
      valid: false,
      error: `Invalid chart type "${obj.type}". Must be one of: ${CHART_TYPES.join(', ')}`
    };
  }

  // Validate series first (it auto-populates data)
  // Validate optional series
  if (obj.series !== undefined) {
    if (!Array.isArray(obj.series)) {
      return { valid: false, error: '"series" must be an array' };
    }
    if (obj.type === 'stacked-bar') {
      return { valid: false, error: '"series" is not supported for stacked-bar charts' };
    }
    if (obj.series.length > 10) {
      return { valid: false, error: '"series" cannot have more than 10 entries' };
    }
    let totalPoints = 0;
    for (let i = 0; i < obj.series.length; i++) {
      const s = obj.series[i] as Record<string, unknown>;
      if (!s || typeof s !== 'object') {
        return { valid: false, error: `Series at index ${i} must be an object` };
      }
      if (typeof s.name !== 'string' || s.name.length === 0) {
        return { valid: false, error: `Series at index ${i} missing "name" string` };
      }
      if (s.name === 'label') {
        return { valid: false, error: `Series at index ${i}: "label" is a reserved name` };
      }
      if (!Array.isArray(s.data) || s.data.length === 0) {
        return { valid: false, error: `Series at index ${i} missing "data" array` };
      }
      totalPoints += (s.data as unknown[]).length;
      for (let j = 0; j < (s.data as unknown[]).length; j++) {
        const point = (s.data as Record<string, unknown>[])[j];
        if (!point || typeof point !== 'object') {
          return { valid: false, error: `Series ${i}, data point ${j} must be an object` };
        }
        if (typeof point.label !== 'string') {
          return { valid: false, error: `Series ${i}, data point ${j} missing "label" string` };
        }
        if (typeof point.value !== 'number' || isNaN(point.value as number)) {
          return { valid: false, error: `Series ${i}, data point ${j} missing valid "value" number` };
        }
      }
    }
    if (totalPoints > 100) {
      return { valid: false, error: 'Total data points across all series cannot exceed 100' };
    }
    // Auto-populate data from first series for backward compat
    if (obj.series.length > 0) {
      const firstSeries = obj.series[0] as { data: ChartDataPoint[] };
      obj.data = firstSeries.data;
    }
  }

  // Validate data (after series, which may auto-populate it)
  if (!obj.data || !Array.isArray(obj.data)) {
    return { valid: false, error: 'Missing or invalid "data" array' };
  }
  if (obj.data.length === 0) {
    return { valid: false, error: 'Data array must not be empty' };
  }

  for (let i = 0; i < obj.data.length; i++) {
    const point = obj.data[i] as Record<string, unknown>;
    if (!point || typeof point !== 'object') {
      return { valid: false, error: `Data point at index ${i} must be an object` };
    }
    if (typeof point.label !== 'string') {
      return { valid: false, error: `Data point at index ${i} missing "label" string` };
    }
    if (typeof point.value !== 'number' || isNaN(point.value)) {
      return { valid: false, error: `Data point at index ${i} missing valid "value" number` };
    }
  }

  // Validate optional title
  if (obj.title !== undefined && typeof obj.title !== 'string') {
    return { valid: false, error: '"title" must be a string' };
  }

  // Validate optional options
  if (obj.options !== undefined) {
    if (typeof obj.options !== 'object') {
      return { valid: false, error: '"options" must be an object' };
    }
    const opts = obj.options as Record<string, unknown>;
    if (opts.width !== undefined && (typeof opts.width !== 'number' || opts.width <= 0)) {
      return { valid: false, error: '"options.width" must be a positive number' };
    }
    if (opts.height !== undefined && (typeof opts.height !== 'number' || opts.height <= 0)) {
      return { valid: false, error: '"options.height" must be a positive number' };
    }
    // Normalize unknown palettes to default — never reject
    if (opts.palette !== undefined && !isValidPalette(opts.palette)) {
      opts.palette = DEFAULT_PALETTE;
    }
  }

  return {
    valid: true,
    config: obj as unknown as ChartConfig
  };
}

/**
 * Parses chart config text into a validated chart configuration.
 * Accepts strict JSON and YAML-like key/value format.
 */
export function parseChartConfig(jsonString: string): {
  valid: boolean;
  error?: string;
  config?: ChartConfig;
} {
  const parsed = parseChartConfigBlock(jsonString);
  if (!parsed.valid) {
    return {
      valid: false,
      error: parsed.error ?? 'Invalid chart configuration'
    };
  }

  return validateChartConfig(parsed.value);
}

/**
 * Serializes chart configuration to formatted JSON.
 * Excludes internal fields (_parseError, _rawJson).
 */
export function serializeChartConfig(config: ChartConfig): string {
  // Exclude internal fields from serialization
  const { _parseError, _rawJson, ...cleanConfig } = config;
  return JSON.stringify(cleanConfig, null, 2);
}

/**
 * Gets a color for a data point at the given index.
 * Automatically generates lighter/darker variants when index exceeds base palette.
 *
 * @param index - The data point index
 * @param palette - Which color palette to use (default: 'classic')
 * @param customColor - Optional override color
 */
export function getChartColor(
  index: number,
  palette: ChartPalette = DEFAULT_PALETTE,
  customColor?: string
): string {
  if (customColor) return customColor;

  const colors = CHART_PALETTES[palette].colors;
  const baseCount = colors.length;
  const colorIndex = index % baseCount;
  const tier = Math.floor(index / baseCount);

  if (tier === 0) {
    return colors[colorIndex];
  }

  // Alternate between lighter and darker, increasing intensity each cycle
  const isLighter = tier % 2 === 1;
  const intensity = Math.ceil(tier / 2) * 0.15;
  const adjustment = isLighter ? intensity : -intensity;

  return adjustLightness(colors[colorIndex], adjustment);
}

/**
 * Creates a sample chart configuration for demonstration
 */
export function createSampleChartConfig(type: ChartType): ChartConfig {
  return {
    type,
    title: `Sample ${CHART_TYPE_LABELS[type]} Chart`,
    data: [
      { label: 'Category A', value: 400 },
      { label: 'Category B', value: 300 },
      { label: 'Category C', value: 200 },
      { label: 'Category D', value: 278 }
    ]
  };
}
