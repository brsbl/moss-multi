// ported-from: packages/desktop/src/renderer/editor/utils/formula-suggestions.ts @ 762abb777
import type { LexicalEditor } from 'lexical';

export interface FormulaSuggestion {
  noteId: string;
  formulaId: string;
  name: string;
  result: string;
  noteTitle: string;
  /** Humanized expression preview (reference tokens shown as names). */
  expression: string;
}

type FormulaSuggestionProvider = (query: string) => FormulaSuggestion[];
type FormulaReferenceValueResolver = (reference: {
  name: string;
  noteId: string;
  formulaId: string;
}) => number | null;
type FormulaBareNameResolver = (name: string) => FormulaSuggestion | null;

// MathCalculationPlugin owns the workspace evaluation; FormulaPlugin's edit
// popover consumes it for reference typeahead and live evaluation. Keyed per
// editor instance so split panes don't cross-suggest.
const providers = new Map<
  LexicalEditor,
  {
    suggest: FormulaSuggestionProvider;
    resolve: FormulaReferenceValueResolver;
    resolveBareName: FormulaBareNameResolver;
  }
>();

export function registerFormulaSuggestionProvider(
  editor: LexicalEditor,
  provider: {
    suggest: FormulaSuggestionProvider;
    resolve: FormulaReferenceValueResolver;
    resolveBareName: FormulaBareNameResolver;
  }
): () => void {
  providers.set(editor, provider);
  return () => {
    if (providers.get(editor) === provider) {
      providers.delete(editor);
    }
  };
}

export function queryFormulaSuggestions(
  editor: LexicalEditor,
  query: string
): FormulaSuggestion[] {
  const provider = providers.get(editor);
  return provider ? provider.suggest(query) : [];
}

/**
 * Resolve a bound reference to its current numeric value via the owning
 * editor's workspace evaluation. Null when unavailable — callers must treat
 * that as "unknown", not zero.
 */
export function resolveFormulaReferenceValue(
  editor: LexicalEditor,
  reference: { name: string; noteId: string; formulaId: string }
): number | null {
  const provider = providers.get(editor);
  return provider ? provider.resolve(reference) : null;
}

/**
 * Resolve a typed/pasted bare identifier to a workspace formula using the
 * owning editor's unambiguity rules (current-note matches win; ambiguous
 * names resolve to null). Used by the edit popover to bind names that were
 * never accepted through the typeahead.
 */
export function resolveFormulaBareName(
  editor: LexicalEditor,
  name: string
): FormulaSuggestion | null {
  const provider = providers.get(editor);
  return provider ? provider.resolveBareName(name) : null;
}
