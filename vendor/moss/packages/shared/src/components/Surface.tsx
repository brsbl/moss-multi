// ported-from: packages/shared/src/components/Surface.tsx @ 762abb777
import type { PropsWithChildren } from 'react';

export function Surface({ children }: PropsWithChildren) {
  return (
    <section className="rounded-lg border border-border-default bg-surface-canvas p-md shadow-sm">
      {children}
    </section>
  );
}

export default Surface;
