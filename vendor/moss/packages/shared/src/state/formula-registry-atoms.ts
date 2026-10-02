// ported-from: packages/shared/src/state/formula-registry-atoms.ts @ 762abb777
import { atom } from 'jotai';
import { atomFamily } from 'jotai-family';

export interface RegisteredFormula {
  noteId: string;
  formulaId: string;
  name: string | null;
  expression: string;
  result: string;
  stale: boolean;
}

/**
 * Per-note formula registry: noteId → Map<formulaId, RegisteredFormula>.
 * FormulaNodes register into this on mount/update and deregister on removal.
 */
export const noteFormulaRegistryAtom = atomFamily((_noteId: string) =>
  atom(new Map<string, RegisteredFormula>())
);

/** Tracks which note IDs have active registries so allNamedFormulasAtom can read them. */
export const activeRegistryNoteIdsAtom = atom(new Set<string>());

/** Derived: all named formulas across all active note registries (for typeahead). */
export const allNamedFormulasAtom = atom((get) => {
  const noteIds = get(activeRegistryNoteIdsAtom);
  const result: RegisteredFormula[] = [];
  for (const noteId of noteIds) {
    const registry = get(noteFormulaRegistryAtom(noteId));
    for (const formula of registry.values()) {
      if (formula.name) {
        result.push(formula);
      }
    }
  }
  return result;
});
