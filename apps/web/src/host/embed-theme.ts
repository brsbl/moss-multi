// X post embeds' theme per note (T3.8). Moss at the pin loads every post with `theme=light`.
export type EmbedTheme = 'light' | 'dark';

export function setEmbedTheme(_noteId: string, _theme: EmbedTheme | null): void {}

export const embedThemeFor = (_noteId: string | null | undefined): EmbedTheme => 'light';
