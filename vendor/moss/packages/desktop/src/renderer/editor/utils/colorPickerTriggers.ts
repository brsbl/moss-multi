// ported-from: packages/desktop/src/renderer/editor/utils/colorPickerTriggers.ts @ 762abb777
import {
  $createRangeSelection,
  $getNodeByKey,
  $getSelection,
  $isElementNode,
  $isRangeSelection,
  $setSelection,
  TextNode,
  type LexicalNode
} from 'lexical';

import { $createColorCodeNode } from '../nodes/ColorCodeNode';
import { CodeBlockNode } from '../nodes/CodeBlockNode';
import {
  isAfterUnclosedBacktick,
  isInsideInlineCodeSpan,
  isInsideRetiredNamedColorToken,
  isInsideUnclosedDelimiter
} from './color-codes';
import type { ColorPickerFormat } from './colorDraftParser';

export interface ColorPickerTriggerRange {
  nodeKey: string;
  startOffset: number;
  endOffset: number;
  triggerText?: string;
}

export interface DetectedColorPickerTrigger {
  kind: ColorPickerFormat;
  triggerOffset: number;
  prefixLength: number;
  query: string;
}

const FN_OPEN = '(';
const HEX_PREFIX = '#';
const WORD_CHAR_RE = /[a-zA-Z0-9_]/;
const HEX_CHAR_RE = /[0-9a-fA-F]/;
// A `#` plus 1–6 hex digits opens the hex color picker as a draft (e.g. `#f`),
// so the picker is available the moment the user starts a color. Opening the
// picker is a transient affordance only — it never mutates the document, so a
// short hex-like ref the user keeps typing stays inert plain text and is only
// ever committed to a pill when a valid color is selected or the hex settles at
// a complete 6-digit `#rrggbb` (see the 6-digit conversion gate in
// `color-codes.ts`). Runs longer than six hex digits — 7/8-digit alpha hex and
// hash-plus-digits issue/PR refs — never trigger the picker at all.
const HEX_QUERY_RE = /^[0-9a-fA-F]{1,6}$/;
const FUNCTION_QUERY_FORBIDDEN_RE = /[)\n]/;
const FORMULA_DRAFT_CHIP_STYLE_MARKER = '--formula-draft-chip: 1';
const FORMULA_EDIT_ID_STYLE_MARKER = '--formula-edit-id:';

const TRIGGER_PREFIXES: ReadonlyArray<{
  kind: ColorPickerFormat;
  prefix: string;
}> = [
  { kind: 'hsla', prefix: 'hsla' + FN_OPEN },
  { kind: 'hsla', prefix: 'hsl' + FN_OPEN },
  { kind: 'rgba', prefix: 'rgba' + FN_OPEN },
  { kind: 'rgba', prefix: 'rgb' + FN_OPEN },
  { kind: 'hex', prefix: HEX_PREFIX },
];

export function detectColorPickerTrigger(
  text: string,
  cursor: number
): DetectedColorPickerTrigger | null {
  const before = text.slice(0, cursor);
  let best: DetectedColorPickerTrigger | null = null;

  for (const cfg of TRIGGER_PREFIXES) {
    const idx = before.lastIndexOf(cfg.prefix);
    if (idx === -1) continue;
    if (idx > 0 && WORD_CHAR_RE.test(before[idx - 1] ?? '')) continue;

    const query = before.slice(idx + cfg.prefix.length);
    if (cfg.kind === 'hex') {
      if (!HEX_QUERY_RE.test(query)) continue;
      if (HEX_CHAR_RE.test(text[cursor] ?? '')) continue;
    } else if (FUNCTION_QUERY_FORBIDDEN_RE.test(query)) {
      continue;
    }

    if (!best || idx > best.triggerOffset) {
      best = {
        kind: cfg.kind,
        triggerOffset: idx,
        prefixLength: cfg.prefix.length,
        query,
      };
    }
  }

  return best;
}

function getInlineTextContext(node: TextNode, offset: number): {
  text: string;
  offset: number;
} | null {
  const parent = node.getParent();
  if (!$isElementNode(parent)) return null;

  let nodeStart = 0;
  for (const child of parent.getChildren()) {
    if (child === node) {
      return {
        text: parent.getTextContent(),
        offset: nodeStart + Math.max(0, Math.min(offset, node.getTextContentSize()))
      };
    }
    nodeStart += child.getTextContent().length;
  }

  return null;
}

function hasFormulaEditStyle(node: TextNode): boolean {
  const style = node.getStyle();
  return (
    style.includes(FORMULA_DRAFT_CHIP_STYLE_MARKER) ||
    style.includes(FORMULA_EDIT_ID_STYLE_MARKER)
  );
}

export function $isInsideColorSuppressedRawContext(
  node: TextNode,
  offset: number
): boolean {
  if (node.hasFormat('code')) return true;
  if (hasFormulaEditStyle(node)) return true;

  const text = node.getTextContent();
  if (isInsideInlineCodeSpan(text, offset)) return true;
  if (isAfterUnclosedBacktick(text, offset)) return true;
  if (isInsideRetiredNamedColorToken(text, offset)) return true;
  if (isInsideUnclosedDelimiter(text, offset)) return true;

  const context = getInlineTextContext(node, offset);
  if (!context || context.text === text) return false;
  if (isInsideInlineCodeSpan(context.text, context.offset)) return true;
  if (isAfterUnclosedBacktick(context.text, context.offset)) return true;
  if (isInsideRetiredNamedColorToken(context.text, context.offset)) return true;
  if (isInsideUnclosedDelimiter(context.text, context.offset)) return true;

  return false;
}

export function $isInsideColorPickerExcludedCode(node: LexicalNode, offset?: number): boolean {
  if (node instanceof TextNode) {
    if (node.hasFormat('code')) return true;
    if (hasFormulaEditStyle(node)) return true;
    if (typeof offset === 'number') {
      if ($isInsideColorSuppressedRawContext(node, offset)) return true;
    }
  }

  let current: LexicalNode | null = node.getParent();
  while (current) {
    if (current instanceof CodeBlockNode) return true;
    current = current.getParent();
  }
  return false;
}

export function $isColorPickerTriggerRangeCurrent(
  range: ColorPickerTriggerRange,
  kind: ColorPickerFormat
): boolean {
  const node = $getNodeByKey(range.nodeKey);
  if (!(node instanceof TextNode)) return false;
  if ($isInsideColorPickerExcludedCode(node, range.endOffset)) return false;

  const text = node.getTextContent();
  if (
    range.startOffset < 0 ||
    range.endOffset < range.startOffset ||
    range.endOffset > text.length
  ) {
    return false;
  }

  if (
    typeof range.triggerText === 'string' &&
    text.slice(range.startOffset, range.endOffset) !== range.triggerText
  ) {
    return false;
  }

  const selection = $getSelection();
  if (
    !$isRangeSelection(selection) ||
    !selection.isCollapsed() ||
    selection.anchor.key !== range.nodeKey ||
    selection.anchor.offset !== range.endOffset
  ) {
    return false;
  }

  const detected = detectColorPickerTrigger(text, range.endOffset);
  return detected?.kind === kind && detected.triggerOffset === range.startOffset;
}

/**
 * Check whether the user is extending an existing trigger (e.g. `#f` → `#ff`).
 * Returns the updated range if the trigger is still valid at a new cursor
 * position, or null if the trigger has become invalid. This enables typeahead-
 * style continuation where the picker stays open as the user refines the value.
 */
export function $getExtendedColorPickerTriggerRange(
  range: ColorPickerTriggerRange,
  kind: ColorPickerFormat
): ColorPickerTriggerRange | null {
  const node = $getNodeByKey(range.nodeKey);
  if (!(node instanceof TextNode)) return null;
  if ($isInsideColorPickerExcludedCode(node)) return null;

  const text = node.getTextContent();
  const selection = $getSelection();
  if (
    !$isRangeSelection(selection) ||
    !selection.isCollapsed() ||
    selection.anchor.key !== range.nodeKey
  ) {
    return null;
  }

  const cursorOffset = selection.anchor.offset;
  if ($isInsideColorPickerExcludedCode(node, cursorOffset)) return null;

  if (cursorOffset <= range.startOffset) return null;

  const detected = detectColorPickerTrigger(text, cursorOffset);
  if (!detected || detected.kind !== kind || detected.triggerOffset !== range.startOffset) {
    return null;
  }

  return {
    nodeKey: range.nodeKey,
    startOffset: range.startOffset,
    endOffset: cursorOffset,
    triggerText: text.slice(range.startOffset, cursorOffset)
  };
}

function isValidReplacementTriggerRange(
  text: string,
  startOffset: number,
  endOffset: number
): boolean {
  const detected = detectColorPickerTrigger(text, endOffset);
  return detected !== null && detected.triggerOffset === startOffset;
}

export function $replaceColorPickerTriggerRange(
  range: ColorPickerTriggerRange,
  literal: string
): boolean {
  const node = $getNodeByKey(range.nodeKey);
  if (!(node instanceof TextNode)) return false;

  const textLength = node.getTextContent().length;
  const startOffset = Math.max(0, Math.min(range.startOffset, textLength));
  const endOffset = Math.max(startOffset, Math.min(range.endOffset, textLength));
  if (
    $isInsideColorPickerExcludedCode(node, startOffset) ||
    $isInsideColorPickerExcludedCode(node, endOffset)
  ) {
    return false;
  }
  if (
    typeof range.triggerText === 'string' &&
    node.getTextContent().slice(startOffset, endOffset) !== range.triggerText
  ) {
    return false;
  }

  if (!isValidReplacementTriggerRange(node.getTextContent(), startOffset, endOffset)) {
    return false;
  }

  node.select(startOffset, endOffset);
  const selection = $getSelection();
  if (!$isRangeSelection(selection)) return false;
  selection.removeText();

  selection.insertNodes([$createColorCodeNode(literal)]);
  return true;
}

export function $insertColorPickerLiteralAtSelection(literal: string): boolean {
  const selection = $getSelection();
  if (!$isRangeSelection(selection)) return false;
  const anchorNode = selection.anchor.getNode();
  if ($isInsideColorPickerExcludedCode(anchorNode, selection.anchor.offset)) return false;

  selection.insertNodes([$createColorCodeNode(literal)]);
  return true;
}

/**
 * A collapsed-cursor location saved when the color picker opens, so the
 * committed pill lands exactly where the cursor was even after the picker
 * popover steals DOM focus (which can blur the editor and leave the live
 * selection unreliable at accept time). Captures both text-anchored and
 * element-anchored points (e.g. an empty paragraph after the `/colorpick`
 * trigger text is removed).
 */
export interface ColorInsertionPoint {
  key: string;
  offset: number;
  type: 'text' | 'element';
}

/** Snapshot the current collapsed selection as a reusable insertion point. */
export function $captureColorInsertionPoint(): ColorInsertionPoint | null {
  const selection = $getSelection();
  if (!$isRangeSelection(selection) || !selection.isCollapsed()) return null;
  const anchor = selection.anchor;
  const node = anchor.getNode();
  const offset = anchor.offset;
  if ($isInsideColorPickerExcludedCode(node, anchor.type === 'text' ? offset : undefined)) {
    return null;
  }
  return {
    key: node.getKey(),
    offset,
    type: anchor.type === 'element' ? 'element' : 'text'
  };
}

/**
 * Restore a previously captured insertion point and insert a color pill there.
 * Returns false if the saved node is gone or now sits inside a code surface.
 */
export function $insertColorAtInsertionPoint(
  point: ColorInsertionPoint | null,
  literal: string
): boolean {
  if (!point) return false;
  const node = $getNodeByKey(point.key);
  if (!node) return false;
  if ($isInsideColorPickerExcludedCode(node, point.type === 'text' ? point.offset : undefined)) {
    return false;
  }

  const offset =
    point.type === 'text' && node instanceof TextNode
      ? Math.max(0, Math.min(point.offset, node.getTextContentSize()))
      : point.offset;

  const selection = $createRangeSelection();
  selection.anchor.set(point.key, offset, point.type);
  selection.focus.set(point.key, offset, point.type);
  $setSelection(selection);

  const active = $getSelection();
  if (!$isRangeSelection(active)) return false;
  active.insertNodes([$createColorCodeNode(literal)]);
  return true;
}
