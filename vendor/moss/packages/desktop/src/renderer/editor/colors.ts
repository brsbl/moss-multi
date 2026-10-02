// ported-from: packages/desktop/src/renderer/editor/colors.ts @ 762abb777
/** Indexed by `comment.color` (0 = user, 3 = agent, 4 = external). Slots 1
 *  and 2 are unused but kept as yellow fillers to preserve the index scheme
 *  for stored comments. */
export const COMMENT_CHALK_COLORS = [
  'var(--highlight-chalk-yellow)',
  'var(--highlight-chalk-yellow)',
  'var(--highlight-chalk-yellow)',
  'var(--highlight-chalk-green)',
  'var(--highlight-chalk-grey)',
] as const;

export const EDITOR_CHROME_COLORS = {
  chartLegendText: 'var(--code-syntax-24292e)',
  imageDropIndicator: 'var(--border-default)',
  imageDropLabelBackground: 'var(--surface-canvas-web)',
  sketchFill: 'var(--code-syntax-1a1a1a)',
} as const;

export const CODE_THEME_COLORS = {
  oneLight: {
    bg: 'var(--code-block-one-light-bg)',
    header: 'var(--code-block-one-light-header)',
    border: 'var(--code-block-one-light-border)',
    text: 'var(--code-block-one-light-text)',
    comment: 'var(--code-block-one-light-comment)',
    punctuation: 'var(--code-block-one-light-text)',
    property: 'var(--code-block-one-light-property)',
    string: 'var(--code-block-one-light-string)',
    operator: 'var(--code-block-one-light-operator)',
    keyword: 'var(--code-block-one-light-keyword)',
    function: 'var(--code-block-one-light-function)',
    variable: 'var(--code-block-one-light-variable)',
  },
  solarized: {
    bg: 'var(--code-block-solarized-bg)',
    header: 'var(--code-block-solarized-header)',
    border: 'var(--code-block-solarized-border)',
    text: 'var(--code-block-solarized-text)',
    comment: 'var(--code-block-solarized-comment)',
    punctuation: 'var(--code-block-solarized-punctuation)',
    property: 'var(--code-block-solarized-property)',
    string: 'var(--code-block-solarized-string)',
    operator: 'var(--code-block-solarized-operator)',
    keyword: 'var(--code-block-solarized-keyword)',
    function: 'var(--code-block-solarized-function)',
    variable: 'var(--code-block-solarized-variable)',
  },
  oneDark: {
    bg: 'var(--code-block-one-dark-bg)',
    header: 'var(--code-block-one-dark-header)',
    border: 'var(--code-block-one-dark-border)',
    text: 'var(--code-block-one-dark-text)',
    comment: 'var(--code-block-one-dark-comment)',
    punctuation: 'var(--code-block-one-dark-text)',
    property: 'var(--code-block-one-dark-property)',
    string: 'var(--code-block-one-dark-string)',
    operator: 'var(--code-block-one-dark-operator)',
    keyword: 'var(--code-block-one-dark-keyword)',
    function: 'var(--code-block-one-dark-function)',
    variable: 'var(--code-block-one-dark-variable)',
  },
  catppuccinMocha: {
    bg: 'var(--code-block-catppuccin-bg)',
    header: 'var(--code-block-catppuccin-header)',
    border: 'var(--code-block-catppuccin-border)',
    text: 'var(--code-block-catppuccin-text)',
    comment: 'var(--code-block-catppuccin-comment)',
    punctuation: 'var(--code-block-catppuccin-text)',
    property: 'var(--code-block-catppuccin-property)',
    string: 'var(--code-block-catppuccin-string)',
    operator: 'var(--code-block-catppuccin-operator)',
    keyword: 'var(--code-block-catppuccin-keyword)',
    function: 'var(--code-block-catppuccin-function)',
    variable: 'var(--code-block-catppuccin-variable)',
  },
} as const;
