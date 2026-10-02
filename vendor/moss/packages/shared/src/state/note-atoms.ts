// ported-from: packages/shared/src/state/note-atoms.ts @ 762abb777
import { atom } from 'jotai';
import { atomFamily } from 'jotai-family';

import type { NoteContentType, NoteEntity, NoteLink } from '../types/note-entity';
import type { NoteComment } from '../types/note-comment';
import {
  activeAgentNoteIdsAtom,
  cleanupLinkResolutionCache,
  initializedNoteIdsAtom,
  noteActionTabsAtom,
  noteExpandedActionTabIdsAtom,
  notePromptDraftAtom,
  pendingAgentExecutionNoteIdsAtom
} from './note-runtime-atoms';

// ============================================================================
// Content Types
// ============================================================================

/**
 * Content data for a note. Hydrated imperatively and written directly.
 */
export interface NoteContentData {
  content: string;
}

/**
 * Sentinel value for noteId when no note is selected.
 * Used by components to avoid conditional hook calls (React Rules of Hooks).
 * Atoms should guard against this value and return empty data without API calls.
 */
export const NO_NOTE_SENTINEL = '__no-note__';

/**
 * Primary per-note atom containing metadata and links.
 * This is the single source of truth for note entity data.
 *
 * NOTE: actionTabs remain in separate atomFamily (noteActionTabsAtom)
 * for granular updates without triggering noteEntityAtom subscribers.
 */
export const noteEntityAtom = atomFamily((_noteId: string) =>
  atom<NoteEntity | null>(null)
);

/**
 * Index of loaded note IDs.
 * Used to iterate over all loaded notes without subscribing to individual atoms.
 */
export const noteIdsAtom = atom<Set<string>>(new Set<string>());

/**
 * Gate atom for initial hydration. Set to true after hydrateNotesAtom
 * completes (or fails). Used by App.tsx to prevent rendering the full
 * UI before the note list is available, eliminating the empty-state flash.
 */
export const notesHydratedAtom = atom<boolean>(false);

/**
 * Selector atom for fine-grained link subscriptions.
 * Derives from noteEntityAtom for reads, updates noteEntityAtom for writes.
 *
 * Read: Returns links from noteEntityAtom or empty arrays if not loaded.
 * Write: Updates the links property of noteEntityAtom. If noteEntityAtom
 *        is null, creates a minimal placeholder entity to store the links
 *        (this supports the current hydration pattern where links arrive
 *        before full entity data).
 */
export const noteLinksAtom = atomFamily((noteId: string) =>
  atom(
    // Getter: derive from noteEntityAtom
    (get) => get(noteEntityAtom(noteId))?.links ?? { outgoing: [], incoming: [] },
    // Setter: update noteEntityAtom's links
    (get, set, links: { outgoing: NoteLink[]; incoming: NoteLink[] } | null) => {
      if (links === null) {
        // Setting to null is a no-op for backward compatibility
        return;
      }
      const entity = get(noteEntityAtom(noteId));
      if (entity) {
        // Update existing entity's links
        set(noteEntityAtom(noteId), { ...entity, links });
      } else {
        // Create placeholder entity with just links
        // This supports the current hydration pattern where links are set
        // before the full entity is loaded. The rest of the entity will be
        // populated when the note is fully loaded.
        set(noteEntityAtom(noteId), {
          id: noteId,
          title: '',
          createdAt: 0,
          updatedAt: 0,
          trashedAt: null,
          lastOpenedAt: null,
          folderPath: '',
          contentType: 'empty',
          links
        });
      }
    }
  )
);

// ============================================================================
// Comment Atoms
// ============================================================================

export type { NoteComment } from '../types/note-comment';

/**
 * Per-note comments data. Hydrated imperatively on mount, written directly.
 * Matches the sticky tabs pattern: atomFamily -> direct read/write -> IPC sync after.
 */
export const noteCommentsMapAtom = atomFamily((_noteId: string) =>
  atom<Record<string, NoteComment>>({})
);

/**
 * Runtime-only comment ids currently anchored in the live editor tree. This is
 * derived from Lexical MarkNodes and commentable decorator nodes, not persisted
 * comment metadata.
 */
export const noteCommentAnchorIdsAtom = atomFamily((_noteId: string) => atom<string[]>([]));

/** True once the mounted editor has synced the current live comment anchors. */
export const noteCommentAnchorIdsSyncedAtom = atomFamily((_noteId: string) => atom(false));

/** Incremented on comment edits via UI (not hydration). Triggers autosave in CanvasAreaContent. */
export const commentDirtySignalAtom = atomFamily((_noteId: string) => atom(0));

export type CommentThreadFilter = 'open' | 'resolved' | 'all';

/** Session UI state: which comment threads are visible in the editor and list. */
export const commentThreadFilterAtom = atomFamily((_noteId: string) => atom<CommentThreadFilter>('open'));

/**
 * Compatibility alias for older callers. `true` means "show all comment
 * threads", while `false` means "show open comment threads".
 */
export const showResolvedCommentsAtom = atomFamily((noteId: string) =>
  atom(
    (get) => get(commentThreadFilterAtom(noteId)) !== 'open',
    (_get, set, showResolved: boolean) => {
      set(commentThreadFilterAtom(noteId), showResolved ? 'all' : 'open');
    }
  )
);

/**
 * Per-note collapsed heading identities ("level:text:ordinal").
 * Hydrated from meta.json on note load, persisted back via notes:update.
 */
export const noteCollapsedHeadingsAtom = atomFamily((_noteId: string) =>
  atom<string[]>([])
);

/**
 * Cleanup helper for comment atoms.
 */
export function cleanupNoteCommentAtoms(noteId: string): void {
  noteCommentsMapAtom.remove(noteId);
  noteCommentAnchorIdsAtom.remove(noteId);
  noteCommentAnchorIdsSyncedAtom.remove(noteId);
  commentDirtySignalAtom.remove(noteId);
  commentThreadFilterAtom.remove(noteId);
  showResolvedCommentsAtom.remove(noteId);
  noteCollapsedHeadingsAtom.remove(noteId);
}

/**
 * Collect a comment and all of its descendant reply ids (BFS over `parentId`).
 * Single source of truth for thread-subtree membership, used by cascade delete
 * and agent-resolution cleanup so a root and its whole thread are removed
 * together. Returns ids present in `map` (the root is included only if present);
 * resilient to cycles and dangling parentIds.
 */
export function collectCommentSubtreeIds(
  map: Record<string, { parentId?: string } | undefined>,
  rootId: string
): string[] {
  if (!Object.prototype.hasOwnProperty.call(map, rootId)) {
    return [];
  }

  const childrenByParent = new Map<string, string[]>();
  for (const [id, comment] of Object.entries(map)) {
    const parentId = comment?.parentId;
    if (typeof parentId === 'string' && parentId.length > 0 && parentId !== id) {
      const children = childrenByParent.get(parentId);
      if (children) {
        children.push(id);
      } else {
        childrenByParent.set(parentId, [id]);
      }
    }
  }

  const result: string[] = [];
  const seen = new Set<string>();
  const queue: string[] = [rootId];
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (seen.has(id)) {
      continue;
    }
    seen.add(id);
    result.push(id);
    for (const childId of childrenByParent.get(id) ?? []) {
      if (!seen.has(childId)) {
        queue.push(childId);
      }
    }
  }

  return result;
}

export type CommentDeletionScope = 'comment' | 'thread';

export interface CommentDeletionResult {
  map: Record<string, NoteComment>;
  changed: boolean;
  removedAnchorIds: string[];
}

/**
 * Delete either one visible comment or an explicit whole thread. Root comment
 * ids double as durable body anchors, so deleting a root message with replies
 * promotes the oldest direct reply into that id instead of removing the anchor.
 */
export function applyCommentDeletion(
  map: Record<string, NoteComment>,
  commentId: string,
  scope: CommentDeletionScope
): CommentDeletionResult {
  const target = map[commentId];
  if (!target) {
    return { map, changed: false, removedAnchorIds: [] };
  }

  if (scope === 'thread') {
    const subtreeIds = collectCommentSubtreeIds(map, commentId);
    const next = { ...map };
    for (const id of subtreeIds) {
      delete next[id];
    }
    return {
      map: next,
      changed: true,
      removedAnchorIds: target.parentId ? [] : [commentId]
    };
  }

  const directChildren = Object.values(map)
    .filter((comment) => comment.parentId === commentId)
    .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));
  const next = { ...map };

  if (target.parentId) {
    delete next[commentId];
    for (const child of directChildren) {
      next[child.id] = { ...child, parentId: target.parentId };
    }
    return { map: next, changed: true, removedAnchorIds: [] };
  }

  const promoted = directChildren[0];
  if (!promoted) {
    delete next[commentId];
    return { map: next, changed: true, removedAnchorIds: [commentId] };
  }

  const promotedRoot = { ...promoted, id: commentId };
  delete promotedRoot.parentId;
  next[commentId] = promotedRoot;
  delete next[promoted.id];
  for (const child of Object.values(next)) {
    if (child.parentId === promoted.id) {
      next[child.id] = { ...child, parentId: commentId };
    }
  }

  return { map: next, changed: true, removedAnchorIds: [] };
}

export type CommentResolutionSource = NonNullable<NoteComment['resolvedBy']>;

export function setCommentSubtreeResolvedState<
  T extends {
    parentId?: string;
    updatedAt: number;
    resolvedAt?: number;
    resolvedBy?: CommentResolutionSource;
  }
>(
  map: Record<string, T>,
  rootId: string,
  options: { resolved: boolean; timestamp: number; resolvedBy?: CommentResolutionSource }
): { map: Record<string, T>; subtreeIds: string[]; changed: boolean } {
  const subtreeIds = collectCommentSubtreeIds(map, rootId);
  if (subtreeIds.length === 0) {
    return { map, subtreeIds, changed: false };
  }

  let changed = false;
  const next = { ...map };
  for (const id of subtreeIds) {
    const comment = next[id];
    if (!comment) continue;

    if (options.resolved) {
      const resolvedBy = options.resolvedBy ?? 'user';
      if (comment.resolvedAt !== options.timestamp || comment.resolvedBy !== resolvedBy || comment.updatedAt !== options.timestamp) {
        next[id] = {
          ...comment,
          resolvedAt: options.timestamp,
          resolvedBy,
          updatedAt: options.timestamp
        };
        changed = true;
      }
    } else {
      if (comment.resolvedAt !== undefined || comment.resolvedBy !== undefined || comment.updatedAt !== options.timestamp) {
        const nextComment = { ...comment };
        delete nextComment.resolvedAt;
        delete nextComment.resolvedBy;
        next[id] = { ...nextComment, updatedAt: options.timestamp };
        changed = true;
      }
    }
  }

  return { map: changed ? next : map, subtreeIds, changed };
}

export function countRootCommentThreads(map: Record<string, NoteComment>): number {
  return Object.values(map).filter((comment) => !comment.parentId).length;
}

/**
 * Derived atom for active (non-trashed) notes.
 * Returns NoteEntity[] sorted by updatedAt descending.
 */
export const activeNotesAtom = atom((get) => {
  const ids = get(noteIdsAtom);
  return [...ids]
    .map((id) => get(noteEntityAtom(id)))
    .filter((n): n is NoteEntity =>
      n !== null &&
      n.trashedAt == null
    )
    .sort((a, b) => b.updatedAt - a.updatedAt);
});

/**
 * Derived atom for trashed notes.
 * Returns NoteEntity[] sorted by trashedAt descending (most recently trashed first).
 * Clean filtering from noteEntityAtom - no scattered gates needed.
 */
export const trashedNotesEntityAtom = atom((get) => {
  const ids = get(noteIdsAtom);
  return [...ids]
    .map((id) => get(noteEntityAtom(id)))
    .filter((n): n is NoteEntity => n !== null && n.trashedAt != null)
    .sort((a, b) => (b.trashedAt ?? 0) - (a.trashedAt ?? 0));
});

export type NoteListEntityEntry = {
  id: string;
  title: string;
  updatedAt: number;
  contentType: NoteContentType;
  folderPath: string;
  externalFilePath?: string;
  pinned?: boolean;
  pinnedAt?: number | null;
};

/**
 * Note list entries derived from activeNotesAtom.
 * Use this instead of noteListAtom from derived.ts for better performance.
 */
export const noteListEntityAtom = atom((get) =>
  get(activeNotesAtom).map((note): NoteListEntityEntry => ({
    id: note.id,
    title: note.title,
    updatedAt: note.updatedAt,
    contentType: note.contentType,
    folderPath: note.folderPath,
    ...(note.externalFilePath ? { externalFilePath: note.externalFilePath } : {}),
    ...(note.pinned != null ? { pinned: note.pinned } : {}),
    ...(note.pinnedAt != null ? { pinnedAt: note.pinnedAt } : {}),
  }))
);

export type SuggestedLinkCandidate = {
  id: string;
  title: string;
  folderPath: string;
  updatedAt: number;
  externalFilePath?: string;
  contentSignalText?: string;
};

/**
 * Structurally-stable projection of activeNotesAtom for suggested link scoring.
 *
 * Only includes the fields buildSuggestedLinks needs. Uses a module-scoped
 * cache to preserve reference identity when scoring-relevant fields (id, title,
 * folderPath) haven't changed — preventing unnecessary useMemo recalculations
 * in LinksSection on every updatedAt bump.
 */
let _suggestedLinkCache: SuggestedLinkCandidate[] = [];

export const suggestedLinkCandidatesAtom = atom((get) => {
  const notes = get(activeNotesAtom);

  const next = notes.map((n): SuggestedLinkCandidate => ({
    id: n.id,
    title: n.title,
    folderPath: n.folderPath,
    updatedAt: n.updatedAt,
    ...(n.externalFilePath ? { externalFilePath: n.externalFilePath } : {}),
    ...(n.contentSignalText ? { contentSignalText: n.contentSignalText } : {})
  }));

  // Structural equality on scoring-relevant fields only
  if (
    next.length === _suggestedLinkCache.length &&
    next.every((entry, i) => {
      const cached = _suggestedLinkCache[i];
      return entry.id === cached.id &&
        entry.title === cached.title &&
        entry.folderPath === cached.folderPath &&
        entry.contentSignalText === cached.contentSignalText;
    })
  ) {
    return _suggestedLinkCache;
  }

  _suggestedLinkCache = next;
  return next;
});

/**
 * Memory management: cleanup all atoms for a note on permanent delete.
 * This should be called when a note is permanently deleted (not just trashed).
 *
 * @example
 * // Awaiting is optional; cleanup is synchronous but still promise-shaped.
 * await store.set(removeNoteEntityAtom, noteId);
 * store.set(removeNoteEntityAtom, noteId);
 */
export const removeNoteEntityAtom = atom(
  null,
  async (get, set, noteId: string) => {
    const entity = get(noteEntityAtom(noteId));
    if (!entity) {
      return;
    }
    const noteTitle = entity.title;

    // Remove from all atomFamilies (entity and metadata)
    noteEntityAtom.remove(noteId);
    noteLinksAtom.remove(noteId);
    noteActionTabsAtom.remove(noteId);
    noteExpandedActionTabIdsAtom.remove(noteId);
    notePromptDraftAtom.remove(noteId);

    // Clean up all content-related atoms to prevent memory leaks
    cleanupNoteContentAtoms(noteId); // also clears pendingSavePromiseAtom

    // Clean up comment atoms
    cleanupNoteCommentAtoms(noteId);

    // Clean up frontmatter atoms
    noteFrontmatterAtom.remove(noteId);
    frontmatterDirtySignalAtom.remove(noteId);
    pendingFrontmatterMetaAtom.remove(noteId);

    // Clean up linkResolutionAtom cache entry for the deleted note's title
    if (noteTitle) {
      cleanupLinkResolutionCache(noteTitle);
    }

    // Remove from all Set-based index atoms
    set(noteIdsAtom, (prev: Set<string>) => {
      const next = new Set(prev);
      next.delete(noteId);
      return next;
    });
    set(initializedNoteIdsAtom, (prev: Set<string>) => {
      const next = new Set(prev);
      next.delete(noteId);
      return next;
    });
    set(activeAgentNoteIdsAtom, (prev: Set<string>) => {
      const next = new Set(prev);
      next.delete(noteId);
      return next;
    });
    set(pendingAgentExecutionNoteIdsAtom, (prev: Set<string>) => {
      const next = new Set(prev);
      next.delete(noteId);
      return next;
    });
  }
);

// ============================================================================
// Content Atom (single sync atom, hydrated imperatively)
// ============================================================================

/**
 * Per-note content atom. Hydrated imperatively in the init effect of
 * CanvasAreaContent, then written directly on editor changes.
 *
 * Follows the same pattern as noteCommentsMapAtom and noteActionTabsAtom:
 * atomFamily → plain default → imperative hydration → direct writes.
 *
 * The editor gates rendering on a local `contentHydrated` boolean so it
 * only mounts once real content is in the atom (avoids mounting with empty
 * content that would be permanent since Lexical's initialConfig runs once).
 */
export const noteContentAtom = atomFamily((_noteId: string) =>
  atom<NoteContentData>({ content: '' })
);

/**
 * Tracks in-flight save promises per note. Used by the agent handler to
 * await completion of any cleanup save before starting agent execution,
 * preventing the cleanup save from overwriting agent-written content.
 */
export const pendingSavePromiseAtom = atomFamily((_noteId: string) =>
  atom<Promise<void> | null>(null)
);

/**
 * Cleanup helper for content atoms - call when a note is permanently deleted.
 * Prevents memory leaks from atomFamily cache.
 */
export function cleanupNoteContentAtoms(noteId: string): void {
  noteContentAtom.remove(noteId);
  pendingSavePromiseAtom.remove(noteId);
}

// ============================================================================
// Frontmatter Atoms
// ============================================================================

/**
 * Per-note frontmatter data. Hydrated imperatively when note content is loaded.
 * null means no frontmatter block exists in the file.
 */
export const noteFrontmatterAtom = atomFamily((_noteId: string) =>
  atom<Record<string, unknown> | null>(null)
);


// ============================================================================
// Panel Tab Atoms
// ============================================================================

/**
 * Per-note signal incremented when frontmatter is changed from outside CanvasAreaContent
 * (e.g., the Properties panel tab). Triggers autosave in CanvasAreaContent the same way
 * commentDirtySignalAtom does for comment changes.
 */
export const frontmatterDirtySignalAtom = atomFamily((_noteId: string) => atom(0));

/**
 * Per-note pending frontmatter meta updates.
 * Accumulated by any component that changes frontmatter fields (Properties panel, toolbar).
 * Read and flushed by CanvasAreaContent during save.
 */
export type FrontmatterMetaUpdate = {
  source: 'user' | 'inferred' | 'user-removed';
  lastModified: number;
};

export const pendingFrontmatterMetaAtom = atomFamily((_noteId: string) =>
  atom<Record<string, FrontmatterMetaUpdate>>({})
);

/** Which tab is active in the right-side actions panel. */
export type ActionsPanelTab = 'actions' | 'properties';

/**
 * Active tab in the actions panel (right side).
 * Global (not per-note) so the user's tab choice is sticky across note switches.
 * Defaults to 'actions'. Persisted only in memory (session-only).
 */
export const actionsPanelActiveTabAtom = atom<ActionsPanelTab>('actions');
