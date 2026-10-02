// ported-from: packages/desktop/src/renderer/editor/utils/comment-ui-open-flag.ts @ 762abb777
export const COMMENT_UI_OPEN_ATTR = 'data-moss-comment-ui-open';

let openCommentUiCount = 0;

export function acquireCommentUiOpenFlag(): () => void {
  if (typeof document === 'undefined') {
    return () => undefined;
  }

  let released = false;
  openCommentUiCount += 1;
  document.documentElement.setAttribute(COMMENT_UI_OPEN_ATTR, 'true');

  return () => {
    if (released) return;
    released = true;
    openCommentUiCount = Math.max(0, openCommentUiCount - 1);
    if (openCommentUiCount === 0) {
      document.documentElement.removeAttribute(COMMENT_UI_OPEN_ATTR);
    }
  };
}

export function isCommentUiOpen(): boolean {
  if (typeof document === 'undefined') {
    return false;
  }
  return document.documentElement.hasAttribute(COMMENT_UI_OPEN_ATTR);
}
