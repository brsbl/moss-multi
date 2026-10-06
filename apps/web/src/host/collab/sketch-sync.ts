// A canvas keeps its strokes in local state while it is open (moss's SketchWrapper). On a bound doc a peer's
// strokes arrive as new props; this hook moves every local copy (the drawing, the edit baseline, the undo stack) by
// exactly the peer's change to the register's keys, so a later local write never erases it (A§10.10). A change that
// arrives mid-stroke waits for the stroke's own commit, because the stroke was drawn on the grid from before it.
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { $getNodeByKey } from 'lexical';
import { moveEntries, readMapEntries, rebaseMapEntries, sameValue } from '@moss-multi/sync/registers';

export interface SketchValue<L = unknown> { grid: boolean[]; labels: L[] }
export type Rebase = <L>(local: SketchValue<L>) => SketchValue<L>;
/** `first`: the payload has just arrived (a view can mount before its payload doc's state does). */
export type ApplyPeerChange = (rebase: Rebase, first: boolean) => void;
type Entries = Map<string, unknown>;

const sameEntries = (a: Entries, b: Entries): boolean =>
  a.size === b.size && [...a].every(([key, value]) => b.has(key) && sameValue(value, b.get(key)));

/** `local` moved by the register's change `from` → `to`. */
export function rebaseSketch<L>(local: SketchValue<L>, from: Entries, to: Entries): SketchValue<L> {
  const moved = rebaseMapEntries('sketch', { __grid: local.grid, __labels: local.labels }, from, to);
  return { grid: moved.__grid as boolean[], labels: moved.__labels as L[] };
}

export function useSketchPeerSync<L>(nodeKey: string, grid: boolean[], labels: L[], apply: ApplyPeerChange): {
  /** Runs the canvas's own register write, which is not a peer change. */
  write(commit: () => void): void;
} {
  const [editor] = useLexicalComposerContext();
  // 'pending': a draft flush can write from inside another update, which a committing read would break.
  const read = useCallback(() => editor.read('pending', () => {
    const node = $getNodeByKey(nodeKey);
    return node ? readMapEntries(node) : undefined;
  }), [editor, nodeKey]);
  // The register as this view last took it in, moved by the view's own writes since.
  const synced = useRef<Entries | undefined>(undefined);
  const applyRef = useRef(apply);
  applyRef.current = apply;
  const drawing = useRef(false);

  const flush = useCallback(() => {
    if (drawing.current) return;
    const from = synced.current;
    const to = read();
    synced.current = to;
    if (!to || (from && sameEntries(from, to))) return;
    // The first arrival moves the view from nothing to the whole payload.
    const start = from ?? new Map<string, unknown>();
    applyRef.current((local) => rebaseSketch(local, start, to), !from);
  }, [read]);

  useEffect(() => { flush(); }, [grid, labels, flush]);

  useEffect(() => {
    const inBlock = (target: EventTarget | null) =>
      target instanceof Element && target.tagName === 'CANVAS' && !!target.closest(`[data-block-decorator-key="${nodeKey}"]`);
    const down = (event: PointerEvent) => { if (inBlock(event.target)) drawing.current = true; };
    const up = () => {
      if (!drawing.current) return;
      drawing.current = false;
      // The stroke commits in the canvas's own handler, after this capture listener; take what arrived meanwhile then.
      setTimeout(flush, 0);
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

  const write = useCallback((commit: () => void) => {
    const before = read();
    commit();
    const after = read();
    if (synced.current && before && after) synced.current = moveEntries(new Map(synced.current), before, after);
  }, [read]);
  return useMemo(() => ({ write }), [write]);
}
