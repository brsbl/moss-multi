// Note trash controls in moss's sidebar, note menu and footer (T2.3; A§8): only the owner trashes and restores, so a
// control is offered only when the server would allow it. The footer's Trash button also takes a dropped note row.
import type { DragEvent } from 'react';
import { noteCan } from './capabilities.ts';

/** Trash and Restore: the note's owner only, as the server decides. */
export const canTrashNote = (id: string): boolean => noteCan(id, 'manage');

/** A note row being dragged (moss's rows carry the note id as text; a folder carries its own type). */
const draggingNote = (event: DragEvent) =>
  event.dataTransfer.types.includes('text/plain') && !event.dataTransfer.types.includes('application/x-moss-folder');

/** Drop handlers for the footer's Trash button: a dropped note the caller owns goes to Trash through `onTrash`. */
export function trashDropTarget(onTrash: ((id: string) => void) | undefined) {
  if (!onTrash) return {};
  return {
    onDragOver: (event: DragEvent) => {
      if (!draggingNote(event)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
    },
    onDrop: (event: DragEvent) => {
      const id = event.dataTransfer.getData('text/plain');
      if (!id || !canTrashNote(id)) return;
      event.preventDefault();
      onTrash(id);
    },
  };
}
