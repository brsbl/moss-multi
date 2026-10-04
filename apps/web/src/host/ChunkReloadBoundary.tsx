// One hard reload when a lazy chunk fails to load, as after a redeploy (L§4.1 stale chunks). Any other error, or
// a second failure within the window, is rethrown: a chunk error on a fresh load is a different bug.
import { Component, type ReactNode } from 'react';
import { reloadDocument } from './navigation.ts';

const RELOAD_KEY = 'moss_chunk_reload_at';
const RELOAD_WINDOW_MS = 10_000;

export function isChunkLoadError(error: unknown): boolean {
  if (!error) return false;
  const { name, message } = error as { name?: string; message?: string };
  if (name === 'ChunkLoadError') return true;
  return /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|Unable to preload CSS/i.test(
    String(message ?? error),
  );
}

/** Reloads unless this tab already did within the window; returns whether it reloads. */
export function reloadOnce(now = Date.now(), storage: Pick<Storage, 'getItem' | 'setItem'> | null = safeSession(), reload = reloadDocument): boolean {
  const last = Number(storage?.getItem(RELOAD_KEY) ?? 0);
  if (now - last < RELOAD_WINDOW_MS) return false;
  storage?.setItem(RELOAD_KEY, String(now));
  reload();
  return true;
}

function safeSession(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

if (typeof window !== 'undefined') {
  // Vite's preload helper reports a failed chunk preload here before the import rejects.
  window.addEventListener('vite:preloadError', (event) => {
    if (reloadOnce()) event.preventDefault();
  });
}

interface Props {
  children: ReactNode;
  fallback: ReactNode;
}

export class ChunkReloadBoundary extends Component<Props, { error: unknown; reloading: boolean }> {
  state = { error: null as unknown, reloading: false };

  static getDerivedStateFromError(error: unknown) {
    return { error };
  }

  componentDidCatch(error: unknown): void {
    if (isChunkLoadError(error)) this.setState({ reloading: reloadOnce() });
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children;
    if (!isChunkLoadError(this.state.error) || !this.state.reloading) throw this.state.error;
    return this.props.fallback;
  }
}
