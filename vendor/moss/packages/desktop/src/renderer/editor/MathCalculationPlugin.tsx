// ported-from: packages/desktop/src/renderer/editor/MathCalculationPlugin.tsx @ 762abb777
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAtomValue } from 'jotai';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import {
  $getNodeByKey,
  $getRoot,
  $getSelection,
  $isElementNode,
  $isRangeSelection,
  $isTextNode,
  $setSelection,
  COMMAND_PRIORITY_CRITICAL,
  COMMAND_PRIORITY_HIGH,
  COMMAND_PRIORITY_LOW,
  SELECTION_CHANGE_COMMAND,
  KEY_ARROW_DOWN_COMMAND,
  KEY_ARROW_UP_COMMAND,
  KEY_DOWN_COMMAND,
  KEY_ENTER_COMMAND,
  KEY_ESCAPE_COMMAND,
  TextNode,
  type BaseSelection,
  type LexicalNode,
  type NodeKey
} from 'lexical';
import { $isLinkNode } from '@lexical/link';
import { $isCodeNode } from '@lexical/code';
import { $isListItemNode } from '@lexical/list';
import { Calculator } from 'lucide-react';

import { activeNotesAtom, noteEntityAtom } from '@moss/shared/state/note-atoms';

import {
  assessMarkdownSafety,
  RENDERER_MARKDOWN_SAFETY_LIMITS
} from '../../common/markdown-safety';
import { notesApi } from '../api/electron';
import {
  HoverCard,
  type HoverCardPosition,
  TypeaheadMenu,
  type TypeaheadItem,
  type TypeaheadPosition
} from './typeahead';
import {
  $createFormulaNode,
  $isFormulaNode,
  FormulaNode,
  createFormulaId
} from './nodes/FormulaNode';
import {
  clearAllEditedFormulaIds,
  clearEditedFormulaId,
  consumeEditedFormulaId,
  peekEditedFormulaId
} from './utils/formula-edit-session';
import { registerFormulaSuggestionProvider } from './utils/formula-suggestions';
import {
  classifyFormulaDraftSource,
  createFormulaCompoundKey,
  createFormulaReferenceToken,
  evaluateFormulaExpression,
  evaluateWorkspaceFormulas,
  extractFormulaReferences,
  extractWorkspaceFormulasFromMarkdown,
  findFormulaPatternAtCursor,
  findFormulaReferenceQueryAtCursor,
  formatFormulaValue,
  parseFormattedNumericResult,
  type CodeRange,
  type FormulaReferenceToken,
  type FormulaWorkspaceEvaluation,
  type FormulaWorkspaceFormulaInput,
  type FormulaWorkspaceFormulaRecord
} from './utils/formula-runtime';
import {
  extractFormulaEditId,
  resolveFormulaEditState,
  resolveFormulaRangeEnd
} from './utils/formula-draft-state';
import {
  EDITOR_UPDATE_TAGS,
  runDerivedEditorUpdate,
  runIgnoredEditorUpdate,
} from './utils/editorUpdateTags';

interface MathCalculationPluginProps {
  noteId: string;
  onDraftPillActiveChange?: (isActive: boolean) => void;
}

const FORMULA_REFERENCE_HOVER_HIDE_DELAY_MS = 80;

interface FormulaTypeaheadItem extends TypeaheadItem {
  data: {
    noteId: string;
    formulaId: string;
    name: string;
    result: string;
    noteTitle: string;
    expression: string;
  };
}

interface FormulaTypeaheadState {
  isOpen: boolean;
  query: string;
  queryStartIndex: number;
  position: TypeaheadPosition | null;
}

interface PreparedCommit {
  paragraphKey: NodeKey;
  segmentNodeKeys: NodeKey[];
  segmentText: string;
  replaceStart: number;
  replaceEnd: number;
  editedTextNodeKey: NodeKey | null;
  formula: FormulaWorkspaceFormulaRecord;
  evaluation: FormulaWorkspaceEvaluation;
}

interface AcceptedReferenceInsertion {
  start: number;
  end: number;
  label: string;
}

interface PendingSelectedReference extends FormulaReferenceToken {
  displayValue: string;
  expression: string;
  result: string;
  noteTitle: string;
}

interface FormulaTextSegment {
  node: TextNode;
  text: string;
  start: number;
  end: number;
  isCode: boolean;
  reference: PendingSelectedReference | null;
}

interface FormulaTextContext {
  paragraphKey: NodeKey;
  text: string;
  cursorOffset: number;
  segments: FormulaTextSegment[];
  codeRanges: CodeRange[];
  anchorNode: TextNode;
  allowInlineAnonymous: boolean;
}

interface FormulaReferenceHoverState {
  isVisible: boolean;
  position: HoverCardPosition;
  name: string;
  formula: string;
  result: string;
  stale: boolean;
}

interface FormulaDraftStyleSegment {
  nodeKey: NodeKey;
  start: number;
  end: number;
  referenceIds: { noteId: string; formulaId: string } | null;
}

interface FormulaDraftStylePlan {
  signature: string;
  formulaStart: number;
  formulaEnd: number;
  editId: string | null;
  segments: FormulaDraftStyleSegment[];
}

interface WorkspaceFormulaNote {
  id: string;
  title: string;
}

// Reference menu appears only during formula typing and is required to insert bound refs.
const ENABLE_FORMULA_REFERENCE_MENU = true;
const REFERENCE_TOKEN_REGEX =
  /@\(([a-zA-Z][a-zA-Z0-9_-]*)#([0-9a-fA-F-]{36})#([0-9a-fA-F-]{36})\)/g;
const BARE_IDENTIFIER_REGEX = /^[A-Za-z][A-Za-z0-9_-]*$/;
const EXPRESSION_SEPARATOR_REGEX = /[+\-*/(),\s%$]/;
const FORMULA_REF_NOTE_ID_STYLE_REGEX = /--formula-ref-note-id:\s*([^;]+)/;
const FORMULA_REF_FORMULA_ID_STYLE_REGEX = /--formula-ref-formula-id:\s*([^;]+)/;

function buildFormulaEditIdStyle(formulaId: string): string {
  return `--formula-edit-id: ${formulaId}`;
}
const FORMULA_CHIP_BASE_STYLE = [
  'display: inline-flex',
  'align-items: center',
  'line-height: 1.5',
  'font-weight: 400',
  'white-space: nowrap',
  'vertical-align: middle',
  'cursor: pointer',
  'background-color: var(--surface-note-selected-bright)',
  'color: var(--accent-brand-pressed)'
].join('; ');
const FORMULA_DRAFT_CHIP_STYLE_MARKER = '--formula-draft-chip: 1';
const workspaceFormulaCacheByNoteId = new Map<string, FormulaWorkspaceFormulaInput[]>();
const pendingWorkspaceFormulaReadsByNoteId = new Map<
  string,
  Promise<FormulaWorkspaceFormulaInput[]>
>();

const readWorkspaceFormulasForNote = (
  note: WorkspaceFormulaNote
): Promise<FormulaWorkspaceFormulaInput[]> => {
  const existing = pendingWorkspaceFormulaReadsByNoteId.get(note.id);
  if (existing) {
    return existing;
  }

  const pending = notesApi.getContent
    .invoke(note.id, { contentReadMode: 'raw' })
    .then((content) => {
      const markdown = content?.content ?? '';
      if (assessMarkdownSafety(markdown, RENDERER_MARKDOWN_SAFETY_LIMITS).failureReason) {
        return [];
      }

      return extractWorkspaceFormulasFromMarkdown(note.id, note.title, markdown);
    })
    .catch(() => [])
    .then((formulas) => {
      workspaceFormulaCacheByNoteId.set(note.id, formulas);
      return formulas;
    })
    .finally(() => {
      pendingWorkspaceFormulaReadsByNoteId.delete(note.id);
    });

  pendingWorkspaceFormulaReadsByNoteId.set(note.id, pending);
  return pending;
};

const getCachedWorkspaceFormulas = (
  notes: WorkspaceFormulaNote[]
): FormulaWorkspaceFormulaInput[] => {
  const formulas: FormulaWorkspaceFormulaInput[] = [];

  for (const note of notes) {
    const cached = workspaceFormulaCacheByNoteId.get(note.id);
    if (!cached) {
      continue;
    }

    for (const formula of cached) {
      formulas.push(
        formula.noteTitle === note.title
          ? formula
          : { ...formula, noteTitle: note.title }
      );
    }
  }

  return formulas;
};

const buildWorkspaceFormulaNotesSnapshot = (
  notes: WorkspaceFormulaNote[]
): WorkspaceFormulaNote[] =>
  notes
    .map((note) => ({ id: note.id, title: note.title }))
    .sort((a, b) => a.id.localeCompare(b.id));

const buildWorkspaceFormulaNotesSignature = (
  notes: WorkspaceFormulaNote[]
): string =>
  buildWorkspaceFormulaNotesSnapshot(notes)
    .map((note) => `${note.id}\u0000${note.title}`)
    .join('\n');

const getWorkspaceFormulaNotesToFetch = (
  activeNotes: WorkspaceFormulaNote[],
  changedNoteIds?: string[]
): WorkspaceFormulaNote[] => {
  if (changedNoteIds) {
    const changed = new Set(changedNoteIds);
    return activeNotes.filter((note) => changed.has(note.id));
  }

  return activeNotes.filter((note) => !workspaceFormulaCacheByNoteId.has(note.id));
};

const pruneWorkspaceFormulaCache = (activeNotes: WorkspaceFormulaNote[]): void => {
  const activeIds = new Set(activeNotes.map((note) => note.id));
  for (const noteId of workspaceFormulaCacheByNoteId.keys()) {
    if (!activeIds.has(noteId)) {
      workspaceFormulaCacheByNoteId.delete(noteId);
    }
  }
};

const scheduleWorkspaceFormulaRefresh = (callback: () => void): (() => void) => {
  if (
    typeof window !== 'undefined' &&
    typeof window.requestIdleCallback === 'function' &&
    typeof window.cancelIdleCallback === 'function'
  ) {
    const handle = window.requestIdleCallback(callback, { timeout: 1500 });
    return () => window.cancelIdleCallback(handle);
  }

  const handle = window.setTimeout(callback, 250);
  return () => window.clearTimeout(handle);
};

function buildReferenceMetadataStyle(noteId: string, formulaId: string): string {
  return `--formula-ref-note-id: ${noteId}; --formula-ref-formula-id: ${formulaId};`;
}

function buildFormulaDraftSegmentStyle(
  isStart: boolean,
  isEnd: boolean,
  referenceIds: { noteId: string; formulaId: string } | null,
  editId?: string | null
): string {
  const parts: string[] = [
    FORMULA_CHIP_BASE_STYLE,
    'padding-top: 0.125rem',
    'padding-bottom: 0.125rem',
    isStart ? 'padding-left: 0.5rem' : 'padding-left: 0',
    isEnd ? 'padding-right: 0.5rem' : 'padding-right: 0',
    isStart ? 'border-top-left-radius: 0.375rem' : 'border-top-left-radius: 0',
    isStart ? 'border-bottom-left-radius: 0.375rem' : 'border-bottom-left-radius: 0',
    isEnd ? 'border-top-right-radius: 0.375rem' : 'border-top-right-radius: 0',
    isEnd ? 'border-bottom-right-radius: 0.375rem' : 'border-bottom-right-radius: 0',
    FORMULA_DRAFT_CHIP_STYLE_MARKER
  ];

  if (referenceIds) {
    parts.push(buildReferenceMetadataStyle(referenceIds.noteId, referenceIds.formulaId));
  }

  if (editId) {
    parts.push(buildFormulaEditIdStyle(editId));
  }

  return parts.join('; ');
}

const INITIAL_TYPEAHEAD_STATE: FormulaTypeaheadState = {
  isOpen: false,
  query: '',
  queryStartIndex: 0,
  position: null
};

const INITIAL_REFERENCE_HOVER_STATE: FormulaReferenceHoverState = {
  isVisible: false,
  position: { x: 0, y: 0 },
  name: '',
  formula: '',
  result: '',
  stale: false
};

function clampTypeaheadIndex(index: number, length: number): number {
  if (length <= 0) {
    return 0;
  }
  if (index < 0) {
    return 0;
  }
  if (index >= length) {
    return length - 1;
  }
  return index;
}

function isFormulaTriggerContext(node: TextNode): boolean {
  if (node.hasFormat('code')) {
    return false;
  }

  let current: LexicalNode | null = node;
  while (current) {
    if ($isLinkNode(current) || $isCodeNode(current)) {
      return false;
    }
    current = current.getParent();
  }

  return findFormulaTextContainer(node) !== null;
}

function findFormulaTextContainer(node: LexicalNode | null): LexicalNode | null {
  let ancestor: LexicalNode | null = node;
  while (ancestor) {
    if ($isElementNode(ancestor)) {
      const children = ancestor.getChildren();
      if (
        children.length > 0 &&
        children.every((child) => $isTextNode(child) || $isFormulaNode(child))
      ) {
        return ancestor;
      }
    }
    ancestor = ancestor.getParent();
  }

  return null;
}

function isInsideListItem(node: LexicalNode | null): boolean {
  let current: LexicalNode | null = node;
  while (current) {
    if ($isListItemNode(current)) {
      return true;
    }
    current = current.getParent();
  }
  return false;
}

function collectCurrentNoteFormulaInputs(
  noteId: string,
  noteTitle: string
): FormulaWorkspaceFormulaInput[] {
  const formulas: FormulaWorkspaceFormulaInput[] = [];
  const root = $getRoot();

  const visit = (node: LexicalNode) => {
    if ($isFormulaNode(node)) {
      formulas.push({
        noteId,
        noteTitle,
        formulaId: node.getFormulaId(),
        name: node.getName(),
        expression: node.getFormula(),
        result: node.getResult(),
        stale: node.isStale()
      });
      return;
    }

    if ($isElementNode(node)) {
      for (const child of node.getChildren()) {
        visit(child);
      }
    }
  };

  for (const child of root.getChildren()) {
    visit(child);
  }

  return formulas;
}

function applyWorkspaceResultsToEditor(
  noteId: string,
  evaluation: FormulaWorkspaceEvaluation
): void {
  const root = $getRoot();

  const visit = (node: LexicalNode) => {
    if ($isFormulaNode(node)) {
      const key = createFormulaCompoundKey(noteId, node.getFormulaId());
      const record = evaluation.byKey.get(key);
      if (record) {
        if (node.getFormula() !== record.expression) {
          node.setFormula(record.expression);
        }
        if (node.getResult() !== record.result) {
          node.setResult(record.result);
        }
        if (node.getName() !== record.name) {
          node.setName(record.name);
        }
        if (node.isStale() !== record.stale) {
          node.setStale(record.stale);
        }
      }
      return;
    }

    if ($isElementNode(node)) {
      for (const child of node.getChildren()) {
        visit(child);
      }
    }
  };

  for (const child of root.getChildren()) {
    visit(child);
  }
}

function buildFormulaTypeaheadItems(
  workspace: FormulaWorkspaceEvaluation,
  noteId: string,
  query: string
): FormulaTypeaheadItem[] {
  const normalizedQuery = query.toLowerCase();
  const toDisplayExpression = (expression: string): string =>
    expression.replace(REFERENCE_TOKEN_REGEX, '$1');
  const getLookupName = (record: FormulaWorkspaceFormulaRecord): string =>
    record.lookupName ?? '';
  const getCategory = (record: FormulaWorkspaceFormulaRecord): string =>
    record.noteId === noteId ? 'Current note' : record.noteTitle;

  const matches = workspace.named
    .filter((record) => {
      const lookupName = getLookupName(record);
      if (!lookupName) {
        return false;
      }
      return lookupName.toLowerCase().includes(normalizedQuery);
    });

  const hasCrossNoteMatches = matches.some((record) => record.noteId !== noteId);

  return matches
    .sort((a, b) => {
      const aInCurrent = a.noteId === noteId ? 0 : 1;
      const bInCurrent = b.noteId === noteId ? 0 : 1;
      if (aInCurrent !== bInCurrent) {
        return aInCurrent - bInCurrent;
      }

      if (a.noteId !== noteId && b.noteId !== noteId && a.noteTitle !== b.noteTitle) {
        return a.noteTitle.localeCompare(b.noteTitle);
      }

      return getLookupName(a).localeCompare(getLookupName(b));
    })
    .map((record) => {
      const expressionPreview = toDisplayExpression(record.expression);
      const description = record.sourceMode === 'symbolic' ? record.result : expressionPreview;
      const lookupName = getLookupName(record);
      return {
        id: `${record.noteId}:${record.formulaId}`,
        label: lookupName,
        description,
        ...(hasCrossNoteMatches ? { category: getCategory(record) } : {}),
        data: {
          noteId: record.noteId,
          formulaId: record.formulaId,
          name: lookupName,
          result: record.result,
          noteTitle: record.noteTitle,
          expression: expressionPreview
        }
      };
    });
}

function resolveRecordForBareName(
  name: string,
  workspace: FormulaWorkspaceEvaluation,
  currentNoteId: string
): FormulaWorkspaceFormulaRecord | null {
  const sameNoteMatches = workspace.named.filter(
    (record) => record.noteId === currentNoteId && record.lookupName === name
  );
  if (sameNoteMatches.length === 1) {
    return sameNoteMatches[0];
  }
  if (sameNoteMatches.length > 1) {
    return null;
  }

  const matches = workspace.named.filter((record) => record.lookupName === name);
  if (matches.length === 1) {
    return matches[0];
  }

  return null;
}

function resolveBareIdentifiersInSegment(
  segment: string,
  workspace: FormulaWorkspaceEvaluation,
  currentNoteId: string,
  takePendingSelectionAt?: (
    segmentText: string,
    offset: number
  ) => { reference: FormulaReferenceToken; consumedLength: number } | null
): string {
  let cursor = 0;
  let resolved = '';

  while (cursor < segment.length) {
    const pendingMatch = takePendingSelectionAt?.(segment, cursor);
    if (pendingMatch) {
      resolved += createFormulaReferenceToken(pendingMatch.reference);
      cursor += pendingMatch.consumedLength;
      continue;
    }

    const char = segment[cursor];
    if (EXPRESSION_SEPARATOR_REGEX.test(char)) {
      resolved += char;
      cursor += 1;
      continue;
    }

    let end = cursor + 1;
    while (end < segment.length && !EXPRESSION_SEPARATOR_REGEX.test(segment[end])) {
      end += 1;
    }

    const chunk = segment.slice(cursor, end);
    if (BARE_IDENTIFIER_REGEX.test(chunk)) {
      const record = resolveRecordForBareName(chunk, workspace, currentNoteId);
      if (record?.lookupName) {
        resolved += createFormulaReferenceToken({
          name: record.lookupName,
          noteId: record.noteId,
          formulaId: record.formulaId
        });
      } else {
        resolved += chunk;
      }
    } else {
      resolved += chunk;
    }

    cursor = end;
  }

  return resolved;
}

function resolveBareIdentifierReferences(
  expression: string,
  workspace: FormulaWorkspaceEvaluation,
  currentNoteId: string,
  pendingSelections: PendingSelectedReference[]
): string {
  const pendingQueue = [...pendingSelections];

  const takePendingSelectionAt = (
    segmentText: string,
    offset: number
  ): { reference: FormulaReferenceToken; consumedLength: number } | null => {
    if (pendingQueue.length === 0) {
      return null;
    }

    const next = pendingQueue[0];
    if (!next) {
      return null;
    }

    if (segmentText.startsWith(next.displayValue, offset)) {
      pendingQueue.shift();
      return {
        reference: {
          name: next.name,
          noteId: next.noteId,
          formulaId: next.formulaId
        },
        consumedLength: next.displayValue.length
      };
    }

    if (segmentText.startsWith(next.name, offset)) {
      pendingQueue.shift();
      return {
        reference: {
          name: next.name,
          noteId: next.noteId,
          formulaId: next.formulaId
        },
        consumedLength: next.name.length
      };
    }

    return null;
  };

  let cursor = 0;
  let resolved = '';
  let match: RegExpExecArray | null;

  REFERENCE_TOKEN_REGEX.lastIndex = 0;
  while ((match = REFERENCE_TOKEN_REGEX.exec(expression)) !== null) {
    const before = expression.slice(cursor, match.index);
    resolved += resolveBareIdentifiersInSegment(
      before,
      workspace,
      currentNoteId,
      takePendingSelectionAt
    );
    resolved += match[0];
    cursor = match.index + match[0].length;
  }

  resolved += resolveBareIdentifiersInSegment(
    expression.slice(cursor),
    workspace,
    currentNoteId,
    takePendingSelectionAt
  );
  return resolved;
}

function resolveSingleNonNumericSymbolicReference(
  expression: string,
  workspace: FormulaWorkspaceEvaluation
): FormulaWorkspaceFormulaRecord | null {
  const trimmed = expression.trim();
  const references = extractFormulaReferences(trimmed);
  if (references.length !== 1) {
    return null;
  }

  const [reference] = references;
  if (trimmed !== createFormulaReferenceToken(reference)) {
    return null;
  }

  const record = workspace.byKey.get(
    createFormulaCompoundKey(reference.noteId, reference.formulaId)
  );
  if (!record || record.sourceMode !== 'symbolic' || record.value !== null) {
    return null;
  }

  return record;
}

function resolveSingleNonNumericSymbolicBareName(
  expression: string,
  workspace: FormulaWorkspaceEvaluation,
  currentNoteId: string
): FormulaWorkspaceFormulaRecord | null {
  const trimmed = expression.trim();
  if (!BARE_IDENTIFIER_REGEX.test(trimmed)) {
    return null;
  }

  const record = resolveRecordForBareName(trimmed, workspace, currentNoteId);
  if (!record || record.sourceMode !== 'symbolic' || record.value !== null) {
    return null;
  }

  return record;
}

function extractReferenceIdsFromStyle(
  style: string
): { noteId: string; formulaId: string } | null {
  const noteIdMatch = FORMULA_REF_NOTE_ID_STYLE_REGEX.exec(style);
  const formulaIdMatch = FORMULA_REF_FORMULA_ID_STYLE_REGEX.exec(style);
  const noteId = noteIdMatch?.[1]?.trim();
  const formulaId = formulaIdMatch?.[1]?.trim();
  if (!noteId || !formulaId) {
    return null;
  }
  return { noteId, formulaId };
}

function hasFormulaDraftStyle(style: string): boolean {
  return style.includes(FORMULA_DRAFT_CHIP_STYLE_MARKER);
}

export function MathCalculationPlugin({
  noteId,
  onDraftPillActiveChange
}: MathCalculationPluginProps) {
  const [editor] = useLexicalComposerContext();
  const activeNotes = useAtomValue(activeNotesAtom);
  const noteEntity = useAtomValue(noteEntityAtom(noteId));
  const workspaceFormulaNotes = useMemo(
    () => buildWorkspaceFormulaNotesSnapshot(activeNotes),
    [activeNotes]
  );
  const workspaceFormulaNotesSignature = useMemo(
    () => buildWorkspaceFormulaNotesSignature(workspaceFormulaNotes),
    [workspaceFormulaNotes]
  );
  const workspaceFormulaNotesRef = useRef(workspaceFormulaNotes);
  workspaceFormulaNotesRef.current = workspaceFormulaNotes;

  const currentNoteTitle =
    noteEntity?.title ?? activeNotes.find((note) => note.id === noteId)?.title ?? 'Untitled';

  const [typeaheadState, setTypeaheadState] =
    useState<FormulaTypeaheadState>(INITIAL_TYPEAHEAD_STATE);
  const [typeaheadResults, setTypeaheadResults] = useState<FormulaTypeaheadItem[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [referenceHoverState, setReferenceHoverState] =
    useState<FormulaReferenceHoverState>(INITIAL_REFERENCE_HOVER_STATE);

  const externalWorkspaceRef = useRef<FormulaWorkspaceFormulaInput[]>([]);
  const referenceBindingsRef = useRef<Map<NodeKey, PendingSelectedReference>>(new Map());
  const acceptedReferenceInsertionRef = useRef<AcceptedReferenceInsertion | null>(null);
  const refreshRequestIdRef = useRef(0);
  const hoverTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hideHoverTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hoveredReferenceElementRef = useRef<HTMLElement | null>(null);
  const draftStyleSignatureRef = useRef<string>('none');
  const draftPillActiveRef = useRef(false);
  // Gate for SELECTION_CHANGE_COMMAND — skip buildFormulaTextContext when selection unchanged
  const lastMathSelectionRef = useRef<BaseSelection | null>(null);
  const typeaheadIsOpenRef = useRef(false);
  const typeaheadQueryRef = useRef('');
  const typeaheadResultsRef = useRef<FormulaTypeaheadItem[]>([]);
  const selectedIndexRef = useRef(0);
  const savedSelectionRef = useRef<BaseSelection | null>(null);
  const lastTypeaheadCursorRef = useRef<number | null>(null);
  const suppressNextEnterCommitRef = useRef(false);
  typeaheadIsOpenRef.current = typeaheadState.isOpen;
  typeaheadQueryRef.current = typeaheadState.query;
  typeaheadResultsRef.current = typeaheadResults;
  selectedIndexRef.current = selectedIndex;

  const typeaheadWidth = useMemo(() => {
    if (typeaheadResults.length === 0) {
      return 260;
    }

    if (typeof window === 'undefined' || typeof document === 'undefined') {
      return 320;
    }

    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    if (!context) {
      return 320;
    }

    // Match second-line expression styling closely.
    context.font = '12px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace';
    let maxExpressionWidth = 0;
    for (const item of typeaheadResults) {
      const width = context.measureText(item.data.expression).width;
      if (width > maxExpressionWidth) {
        maxExpressionWidth = width;
      }
    }

    const paddedWidth = Math.ceil(maxExpressionWidth) + 64;
    const maxViewportWidth = Math.max(240, window.innerWidth - 32);
    return Math.max(240, Math.min(paddedWidth, Math.min(560, maxViewportWidth)));
  }, [typeaheadResults]);

  const closeTypeahead = useCallback(() => {
    typeaheadIsOpenRef.current = false;
    typeaheadQueryRef.current = '';
    typeaheadResultsRef.current = [];
    selectedIndexRef.current = 0;
    setTypeaheadState(INITIAL_TYPEAHEAD_STATE);
    setTypeaheadResults([]);
    setSelectedIndex(0);
  }, []);

  const getSelectedTypeaheadItem = useCallback((): FormulaTypeaheadItem | null => {
    const results = typeaheadResultsRef.current;
    if (results.length === 0) {
      return null;
    }
    const index = clampTypeaheadIndex(selectedIndexRef.current, results.length);
    return results[index] ?? null;
  }, []);

  const clearHoverTimeouts = useCallback(() => {
    if (hoverTimeoutRef.current) {
      clearTimeout(hoverTimeoutRef.current);
      hoverTimeoutRef.current = null;
    }
    if (hideHoverTimeoutRef.current) {
      clearTimeout(hideHoverTimeoutRef.current);
      hideHoverTimeoutRef.current = null;
    }
  }, []);

  const hideReferenceHover = useCallback(() => {
    clearHoverTimeouts();
    if (hoveredReferenceElementRef.current) {
      hoveredReferenceElementRef.current.style.boxShadow = '';
      hoveredReferenceElementRef.current.style.backgroundColor = '';
      hoveredReferenceElementRef.current = null;
    }
    hideHoverTimeoutRef.current = setTimeout(() => {
      setReferenceHoverState(INITIAL_REFERENCE_HOVER_STATE);
    }, FORMULA_REFERENCE_HOVER_HIDE_DELAY_MS);
  }, [clearHoverTimeouts]);

  const buildFormulaTextContext = useCallback((): FormulaTextContext | null => {
    const selection = $getSelection();
    if (!$isRangeSelection(selection) || !selection.isCollapsed()) {
      return null;
    }

    const anchor = selection.anchor;
    const anchorNode = anchor.getNode();
    if (!$isTextNode(anchorNode) || !isFormulaTriggerContext(anchorNode)) {
      return null;
    }

    const paragraph = findFormulaTextContainer(anchorNode);
    if (!paragraph || !$isElementNode(paragraph)) {
      return null;
    }

    const paragraphChildren = paragraph.getChildren();
    const anchorIndex = paragraphChildren.findIndex((child) => child.getKey() === anchorNode.getKey());
    if (anchorIndex < 0) {
      return null;
    }

    let segmentStartIndex = anchorIndex;
    while (segmentStartIndex > 0 && $isTextNode(paragraphChildren[segmentStartIndex - 1])) {
      segmentStartIndex -= 1;
    }

    let segmentEndIndex = anchorIndex;
    while (
      segmentEndIndex < paragraphChildren.length - 1 &&
      $isTextNode(paragraphChildren[segmentEndIndex + 1])
    ) {
      segmentEndIndex += 1;
    }

    const segments: FormulaTextSegment[] = [];
    const codeRanges: CodeRange[] = [];
    let text = '';
    let cursorOffset: number | null = null;

    for (const child of paragraphChildren.slice(segmentStartIndex, segmentEndIndex + 1)) {
      if (!$isTextNode(child)) {
        return null;
      }

      const childText = child.getTextContent();
      const start = text.length;
      const end = start + childText.length;
      const isCode = child.hasFormat('code');
      const nodeKey = child.getKey();
      const existingReference = referenceBindingsRef.current.get(nodeKey) ?? null;
      const styledReferenceIds = extractReferenceIdsFromStyle(child.getStyle());

      if (isCode) {
        codeRanges.push({ start, end });
      }

      let reference: PendingSelectedReference | null = existingReference;
      if (styledReferenceIds) {
        reference = {
          name: existingReference?.name ?? childText,
          noteId: styledReferenceIds.noteId,
          formulaId: styledReferenceIds.formulaId,
          displayValue: childText,
          expression: existingReference?.expression ?? '',
          result: existingReference?.result ?? '',
          noteTitle: existingReference?.noteTitle ?? ''
        };
        referenceBindingsRef.current.set(nodeKey, reference);
      } else if (existingReference && childText !== existingReference.displayValue) {
        referenceBindingsRef.current.delete(nodeKey);
        reference = null;
      }

      segments.push({
        node: child,
        text: childText,
        start,
        end,
        isCode,
        reference
      });
      text += childText;

      if (child.getKey() === anchorNode.getKey()) {
        cursorOffset = start + anchor.offset;
      }
    }

    if (cursorOffset === null) {
      return null;
    }

    return {
      paragraphKey: paragraph.getKey(),
      text,
      cursorOffset,
      segments,
      codeRanges,
      anchorNode,
      allowInlineAnonymous: isInsideListItem(anchorNode)
    };
  }, []);

  const collectPendingSelectionsForRange = useCallback(
    (
      context: FormulaTextContext,
      start: number,
      end: number
    ): PendingSelectedReference[] => {
      const pending: PendingSelectedReference[] = [];
      for (const segment of context.segments) {
        if (!segment.reference) {
          continue;
        }
        if (segment.start >= start && segment.end <= end) {
          pending.push(segment.reference);
        }
      }
      return pending;
    },
    []
  );

  const resolveContextEditState = useCallback((context: FormulaTextContext) => {
    return resolveFormulaEditState(
      context.segments.map((segment) => ({
        start: segment.start,
        end: segment.end,
        style: segment.node.getStyle()
      })),
      context.cursorOffset
    );
  }, []);

  const resolveInsertionSegment = useCallback(
    (
      context: FormulaTextContext,
      start: number,
      end: number
    ): { node: TextNode; text: string; segmentStart: number } | null => {
      const inSingleSegment = context.segments.find(
        (segment) => start >= segment.start && end <= segment.end
      );
      if (inSingleSegment) {
        return {
          node: inSingleSegment.node,
          text: inSingleSegment.text,
          segmentStart: inSingleSegment.start
        };
      }

      const startIndex = context.segments.findIndex(
        (segment) => start >= segment.start && start < segment.end
      );
      const endIndex = context.segments.findIndex(
        (segment) => end > segment.start && end <= segment.end
      );

      if (
        startIndex < 0 ||
        endIndex < 0 ||
        endIndex < startIndex
      ) {
        return null;
      }

      const firstSegment = context.segments[startIndex];
      const mergedText = context.segments
        .slice(startIndex, endIndex + 1)
        .map((segment) => segment.text)
        .join('');

      referenceBindingsRef.current.delete(firstSegment.node.getKey());
      firstSegment.node.setTextContent(mergedText);

      for (let index = startIndex + 1; index <= endIndex; index += 1) {
        const segment = context.segments[index];
        if (!segment) {
          continue;
        }
        referenceBindingsRef.current.delete(segment.node.getKey());
        segment.node.remove();
      }

      return {
        node: firstSegment.node,
        text: mergedText,
        segmentStart: firstSegment.start
      };
    },
    []
  );

  const buildDraftStylePlan = useCallback(
    (context: FormulaTextContext): FormulaDraftStylePlan | null => {
      const editState = resolveContextEditState(context);

      if (editState.isEditMode) {
        // Verify the marked range still contains '=' (user hasn't deleted past it)
        const markedText = context.text.slice(editState.rangeStart, editState.rangeEnd);
        if (!markedText.includes('=')) {
          return null;
        }
      }

      const formulaEnd = resolveFormulaRangeEnd({
        text: context.text,
        cursorOffset: context.cursorOffset,
        editState,
        allowEmptyExpression: true,
        allowInlineAnonymous: context.allowInlineAnonymous,
        codeRanges: context.codeRanges
      });

      const pattern = findFormulaPatternAtCursor(context.text, formulaEnd, {
        allowEmptyExpression: true,
        allowInlineAnonymous: context.allowInlineAnonymous,
        codeRanges: context.codeRanges
      });
      if (!pattern) {
        return null;
      }

      const segmentSignature = context.segments
        .map((segment) => {
          const referenceTag = segment.reference
            ? `ref:${segment.reference.noteId}:${segment.reference.formulaId}`
            : 'txt';
          return `${segment.node.getKey()}:${segment.start}:${segment.end}:${referenceTag}`;
        })
        .join('|');

      // In edit mode, exclude cursorOffset from signature to prevent re-styling on arrow keys
      const signatureEnd = editState.isEditMode ? formulaEnd : context.cursorOffset;

      return {
        signature: `${context.paragraphKey}:${pattern.startIndex}:${signatureEnd}:${segmentSignature}`,
        formulaStart: pattern.startIndex,
        formulaEnd,
        editId: editState.editId,
        segments: context.segments.map((segment) => ({
          nodeKey: segment.node.getKey(),
          start: segment.start,
          end: segment.end,
          referenceIds: segment.reference
            ? { noteId: segment.reference.noteId, formulaId: segment.reference.formulaId }
            : null
        }))
      };
    },
    [resolveContextEditState]
  );

  const clearAllDraftStyles = useCallback(() => {
    const root = $getRoot();

    const visit = (node: LexicalNode) => {
      if ($isTextNode(node)) {
        const style = node.getStyle();
        if (hasFormulaDraftStyle(style)) {
          const editId = extractFormulaEditId(style);
          node.setStyle(editId ? buildFormulaEditIdStyle(editId) : '');
        }
        return;
      }

      if ($isElementNode(node)) {
        for (const child of node.getChildren()) {
          visit(child);
        }
      }
    };

    for (const child of root.getChildren()) {
      visit(child);
    }
  }, []);

  const applyDraftStylePlan = useCallback((plan: FormulaDraftStylePlan) => {
    for (let index = plan.segments.length - 1; index >= 0; index -= 1) {
      const segment = plan.segments[index];

      const overlapStart = Math.max(segment.start, plan.formulaStart);
      const overlapEnd = Math.min(segment.end, plan.formulaEnd);
      if (overlapStart >= overlapEnd) {
        continue;
      }

      const node = $getNodeByKey(segment.nodeKey);
      if (!$isTextNode(node)) {
        continue;
      }

      const currentLength = node.getTextContent().length;
      const localStart = Math.max(0, overlapStart - segment.start);
      const localEnd = Math.min(currentLength, overlapEnd - segment.start);
      if (localEnd <= localStart) {
        continue;
      }

      let targetNode: TextNode = node;

      if (localEnd < currentLength) {
        targetNode.splitText(localEnd);
      }

      if (localStart > 0) {
        const [, middleNode] = targetNode.splitText(localStart);
        if ($isTextNode(middleNode)) {
          targetNode = middleNode;
        }
      }

      const existingEditId = extractFormulaEditId(node.getStyle());
      const segmentEditId = plan.editId ?? existingEditId;
      targetNode.setStyle(
        buildFormulaDraftSegmentStyle(
          overlapStart === plan.formulaStart,
          overlapEnd === plan.formulaEnd,
          segment.referenceIds,
          segmentEditId
        )
      );
    }
  }, []);

  const buildWorkspaceEvaluation = useCallback(
    (
      currentNoteFormulas: FormulaWorkspaceFormulaInput[],
      candidate?: FormulaWorkspaceFormulaInput
    ): FormulaWorkspaceEvaluation => {
      const externalFormulas = externalWorkspaceRef.current.filter(
        (entry) => entry.noteId !== noteId
      );
      const combined = [...externalFormulas, ...currentNoteFormulas];

      if (!candidate) {
        return evaluateWorkspaceFormulas(combined);
      }

      const candidateKey = createFormulaCompoundKey(
        candidate.noteId,
        candidate.formulaId
      );

      const withoutCandidate = combined.filter(
        (entry) =>
          createFormulaCompoundKey(entry.noteId, entry.formulaId) !== candidateKey
      );

      withoutCandidate.push(candidate);
      return evaluateWorkspaceFormulas(withoutCandidate);
    },
    [noteId]
  );

  const recomputeEditorFormulas = useCallback(() => {
    let evaluation: FormulaWorkspaceEvaluation | null = null;

    editor.getEditorState().read(() => {
      const currentFormulas = collectCurrentNoteFormulaInputs(noteId, currentNoteTitle);
      evaluation = buildWorkspaceEvaluation(currentFormulas);
    });

    if (!evaluation) {
      return;
    }

    runDerivedEditorUpdate(editor, () => {
      applyWorkspaceResultsToEditor(noteId, evaluation as FormulaWorkspaceEvaluation);
    }, EDITOR_UPDATE_TAGS.derived.formulaWorkspaceRefresh);
  }, [buildWorkspaceEvaluation, currentNoteTitle, editor, noteId]);

  useEffect(() => {
    return editor.registerMutationListener(FormulaNode, (_mutations, { updateTags }) => {
      if (updateTags.has(EDITOR_UPDATE_TAGS.derived.formulaWorkspaceRefresh)) {
        return;
      }
      recomputeEditorFormulas();
    });
  }, [editor, recomputeEditorFormulas]);

  // Reference typeahead + value resolution for the formula edit popover
  // (FormulaPlugin): same workspace evaluation and ranking as the inline
  // typeahead.
  useEffect(() => {
    // Memoized per microtask: a single popover keystroke resolves every
    // reference in the draft (plus suggestions), and each resolution would
    // otherwise walk the note tree and re-evaluate the whole workspace. All
    // provider calls within one synchronous burst share one evaluation.
    let memoizedWorkspace: FormulaWorkspaceEvaluation | null = null;
    const readWorkspace = (): FormulaWorkspaceEvaluation => {
      if (memoizedWorkspace) {
        return memoizedWorkspace;
      }
      const evaluation = editor.getEditorState().read(() => {
        const currentFormulas = collectCurrentNoteFormulaInputs(noteId, currentNoteTitle);
        return buildWorkspaceEvaluation(currentFormulas);
      });
      memoizedWorkspace = evaluation;
      queueMicrotask(() => {
        memoizedWorkspace = null;
      });
      return evaluation;
    };
    return registerFormulaSuggestionProvider(editor, {
      suggest: (query) =>
        buildFormulaTypeaheadItems(readWorkspace(), noteId, query).map((item) => item.data),
      resolve: (reference) => {
        const record = readWorkspace().byKey.get(
          createFormulaCompoundKey(reference.noteId, reference.formulaId)
        );
        if (!record) {
          return null;
        }
        if (record.value !== null) {
          return record.value;
        }
        return parseFormattedNumericResult(record.result);
      },
      resolveBareName: (name) => {
        const record = resolveRecordForBareName(name, readWorkspace(), noteId);
        if (!record?.lookupName) {
          return null;
        }
        return {
          noteId: record.noteId,
          formulaId: record.formulaId,
          name: record.lookupName,
          result: record.result,
          noteTitle: record.noteTitle,
          expression: record.expression.replace(REFERENCE_TOKEN_REGEX, '$1')
        };
      }
    });
  }, [buildWorkspaceEvaluation, currentNoteTitle, editor, noteId]);

  const refreshWorkspaceFromDisk = useCallback(async (
    notesSnapshot: WorkspaceFormulaNote[],
    changedNoteIds?: string[]
  ) => {
    const requestId = ++refreshRequestIdRef.current;
    pruneWorkspaceFormulaCache(notesSnapshot);

    const notesToFetch = getWorkspaceFormulaNotesToFetch(notesSnapshot, changedNoteIds);
    if (notesToFetch.length > 0) {
      await Promise.all(notesToFetch.map(readWorkspaceFormulasForNote));
    }

    if (requestId !== refreshRequestIdRef.current) {
      return;
    }

    externalWorkspaceRef.current = getCachedWorkspaceFormulas(notesSnapshot);
    recomputeEditorFormulas();
  }, [recomputeEditorFormulas]);

  const prepareCommitFromSelection = useCallback((): PreparedCommit | 'cycle' | null => {
    const context = buildFormulaTextContext();
    if (!context) {
      return null;
    }

    const editState = resolveContextEditState(context);

    const commitEnd = resolveFormulaRangeEnd({
      text: context.text,
      cursorOffset: context.cursorOffset,
      editState,
      allowEmptyExpression: false,
      allowInlineAnonymous: context.allowInlineAnonymous,
      codeRanges: context.codeRanges
    });

    const pattern = findFormulaPatternAtCursor(context.text, commitEnd, {
      allowInlineAnonymous: context.allowInlineAnonymous,
      codeRanges: context.codeRanges
    });
    if (!pattern) {
      return null;
    }

    const rawExpression = pattern.expression.trim();
    if (!rawExpression) {
      return null;
    }

    const currentFormulas = collectCurrentNoteFormulaInputs(noteId, currentNoteTitle);
    const workspaceBefore = buildWorkspaceEvaluation(currentFormulas);
    const pendingSelections = collectPendingSelectionsForRange(
      context,
      pattern.equalsIndex + 1,
      commitEnd
    );
    const expression = resolveBareIdentifierReferences(
      rawExpression,
      workspaceBefore,
      noteId,
      pendingSelections
    );
    const symbolicReference =
      pattern.name !== null
        ? resolveSingleNonNumericSymbolicReference(expression, workspaceBefore) ??
          resolveSingleNonNumericSymbolicBareName(rawExpression, workspaceBefore, noteId)
        : null;

    // Try NodeKey-based lookup first, fall back to CSS-based edit ID
    const editedFormulaId = peekEditedFormulaId(context.anchorNode.getKey()) ?? editState.editId;
    const existingFormula = editedFormulaId
      ? workspaceBefore.byKey.get(createFormulaCompoundKey(noteId, editedFormulaId))
      : undefined;
    const formulaId = editedFormulaId ?? createFormulaId();

    const previewEvaluation = evaluateFormulaExpression(expression, (reference) => {
      const key = createFormulaCompoundKey(reference.noteId, reference.formulaId);
      const source = workspaceBefore.byKey.get(key);
      if (!source) {
        return null;
      }
      if (source.value !== null) {
        return source.value;
      }
      return parseFormattedNumericResult(source.result) ?? Number.NaN;
    });
    const draftSourceMode = classifyFormulaDraftSource({
      name: pattern.name,
      expression: rawExpression,
      evaluation: previewEvaluation
    });
    const isSymbolicDraft =
      pattern.name !== null &&
      (symbolicReference !== null || draftSourceMode === 'symbolic');
    const symbolicSource = isSymbolicDraft ? pattern.name : null;
    const symbolicResult = symbolicReference?.result ?? rawExpression;

    const candidate: FormulaWorkspaceFormulaInput = {
      noteId,
      noteTitle: currentNoteTitle,
      formulaId,
      name: symbolicSource ? null : pattern.name,
      expression: symbolicSource ?? expression,
      result: symbolicSource ? symbolicResult : existingFormula?.result ?? '',
      stale: symbolicSource ? false : existingFormula?.stale ?? false
    };

    const workspaceAfter = buildWorkspaceEvaluation(currentFormulas, candidate);
    const candidateKey = createFormulaCompoundKey(noteId, formulaId);

    if (workspaceAfter.cycles.has(candidateKey)) {
      return 'cycle';
    }

    const evaluatedCandidate = workspaceAfter.byKey.get(candidateKey);
    if (!evaluatedCandidate) {
      return null;
    }

    // If reference resolution is temporarily unavailable but the expression
    // clearly contains bound reference tokens, still allow commit as stale.
    if (!evaluatedCandidate.result.trim()) {
      if (!expression.includes('@(') || !evaluatedCandidate.stale) {
        return null;
      }
      evaluatedCandidate.result = formatFormulaValue(0);
      evaluatedCandidate.stale = true;
    }

    return {
      paragraphKey: context.paragraphKey,
      segmentNodeKeys: context.segments.map((segment) => segment.node.getKey()),
      segmentText: context.text,
      replaceStart: pattern.startIndex,
      replaceEnd: commitEnd,
      editedTextNodeKey: editedFormulaId ? context.anchorNode.getKey() : null,
      formula: evaluatedCandidate,
      evaluation: workspaceAfter
    };
  }, [
    buildWorkspaceEvaluation,
    buildFormulaTextContext,
    collectPendingSelectionsForRange,
    currentNoteTitle,
    noteId,
    resolveContextEditState
  ]);

  const applyPreparedCommit = useCallback(
    (prepared: PreparedCommit, opts?: { trailingSpace?: boolean }) => {
      const paragraph = $getNodeByKey(prepared.paragraphKey);
      if (!paragraph || !$isElementNode(paragraph)) {
        return;
      }

      const formulaNode = $createFormulaNode(
        prepared.formula.expression,
        prepared.formula.result,
        {
          formulaId: prepared.formula.formulaId,
          name: prepared.formula.name,
          stale: prepared.formula.stale
        }
      );

      const segmentNodes = prepared.segmentNodeKeys
        .map((nodeKey) => $getNodeByKey(nodeKey))
        .filter($isTextNode);
      const firstSegment = segmentNodes[0];
      if (!firstSegment) {
        return;
      }

      const beforeText = prepared.segmentText.slice(0, prepared.replaceStart);
      const afterText = prepared.segmentText.slice(prepared.replaceEnd);

      if (beforeText.length > 0) {
        firstSegment.insertBefore(new TextNode(beforeText));
      }

      firstSegment.insertBefore(formulaNode);

      if (prepared.editedTextNodeKey) {
        consumeEditedFormulaId(prepared.editedTextNodeKey);
      }

      for (const segmentNode of segmentNodes) {
        segmentNode.remove();
      }

      applyWorkspaceResultsToEditor(noteId, prepared.evaluation);

      if (opts?.trailingSpace === false) {
        // Enter-commit: no trailing space; cursor right after the pill
        if (afterText.length > 0) {
          const afterNode = new TextNode(afterText);
          formulaNode.insertAfter(afterNode);
          afterNode.select(0, 0);
        } else {
          formulaNode.selectNext(0, 0);
        }
      } else {
        // Space-commit: trailing space mirrors the typed keystroke
        const spaceNode = new TextNode(' ');
        formulaNode.insertAfter(spaceNode);
        if (afterText.length > 0) {
          spaceNode.insertAfter(new TextNode(afterText));
        }
        spaceNode.select();
      }
      referenceBindingsRef.current.clear();
    },
    [noteId]
  );

  const insertTypeaheadReference = useCallback(
    (item: FormulaTypeaheadItem): boolean => {
      let selection = $getSelection();
      if (!selection && savedSelectionRef.current) {
        $setSelection(savedSelectionRef.current.clone());
        selection = $getSelection();
      }
      if (!$isRangeSelection(selection) || !selection.isCollapsed()) {
        return false;
      }

      const context = buildFormulaTextContext();
      if (!context) {
        return false;
      }

      const liveQueryMatch = findFormulaReferenceQueryAtCursor(
        context.text,
        context.cursorOffset,
        { allowInlineAnonymous: context.allowInlineAnonymous, codeRanges: context.codeRanges }
      );
      let start = liveQueryMatch?.queryStartIndex ?? typeaheadState.queryStartIndex;
      const end = context.cursorOffset;
      // Dash-suffix retry: the menu can be open on just the segment after the
      // last dash (subtraction, e.g. "revenue-co" suggesting on "co") while the
      // live query walks back over the whole dashed token. Accepting must only
      // replace the suffix — never the left operand.
      const menuQuery = typeaheadState.query;
      if (
        liveQueryMatch &&
        menuQuery.length > 0 &&
        liveQueryMatch.query !== menuQuery &&
        liveQueryMatch.query.endsWith(menuQuery) &&
        liveQueryMatch.query[liveQueryMatch.query.length - menuQuery.length - 1] === '-'
      ) {
        start = end - menuQuery.length;
      }
      if (start < 0 || start > end) {
        return false;
      }

      const segment = resolveInsertionSegment(context, start, end);
      if (!segment) {
        return false;
      }

      const localStart = start - segment.segmentStart;
      const localEnd = end - segment.segmentStart;
      if (localStart < 0 || localEnd < localStart || localEnd > segment.text.length) {
        return false;
      }
      const prefixText = segment.text.slice(0, localStart);
      const suffixText = segment.text.slice(localEnd);
      referenceBindingsRef.current.delete(segment.node.getKey());
      segment.node.setTextContent(prefixText);

      const referenceLabel = item.data.name.trim();
      if (!referenceLabel) {
        return false;
      }
      const reference: PendingSelectedReference = {
        name: item.data.name,
        noteId: item.data.noteId,
        formulaId: item.data.formulaId,
        displayValue: referenceLabel,
        expression: item.data.expression,
        result: item.data.result,
        noteTitle: item.data.noteTitle
      };

      const referenceNode = new TextNode(referenceLabel);
      referenceNode.setStyle(
        buildReferenceMetadataStyle(reference.noteId, reference.formulaId)
      );
      segment.node.insertAfter(referenceNode);
      referenceBindingsRef.current.set(referenceNode.getKey(), reference);

      let cursorNode: TextNode;
      if (suffixText.length > 0) {
        const trailingNode = new TextNode(suffixText);
        referenceNode.insertAfter(trailingNode);
        cursorNode = trailingNode;
      } else {
        const nextSibling = referenceNode.getNextSibling();
        if ($isTextNode(nextSibling)) {
          const nextText = nextSibling.getTextContent();
          if (/^\s+/.test(nextText)) {
            nextSibling.setTextContent(nextText.replace(/^\s+/, ''));
          }
          cursorNode = nextSibling;
        } else {
          const trailingNode = new TextNode('');
          referenceNode.insertAfter(trailingNode);
          cursorNode = trailingNode;
        }
      }
      cursorNode.select(0, 0);

      const acceptedEnd = start + referenceLabel.length;
      acceptedReferenceInsertionRef.current = {
        start,
        end: acceptedEnd,
        label: referenceLabel
      };
      lastTypeaheadCursorRef.current = acceptedEnd;
      return true;
    },
    [
      buildFormulaTextContext,
      resolveInsertionSegment,
      typeaheadState.query,
      typeaheadState.queryStartIndex
    ]
  );

  const acceptTypeaheadSelection = useCallback(
    (item?: FormulaTypeaheadItem): boolean => {
      const selectedItem = item ?? getSelectedTypeaheadItem();
      if (!selectedItem) {
        return false;
      }

      let inserted = false;
      editor.update(() => {
        inserted = insertTypeaheadReference(selectedItem);
      });
      if (!inserted) {
        return false;
      }

      runIgnoredEditorUpdate(
        editor,
        () => {
          const context = buildFormulaTextContext();
          const plan = context ? buildDraftStylePlan(context) : null;
          const isDraftPillActive = plan !== null;

          if (draftPillActiveRef.current !== isDraftPillActive) {
            draftPillActiveRef.current = isDraftPillActive;
            onDraftPillActiveChange?.(isDraftPillActive);
          }

          draftStyleSignatureRef.current = plan?.signature ?? 'none';
          clearAllDraftStyles();
          if (plan) {
            applyDraftStylePlan(plan);
          }
        },
        EDITOR_UPDATE_TAGS.ignored.formulaDraftStyle
      );

      closeTypeahead();
      editor.focus();
      return true;
    },
    [
      applyDraftStylePlan,
      buildDraftStylePlan,
      buildFormulaTextContext,
      clearAllDraftStyles,
      closeTypeahead,
      editor,
      getSelectedTypeaheadItem,
      insertTypeaheadReference,
      onDraftPillActiveChange
    ]
  );

  const tryCommitFormulaAtSelection = useCallback((opts?: { trailingSpace?: boolean }): 'committed' | 'cycle' | 'none' => {
    const prepared = prepareCommitFromSelection();
    if (prepared === 'cycle') {
      referenceBindingsRef.current.clear();
      acceptedReferenceInsertionRef.current = null;
      return 'cycle';
    }
    if (!prepared) {
      return 'none';
    }

    applyPreparedCommit(prepared, opts);
    referenceBindingsRef.current.clear();
    acceptedReferenceInsertionRef.current = null;
    return 'committed';
  }, [applyPreparedCommit, prepareCommitFromSelection]);

  const runCommitInUpdate = useCallback((opts?: { trailingSpace?: boolean }): 'committed' | 'cycle' | 'none' => {
    let outcome: 'committed' | 'cycle' | 'none' = 'none';
    editor.update(() => {
      outcome = tryCommitFormulaAtSelection(opts);
    });
    return outcome;
  }, [editor, tryCommitFormulaAtSelection]);

  useEffect(() => {
    const notesSnapshot = workspaceFormulaNotesRef.current;
    pruneWorkspaceFormulaCache(notesSnapshot);
    externalWorkspaceRef.current = getCachedWorkspaceFormulas(notesSnapshot);

    const notesToFetch = getWorkspaceFormulaNotesToFetch(notesSnapshot);
    if (notesToFetch.length === 0) {
      recomputeEditorFormulas();
      return;
    }

    return scheduleWorkspaceFormulaRefresh(() => {
      void refreshWorkspaceFromDisk(notesSnapshot);
    });
  }, [recomputeEditorFormulas, refreshWorkspaceFromDisk, workspaceFormulaNotesSignature]);

  useEffect(() => {
    const onDiskChange = window.electronAPI?.notes?.onDiskChange;
    if (typeof onDiskChange !== 'function') {
      return;
    }

    return onDiskChange((_noteIds, contentNoteIds = []) => {
      if (contentNoteIds.length === 0) {
        return;
      }

      void refreshWorkspaceFromDisk(workspaceFormulaNotesRef.current, contentNoteIds);
    });
  }, [refreshWorkspaceFromDisk]);

  useEffect(() => {
    return () => {
      clearAllEditedFormulaIds();
    };
  }, []);

  useEffect(() => {
    const rootElement = editor.getRootElement();
    if (!rootElement) {
      return;
    }

    const showReferenceHover = (target: EventTarget | null) => {
      const targetElement =
        target instanceof HTMLElement
          ? target
          : target instanceof Node
            ? target.parentElement
            : null;
      const element = targetElement?.closest('span') as HTMLElement | null;
      if (!element) {
        return;
      }

      const referencedNoteId = element.style.getPropertyValue('--formula-ref-note-id').trim();
      const formulaId = element.style.getPropertyValue('--formula-ref-formula-id').trim();
      if (!referencedNoteId || !formulaId) {
        return;
      }

      if (hoveredReferenceElementRef.current && hoveredReferenceElementRef.current !== element) {
        hoveredReferenceElementRef.current.style.boxShadow = '';
        hoveredReferenceElementRef.current.style.backgroundColor = '';
      }
      hoveredReferenceElementRef.current = element;
      element.style.boxShadow = 'inset 0 0 0 1px var(--border-strong)';
      element.style.backgroundColor = 'var(--surface-note-selected)';

      clearHoverTimeouts();
      hoverTimeoutRef.current = setTimeout(() => {
        const record = editor.getEditorState().read(() => {
          const currentFormulas = collectCurrentNoteFormulaInputs(noteId, currentNoteTitle);
          const workspace = buildWorkspaceEvaluation(currentFormulas);
          return (
            workspace.byKey.get(createFormulaCompoundKey(referencedNoteId, formulaId)) ?? null
          );
        });

        if (!record) {
          return;
        }

        const rect = element.getBoundingClientRect();
        setReferenceHoverState({
          isVisible: true,
          position: {
            x: rect.left,
            y: rect.bottom,
            anchorHeight: rect.height
          },
          name: record.lookupName ?? '',
          formula: record.expression,
          result: record.result,
          stale: record.stale
        });
      }, 140);
    };

    const handleMouseOver = (event: MouseEvent) => {
      showReferenceHover(event.target);
    };

    const handleMouseOut = (event: MouseEvent) => {
      const targetElement =
        event.target instanceof HTMLElement
          ? event.target
          : event.target instanceof Node
            ? event.target.parentElement
            : null;
      if (!targetElement) {
        return;
      }
      const fromReference = targetElement
        .closest('span')
        ?.style.getPropertyValue('--formula-ref-formula-id')
        .trim();
      if (!fromReference) {
        return;
      }

      hideReferenceHover();
    };

    rootElement.addEventListener('mouseover', handleMouseOver);
    rootElement.addEventListener('mouseout', handleMouseOut);

    return () => {
      rootElement.removeEventListener('mouseover', handleMouseOver);
      rootElement.removeEventListener('mouseout', handleMouseOut);
      clearHoverTimeouts();
      if (hoveredReferenceElementRef.current) {
        hoveredReferenceElementRef.current.style.boxShadow = '';
        hoveredReferenceElementRef.current.style.backgroundColor = '';
        hoveredReferenceElementRef.current = null;
      }
    };
  }, [
    buildWorkspaceEvaluation,
    clearHoverTimeouts,
    currentNoteTitle,
    editor,
    hideReferenceHover,
    noteId
  ]);

  useEffect(() => {
    return () => {
      if (draftPillActiveRef.current) {
        draftPillActiveRef.current = false;
      }
      onDraftPillActiveChange?.(false);
    };
  }, [onDraftPillActiveChange]);

  // Cursor-driven draft style: update pill/styles when cursor enters or leaves
  // a formula line. Uses SELECTION_CHANGE_COMMAND (not registerUpdateListener)
  // so it only runs on selection changes, not on every keystroke.
  // Gated with selection.is() so repeated clicks at the same position skip all work.
  useEffect(() => {
    return editor.registerCommand(
      SELECTION_CHANGE_COMMAND,
      () => {
        const selection = $getSelection();
        if (
          selection !== null &&
          lastMathSelectionRef.current !== null &&
          selection.is(lastMathSelectionRef.current)
        ) {
          return false;
        }
        lastMathSelectionRef.current = selection?.clone() ?? null;

        const context = buildFormulaTextContext();
        const plan = context ? buildDraftStylePlan(context) : null;

        const isDraftPillActive = plan !== null;
        if (draftPillActiveRef.current !== isDraftPillActive) {
          draftPillActiveRef.current = isDraftPillActive;
          onDraftPillActiveChange?.(isDraftPillActive);
        }

        const nextSignature = plan?.signature ?? 'none';
        if (nextSignature === draftStyleSignatureRef.current) return false;
        draftStyleSignatureRef.current = nextSignature;

        runIgnoredEditorUpdate(
          editor,
          () => {
            clearAllDraftStyles();
            if (plan) {
              applyDraftStylePlan(plan);
            }
          },
          EDITOR_UPDATE_TAGS.ignored.formulaDraftStyle
        );

        return false;
      },
      COMMAND_PRIORITY_LOW
    );
  }, [
    applyDraftStylePlan,
    buildDraftStylePlan,
    buildFormulaTextContext,
    clearAllDraftStyles,
    editor,
    onDraftPillActiveChange
  ]);

  // Content-driven draft style: update when formula text is edited.
  // Dirty-gated so it skips selection-only changes (click-to-focus, arrow keys).
  useEffect(() => {
    return editor.registerUpdateListener(({ editorState, tags, dirtyLeaves, dirtyElements }) => {
      if (tags.has(EDITOR_UPDATE_TAGS.ignored.formulaDraftStyle)) return;
      if (dirtyLeaves.size === 0 && dirtyElements.size === 0) return;

      const plan = editorState.read(() => {
        const context = buildFormulaTextContext();
        if (!context) {
          return null;
        }
        return buildDraftStylePlan(context);
      });

      const isDraftPillActive = plan !== null;
      if (draftPillActiveRef.current !== isDraftPillActive) {
        draftPillActiveRef.current = isDraftPillActive;
        onDraftPillActiveChange?.(isDraftPillActive);
      }

      const nextSignature = plan?.signature ?? 'none';
      if (nextSignature === draftStyleSignatureRef.current) {
        return;
      }

      draftStyleSignatureRef.current = nextSignature;

      runIgnoredEditorUpdate(
        editor,
        () => {
          clearAllDraftStyles();
          if (plan) {
            applyDraftStylePlan(plan);
          }
        },
        EDITOR_UPDATE_TAGS.ignored.formulaDraftStyle
      );
    });
  }, [
    applyDraftStylePlan,
    buildDraftStylePlan,
    buildFormulaTextContext,
    clearAllDraftStyles,
    editor,
    onDraftPillActiveChange
  ]);

  // Update typeahead visibility and results as the user types.
  useEffect(() => {
    if (!ENABLE_FORMULA_REFERENCE_MENU) {
      return;
    }

    return editor.registerUpdateListener(({ editorState, dirtyLeaves, dirtyElements }) => {
      // Always keep selection ref current (cheap: one clone)
      editorState.read(() => {
        const selection = $getSelection();
        if (selection) {
          savedSelectionRef.current = selection.clone();
        }
      });

      // Dirty-gated: typeahead trigger detection requires content changes (typing),
      // not selection-only changes (click-to-focus, arrow keys).
      if (dirtyLeaves.size === 0 && dirtyElements.size === 0) return;

      editorState.read(() => {
        const context = buildFormulaTextContext();
        if (!context) {
          referenceBindingsRef.current.clear();
          acceptedReferenceInsertionRef.current = null;
          if (typeaheadIsOpenRef.current) {
            closeTypeahead();
          }
          return;
        }

        const queryMatch = findFormulaReferenceQueryAtCursor(
          context.text,
          context.cursorOffset,
          { allowInlineAnonymous: context.allowInlineAnonymous, codeRanges: context.codeRanges }
        );

        if (!queryMatch) {
          acceptedReferenceInsertionRef.current = null;
          const formulaPattern = findFormulaPatternAtCursor(context.text, context.cursorOffset, {
            allowEmptyExpression: true,
            allowInlineAnonymous: context.allowInlineAnonymous,
            codeRanges: context.codeRanges
          });
          if (!formulaPattern) {
            clearEditedFormulaId(context.anchorNode.getKey());
            referenceBindingsRef.current.clear();
          }
          if (typeaheadIsOpenRef.current) {
            closeTypeahead();
          }
          return;
        }

        if (
          acceptedReferenceInsertionRef.current &&
          lastTypeaheadCursorRef.current !== null &&
          lastTypeaheadCursorRef.current !== context.cursorOffset
        ) {
          acceptedReferenceInsertionRef.current = null;
        }

        const acceptedInsertion = acceptedReferenceInsertionRef.current;
        if (
          acceptedInsertion &&
          acceptedInsertion.start === queryMatch.queryStartIndex &&
          acceptedInsertion.end === context.cursorOffset &&
          acceptedInsertion.label === queryMatch.query
        ) {
          if (typeaheadIsOpenRef.current) {
            closeTypeahead();
          }
          return;
        }
        acceptedReferenceInsertionRef.current = null;

        const currentFormulas = collectCurrentNoteFormulaInputs(noteId, currentNoteTitle);
        const workspace = buildWorkspaceEvaluation(currentFormulas);
        let effectiveQuery = queryMatch.query;
        let effectiveQueryStartIndex = queryMatch.queryStartIndex;
        let results = buildFormulaTypeaheadItems(
          workspace,
          noteId,
          effectiveQuery
        );
        // `-` is both a name character and the subtraction operator. When the
        // greedy dashed query (e.g. "revenue-co") matches no variable, the dash
        // is arithmetic — retry with the segment after the last dash ("co") so
        // subtraction chains still get suggestions.
        if (results.length === 0 && effectiveQuery.includes('-')) {
          const lastDash = effectiveQuery.lastIndexOf('-');
          const suffix = effectiveQuery.slice(lastDash + 1);
          if (suffix.length > 0) {
            const suffixResults = buildFormulaTypeaheadItems(workspace, noteId, suffix);
            if (suffixResults.length > 0) {
              results = suffixResults;
              effectiveQueryStartIndex = effectiveQueryStartIndex + lastDash + 1;
              effectiveQuery = suffix;
            }
          }
        }

        const nativeSelection = window.getSelection();
        if (!nativeSelection || nativeSelection.rangeCount === 0) {
          return;
        }

        const range = nativeSelection.getRangeAt(0);
        const cursorRect = range.getBoundingClientRect();

        setTypeaheadResults(results);
        setSelectedIndex((prev) => {
          const shouldResetSelection =
            !typeaheadIsOpenRef.current || typeaheadQueryRef.current !== effectiveQuery;
          let nextIndex = 0;
          if (shouldResetSelection) {
            selectedIndexRef.current = nextIndex;
            return nextIndex;
          }
          nextIndex = clampTypeaheadIndex(prev, results.length);
          selectedIndexRef.current = nextIndex;
          return nextIndex;
        });
        setTypeaheadState({
          isOpen: true,
          query: effectiveQuery,
          queryStartIndex: effectiveQueryStartIndex,
          position: {
            top: cursorRect.bottom + 4,
            left: cursorRect.left
          }
        });
      });
    });
  }, [
    buildFormulaTextContext,
    buildWorkspaceEvaluation,
    closeTypeahead,
    currentNoteTitle,
    editor,
    noteId
  ]);

  useEffect(() => {
    if (!ENABLE_FORMULA_REFERENCE_MENU) {
      return;
    }

    if (!typeaheadState.isOpen) {
      return;
    }

    const removeArrowDown = editor.registerCommand(
      KEY_ARROW_DOWN_COMMAND,
      (event) => {
        const resultsCount = typeaheadResultsRef.current.length;
        if (resultsCount === 0) {
          return false;
        }

        event?.preventDefault();
        setSelectedIndex((prev) => {
          const nextIndex = (prev + 1) % resultsCount;
          selectedIndexRef.current = nextIndex;
          return nextIndex;
        });
        return true;
      },
      COMMAND_PRIORITY_HIGH
    );

    const removeArrowUp = editor.registerCommand(
      KEY_ARROW_UP_COMMAND,
      (event) => {
        const resultsCount = typeaheadResultsRef.current.length;
        if (resultsCount === 0) {
          return false;
        }

        event?.preventDefault();
        setSelectedIndex((prev) => {
          const nextIndex = (prev - 1 + resultsCount) % resultsCount;
          selectedIndexRef.current = nextIndex;
          return nextIndex;
        });
        return true;
      },
      COMMAND_PRIORITY_HIGH
    );

    const removeKeyDown = editor.registerCommand(
      KEY_DOWN_COMMAND,
      (event: KeyboardEvent) => {
        if (!event) {
          return false;
        }

        const isEnter = event.key === 'Enter';
        const isTab = event.key === 'Tab';
        if (!isEnter && !isTab) {
          return false;
        }
        if (isEnter && (event.metaKey || event.ctrlKey || event.altKey)) {
          return false;
        }

        const item = getSelectedTypeaheadItem();
        if (!item) {
          return false;
        }

        event.preventDefault();
        event.stopPropagation();
        const accepted = acceptTypeaheadSelection(item);
        if (accepted && isEnter) {
          suppressNextEnterCommitRef.current = true;
        }
        return accepted;
      },
      COMMAND_PRIORITY_CRITICAL
    );

    const removeEscape = editor.registerCommand(
      KEY_ESCAPE_COMMAND,
      (event) => {
        event?.preventDefault();
        closeTypeahead();
        return true;
      },
      COMMAND_PRIORITY_HIGH
    );

    return () => {
      removeArrowDown();
      removeArrowUp();
      removeKeyDown();
      removeEscape();
    };
  }, [
    acceptTypeaheadSelection,
    closeTypeahead,
    editor,
    getSelectedTypeaheadItem,
    typeaheadState.isOpen
  ]);

  useEffect(() => {
    const removeSpaceHandler = editor.registerCommand(
      KEY_DOWN_COMMAND,
      (event: KeyboardEvent) => {
        if (event.key !== ' ' || event.metaKey || event.ctrlKey || event.altKey) {
          return false;
        }

        const outcome = runCommitInUpdate();

        if (outcome === 'cycle') {
          event.preventDefault();
          closeTypeahead();
          return true;
        }

        if (outcome !== 'committed') {
          return false;
        }

        event.preventDefault();
        closeTypeahead();

        return true;
      },
      COMMAND_PRIORITY_LOW
    );

    const removeEnterHandler = editor.registerCommand(
      KEY_ENTER_COMMAND,
      (event) => {
        if (suppressNextEnterCommitRef.current) {
          suppressNextEnterCommitRef.current = false;
          return true;
        }

        if (event?.defaultPrevented) {
          return true;
        }

        const outcome = runCommitInUpdate({ trailingSpace: false });

        if (outcome === 'cycle') {
          event?.preventDefault();
          closeTypeahead();
          return true;
        }

        if (outcome !== 'committed') {
          return false;
        }

        event?.preventDefault();
        closeTypeahead();
        return true;
      },
      COMMAND_PRIORITY_HIGH
    );

    return () => {
      removeSpaceHandler();
      removeEnterHandler();
    };
  }, [
    closeTypeahead,
    editor,
    runCommitInUpdate
  ]);

  const referenceHoverCard = (
    <HoverCard
      isVisible={referenceHoverState.isVisible}
      position={referenceHoverState.position}
      className="p-2.5"
      maxWidth={280}
    >
      <div className="flex items-start gap-2">
        <Calculator className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-accent-brand" aria-hidden />
        <div className="min-w-0 flex-1">
          {referenceHoverState.name ? (
            <p className="text-nano font-medium uppercase tracking-wide text-ink-muted">
              {referenceHoverState.name}
            </p>
          ) : null}
          <p className="text-small font-medium text-ink-default">{referenceHoverState.result}</p>
          <p className="mt-1 break-words font-mono text-micro text-ink-muted">
            = {referenceHoverState.formula.replace(REFERENCE_TOKEN_REGEX, '$1')}
          </p>
          {referenceHoverState.stale ? (
            <p className="mt-1.5 text-nano text-ink-muted">
              stale - source formula was deleted or is unavailable
            </p>
          ) : null}
        </div>
      </div>
    </HoverCard>
  );

  if (!ENABLE_FORMULA_REFERENCE_MENU) {
    return referenceHoverCard;
  }

  if (!typeaheadState.isOpen || !typeaheadState.position) {
    return referenceHoverCard;
  }

  return (
    <>
      <TypeaheadMenu
          items={typeaheadResults}
          selectedIndex={selectedIndex}
          position={typeaheadState.position}
          onSelect={(item) => {
            acceptTypeaheadSelection(item as FormulaTypeaheadItem);
          }}
          onClose={closeTypeahead}
          emptyQueryMessage="Type formula name..."
          noResultsMessage="No formulas found"
          isQueryEmpty={typeaheadState.query.length === 0}
          width={typeaheadWidth}
          maxHeight={260}
          itemHeight={52}
          renderItem={(item, isSelected, index) => (
            <button
              type="button"
              tabIndex={-1}
              data-index={index}
              className={[
                'flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-small transition-colors',
                isSelected
                  ? 'bg-action-primary/10 text-action-primary'
                  : 'text-ink-default hover:bg-surface-canvas'
              ].join(' ')}
              onMouseDown={(e) => e.preventDefault()}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                acceptTypeaheadSelection(item as FormulaTypeaheadItem);
              }}
            >
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="truncate font-medium">{item.label}</span>
                <span className="truncate font-mono text-micro text-ink-muted">
                  {item.description}
                </span>
              </div>
            </button>
          )}
      />
      {referenceHoverCard}
    </>
  );
}

export default MathCalculationPlugin;

export const mathCalculationPluginTestUtils = {
  buildWorkspaceFormulaNotesSnapshot,
  buildWorkspaceFormulaNotesSignature,
  getWorkspaceFormulaNotesToFetch
};
