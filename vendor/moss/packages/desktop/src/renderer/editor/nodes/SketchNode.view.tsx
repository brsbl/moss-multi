// ported-from: packages/desktop/src/renderer/editor/nodes/SketchNode.tsx @ 762abb777
import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { JSX } from 'react';
import { $getNodeByKey, type LexicalEditor, type NodeKey } from 'lexical';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { useLexicalNodeSelection } from '@lexical/react/useLexicalNodeSelection';
import { Undo2, Redo2, Eraser, Check, X, CopyPlus, Minus, Pen, Type, StickyNote } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@moss/shared/components/ui/tooltip';
// moss-multi seam: register payloads (A§10.10): peer strokes reach an open canvas; local writes carry their base.
import { useSketchPeerSync, type Rebase } from '@moss-multi/host/collab/sketch-sync';
import { useMapRegisterWritable } from '@moss-multi/host/collab/register-input';
// moss-multi seam: converter-split (A§12; S-conv §2.3)
import { OPEN_BLOCK_COMMENT_COMMAND } from '../commands';
import { EDITOR_CHROME_COLORS } from '../colors';
import {
  BLOCK_HEADER_CLASSNAME,
  BLOCK_SURFACE_CLASSNAME,
  BlockNodeShell
} from '../components/block-node-primitives';
// moss-multi seam: read-only-decorators (T3.8)
import { useIsEditorEditable } from '../components/media-primitives';
import { useBlockCanComment } from '@moss-multi/host/comments/adapter'; // moss-multi seam: comments (T4.B3)
import { insertParagraphAdjacentToBlock } from '../utils/block-node-insertion';
import {
  registerDecoratorDraftFlusher,
  unregisterDecoratorDraftFlusher
} from '../utils/decoratorDraftRegistry';
// moss-multi seam: converter-split (A§12; S-conv §2.3)
import { $createSketchNode, $isSketchNode, GRID_COLS, GRID_ROWS, SketchNode, type TextLabel } from './SketchNode';
import { registerNodeView } from './node-views';
export { $createSketchNode, $isSketchNode, GRID_COLS, GRID_ROWS, SketchNode, buildSketchMarkdown, createEmptyGrid, gridToText, parseSketchBlock, textToGrid, upscaleLegacyGrid } from './SketchNode';
export type { PixelGrid, SerializedSketchNode, TextLabel } from './SketchNode';

type SketchSnapshot = { grid: boolean[] };

const CELL_PX = 5;
const CANVAS_W = GRID_COLS * CELL_PX; // 600
const CANVAS_H = GRID_ROWS * CELL_PX; // 300
const GRID_STEP_PX = CELL_PX * 2; // 10px, same visual density as legacy 60x30
const GRID_LINE_DEVICE_PX = 1;
// Ink stroke is ~half the cell width (3 of 5 CSS px), centered inside each cell.
// Integer offset keeps fillRect edges pixel-aligned at common DPRs.
const STROKE_PX = 3;
const STROKE_OFFSET = (CELL_PX - STROKE_PX) / 2; // 1
const CELL_CENTER_PX = CELL_PX / 2;

const FILL_COLOR = EDITOR_CHROME_COLORS.sketchFill;
const GRID_LINE_COLOR = 'var(--ink-fn-rgba000003)';

function resolveCssColor(color: string): string {
  const match = color.match(/^var\((--[^,\s)]+)\)$/);
  if (!match || typeof window === 'undefined') return color;
  const resolved = window.getComputedStyle(document.documentElement).getPropertyValue(match[1]).trim();
  return resolved || color;
}

type RenderContext = {
  ctx: CanvasRenderingContext2D;
  scaleX: number;
  scaleY: number;
  fillStyle: string;
  gridStyle: string;
};

function ensureBackingStoreSize(canvas: HTMLCanvasElement): boolean {
  const rect = canvas.getBoundingClientRect();
  const cssWidth = rect.width || CANVAS_W;
  const cssHeight = rect.height || CANVAS_H;
  const pixelRatio = typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1;
  const backingWidth = Math.max(1, Math.round(cssWidth * pixelRatio));
  const backingHeight = Math.max(1, Math.round(cssHeight * pixelRatio));
  if (canvas.width === backingWidth && canvas.height === backingHeight) {
    return false;
  }
  canvas.width = backingWidth;
  canvas.height = backingHeight;
  return true;
}

function acquireRenderContext(canvas: HTMLCanvasElement): RenderContext | null {
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const scaleX = (canvas.width || CANVAS_W) / CANVAS_W;
  const scaleY = (canvas.height || CANVAS_H) / CANVAS_H;
  ctx.setTransform(scaleX, 0, 0, scaleY, 0, 0);
  return {
    ctx,
    scaleX,
    scaleY,
    fillStyle: resolveCssColor(FILL_COLOR),
    gridStyle: resolveCssColor(GRID_LINE_COLOR)
  };
}

function alignToDevicePixel(value: number, scale: number): number {
  return (Math.round(value * scale) + 0.5) / scale;
}

function drawGridLines(
  ctx: CanvasRenderingContext2D,
  scaleX: number,
  scaleY: number,
  gridStyle: string
): void {
  ctx.strokeStyle = gridStyle;

  ctx.lineWidth = GRID_LINE_DEVICE_PX / scaleX;
  ctx.beginPath();
  for (let x = 0; x <= CANVAS_W; x += GRID_STEP_PX) {
    const alignedX = alignToDevicePixel(x, scaleX);
    ctx.moveTo(alignedX, 0);
    ctx.lineTo(alignedX, CANVAS_H);
  }
  ctx.stroke();

  ctx.lineWidth = GRID_LINE_DEVICE_PX / scaleY;
  ctx.beginPath();
  for (let y = 0; y <= CANVAS_H; y += GRID_STEP_PX) {
    const alignedY = alignToDevicePixel(y, scaleY);
    ctx.moveTo(0, alignedY);
    ctx.lineTo(CANVAS_W, alignedY);
  }
  ctx.stroke();
}

function bresenhamLine(
  x0: number,
  y0: number,
  x1: number,
  y1: number
): [number, number][] {
  const points: [number, number][] = [];
  let dx = Math.abs(x1 - x0);
  let dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  let x = x0;
  let y = y0;
  while (true) {
    points.push([x, y]);
    if (x === x1 && y === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      x += sx;
    }
    if (e2 <= dx) {
      err += dx;
      y += sy;
    }
  }
  return points;
}

function constrainToAxis(
  startX: number,
  startY: number,
  endX: number,
  endY: number
): { x: number; y: number } {
  const dx = endX - startX;
  const dy = endY - startY;
  const absDx = Math.abs(dx);
  const absDy = Math.abs(dy);

  if (absDx > absDy * 2) {
    return { x: endX, y: startY };
  } else if (absDy > absDx * 2) {
    return { x: startX, y: endY };
  } else {
    const dist = Math.max(absDx, absDy);
    return {
      x: startX + dist * Math.sign(dx),
      y: startY + dist * Math.sign(dy)
    };
  }
}

function clampCell(x: number, y: number): { x: number; y: number } {
  return {
    x: Math.max(0, Math.min(GRID_COLS - 1, x)),
    y: Math.max(0, Math.min(GRID_ROWS - 1, y))
  };
}

// ---------------------------------------------------------------------------
// Canvas rendering helpers
// ---------------------------------------------------------------------------

function paintInk(
  ctx: CanvasRenderingContext2D,
  grid: boolean[] | Uint8Array,
  fillStyle: string
): void {
  ctx.fillStyle = fillStyle;

  // Pass 1: maximal horizontal runs (len >= 2) -> one continuous centered rect.
  // A run spans from the first cell's center minus STROKE_PX/2 to the last cell's
  // center plus STROKE_PX/2, yielding width (len-1)*CELL_PX + STROKE_PX.
  for (let row = 0; row < GRID_ROWS; row++) {
    let col = 0;
    while (col < GRID_COLS) {
      if (!grid[row * GRID_COLS + col]) { col++; continue; }
      const start = col;
      while (col < GRID_COLS && grid[row * GRID_COLS + col]) col++;
      const len = col - start;
      if (len >= 2) {
        ctx.fillRect(
          start * CELL_PX + STROKE_OFFSET,
          row * CELL_PX + STROKE_OFFSET,
          (len - 1) * CELL_PX + STROKE_PX,
          STROKE_PX
        );
      }
    }
  }

  // Pass 2: maximal vertical runs (len >= 2) -> one continuous centered rect.
  // The single tall rect covers any grid line crossings within its width, so
  // faint grid lines drawn beneath cannot bleed through internal cell seams.
  for (let col = 0; col < GRID_COLS; col++) {
    let row = 0;
    while (row < GRID_ROWS) {
      if (!grid[row * GRID_COLS + col]) { row++; continue; }
      const start = row;
      while (row < GRID_ROWS && grid[row * GRID_COLS + col]) row++;
      const len = row - start;
      if (len >= 2) {
        ctx.fillRect(
          col * CELL_PX + STROKE_OFFSET,
          start * CELL_PX + STROKE_OFFSET,
          STROKE_PX,
          (len - 1) * CELL_PX + STROKE_PX
        );
      }
    }
  }

  // Pass 3: diagonal connectors between center points (no h/v intermediate),
  // and centered squares for truly isolated cells.
  ctx.strokeStyle = fillStyle;
  ctx.lineWidth = STROKE_PX;
  ctx.lineCap = 'butt';
  ctx.beginPath();
  let needStroke = false;

  for (let row = 0; row < GRID_ROWS; row++) {
    for (let col = 0; col < GRID_COLS; col++) {
      const idx = row * GRID_COLS + col;
      if (!grid[idx]) continue;

      const left = col > 0 && grid[idx - 1];
      const right = col + 1 < GRID_COLS && grid[idx + 1];
      const up = row > 0 && grid[idx - GRID_COLS];
      const down = row + 1 < GRID_ROWS && grid[idx + GRID_COLS];

      // Down-right diagonal: only when neither end shares an h/v step.
      if (
        col + 1 < GRID_COLS &&
        row + 1 < GRID_ROWS &&
        grid[idx + GRID_COLS + 1] &&
        !right &&
        !down
      ) {
        ctx.moveTo(col * CELL_PX + CELL_CENTER_PX, row * CELL_PX + CELL_CENTER_PX);
        ctx.lineTo((col + 1) * CELL_PX + CELL_CENTER_PX, (row + 1) * CELL_PX + CELL_CENTER_PX);
        needStroke = true;
      }
      // Down-left diagonal.
      if (
        col > 0 &&
        row + 1 < GRID_ROWS &&
        grid[idx + GRID_COLS - 1] &&
        !left &&
        !down
      ) {
        ctx.moveTo(col * CELL_PX + CELL_CENTER_PX, row * CELL_PX + CELL_CENTER_PX);
        ctx.lineTo((col - 1) * CELL_PX + CELL_CENTER_PX, (row + 1) * CELL_PX + CELL_CENTER_PX);
        needStroke = true;
      }

      // Isolated cell (no 8-neighbor) -> small centered square.
      if (!left && !right && !up && !down) {
        const upLeft = col > 0 && row > 0 && grid[idx - GRID_COLS - 1];
        const upRight = col + 1 < GRID_COLS && row > 0 && grid[idx - GRID_COLS + 1];
        const downLeft = col > 0 && row + 1 < GRID_ROWS && grid[idx + GRID_COLS - 1];
        const downRight = col + 1 < GRID_COLS && row + 1 < GRID_ROWS && grid[idx + GRID_COLS + 1];
        if (!upLeft && !upRight && !downLeft && !downRight) {
          ctx.fillRect(
            col * CELL_PX + STROKE_OFFSET,
            row * CELL_PX + STROKE_OFFSET,
            STROKE_PX,
            STROKE_PX
          );
        }
      }
    }
  }

  if (needStroke) {
    ctx.stroke();
  }
}

function renderFullCanvas(
  canvas: HTMLCanvasElement,
  grid: boolean[] | Uint8Array,
  showGridLines: boolean
): RenderContext | null {
  ensureBackingStoreSize(canvas);
  const rc = acquireRenderContext(canvas);
  if (!rc) return null;
  const { ctx, scaleX, scaleY, fillStyle, gridStyle } = rc;

  ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);

  // Grid lines render beneath ink. Ink runs paint as continuous rects so any
  // grid line crossing inside the stroke is fully covered by solid fill —
  // no seams or banding through the stroke.
  if (showGridLines) {
    drawGridLines(ctx, scaleX, scaleY, gridStyle);
  }

  paintInk(ctx, grid, fillStyle);

  return rc;
}

// ---------------------------------------------------------------------------
// SketchSurface -- canvas-based drawing surface
// ---------------------------------------------------------------------------

function SketchSurface({
  grid,
  labels,
  isEditing,
  editable,
  toolMode,
  onToolModeChange,
  onGridChange,
  onLabelsChange
}: {
  grid: boolean[];
  labels: TextLabel[];
  isEditing: boolean;
  editable: boolean; // moss-multi seam: read-only-decorators (T4.B3): a read-only body holds nothing focusable
  toolMode: 'draw' | 'erase' | 'label';
  onToolModeChange: (mode: 'draw' | 'erase' | 'label') => void;
  onGridChange: (newGrid: boolean[]) => void;
  onLabelsChange: (labels: TextLabel[]) => void;
}): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const drawingRef = useRef<Uint8Array>(new Uint8Array(GRID_COLS * GRID_ROWS));
  const isDraggingRef = useRef(false);
  const eraseModeRef = useRef(false);
  const lastCellRef = useRef<{ x: number; y: number } | null>(null);
  const dragStartRef = useRef<{ x: number; y: number } | null>(null);
  const preStrokeSnapshotRef = useRef<Uint8Array | null>(null);

  // Label interaction state
  const [editingLabelId, setEditingLabelId] = useState<string | null>(null);
  const [selectedLabelId, setSelectedLabelId] = useState<string | null>(null);
  // Track the text of a label before editing started, so we can push undo snapshots only when text actually changed

  const labelDragRef = useRef<{
    labelId: string;
    startCol: number;
    startRow: number;
    offsetX: number;
    offsetY: number;
  } | null>(null);

  // Clear label selection/editing when exiting edit mode
  useEffect(() => {
    if (!isEditing) {
      setEditingLabelId(null);
      setSelectedLabelId(null);
    }
  }, [isEditing]);

  // Sync grid state to canvas on state changes (undo/redo/clear/mode switch)
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    renderFullCanvas(canvas, grid, isEditing);
  }, [grid, isEditing]);

  // Repaint on app theme changes by observing documentElement attributes directly.
  // Reading effectiveThemeAtom didn't work: SketchSurface's effect fires before the
  // parent useThemeEffect updates document.documentElement.dataset.theme, so
  // getComputedStyle resolves the old token values. Observing the attribute itself
  // ensures the redraw runs *after* the CSS variables flip.
  useEffect(() => {
    if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') return;
    const root = document.documentElement;
    const observer = new MutationObserver(() => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const source = isDraggingRef.current ? drawingRef.current : grid;
      renderFullCanvas(canvas, source, isEditing);
    });
    observer.observe(root, { attributes: true, attributeFilter: ['data-theme', 'class'] });
    return () => observer.disconnect();
  }, [grid, isEditing]);

  // Resize backing store + full redraw on CSS-size / DPR changes.
  useEffect(() => {
    if (typeof ResizeObserver === 'undefined') return;
    const canvas = canvasRef.current;
    if (!canvas) return;

    let initial = true;
    const observer = new ResizeObserver(() => {
      if (initial) {
        initial = false;
        return;
      }
      const source = isDraggingRef.current ? drawingRef.current : grid;
      renderFullCanvas(canvas, source, isEditing);
    });
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [grid, isEditing]);


  const cellFromPointer = useCallback(
    (clientX: number, clientY: number): { x: number; y: number } => {
      const container = containerRef.current;
      if (!container) return { x: 0, y: 0 };
      const rect = container.getBoundingClientRect();
      const cellPx = rect.width / GRID_COLS;
      const px = clientX - rect.left;
      const py = clientY - rect.top;
      return clampCell(Math.floor(px / cellPx), Math.floor(py / cellPx));
    },
    []
  );

  const cellFromEvent = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>): { x: number; y: number } => {
      const canvas = canvasRef.current;
      if (!canvas) return { x: 0, y: 0 };
      const rect = canvas.getBoundingClientRect();
      const scaleX = CANVAS_W / rect.width;
      const scaleY = CANVAS_H / rect.height;
      const px = (e.clientX - rect.left) * scaleX;
      const py = (e.clientY - rect.top) * scaleY;
      return clampCell(Math.floor(px / CELL_PX), Math.floor(py / CELL_PX));
    },
    []
  );

  const repaintFromBuffer = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    renderFullCanvas(canvas, drawingRef.current, isEditing);
  }, [isEditing]);

  const applyCell = useCallback(
    (col: number, row: number, erase: boolean): boolean => {
      const idx = row * GRID_COLS + col;
      const value = erase ? 0 : 1;
      if (drawingRef.current[idx] === value) return false;
      drawingRef.current[idx] = value;
      return true;
    },
    []
  );

  const applyLine = useCallback(
    (x0: number, y0: number, x1: number, y1: number, erase: boolean) => {
      const points = bresenhamLine(x0, y0, x1, y1);
      let changed = false;
      for (const [px, py] of points) {
        if (applyCell(px, py, erase)) changed = true;
      }
      if (changed) repaintFromBuffer();
    },
    [applyCell, repaintFromBuffer]
  );

  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      if (!isEditing || toolMode === 'label') return;

      const cell = cellFromEvent(e);

      // Copy grid to drawing buffer
      const buf = drawingRef.current;
      for (let i = 0; i < grid.length; i++) {
        buf[i] = grid[i] ? 1 : 0;
      }

      // Save pre-stroke snapshot for shift redraw
      preStrokeSnapshotRef.current = new Uint8Array(buf);

      // Erase mode: toolbar toggle OR hold Alt
      eraseModeRef.current = toolMode === 'erase' || e.altKey;

      isDraggingRef.current = true;
      lastCellRef.current = cell;
      dragStartRef.current = cell;

      if (applyCell(cell.x, cell.y, eraseModeRef.current)) {
        repaintFromBuffer();
      }
      (e.target as HTMLCanvasElement).setPointerCapture(e.pointerId);
    },
    [isEditing, toolMode, grid, cellFromEvent, applyCell, repaintFromBuffer]
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      if (!isDraggingRef.current || !lastCellRef.current || !dragStartRef.current)
        return;

      let target = cellFromEvent(e);
      const erase = eraseModeRef.current;

      if (e.shiftKey) {
        const start = dragStartRef.current;
        const constrained = constrainToAxis(
          start.x,
          start.y,
          target.x,
          target.y
        );
        target = clampCell(constrained.x, constrained.y);

        // Restore pre-stroke snapshot and redraw the constrained line
        const snapshot = preStrokeSnapshotRef.current;
        if (snapshot) {
          drawingRef.current.set(snapshot);
          repaintFromBuffer();
        }

        applyLine(start.x, start.y, target.x, target.y, erase);
      } else {
        const last = lastCellRef.current;
        applyLine(last.x, last.y, target.x, target.y, erase);
        lastCellRef.current = target;
      }
    },
    [cellFromEvent, applyLine, repaintFromBuffer]
  );

  const handlePointerUp = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      if (!isDraggingRef.current) return;

      isDraggingRef.current = false;
      lastCellRef.current = null;
      dragStartRef.current = null;
      preStrokeSnapshotRef.current = null;

      (e.target as HTMLCanvasElement).releasePointerCapture(e.pointerId);

      // Commit drawing buffer to React state
      const buf = drawingRef.current;
      const newGrid: boolean[] = new Array(buf.length);
      for (let i = 0; i < buf.length; i++) {
        newGrid[i] = buf[i] === 1;
      }
      onGridChange(newGrid);
    },
    [onGridChange]
  );

  const handleLostPointerCapture = useCallback(() => {
    if (!isDraggingRef.current) return;
    isDraggingRef.current = false;
    lastCellRef.current = null;
    dragStartRef.current = null;
    preStrokeSnapshotRef.current = null;

    // Commit drawing buffer to React state
    const buf = drawingRef.current;
    const newGrid: boolean[] = new Array(buf.length);
    for (let i = 0; i < buf.length; i++) {
      newGrid[i] = buf[i] === 1;
    }
    onGridChange(newGrid);
  }, [onGridChange]);

  // -----------------------------------------------------------------------
  // Label interaction handlers
  // -----------------------------------------------------------------------

  const commitLabelEdit = useCallback(
    (labelId: string, text: string) => {
      setEditingLabelId(null);


      if (text.trim() === '') {
        onLabelsChange(labels.filter(l => l.id !== labelId));
        setSelectedLabelId(null);
      } else {
        onLabelsChange(labels.map(l => (l.id === labelId ? { ...l, text } : l)));
      }
    },
    [labels, onLabelsChange]
  );

  // Place a new label at the clicked position (used in label mode)
  const placeLabel = useCallback(
    (e: React.MouseEvent) => {
      if (!isEditing || toolMode !== 'label') return;

      const cell = cellFromPointer(e.clientX, e.clientY);
      const id = Math.random().toString(36).slice(2, 8);
      const newLabel: TextLabel = {
        id,
        text: '',
        col: cell.x,
        row: cell.y
      };
      onLabelsChange([...labels, newLabel]);

      setEditingLabelId(id);
      setSelectedLabelId(null);
    },
    [isEditing, toolMode, labels, onLabelsChange, cellFromPointer]
  );

  const handleLabelDoubleClick = useCallback(
    (e: React.MouseEvent, labelId: string) => {
      e.stopPropagation();
      if (!isEditing) return;
      onToolModeChange('label');
      setEditingLabelId(labelId);
      setSelectedLabelId(null);
    },
    [isEditing, onToolModeChange]
  );

  const handleLabelClick = useCallback(
    (e: React.MouseEvent, labelId: string) => {
      e.stopPropagation();
      if (!isEditing) return;
      if (toolMode === 'erase') {
        onLabelsChange(labels.filter(l => l.id !== labelId));
        return;
      }
      if (editingLabelId === labelId) return;
      setSelectedLabelId(labelId);
      setEditingLabelId(null);
    },
    [isEditing, toolMode, editingLabelId, labels, onLabelsChange]
  );

  const handleLabelPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>, label: TextLabel) => {
      if (!isEditing) return;
      if (editingLabelId === label.id) return;
      e.stopPropagation();

      const container = containerRef.current;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      const cellPx = rect.width / GRID_COLS;

      labelDragRef.current = {
        labelId: label.id,
        startCol: label.col,
        startRow: label.row,
        offsetX: e.clientX - (rect.left + label.col * cellPx),
        offsetY: e.clientY - (rect.top + label.row * cellPx)
      };

      setSelectedLabelId(label.id);
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    },
    [isEditing, editingLabelId]
  );

  const handleLabelPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const drag = labelDragRef.current;
      if (!drag) return;

      const container = containerRef.current;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      const cellPx = rect.width / GRID_COLS;

      // Calculate new pixel position
      const newPxX = e.clientX - rect.left - drag.offsetX;
      const newPxY = e.clientY - rect.top - drag.offsetY;

      // Update DOM position directly for smooth dragging (pixels for smooth visual, resets to % on commit)
      const labelEl = e.currentTarget as HTMLElement;
      labelEl.style.left = `${newPxX}px`;
      labelEl.style.top = `${newPxY}px`;

      // Clamp max-width based on current position
      const col = Math.max(0, Math.min(GRID_COLS - 1, Math.round(newPxX / cellPx)));
      labelEl.style.maxWidth = `${((GRID_COLS - col) / GRID_COLS) * 100}%`;
    },
    []
  );

  const handleLabelPointerUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const drag = labelDragRef.current;
      if (!drag) return;
      labelDragRef.current = null;

      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);

      const container = containerRef.current;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      const cellPx = rect.width / GRID_COLS;

      // Snap to grid
      const newPxX = e.clientX - rect.left - drag.offsetX;
      const newPxY = e.clientY - rect.top - drag.offsetY;
      const col = Math.max(0, Math.min(GRID_COLS - 1, Math.round(newPxX / cellPx)));
      const row = Math.max(0, Math.min(GRID_ROWS - 1, Math.round(newPxY / cellPx)));

      // If it didn't move, don't update (was just a click)
      if (col === drag.startCol && row === drag.startRow) return;

      onLabelsChange(
        labels.map(l => (l.id === drag.labelId ? { ...l, col, row } : l))
      );
    },
    [labels, onLabelsChange]
  );

  const handleOverlayKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (!isEditing || !selectedLabelId || editingLabelId) return;
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        e.stopPropagation();
        onLabelsChange(labels.filter(l => l.id !== selectedLabelId));
        setSelectedLabelId(null);
      }
    },
    [isEditing, selectedLabelId, editingLabelId, labels, onLabelsChange]
  );

  // Click on overlay background deselects labels
  const handleOverlayClick = useCallback(
    () => {
      setSelectedLabelId(null);
      setEditingLabelId(null);
    },
    []
  );

  return (
    <div ref={containerRef} className="relative" style={{ aspectRatio: '2 / 1' }}>
      <canvas
        ref={canvasRef}
        width={CANVAS_W}
        height={CANVAS_H}
        className="w-full bg-ink-inverse"
        style={{
          aspectRatio: '2 / 1',
          touchAction: 'none',
          cursor: isEditing ? 'crosshair' : 'default',
          pointerEvents: isEditing ? 'auto' : 'none'
        }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onLostPointerCapture={handleLostPointerCapture}
        onClick={toolMode === 'label' ? placeLabel : handleOverlayClick}
      />
      {/* Labels overlay — pointer-events: none so drawing passes through to canvas.
           Individual LabelElements have pointer-events: auto to intercept label interactions. */}
      <div
        style={{
          position: 'absolute',
          inset: 0,
          pointerEvents: 'none',
          overflow: 'hidden'
        }}
        onKeyDown={handleOverlayKeyDown}
        tabIndex={isEditing ? 0 : editable ? -1 : undefined /* moss-multi seam: read-only-decorators (T4.B3) */}
      >
        {labels.map(label => {
          const isEditingThis = editingLabelId === label.id;
          const isSelectedThis = selectedLabelId === label.id;
          return (
            <LabelElement
              key={label.id}
              label={label}
              isEditing={isEditingThis}
              isSelected={isSelectedThis}
              isEditMode={isEditing}
              onDoubleClick={handleLabelDoubleClick}
              onClick={handleLabelClick}
              onPointerDown={handleLabelPointerDown}
              onPointerMove={handleLabelPointerMove}
              onPointerUp={handleLabelPointerUp}
              onCommit={commitLabelEdit}
            />
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// LabelElement -- individual label within the overlay
// ---------------------------------------------------------------------------

function LabelElement({
  label,
  isEditing,
  isSelected,
  isEditMode,
  onDoubleClick,
  onClick,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onCommit
}: {
  label: TextLabel;
  isEditing: boolean;
  isSelected: boolean;
  isEditMode: boolean;
  onDoubleClick: (e: React.MouseEvent, id: string) => void;
  onClick: (e: React.MouseEvent, id: string) => void;
  onPointerDown: (e: React.PointerEvent<HTMLDivElement>, label: TextLabel) => void;
  onPointerMove: (e: React.PointerEvent<HTMLDivElement>) => void;
  onPointerUp: (e: React.PointerEvent<HTMLDivElement>) => void;
  onCommit: (id: string, text: string) => void;
}): JSX.Element {
  const editableRef = useRef<HTMLDivElement>(null);

  // Auto-focus when entering edit mode
  useEffect(() => {
    if (isEditing && editableRef.current) {
      const el = editableRef.current;
      el.focus();
      // Place cursor at end
      const range = document.createRange();
      const sel = window.getSelection();
      range.selectNodeContents(el);
      range.collapse(false);
      sel?.removeAllRanges();
      sel?.addRange(range);
    }
  }, [isEditing]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (!isEditing) return;
      // Stop ALL keystrokes from propagating to the overlay/Lexical while editing label text
      e.stopPropagation();
      if (e.key === 'Enter' || e.key === 'Escape') {
        e.preventDefault();
        const text = (editableRef.current?.textContent ?? '').slice(0, 80);
        onCommit(label.id, text);
      }
    },
    [isEditing, label.id, onCommit]
  );

  const handleBlur = useCallback(() => {
    if (!isEditing) return;
    const text = (editableRef.current?.textContent ?? '').slice(0, 80);
    onCommit(label.id, text);
  }, [isEditing, label.id, onCommit]);

  const handleInput = useCallback(() => {
    const el = editableRef.current;
    if (!el) return;
    const text = el.textContent ?? '';
    if (text.length > 80) {
      el.textContent = text.slice(0, 80);
      // Place cursor at end after truncation
      const range = document.createRange();
      const sel = window.getSelection();
      range.selectNodeContents(el);
      range.collapse(false);
      sel?.removeAllRanges();
      sel?.addRange(range);
    }
  }, []);

  return (
    <div
      style={{
        position: 'absolute',
        left: `${(label.col / GRID_COLS) * 100}%`,
        top: `${(label.row / GRID_ROWS) * 100}%`,
        maxWidth: `${((GRID_COLS - label.col) / GRID_COLS) * 100}%`,
        fontFamily: 'monospace',
        fontSize: '11px',
        lineHeight: '14px',
        color: 'var(--ink-default)',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        pointerEvents: isEditMode ? 'auto' : 'none',
        cursor: isEditMode ? (isEditing ? 'text' : 'pointer') : 'default',
        touchAction: 'none',
        outline: isSelected && !isEditing ? '2px solid var(--surface-fn-rgba921249903)' : 'none',
        outlineOffset: '1px',
        borderRadius: '1px',
        userSelect: isEditing ? 'text' : 'none'
      }}
      onDoubleClick={e => onDoubleClick(e, label.id)}
      onClick={e => onClick(e, label.id)}
      onPointerDown={isEditing ? undefined : (e => onPointerDown(e, label))}
      onPointerMove={isEditing ? undefined : onPointerMove}
      onPointerUp={isEditing ? undefined : onPointerUp}
    >
      {isEditing ? (
        <div
          ref={editableRef}
          contentEditable
          data-sketch-label-id={label.id}
          suppressContentEditableWarning
          onKeyDown={handleKeyDown}
          onBlur={handleBlur}
          onInput={handleInput}
          onPaste={(e) => {
            e.preventDefault();
            const text = e.clipboardData.getData('text/plain').replace(/\n/g, ' ').slice(0, 80);
            document.execCommand('insertText', false, text);
          }}
          className="rounded-sm border border-border-default/60 bg-surface-raised-control px-1 shadow-sm"
          style={{
            outline: 'none',
            minWidth: '4px',
            whiteSpace: 'nowrap',
            cursor: 'text'
          }}
        >
          {label.text}
        </div>
      ) : (
        label.text
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// SketchWrapper -- edit/view container with toolbar
// ---------------------------------------------------------------------------

function SketchWrapper({
  grid: initialGrid,
  labels: initialLabels,
  nodeKey,
  commentIds: _commentIds = []
}: {
  grid: boolean[];
  labels: TextLabel[];
  nodeKey: NodeKey;
  commentIds?: string[];
}): JSX.Element {
  const [editor] = useLexicalComposerContext();
  const [isSelected, setSelected, clearSelection] = useLexicalNodeSelection(nodeKey);

  // Check if grid is empty to auto-enter edit mode
  const isInitialEmpty = initialGrid.every((v) => !v);
  // moss-multi seam: register payloads (A§10.10): a canvas whose payload has not arrived only looks empty; it is
  // read-only until then, as a text field is, so no stroke is drawn against nothing.
  const payloadWritable = useMapRegisterWritable(editor, nodeKey);

  const [isEditing, setIsEditing] = useState(isInitialEmpty && payloadWritable);
  const [grid, setGrid] = useState<boolean[]>(initialGrid);
  const [labels, setLabels] = useState<TextLabel[]>(initialLabels);
  const [undoStack, setUndoStack] = useState<SketchSnapshot[]>([]);
  const [redoStack, setRedoStack] = useState<SketchSnapshot[]>([]);
  const [toolMode, setToolMode] = useState<'draw' | 'erase' | 'label'>('draw');
  const editBaselineGridRef = useRef(initialGrid);
  const editBaselineLabelsRef = useRef(initialLabels);

  // Refs mirror state so callbacks can read current values without stale closures
  const gridRef = useRef(grid);
  gridRef.current = grid;
  const labelsRef = useRef(labels);
  labelsRef.current = labels;
  const undoRef = useRef(undoStack);
  undoRef.current = undoStack;
  const redoRef = useRef(redoStack);
  redoRef.current = redoStack;

  const isGridEmpty = grid.every((v) => !v);
  // moss-multi seam: read-only-decorators (T3.8): a read-only canvas offers no Draw, Duplicate, comment or gap.
  const editable = useIsEditorEditable() && payloadWritable;
  const canAddComment = useBlockCanComment(editor, editable); // moss-multi seam: comments (T4.B3)

  const handleEditClick = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    editBaselineGridRef.current = gridRef.current;
    editBaselineLabelsRef.current = labelsRef.current;
    setIsEditing(true);
    setUndoStack([]);
    setRedoStack([]);
  }, []);

  const handleContainerClick = useCallback(
    (e: React.MouseEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest('button') || target.closest('canvas')) {
        return;
      }

      if (e.shiftKey) {
        setSelected(!isSelected);
      } else {
        clearSelection();
        setSelected(true);
      }
    },
    [isSelected, setSelected, clearSelection]
  );

  // moss-multi seam: register payloads (A§10.10)
  const applyPeerChange = useCallback((rebase: Rebase) => {
    const local = rebase({ grid: gridRef.current, labels: labelsRef.current });
    gridRef.current = local.grid;
    labelsRef.current = local.labels;
    setGrid(local.grid);
    setLabels(local.labels);
    const baseline = rebase({ grid: editBaselineGridRef.current, labels: editBaselineLabelsRef.current });
    editBaselineGridRef.current = baseline.grid;
    editBaselineLabelsRef.current = baseline.labels;
    const moveSnapshot = (snapshot: SketchSnapshot) => ({ ...snapshot, grid: rebase({ grid: snapshot.grid, labels: [] as TextLabel[] }).grid });
    undoRef.current = undoRef.current.map(moveSnapshot);
    redoRef.current = redoRef.current.map(moveSnapshot);
    setUndoStack(undoRef.current);
    setRedoStack(redoRef.current);
  }, []);
  const peerSync = useSketchPeerSync(nodeKey, initialGrid, initialLabels, applyPeerChange);

  const persistSketchDraft = useCallback(
    (nextGrid: boolean[], nextLabels: TextLabel[] = labelsRef.current, base = { grid: gridRef.current, labels: labelsRef.current }) => {
      peerSync.write(() => commitSketchDraftToNode(editor, nodeKey, nextGrid, nextLabels, base));
    },
    [editor, nodeKey, peerSync]
  );

  const handleDone = useCallback(() => {
    let nextLabels = labelsRef.current;
    const activeLabelDraft = typeof document === 'undefined'
      ? null
      : document.querySelector<HTMLElement>(
          `[data-block-decorator-key="${nodeKey}"] [contenteditable="true"][data-sketch-label-id]`
        );
    const activeLabelId = activeLabelDraft?.dataset.sketchLabelId ?? null;

    if (activeLabelId) {
      const draftText = (activeLabelDraft?.textContent ?? '').slice(0, 80);
      nextLabels = draftText.trim() === ''
        ? nextLabels.filter((label) => label.id !== activeLabelId)
        : nextLabels.map((label) => (
            label.id === activeLabelId ? { ...label, text: draftText } : label
          ));
      setLabels(nextLabels);
    }

    persistSketchDraft(gridRef.current, nextLabels);
    setIsEditing(false);
  }, [nodeKey, persistSketchDraft]);

  useEffect(() => {
    if (!isEditing) {
      return;
    }

    const flushDraft = () => {
      handleDone();
    };

    const editorId = editor._key;
    registerDecoratorDraftFlusher(editorId, nodeKey, flushDraft);
    return () => {
      unregisterDecoratorDraftFlusher(editorId, nodeKey, flushDraft);
    };
  }, [editor._key, handleDone, isEditing, nodeKey]);

  const handleCancel = useCallback(() => {
    const base = { grid: gridRef.current, labels: labelsRef.current };
    const baselineGrid = editBaselineGridRef.current;
    const baselineLabels = editBaselineLabelsRef.current;
    setGrid(baselineGrid);
    setLabels(baselineLabels);
    gridRef.current = baselineGrid;
    labelsRef.current = baselineLabels;
    setUndoStack([]);
    setRedoStack([]);
    persistSketchDraft(baselineGrid, baselineLabels, base);
    setIsEditing(false);
  }, [persistSketchDraft]);

  // onGridChange is called on pointer-up from the drawing surface.
  // We push the pre-stroke snapshot to undo before committing the new grid,
  // then write the grid into Lexical immediately so note-switch saves don't
  // depend on the toolbar Done path.
  // Undo/redo is grid-only — labels are not part of the undo history.
  const handleGridChange = useCallback((newGrid: boolean[]) => {
    const base = { grid: gridRef.current, labels: labelsRef.current };
    setUndoStack([...undoRef.current.slice(-49), { grid: gridRef.current }]);
    setRedoStack([]);
    setGrid(newGrid);
    gridRef.current = newGrid;
    persistSketchDraft(newGrid, labelsRef.current, base);
  }, [persistSketchDraft]);

  const handleUndo = useCallback(() => {
    const stack = undoRef.current;
    if (stack.length === 0) return;
    const snapshot = stack[stack.length - 1];
    const base = { grid: gridRef.current, labels: labelsRef.current };
    setRedoStack([...redoRef.current, { grid: gridRef.current }]);
    setGrid(snapshot.grid);
    setUndoStack(stack.slice(0, -1));
    gridRef.current = snapshot.grid;
    persistSketchDraft(snapshot.grid, labelsRef.current, base);
  }, [persistSketchDraft]);

  const handleRedo = useCallback(() => {
    const stack = redoRef.current;
    if (stack.length === 0) return;
    const snapshot = stack[stack.length - 1];
    const base = { grid: gridRef.current, labels: labelsRef.current };
    setUndoStack([...undoRef.current, { grid: gridRef.current }]);
    setGrid(snapshot.grid);
    setRedoStack(stack.slice(0, -1));
    gridRef.current = snapshot.grid;
    persistSketchDraft(snapshot.grid, labelsRef.current, base);
  }, [persistSketchDraft]);

  const handleLabelsChange = useCallback(
    (nextLabels: TextLabel[]) => {
      const base = { grid: gridRef.current, labels: labelsRef.current };
      setLabels(nextLabels);
      labelsRef.current = nextLabels;
      persistSketchDraft(gridRef.current, nextLabels, base);
    },
    [persistSketchDraft]
  );

  const handleGapClick = useCallback(
    (position: 'before' | 'after') => (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      editor.update(() => {
        const node = $getNodeByKey(nodeKey);
        if (!node) return;

        insertParagraphAdjacentToBlock(node, position);
      });
    },
    [editor, nodeKey]
  );

  const handleDuplicate = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      editor.update(() => {
        const node = $getNodeByKey(nodeKey);
        if (!node || !$isSketchNode(node)) return;

        const duplicate = $createSketchNode([...node.getGrid()], [...node.getLabels().map(l => ({ ...l }))]);
        node.insertAfter(duplicate);
      });
    },
    [editor, nodeKey]
  );

  // Document-level listener for Cmd+Z/Cmd+Shift+Z — works regardless of focus.
  // Capture phase so we intercept before Lexical's handler.
  // Skipped when a contentEditable has focus (label text editing uses browser-native undo).
  useEffect(() => {
    if (!isEditing) return;
    const handler = (e: KeyboardEvent) => {
      const active = document.activeElement;
      if (active && (active as HTMLElement).isContentEditable) return;

      const isMod = e.metaKey || e.ctrlKey;
      if (isMod && e.shiftKey && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        e.stopPropagation();
        handleRedo();
      } else if (isMod && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        e.stopPropagation();
        handleUndo();
      }
    };
    document.addEventListener('keydown', handler, true);
    return () => document.removeEventListener('keydown', handler, true);
  }, [isEditing, handleUndo, handleRedo]);

  return (
    <BlockNodeShell
      selected={isSelected}
      beforeLabel="Insert paragraph before canvas"
      afterLabel="Insert paragraph after canvas"
      onGapClick={editable ? handleGapClick : undefined /* moss-multi seam: read-only-decorators (T3.8) */}
      className="my-6 outline-none"
      data-block-decorator-key={nodeKey}
      onClick={handleContainerClick}
      tabIndex={editable ? -1 : undefined /* moss-multi seam: read-only-decorators (T3.8) */}
    >
      <div
        className={`outline-none transition-colors ${BLOCK_SURFACE_CLASSNAME}`}
      >
        {/* Header */}
        <div
          className={`flex h-10 items-center justify-between cursor-default px-canvas-surface-pad ${BLOCK_HEADER_CLASSNAME}`}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="font-mono text-xs text-ink-muted">Canvas</div>
          <div className={`flex items-center gap-1 transition-opacity ${
            isEditing || isSelected ? 'opacity-100' : 'opacity-0 group-hover/decorator:opacity-100'
          }`}>
            {isEditing ? (
              <TooltipProvider delayDuration={200}>
                <div className="flex shrink-0 items-center gap-1">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        onClick={handleUndo}
                        disabled={undoStack.length === 0}
                        className="flex h-6 w-6 items-center justify-center rounded border border-surface-panel bg-surface-raised-control text-ink-muted shadow-sm hover:bg-surface-canvas disabled:opacity-40"
                      >
                        <Undo2 className="h-3 w-3" />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom"><p>Undo</p></TooltipContent>
                  </Tooltip>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        onClick={handleRedo}
                        disabled={redoStack.length === 0}
                        className="flex h-6 w-6 items-center justify-center rounded border border-surface-panel bg-surface-raised-control text-ink-muted shadow-sm hover:bg-surface-canvas disabled:opacity-40"
                      >
                        <Redo2 className="h-3 w-3" />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom"><p>Redo</p></TooltipContent>
                  </Tooltip>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        onClick={() => setToolMode('draw')}
                        className={`flex h-6 w-6 items-center justify-center rounded border shadow-sm ${
                          toolMode === 'draw'
                            ? 'border-accent-brand bg-accent-brand/10 text-accent-brand'
                            : 'border-surface-panel bg-surface-raised-control text-ink-muted hover:bg-surface-canvas'
                        }`}
                      >
                        <Pen className="h-3 w-3" />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom"><p>Draw</p></TooltipContent>
                  </Tooltip>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        onClick={() => setToolMode('erase')}
                        className={`flex h-6 w-6 items-center justify-center rounded border shadow-sm ${
                          toolMode === 'erase'
                            ? 'border-accent-brand bg-accent-brand/10 text-accent-brand'
                            : 'border-surface-panel bg-surface-raised-control text-ink-muted hover:bg-surface-canvas'
                        }`}
                      >
                        <Eraser className="h-3 w-3" />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom"><p>Erase</p></TooltipContent>
                  </Tooltip>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        onClick={() => setToolMode('label')}
                        className={`flex h-6 w-6 items-center justify-center rounded border shadow-sm ${
                          toolMode === 'label'
                            ? 'border-accent-brand bg-accent-brand/10 text-accent-brand'
                            : 'border-surface-panel bg-surface-raised-control text-ink-muted hover:bg-surface-canvas'
                        }`}
                      >
                        <Type className="h-3 w-3" />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom"><p>Text label</p></TooltipContent>
                  </Tooltip>
                  <Minus className="h-3 w-3 rotate-90 text-border-default" />
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        onClick={handleCancel}
                        className="flex h-6 w-6 items-center justify-center rounded border border-surface-panel bg-surface-raised-control text-ink-muted shadow-sm hover:bg-surface-canvas"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom"><p>Cancel</p></TooltipContent>
                  </Tooltip>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        onClick={handleDone}
                        className="flex h-6 w-6 items-center justify-center rounded bg-accent-brand text-ink-on-accent shadow-sm hover:bg-accent-brand/90"
                      >
                        <Check className="h-3 w-3" />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom"><p>Done</p></TooltipContent>
                  </Tooltip>
                </div>
              </TooltipProvider>
            ) : !editable && !canAddComment ? null /* moss-multi seam: read-only-decorators (T3.8) */ : (
              <TooltipProvider delayDuration={200}>
                <div className="flex items-center gap-1">
                  {/* moss-multi seam: read-only-decorators (T3.8): a read-only body offers no Duplicate or Draw */}
                  {!editable ? null : (<>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        onClick={handleDuplicate}
                        disabled={isGridEmpty}
                        className="flex h-6 w-6 items-center justify-center rounded border border-surface-panel bg-surface-raised-control text-ink-muted shadow-sm hover:bg-surface-canvas hover:text-ink-default disabled:opacity-40"
                      >
                        <CopyPlus className="h-3 w-3" />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom"><p>Duplicate canvas</p></TooltipContent>
                  </Tooltip>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        onClick={handleEditClick}
                        className="flex h-6 items-center gap-1 rounded border border-surface-panel bg-surface-raised-control px-2 text-xs text-ink-muted shadow-sm hover:bg-surface-canvas hover:text-ink-default"
                      >
                        <Pen className="h-3 w-3" />
                        Draw
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom"><p>Edit canvas</p></TooltipContent>
                  </Tooltip>
                  </>)}
                  {/* moss-multi seam: comments (T4.B3): Add comment follows the comment capability, so a commenter has it */}
                  {!canAddComment ? null : (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          editor.dispatchCommand(OPEN_BLOCK_COMMENT_COMMAND, { nodeKey });
                        }}
                        data-comment-entry="" /* moss-multi seam: comments (T4.B3) */
                        className="flex h-6 w-6 items-center justify-center rounded border border-surface-panel bg-surface-raised-control text-ink-muted shadow-sm hover:bg-surface-canvas hover:text-ink-default"
                      >
                        <StickyNote className="h-3 w-3" />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom"><p>Add comment</p></TooltipContent>
                  </Tooltip>
                  )}
                </div>
              </TooltipProvider>
            )}
          </div>
        </div>

        {/* Sketch body */}
        <div className="bg-ink-inverse">
          <SketchSurface
            grid={grid}
            labels={labels}
            isEditing={isEditing}
            editable={editable}
            toolMode={toolMode}
            onToolModeChange={setToolMode}
            onGridChange={handleGridChange}
            onLabelsChange={handleLabelsChange}
          />
        </div>
      </div>

    </BlockNodeShell>
  );
}

export function commitSketchDraftToNode(
  editor: LexicalEditor,
  nodeKey: NodeKey,
  grid: boolean[],
  labels: TextLabel[],
  base?: { grid: boolean[]; labels: TextLabel[] }
): void {
  // Commit synchronously: note-switch cleanup saves immediately after flushing
  // decorator drafts. A non-discrete update can defer dirty notification until
  // after the save guard has already seen a clean editor.
  editor.update(
    () => {
      const node = $getNodeByKey(nodeKey);
      if (node && $isSketchNode(node)) {
        node.setGrid(grid, base?.grid);
        node.setLabels(labels, base?.labels);
      }
    },
    { discrete: true }
  );
}

// moss-multi seam: node-views (A§12)
registerNodeView(SketchNode.getType(), function decorate(this: SketchNode): JSX.Element {
    return <SketchWrapper grid={this.getGrid()} labels={this.getLabels()} nodeKey={this.__key} commentIds={this.__commentIds} />;
  });
