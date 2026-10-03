import { NOTICE_BAND_ATTR } from '@moss-multi/protocol/dom-contract';
import { createPortal } from 'react-dom';
import { createContext, createElement, lazy, useContext, useState, type ComponentType } from 'react';
import { isChunkLoadError, recoverChunk } from './ChunkReloadBoundary.tsx';

const RetryChunk = createContext(() => undefined as void);
function Unavailable() {
  const retry = useContext(RetryChunk);
  const notice = <div role="status" className="border-t border-border-subtle bg-surface-panel px-4 py-2 text-xs text-ink-muted">
    This part of the app could not load. <button type="button" className="underline" onClick={retry}>Retry loading</button>
  </div>;
  const band = document.querySelector(`[${NOTICE_BAND_ATTR}]`);
  return band ? createPortal(notice, band) : notice;
}

/** Optional shell surfaces fail within their own Suspense slot, leaving the bound editor mounted. */
export function recoverableLazy<P extends object>(load: () => Promise<{ default: ComponentType<P> }>): ComponentType<P> {
  const createSurface = () => lazy(async () => {
    try {
      return await load();
    } catch (error) {
      if (!isChunkLoadError(error)) throw error;
      void recoverChunk();
      return { default: Unavailable as ComponentType<P> };
    }
  });
  // Initial suspension discards component hooks; keep the first lazy identity outside that render.
  let latest = createSurface();
  return function Recoverable(props: P) {
    const [Surface, setSurface] = useState(latest);
    return <RetryChunk.Provider value={() => { latest = createSurface(); setSurface(latest); }}>
      {createElement(Surface, props)}
    </RetryChunk.Provider>;
  };
}
