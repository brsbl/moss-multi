// The image context menu (A§9 system; deviation 5): moss desktop edits an image's alt text from its native Edit menu,
// which a browser has none of, so a right-click on an image in an editable note opens a moss-DS context menu holding
// "Edit Alt Text…". Choosing it selects that image the way moss's click does and fires moss's own native command, so
// moss's editor opens its alt-text field as on desktop. A right-click anywhere else keeps the browser's menu.
import { useEffect, useRef, type ReactNode } from 'react';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '@moss/shared/components/ui/context-menu';
import { runNativeMenuCommand } from './image-menu.ts';

/** moss's image node view: a block decorator holding the `<img>`. */
const IMAGE = '[data-block-decorator-key] img';

/** moss selects a media block on a click of its container (ImageNode.view's handleContainerClick). */
const select = (block: Element) => block.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

export function ImageContextMenu(): ReactNode {
  const anchor = useRef<HTMLElement>(null);
  const block = useRef<Element | null>(null);

  useEffect(() => {
    const open = (event: MouseEvent) => {
      if (!event.isTrusted || !(event.target instanceof Element)) return;
      const image = event.target.closest(IMAGE);
      const editor = image?.closest('[data-lexical-editor="true"]');
      if (!image || editor?.getAttribute('contenteditable') !== 'true') return;
      event.preventDefault();
      event.stopPropagation();
      block.current = image.closest('[data-block-decorator-key]');
      if (block.current) select(block.current);
      // The DS menu opens where its trigger hears a contextmenu, at that event's point.
      anchor.current?.dispatchEvent(new MouseEvent('contextmenu', {
        bubbles: true, cancelable: true, button: 2, clientX: event.clientX, clientY: event.clientY,
      }));
    };
    document.addEventListener('contextmenu', open, true);
    return () => document.removeEventListener('contextmenu', open, true);
  }, []);

  // The menu took focus, and the editor drops a node selection on blur, so the image is selected again first; the
  // command runs once that selection has committed.
  const editAltText = () => {
    const target = block.current;
    if (!target?.isConnected) return;
    select(target);
    setTimeout(() => runNativeMenuCommand('edit-image-alt-text'), 0);
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
