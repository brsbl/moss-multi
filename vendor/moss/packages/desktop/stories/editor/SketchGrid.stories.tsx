// ported-from: packages/desktop/stories/editor/SketchGrid.stories.tsx @ 762abb777
import type { Story } from '@ladle/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  gridToText,
  textToGrid,
  createEmptyGrid,
  GRID_COLS,
  GRID_ROWS
} from '../../src/renderer/editor/nodes/SketchNode';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CELL_SIZE = 10;
const CANVAS_W = GRID_COLS * CELL_SIZE; // 600
const CANVAS_H = GRID_ROWS * CELL_SIZE; // 300

const FILL_COLOR_TOKEN = '--code-syntax-1a1a1a';
const GRID_LINE_COLOR_TOKEN = '--border-subtle';

// ---------------------------------------------------------------------------
// Drawing utilities (kept local -- story is self-contained for Ladle)
// ---------------------------------------------------------------------------

function readThemeColor(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || 'currentColor';
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

function renderFullCanvas(
  canvas: HTMLCanvasElement,
  grid: boolean[] | Uint8Array,
  showGridLines: boolean
) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const fillColor = readThemeColor(FILL_COLOR_TOKEN);
  const gridLineColor = readThemeColor(GRID_LINE_COLOR_TOKEN);

  ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);

  ctx.fillStyle = fillColor;
  for (let row = 0; row < GRID_ROWS; row++) {
    for (let col = 0; col < GRID_COLS; col++) {
      if (grid[row * GRID_COLS + col]) {
        ctx.fillRect(col * CELL_SIZE, row * CELL_SIZE, CELL_SIZE, CELL_SIZE);
      }
    }
  }

  if (showGridLines) {
    ctx.save();
    ctx.strokeStyle = gridLineColor;
    for (let col = 0; col <= GRID_COLS; col++) {
      const x = col * CELL_SIZE;
      const isMajor = col % 5 === 0;
      ctx.globalAlpha = isMajor ? 0.18 : 0.08;
      ctx.lineWidth = isMajor ? 0.35 : 0.25;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, CANVAS_H);
      ctx.stroke();
    }
    for (let row = 0; row <= GRID_ROWS; row++) {
      const y = row * CELL_SIZE;
      const isMajor = row % 5 === 0;
      ctx.globalAlpha = isMajor ? 0.18 : 0.08;
      ctx.lineWidth = isMajor ? 0.35 : 0.25;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(CANVAS_W, y);
      ctx.stroke();
    }
    ctx.restore();
  }
}

function renderCell(
  canvas: HTMLCanvasElement,
  col: number,
  row: number,
  filled: boolean,
  showGridLines: boolean
) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const fillColor = readThemeColor(FILL_COLOR_TOKEN);
  const gridLineColor = readThemeColor(GRID_LINE_COLOR_TOKEN);

  const x = col * CELL_SIZE;
  const y = row * CELL_SIZE;

  ctx.clearRect(x, y, CELL_SIZE, CELL_SIZE);

  if (filled) {
    ctx.fillStyle = fillColor;
    ctx.fillRect(x, y, CELL_SIZE, CELL_SIZE);
  }

  if (showGridLines) {
    ctx.save();
    ctx.strokeStyle = gridLineColor;
    ctx.globalAlpha = 0.1;
    ctx.lineWidth = 0.25;
    ctx.strokeRect(x, y, CELL_SIZE, CELL_SIZE);
    ctx.restore();
  }
}

// ---------------------------------------------------------------------------
// SketchGrid component
// ---------------------------------------------------------------------------

interface SketchGridProps {
  initialGrid?: boolean[];
  editable?: boolean;
}

function SketchGrid({ initialGrid, editable = true }: SketchGridProps) {
  const [grid, setGrid] = useState<boolean[]>(
    () => initialGrid ?? createEmptyGrid()
  );
  const [mode, setMode] = useState<'edit' | 'view'>(editable ? 'edit' : 'view');
  const [undoStack, setUndoStack] = useState<boolean[][]>([]);
  const [redoStack, setRedoStack] = useState<boolean[][]>([]);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawingRef = useRef<Uint8Array>(new Uint8Array(GRID_COLS * GRID_ROWS));
  const isDraggingRef = useRef(false);
  const eraseModeRef = useRef(false);
  const lastCellRef = useRef<{ x: number; y: number } | null>(null);
  const dragStartRef = useRef<{ x: number; y: number } | null>(null);
  const preStrokeSnapshotRef = useRef<Uint8Array | null>(null);

  const isEditMode = mode === 'edit';

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    renderFullCanvas(canvas, grid, isEditMode);
  }, [grid, isEditMode]);

  const cellFromEvent = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>): { x: number; y: number } => {
      const canvas = canvasRef.current;
      if (!canvas) return { x: 0, y: 0 };
      const rect = canvas.getBoundingClientRect();
      const scaleX = CANVAS_W / rect.width;
      const scaleY = CANVAS_H / rect.height;
      const px = (e.clientX - rect.left) * scaleX;
      const py = (e.clientY - rect.top) * scaleY;
      return clampCell(Math.floor(px / CELL_SIZE), Math.floor(py / CELL_SIZE));
    },
    []
  );

  const applyCell = useCallback(
    (col: number, row: number, erase: boolean) => {
      const idx = row * GRID_COLS + col;
      const value = erase ? 0 : 1;
      if (drawingRef.current[idx] === value) return;
      drawingRef.current[idx] = value;
      const canvas = canvasRef.current;
      if (canvas) {
        renderCell(canvas, col, row, !erase, isEditMode);
      }
    },
    [isEditMode]
  );

  const applyLine = useCallback(
    (
      x0: number,
      y0: number,
      x1: number,
      y1: number,
      erase: boolean
    ) => {
      const points = bresenhamLine(x0, y0, x1, y1);
      for (const [px, py] of points) {
        applyCell(px, py, erase);
      }
    },
    [applyCell]
  );

  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      if (!isEditMode) return;

      const cell = cellFromEvent(e);

      setUndoStack(prev => [...prev, [...grid]]);

      const buf = drawingRef.current;
      for (let i = 0; i < grid.length; i++) {
        buf[i] = grid[i] ? 1 : 0;
      }

      preStrokeSnapshotRef.current = new Uint8Array(buf);

      const idx = cell.y * GRID_COLS + cell.x;
      eraseModeRef.current = buf[idx] === 1;

      isDraggingRef.current = true;
      lastCellRef.current = cell;
      dragStartRef.current = cell;

      applyCell(cell.x, cell.y, eraseModeRef.current);
      (e.target as HTMLCanvasElement).setPointerCapture(e.pointerId);
    },
    [isEditMode, grid, cellFromEvent, applyCell]
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

        const snapshot = preStrokeSnapshotRef.current;
        if (snapshot) {
          drawingRef.current.set(snapshot);
          const canvas = canvasRef.current;
          if (canvas) renderFullCanvas(canvas, drawingRef.current, isEditMode);
        }

        applyLine(start.x, start.y, target.x, target.y, erase);
      } else {
        const last = lastCellRef.current;
        applyLine(last.x, last.y, target.x, target.y, erase);
        lastCellRef.current = target;
      }
    },
    [cellFromEvent, isEditMode, applyLine]
  );

  const handlePointerUp = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      if (!isDraggingRef.current) return;

      isDraggingRef.current = false;
      lastCellRef.current = null;
      dragStartRef.current = null;
      preStrokeSnapshotRef.current = null;

      (e.target as HTMLCanvasElement).releasePointerCapture(e.pointerId);

      const buf = drawingRef.current;
      const newGrid: boolean[] = new Array(buf.length);
      for (let i = 0; i < buf.length; i++) {
        newGrid[i] = buf[i] === 1;
      }
      setGrid(newGrid);

      setRedoStack([]);
    },
    []
  );

  const undo = useCallback(() => {
    setUndoStack(prev => {
      if (prev.length === 0) return prev;
      const newStack = [...prev];
      const snapshot = newStack.pop()!;
      setRedoStack(r => [...r, grid]);
      setGrid(snapshot);
      return newStack;
    });
  }, [grid]);

  const redo = useCallback(() => {
    setRedoStack(prev => {
      if (prev.length === 0) return prev;
      const newStack = [...prev];
      const snapshot = newStack.pop()!;
      setUndoStack(u => [...u, grid]);
      setGrid(snapshot);
      return newStack;
    });
  }, [grid]);

  const clear = useCallback(() => {
    setUndoStack(prev => [...prev, grid]);
    setRedoStack([]);
    setGrid(createEmptyGrid());
  }, [grid]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (!isEditMode) return;
      e.stopPropagation();

      const isMod = e.metaKey || e.ctrlKey;
      if (isMod && e.shiftKey && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        redo();
      } else if (isMod && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        undo();
      }
    },
    [isEditMode, undo, redo]
  );

  const serialized = gridToText(grid);

  return (
    <div
      tabIndex={0}
      onKeyDown={handleKeyDown}
      style={{ outline: 'none', maxWidth: 720 }}
    >
      {editable && (
        <div
          style={{
            display: 'flex',
            gap: 8,
            marginBottom: 8,
            alignItems: 'center'
          }}
        >
          <button
            onClick={() => setMode(m => (m === 'edit' ? 'view' : 'edit'))}
            style={{
              padding: '4px 12px',
              fontSize: 13,
              border: '1px solid var(--border-default)',
              borderRadius: 4,
              background: isEditMode ? 'var(--surface-note-hover)' : 'var(--ink-inverse)',
              cursor: 'pointer'
            }}
          >
            {isEditMode ? 'Edit' : 'View'}
          </button>
          <button
            onClick={undo}
            disabled={undoStack.length === 0}
            style={{
              padding: '4px 12px',
              fontSize: 13,
              border: '1px solid var(--border-default)',
              borderRadius: 4,
              background: 'var(--ink-inverse)',
              cursor: undoStack.length > 0 ? 'pointer' : 'default',
              opacity: undoStack.length > 0 ? 1 : 0.4
            }}
          >
            Undo
          </button>
          <button
            onClick={redo}
            disabled={redoStack.length === 0}
            style={{
              padding: '4px 12px',
              fontSize: 13,
              border: '1px solid var(--border-default)',
              borderRadius: 4,
              background: 'var(--ink-inverse)',
              cursor: redoStack.length > 0 ? 'pointer' : 'default',
              opacity: redoStack.length > 0 ? 1 : 0.4
            }}
          >
            Redo
          </button>
          <button
            onClick={clear}
            style={{
              padding: '4px 12px',
              fontSize: 13,
              border: '1px solid var(--border-default)',
              borderRadius: 4,
              background: 'var(--ink-inverse)',
              cursor: 'pointer'
            }}
          >
            Clear
          </button>
          <span style={{ fontSize: 12, color: 'var(--ink-subtle)', marginLeft: 8 }}>
            {isEditMode
              ? 'Draw with mouse. Hold Shift for straight lines.'
              : 'View mode (read-only)'}
          </span>
        </div>
      )}

      <div
        style={{
          border: '1px solid var(--border-subtle)',
          borderRadius: 4,
          overflow: 'hidden',
          lineHeight: 0
        }}
      >
        <canvas
          ref={canvasRef}
          width={CANVAS_W}
          height={CANVAS_H}
          style={{
            width: '100%',
            aspectRatio: '2 / 1',
            touchAction: 'none',
            cursor: isEditMode ? 'crosshair' : 'default',
            pointerEvents: isEditMode ? 'auto' : 'none'
          }}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
        />
      </div>

      <details style={{ marginTop: 12 }} open>
        <summary
          style={{
            fontSize: 12,
            color: 'var(--ink-muted)',
            cursor: 'pointer',
            userSelect: 'none'
          }}
        >
          Serialized text ({GRID_COLS}x{GRID_ROWS})
        </summary>
        <pre
          style={{
            marginTop: 4,
            padding: 12,
            fontSize: 10,
            lineHeight: '12px',
            fontFamily: 'monospace',
            background: 'var(--surface-panel)',
            border: '1px solid var(--border-subtle)',
            borderRadius: 4,
            overflow: 'auto',
            whiteSpace: 'pre'
          }}
        >
          {serialized}
        </pre>
      </details>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Stories
// ---------------------------------------------------------------------------

export const meta = {
  title: 'Editor/SketchGrid'
};

/** Full interactive sketch grid with toolbar and serialized text output. */
export const Default: Story = () => (
  <div style={{ padding: 32 }}>
    <SketchGrid />
  </div>
);

/**
 * Pre-filled grid shown in view-only mode.
 * Demonstrates how a saved sketch renders without editing controls.
 */
export const ViewMode: Story = () => {
  const sampleText = [
    '............................................................',
    '............................................................',
    '....+----------------------------+..........................',
    '....|                            |..........................',
    '....|                            |..........................',
    '....|                            |..........................',
    '....|                            |..........................',
    '....+----------------------------+..........................',
    '............................................................',
    '............................................................',
    '..........+--------+............+--------+..................',
    '..........|        |............|        |..................',
    '..........|        |............|        |..................',
    '..........+--------+............+--------+..................',
    '............................................................',
    '....................|............|..........................',
    '....................|............|..........................',
    '..........+---------+----------+---------+..................',
    '..........|                              |..................',
    '..........|                              |..................',
    '..........+------------------------------+..................',
    '............................................................',
    '............................................................',
    '............................................................',
    '............................................................',
    '............................................................',
    '............................................................',
    '............................................................',
    '............................................................',
    '............................................................'
  ].join('\n');

  const sampleGrid = textToGrid(sampleText);

  return (
    <div style={{ padding: 32 }}>
      <SketchGrid initialGrid={sampleGrid} editable={false} />
    </div>
  );
};
