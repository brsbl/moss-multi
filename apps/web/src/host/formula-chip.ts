import type { LexicalEditor } from 'lexical';

export interface LineRect { left: number; top: number; width: number; height: number }
export interface ChipBox extends LineRect { roundStart: boolean; roundEnd: boolean }

export function formulaChipBoxes(lines: LineRect[], _options: { lineHeight: number; startRoom?: number; endRoom?: number }): ChipBox[] {
  return lines.map((line, index) => ({ ...line, roundStart: index === 0, roundEnd: index === lines.length - 1 }));
}

export function paintFormulaDraft(_editor: LexicalEditor, _ranges: Range[]): void {}
