// ported-from: packages/desktop/src/renderer/editor/plugins/FormulaPlugin.tsx @ 762abb777
// moss-multi seam: local-view (A§10): edit-session identity stays in the existing local map.
// moss-multi seam: register drafts merge while the formula popover stays open.
import { mergeIntoField, nodeRegister, useFollowRegister, useRegisterWritable } from '@moss-multi/host/collab/register-input';
import { registerDoc, registerState, REGISTER_LOCAL_ORIGIN, writeRegisterEdit } from '@moss-multi/host/collab/registers';
import { $isBoundEditor } from '@moss-multi/host/collab/view-state';
/**
 * FormulaPlugin - Keyboard navigation for formula nodes
 *
 * Includes hover preview and backspace-to-edit behavior.
 */
import type { JSX, KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { $getNodeByKey, $getRoot, $nodesOfType, HISTORY_MERGE_TAG, HISTORY_PUSH_TAG, REDO_COMMAND, SKIP_DOM_SELECTION_TAG, UNDO_COMMAND } from 'lexical';
import { Calculator, CornerDownLeft, Variable, X } from 'lucide-react';

import { Popover } from '@moss/shared/primitives';
import { $isFormulaNode, FormulaNode } from '../nodes/FormulaNode';
import { useDecoratorBackspace } from '../hooks';
import { HoverCard, type HoverCardPosition } from '../typeahead';
import { registerEditedFormulaId } from '../utils/formula-edit-session';
import {
  queryFormulaSuggestions,
  resolveFormulaBareName,
  resolveFormulaReferenceValue,
  type FormulaSuggestion
} from '../utils/formula-suggestions';
import {
  classifyFormulaSource,
  createFormulaReferenceToken,
  evaluateFormulaExpression,
  formatFormulaValue,
  isValidFormulaName,
  type FormulaReferenceToken,
  type FormulaSourceMode
} from '../utils/formula-runtime';
import { EDITOR_UPDATE_TAGS } from '../utils/editorUpdateTags';

const FORMULA_REFERENCE_TOKEN_REGEX =
  /@\(([a-zA-Z][a-zA-Z0-9_-]*)#([0-9a-fA-F-]{36})#([0-9a-fA-F-]{36})\)/g;
const RAW_REFERENCE_TOKEN_SPLIT_REGEX =
  /(@\([a-zA-Z][a-zA-Z0-9_-]*#[0-9a-fA-F-]{36}#[0-9a-fA-F-]{36}\))/g;
// No `-` in the lookbehind: an identifier directly after a dash must still
// match (stored `100-@(cost#…)` humanizes to `100-cost` and needs to rebind).
// Greedy letter-start matching still consumes whole dashed names.
const BARE_IDENTIFIER_REGEX = /(?<![A-Za-z0-9_@#])([A-Za-z][A-Za-z0-9_-]*)/g;

interface PositionedFormulaReference extends FormulaReferenceToken {
  start: number;
  end: number;
}

const humanizeFormulaExpressionWithReferences = (
  expression: string
): { expression: string; references: PositionedFormulaReference[] } => {
  let humanized = '';
  let sourceIndex = 0;
  const references: PositionedFormulaReference[] = [];
  let match: RegExpExecArray | null;
  FORMULA_REFERENCE_TOKEN_REGEX.lastIndex = 0;

  while ((match = FORMULA_REFERENCE_TOKEN_REGEX.exec(expression)) !== null) {
    humanized += expression.slice(sourceIndex, match.index);
    const start = humanized.length;
    humanized += match[1];
    references.push({
      name: match[1],
      noteId: match[2],
      formulaId: match[3],
      start,
      end: humanized.length
    });
    sourceIndex = match.index + match[0].length;
  }

  return {
    expression: humanized + expression.slice(sourceIndex),
    references
  };
};

const toEditableExpression = (expression: string): string =>
  humanizeFormulaExpressionWithReferences(expression).expression;

const remapPositionedReferences = (
  previousExpression: string,
  nextExpression: string,
  references: PositionedFormulaReference[],
  selectionStart = nextExpression.length
): PositionedFormulaReference[] => {
  if (previousExpression === nextExpression) {
    return references;
  }

  const prefixLimit = Math.min(
    previousExpression.length,
    nextExpression.length,
    Math.max(0, selectionStart)
  );
  let commonPrefixLength = 0;
  while (
    commonPrefixLength < prefixLimit &&
    previousExpression[commonPrefixLength] === nextExpression[commonPrefixLength]
  ) {
    commonPrefixLength += 1;
  }

  let commonSuffixLength = 0;
  while (
    previousExpression.length - commonSuffixLength > commonPrefixLength &&
    nextExpression.length - commonSuffixLength > commonPrefixLength &&
    previousExpression[previousExpression.length - commonSuffixLength - 1] ===
      nextExpression[nextExpression.length - commonSuffixLength - 1]
  ) {
    commonSuffixLength += 1;
  }

  const previousChangeEnd = previousExpression.length - commonSuffixLength;
  const nextChangeEnd = nextExpression.length - commonSuffixLength;
  const offset = nextChangeEnd - previousChangeEnd;

  return references.flatMap((reference) => {
    if (reference.end <= commonPrefixLength) {
      return [reference];
    }
    if (reference.start >= previousChangeEnd) {
      return [{
        ...reference,
        start: reference.start + offset,
        end: reference.end + offset
      }];
    }
    return [];
  });
};

/**
 * Inverse of humanizeFormulaExpression for the edit popover: bare identifiers
 * at tracked reference ranges are rebound to their full
 * `@(name#noteId#formulaId)` token before validation/persistence, so
 * same-named references retain identity across edits.
 * Already-raw tokens (e.g. pasted) pass through untouched. Identifiers that
 * match no bound reference fall back to `resolveBareName` so typed/pasted
 * names bind when the workspace resolves them unambiguously.
 */
const rebindHumanizedExpression = (
  expression: string,
  references: PositionedFormulaReference[],
  resolveBareName?: (name: string) => FormulaReferenceToken | null
): string => {
  if (references.length === 0 && !resolveBareName) {
    return expression;
  }

  const validReferences = references
    .filter(
      (reference) =>
        reference.start >= 0 &&
        reference.end <= expression.length &&
        expression.slice(reference.start, reference.end) === reference.name
    )
    .sort((a, b) => a.start - b.start);
  let sourceIndex = 0;
  let rebound = '';
  for (const reference of validReferences) {
    if (reference.start < sourceIndex) {
      continue;
    }
    rebound += expression.slice(sourceIndex, reference.start);
    rebound += createFormulaReferenceToken(reference);
    sourceIndex = reference.end;
  }
  rebound += expression.slice(sourceIndex);

  // `-` is ambiguous: legal inside variable names AND the subtraction operator
  // (the inline commit grammar treats it as a separator). Greedily bind the
  // longest dash-joined prefix that names a known reference, consume it, and
  // repeat on the rest; unmatched single parts stay bare. Dashes between
  // bound chunks remain subtraction operators.
  const bindIdentifier = (identifier: string): string => {
    if (!identifier.includes('-')) {
      const direct = resolveBareName?.(identifier) ?? null;
      return direct ? createFormulaReferenceToken(direct) : identifier;
    }
    const parts = identifier.split('-');
    const bound: string[] = [];
    let index = 0;
    while (index < parts.length) {
      let matched = false;
      for (let end = parts.length; end > index; end -= 1) {
        const reference = resolveBareName?.(parts.slice(index, end).join('-')) ?? null;
        if (reference) {
          bound.push(createFormulaReferenceToken(reference));
          index = end;
          matched = true;
          break;
        }
      }
      if (!matched) {
        bound.push(parts[index]);
        index += 1;
      }
    }
    return bound.join('-');
  };
  return rebound
    .split(RAW_REFERENCE_TOKEN_SPLIT_REGEX)
    .map((chunk, index) =>
      index % 2 === 1 ? chunk : chunk.replace(BARE_IDENTIFIER_REGEX, bindIdentifier)
    )
    .join('');
};

interface AnchorRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface EditingFormula {
  nodeKey: string;
  noteId: string;
  formulaId: string;
  name: string;
  expression: string;
  result: string;
  anchorRect: AnchorRect;
  collisionBoundary: Element | null;
  sourceMode: FormulaSourceMode;
  /** Bound references tracked by their ranges in the humanized expression. */
  references: PositionedFormulaReference[];
  /** Changes when the popover (re)reads its formula: on open and when its payload arrives, not when it follows a move. */
  session: number;
  /** Opened on a bound note before its payload arrived: the mode and draft are read again once it does. */
  pending: boolean;
}

let formulaEditSessions = 0;

interface FormulaDraft {
  name: string;
  expression: string;
}

interface FormulaDraftChange {
  selectionStart?: number;
  acceptedReference?: PositionedFormulaReference;
  references?: PositionedFormulaReference[];
  formulaId?: string;
}

interface FormulaDraftSnapshot {
  draft: FormulaDraft;
  references: PositionedFormulaReference[];
  formulaId: string;
}

interface PreviewState {
  isVisible: boolean;
  position: HoverCardPosition;
  name: string | null;
  formula: string;
  result: string;
  stale: boolean;
  sourceMode: FormulaSourceMode;
}

const initialPreviewState: PreviewState = {
  isVisible: false,
  position: { x: 0, y: 0 },
  name: null,
  formula: '',
  result: '',
  stale: false,
  sourceMode: 'invalid'
};

const FORMULA_PREVIEW_HIDE_DELAY_MS = 80;
const FORMULA_EDIT_SIDE_OFFSET = 8;
const FORMULA_EDIT_INPUT_MAX_CH = 30;
const FORMULA_EDIT_INPUT_MIN_CH = 4;
/**
 * Worst-case popover height: input row (~40) + typeahead list (max-h-56 =
 * 224) + borders/offset. Used to pick the popover side ONCE at open — the
 * side is then pinned so the suggestions list appearing/disappearing can't
 * flip the popover mid-edit.
 */
const FORMULA_EDIT_MAX_POPOVER_HEIGHT = 280;
const FORMULA_EDIT_TOP_CLEARANCE = 48 + 24; // topnav + collision padding

const formulaDraftsEqual = (a: FormulaDraft | null, b: FormulaDraft | null): boolean =>
  Boolean(a && b && a.name.trim() === b.name.trim() && a.expression.trim() === b.expression.trim());

// Quantized to 4ch steps so the input (and the popover around it) doesn't
// resize on every keystroke.
const getDraftInputWidthCh = (value: string, placeholder: string): number =>
  Math.min(
    FORMULA_EDIT_INPUT_MAX_CH,
    Math.ceil(
      Math.max(FORMULA_EDIT_INPUT_MIN_CH, placeholder.length + 2, value.length + 2) / 4
    ) * 4
  );

const isFormulaDraftValidForMode = (
  draft: FormulaDraft,
  sourceMode: FormulaSourceMode,
  storedDisplay: string
): boolean => {
  const nextName = draft.name.trim();
  const nextExpression = draft.expression.trim();
  if (!nextExpression) {
    return false;
  }
  if (sourceMode === 'symbolic') {
    return isValidFormulaName(nextName);
  }
  if (nextName.length > 0 && !isValidFormulaName(nextName)) {
    return false;
  }
  return classifyFormulaSource(nextExpression, { storedDisplay }) === 'executable';
};

function FormulaPreview({ state }: { state: PreviewState }) {
  const isSymbolic = state.sourceMode === 'symbolic';
  const Icon = isSymbolic ? Variable : Calculator;
  const label = isSymbolic ? state.formula : state.name;
  const expression = toEditableExpression(state.formula);
  const detail = isSymbolic ? `= ${state.result}` : `= ${expression}`;

  return (
    <HoverCard
      isVisible={state.isVisible}
      position={state.position}
      className="p-2.5"
      maxWidth={280}
    >
      <div data-formula-preview="true" className="flex items-start gap-2">
        <Icon className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-accent-brand" aria-hidden />
        <div className="min-w-0 flex-1">
          {label ? (
            <p className="text-nano font-medium uppercase tracking-wide text-ink-muted">
              {label}
            </p>
          ) : null}
          <p className="truncate font-mono text-small font-medium text-ink-default">{detail}</p>
          {!isSymbolic && state.stale ? (
            <p className="mt-1.5 text-nano text-ink-muted">
              stale - source formula was deleted or is unavailable
            </p>
          ) : null}
        </div>
      </div>
    </HoverCard>
  );
}

function rectFromElement(element: Element): AnchorRect {
  const rect = element.getBoundingClientRect();
  return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
}

interface PopoverSuggestionState {
  items: FormulaSuggestion[];
  tokenStart: number;
  tokenEnd: number;
  selectedIndex: number;
}

/** Identifier fragment ending at the caret, excluding mid-token and numeric-suffix positions. */
function findSuggestionQueryFragment(
  value: string,
  caret: number
): { start: number; query: string } | null {
  const match = /([A-Za-z][A-Za-z0-9_-]*)$/.exec(value.slice(0, caret));
  if (!match) {
    return null;
  }
  const start = caret - match[1].length;
  const previous = start > 0 ? value[start - 1] : '';
  // `-` is deliberately absent: a fragment can't start mid-dashed-token (the
  // fragment regex already scans back over dashes), so a `-` before the
  // fragment is the subtraction operator (e.g. "5-co" should suggest on "co").
  if (previous && /[A-Za-z0-9_@#.]/.test(previous)) {
    return null;
  }
  return { start, query: match[1] };
}

function FormulaEditPopover({
  editingFormula,
  onClose,
  onDraftChange,
  onHistoryShortcut,
  isDraftValid,
  readCurrentDraft,
  getSuggestions
}: {
  editingFormula: EditingFormula;
  onClose: (options?: { restoreFocus?: boolean }) => void;
  onDraftChange: (draft: FormulaDraft, change?: FormulaDraftChange) => boolean;
  onHistoryShortcut: (direction: 'undo' | 'redo') => FormulaDraft | null;
  isDraftValid: (draft: FormulaDraft) => boolean;
  readCurrentDraft: () => FormulaDraft | null;
  getSuggestions: (query: string) => FormulaSuggestion[];
}): JSX.Element | null {
  const [editor] = useLexicalComposerContext();
  const writable = useRegisterWritable(editor, editingFormula.nodeKey);
  const [name, setName] = useState(editingFormula.name);
  const [expression, setExpression] = useState(editingFormula.expression);
  const [suggestionState, setSuggestionState] = useState<PopoverSuggestionState | null>(null);
  const nameInputRef = useRef<HTMLInputElement | null>(null);
  const expressionInputRef = useRef<HTMLInputElement | null>(null);
  const latestDraftRef = useRef<FormulaDraft>({
    name: editingFormula.name,
    expression: editingFormula.expression
  });
  const virtualRef = useRef<{ getBoundingClientRect: () => DOMRect }>({
    getBoundingClientRect: () => new DOMRect()
  });
  virtualRef.current = {
    getBoundingClientRect: () =>
      new DOMRect(
        editingFormula.anchorRect.x,
        editingFormula.anchorRect.y,
        editingFormula.anchorRect.width,
        editingFormula.anchorRect.height
      )
  };

  const setDraftState = useCallback((draft: FormulaDraft) => {
    latestDraftRef.current = draft;
    if (nameInputRef.current) {
      nameInputRef.current.value = draft.name;
    }
    if (expressionInputRef.current) {
      expressionInputRef.current.value = draft.expression;
    }
    setName(draft.name);
    setExpression(draft.expression);
    setSuggestionState(null);
  }, []);

  const syncDraftFromNode = useCallback(() => {
    const draft = readCurrentDraft();
    if (!draft || formulaDraftsEqual(draft, latestDraftRef.current)) {
      return;
    }
    setDraftState(draft);
  }, [readCurrentDraft, setDraftState]);

  // The payload's text as the field last saw it, so a peer's change merges into text the field has not written.
  const syncedRef = useRef('');
  // The other field as the node last held it: the draft keeps its own value there only once the person has changed it.
  const syncedOtherRef = useRef('');
  // Whether the field holds a merge no keystroke has written since, so accepting writes it again after the peer's edit.
  const mergedRef = useRef(false);
  useEffect(() => {
    const text = nodeRegister(editor, editingFormula.nodeKey);
    if (!text) return;
    let stopped = false;
    const changed = (_event: unknown, transaction: { origin: unknown }) => {
      const local = transaction.origin === REGISTER_LOCAL_ORIGIN;
      queueMicrotask(() => {
        if (stopped) return;
        const draft = readCurrentDraft();
        if (!draft) return;
        const symbolic = editingFormula.sourceMode === 'symbolic';
        const next = symbolic ? draft.name : draft.expression;
        const base = syncedRef.current;
        syncedRef.current = next;
        const nodeOther = symbolic ? draft.expression : draft.name;
        const baseOther = syncedOtherRef.current;
        syncedOtherRef.current = nodeOther;
        if (local) return;
        const merged = mergeIntoField(symbolic ? nameInputRef.current : expressionInputRef.current, base, next);
        const kept = latestDraftRef.current;
        const keptOther = symbolic ? kept.expression : kept.name;
        const other = keptOther === baseOther ? nodeOther : keptOther;
        const mergedDraft = symbolic ? { name: merged, expression: other } : { name: other, expression: merged };
        setDraftState(mergedDraft);
        // The field's own characters, once the peer's change makes them valid, are written as a keystroke would.
        if (merged !== next) {
          mergedRef.current = true;
          onDraftChange(mergedDraft);
        }
      });
    };
    text.observe(changed);
    return () => { stopped = true; text.unobserve(changed); };
  }, [editor, editingFormula, onDraftChange, readCurrentDraft, setDraftState]);

  // Per session, so following the formula through a peer's move keeps what the inputs show.
  const sessionDraftRef = useRef(editingFormula);
  sessionDraftRef.current = editingFormula;
  useEffect(() => {
    const opened = sessionDraftRef.current;
    syncedRef.current = opened.sourceMode === 'symbolic' ? opened.name : opened.expression;
    syncedOtherRef.current = opened.sourceMode === 'symbolic' ? opened.expression : opened.name;
    mergedRef.current = false;
    setDraftState({ name: opened.name, expression: opened.expression });
  }, [editingFormula.session, setDraftState]);

  useEffect(() => {
    const focusValueInput = () => {
      const input = expressionInputRef.current;
      if (!input) {
        return;
      }
      input.focus({ preventScroll: true });
      input.setSelectionRange(0, input.value.length);
    };
    focusValueInput();
    const frame = requestAnimationFrame(focusValueInput);
    return () => cancelAnimationFrame(frame);
  }, [editingFormula.session]);

  const handleNameChange = useCallback(
    (nextName: string) => {
      const nextDraft = { name: nextName, expression };
      latestDraftRef.current = nextDraft;
      mergedRef.current = false;
      setName(nextName);
      onDraftChange({ name: nextName, expression });
    },
    [expression, onDraftChange]
  );

  const handleExpressionChange = useCallback(
    (nextExpression: string, selectionStart: number | null) => {
      const nextDraft = { name, expression: nextExpression };
      latestDraftRef.current = nextDraft;
      mergedRef.current = false;
      setExpression(nextExpression);
      const caret = selectionStart ?? nextExpression.length;
      onDraftChange(nextDraft, { selectionStart: caret });

      if (editingFormula.sourceMode === 'symbolic') {
        return;
      }
      let fragment = findSuggestionQueryFragment(nextExpression, caret);
      if (!fragment) {
        setSuggestionState(null);
        return;
      }
      let items = getSuggestions(fragment.query).slice(0, 6);
      // Dashed fragment with no dashed-name match: `-` is being used as the
      // subtraction operator (inline grammar) — retry with the last segment.
      if (items.length === 0 && fragment.query.includes('-')) {
        const lastDash = fragment.query.lastIndexOf('-');
        const suffix = fragment.query.slice(lastDash + 1);
        if (suffix.length > 0) {
          fragment = { start: fragment.start + lastDash + 1, query: suffix };
          items = getSuggestions(suffix).slice(0, 6);
        }
      }
      setSuggestionState(
        items.length > 0
          ? { items, tokenStart: fragment.start, tokenEnd: caret, selectedIndex: 0 }
          : null
      );
    },
    [editingFormula.sourceMode, getSuggestions, name, onDraftChange]
  );

  const acceptSuggestion = useCallback(
    (suggestion: FormulaSuggestion) => {
      const state = suggestionState;
      if (!state) {
        return;
      }
      const nextExpression =
        expression.slice(0, state.tokenStart) + suggestion.name + expression.slice(state.tokenEnd);
      const nextDraft = { name, expression: nextExpression };
      latestDraftRef.current = nextDraft;
      setExpression(nextExpression);
      setSuggestionState(null);
      const caretAfter = state.tokenStart + suggestion.name.length;
      onDraftChange(nextDraft, {
        selectionStart: caretAfter,
        acceptedReference: {
          name: suggestion.name,
          noteId: suggestion.noteId,
          formulaId: suggestion.formulaId,
          start: state.tokenStart,
          end: caretAfter
        }
      });
      requestAnimationFrame(() => {
        const input = expressionInputRef.current;
        if (input) {
          input.focus({ preventScroll: true });
          input.setSelectionRange(caretAfter, caretAfter);
        }
      });
    },
    [expression, name, onDraftChange, suggestionState]
  );

  const closeIfValid = useCallback(() => {
    if (!isDraftValid({ name, expression })) {
      return;
    }
    if (mergedRef.current) onDraftChange({ name, expression });
    onClose({ restoreFocus: true });
  }, [expression, isDraftValid, name, onClose, onDraftChange]);

  const handleInputKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLInputElement>) => {
      const hasPrimaryModifier = event.metaKey || event.ctrlKey;
      const key = event.key.toLowerCase();
      const isRedo =
        key === 'y' ||
        (key === 'z' && event.shiftKey) ||
        (key === 'z' && event.metaKey && event.ctrlKey);

      if (hasPrimaryModifier && (isRedo || key === 'z')) {
        event.preventDefault();
        event.stopPropagation();
        const appliedDraft = onHistoryShortcut(isRedo ? 'redo' : 'undo');
        if (appliedDraft) {
          setDraftState(appliedDraft);
          return;
        }
        queueMicrotask(syncDraftFromNode);
        return;
      }

      event.stopPropagation();

      // Typeahead navigation owns arrows/enter/escape while suggestions are open.
      if (suggestionState && event.currentTarget === expressionInputRef.current) {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          const delta = event.key === 'ArrowDown' ? 1 : -1;
          setSuggestionState((previous) =>
            previous
              ? {
                  ...previous,
                  selectedIndex:
                    (previous.selectedIndex + delta + previous.items.length) % previous.items.length
                }
              : previous
          );
          return;
        }
        if (event.key === 'Enter') {
          event.preventDefault();
          acceptSuggestion(suggestionState.items[suggestionState.selectedIndex]);
          return;
        }
        if (event.key === 'Escape') {
          event.preventDefault();
          setSuggestionState(null);
          return;
        }
      }

      if (event.key === 'Escape') {
        event.preventDefault();
        onClose({ restoreFocus: true });
      } else if (event.key === 'Enter') {
        event.preventDefault();
        closeIfValid();
      }
    },
    [acceptSuggestion, closeIfValid, onClose, onHistoryShortcut, setDraftState, suggestionState, syncDraftFromNode]
  );

  const inputClassName =
    'min-h-6 max-w-full shrink-0 rounded-md border border-border-clear bg-surface-transparent py-0.5 pl-1.5 pr-1 text-small leading-relaxed text-ink-default outline-none placeholder:text-ink-faint/50 transition-colors hover:bg-surface-panel focus:border-border-subtle focus:bg-surface-panel';
  const nameInputClassName = `${inputClassName} font-mono text-ink-muted`;
  const actionButtonClassName =
    'flex h-5 shrink-0 items-center justify-center gap-0.5 rounded-md px-1 text-ink-faint transition-colors hover:bg-surface-panel hover:text-ink-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ink-default/15 disabled:cursor-not-allowed disabled:opacity-30';
  const canAccept = useMemo(
    () => isDraftValid({ name, expression }),
    [expression, isDraftValid, name]
  );
  const expressionPlaceholder = editingFormula.sourceMode === 'symbolic' ? 'Value' : 'Formula';
  // Pinned per edit session: below the pill when there isn't guaranteed room
  // above for the fully expanded popover, above otherwise. Never re-flips
  // while the popover is open.
  const pinnedSide =
    editingFormula.anchorRect.y - FORMULA_EDIT_MAX_POPOVER_HEIGHT - FORMULA_EDIT_SIDE_OFFSET <
    FORMULA_EDIT_TOP_CLEARANCE
      ? ('bottom' as const)
      : ('top' as const);

  const suggestionListbox = suggestionState ? (
    <div
      role="listbox"
      aria-label="Variable suggestions"
      className={`max-h-56 overflow-y-auto py-1 ${pinnedSide === 'top' ? 'border-b' : 'border-t'} border-border-subtle`}
    >
      {suggestionState.items.map((suggestion, index) => (
        <button
          key={`${suggestion.noteId}:${suggestion.formulaId}`}
          type="button"
          role="option"
          aria-selected={index === suggestionState.selectedIndex}
          onMouseDown={(event) => {
            // mousedown (not click) so the expression input never blurs
            event.preventDefault();
            acceptSuggestion(suggestion);
          }}
          onMouseEnter={() =>
            setSuggestionState((previous) =>
              previous ? { ...previous, selectedIndex: index } : previous
            )
          }
          className={`flex w-full items-center justify-between gap-3 px-3 py-1.5 text-left text-small transition-colors ${
            index === suggestionState.selectedIndex
              ? 'bg-surface-panel text-ink-default'
              : 'text-ink-muted'
          }`}
        >
          <span className="font-mono">{suggestion.name}</span>
          <span className="min-w-0 truncate text-nano text-ink-faint">
            {suggestion.result || suggestion.expression}
          </span>
        </button>
      ))}
    </div>
  ) : null;

  return (
    <Popover.Root open onOpenChange={(open) => { if (!open) onClose(); }}>
      <Popover.Anchor virtualRef={virtualRef} />
      <Popover.Portal>
        <Popover.Content
          role="dialog"
          aria-label={editingFormula.sourceMode === 'symbolic' ? 'Edit variable' : 'Edit formula'}
          side={pinnedSide}
          align="start"
          sideOffset={FORMULA_EDIT_SIDE_OFFSET}
          collisionAvoidance={{ side: 'none' }}
          collisionBoundary={editingFormula.collisionBoundary ? [editingFormula.collisionBoundary] : undefined}
          collisionPadding={{ top: 24, right: 16, bottom: 88, left: 16 }}
          positionerClassName="z-[51]"
          className="app-region-no-drag z-[51] max-w-floating-popover-viewport rounded-xl border border-border-subtle bg-surface-floating shadow-sm data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95"
          onOpenAutoFocus={(event) => event.preventDefault()}
          onCloseAutoFocus={(event) => event.preventDefault()}
          // Escape is a deliberate close wherever focus sits. handleInputKeyDown
          // only covers the two inputs, so without this an Escape pressed while
          // an action button has focus dismisses via Base UI and restores
          // nothing. The follow-on onOpenChange -> onClose() is a harmless
          // second call.
          onEscapeKeyDown={() => onClose({ restoreFocus: true })}
        >
          <Popover.Arrow
            className="formula-edit-popover-anchor-line"
            data-formula-edit-arrow="true"
          />
          {pinnedSide === 'top' ? suggestionListbox : null}
          <div data-formula-edit-popover="true" className="flex max-w-full items-center gap-1 px-2 py-1.5">
            <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
              <input
                ref={nameInputRef}
                aria-label="Formula name"
                value={name}
                readOnly={!writable}
                onChange={(event) => handleNameChange(event.target.value)}
                onKeyDown={handleInputKeyDown}
                placeholder="Name"
                className={nameInputClassName}
                style={{ width: `${getDraftInputWidthCh(name, 'Name')}ch` }}
              />
              <input
                ref={expressionInputRef}
                aria-label={editingFormula.sourceMode === 'symbolic' ? 'Variable value' : 'Formula expression'}
                value={expression}
                readOnly={!writable}
                onChange={(event) =>
                  handleExpressionChange(event.target.value, event.target.selectionStart)
                }
                onKeyDown={handleInputKeyDown}
                placeholder={expressionPlaceholder}
                className={`${inputClassName} font-mono`}
                style={{ width: `${getDraftInputWidthCh(expression, expressionPlaceholder)}ch` }}
              />
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <button
                type="button"
                aria-label="Dismiss formula editor"
                onClick={() => onClose({ restoreFocus: true })}
                className={actionButtonClassName}
              >
                <X aria-hidden className="h-3 w-3" strokeWidth={1.5} />
              </button>
              <button
                type="button"
                aria-label={editingFormula.sourceMode === 'symbolic' ? 'Apply variable changes' : 'Apply formula changes'}
                disabled={!canAccept}
                onClick={closeIfValid}
                className={actionButtonClassName}
              >
                <CornerDownLeft aria-hidden className="h-3 w-3" strokeWidth={1.5} />
              </button>
            </div>
          </div>
          {pinnedSide === 'bottom' ? suggestionListbox : null}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

export function FormulaPlugin({ noteId }: { noteId: string }) {
  const [editor] = useLexicalComposerContext();
  const [previewState, setPreviewState] = useState<PreviewState>(initialPreviewState);
  const [editingFormula, setEditingFormula] = useState<EditingFormula | null>(null);
  const hoverTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hideTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const editHistoryPushedRef = useRef(false);
  const editOriginalDraftRef = useRef<FormulaDraftSnapshot | null>(null);
  const editRedoDraftRef = useRef<FormulaDraftSnapshot | null>(null);
  const editReferenceBindingsRef = useRef<PositionedFormulaReference[]>([]);
  const editExpressionRef = useRef('');
  // The stored formula as the open popover last read it: a bound note writes each edit against it, rebased onto the
  // payload as it is now, never the draft's whole value.
  const editStoredRef = useRef<string | null>(null);
  const editingFormulaNodeKey = editingFormula?.nodeKey ?? null;

  const readEditingFormula = useCallback(
    (nodeKey: string, anchorRect: AnchorRect, collisionBoundary: Element | null): EditingFormula | null => {
      let draft: EditingFormula | null = null;
      editor.getEditorState().read(() => {
        const node = $getNodeByKey(nodeKey);
        if (!$isFormulaNode(node)) {
          return;
        }
        const formula = node.getFormula();
        const result = node.getResult();
        const sourceMode = classifyFormulaSource(formula, { storedDisplay: result });
        const editableFormula = humanizeFormulaExpressionWithReferences(formula);
        draft = {
          nodeKey,
          noteId,
          formulaId: node.getFormulaId(),
          name: sourceMode === 'symbolic' ? formula : node.getName() ?? '',
          expression: sourceMode === 'symbolic' ? result : editableFormula.expression,
          result,
          anchorRect,
          collisionBoundary,
          sourceMode,
          references: sourceMode === 'symbolic' ? [] : editableFormula.references,
          session: ++formulaEditSessions,
          pending: !!registerDoc(editor) && !registerState(editor, nodeKey)?.ready
        };
      });
      return draft;
    },
    [editor, noteId]
  );

  const startEditSession = useCallback((nextDraft: EditingFormula) => {
    editHistoryPushedRef.current = false;
    editOriginalDraftRef.current = {
      draft: { name: nextDraft.name, expression: nextDraft.expression },
      references: nextDraft.references,
      formulaId: nextDraft.formulaId
    };
    editRedoDraftRef.current = null;
    editReferenceBindingsRef.current = nextDraft.references;
    editExpressionRef.current = nextDraft.expression;
    editStoredRef.current = null;
    setEditingFormula(nextDraft);
  }, []);

  useLayoutEffect(() => {
    if (!editingFormulaNodeKey) {
      return;
    }
    const formulaElement = editor.getElementByKey(editingFormulaNodeKey);
    if (!formulaElement) {
      return;
    }
    formulaElement.setAttribute('data-formula-editing', 'true');
    return () => formulaElement.removeAttribute('data-formula-editing');
  }, [editingFormulaNodeKey, editor]);

  const clearTimeouts = useCallback(() => {
    if (hoverTimeoutRef.current) {
      clearTimeout(hoverTimeoutRef.current);
      hoverTimeoutRef.current = null;
    }
    if (hideTimeoutRef.current) {
      clearTimeout(hideTimeoutRef.current);
      hideTimeoutRef.current = null;
    }
  }, []);

  const hidePreview = useCallback(() => {
    clearTimeouts();
    hideTimeoutRef.current = setTimeout(() => {
      setPreviewState(initialPreviewState);
    }, FORMULA_PREVIEW_HIDE_DELAY_MS);
  }, [clearTimeouts]);

  const showPreview = useCallback(
    (element: HTMLElement, nodeKey: string) => {
      clearTimeouts();

      let name: string | null = null;
      let formula = '';
      let result = '';
      let stale = false;
      let sourceMode: FormulaSourceMode = 'invalid';
      editor.getEditorState().read(() => {
        const node = $getNodeByKey(nodeKey);
        if ($isFormulaNode(node)) {
          name = node.getName();
          formula = node.getFormula();
          result = node.getResult();
          stale = node.isStale();
          sourceMode = classifyFormulaSource(formula, { storedDisplay: result });
        }
      });

      if (!formula) {
        return;
      }

      hoverTimeoutRef.current = setTimeout(() => {
        const rect = element.getBoundingClientRect();
        setPreviewState({
          isVisible: true,
          position: {
            x: rect.left,
            y: rect.bottom,
            anchorHeight: rect.height
          },
          name,
          formula,
          result,
          stale,
          sourceMode
        });
      }, 180);
    },
    [clearTimeouts, editor]
  );

  useEffect(() => {
    const rootElement = editor.getRootElement();
    if (!rootElement) {
      return;
    }

    const handleMouseOver = (event: MouseEvent) => {
      const target = event.target as HTMLElement;
      const formulaElement = target.closest('[data-formula-node-key]') as HTMLElement | null;
      if (!formulaElement) {
        return;
      }
      const nodeKey = formulaElement.getAttribute('data-formula-node-key');
      if (!nodeKey) {
        return;
      }
      showPreview(formulaElement, nodeKey);
    };

    const handleMouseOut = (event: MouseEvent) => {
      const target = event.target as HTMLElement;
      if (!target.closest('[data-formula-node-key]')) {
        return;
      }
      hidePreview();
    };

    const handleMouseDown = (event: MouseEvent) => {
      const target = event.target as HTMLElement;
      if (target.closest('[data-formula-node-key]')) {
        event.preventDefault();
        if (editor.isEditable()) {
          clearTimeouts();
          setPreviewState(initialPreviewState);
        }
      }
    };

    const handleClick = (event: MouseEvent) => {
      if (!editor.isEditable()) {
        return;
      }

      const target = event.target as HTMLElement;
      const formulaElement = target.closest('[data-formula-node-key]') as HTMLElement | null;
      if (!formulaElement) {
        return;
      }
      const nodeKey = formulaElement.getAttribute('data-formula-node-key');
      if (!nodeKey) {
        return;
      }

      const nextDraft = readEditingFormula(nodeKey, rectFromElement(formulaElement), formulaElement.closest('.canvas-scroll'));
      if (!nextDraft) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      clearTimeouts();
      setPreviewState(initialPreviewState);
      startEditSession(nextDraft);
    };

    rootElement.addEventListener('mouseover', handleMouseOver);
    rootElement.addEventListener('mouseout', handleMouseOut);
    rootElement.addEventListener('mousedown', handleMouseDown);
    rootElement.addEventListener('click', handleClick);

    return () => {
      rootElement.removeEventListener('mouseover', handleMouseOver);
      rootElement.removeEventListener('mouseout', handleMouseOut);
      rootElement.removeEventListener('mousedown', handleMouseDown);
      rootElement.removeEventListener('click', handleClick);
      clearTimeouts();
    };
  }, [clearTimeouts, editor, hidePreview, noteId, readEditingFormula, showPreview, startEditSession]);

  // A popover opened before its payload arrived reads its formula again when it does: the mode, references and draft
  // it showed came from the empty payload.
  const editingWritable = useRegisterWritable(editor, editingFormulaNodeKey ?? '');
  useEffect(() => {
    const target = editingFormula;
    if (!target?.pending || !editingWritable) return;
    const arrived = readEditingFormula(target.nodeKey, target.anchorRect, target.collisionBoundary);
    if (arrived) startEditSession(arrived);
  }, [editingFormula, editingWritable, readEditingFormula, startEditSession]);

  const readCurrentDraft = useCallback((): FormulaDraft | null => {
    const target = editingFormula;
    if (!target) {
      return null;
    }

    let draft: FormulaDraft | null = null;
    editor.read(() => {
      const node = $getNodeByKey(target.nodeKey);
      if (!$isFormulaNode(node)) {
        return;
      }
      const formula = node.getFormula();
      editStoredRef.current = formula;
      const result = node.getResult();
      const sourceMode = classifyFormulaSource(formula, { storedDisplay: result });
      draft = {
        name: sourceMode === 'symbolic' ? formula : node.getName() ?? '',
        expression: sourceMode === 'symbolic' ? result : toEditableExpression(formula)
      };
    });

    return draft;
  }, [editingFormula, editor]);

  const readCurrentFormulaId = useCallback((): string | null => {
    const target = editingFormula;
    if (!target) return null;
    let formulaId: string | null = null;
    editor.getEditorState().read(() => {
      const node = $getNodeByKey(target.nodeKey);
      if ($isFormulaNode(node)) formulaId = node.getFormulaId();
    });
    return formulaId;
  }, [editingFormula, editor]);

  // Typed/pasted bare names (never accepted through the typeahead) bind when
  // the workspace resolves them unambiguously — excluding the formula being
  // edited so it can't bind to itself.
  const createBareNameResolver = useCallback(
    (target: EditingFormula) =>
      (name: string): FormulaReferenceToken | null => {
        const suggestion = resolveFormulaBareName(editor, name);
        if (
          !suggestion ||
          (suggestion.noteId === target.noteId && suggestion.formulaId === target.formulaId)
        ) {
          return null;
        }
        return {
          name: suggestion.name,
          noteId: suggestion.noteId,
          formulaId: suggestion.formulaId
        };
      },
    [editor]
  );

  const applyDraftToNode = useCallback(
    (draft: FormulaDraft, change?: FormulaDraftChange): boolean => {
      const target = editingFormula;
      if (!target || !editor.isEditable()) {
        return false;
      }
      let references =
        change?.references ??
        remapPositionedReferences(
          editExpressionRef.current,
          draft.expression,
          editReferenceBindingsRef.current,
          change?.selectionStart
        );
      if (change?.acceptedReference) {
        const accepted = change.acceptedReference;
        references = [
          ...references.filter(
            (reference) =>
              reference.end <= accepted.start || reference.start >= accepted.end
          ),
          accepted
        ].sort((a, b) => a.start - b.start);
      }
      editExpressionRef.current = draft.expression;
      editReferenceBindingsRef.current = references;

      const nextName = draft.name.trim();
      const nextExpression =
        target.sourceMode === 'symbolic'
          ? draft.expression.trim()
          : rebindHumanizedExpression(
              draft.expression,
              references,
              createBareNameResolver(target)
            ).trim();
      if (!isFormulaDraftValidForMode({ name: draft.name, expression: nextExpression }, target.sourceMode, target.result)) {
        return false;
      }

      if (!editHistoryPushedRef.current) {
        editor.update(() => {
          $getRoot().markDirty();
        }, { tag: [HISTORY_PUSH_TAG, EDITOR_UPDATE_TAGS.ignored.skipDirty, SKIP_DOM_SELECTION_TAG] });
      }

      let changed = false;
      editor.update(() => {
        const targetNode = $getNodeByKey(target.nodeKey);
        if (!$isFormulaNode(targetNode)) {
          return;
        }

        let instanceId = targetNode.getFormulaId();
        if (change?.formulaId && targetNode.getFormulaId() !== change.formulaId) {
          targetNode.setFormulaId(change.formulaId);
          instanceId = change.formulaId;
          changed = true;
        }

        const instances = $nodesOfType(FormulaNode).filter(
          (candidate) => candidate.getFormulaId() === instanceId
        );
        // Linked instances take the same edit, each rebased onto its own payload.
        const before = editStoredRef.current ?? targetNode.getFormula();
        const writeFormula = (node: FormulaNode, next: string) => {
          if (!registerDoc(editor)) {
            node.setFormula(next);
            return;
          }
          const written = writeRegisterEdit(editor, node.getKey(), before, next);
          if (written !== null && node.getKey() === target.nodeKey) editStoredRef.current = written;
        };

        if (target.sourceMode === 'symbolic') {
          for (const node of instances) {
            if (node.getFormula() !== nextName) {
              writeFormula(node, nextName);
              changed = true;
            }
            if (node.getName() !== null) {
              node.setName(null);
              changed = true;
            }
            if (node.getResult() !== nextExpression) {
              node.setResult(nextExpression);
              changed = true;
            }
            if (node.isStale()) {
              node.setStale(false);
              changed = true;
            }
          }
          return;
        }

        const normalizedName = nextName.length > 0 ? nextName : null;
        for (const node of instances) {
          if (node.getFormula() !== nextExpression) {
            writeFormula(node, nextExpression);
            changed = true;
          }
          if (node.getName() !== normalizedName) {
            node.setName(normalizedName);
            changed = true;
          }
        }

        // Resolve references through the live workspace so an expression that
        // references other variables evaluates immediately instead of showing
        // a stale/zero result until the next full recompute.
        const evaluation = evaluateFormulaExpression(nextExpression, (reference) =>
          resolveFormulaReferenceValue(editor, reference)
        );
        if (evaluation.hasMissingReferences) {
          return;
        }
        if (evaluation.value !== null) {
          const result = formatFormulaValue(evaluation.value);
          for (const node of instances) {
            if (node.getResult() !== result) {
              node.setResult(result);
              changed = true;
            }
            if (node.isStale()) {
              node.setStale(false);
              changed = true;
            }
          }
        }
      }, {
        // skip-dom-selection: these updates fire on every popover keystroke —
        // without it, Lexical's reconciler restores the editor's DOM selection
        // and steals focus from the popover inputs.
        tag: [
          editHistoryPushedRef.current ? HISTORY_MERGE_TAG : HISTORY_PUSH_TAG,
          SKIP_DOM_SELECTION_TAG
        ]
      });

      if (changed) {
        editHistoryPushedRef.current = true;
      }
      return changed;
    },
    [createBareNameResolver, editingFormula, editor]
  );

  const handleDraftChange = useCallback(
    (draft: FormulaDraft, change?: FormulaDraftChange): boolean => {
      const changed = applyDraftToNode(draft, change);
      if (changed) {
        editRedoDraftRef.current = null;
      }
      return changed;
    },
    [applyDraftToNode]
  );

  const isEditingDraftValid = useCallback(
    (draft: FormulaDraft): boolean => {
      const target = editingFormula;
      if (!target) {
        return false;
      }
      const expression =
        target.sourceMode === 'symbolic'
          ? draft.expression
          : rebindHumanizedExpression(
              draft.expression,
              editReferenceBindingsRef.current,
              createBareNameResolver(target)
            ).trim();
      return isFormulaDraftValidForMode(
        { name: draft.name, expression },
        target.sourceMode,
        target.result
      );
    },
    [createBareNameResolver, editingFormula]
  );

  const handleHistoryShortcut = useCallback(
    (direction: 'undo' | 'redo'): FormulaDraft | null => {
      if (registerDoc(editor)) {
        editor.dispatchCommand(direction === 'redo' ? REDO_COMMAND : UNDO_COMMAND, undefined);
        return null;
      }
      const originalDraft = editOriginalDraftRef.current;
      const currentDraft = readCurrentDraft();
      const currentFormulaId = readCurrentFormulaId();

      if (
        direction === 'undo' &&
        originalDraft &&
        currentDraft &&
        currentFormulaId &&
        !formulaDraftsEqual(currentDraft, originalDraft.draft)
      ) {
        editRedoDraftRef.current = {
          draft: currentDraft,
          references: editReferenceBindingsRef.current,
          formulaId: currentFormulaId
        };
        applyDraftToNode(originalDraft.draft, {
          references: originalDraft.references,
          formulaId: originalDraft.formulaId
        });
        return originalDraft.draft;
      }

      if (direction === 'redo' && editRedoDraftRef.current) {
        const redoDraft = editRedoDraftRef.current;
        applyDraftToNode(redoDraft.draft, {
          references: redoDraft.references,
          formulaId: redoDraft.formulaId
        });
        editRedoDraftRef.current = null;
        return redoDraft.draft;
      }

      editor.dispatchCommand(direction === 'redo' ? REDO_COMMAND : UNDO_COMMAND, undefined);
      return null;
    },
    [applyDraftToNode, editor, readCurrentDraft, readCurrentFormulaId]
  );

  const getEditableText = useCallback((node: FormulaNode) => {
    const name = node.getName();
    const editableExpression = toEditableExpression(node.getFormula());
    if (classifyFormulaSource(node.getFormula(), { storedDisplay: node.getResult() }) === 'symbolic') {
      return `${editableExpression}=${node.getResult()}`;
    }
    if (name && name.length > 0) {
      return `${name}=${editableExpression}`;
    }
    return `=${editableExpression}`;
  }, []);

  // Handle backspace on FormulaNodes - convert back to editable text.
  useDecoratorBackspace({
    isTargetNode: $isFormulaNode,
    getEditableText,
    onConvert: (targetNode, textNode) => {
      const formulaId = targetNode.getFormulaId();
      registerEditedFormulaId(textNode.getKey(), formulaId);
      if (!$isBoundEditor()) textNode.setStyle(`--formula-edit-id: ${formulaId}`);
    }
  });

  const getEditSuggestions = useCallback(
    (query: string): FormulaSuggestion[] => {
      const target = editingFormula;
      if (!target) {
        return [];
      }
      return queryFormulaSuggestions(editor, query).filter(
        (suggestion) =>
          suggestion.noteId !== target.noteId || suggestion.formulaId !== target.formulaId
      );
    },
    [editingFormula, editor]
  );

  const endEditSession = useCallback(() => {
    editHistoryPushedRef.current = false;
    editOriginalDraftRef.current = null;
    editRedoDraftRef.current = null;
    editReferenceBindingsRef.current = [];
    editExpressionRef.current = '';
    editStoredRef.current = null;
    setEditingFormula(null);
  }, []);

  // A peer's move recreates the formula node: the popover follows it by payload id. A peer's removal closes it with a
  // notice rather than leaving it open on nothing.
  useFollowRegister(
    editor,
    editingFormulaNodeKey,
    (nodeKey) => {
      const element = editor.getElementByKey(nodeKey);
      setEditingFormula((current) =>
        current && current.nodeKey === editingFormulaNodeKey
          ? { ...current, nodeKey, anchorRect: element ? rectFromElement(element) : current.anchorRect }
          : current
      );
    },
    endEditSession
  );

  return (
    <>
      <FormulaPreview state={previewState} />
      {editingFormula ? (
        <FormulaEditPopover
          editingFormula={editingFormula}
          onClose={(options) => {
            const { nodeKey } = editingFormula;
            endEditSession();
            // Opening the popover suppresses the pill's click so the editor
            // never takes focus. Deliberate closes (submit, escape, dismiss)
            // hand it back, otherwise the note has no selection and undo
            // shortcuts go nowhere. Outside presses keep focus where the user
            // clicked.
            if (options?.restoreFocus) {
              let placed = false;
              editor.update(() => {
                const node = $getNodeByKey(nodeKey);
                if ($isFormulaNode(node)) {
                  node.selectNext(0, 0);
                  placed = true;
                }
              }, { tag: EDITOR_UPDATE_TAGS.ignored.skipDirty });
              // Only focus once a selection actually landed: editor.focus()
              // falls back to selectEnd() when the selection is null, which
              // would throw the caret to the end of the note if the formula
              // node went away while the popover was open.
              if (placed) {
                editor.focus();
              }
            }
          }}
          onDraftChange={handleDraftChange}
          onHistoryShortcut={handleHistoryShortcut}
          isDraftValid={isEditingDraftValid}
          readCurrentDraft={readCurrentDraft}
          getSuggestions={getEditSuggestions}
        />
      ) : null}
    </>
  );
}

export default FormulaPlugin;
