// ported-from: packages/desktop/src/renderer/editor/utils/colorPickerState.ts @ 762abb777
import {
  type ColorDraft,
  type ColorDraftField,
  type ColorDraftFieldName,
  type ColorLiteralFormat,
  type ColorPickerFormat,
  formatAlpha,
  formatHsla,
  formatRgba,
  parseColorDraft,
  parseColorLiteralDraft,
} from './colorDraftParser';

export type { ColorLiteralFormat, ColorTriggerKind, ColorPickerFormat } from './colorDraftParser';

export interface ColorPickerState {
  h: number;
  s: number;
  v: number;
  a: number;
  format: ColorPickerFormat;
}

export type ColorPickerHsvaPatch = Partial<
  Pick<ColorPickerState, 'h' | 's' | 'v' | 'a'>
>;

export interface ColorPickerOutput {
  literal: string;
  cssColor: string;
  fields: ColorDraftField[];
  showAlpha: boolean;
  format: ColorPickerFormat;
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

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function toHexByte(value: number): string {
  return Math.round(clamp(value, 0, 255)).toString(16).padStart(2, '0');
}

function makeField(
  name: ColorDraftFieldName,
  raw: string,
  value: number,
  options: {
    min?: number;
    max?: number;
    unit?: '%' | '';
    textValue?: string;
  } = {},
): ColorDraftField {
  return {
    name,
    label: FIELD_LABELS[name],
    raw,
    value,
    status: 'typed',
    ...options,
  };
}

function hsvToRgb(
  h: number,
  s: number,
  v: number,
): { r: number; g: number; b: number } {
  const hue = ((h % 360) + 360) % 360;
  const sat = clamp(s, 0, 100) / 100;
  const val = clamp(v, 0, 100) / 100;
  const c = val * sat;
  const hp = hue / 60;
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

  const m = val - c;
  return {
    r: Math.round((r + m) * 255),
    g: Math.round((g + m) * 255),
    b: Math.round((b + m) * 255),
  };
}

function rgbToHsv(
  r: number,
  g: number,
  b: number,
  a = 1,
): ColorPickerState {
  const red = clamp(r, 0, 255) / 255;
  const green = clamp(g, 0, 255) / 255;
  const blue = clamp(b, 0, 255) / 255;
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const delta = max - min;
  let h = 0;

  if (delta !== 0) {
    if (max === red) {
      h = 60 * (((green - blue) / delta) % 6);
    } else if (max === green) {
      h = 60 * ((blue - red) / delta + 2);
    } else {
      h = 60 * ((red - green) / delta + 4);
    }
  }

  if (h < 0) h += 360;
  return {
    h,
    s: max === 0 ? 0 : (delta / max) * 100,
    v: max * 100,
    a: clamp(a, 0, 1),
    format: 'rgba',
  };
}

function hsvToHsl(
  h: number,
  s: number,
  v: number,
): { h: number; s: number; l: number } {
  const sat = clamp(s, 0, 100) / 100;
  const val = clamp(v, 0, 100) / 100;
  const light = val * (1 - sat / 2);
  const hslS =
    light === 0 || light === 1
      ? 0
      : (val - light) / Math.min(light, 1 - light);
  return {
    h: clamp(h, 0, 360),
    s: hslS * 100,
    l: light * 100,
  };
}

function hslToHsv(
  h: number,
  s: number,
  l: number,
  a = 1,
): ColorPickerState {
  const sat = clamp(s, 0, 100) / 100;
  const light = clamp(l, 0, 100) / 100;
  const v = light + sat * Math.min(light, 1 - light);
  const hsvS = v === 0 ? 0 : 2 * (1 - light / v);
  return {
    h: clamp(h, 0, 360),
    s: hsvS * 100,
    v: v * 100,
    a: clamp(a, 0, 1),
    format: 'hsla',
  };
}

function numberFromField(field: ColorDraftField | undefined, fallback: number): number {
  return field?.value ?? fallback;
}

function stateFromDraft(seed: ColorDraft, format: ColorPickerFormat): ColorPickerState {
  if (seed.kind === 'hsl' || seed.kind === 'hsla') {
    const next = hslToHsv(
      numberFromField(seed.components.h, 0),
      numberFromField(seed.components.s, 100),
      numberFromField(seed.components.l, 50),
      numberFromField(seed.components.a, 1),
    );
    return { ...next, format };
  }

  const next = rgbToHsv(
    numberFromField(seed.components.r, 255),
    numberFromField(seed.components.g, 255),
    numberFromField(seed.components.b, 255),
    numberFromField(seed.components.a, 1),
  );
  return { ...next, format };
}

export function normalizeColorPickerFormat(
  format: ColorLiteralFormat | ColorPickerFormat,
): ColorPickerFormat {
  if (format === 'rgb') return 'rgba';
  if (format === 'hsl') return 'hsla';
  return format;
}

export function createColorPickerState(
  seed: ColorDraft | null,
  initialFormat: ColorLiteralFormat | ColorPickerFormat,
): ColorPickerState {
  const format = normalizeColorPickerFormat(initialFormat);
  if (seed) {
    return stateFromDraft(seed, format);
  }

  if (format === 'hex') {
    return { h: 0, s: 0, v: 100, a: 1, format };
  }
  return { h: 0, s: 100, v: 100, a: 1, format };
}

export function createColorPickerStateFromLiteral(
  value: string,
): ColorPickerState | null {
  const seed = parseColorLiteralDraft(value);
  if (!seed) return null;
  return createColorPickerState(seed, seed.kind);
}

export function setColorPickerFormat(
  state: ColorPickerState,
  format: ColorPickerFormat,
): ColorPickerState {
  return { ...state, format };
}

export function setColorPickerHsva(
  state: ColorPickerState,
  patch: ColorPickerHsvaPatch,
): ColorPickerState {
  return {
    ...state,
    h: patch.h === undefined ? state.h : clamp(patch.h, 0, 360),
    s: patch.s === undefined ? state.s : clamp(patch.s, 0, 100),
    v: patch.v === undefined ? state.v : clamp(patch.v, 0, 100),
    a: patch.a === undefined ? state.a : clamp(patch.a, 0, 1),
  };
}

function parseInputNumber(raw: string): number | null {
  const trimmed = raw.trim();
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)%?$/.test(trimmed)) return null;
  const value = Number(trimmed.endsWith('%') ? trimmed.slice(0, -1) : trimmed);
  return Number.isFinite(value) ? value : null;
}

export function commitColorPickerInput(
  state: ColorPickerState,
  field: ColorDraftFieldName,
  raw: string,
): ColorPickerState {
  if (field === 'hex') {
    const draft = parseColorDraft('hex', raw.replace(/^#/, ''));
    if (!draft || draft.status === 'invalid') return state;
    const next = stateFromDraft(draft, state.format);
    return {
      ...next,
      a: draft.components.a?.value ?? state.a,
    };
  }

  const value = parseInputNumber(raw);
  if (value === null) return state;

  if (field === 'a') {
    return setColorPickerHsva(state, { a: clamp(value, 0, 1) });
  }

  if (field === 'r' || field === 'g' || field === 'b') {
    const rgb = hsvToRgb(state.h, state.s, state.v);
    const nextRgb = {
      ...rgb,
      [field]: clamp(value, 0, 255),
    };
    const next = rgbToHsv(nextRgb.r, nextRgb.g, nextRgb.b, state.a);
    return { ...next, format: state.format };
  }

  const hsl = hsvToHsl(state.h, state.s, state.v);
  const nextHsl = {
    ...hsl,
    [field]: field === 'h' ? clamp(value, 0, 360) : clamp(value, 0, 100),
  };
  const next = hslToHsv(nextHsl.h, nextHsl.s, nextHsl.l, state.a);
  return { ...next, format: state.format };
}

export function commitColorPickerLiteral(
  state: ColorPickerState,
  raw: string,
): ColorPickerState {
  const trimmed = raw.trim();
  if (!trimmed) return state;

  let draft: ColorDraft | null = null;
  if (state.format === 'hex') {
    draft = parseColorDraft('hex', trimmed.replace(/^#/, ''));
  } else if (trimmed.toLowerCase().startsWith(state.format + '(')) {
    draft = parseColorDraft(state.format, trimmed.slice(state.format.length + 1));
  } else {
    draft = parseColorLiteralDraft(trimmed);
  }

  if (!draft || draft.status === 'invalid') {
    return state;
  }

  return stateFromDraft(draft, normalizeColorPickerFormat(draft.kind));
}

function literalForState(state: ColorPickerState): string {
  const rgb = hsvToRgb(state.h, state.s, state.v);
  if (state.format === 'hex') {
    // HEX output is always the 6-digit `#rrggbb` form. Moss does not support
    // 8-digit `#rrggbbaa`. The HEX tab hides the alpha control; if alpha needs
    // preserving the user picks the rgba/hsla format instead.
    return `#${toHexByte(rgb.r)}${toHexByte(rgb.g)}${toHexByte(rgb.b)}`;
  }
  if (state.format === 'rgba') {
    return formatRgba(rgb.r, rgb.g, rgb.b, state.a);
  }

  const hsl = hsvToHsl(state.h, state.s, state.v);
  return formatHsla(hsl.h, hsl.s, hsl.l, state.a);
}

function fieldsForState(state: ColorPickerState): ColorDraftField[] {
  const literal = literalForState(state);
  const rgb = hsvToRgb(state.h, state.s, state.v);
  if (state.format === 'hex') {
    return [makeField('hex', literal, 0, { textValue: literal })];
  }
  if (state.format === 'rgba') {
    const fields = [
      makeField('r', String(rgb.r), rgb.r, { min: 0, max: 255 }),
      makeField('g', String(rgb.g), rgb.g, { min: 0, max: 255 }),
      makeField('b', String(rgb.b), rgb.b, { min: 0, max: 255 }),
    ];
    fields.push(makeField('a', formatAlpha(state.a), state.a, { min: 0, max: 1 }));
    return fields;
  }

  const hsl = hsvToHsl(state.h, state.s, state.v);
  const fields = [
    makeField('h', String(Math.round(hsl.h)), Math.round(hsl.h), {
      min: 0,
      max: 360,
    }),
    makeField('s', String(Math.round(hsl.s)), Math.round(hsl.s), {
      min: 0,
      max: 100,
      unit: '%',
    }),
    makeField('l', String(Math.round(hsl.l)), Math.round(hsl.l), {
      min: 0,
      max: 100,
      unit: '%',
    }),
  ];
  fields.push(makeField('a', formatAlpha(state.a), state.a, { min: 0, max: 1 }));
  return fields;
}

export function getColorPickerOutput(state: ColorPickerState): ColorPickerOutput {
  const rgb = hsvToRgb(state.h, state.s, state.v);
  return {
    literal: literalForState(state),
    cssColor: formatRgba(rgb.r, rgb.g, rgb.b, state.a),
    fields: fieldsForState(state),
    showAlpha: state.format === 'rgba' || state.format === 'hsla',
    format: state.format,
  };
}
