// ported-from: packages/shared/src/state/theme.ts @ 762abb777
import { useEffect } from 'react';
import { atom, useAtomValue, useSetAtom } from 'jotai';

/**
 * Theme choice persistence is split by runtime:
 * desktop uses the workspace settings file via typed Electron IPC as the
 * durable source of truth, while web uses localStorage as its durable source.
 * Desktop also mirrors the choice to localStorage as a fast FOUC boot cache.
 */

export type ThemeChoice = 'system' | 'light' | 'dark';
export type EffectiveTheme = 'light' | 'dark';

const THEME_STORAGE_KEY = 'moss_theme';
const THEME_MEDIA_QUERY = '(prefers-color-scheme: dark)';
const DEFAULT_THEME_CHOICE: ThemeChoice = 'system';

type ThemeSettingsApi = {
  getTheme?: () => Promise<ThemeChoice>;
  setTheme?: (theme: ThemeChoice) => Promise<void>;
};

type ThemeWindow = Window & {
  electronAPI?: {
    settings?: ThemeSettingsApi;
  };
};

function isThemeChoice(value: unknown): value is ThemeChoice {
  return value === 'system' || value === 'light' || value === 'dark';
}

function normalizeThemeChoice(value: unknown): ThemeChoice {
  return isThemeChoice(value) ? value : DEFAULT_THEME_CHOICE;
}

function getLocalStorage(): Storage | null {
  if (typeof window === 'undefined') {
    return null;
  }

  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function readLocalThemeChoice(): ThemeChoice {
  const storage = getLocalStorage();
  if (!storage) {
    return DEFAULT_THEME_CHOICE;
  }

  try {
    return normalizeThemeChoice(storage.getItem(THEME_STORAGE_KEY));
  } catch {
    return DEFAULT_THEME_CHOICE;
  }
}

function writeLocalThemeChoice(theme: ThemeChoice): void {
  const storage = getLocalStorage();
  if (!storage) {
    return;
  }

  try {
    storage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Ignore storage issues; the in-memory atom still drives the current UI.
  }
}

function getElectronThemeSettings(): ThemeSettingsApi | undefined {
  if (typeof window === 'undefined') {
    return undefined;
  }

  return (window as ThemeWindow).electronAPI?.settings;
}

function readSystemTheme(): EffectiveTheme {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return 'light';
  }

  try {
    return window.matchMedia(THEME_MEDIA_QUERY).matches ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

const settingsThemeValueAtom = atom<ThemeChoice>(readLocalThemeChoice());

settingsThemeValueAtom.onMount = (setThemeChoice) => {
  const settings = getElectronThemeSettings();
  if (!settings?.getTheme) {
    return;
  }

  let mounted = true;
  void settings.getTheme()
    .then((theme) => {
      if (mounted) {
        setThemeChoice(normalizeThemeChoice(theme));
      }
    })
    .catch((error) => {
      console.warn('[theme] Failed to load persisted theme:', error);
    });

  return () => {
    mounted = false;
  };
};

export const settingsThemeAtom = atom(
  (get) => get(settingsThemeValueAtom),
  async (get, set, update: ThemeChoice | ((previous: ThemeChoice) => ThemeChoice)) => {
    const previous = get(settingsThemeValueAtom);
    const next = normalizeThemeChoice(
      typeof update === 'function' ? update(previous) : update
    );

    set(settingsThemeValueAtom, next);
    writeLocalThemeChoice(next);

    const settings = getElectronThemeSettings();
    if (!settings?.setTheme) {
      return;
    }

    try {
      await settings.setTheme(next);
    } catch (error) {
      console.warn('[theme] Failed to persist theme:', error);
    }
  }
);

export const themeChoiceAtom = atom(
  (get) => get(settingsThemeAtom),
  (get, set, update: ThemeChoice | ((previous: ThemeChoice) => ThemeChoice)) => {
    const previous = get(settingsThemeAtom);
    return set(settingsThemeAtom, typeof update === 'function' ? update(previous) : update);
  }
);

const systemThemeAtom = atom<EffectiveTheme>(readSystemTheme());

export const effectiveThemeAtom = atom<EffectiveTheme>((get) => {
  const choice = get(themeChoiceAtom);
  return choice === 'system' ? get(systemThemeAtom) : choice;
});

export function useThemeEffect(): void {
  const themeChoice = useAtomValue(themeChoiceAtom);
  const effectiveTheme = useAtomValue(effectiveThemeAtom);
  const setSystemTheme = useSetAtom(systemThemeAtom);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return;
    }

    let mediaQuery: MediaQueryList;
    try {
      mediaQuery = window.matchMedia(THEME_MEDIA_QUERY);
    } catch {
      return;
    }
    const syncSystemTheme = () => {
      setSystemTheme(mediaQuery.matches ? 'dark' : 'light');
    };

    syncSystemTheme();
    if (typeof mediaQuery.addEventListener === 'function') {
      mediaQuery.addEventListener('change', syncSystemTheme);
      return () => mediaQuery.removeEventListener('change', syncSystemTheme);
    }

    mediaQuery.addListener(syncSystemTheme);
    return () => mediaQuery.removeListener(syncSystemTheme);
  }, [setSystemTheme]);

  useEffect(() => {
    writeLocalThemeChoice(themeChoice);

    if (typeof document === 'undefined') {
      return;
    }

    const root = document.documentElement;
    if (root.dataset.theme !== effectiveTheme) {
      root.dataset.theme = effectiveTheme;
    }
  }, [themeChoice, effectiveTheme]);
}
