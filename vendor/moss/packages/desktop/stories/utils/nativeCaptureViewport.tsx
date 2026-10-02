// ported-from: packages/desktop/stories/utils/nativeCaptureViewport.tsx @ 762abb777
import type { ReactNode } from 'react';

interface NativeCaptureViewportProps {
  captureHeight: number;
  captureWidth: number;
  children: ReactNode;
  inset: number;
  surface: string;
  surfaceHeight: number;
  surfaceWidth: number;
}

/**
 * Deterministic, story-only viewport for native visual comparisons.
 */
export function NativeCaptureViewport({
  captureHeight,
  captureWidth,
  children,
  inset,
  surface,
  surfaceHeight,
  surfaceWidth
}: NativeCaptureViewportProps) {
  return (
    <div
      data-story-capture-height={captureHeight}
      data-story-capture-width={captureWidth}
      style={{ width: captureWidth, height: captureHeight, overflow: 'hidden' }}
    >
      <div
        data-story-surface={surface}
        data-story-surface-height={surfaceHeight}
        data-story-surface-width={surfaceWidth}
        style={{ width: surfaceWidth, height: surfaceHeight, margin: inset }}
      >
        {children}
      </div>
    </div>
  );
}
