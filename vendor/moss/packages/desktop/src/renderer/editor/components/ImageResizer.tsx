// ported-from: packages/desktop/src/renderer/editor/components/ImageResizer.tsx @ 762abb777
/**
 * ImageResizer - Simple scale slider for images
 */

import type { JSX } from 'react';
import { useState, useCallback, useEffect } from 'react';

interface ImageResizerProps {
  imageRef: React.RefObject<HTMLImageElement>;
  currentWidth?: number;
  naturalWidth: number;
  onResizeEnd: (width: number, height: number) => void;
}

export function ImageResizer({
  imageRef,
  currentWidth,
  naturalWidth,
  onResizeEnd
}: ImageResizerProps): JSX.Element {
  // Calculate current scale (default to 100% if no width set)
  const initialScale = currentWidth ? Math.round((currentWidth / naturalWidth) * 100) : 100;
  const [scale, setScale] = useState(initialScale);

  // Update scale when currentWidth changes externally
  useEffect(() => {
    if (currentWidth) {
      setScale(Math.round((currentWidth / naturalWidth) * 100));
    }
  }, [currentWidth, naturalWidth]);

  const handleScaleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const newScale = parseInt(e.target.value, 10);
      setScale(newScale);

      const image = imageRef.current;
      if (!image) return;

      const newWidth = Math.round((naturalWidth * newScale) / 100);
      const aspectRatio = image.naturalHeight / image.naturalWidth;
      const newHeight = Math.round(newWidth * aspectRatio);

      // Apply dimensions immediately for preview
      image.style.width = `${newWidth}px`;
      image.style.height = `${newHeight}px`;
    },
    [imageRef, naturalWidth]
  );

  const handleScaleCommit = useCallback(() => {
    const image = imageRef.current;
    if (!image) return;

    const newWidth = Math.round((naturalWidth * scale) / 100);
    const aspectRatio = image.naturalHeight / image.naturalWidth;
    const newHeight = Math.round(newWidth * aspectRatio);

    onResizeEnd(newWidth, newHeight);
  }, [imageRef, naturalWidth, scale, onResizeEnd]);

  return (
    <div
      className="absolute bottom-2 left-2 right-2 flex items-center gap-2 rounded-md border border-border-default bg-surface-raised-card px-3 py-2 shadow-sm"
      onClick={(e) => e.stopPropagation()}
    >
      <span className="text-xs text-ink-muted whitespace-nowrap">Size</span>
      <input
        type="range"
        min={25}
        max={100}
        step={5}
        value={scale}
        onChange={handleScaleChange}
        onMouseUp={handleScaleCommit}
        onTouchEnd={handleScaleCommit}
        className="flex-1 h-1.5 appearance-none rounded-full bg-border-subtle accent-accent-brand cursor-pointer"
      />
      <span className="text-xs text-ink-muted w-8 text-right">{scale}%</span>
    </div>
  );
}

export default ImageResizer;
