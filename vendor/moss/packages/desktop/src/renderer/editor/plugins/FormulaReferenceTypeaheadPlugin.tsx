// ported-from: packages/desktop/src/renderer/editor/plugins/FormulaReferenceTypeaheadPlugin.tsx @ 762abb777
import { useCallback, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  LexicalTypeaheadMenuPlugin,
  MenuOption,
  type MenuRenderFn,
  type MenuTextMatch,
  type TriggerFn
} from '@lexical/react/LexicalTypeaheadMenuPlugin';
import {
  $getSelection,
  $isElementNode,
  $isRangeSelection,
  $isTextNode,
  COMMAND_PRIORITY_CRITICAL,
  TextNode,
  type LexicalEditor
} from 'lexical';
import { $isLinkNode } from '@lexical/link';
import { $isCodeNode } from '@lexical/code';
import { $isListItemNode } from '@lexical/list';

import {
  findFormulaReferenceQueryAtCursor,
  type CodeRange
} from '../utils/formula-runtime';
import { $isFormulaNode } from '../nodes/FormulaNode';

export interface FormulaReferenceData {
  noteId: string;
  formulaId: string;
  name: string;
  result: string;
  noteTitle: string;
  expression: string;
}

export class FormulaReferenceOption extends MenuOption {
  data: FormulaReferenceData;

  constructor(data: FormulaReferenceData) {
    super(`${data.noteId}:${data.formulaId}`);
    this.data = data;
  }
}

interface FormulaReferenceTypeaheadPluginProps {
  /** Compute filtered typeahead items for a query. Called inside editor read context. */
  getItems: (query: string) => FormulaReferenceOption[];
  /** Handle reference selection. Called inside editor update context by the plugin. */
  onSelectOption: (
    option: FormulaReferenceOption,
    textNodeContainingQuery: TextNode | null,
    closeMenu: () => void,
    matchingString: string
  ) => void;
  /** Called when the typeahead menu opens. */
  onOpen?: () => void;
  /** Called when the typeahead menu closes. */
  onClose?: () => void;
}

// ── Context detection helpers ────────────────────────────────────────

function isFormulaTriggerContext(node: TextNode): boolean {
  if (node.hasFormat('code')) return false;

  let current = node.getParent();
  while (current) {
    if ($isLinkNode(current) || $isCodeNode(current)) return false;
    current = current.getParent();
  }

  return findFormulaTextContainer(node) !== null;
}

function findFormulaTextContainer(node: TextNode): ReturnType<typeof node.getParent> {
  let ancestor = node.getParent();
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

function isInsideListItem(node: TextNode): boolean {
  let current = node.getParent();
  while (current) {
    if ($isListItemNode(current)) return true;
    current = current.getParent();
  }
  return false;
}

interface FormulaContextForTrigger {
  text: string;
  cursorOffset: number;
  codeRanges: CodeRange[];
  allowInlineAnonymous: boolean;
  anchorNodeStart: number;
}

/** Build paragraph text and cursor offset for formula trigger detection. */
function getFormulaContextForTrigger(): FormulaContextForTrigger | null {
  const selection = $getSelection();
  if (!$isRangeSelection(selection) || !selection.isCollapsed()) return null;

  const anchor = selection.anchor;
  const anchorNode = anchor.getNode();
  if (!$isTextNode(anchorNode) || !isFormulaTriggerContext(anchorNode)) return null;

  const paragraph = findFormulaTextContainer(anchorNode);
  if (!paragraph || !$isElementNode(paragraph)) return null;

  let text = '';
  let cursorOffset: number | null = null;
  let anchorNodeStart = 0;
  const codeRanges: CodeRange[] = [];

  for (const child of paragraph.getChildren()) {
    if (!$isTextNode(child)) return null;
    const childText = child.getTextContent();
    const start = text.length;
    const end = start + childText.length;

    if (child.hasFormat('code')) {
      codeRanges.push({ start, end });
    }

    if (child.getKey() === anchorNode.getKey()) {
      cursorOffset = start + anchor.offset;
      anchorNodeStart = start;
    }
    text += childText;
  }

  if (cursorOffset === null) return null;

  return { text, cursorOffset, codeRanges, allowInlineAnonymous: isInsideListItem(anchorNode), anchorNodeStart };
}

// ── Plugin component ────────────────────────────────────────────────

export function FormulaReferenceTypeaheadPlugin({
  getItems,
  onSelectOption,
  onOpen,
  onClose
}: FormulaReferenceTypeaheadPluginProps) {
  const [options, setOptions] = useState<FormulaReferenceOption[]>([]);
  const lastAcceptedCursorRef = useRef<number | null>(null);

  const triggerFn: TriggerFn = useCallback(
    (text: string, _editor: LexicalEditor): MenuTextMatch | null => {
      const ctx = getFormulaContextForTrigger();
      if (!ctx) return null;

      // Suppress re-trigger immediately after accepting a reference
      if (lastAcceptedCursorRef.current !== null) {
        if (ctx.cursorOffset === lastAcceptedCursorRef.current) {
          return null;
        }
        lastAcceptedCursorRef.current = null;
      }

      const queryMatch = findFormulaReferenceQueryAtCursor(ctx.text, ctx.cursorOffset, {
        allowInlineAnonymous: ctx.allowInlineAnonymous,
        codeRanges: ctx.codeRanges
      });
      if (!queryMatch) return null;

      // leadOffset is relative to the text passed by the plugin (anchor node text before cursor)
      const leadOffset = queryMatch.queryStartIndex - ctx.anchorNodeStart;
      if (leadOffset < 0 || leadOffset > text.length) return null;

      return {
        leadOffset,
        matchingString: queryMatch.query,
        replaceableString: queryMatch.query
      };
    },
    []
  );

  const handleQueryChange = useCallback(
    (matchingString: string | null) => {
      if (matchingString === null) {
        setOptions([]);
        return;
      }
      setOptions(getItems(matchingString));
    },
    [getItems]
  );

  const handleSelectOption = useCallback(
    (
      option: FormulaReferenceOption,
      textNodeContainingQuery: TextNode | null,
      closeMenu: () => void,
      matchingString: string
    ) => {
      // Track cursor for re-trigger suppression
      const selection = $getSelection();
      if ($isRangeSelection(selection)) {
        lastAcceptedCursorRef.current = selection.anchor.offset;
      }

      onSelectOption(option, textNodeContainingQuery, closeMenu, matchingString);
    },
    [onSelectOption]
  );

  const menuRenderFn: MenuRenderFn<FormulaReferenceOption> = useCallback(
    (anchorElementRef, { selectedIndex, selectOptionAndCleanUp, options: menuOptions }) => {
      if (!anchorElementRef.current || menuOptions.length === 0) return null;

      return createPortal(
        <div
          className="rounded-lg border border-border-subtle bg-surface-canvas shadow-lg"
          style={{ minWidth: 280 }}
        >
          <div className="max-h-[260px] overflow-y-auto py-1">
            {menuOptions.map((option, index) => (
              <button
                key={option.key}
                type="button"
                ref={option.setRefElement}
                tabIndex={-1}
                className={[
                  'flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-small transition-colors',
                  index === selectedIndex
                    ? 'bg-action-primary/10 text-action-primary'
                    : 'text-ink-default hover:bg-surface-canvas'
                ].join(' ')}
                onMouseDown={(e) => e.preventDefault()}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  selectOptionAndCleanUp(option);
                }}
              >
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate font-medium">{option.data.name}</span>
                  <span className="truncate font-mono text-micro text-ink-muted">
                    {option.data.expression}
                  </span>
                </div>
              </button>
            ))}
          </div>
        </div>,
        anchorElementRef.current
      );
    },
    []
  );

  return (
    <LexicalTypeaheadMenuPlugin<FormulaReferenceOption>
      options={options}
      triggerFn={triggerFn}
      onQueryChange={handleQueryChange}
      onSelectOption={handleSelectOption}
      menuRenderFn={menuRenderFn}
      commandPriority={COMMAND_PRIORITY_CRITICAL}
      onOpen={onOpen ? () => onOpen() : undefined}
      onClose={onClose}
    />
  );
}
