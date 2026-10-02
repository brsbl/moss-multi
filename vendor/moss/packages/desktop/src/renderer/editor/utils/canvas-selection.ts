// ported-from: packages/desktop/src/renderer/editor/utils/canvas-selection.ts @ 762abb777
/**
 * True when the current DOM selection is a non-collapsed range that lives inside
 * the editor.
 *
 * A mouse drag-selection finalizes with a trailing `click` whose target can
 * resolve to the editor root element — notably when selecting across top-level
 * blocks, where the common ancestor of the mousedown/mouseup targets is the
 * contenteditable root itself. The canvas "click empty area to deselect" handler
 * must not treat that as an empty click and collapse the selection the user just
 * made. Keyboard selections never produce a click, so they are unaffected.
 */
export function hasActiveEditorTextSelection(
  editorRoot: HTMLElement | null | undefined,
  selection: Selection | null
): boolean {
  if (!editorRoot || !selection || selection.isCollapsed || selection.rangeCount === 0) {
    return false;
  }
  const range = selection.getRangeAt(0);
  return editorRoot.contains(range.commonAncestorContainer);
}
