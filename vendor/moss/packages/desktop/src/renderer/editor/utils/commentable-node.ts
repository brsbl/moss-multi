// ported-from: packages/desktop/src/renderer/editor/utils/commentable-node.ts @ 762abb777
import type { LexicalNode } from 'lexical';

export interface CommentableNode {
  getCommentIds(): string[];
  setCommentIds(ids: string[]): void;
}

export function $isCommentableDecorator(node: LexicalNode): node is LexicalNode & CommentableNode {
  return typeof (node as any).getCommentIds === 'function'
      && typeof (node as any).setCommentIds === 'function';
}

export function initCommentIds(ids?: string[]): string[] {
  return ids ?? [];
}

export function cloneCommentIds(ids: string[]): string[] {
  return [...ids];
}

export function exportCommentIds(ids: string[]): Record<string, unknown> {
  return ids.length > 0 ? { commentIds: ids } : {};
}

export function importCommentIds(json: Record<string, unknown>): string[] {
  const ids = json.commentIds;
  if (!Array.isArray(ids)) return [];
  return ids.filter((id): id is string => typeof id === 'string');
}
