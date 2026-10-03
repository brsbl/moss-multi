// moss's theme and plugins (packages/desktop/tailwind.config.ts @ 762abb777) over every file that writes a
// className into the viewer bundle. Not in tsconfig: moss's config imports its theme state (jotai, React).
import type { Config } from 'tailwindcss';
import mossShared from '../../vendor/moss/packages/shared/tailwind.config.ts';

export default {
  content: {
    relative: true,
    files: [
      '../../vendor/moss/packages/desktop/src/renderer/**/*.{ts,tsx,html}',
      '../../vendor/moss/packages/desktop/src/common/**/*.{ts,tsx}',
      '../../vendor/moss/packages/shared/src/**/*.{ts,tsx}',
      './src/**/*.{ts,tsx}',
    ],
  },
  theme: mossShared.theme,
  plugins: mossShared.plugins,
} satisfies Config;
