// ported-from: packages/desktop/src/renderer/editor/utils/canvas-collision-boundary.ts @ 762abb777
export interface CanvasAnchorRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function resolveCanvasCollisionBoundary(
  explicitBoundary: Element | null | undefined,
  anchorRect: CanvasAnchorRect | null
): Element | null {
  if (explicitBoundary) return explicitBoundary;
  if (typeof document === 'undefined') return null;

  const canvases = Array.from(document.querySelectorAll<HTMLElement>('.canvas-scroll'));
  if (canvases.length <= 1 || !anchorRect) {
    return canvases[0] ?? null;
  }

  const anchorX = anchorRect.x + anchorRect.width / 2;
  const anchorY = anchorRect.y + anchorRect.height / 2;
  const containingCanvas = canvases.find((canvas) => {
    const rect = canvas.getBoundingClientRect();
    return anchorX >= rect.left && anchorX <= rect.right && anchorY >= rect.top && anchorY <= rect.bottom;
  });
  if (containingCanvas) return containingCanvas;

  return canvases
    .map((canvas) => {
      const rect = canvas.getBoundingClientRect();
      return {
        canvas,
        distance: Math.hypot(
          rect.left + rect.width / 2 - anchorX,
          rect.top + rect.height / 2 - anchorY
        )
      };
    })
    .sort((a, b) => a.distance - b.distance)[0]?.canvas ?? null;
}
