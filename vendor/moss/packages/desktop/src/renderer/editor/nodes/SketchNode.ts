// ported-from: packages/desktop/src/renderer/editor/nodes/SketchNode.tsx @ 762abb777 (extracted)
import type { JSX } from 'react';
import { $applyNodeReplacement, type DOMConversionMap, type DOMConversionOutput, type DOMExportOutput, DecoratorNode, type EditorConfig, type LexicalNode, type NodeKey, type SerializedLexicalNode, type Spread } from 'lexical';
import { cloneCommentIds, exportCommentIds, importCommentIds, initCommentIds } from '../utils/commentable-node';
import { MOSS_CANVAS_FENCE_NAME } from '../../../common/markdown-fences';
import { renderNodeView } from './node-views';

// ---------------------------------------------------------------------------
// Grid constants and types
// ---------------------------------------------------------------------------

export type PixelGrid = boolean[];

export type TextLabel = {
  id: string;
  text: string;
  col: number;
  row: number;
};

export const GRID_COLS = 120;

export const GRID_ROWS = 60;

 // 2.5

// Legacy grid dimensions for upscaling
const LEGACY_COLS = 60;

const LEGACY_ROWS = 30;

// ---------------------------------------------------------------------------
// Grid utilities
// ---------------------------------------------------------------------------

export function createEmptyGrid(): boolean[] {
  return new Array(GRID_COLS * GRID_ROWS).fill(false);
}

export function gridToText(grid: boolean[]): string {
  const lines: string[] = [];
  for (let row = 0; row < GRID_ROWS; row++) {
    let line = '';
    for (let col = 0; col < GRID_COLS; col++) {
      const idx = row * GRID_COLS + col;
      if (!grid[idx]) {
        line += '.';
        continue;
      }
      const left = col > 0 && grid[idx - 1];
      const right = col < GRID_COLS - 1 && grid[idx + 1];
      const up = row > 0 && grid[(row - 1) * GRID_COLS + col];
      const down = row < GRID_ROWS - 1 && grid[(row + 1) * GRID_COLS + col];
      const hasH = left || right;
      const hasV = up || down;
      if (hasH && hasV) line += '+';
      else if (hasH) line += '-';
      else if (hasV) line += '|';
      else line += '#';
    }
    lines.push(line);
  }
  return lines.join('\n');
}

export function textToGrid(text: string): boolean[] {
  const grid = createEmptyGrid();
  const lines = text.split('\n').filter(l => !l.startsWith('[moss:'));
  for (let row = 0; row < Math.min(lines.length, GRID_ROWS); row++) {
    const line = lines[row];
    for (let col = 0; col < Math.min(line.length, GRID_COLS); col++) {
      const ch = line[col];
      if (ch !== '.' && ch !== ' ') {
        grid[row * GRID_COLS + col] = true;
      }
    }
  }
  return grid;
}

export function upscaleLegacyGrid(text: string): boolean[] {
  // Parse as legacy 60x30 grid
  const old = new Array(LEGACY_COLS * LEGACY_ROWS).fill(false);
  const lines = text.split('\n').filter(l => !l.startsWith('[moss:'));
  for (let row = 0; row < Math.min(lines.length, LEGACY_ROWS); row++) {
    const line = lines[row];
    for (let col = 0; col < Math.min(line.length, LEGACY_COLS); col++) {
      const ch = line[col];
      if (ch !== '.' && ch !== ' ') {
        old[row * LEGACY_COLS + col] = true;
      }
    }
  }
  // Map each 60x30 cell to a 2x2 block in 120x60
  const next = new Array(GRID_COLS * GRID_ROWS).fill(false);
  for (let row = 0; row < LEGACY_ROWS; row++) {
    for (let col = 0; col < LEGACY_COLS; col++) {
      const val = old[row * LEGACY_COLS + col];
      if (val) {
        next[(row * 2) * GRID_COLS + (col * 2)] = true;
        next[(row * 2) * GRID_COLS + (col * 2 + 1)] = true;
        next[(row * 2 + 1) * GRID_COLS + (col * 2)] = true;
        next[(row * 2 + 1) * GRID_COLS + (col * 2 + 1)] = true;
      }
    }
  }
  return next;
}

function parseLabelsHeader(headers: string[]): TextLabel[] {
  const prefix = '[moss:labels:';
  const line = headers.find(h => h.startsWith(prefix));
  if (!line) return [];
  // Extract JSON between [moss:labels: and trailing ]
  const jsonStr = line.slice(prefix.length, -1);
  try {
    const parsed = JSON.parse(jsonStr);
    if (!Array.isArray(parsed)) return [];
    return parsed;
  } catch {
    return [];
  }
}

export function parseSketchBlock(text: string): { grid: boolean[]; labels: TextLabel[] } {
  const allLines = text.split('\n');
  const headers: string[] = [];
  const gridLines: string[] = [];

  for (const line of allLines) {
    if (line.startsWith('[moss:')) {
      headers.push(line);
    } else {
      gridLines.push(line);
    }
  }

  const isV2 = headers.some(h => h === '[moss:grid:v2]');
  const gridText = gridLines.join('\n');
  const grid = isV2 ? textToGrid(gridText) : upscaleLegacyGrid(gridText);
  const labels = parseLabelsHeader(headers);

  return { grid, labels };
}

export function buildSketchMarkdown(grid: boolean[], labels: TextLabel[]): string {
  const parts: string[] = [];
  parts.push('[moss:grid:v2]');
  if (labels.length > 0) {
    parts.push('[moss:labels:' + JSON.stringify(labels) + ']');
  }
  parts.push(gridToText(grid));
  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// Serialized format
// ---------------------------------------------------------------------------

export type SerializedSketchNode = Spread<
  {
    grid: string;
    commentIds?: string[];
  },
  SerializedLexicalNode
>;

// ---------------------------------------------------------------------------
// DOM conversion helpers
// ---------------------------------------------------------------------------

function $convertSketchElement(domNode: HTMLElement): DOMConversionOutput | null {
  const gridText = domNode.getAttribute('data-sketch-grid');
  if (gridText) {
    const { grid, labels } = parseSketchBlock(gridText);
    const node = $createSketchNode(grid, labels);
    return { node };
  }
  // Fallback: try textContent for <pre> elements
  const text = domNode.textContent;
  if (text && text.includes('.')) {
    const { grid, labels } = parseSketchBlock(text);
    const node = $createSketchNode(grid, labels);
    return { node };
  }
  return null;
}

// ---------------------------------------------------------------------------
// SketchNode class
// ---------------------------------------------------------------------------

export class SketchNode extends DecoratorNode<JSX.Element> {
  __grid: boolean[];
  __labels: TextLabel[];
  __commentIds: string[];

  static getType(): string {
    return 'sketch';
  }

  static clone(node: SketchNode): SketchNode {
    return new SketchNode(
      [...node.__grid],
      [...node.__labels.map(l => ({ ...l }))],
      node.__key,
      cloneCommentIds(node.__commentIds)
    );
  }

  constructor(grid: boolean[] = createEmptyGrid(), labels: TextLabel[] = [], key?: NodeKey, commentIds?: string[]) {
    super(key);
    this.__grid = grid;
    this.__labels = labels;
    this.__commentIds = initCommentIds(commentIds);
  }

  static importJSON(serializedNode: SerializedSketchNode): SketchNode {
    const { grid, labels } = parseSketchBlock(serializedNode.grid);
    const node = $createSketchNode(grid, labels);
    node.__commentIds = importCommentIds(serializedNode as unknown as Record<string, unknown>);
    return node;
  }

  exportJSON(): SerializedSketchNode {
    return {
      type: 'sketch',
      version: 1,
      grid: buildSketchMarkdown(this.__grid, this.__labels),
      ...exportCommentIds(this.__commentIds)
    };
  }

  static importDOM(): DOMConversionMap | null {
    return {
      pre: (domNode: HTMLElement) => {
        if (!domNode.hasAttribute('data-sketch-grid')) {
          return null;
        }
        return {
          conversion: $convertSketchElement,
          priority: 1
        };
      }
    };
  }

  exportDOM(): DOMExportOutput {
    const element = document.createElement('pre');
    const text = buildSketchMarkdown(this.__grid, this.__labels);
    element.setAttribute('data-sketch-grid', text);
    element.textContent = text;
    return { element };
  }

  createDOM(config: EditorConfig): HTMLElement {
    const div = document.createElement('div');
    const theme = config.theme;
    const className = theme.sketch;
    if (className) {
      div.className = className;
    }
    return div;
  }

  updateDOM(): boolean {
    return false;
  }

  getGrid(): boolean[] {
    return this.__grid;
  }

  setGrid(grid: boolean[]): void {
    const writable = this.getWritable();
    writable.__grid = grid;
  }

  getLabels(): TextLabel[] {
    return this.__labels;
  }

  setLabels(labels: TextLabel[]): void {
    const writable = this.getWritable();
    writable.__labels = labels;
  }

  getCommentIds(): string[] {
    return this.__commentIds;
  }

  setCommentIds(ids: string[]): void {
    const writable = this.getWritable();
    writable.__commentIds = ids;
  }

  getTextContent(): string {
    return (
      '```' +
      MOSS_CANVAS_FENCE_NAME +
      '\n' +
      buildSketchMarkdown(this.__grid, this.__labels) +
      '\n```'
    );
  }

  decorate(): JSX.Element {
    // moss-multi seam: node-views (A§12)
    return renderNodeView(this);
  }

  isInline(): boolean {
    return false;
  }

  isIsolated(): boolean {
    return true;
  }

  isKeyboardSelectable(): boolean {
    return true;
  }
}

export function $createSketchNode(grid?: boolean[], labels?: TextLabel[]): SketchNode {
  return $applyNodeReplacement(new SketchNode(grid ?? createEmptyGrid(), labels ?? []));
}

export function $isSketchNode(node: LexicalNode | null | undefined): node is SketchNode {
  return node instanceof SketchNode;
}
