// ported-from: packages/shared/src/types/note-entity.ts @ 762abb777
/**
 * Content type for note icons based on dominant content (>60% threshold).
 * This is the canonical definition - all other locations should import from here.
 *
 * - 'empty': New notes or notes with <50 characters
 * - 'code': Primarily code blocks (>60% of content)
 * - 'charts': Primarily chart blocks (>60% of block nodes)
 * - 'images': Primarily image nodes (>60% of block nodes)
 * - 'media': Primarily media nodes like sketches (>60% of block nodes)
 * - 'large-text': Large notes (>2000 chars) without dominant block type
 * - 'medium-text': Medium notes (50-2000 chars) without dominant block type
 */
export type NoteContentType =
  | 'empty'
  | 'code'
  | 'charts'
  | 'images'
  | 'media'
  | 'large-text'
  | 'medium-text';

/**
 * Link information for a note connection.
 * Used for both outgoing (wiki links) and incoming (backlinks).
 *
 * This is the canonical type for note links. Re-exported as:
 * - `NoteLinkInfo` from `@moss/shared/state/atoms` (deprecated alias)
 * - `LinkInfo` from `@moss/desktop/common/noteTypes` (deprecated alias)
 */
export interface NoteLink {
  /** ID of the linked note */
  noteId: string;
  /** Title of the linked note */
  title: string;
  /** Folder path of the linked note */
  folderPath?: string;
  /** Preview text from the linked note */
  preview?: string;
  /** Unix timestamp when the linked note was last updated */
  updatedAt?: number;
}

/**
 * Consolidated note entity containing metadata and links.
 * This is the primary per-note atom structure.
 *
 * NOTE: actionTabs are NOT included here - they remain in a separate atomFamily
 * for granular updates without re-render cascades.
 */
export interface NoteEntity {
  // Core identity
  /** Unique note identifier (UUID) */
  id: string;
  /** Note title */
  title: string;

  // Timestamps (Unix seconds)
  /** Unix timestamp when the note was created */
  createdAt: number;
  /** Unix timestamp when the note was last updated */
  updatedAt: number;
  /** Unix timestamp when the note was trashed, or null if not trashed */
  trashedAt: number | null;
  /** Unix timestamp when the note was last opened, or null if never opened */
  lastOpenedAt: number | null;

  // Organization
  /** Folder path (e.g., "Notes" or "Notes/Projects") */
  folderPath: string;
  /** Absolute path to the note's canonical markdown content file. */
  contentPath?: string;
  /** Content type for icon display based on dominant content */
  contentType: NoteContentType;
  /** Absolute path to the original external .md file (only present for external notes) */
  externalFilePath?: string;
  /** Root directory for this external note's source tree (for boundary checks and link resolution) */
  externalRootPath?: string;
  /** Bounded text signal from already-cached note content metadata, used for lightweight related-note scoring. */
  contentSignalText?: string;

  // Pin state
  /** Whether the note is pinned to the top of the notes panel */
  pinned?: boolean;
  /** Unix timestamp (seconds) when the note was pinned, or null if unpinned */
  pinnedAt?: number | null;

  // Links (consolidated from noteLinksAtom)
  /** Outgoing and incoming note links */
  links: {
    /** Notes this note links to (outgoing wiki links) */
    outgoing: NoteLink[];
    /** Notes that link to this note (backlinks) */
    incoming: NoteLink[];
  };
}
