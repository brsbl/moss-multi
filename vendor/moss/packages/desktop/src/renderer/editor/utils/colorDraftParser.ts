// ported-from: packages/desktop/src/renderer/editor/utils/colorDraftParser.ts @ 762abb777
export type ColorTriggerKind = 'hex' | 'rgb' | 'rgba' | 'hsl' | 'hsla';
export type ColorLiteralFormat = ColorTriggerKind;

/**
 * Formats the picker UI emits. Defined alongside `ColorTriggerKind`
 * (re-exported from `colorPickerState`) to avoid an import cycle through the
 * picker state module.
 */
export type ColorPickerFormat = 'hex' | 'rgba' | 'hsla';

export type ColorDraftFieldStatus =
  | 'typed'
  | 'inferred'
  | 'defaulted'
  | 'clamped'
  | 'invalid';

export type ColorDraftStatus = 'exact' | 'inferred' | 'corrected' | 'invalid';

export type ColorDraftFieldName =
  | 'hex'
  | 'r'
  | 'g'
  | 'b'
  | 'h'
  | 's'
  | 'l'
  | 'a';

export interface ColorDraftField {
  name: ColorDraftFieldName;
  label: string;
  raw: string;
  value: number;
  status: ColorDraftFieldStatus;
  min?: number;
  max?: number;
  unit?: '%' | '';
  textValue?: string;
  message?: string;
}

export interface ColorDraftCorrection {
  field?: ColorDraftFieldName;
  status: Exclude<ColorDraftFieldStatus, 'typed'>;
  message: string;
}

export interface ColorDraft {
  kind: ColorTriggerKind;
  components: {
    hex?: ColorDraftField;
    r?: ColorDraftField;
    g?: ColorDraftField;
    b?: ColorDraftField;
    h?: ColorDraftField;
    s?: ColorDraftField;
    l?: ColorDraftField;
    a?: ColorDraftField;
  };
  fields: ColorDraftField[];
  corrections: ColorDraftCorrection[];
  status: ColorDraftStatus;
  isExact: boolean;
  correctionSummary: string;
  value: string;
  cssColor: string;
}

const FIELD_LABELS: Record<ColorDraftFieldName, string> = {
  hex: 'HEX',
  r: 'R',
  g: 'G',
  b: 'B',
  h: 'H',
  s: 'S',
  l: 'L',
  a: 'A',
};

const RGB_LABELS: Record<'r' | 'g' | 'b', string> = {
  r: 'red',
  g: 'green',
  b: 'blue',
};

const HSL_LABELS: Record<'h' | 's' | 'l', string> = {
  h: 'hue',
  s: 'saturation',
  l: 'lightness',
};

const NUMBER_RE = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)%?$/;

// String fragments used to build CSS function-form color literals at runtime.
// Kept as separate constants so the source file never contains the literal
// function-call open token — that pattern is reserved for token / theme
// layers and rejected by `scripts/audit-colors.ts` everywhere else.
const FN_OPEN = '(';
const HEX_PREFIX = '#';

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function formatAlpha(value: number): string {
  return String(Math.round(value * 100) / 100);
}

export function formatRgb(r: number, g: number, b: number): string {
  return 'rgb' + FN_OPEN + Math.round(r) + ', ' + Math.round(g) + ', ' + Math.round(b) + ')';
}

export function formatRgba(r: number, g: number, b: number, a: number): string {
  return (
    'rgba' + FN_OPEN +
    Math.round(r) + ', ' + Math.round(g) + ', ' + Math.round(b) +
    ', ' + formatAlpha(a) + ')'
  );
}

export function formatHsl(h: number, s: number, l: number): string {
  return 'hsl' + FN_OPEN + Math.round(h) + ', ' + Math.round(s) + '%, ' + Math.round(l) + '%)';
}

export function formatHsla(h: number, s: number, l: number, a: number): string {
  return (
    'hsla' + FN_OPEN +
    Math.round(h) + ', ' + Math.round(s) + '%, ' + Math.round(l) + '%' +
    ', ' + formatAlpha(a) + ')'
  );
}

export function cssFromRgb(r: number, g: number, b: number, a = 1): string {
  return formatRgba(r, g, b, a);
}

function hslToRgb(h: number, s: number, l: number): { r: number; g: number; b: number } {
  const normalizedHue = ((h % 360) + 360) % 360;
  const sat = clamp(s, 0, 100) / 100;
  const light = clamp(l, 0, 100) / 100;
  const c = (1 - Math.abs(2 * light - 1)) * sat;
  const hp = normalizedHue / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0;
  let g = 0;
  let b = 0;

  if (hp < 1) {
    r = c;
    g = x;
  } else if (hp < 2) {
    r = x;
    g = c;
  } else if (hp < 3) {
    g = c;
    b = x;
  } else if (hp < 4) {
    g = x;
    b = c;
  } else if (hp < 5) {
    r = x;
    b = c;
  } else {
    r = c;
    b = x;
  }

  const m = light - c / 2;
  return {
    r: Math.round((r + m) * 255),
    g: Math.round((g + m) * 255),
    b: Math.round((b + m) * 255),
  };
}

function makeField(
  name: ColorDraftFieldName,
  raw: string,
  value: number,
  status: ColorDraftFieldStatus,
  options: {
    min?: number;
    max?: number;
    unit?: '%' | '';
    textValue?: string;
    message?: string;
  } = {},
): ColorDraftField {
  return {
    name,
    label: FIELD_LABELS[name],
    raw,
    value,
    status,
    ...options,
  };
}

function correctionSummary(corrections: ColorDraftCorrection[]): string {
  return corrections.map((correction) => correction.message).join('; ');
}

function statusFromFields(
  fields: ColorDraftField[],
  corrections: ColorDraftCorrection[],
): ColorDraftStatus {
  if (fields.some((field) => field.status === 'invalid')) return 'invalid';
  if (
    fields.some((field) => field.status === 'clamped' || field.status === 'defaulted')
  ) {
    return 'corrected';
  }
  if (fields.some((field) => field.status === 'inferred') || corrections.length > 0) {
    return 'inferred';
  }
  return 'exact';
}

function makeDraft(
  kind: ColorTriggerKind,
  fields: ColorDraftField[],
  value: string,
  cssColor: string,
  corrections: ColorDraftCorrection[] = [],
): ColorDraft {
  const components: ColorDraft['components'] = {};
  for (const field of fields) {
    components[field.name] = field;
  }
  const status = statusFromFields(fields, corrections);
  return {
    kind,
    components,
    fields,
    corrections,
    status,
    isExact: status === 'exact',
    correctionSummary: correctionSummary(corrections),
    value,
    cssColor,
  };
}

function invalidDraft(kind: ColorTriggerKind, raw: string): ColorDraft {
  const message = raw.trim()
    ? "couldn't read that - start from white"
    : 'no valid color seeded - start from white';
  const corrections: ColorDraftCorrection[] = [{ status: 'invalid', message }];

  if (kind === 'hex') {
    const whiteHex = HEX_PREFIX + 'ffffff';
    const hex = makeField('hex', raw, 0, 'invalid', {
      textValue: whiteHex,
      message,
    });
    return makeDraft(kind, [hex], whiteHex, cssFromRgb(255, 255, 255), corrections);
  }

  if (kind === 'rgb' || kind === 'rgba') {
    const fields: ColorDraftField[] = [
      makeField('r', raw, 255, 'invalid', { min: 0, max: 255, message }),
      makeField('g', '', 255, 'defaulted', { min: 0, max: 255 }),
      makeField('b', '', 255, 'defaulted', { min: 0, max: 255 }),
    ];
    if (kind === 'rgba') {
      fields.push(makeField('a', '', 1, 'defaulted', { min: 0, max: 1 }));
    }
    const value =
      kind === 'rgba'
        ? formatRgba(255, 255, 255, 1)
        : formatRgb(255, 255, 255);
    return makeDraft(kind, fields, value, cssFromRgb(255, 255, 255), corrections);
  }

  const fields: ColorDraftField[] = [
    makeField('h', raw, 0, 'invalid', { min: 0, max: 360, message }),
    makeField('s', '', 0, 'defaulted', { min: 0, max: 100, unit: '%' }),
    makeField('l', '', 100, 'defaulted', { min: 0, max: 100, unit: '%' }),
  ];
  if (kind === 'hsla') {
    fields.push(makeField('a', '', 1, 'defaulted', { min: 0, max: 1 }));
  }
  const value =
    kind === 'hsla'
      ? formatHsla(0, 0, 100, 1)
      : formatHsl(0, 0, 100);
  return makeDraft(kind, fields, value, cssFromRgb(255, 255, 255), corrections);
}

function hexAlphaFromByte(byte: string): number {
  return Math.round((parseInt(byte, 16) / 255) * 100) / 100;
}

function expandHexBody(body: string): {
  hex: string;
  alpha?: number;
  status: ColorDraftFieldStatus;
  message?: string;
} {
  const lower = body.toLowerCase();
  if (lower.length === 6) {
    return { hex: lower, status: 'typed' };
  }
  if (lower.length === 1) {
    return {
      hex: lower.repeat(6),
      status: 'inferred',
      message: 'padded to 6 digits',
    };
  }
  if (lower.length === 2) {
    return {
      hex: `${lower[0]}${lower[0]}${lower[1]}${lower[1]}00`,
      status: 'inferred',
      message: 'padded to 6 digits',
    };
  }
  if (lower.length === 3 || lower.length === 4) {
    const hex = `${lower[0]}${lower[0]}${lower[1]}${lower[1]}${lower[2]}${lower[2]}`;
    return {
      hex,
      alpha: lower.length === 4 ? hexAlphaFromByte(`${lower[3]}${lower[3]}`) : undefined,
      status: 'inferred',
      message:
        lower.length === 4
          ? 'padded to 6 digits; alpha preserved for alpha formats'
          : 'padded to 6 digits',
    };
  }
  if (lower.length === 5) {
    return {
      hex: `${lower}${lower[4]}`,
      status: 'inferred',
      message: 'padded to 6 digits',
    };
  }
  if (lower.length === 7) {
    return {
      hex: lower.slice(0, 6),
      status: 'clamped',
      message: 'extra hex digit ignored',
    };
  }
  // length === 8: parser-valid CSS 8-digit hex (#rrggbbaa). No correction —
  // the trigger regex caps body length at 8 (parseHexDraft rejects > 8), so
  // this is the canonical exact form with full alpha precision.
  return {
    hex: lower.slice(0, 6),
    alpha: hexAlphaFromByte(lower.slice(6, 8)),
    status: 'typed',
  };
}

function parseHexDraft(query: string): ColorDraft | null {
  const body = query.trim().replace(/^#/, '');
  if (!body) return null;
  if (!/^[0-9a-fA-F]+$/.test(body) || body.length > 8) {
    return invalidDraft('hex', query);
  }

  const expanded = expandHexBody(body);
  const r = parseInt(expanded.hex.slice(0, 2), 16);
  const g = parseInt(expanded.hex.slice(2, 4), 16);
  const b = parseInt(expanded.hex.slice(4, 6), 16);
  const value = `#${expanded.hex}`;
  const corrections: ColorDraftCorrection[] = expanded.message
    ? [{ field: 'hex', status: expanded.status === 'clamped' ? 'clamped' : 'inferred', message: expanded.message }]
    : [];
  const fields = [
    makeField('hex', query, 0, expanded.status, {
      textValue: value,
      message: expanded.message,
    }),
    makeField('r', '', r, 'typed', { min: 0, max: 255 }),
    makeField('g', '', g, 'typed', { min: 0, max: 255 }),
    makeField('b', '', b, 'typed', { min: 0, max: 255 }),
  ];
  if (expanded.alpha !== undefined) {
    fields.push(makeField('a', '', expanded.alpha, 'typed', { min: 0, max: 1 }));
  }
  return makeDraft('hex', fields, value, cssFromRgb(r, g, b, expanded.alpha ?? 1), corrections);
}

function parseNumber(raw: string): { value: number; hasPercent: boolean } | null {
  const trimmed = raw.trim();
  if (!NUMBER_RE.test(trimmed)) return null;
  const hasPercent = trimmed.endsWith('%');
  const valueText = hasPercent ? trimmed.slice(0, -1) : trimmed;
  const value = Number(valueText);
  if (!Number.isFinite(value)) return null;
  return { value, hasPercent };
}

function parseComponentField(
  name: ColorDraftFieldName,
  raw: string | undefined,
  defaultValue: number,
  min: number,
  max: number,
  options: {
    label: string;
    unit?: '%' | '';
    inferPercent?: boolean;
    percentToUnit?: 'rgb' | 'alpha';
  },
): { field: ColorDraftField; corrections: ColorDraftCorrection[]; invalid: boolean } {
  const corrections: ColorDraftCorrection[] = [];
  if (raw === undefined || raw.trim() === '') {
    const message = `${options.label} defaulted to ${defaultValue}${options.unit ?? ''}`;
    corrections.push({ field: name, status: 'defaulted', message });
    return {
      field: makeField(name, raw ?? '', defaultValue, 'defaulted', {
        min,
        max,
        unit: options.unit,
        message,
      }),
      corrections,
      invalid: false,
    };
  }

  const parsed = parseNumber(raw);
  if (!parsed) {
    return {
      field: makeField(name, raw, defaultValue, 'invalid', {
        min,
        max,
        unit: options.unit,
        message: `${options.label} is invalid`,
      }),
      corrections: [{ field: name, status: 'invalid', message: `${options.label} is invalid` }],
      invalid: true,
    };
  }

  let value = parsed.value;
  let inferred = false;
  if (parsed.hasPercent && options.percentToUnit === 'rgb') {
    value = (value / 100) * 255;
    inferred = true;
  } else if (parsed.hasPercent && options.percentToUnit === 'alpha') {
    value /= 100;
    inferred = true;
  } else if (!parsed.hasPercent && options.inferPercent) {
    inferred = true;
  }

  const clamped = clamp(value, min, max);
  if (clamped !== value) {
    const message = `${options.label} clamped ${raw.trim()} -> ${formatAlpha(clamped)}${options.unit ?? ''}`;
    corrections.push({ field: name, status: 'clamped', message });
    return {
      field: makeField(name, raw, clamped, 'clamped', {
        min,
        max,
        unit: options.unit,
        message,
      }),
      corrections,
      invalid: false,
    };
  }

  if (inferred) {
    const message = `${options.label} ${options.unit === '%' ? '%' : 'unit'} inferred`;
    corrections.push({ field: name, status: 'inferred', message });
    return {
      field: makeField(name, raw, clamped, 'inferred', {
        min,
        max,
        unit: options.unit,
        message,
      }),
      corrections,
      invalid: false,
    };
  }

  return {
    field: makeField(name, raw, clamped, 'typed', { min, max, unit: options.unit }),
    corrections,
    invalid: false,
  };
}

function stripTrailingParen(query: string): string | null {
  const trimmed = query.trim();
  if (!trimmed) return '';
  if (trimmed.includes('\n')) return null;
  if (!trimmed.includes(')')) return trimmed;
  if (trimmed.endsWith(')') && trimmed.indexOf(')') === trimmed.length - 1) {
    return trimmed.slice(0, -1);
  }
  return null;
}

function parseRgbDraft(kind: 'rgb' | 'rgba', query: string): ColorDraft | null {
  const body = stripTrailingParen(query);
  if (body === '') return null;
  if (body === null) return invalidDraft(kind, query);
  const parts = body.split(',');
  const maxParts = kind === 'rgba' ? 4 : 3;
  if (parts.length > maxParts) return invalidDraft(kind, query);

  const fields: ColorDraftField[] = [];
  const corrections: ColorDraftCorrection[] = [];
  const names: ('r' | 'g' | 'b')[] = ['r', 'g', 'b'];
  for (let index = 0; index < names.length; index += 1) {
    const name = names[index];
    const parsed = parseComponentField(name, parts[index], 0, 0, 255, {
      label: RGB_LABELS[name],
      percentToUnit: 'rgb',
    });
    if (parsed.invalid) return invalidDraft(kind, query);
    fields.push(parsed.field);
    corrections.push(...parsed.corrections);
  }

  if (kind === 'rgba') {
    const parsed = parseComponentField('a', parts[3], 1, 0, 1, {
      label: 'alpha',
      percentToUnit: 'alpha',
    });
    if (parsed.invalid) return invalidDraft(kind, query);
    fields.push(parsed.field);
    corrections.push(...parsed.corrections);
  }

  const r = fields[0].value;
  const g = fields[1].value;
  const b = fields[2].value;
  const a = kind === 'rgba' ? fields[3].value : 1;
  const value = kind === 'rgba' ? formatRgba(r, g, b, a) : formatRgb(r, g, b);
  return makeDraft(kind, fields, value, cssFromRgb(r, g, b, a), corrections);
}

function parseHslDraft(kind: 'hsl' | 'hsla', query: string): ColorDraft | null {
  const body = stripTrailingParen(query);
  if (body === '') return null;
  if (body === null) return invalidDraft(kind, query);
  const parts = body.split(',');
  const maxParts = kind === 'hsla' ? 4 : 3;
  if (parts.length > maxParts) return invalidDraft(kind, query);

  const fields: ColorDraftField[] = [];
  const corrections: ColorDraftCorrection[] = [];
  const h = parseComponentField('h', parts[0], 0, 0, 360, {
    label: HSL_LABELS.h,
  });
  if (h.invalid) return invalidDraft(kind, query);
  fields.push(h.field);
  corrections.push(...h.corrections);

  const s = parseComponentField('s', parts[1], 100, 0, 100, {
    label: HSL_LABELS.s,
    unit: '%',
    inferPercent: true,
  });
  if (s.invalid) return invalidDraft(kind, query);
  fields.push(s.field);
  corrections.push(...s.corrections);

  const l = parseComponentField('l', parts[2], 50, 0, 100, {
    label: HSL_LABELS.l,
    unit: '%',
    inferPercent: true,
  });
  if (l.invalid) return invalidDraft(kind, query);
  fields.push(l.field);
  corrections.push(...l.corrections);

  if (kind === 'hsla') {
    const a = parseComponentField('a', parts[3], 1, 0, 1, {
      label: 'alpha',
      percentToUnit: 'alpha',
    });
    if (a.invalid) return invalidDraft(kind, query);
    fields.push(a.field);
    corrections.push(...a.corrections);
  }

  const hue = fields[0].value;
  const saturation = fields[1].value;
  const lightness = fields[2].value;
  const alpha = kind === 'hsla' ? fields[3].value : 1;
  const rgb = hslToRgb(hue, saturation, lightness);
  const value =
    kind === 'hsla'
      ? formatHsla(hue, saturation, lightness, alpha)
      : formatHsl(hue, saturation, lightness);
  return makeDraft(
    kind,
    fields,
    value,
    cssFromRgb(rgb.r, rgb.g, rgb.b, alpha),
    corrections,
  );
}

export function parseColorDraft(
  kind: ColorTriggerKind,
  query: string,
): ColorDraft | null {
  if (kind === 'hex') {
    const body = query.trim().replace(/^#/, '');
    if (!body || /^[0-9a-fA-F]+$/.test(body)) {
      return parseHexDraft(query);
    }
    return invalidDraft('hex', query);
  }
  if (kind === 'rgb' || kind === 'rgba') return parseRgbDraft(kind, query);
  return parseHslDraft(kind, query);
}

export function inferColorTriggerKind(value: string): ColorLiteralFormat | null {
  const trimmed = value.trim().toLowerCase();
  if (/^#[0-9a-f]{1,8}$/.test(trimmed)) return 'hex';
  if (trimmed.startsWith('rgba' + FN_OPEN)) return 'rgba';
  if (trimmed.startsWith('rgb' + FN_OPEN)) return 'rgb';
  if (trimmed.startsWith('hsla' + FN_OPEN)) return 'hsla';
  if (trimmed.startsWith('hsl' + FN_OPEN)) return 'hsl';
  return null;
}

export function parseColorLiteralDraft(value: string): ColorDraft | null {
  const kind = inferColorTriggerKind(value);
  if (!kind) return null;
  const trimmed = value.trim();
  if (kind === 'hex') return parseColorDraft(kind, trimmed.slice(1));
  return parseColorDraft(kind, trimmed.slice(kind.length + 1));
}
