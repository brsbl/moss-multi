# Moss theme tokens

`tokens.css` is the source of truth for theme color custom properties. Import it before Tailwind's `@tailwind base` entry so later semantic Tailwind aliases can resolve `var(--token)` values during app startup.

Token names are semantic and omit a `color-` prefix:

- `--surface-*` for backgrounds and panels.
- `--ink-*` for text, icons, and foregrounds.
- `--accent-*` for brand, status, and action colors.
- `--border-*` for dividers, outlines, and rings.
- `--highlight-*` for editor/search highlights.
- Component-scoped names such as `--chart-*`, `--sketch-*`, `--action-tab-*`, and `--code-syntax-*` stay in their existing domain language.

Run `pnpm gen:tokens` after changing `tokens.css`. The generator refreshes `tokens.ts`, the `@moss/shared/themes` barrel, and the generated inventory in `docs/design-system/tokens.md`.

To add a theme, keep the light values in `:root` and add a sibling selector such as `[data-theme="dark"]` with the same token keys. Dark values are intentionally added in the later dark-palette phase, not in S5.
