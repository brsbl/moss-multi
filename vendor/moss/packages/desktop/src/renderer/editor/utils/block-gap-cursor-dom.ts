// ported-from: packages/desktop/src/renderer/editor/utils/block-gap-cursor-dom.ts @ 762abb777
import { setDOMUnmanaged } from 'lexical';

export function createElementNodeGapCursor(
  position: 'before' | 'after',
  label: string
): HTMLDivElement {
  const gapCursor = document.createElement('div');
  gapCursor.className = `editor-element-block-gap-cursor group/gap absolute left-0 right-0 z-20 flex h-4 cursor-text items-center justify-center ${
    position === 'before' ? '-top-2' : '-bottom-2'
  }`;
  gapCursor.setAttribute('data-block-gap-cursor', position);
  gapCursor.setAttribute('aria-label', label);
  gapCursor.setAttribute('role', 'button');
  gapCursor.tabIndex = -1;

  const line = document.createElement('div');
  line.className = 'editor-block-gap-cursor-line w-16 rounded-full opacity-0 transition-opacity group-hover/gap:opacity-100';
  gapCursor.appendChild(line);
  setDOMUnmanaged(gapCursor);
  return gapCursor;
}
