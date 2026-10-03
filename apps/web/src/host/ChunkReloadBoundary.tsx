// One hard reload when a lazy chunk fails to load, as after a redeploy (L§4.1 stale chunks). Any other error, or
// a second failure within the window, is rethrown: a chunk error on a fresh load is a different bug.
import { Component, type ReactNode } from 'react';
import { hasDocSessions, hasUnacked } from './collab/unacked.ts';
import { refuseInput } from './refusal.ts';
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
  if (hasUnacked() || hasDocSessions()) return false;
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

/** A failed fetch is not proof of a stale chunk. A live editor never reloads automatically. */
export async function recoverChunk(): Promise<boolean> {
  if (hasDocSessions() || hasUnacked()) {
    refuseInput('A part of the app could not load. Your edits are kept here; try the action again when connected.');
    return false;
  }
  try {
    const response = await fetch('/api/version', { cache: 'no-store', signal: AbortSignal.timeout(5_000) });
    if (!response.ok) return false;
    return reloadOnce();
  } catch {
    return false;
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('vite:preloadError', (event) => {
    event.preventDefault();
    void recoverChunk();
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
    if (isChunkLoadError(error)) void recoverChunk().then((reloading) => this.setState({ reloading }));
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children;
    if (!isChunkLoadError(this.state.error)) throw this.state.error;
    if (this.state.reloading) return this.props.fallback;
    return <div role="status" className="flex h-full flex-col items-center justify-center gap-3 bg-surface-panel text-sm text-ink-muted">
      <p>The app could not finish loading. Check your connection and try again.</p>
      <button type="button" className="underline" onClick={() => void recoverChunk()}>Retry</button>
    </div>;
  }
}
