// ported-from: packages/desktop/src/renderer/editor/plugins/code-block/themes.ts @ 762abb777
/**
 * Code block syntax highlighting themes.
 *
 * Each theme maps semantic token roles to CSS color values,
 * plus background and header colors for the container chrome.
 */
import { CODE_THEME_COLORS } from '../../colors';

export interface CodeBlockTheme {
  id: string;
  label: string;
  colors: {
    bg: string;
    header: string;
    border: string;
    text: string;
    comment: string;
    punctuation: string;
    property: string;
    string: string;
    operator: string;
    keyword: string;
    function: string;
    variable: string;
  };
}

export const CODE_THEMES: CodeBlockTheme[] = [
  {
    id: 'one-light',
    label: 'One Light',
    colors: CODE_THEME_COLORS.oneLight,
  },
  {
    id: 'solarized',
    label: 'Solarized',
    colors: CODE_THEME_COLORS.solarized,
  },
  {
    id: 'one-dark',
    label: 'One Dark',
    colors: CODE_THEME_COLORS.oneDark,
  },
  {
    id: 'catppuccin-mocha',
    label: 'Catppuccin Mocha',
    colors: CODE_THEME_COLORS.catppuccinMocha,
  },
];

export const DEFAULT_THEME = 'one-light';

export function getThemeById(id: string): CodeBlockTheme {
  return CODE_THEMES.find((t) => t.id === id) ?? CODE_THEMES.find((t) => t.id === DEFAULT_THEME)!;
}

export function getThemeLabel(id: string): string {
  return getThemeById(id).label;
}
