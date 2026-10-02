// ported-from: packages/desktop/src/renderer/editor/utils/formula-edit-session.ts @ 762abb777
import type { NodeKey } from 'lexical';

export interface EditedFormulaSession {
  formulaId: string;
}

const editedFormulaSessionsByTextNodeKey = new Map<NodeKey, EditedFormulaSession>();

export function registerEditedFormulaId(
  textNodeKey: NodeKey,
  formulaId: string
): void {
  editedFormulaSessionsByTextNodeKey.set(textNodeKey, { formulaId });
}

export function peekEditedFormulaSession(textNodeKey: NodeKey): EditedFormulaSession | null {
  return editedFormulaSessionsByTextNodeKey.get(textNodeKey) ?? null;
}

export function peekEditedFormulaId(textNodeKey: NodeKey): string | null {
  return peekEditedFormulaSession(textNodeKey)?.formulaId ?? null;
}

export function consumeEditedFormulaId(textNodeKey: NodeKey): string | null {
  const formulaId = peekEditedFormulaId(textNodeKey);
  editedFormulaSessionsByTextNodeKey.delete(textNodeKey);
  return formulaId;
}

export function clearEditedFormulaId(textNodeKey: NodeKey): void {
  editedFormulaSessionsByTextNodeKey.delete(textNodeKey);
}

export function clearAllEditedFormulaIds(): void {
  editedFormulaSessionsByTextNodeKey.clear();
}
