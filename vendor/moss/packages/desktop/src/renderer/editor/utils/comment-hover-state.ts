// ported-from: packages/desktop/src/renderer/editor/utils/comment-hover-state.ts @ 762abb777
import type { LexicalEditor } from 'lexical';

import { forEachCommentElement } from '../plugins/CommentPlugin';
// moss-multi seam: comments (comments.md §11)
import { setHover } from '@moss-multi/host/comments/adapter';

function escapeCommentId(commentId: string): string {
  return typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
    ? CSS.escape(commentId)
    : commentId.replace(/["\\]/g, '\\$&');
}

function findPaneGutterButton(rootElement: HTMLElement | null, commentId: string): HTMLElement | null {
  if (!rootElement) return null;
  const selector = `[data-comment-gutter-id="${escapeCommentId(commentId)}"]`;
  let scope: HTMLElement | null = rootElement.parentElement;
  while (scope) {
    const match = scope.querySelector<HTMLElement>(selector);
    if (match) return match;
    scope = scope.parentElement;
  }
  return null;
}

export function applyCommentHoverState(
  editor: LexicalEditor,
  commentId: string,
  colorIndex: number
): void {
  setHover(editor, commentId); // moss-multi seam: comments (comments.md §11): the underline is paint
  forEachCommentElement(editor, commentId, (el) => {
    if (el.classList.contains('comment-mark')) {
      el.classList.add('comment-underline-hover');
      el.setAttribute('data-comment-hover-color', String(colorIndex));
      return;
    }
    el.classList.add('comment-decorator-hover');
  });

  findPaneGutterButton(editor.getRootElement(), commentId)?.classList.add('comment-gutter-hover');
}

export function clearCommentHoverState(editor: LexicalEditor): void {
  setHover(editor, null); // moss-multi seam: comments
  const root = editor.getRootElement();
  root?.querySelectorAll('.comment-underline-hover').forEach((el) => {
    el.classList.remove('comment-underline-hover');
    el.removeAttribute('data-comment-hover-color');
  });
  root?.querySelectorAll('.comment-decorator-hover').forEach((el) => el.classList.remove('comment-decorator-hover'));

  let scope: HTMLElement | null = root?.parentElement ?? null;
  while (scope) {
    scope.querySelectorAll('.comment-gutter-hover').forEach((el) => el.classList.remove('comment-gutter-hover'));
    scope = scope.parentElement;
  }
}
