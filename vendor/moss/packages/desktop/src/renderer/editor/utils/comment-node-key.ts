// ported-from: packages/desktop/src/renderer/editor/utils/comment-node-key.ts @ 762abb777
export function buildCommentNodeKeyCandidates(
  savedNodeKey: string | null,
  liveNodeKey: string | null
): string[] {
  return Array.from(new Set([savedNodeKey, liveNodeKey].filter(Boolean) as string[]));
}
