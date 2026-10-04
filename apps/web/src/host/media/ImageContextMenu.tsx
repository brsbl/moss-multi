// The image context menu (A§9 system; deviation 5): moss desktop edits an image's alt text from its native Edit menu,
// which a browser has none of, so a right-click on an image in an editable note opens a moss-DS context menu holding
// "Edit Alt Text…". Choosing it selects that image node and fires moss's own native command, so moss's editor opens
// its alt-text field as on desktop. A right-click anywhere else keeps the browser's menu.
import { useEffect, useRef, type ReactNode } from 'react';
import { $createNodeSelection, $getNearestNodeFromDOMNode, $setSelection, getNearestEditorFromDOMNode } from 'lexical';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '@moss/shared/components/ui/context-menu';
import { runNativeMenuCommand } from './image-menu.ts';

/** moss's image node view: a block decorator holding the `<img>`. */
const IMAGE = '[data-block-decorator-key] img';

/** Makes the image under `element` the editor's selection, as moss's click on it does; false once it is gone. */
function selectImage(element: Element): boolean {
  const editor = element.isConnected ? getNearestEditorFromDOMNode(element) : null;
  if (!editor?.isEditable()) return false;
  let selected = false;
  editor.update(() => {
    const node = $getNearestNodeFromDOMNode(element);
    if (!node) return;
    const selection = $createNodeSelection();
    selection.add(node.getKey());
    $setSelection(selection);
    selected = true;
  }, { discrete: true });
  return selected;
}

export function ImageContextMenu(): ReactNode {
  const anchor = useRef<HTMLElement>(null);
  const image = useRef<Element | null>(null);

  useEffect(() => {
    const open = (event: MouseEvent) => {
      if (!event.isTrusted || !(event.target instanceof Element)) return;
      const target = event.target.closest(IMAGE);
      if (target?.closest('[data-lexical-editor="true"]')?.getAttribute('contenteditable') !== 'true') return;
      if (!target || !selectImage(target)) return;
      event.preventDefault();
      event.stopPropagation();
      image.current = target;
      // The DS menu opens where its trigger hears a contextmenu, at that event's point.
      anchor.current?.dispatchEvent(new MouseEvent('contextmenu', {
        bubbles: true, cancelable: true, button: 2, clientX: event.clientX, clientY: event.clientY,
      }));
    };
    document.addEventListener('contextmenu', open, true);
    return () => document.removeEventListener('contextmenu', open, true);
  }, []);

  // The menu took focus, which drops the editor's node selection, so the image is selected again before the command.
  const editAltText = () => {
    if (image.current && selectImage(image.current)) runNativeMenuCommand('edit-image-alt-text');
  };

  return (
    <ContextMenu>
      <ContextMenuTrigger
        ref={anchor}
        render={<div aria-hidden="true" style={{ position: 'fixed', top: 0, left: 0, width: 0, height: 0, pointerEvents: 'none' }} />}
      />
      {/* Focus goes to moss's alt-text field, never back to the hidden trigger. */}
      <ContextMenuContent onCloseAutoFocus={(event) => event.preventDefault()}>
        <ContextMenuItem onSelect={editAltText}>Edit Alt Text…</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
