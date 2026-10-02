// ported-from: packages/shared/src/lib/colors.ts @ 762abb777
/**
 * Design token colors for use in JS/TS files.
 * These values must stay in sync with packages/shared/tailwind.config.ts
 */

export const MOSS_DESIGN_COLORS = {
  beige: {
    50: 'var(--surface-canvas)',
    100: 'var(--surface-panel)',
    200: 'var(--border-subtle)',
    300: 'var(--border-default)'
  },
  ink: {
    DEFAULT: 'var(--ink-default)',
    accent: 'var(--ink-accent)',
    muted: 'var(--ink-muted)'
  },
  moss: {
    DEFAULT: 'var(--accent-brand)'
  }
} as const;

/** Classic — high hue separation, bold and recognizable */
export const CHART_PALETTE_VIBRANT = [
  'var(--chart-cb-008fd5)',
  'var(--chart-cb-fc4f30)',
  'var(--chart-cb-e5ae38)',
  'var(--chart-cb-6d904f)',
  'var(--chart-cb-8b8b8b)',
  'var(--chart-cb-810f7c)',
] as const;

/** Accessible — colorblind-safe (Wong palette) */
export const CHART_PALETTE_COOL = [
  'var(--chart-cb-0072b2)',
  'var(--chart-cb-d55e00)',
  'var(--chart-cb-e69f00)',
  'var(--chart-cb-009e73)',
  'var(--chart-cb-56b4e9)',
  'var(--chart-cb-cc79a7)',
  'var(--chart-cb-f0e442)',
] as const;

/** Mono — grayscale for minimal distraction */
export const CHART_PALETTE_EARTHY = [
  'var(--chart-cb-2b2b2b)',
  'var(--chart-cb-636363)',
  'var(--chart-cb-969696)',
  'var(--chart-cb-bdbdbd)',
  'var(--chart-tick)',
  'var(--chart-cb-7a7a7a)',
  'var(--chart-cb-adadad)',
] as const;

export const chartColors = {
  grid: 'var(--chart-cb-e0e0e0)',
  tick: 'var(--chart-cb-999999)',
  selection: 'var(--surface-note-hover)'
} as const;
