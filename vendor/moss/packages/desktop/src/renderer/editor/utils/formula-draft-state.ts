// ported-from: packages/desktop/src/renderer/editor/utils/formula-draft-state.ts @ 762abb777
import { findFormulaPatternAtCursor, type CodeRange } from './formula-runtime';

const FORMULA_EDIT_ID_STYLE_REGEX = /--formula-edit-id:\s*([^;]+)/;

export interface FormulaDraftSegmentRange {
  start: number;
  end: number;
  style: string;
}

export interface FormulaEditState {
  isEditMode: boolean;
  editId: string | null;
  rangeStart: number;
  rangeEnd: number;
}

interface ResolveFormulaRangeEndOptions {
  text: string;
  cursorOffset: number;
  editState: FormulaEditState;
  allowEmptyExpression: boolean;
  allowInlineAnonymous: boolean;
  codeRanges: CodeRange[];
}

const EMPTY_EDIT_STATE: FormulaEditState = {
  isEditMode: false,
  editId: null,
  rangeStart: -1,
  rangeEnd: -1
};

export function extractFormulaEditId(style: string): string | null {
  const match = FORMULA_EDIT_ID_STYLE_REGEX.exec(style);
  return match?.[1]?.trim() ?? null;
}

function offsetWithinRange(offset: number, start: number, end: number): boolean {
  return offset >= start && offset <= end;
}

export function resolveFormulaEditState(
  segments: FormulaDraftSegmentRange[],
  cursorOffset: number
): FormulaEditState {
  const editSegments = segments
    .map((segment) => {
      const editId = extractFormulaEditId(segment.style);
      return editId
        ? { start: segment.start, end: segment.end, editId }
        : null;
    })
    .filter((segment): segment is { start: number; end: number; editId: string } => segment !== null);

  if (editSegments.length === 0) {
    return EMPTY_EDIT_STATE;
  }

  // Only adopt an edit id whose segment actually contains the cursor. Falling
  // back to an arbitrary edit segment made a NEW formula typed elsewhere on the
  // line commit with an existing pill's formula id — silently overwriting it.
  const activeSegment =
    editSegments.find((segment) => offsetWithinRange(cursorOffset, segment.start, segment.end)) ??
    editSegments.find((segment) => segment.end === cursorOffset) ??
    null;
  if (!activeSegment) {
    return EMPTY_EDIT_STATE;
  }

  const activeEditId = activeSegment.editId;
  let rangeStart = Infinity;
  let rangeEnd = -Infinity;

  for (const segment of editSegments) {
    if (segment.editId !== activeEditId) {
      continue;
    }
    rangeStart = Math.min(rangeStart, segment.start);
    rangeEnd = Math.max(rangeEnd, segment.end);
  }

  if (!Number.isFinite(rangeStart) || !Number.isFinite(rangeEnd)) {
    return EMPTY_EDIT_STATE;
  }

  return {
    isEditMode: true,
    editId: activeEditId,
    rangeStart,
    rangeEnd
  };
}

export function resolveFormulaRangeEnd({
  text,
  cursorOffset,
  editState,
  allowEmptyExpression,
  allowInlineAnonymous,
  codeRanges
}: ResolveFormulaRangeEndOptions): number {
  if (!editState.isEditMode) {
    return cursorOffset;
  }

  if (cursorOffset <= editState.rangeEnd) {
    return editState.rangeEnd;
  }

  const cursorPattern = findFormulaPatternAtCursor(text, cursorOffset, {
    allowEmptyExpression,
    allowInlineAnonymous,
    codeRanges
  });
  if (!cursorPattern) {
    return editState.rangeEnd;
  }

  // Keep edit mode anchored to the original formula token.
  if (cursorPattern.startIndex > editState.rangeStart) {
    return editState.rangeEnd;
  }

  return cursorOffset;
}
