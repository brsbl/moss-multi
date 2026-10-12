// moss's comment UI over CRDT comments (docs/design/comments.md §12). At the pin moss finds comments by walking the
// tree for MarkNodes and decorator `__commentIds`; a bound note has neither, so each walk site reads one of these
// through a `moss-multi seam: comments` instead. Positions come from the painter's ranges, identities from the doc's
// model, and every write goes through the REST API. An editor with no binding (the file-backed editor bundle) keeps
// moss's own path: each seam asks `bound` first, and the readers answer null for it.
import { can } from '@moss-multi/protocol/roles';
import { $getSelection, $isRangeSelection, type LexicalEditor } from 'lexical';
import { useSyncExternalStore } from 'react';
import { knownRole, useDocRole, useKnownRole } from '../access.ts';
import { terminalOf, useTerminal } from '../collab/terminal.ts';
import {
  createComment, deleteComment, draftOf, editComment, failedDrafts, reactTo, replyTo, resolveThread, type Completion, type DraftSlot,
} from './api.ts';
import { $mintNode, mintCurrent, type Minted } from './mint.ts';
import {
  commentsAtPoint, isShared, noteBound, painterOf, setActive, setHover, sharedDocOf, subscribeAnyPaint, subscribePaint, trackCommentHover,
} from './paint.ts';
import { myPrincipalId } from './people.ts';

export { commentsAtPoint, isShared as bound, setActive, setHover, subscribePaint, trackCommentHover };
export type { Completion, DraftSlot };

/** Whether an editor in this tab is bound to `noteId`, as React state (a binding's start and end both repaint). */
export function useNoteBound(noteId: string): boolean {
  return useSyncExternalStore(subscribeAnyPaint, () => noteBound(noteId));
}

/**
 * What the composer opened on, per editor: the selection minted at open (null when that minted nothing), or a block.
 * Every open replaces it, and a submit leaves it, so a resubmit from the same composer (a retry or a revision) comments
 * on the same words or the same block, and peers' edits meanwhile cannot move it.
 */
type Target = { text: Minted | null } | { block: string };
const stashed = new WeakMap<LexicalEditor, Target>();

/** The composer is opening on the current selection: mint it now (comments.md §4 "mints at open"). */
export function stashCommentSelection(editor: LexicalEditor): void {
  const painter = painterOf(editor);
  stashed.set(editor, { text: painter ? mintCurrent(editor, painter.binding) : null });
}

/** The composer is opening on the block `nodeKey` (a block header's Add comment). */
export function stashCommentBlock(editor: LexicalEditor, nodeKey: string): void {
  stashed.set(editor, { block: nodeKey });
}

/**
 * CREATE_COMMENT_COMMAND (CommentPlugin's seam), inside the command's update: a block comment on `nodeKey` or the block
 * the composer opened on, else a text comment on the selection minted at open (else the current one). True when the
 * comment was sent; null for an editor with no binding (moss's own path then runs). The server's answer reaches the
 * composer through `submitted(noteId, 'root')`.
 */
export function createFromCommand(editor: LexicalEditor, payload: { text: string; nodeKey?: string }): boolean | null {
  if (!isShared(editor)) return null;
  const painter = painterOf(editor);
  if (!painter) return false;
  if (!payload.text.trim() || !canComment(painter.docId)) return false;
  const target = stashed.get(editor);
  const nodeKey = payload.nodeKey ?? (target && 'block' in target ? target.block : undefined);
  const minted = nodeKey
    ? $mintNode(painter.binding, nodeKey)
    : ((target && 'text' in target ? target.text : null) ?? mintCurrent(editor, painter.binding));
  if (!minted) return false;
  createComment(painter.docId, painter.binding.doc, minted, payload.text);
  if (!nodeKey && editor.isEditable()) editor.update($collapseToFocus);
  return true;
}

/**
 * Moss's mark wrap leaves the caret after a forward selection and before a backward one; a comment here adds no
 * MarkNode, so collapse to the focus the same way, or the next keystroke replaces the commented words.
 */
function $collapseToFocus(): void {
  const selection = $getSelection();
  if (!$isRangeSelection(selection) || selection.isCollapsed()) return;
  const { key, offset, type } = selection.focus;
  selection.anchor.set(key, offset, type);
}

/**
 * Roots with an anchor record, attached or detached: what moss's comment list counts (CommentAnchorTrackerPlugin).
 * Null for an editor with no binding (moss's MarkNode walk then runs).
 */
export function liveAnchorIds(editor: LexicalEditor): string[] | null {
  if (!isShared(editor)) return null;
  return painterOf(editor)?.model.anchoredRoots() ?? [];
}

/**
 * Gutter rows: each painted root at the top of its first line, relative to the editor root (CommentGutter). Null for
 * an editor with no binding (moss's MarkNode walk then runs).
 */
export function targets(editor: LexicalEditor): { commentId: string; top: number }[] | null {
  if (!isShared(editor)) return null;
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

/**
 * Whether this tab may comment on, reply to and resolve threads on `noteId`: a commenter or above, while the note is
 * not terminal (A§10.6: a trashed or revoked note keeps its threads readable and nothing else). A viewer only reads.
 */
export function canComment(noteId: string): boolean {
  const role = knownRole(noteId);
  return role !== null && can(role, 'comment') && terminalOf(noteId) === null;
}

/** canComment as React state: a role change or a terminal note re-renders the thread without its write controls. */
export function useCanComment(noteId: string): boolean {
  const role = useDocRole(noteId);
  const terminal = useTerminal(noteId);
  return role !== null && can(role, 'comment') && terminal === null;
}

/**
 * Whether a block header offers Add comment. On a bound note it is canComment, so a commenter comments on blocks in a
 * read-only body; an unbound editor (the file-backed bundle, the viewer) keeps moss's gate, `editable`. It reads the
 * role the pane already holds and never asks the server, so a role this tab forgot (an unknown one) stays forgotten.
 */
export function useBlockCanComment(editor: LexicalEditor, editable: boolean): boolean {
  const docId = useSyncExternalStore(subscribeAnyPaint, () => sharedDocOf(editor), () => null);
  const role = useKnownRole(docId);
  const terminal = useTerminal(docId);
  if (docId === null) return editable;
  return role !== null && can(role, 'comment') && terminal === null;
}

/** Whether this tab's principal wrote `comment` (moss's NoteComment as projected, which carries `author`). */
export function isMine(comment: unknown): boolean {
  const me = myPrincipalId();
  return me !== null && (comment as { author?: unknown } | null)?.author === me;
}

/**
 * The thread's writes: a reply, resolve or reopen, and the author's edit and delete (the server refuses anyone else's
 * with 403; comments.md §12).
 */
export type CommentMutation =
  | { type: 'reply'; parentId: string; text: string }
  | { type: 'resolve'; rootId: string; resolved: boolean }
  | { type: 'edit'; id: string; text: string }
  | { type: 'delete'; id: string; scope: 'comment' | 'thread' };

export function mutate(editor: LexicalEditor, op: CommentMutation): boolean {
  const painter = painterOf(editor);
  if (!painter || !canComment(painter.docId)) return false;
  switch (op.type) {
    case 'reply':
      if (!op.text.trim()) return false;
      replyTo(painter.docId, painter.binding.doc, op.parentId, op.text);
      return true;
    case 'resolve':
      void resolveThread(painter.docId, op.rootId, op.resolved);
      return true;
    case 'edit':
      if (!op.text.trim()) return false;
      void editComment(painter.docId, op.id, op.text);
      return true;
    case 'delete':
      void deleteComment(painter.docId, op.id, op.scope);
      return true;
  }
}

/** Adds or removes this tab's reaction on a comment of `noteId`. */
export function react(noteId: string, commentId: string, emoji: string, on: boolean): void {
  if (canComment(noteId)) void reactTo(noteId, commentId, emoji, on);
}

/**
 * The server's answer to the submit a bound composer just made in `slot` (CREATE_COMMENT_COMMAND or `mutate`), or
 * null when none is in flight. The composer keeps its text until the answer is a success, so a refused or lost write
 * leaves the draft in place and a resubmit of the same text retries it under the same id.
 */
export function submitted(noteId: string, slot: DraftSlot): Promise<Completion> | null {
  const draft = draftOf(noteId, slot);
  return draft && draft.failed === undefined ? draft.done : null;
}

/**
 * The text of `slot`'s failed submits, for a composer to offer again (a reply box that opens, an edit that starts): a
 * thread's failed replies together, a comment's latest failed edit. Null when none failed.
 */
export function failedDraftText(noteId: string, slot: DraftSlot): string | null {
  const failed = failedDrafts(noteId, slot);
  if (!failed.length) return null;
  return slot.startsWith('edit:') ? failed.at(-1)!.text : failed.map((draft) => draft.text).join('\n\n');
}
