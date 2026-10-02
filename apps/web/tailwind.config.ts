import type { Config } from 'tailwindcss';

// T0.5a adds moss's shared config and the vendored renderer globs (A§4.3).
export default {
  content: ['./src/**/*.{ts,tsx}'],
} satisfies Config;
