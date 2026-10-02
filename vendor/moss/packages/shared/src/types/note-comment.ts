// ported-from: packages/shared/src/types/note-comment.ts @ 762abb777
/**
 * Canonical comment type. Comments are persisted as inline markers in note.md
 * with metadata in a sidecar file.
 */
export interface NoteComment {
  id: string;
  text: string;
  createdAt: number;
  updatedAt: number;
  /** Color index (0-4) assigned at creation for stable gutter icon coloring. */
  color: number;
  source?: 'user' | 'agent' | 'external';
  /**
   * Id of the root/parent comment this is a reply to. Replies are sidecar-only
   * (no inline marker, no body highlight, no gutter marker); a root comment has
   * no parentId. Backward compatible: comments without parentId are roots.
   */
  parentId?: string;
  /** Relative path to an attached image, e.g. "assets/comment-image-xyz.png". */
  imageUrl?: string;
  /** Multiple attached image paths. Takes precedence over imageUrl when present. */
  imageUrls?: string[];
  /** Unix timestamp (seconds) when the comment/thread was resolved. */
  resolvedAt?: number;
  /** Source that resolved the comment/thread. */
  resolvedBy?: 'user' | 'agent' | 'external';
}
