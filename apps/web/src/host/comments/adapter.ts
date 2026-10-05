// moss's comment UI over CRDT comments (docs/design/comments.md §12). At the pin moss finds comments by walking the
// tree for MarkNodes and decorator `__commentIds`; a bound note has neither, so each walk site reads one of these
// through a `moss-multi seam: comments` instead. Positions come from the painter's ranges, identities from the doc's
// model, and every write goes through the REST API.
import { can } from '@moss-multi/protocol/roles';
import type { LexicalEditor } from 'lexical';
import { knownRole } from '../access.ts';
import { createComment, replyTo, resolveThread } from './api.ts';
import { $mintNode, mintCurrent, type Minted } from './mint.ts';
import { commentsAtPoint, painterOf, setActive, setHover, subscribePaint } from './paint.ts';

export { commentsAtPoint, setActive, setHover, subscribePaint };

/** The selection minted when the composer opened, per editor, so peers' edits meanwhile cannot move it. */
const stashed = new WeakMap<LexicalEditor, Minted>();

/** The composer is opening on the current selection: mint it now (comments.md §4 "mints at open"). */
export function stashCommentSelection(editor: LexicalEditor): void {
  const painter = painterOf(editor);
  const minted = painter ? mintCurrent(editor, painter.binding) : null;
  if (minted) stashed.set(editor, minted);
  else stashed.delete(editor);
}

/**
 * CREATE_COMMENT_COMMAND (CommentPlugin's seam), inside the command's update: a block comment on `nodeKey`, or a
 * text comment on the selection minted at open (else the current one). True when the comment was sent; null for an
 * editor with no binding (moss's own path then runs).
 */
export function createFromCommand(editor: LexicalEditor, payload: { text: string; nodeKey?: string }): boolean | null {
  const painter = painterOf(editor);
  if (!painter) return null;
  if (!payload.text.trim()) return false;
  const minted = payload.nodeKey ? $mintNode(painter.binding, payload.nodeKey) : (stashed.get(editor) ?? mintCurrent(editor, painter.binding));
  stashed.delete(editor);
  if (!minted) return false;
  createComment(painter.docId, painter.binding.doc, minted, payload.text);
  return true;
}

/** Roots with an anchor record, attached or detached: what moss's comment list counts (CommentAnchorTrackerPlugin). */
export function liveAnchorIds(editor: LexicalEditor): string[] {
  return painterOf(editor)?.model.anchoredRoots() ?? [];
}

/** Gutter rows: each painted root at the top of its first line, relative to the editor root (CommentGutter). */
export function targets(editor: LexicalEditor): { commentId: string; top: number }[] {
  const painter = painterOf(editor);
  const root = editor.getRootElement();
  if (!painter || !root) return [];
  const origin = root.getBoundingClientRect().top;
  const out: { commentId: string; top: number }[] = [];
  for (const [commentId, entry] of painter.painted) {
    const element = entry.block ?? (entry.ranges[0]?.startContainer.parentElement ?? null);
    if (element?.closest('.heading-collapsed-content')) continue;
    const rect = entry.block ? entry.block.getBoundingClientRect() : entry.ranges[0]?.getClientRects()[0];
    if (!rect || rect.height === 0) continue;
    out.push({ commentId, top: rect.top - origin });
  }
  return out;
}

/** Where a thread's anchor is, for opening and revealing it (CommentUIWrapper's inline anchor). */
export function anchorTarget(editor: LexicalEditor, commentId: string): { element: HTMLElement; nodeKey: string } | null {
  const entry = painterOf(editor)?.painted.get(commentId);
  if (!entry) return null;
  const element = entry.block ?? editor.getElementByKey(entry.key);
  return element ? { element, nodeKey: entry.key } : null;
}

/** Block comments on the decorator `nodeKey` (a click on a commented block opens its newest thread). */
export function commentsOnDecorator(editor: LexicalEditor, nodeKey: string): string[] {
  const painter = painterOf(editor);
  if (!painter) return [];
  return [...painter.painted].filter(([, entry]) => entry.block && entry.key === nodeKey).map(([id]) => id);
}

/** A detached thread has no place in the text; its popover opens at the top of the note's text column. */
export function detachedRect(editor: LexicalEditor): { x: number; y: number; width: number; height: number } | null {
  const root = editor.getRootElement();
  if (!root) return null;
  const rect = root.getBoundingClientRect();
  return { x: rect.right, y: Math.max(rect.top, 0), width: 0, height: 0 };
}

/** Whether this tab may reply to and resolve threads on `noteId`: a commenter or above. A viewer only reads them. */
export function canComment(noteId: string): boolean {
  const role = knownRole(noteId);
  return role !== null && can(role, 'comment');
}

/** The thread's writes: a reply, and resolve or reopen. Edit and delete arrive with T4.4. */
export type CommentMutation = { type: 'reply'; parentId: string; text: string } | { type: 'resolve'; rootId: string; resolved: boolean };

export function mutate(editor: LexicalEditor, op: CommentMutation): boolean {
  const painter = painterOf(editor);
  if (!painter) return false;
  if (op.type === 'reply') {
    if (!op.text.trim()) return false;
    replyTo(painter.docId, painter.binding.doc, op.parentId, op.text);
    return true;
  }
  void resolveThread(painter.docId, op.rootId, op.resolved);
  return true;
}
