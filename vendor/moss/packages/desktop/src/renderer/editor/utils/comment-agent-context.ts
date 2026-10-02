// ported-from: packages/desktop/src/renderer/editor/utils/comment-agent-context.ts @ 762abb777
import type { NoteComment } from '@moss/shared/state/note-atoms';
import type { createStore } from 'jotai';
import {
  pendingAgentCommentContextAtom,
  pendingAgentCommentIdAtom,
  pendingAgentContextAtom,
  pendingAgentContextIconUrlAtom,
  pendingAgentContextSourceUrlAtom,
  pendingAgentImageUrlsAtom,
  type PendingAgentCommentContext
} from '@moss/shared/state/atoms';
import { collectCommentSubtreeIds } from '@moss/shared/state/note-atoms';
import {
  getReachableRootCommentIds,
  isCommentThreadResolved,
  type CommentAnchorIdOptions,
  type CommentThreadStatusFilter
} from './comment-thread-count';

export const ADDRESS_ALL_OPEN_COMMENTS_PROMPT = 'Address all comments';

export function formatAddressOpenCommentsLabel(openCommentCount: number): string {
  return `Address ${openCommentCount} open ${openCommentCount === 1 ? 'comment' : 'comments'}`;
}

type JotaiStore = ReturnType<typeof createStore>;

export const getCommentAgentAuthorLabel = (comment: NoteComment): string => {
  if (comment.source === 'agent') return 'Moss';
  if (comment.source === 'external') return 'External';
  if (comment.source === 'user') return 'Me';
  return 'Unknown';
};

export function orderCommentThreadForAgent(thread: NoteComment[]): NoteComment[] {
  const [root, ...replies] = thread;
  if (!root) return [];
  return [root, ...replies.sort((a, b) => a.createdAt - b.createdAt)];
}

export function serializeCommentThreadIdsForAgent(thread: NoteComment[]): string {
  const orderedThread = orderCommentThreadForAgent(thread);
  const root = orderedThread[0];
  if (!root) {
    return '';
  }

  const messageIds = orderedThread.map((comment) => comment.id).join(', ');
  return `rootId=${root.id}; messageIds=${messageIds}`;
}

export function getCommentImageUrls(comment: NoteComment): string[] {
  return comment.imageUrls ?? (comment.imageUrl ? [comment.imageUrl] : []);
}

export function collectCommentThreadForAgent(
  commentsMap: Record<string, NoteComment>,
  rootId: string
): NoteComment[] {
  const ids = collectCommentSubtreeIds(commentsMap, rootId);
  const comments = ids
    .map((id) => commentsMap[id])
    .filter((comment): comment is NoteComment => Boolean(comment));

  if (comments.length === 0) {
    return [];
  }

  const root = commentsMap[rootId] ?? comments.find((comment) => !comment.parentId);
  if (!root) {
    return orderCommentThreadForAgent(comments);
  }

  return orderCommentThreadForAgent([
    root,
    ...comments.filter((comment) => comment.id !== root.id)
  ]);
}

export function collectReachableCommentThreadsForAgent(
  commentsMap: Record<string, NoteComment>,
  markdownBody: string,
  options?: { status?: CommentThreadStatusFilter } & CommentAnchorIdOptions
): NoteComment[][] {
  const status = options?.status ?? 'open';
  const rootIds = new Set<string>();
  for (const id of getReachableRootCommentIds(commentsMap, markdownBody, options)) {
    const comment = commentsMap[id];
    if (!comment) continue;
    if (!comment.parentId || !commentsMap[comment.parentId]) {
      if (status !== 'all') {
        const resolved = isCommentThreadResolved(commentsMap, id);
        if (status === 'open' && resolved) continue;
        if (status === 'resolved' && !resolved) continue;
      }
      rootIds.add(id);
    }
  }

  return Array.from(rootIds)
    .map((rootId) => collectCommentThreadForAgent(commentsMap, rootId))
    .filter((thread) => thread.length > 0)
    .sort((left, right) => left[0].createdAt - right[0].createdAt);
}

export function buildPendingCommentContext({
  scope,
  threads,
  promptText
}: {
  scope: PendingAgentCommentContext['scope'];
  threads: NoteComment[][];
  promptText: string;
}): PendingAgentCommentContext | null {
  const orderedThreads = threads
    .map(orderCommentThreadForAgent)
    .filter((thread) => thread.length > 0);

  if (orderedThreads.length === 0) {
    return null;
  }

  const messageCount = orderedThreads.reduce((count, thread) => count + thread.length, 0);
  const title = `${messageCount} ${messageCount === 1 ? 'comment' : 'comments'}`;

  const agentContextText = [
    scope === 'all'
      ? 'Comment root IDs to address and resolve:'
      : scope === 'thread'
        ? 'Comment thread IDs to address and resolve:'
        : 'Comment ID to address and resolve:',
    'Look up these IDs in the active note comments.json sidecar before editing. Update that sidecar directly when replying to, adding, or resolving comments; keep valid JSON and preserve unrelated metadata.',
    ...orderedThreads.map((thread, threadIndex) => {
      const ids = serializeCommentThreadIdsForAgent(thread);
      return orderedThreads.length > 1 ? `- Thread ${threadIndex + 1}: ${ids}` : `- ${ids}`;
    })
  ].join('\n');

  return {
    scope,
    title,
    promptText,
    agentContextText,
    threads: orderedThreads.map((thread) => ({
      rootId: thread[0].id,
      messages: thread.map((comment, index) => ({
        id: comment.id,
        authorLabel: getCommentAgentAuthorLabel(comment),
        source: comment.source,
        color: comment.color,
        text: comment.text,
        kind: index === 0 ? 'comment' : 'reply'
      }))
    }))
  };
}

export function buildPromptWithPendingCommentContext({
  prompt,
  context
}: {
  prompt: string;
  context: PendingAgentCommentContext | null;
}): string {
  if (!context) {
    return prompt;
  }
  return `${context.agentContextText}\n\n${prompt}`;
}

export function getCommentRootIdsForAgentContext(context: PendingAgentCommentContext | null): string[] {
  if (!context) {
    return [];
  }

  return Array.from(new Set(context.threads.map((thread) => thread.rootId)));
}

export function clearPendingCommentAgentContext(store: JotaiStore): void {
  store.set(pendingAgentCommentIdAtom, null);
  store.set(pendingAgentCommentContextAtom, null);
  store.set(pendingAgentContextAtom, null);
  store.set(pendingAgentContextIconUrlAtom, null);
  store.set(pendingAgentContextSourceUrlAtom, null);
  store.set(pendingAgentImageUrlsAtom, null);
}
