// Mounts moss's App (A§4.3): client-only, behind one stale-chunk reload, from a lazy chunk that the Worker build
// never bundles (A§4.4). `#root` keeps moss's own sizing rule (html, body, #root { height: 100% }).
import { ClientOnly } from '@tanstack/react-router';
import { lazy, Suspense, type ReactNode } from 'react';
import { ChunkReloadBoundary } from './ChunkReloadBoundary.tsx';

// The SSR branch is a constant, so the Worker build drops the import and everything behind it.
const MossApp = lazy(() =>
  import.meta.env.SSR ? Promise.reject(new Error('moss renders on the client only')) : import('./boot.tsx').then((boot) => boot.bootMoss()),
);

/** What paints until moss's shell does: moss's panel surface, nothing focusable. */
export function BootFrame(): ReactNode {
  return <div aria-hidden="true" className="h-full w-full bg-surface-panel" />;
}

export function MossAppHost(): ReactNode {
  return (
    <div id="root">
      <ClientOnly fallback={<BootFrame />}>
        <ChunkReloadBoundary fallback={<BootFrame />}>
          <Suspense fallback={<BootFrame />}>
            <MossApp />
          </Suspense>
        </ChunkReloadBoundary>
      </ClientOnly>
    </div>
  );
}
