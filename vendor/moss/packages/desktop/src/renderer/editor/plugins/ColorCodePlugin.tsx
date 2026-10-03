// ported-from: packages/desktop/src/renderer/editor/plugins/ColorCodePlugin.tsx @ 762abb777
// moss-multi seam: local-view (A§10): only the author converts local text; hydration is already normalized.
import { isBoundEditor } from '@moss-multi/host/collab/view-state';
/**
 * ColorCodePlugin – first-class inline color pills.
 *
 * Architecture mirrors FormulaPlugin / FileLinkPlugin:
 *  - DecoratorNode (`ColorCodeNode`) renders the chip via the shared `InlinePill`.
 *  - Targeted TextNode mutation listener converts complete color literals in
 *    prose into pills (no per-keystroke tree walks; only mutated nodes scan).
 *  - `useDecoratorBackspace` round-trips pill → editable text on backspace.
 *
 * Inline `<code>` text and CodeBlockNode text are fully inert — no pills,
 * no swatches, no tooltips. Color literals in code stay as plain text.
 */
import type { JSX } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import {
  $addUpdateTag,
  $createTextNode,
  $getNodeByKey,
  $getRoot,
  $getSelection,
  $isElementNode,
  $isNodeSelection,
  $isRangeSelection,
  HISTORY_PUSH_TAG,
  COMMAND_PRIORITY_LOW,
  KEY_ENTER_COMMAND,
  SELECTION_CHANGE_COMMAND,
  TextNode,
  type LexicalEditor,
  type LexicalNode
} from 'lexical';

import { ColorPickerPopover } from '../components/colorPicker';
import { useDecoratorBackspace } from '../hooks';
import {
  $createColorCodeNode,
  $isColorCodeNode,
  ColorCodeNode
} from '../nodes/ColorCodeNode';
import { CodeBlockNode } from '../nodes/CodeBlockNode';
import {
  findCompleteColorMatches,
  findLiveCompleteColorMatches
} from '../utils/color-codes';
import {
  inferColorTriggerKind,
  parseColorDraft,
  parseColorLiteralDraft,
  type ColorDraft,
  type ColorPickerFormat
} from '../utils/colorDraftParser';
import {
  $captureColorInsertionPoint,
  $getExtendedColorPickerTriggerRange,
  $insertColorAtInsertionPoint,
  $insertColorPickerLiteralAtSelection,
  $isInsideColorSuppressedRawContext,
  $isColorPickerTriggerRangeCurrent,
  $isInsideColorPickerExcludedCode,
  $replaceColorPickerTriggerRange,
  detectColorPickerTrigger,
  type ColorInsertionPoint,
  type ColorPickerTriggerRange
} from '../utils/colorPickerTriggers';
import {
  OPEN_COLOR_PICKER_COMMAND,
  type OpenColorPickerPayload
} from './colorPickerCommands';

/** Update tag used to suppress recursion when this plugin mutates the tree. */
const COLOR_CONVERT_TAG = 'color-pill-convert';
/** Update tag set when the pill is converted back to editable text. */
const COLOR_PILL_EXPAND_TAG = 'color-pill-expand';

interface ColorConversionOptions {
  liveTyping?: boolean;
}

function findConvertibleColorMatchesInNode(node: TextNode, opts?: ColorConversionOptions) {
  const text = node.getTextContent();
  const matches = opts?.liveTyping
    ? findLiveCompleteColorMatches(text)
    : findCompleteColorMatches(text);
  return matches.filter((m) => !$isInsideColorSuppressedRawContext(node, m.start));
}

export function $convertColorLiteralsInTextNode(node: TextNode, opts?: ColorConversionOptions): void {
  if (node.hasFormat('code')) return;
  const initial = node.getTextContent();
  if (!initial) return;

  // If a user types the retired `value[label]` form after an already-created
  // pill, restore the adjacent value to ordinary text as soon as `[` appears.
  // Raw/imported forms are suppressed by the shared context guard below.
  const previous = node.getPreviousSibling();
  if (initial.startsWith('[') && previous instanceof ColorCodeNode) {
    previous.replace($createTextNode(previous.getValue()));
  }

  // Only the 6-digit `#rrggbb` hex form (plus functional rgb / hsl) pills.
  // The hex regex's trailing `\b` keeps a 7- or 8-digit string the user is
  // still typing from matching, so there is no shorter prefix to defer here;
  // functional literals stay eager because `)` is an unambiguous terminator.
  const safeMatches = findConvertibleColorMatchesInNode(node, opts);
  if (safeMatches.length === 0) return;

  // Process matches from the end so the shrinking prefix node keeps the same
  // (smaller) offsets for any earlier matches we still need to convert.
  let current = node;
  for (let i = safeMatches.length - 1; i >= 0; i -= 1) {
    const { start, end, value } = safeMatches[i];
    const len = current.getTextContent().length;
    if (start < 0 || start >= end || end > len) continue;

    let target: TextNode | null = null;
    if (start === 0 && end === len) {
      target = current;
    } else if (start === 0) {
      const segments = current.splitText(end);
      target = segments[0] ?? null;
    } else if (end === len) {
      const segments = current.splitText(start);
      target = segments[1] ?? null;
      current = segments[0] ?? current;
    } else {
      const segments = current.splitText(start, end);
      target = segments[1] ?? null;
      current = segments[0] ?? current;
    }

    if (target && target.getTextContent() === value) {
      target.replace($createColorCodeNode(value));
    }
  }
}

function $isInsideCodeBlock(node: LexicalNode): boolean {
  let parent: LexicalNode | null = node.getParent();
  while (parent) {
    if (parent instanceof CodeBlockNode) return true;
    parent = parent.getParent();
  }
  return false;
}

export function ColorCodeConversionPlugin(): null {
  const [editor] = useLexicalComposerContext();

  // -----------------------------------------------------------------------
  // Mutation listener: convert complete color literals into ColorCodeNodes.
  // Targeted to TextNode changes — no broad tree walks, no per-keystroke
  // scans of unrelated nodes.
  // -----------------------------------------------------------------------
  useEffect(() => {
    if (typeof editor.registerMutationListener !== 'function') return undefined;
    return editor.registerMutationListener(TextNode, (mutations, payload) => {
      const updateTags = payload?.updateTags;
      if (!editor.isEditable() || updateTags?.has('collaboration') || (isBoundEditor(editor) && updateTags?.has('registerMutationListener'))) return;
      // Skip our own conversion writes and the backspace-to-text path so the
      // user can edit the expanded literal without it snapping back.
      if (updateTags?.has(COLOR_CONVERT_TAG) || updateTags?.has(COLOR_PILL_EXPAND_TAG)) return;

      const keysToConvert: string[] = [];
      editor.getEditorState().read(() => {
        for (const [nodeKey, type] of mutations) {
          if (type === 'destroyed') continue;
          const node = $getNodeByKey(nodeKey);
          if (!(node instanceof TextNode)) continue;
          if (node.hasFormat('code')) continue;
          if ($isInsideCodeBlock(node)) continue;
          const text = node.getTextContent();
          if (!text) continue;
          // Only the 6-digit `#rrggbb` hex form (plus functional rgb / hsl)
          // pills. A 7- or 8-digit string in progress fails the hex regex's
          // trailing `\b`, so it stays plain text until it settles at exactly
          // six digits; functional literals stay eager via their `)` terminator.
          const restoresRetiredLabel =
            text.startsWith('[') && node.getPreviousSibling() instanceof ColorCodeNode;
          if (
            !restoresRetiredLabel &&
            findConvertibleColorMatchesInNode(node, { liveTyping: true }).length === 0
          ) {
            continue;
          }
          keysToConvert.push(nodeKey);
        }
      });

      if (keysToConvert.length === 0) return;

      editor.update(
        () => {
          for (const nodeKey of keysToConvert) {
            const node = $getNodeByKey(nodeKey);
            if (node instanceof TextNode) {
              $convertColorLiteralsInTextNode(node, { liveTyping: true });
            }
          }
        },
        { tag: COLOR_CONVERT_TAG }
      );
    });
  }, [editor]);

  // -----------------------------------------------------------------------
  // Initial sweep: convert any color literals present at editor mount, e.g.
  // after markdown import where the COLOR_TRANSFORMER didn't catch a token.
  // This non-interactive pass also runs in read-only/PDF renderers so
  // hex/function literals reach parity there too.
  // -----------------------------------------------------------------------
  useEffect(() => {
    if (isBoundEditor(editor)) return;
    let cancelled = false;
    const run = (): void => {
      if (cancelled) return;
      const keysToConvert: string[] = [];
      editor.getEditorState().read(() => {
        const root = $getRoot();
        const visit = (node: LexicalNode): void => {
          if (node instanceof TextNode) {
            if (node.hasFormat('code')) return;
            if ($isInsideCodeBlock(node)) return;
            if (findConvertibleColorMatchesInNode(node).length > 0) {
              keysToConvert.push(node.getKey());
            }
            return;
          }
          if (node instanceof ColorCodeNode || node instanceof CodeBlockNode) return;
          if ($isElementNode(node)) {
            for (const child of node.getChildren()) visit(child);
          }
        };
        visit(root);
      });
      if (keysToConvert.length === 0) return;
      editor.update(
        () => {
          for (const nodeKey of keysToConvert) {
            const node = $getNodeByKey(nodeKey);
            if (node instanceof TextNode) $convertColorLiteralsInTextNode(node);
          }
        },
        { tag: COLOR_CONVERT_TAG }
      );
    };
    run();
    return () => {
      cancelled = true;
    };
  }, [editor]);

  return null;
}

interface AnchorRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface EditingPill {
  nodeKey: string;
  value: string;
  anchorRect: AnchorRect;
}

interface InsertingColor {
  initialFormat: ColorPickerFormat;
  seed: ColorDraft | null;
  anchorRect: AnchorRect | null;
  replaceRange: ColorPickerTriggerRange | null;
  /** Cursor location captured at open, used to insert when there is no typed
   *  trigger to replace (e.g. the `/colorpick` slash command). */
  insertionPoint: ColorInsertionPoint | null;
}

type OpenInsertionPickerInput = OpenColorPickerPayload & {
  insertionPoint?: ColorInsertionPoint | null;
};

function rectFromElement(element: Element): AnchorRect {
  const rect = element.getBoundingClientRect();
  return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
}

function rectFromNativeSelection(startOffset?: number): AnchorRect | null {
  const nativeSelection = window.getSelection();
  if (!nativeSelection || nativeSelection.rangeCount === 0) return null;

  try {
    const range = nativeSelection.getRangeAt(0).cloneRange();
    const measuringRange =
      typeof startOffset === 'number' ? document.createRange() : range;

    if (typeof startOffset === 'number') {
      measuringRange.setStart(range.startContainer, startOffset);
      measuringRange.setEnd(range.endContainer, range.endOffset);
    }

    const rect = measuringRange.getBoundingClientRect();
    return {
      x: rect.left,
      y: rect.top,
      width: rect.right - rect.left,
      height: rect.bottom - rect.top
    };
  } catch {
    return null;
  }
}

/** A caret rect collapsed onto an empty block reports all zeros; that would
 *  float the popover at the viewport origin, so treat it as unusable. */
function isUsableAnchorRect(rect: AnchorRect | null): rect is AnchorRect {
  if (!rect) return false;
  return rect.x !== 0 || rect.y !== 0 || rect.width !== 0 || rect.height !== 0;
}

/** Measure the nearest rendered element enclosing the current caret. */
function $rectFromAnchorElement(editor: LexicalEditor): AnchorRect | null {
  const selection = $getSelection();
  if (!$isRangeSelection(selection)) return null;
  let node: LexicalNode | null = selection.anchor.getNode();
  while (node) {
    const element = editor.getElementByKey(node.getKey());
    if (element) {
      const rect = element.getBoundingClientRect();
      if (rect.width > 0 || rect.height > 0) {
        return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
      }
    }
    node = node.getParent();
  }
  return null;
}

/**
 * Resolve a reliable anchor for an insertion picker opened with no typed trigger
 * (the `/colorpick` slash path). Prefer the native caret rect, but a collapsed
 * caret on a block the slash trigger text just emptied reports an all-zero rect
 * — fall back to the enclosing block element so the popover stays anchored at
 * the cursor instead of floating at the viewport origin.
 */
function $resolveInsertionAnchorRect(editor: LexicalEditor): AnchorRect | null {
  const fromSelection = rectFromNativeSelection();
  if (isUsableAnchorRect(fromSelection)) return fromSelection;
  return $rectFromAnchorElement(editor) ?? fromSelection;
}

function rangeFromSelection(): ColorPickerTriggerRange | null {
  const selection = $getSelection();
  if (!$isRangeSelection(selection) || !selection.isCollapsed()) return null;
  const anchor = selection.anchor;
  const node = anchor.getNode();
  if (!(node instanceof TextNode)) return null;
  return {
    nodeKey: node.getKey(),
    startOffset: anchor.offset,
    endOffset: anchor.offset,
    triggerText: ''
  };
}

function $rangeWithCurrentText(range: ColorPickerTriggerRange | null): ColorPickerTriggerRange | null {
  if (!range || typeof range.triggerText === 'string') return range;
  const node = $getNodeByKey(range.nodeKey);
  if (!(node instanceof TextNode)) return range;
  return {
    ...range,
    triggerText: node.getTextContent().slice(range.startOffset, range.endOffset)
  };
}

export function ColorCodePlugin(): JSX.Element | null {
  const [editor] = useLexicalComposerContext();
  const [editingPill, setEditingPill] = useState<EditingPill | null>(null);
  const [insertingColor, setInsertingColor] = useState<InsertingColor | null>(null);
  const insertingColorRef = useRef<InsertingColor | null>(null);
  const pickerOpenRef = useRef(false);

  useEffect(() => {
    pickerOpenRef.current = editingPill !== null || insertingColor !== null;
    insertingColorRef.current = insertingColor;
  }, [editingPill, insertingColor]);

  const openInsertionPicker = useCallback((payload: OpenInsertionPickerInput): void => {
    const nextInsertion: InsertingColor = {
      initialFormat: payload.initialFormat,
      seed: payload.seed ?? null,
      anchorRect: payload.anchorRect ?? null,
      replaceRange: payload.replaceRange ?? null,
      insertionPoint: payload.insertionPoint ?? null
    };
    setEditingPill(null);
    insertingColorRef.current = nextInsertion;
    setInsertingColor(nextInsertion);
  }, []);

  useEffect(() => {
    return editor.registerCommand(
      OPEN_COLOR_PICKER_COMMAND,
      (payload) => {
        openInsertionPicker({
          ...payload,
          replaceRange: $rangeWithCurrentText(payload.replaceRange ?? rangeFromSelection()),
          // The inline typed-trigger flow anchors to its measured trigger rect;
          // the slash path has no trigger text left, so resolve a robust caret
          // anchor (falling back to the enclosing block) instead of a stale or
          // all-zero native rect that would float the popover at the origin.
          anchorRect: payload.anchorRect ?? $resolveInsertionAnchorRect(editor),
          // Slash command / programmatic open with no typed trigger to replace:
          // remember the cursor so accept inserts there even if the popover
          // later blurs the editor.
          insertionPoint: payload.replaceRange ? null : $captureColorInsertionPoint()
        });
        return true;
      },
      COMMAND_PRIORITY_LOW
    );
  }, [editor, openInsertionPicker]);

  // Direct color entry: the old color typeahead trigger prefixes now open the
  // picker immediately instead of rendering suggestions. Detection is scoped
  // to mutated TextNodes and the current collapsed selection.
  useEffect(() => {
    if (typeof editor.registerMutationListener !== 'function') return undefined;
    return editor.registerMutationListener(TextNode, (mutations, payload) => {
      if (pickerOpenRef.current) return;

      const updateTags = payload?.updateTags;
      if (!editor.isEditable() || updateTags?.has('collaboration') || (isBoundEditor(editor) && updateTags?.has('registerMutationListener'))) return;
      if (updateTags?.has(COLOR_CONVERT_TAG) || updateTags?.has(COLOR_PILL_EXPAND_TAG)) return;

      let nextPayload: OpenColorPickerPayload | null = null;
      editor.getEditorState().read(() => {
        const selection = $getSelection();
        if (!$isRangeSelection(selection) || !selection.isCollapsed()) return;

        const anchor = selection.anchor;
        const node = anchor.getNode();
        if (!(node instanceof TextNode)) return;
        if (!mutations.has(node.getKey())) return;
        if ($isInsideColorPickerExcludedCode(node, anchor.offset)) return;

        const detected = detectColorPickerTrigger(node.getTextContent(), anchor.offset);
        if (!detected) return;

        nextPayload = {
          initialFormat: detected.kind,
          seed: detected.query ? parseColorDraft(detected.kind, detected.query) : null,
          replaceRange: {
            nodeKey: node.getKey(),
            startOffset: detected.triggerOffset,
            endOffset: anchor.offset,
            triggerText: node.getTextContent().slice(detected.triggerOffset, anchor.offset)
          },
          anchorRect: rectFromNativeSelection(detected.triggerOffset)
        };
      });

      if (nextPayload) {
        openInsertionPicker(nextPayload);
      }
    });
  }, [editor, openInsertionPicker]);

  const updateOrCloseInsertionPicker = useCallback((): void => {
    const target = insertingColorRef.current;
    const range = target?.replaceRange;
    if (!target || !range || !range.triggerText) return;

    const result: { isCurrent: boolean; extended: ColorPickerTriggerRange | null } = {
      isCurrent: false,
      extended: null
    };
    editor.getEditorState().read(() => {
      result.isCurrent = $isColorPickerTriggerRangeCurrent(range, target.initialFormat);
      if (!result.isCurrent) {
        result.extended = $getExtendedColorPickerTriggerRange(range, target.initialFormat);
      }
    });

    if (result.isCurrent) return;

    if (result.extended) {
      const triggerText = result.extended.triggerText ?? '';
      const prefixLen = target.initialFormat === 'hex' ? 1 : target.initialFormat.length + 1;
      const query = triggerText.slice(prefixLen);
      const nextSeed = query ? parseColorDraft(target.initialFormat, query) : null;
      const updated: InsertingColor = {
        ...target,
        seed: nextSeed,
        replaceRange: result.extended
      };
      insertingColorRef.current = updated;
      setInsertingColor(updated);
      return;
    }

    insertingColorRef.current = null;
    setInsertingColor(null);
  }, [editor]);

  const updateOrCloseInsertionPickerInActiveEditor = useCallback((): void => {
    const target = insertingColorRef.current;
    const range = target?.replaceRange;
    if (!target || !range || !range.triggerText) return;

    if ($isColorPickerTriggerRangeCurrent(range, target.initialFormat)) return;

    const extended = $getExtendedColorPickerTriggerRange(range, target.initialFormat);
    if (extended) {
      const triggerText = extended.triggerText ?? '';
      const prefixLen = target.initialFormat === 'hex' ? 1 : target.initialFormat.length + 1;
      const query = triggerText.slice(prefixLen);
      const nextSeed = query ? parseColorDraft(target.initialFormat, query) : null;
      const updated: InsertingColor = {
        ...target,
        seed: nextSeed,
        replaceRange: extended
      };
      insertingColorRef.current = updated;
      setInsertingColor(updated);
      return;
    }

    insertingColorRef.current = null;
    setInsertingColor(null);
  }, []);

  useEffect(() => {
    if (typeof editor.registerMutationListener !== 'function') return undefined;
    return editor.registerMutationListener(TextNode, (mutations) => {
      const range = insertingColorRef.current?.replaceRange;
      if (!range?.triggerText || !mutations.has(range.nodeKey)) return;
      updateOrCloseInsertionPicker();
    });
  }, [editor, updateOrCloseInsertionPicker]);

  useEffect(() => {
    return editor.registerCommand(
      SELECTION_CHANGE_COMMAND,
      () => {
        updateOrCloseInsertionPickerInActiveEditor();
        return false;
      },
      COMMAND_PRIORITY_LOW
    );
  }, [editor, updateOrCloseInsertionPickerInActiveEditor]);

  // -----------------------------------------------------------------------
  // Pill edit: open the shared color picker from an existing pill via
  // single click on the chip, or Enter while the chip is keyboard-selected.
  // The picker mutates the same node via `setValue` on accept; cancel is a
  // no-op so markdown stays byte-identical.
  // -----------------------------------------------------------------------
  const openPickerFor = useCallback(
    (nodeKey: string, value: string, anchorRect: AnchorRect): void => {
      setEditingPill({ nodeKey, value, anchorRect });
    },
    []
  );

  const closePicker = useCallback((): void => {
    setEditingPill(null);
    insertingColorRef.current = null;
    setInsertingColor(null);
  }, []);

  const acceptPicker = useCallback(
    (literal: string, _format: string): void => {
      const target = editingPill;
      if (!target) return;
      // Single editor.update so the user gets exactly one reversible history
      // step. Same node key; only `__value` changes.
      editor.update(() => {
        const node = $getNodeByKey(target.nodeKey);
        if (!$isColorCodeNode(node)) return;
        if (node.getValue() !== literal) node.setValue(literal);
      }, { tag: HISTORY_PUSH_TAG });
      setEditingPill(null);
    },
    [editor, editingPill]
  );

  const acceptInsertionPicker = useCallback(
    (literal: string, _format: string): void => {
      const target = insertingColor;
      if (!target) return;
      editor.update(() => {
        // 1. Replace a typed trigger in place (the in-progress hex/rgb/hsl text).
        if (target.replaceRange?.triggerText) {
          if ($replaceColorPickerTriggerRange(target.replaceRange, literal)) return;
        }
        // 2. Insert at the cursor captured when the picker opened. This is the
        //    `/colorpick` path: the popover may have blurred the editor, so the
        //    saved point is more reliable than the live selection.
        if ($insertColorAtInsertionPoint(target.insertionPoint, literal)) return;
        // 3. Fallbacks: a collapsed trigger range, then the live selection.
        if (target.replaceRange && $replaceColorPickerTriggerRange(target.replaceRange, literal)) return;
        $insertColorPickerLiteralAtSelection(literal);
      });
      setInsertingColor(null);
    },
    [editor, insertingColor]
  );

  useEffect(() => {
    const root = editor.getRootElement();
    if (!root) return undefined;
    const handleClick = (event: MouseEvent): void => {
      const target = event.target as HTMLElement | null;
      const pill = target?.closest('[data-color-node-key]') as HTMLElement | null;
      if (!pill) return;
      const nodeKey = pill.getAttribute('data-color-node-key');
      const value = pill.getAttribute('data-color-value');
      if (!nodeKey || !value) return;
      event.preventDefault();
      event.stopPropagation();
      openPickerFor(nodeKey, value, rectFromElement(pill));
    };
    root.addEventListener('click', handleClick);
    return () => {
      root.removeEventListener('click', handleClick);
    };
  }, [editor, openPickerFor]);

  useEffect(() => {
    return editor.registerCommand(
      KEY_ENTER_COMMAND,
      (event) => {
        const selection = $getSelection();
        if (!$isNodeSelection(selection)) return false;
        const nodes = selection.getNodes();
        if (nodes.length !== 1) return false;
        const node = nodes[0];
        if (!$isColorCodeNode(node)) return false;
        const element = editor.getElementByKey(node.getKey());
        if (!element) return false;
        event?.preventDefault();
        openPickerFor(node.getKey(), node.getValue(), rectFromElement(element));
        return true;
      },
      COMMAND_PRIORITY_LOW
    );
  }, [editor, openPickerFor]);

  // -----------------------------------------------------------------------
  // Backspace pill → editable text. Tag the update so the mutation listener
  // skips it and the user can edit the expanded literal.
  // -----------------------------------------------------------------------
  useDecoratorBackspace({
    isTargetNode: $isColorCodeNode,
    // Expand back to the raw color literal so the user can edit it as text.
    getEditableText: (node) => node.getTextContent(),
    onConvert: () => {
      // Tag this update so the mutation listener doesn't immediately
      // re-convert the just-expanded text node back into a pill. Once the
      // user types anything else, the next mutation lacks this tag and the
      // listener fires normally.
      $addUpdateTag(COLOR_PILL_EXPAND_TAG);
    }
  });

  return (
    <>
      {editingPill ? (
        <ColorPickerPopover
          open
          mode="edit-pill"
          anchorRect={editingPill.anchorRect}
          seed={parseColorLiteralDraft(editingPill.value)}
          initialFormat={inferColorTriggerKind(editingPill.value) ?? 'hex'}
          collisionBoundary={editor.getRootElement()?.closest('.canvas-scroll') ?? null}
          onAccept={acceptPicker}
          onCancel={closePicker}
        />
      ) : null}
      {insertingColor ? (
        <ColorPickerPopover
          open
          mode="insert"
          anchorRect={insertingColor.anchorRect}
          seed={insertingColor.seed}
          initialFormat={insertingColor.initialFormat}
          collisionBoundary={editor.getRootElement()?.closest('.canvas-scroll') ?? null}
          onAccept={acceptInsertionPicker}
          onCancel={closePicker}
        />
      ) : null}
    </>
  );
}

/** Exported tag so the backspace expansion in useDecoratorBackspace can suppress recursion. */
export const COLOR_CODE_UPDATE_TAGS = {
  convert: COLOR_CONVERT_TAG,
  expand: COLOR_PILL_EXPAND_TAG
} as const;

export { isInsideUnclosedDelimiter } from '../utils/color-codes';

export default ColorCodePlugin;
