// X post embeds' theme per note (T3.8; the embed-theme seam in TweetEmbedCard). Moss at the pin loads every post
// with `theme=light`, and so does apps/web; a host that themes its notes (the viewer) sets each note's theme here, and
// its posts re-render in it.
import { useSyncExternalStore } from 'react';

export type EmbedTheme = 'light' | 'dark';

const themes = new Map<string, EmbedTheme>();
const listeners = new Set<() => void>();

/** Sets the theme a note's posts load in; null returns it to moss's light. */
export function setEmbedTheme(noteId: string, theme: EmbedTheme | null): void {
  if ((themes.get(noteId) ?? null) === theme) return;
  if (theme) themes.set(noteId, theme);
  else themes.delete(noteId);
  for (const listener of listeners) listener();
}

export const embedThemeFor = (noteId: string | null | undefined): EmbedTheme => (noteId ? themes.get(noteId) : undefined) ?? 'light';

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useEmbedTheme(noteId: string | null | undefined): EmbedTheme {
  return useSyncExternalStore(subscribe, () => embedThemeFor(noteId), () => 'light');
}
