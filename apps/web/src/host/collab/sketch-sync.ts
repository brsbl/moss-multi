// A canvas keeps its strokes in local state while it is open (moss's SketchWrapper). On a bound doc a peer's
// strokes arrive as new props; this hook moves every local copy (the drawing, the edit baseline, the undo stack) by
// exactly the peer's change, so a later local write never erases it (A§10.10). A change that arrives mid-stroke
// waits for the stroke's own commit, because the stroke was drawn on the grid from before it.
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { rebaseMapFields, sameValue } from '@moss-multi/sync/registers';

export interface SketchValue<L = unknown> { grid: boolean[]; labels: L[] }
export type Rebase = <L>(local: SketchValue<L>) => SketchValue<L>;

export const sameSketch = (a: SketchValue, b: SketchValue): boolean => sameValue(a.grid, b.grid) && sameValue(a.labels, b.labels);

/** `local` moved by the change `from` → `to`. */
export function rebaseSketch<L>(local: SketchValue<L>, from: SketchValue, to: SketchValue): SketchValue<L> {
  const moved = rebaseMapFields('sketch',
    { __grid: local.grid, __labels: local.labels }, { __grid: from.grid, __labels: from.labels }, { __grid: to.grid, __labels: to.labels });
  return { grid: moved.__grid as boolean[], labels: moved.__labels as L[] };
}

export function useSketchPeerSync<L>(nodeKey: string, grid: boolean[], labels: L[], apply: (rebase: Rebase) => void): {
  committed(from: SketchValue<L>, to: SketchValue<L>): void;
} {
  const value = useRef<SketchValue<L>>({ grid, labels });
  value.current = { grid, labels };
  const synced = useRef<SketchValue>(value.current);
  const applyRef = useRef(apply);
  applyRef.current = apply;
  const drawing = useRef(false);
  const ownPending = useRef(false);

  const flush = useCallback(() => {
    if (drawing.current) return;
    ownPending.current = false;
    const from = synced.current;
    const to = value.current;
    synced.current = to;
    if (sameSketch(from, to)) return;
    applyRef.current((local) => rebaseSketch(local, from, to));
  }, []);

  useEffect(() => { flush(); }, [grid, labels, flush]);

  useEffect(() => {
    const inBlock = (target: EventTarget | null) =>
      target instanceof Element && target.tagName === 'CANVAS' && !!target.closest(`[data-block-decorator-key="${nodeKey}"]`);
    const down = (event: PointerEvent) => { if (inBlock(event.target)) drawing.current = true; };
    const up = () => {
      if (!drawing.current) return;
      drawing.current = false;
      // The stroke commits in the canvas's own handler, after this capture listener. A stroke that changed nothing
      // brings no new props, so apply what arrived meanwhile now; otherwise its props carry both.
      setTimeout(() => { if (!ownPending.current) flush(); }, 0);
    };
    document.addEventListener('pointerdown', down, true);
    document.addEventListener('pointerup', up, true);
    document.addEventListener('pointercancel', up, true);
    return () => {
      document.removeEventListener('pointerdown', down, true);
      document.removeEventListener('pointerup', up, true);
      document.removeEventListener('pointercancel', up, true);
    };
  }, [nodeKey, flush]);

  const committed = useCallback((from: SketchValue<L>, to: SketchValue<L>) => {
    if (sameSketch(from, to)) return;
    synced.current = rebaseSketch(synced.current, from, to);
    ownPending.current = true;
  }, []);
  return useMemo(() => ({ committed }), [committed]);
}
