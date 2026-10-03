import { createElement, lazy, useMemo, useState, type ComponentType } from 'react';
import { isChunkLoadError, recoverChunk } from './ChunkReloadBoundary.tsx';

/** Optional shell surfaces fail within their own Suspense slot, leaving the bound editor mounted. */
export function recoverableLazy<P extends object>(load: () => Promise<{ default: ComponentType<P> }>): ComponentType<P> {
  return function Recoverable(props: P) {
    const [attempt, setAttempt] = useState(0);
    const Surface = useMemo(() => lazy(async () => {
      try {
        return await load();
      } catch (error) {
        if (!isChunkLoadError(error)) throw error;
        void recoverChunk();
        return { default: function Unavailable() {
          return <div role="status" className="border-t border-border-subtle bg-surface-panel px-4 py-2 text-xs text-ink-muted">
            This part of the app could not load. <button type="button" className="underline" onClick={() => setAttempt(value => value + 1)}>Retry loading</button>
          </div>;
        } as ComponentType<P> };
      }
    }), [attempt]);
    return createElement(Surface, props);
  };
}
