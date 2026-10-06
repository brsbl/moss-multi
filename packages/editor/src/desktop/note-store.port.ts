// ported-from: brsbl/moss@762abb777 (762abb7770714a49d912f6081384aabb958a7ea6)
//   packages/desktop/src/main/storage/note-store.ts (sha256 359f74f66a18151a35134645ec91612468ccb987e7e0687191ea163244055a0d)
//     249-273, 482-522, 567-575, 635-667, 747-870, 909-1033, 1087-1181, 1183-1422, 1424-1798, 2421-2560, 2583-2621,
//     3915-3973, 4027
//   packages/desktop/src/main/ipc-handlers.ts (sha256 b89bd07c5870b1d7f33c7be45fecc1efc3bf6bf202c7545131c0fffbc96c72e2)
//     1161-1191, 2532-2545
// The pure steps Moss desktop's main process applies to a note's files on read and on save. They live in Electron
// main-process modules that cannot be imported into a browser bundle, so the function bodies are copied verbatim.
// The only changes: types are loosened to plain records; a rest destructuring that drops keys becomes `delete`; `currentUnixSeconds()` reads `clock` (so tests can pin
// it); `agentSessionRegistry` is empty (a bb frame runs no Moss agent); file reads become text parameters; and
// `Buffer` byte work goes through TextEncoder/TextDecoder, which decode a cut sequence to U+FFFD as Buffer does.
/* eslint-disable @typescript-eslint/no-explicit-any -- verbatim ports over moss's own loose JSON shapes */
import { MOSS_CANVAS_FENCE_PATTERN_SOURCE } from '@moss-desktop/common/markdown-fences';
import { countMarkdownTables, extractLeadingH1, getMarkdownTabGroupShapes } from '@moss-desktop/common/markdown-utils';
import { hasLegacyCommentFooter, parseCommentFooter, splitFrontmatter, stripCommentAnchors } from '@moss-desktop/common/markdown-layers';
import { stripWikiLinks } from '@moss-desktop/common/utils';

export type NoteMetadataFile = { id: string; title: string; createdAt: number; updatedAt: number; stickyTabs: any[] } & Record<string, any>;
export type StickyTabMetadataFile = Record<string, any> & { id: string; status: string; createdAt: number };

export interface NoteLayoutMetadata {
  version: 1;
  tableCount: number;
  tables: { columnWidths?: number[] }[];
  tabGroupCount?: number;
  tabGroups?: { tabWidths?: (number | null)[]; panelLabels?: string[] }[];
}

/** Unix seconds; tests pin it. */
export const clock = { now: (): number => Math.floor(Date.now() / 1000) };
const currentUnixSeconds = (): number => clock.now();

// A bb frame runs no Moss agent, so no sticky tab has a live session (note-store.ts:1127).
const agentSessionRegistry: ReadonlySet<string> = new Set();

export const NOTES_FOLDER_NAME = 'Notes';
export const TRASH_FOLDER_NAME = 'Trash';
export const UNTITLED_NOTE_TITLE = 'Untitled';
const STICKY_TAB_RETENTION_SECONDS = 30 * 24 * 60 * 60; // 30 days
// eslint-disable-next-line no-control-regex -- Moss strips control characters
const INVALID_PATH_CHARACTERS = /[<>:"/\\|?*\u0000-\u001F]/g;
const MAX_FOLDER_NAME_BYTES = 252;

const encoder = new TextEncoder();
const decoder = new TextDecoder();
export const byteLength = (value: string): number => encoder.encode(value).length;

// note-store.ts:249-273, with POSIX path arithmetic on note-relative paths.
export const isNoteRelativeCompanionPath = (relativePath: string): boolean => {
  if (relativePath.length === 0 || relativePath.includes('\0') || relativePath.startsWith('/')) {
    return false;
  }
  if (relativePath.split(/[\\/]+/).includes('..')) {
    return false;
  }
  const segments = relativePath.split('/').filter((segment) => segment.length > 0 && segment !== '.');
  return segments.length > 0;
};

// note-store.ts:482-522
const NOTE_METADATA_FILE_FIELDS = new Set([
  'id',
  'userId',
  'title',
  'createdAt',
  'updatedAt',
  'stickyTabs',
  'folderPath',
  'frontmatterMeta',
  'frontmatterInference',
  'noteHierarchyCache',
  'previousFolderPath',
  'trashedAt',
  'lastOpenedAt',
  'contentType',
  'systemNoteType',
  'externalFilePath',
  'externalRootPath',
  'externalContentHash',
  'externalContentHashVersion',
  'externalFileIdentity',
  'nextCommentColorIndex',
  'commentColors',
  'collapsedHeadings',
  'pinned',
  'pinnedAt',
  'cacheHydrationState'
]);

export const preserveUnknownMetadataFields = (
  source: NoteMetadataFile,
  target: NoteMetadataFile
): NoteMetadataFile => {
  const next = target as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(source as unknown as Record<string, unknown>)) {
    if (!NOTE_METADATA_FILE_FIELDS.has(key) && value !== undefined) {
      next[key] = value;
    }
  }
  return target;
};

// note-store.ts:567-575
export const sanitizeTitle = (value: string): string => {
  const condensed = value.replace(/\s+/g, ' ').trim();

  if (condensed.length === 0) {
    throw new Error('Title must be a non-empty string');
  }

  return condensed;
};

// note-store.ts:635-667
const sanitizeFolderComponent = (value: string): string => {
  // Remove invalid path characters and normalize whitespace
  const sanitized = value.replace(INVALID_PATH_CHARACTERS, '').replace(/\s+/g, ' ').trim();

  // Defense-in-depth: reject path traversal sequences even though ensureWithinRoot
  // will catch them. This provides a clearer error message and early rejection.
  if (sanitized === '.' || sanitized === '..' || sanitized.includes('/') || sanitized.includes('\\')) {
    return '';
  }

  return sanitized;
};

const truncateToByteLimit = (value: string, maxBytes: number): string => {
  const encoded = encoder.encode(value);
  if (encoded.length <= maxBytes) return value;
  // Slice bytes and decode back — may produce a partial multi-byte char at the end
  const sliced = decoder.decode(encoded.subarray(0, maxBytes));
  // Drop any replacement character from a truncated multi-byte sequence
  return sliced.replace(/�+$/, '').trimEnd();
};

export const toFolderBaseName = (value: string): string => {
  const sanitized = sanitizeFolderComponent(value);
  if (sanitized.length === 0) return UNTITLED_NOTE_TITLE;
  const truncated = truncateToByteLimit(sanitized, MAX_FOLDER_NAME_BYTES);
  return truncated.length > 0 ? truncated : UNTITLED_NOTE_TITLE;
};

// note-store.ts:747-870
const FRONTMATTER_REGEX = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/;
const CHART_BLOCK_REGEX = /```moss-chart\b[\s\S]*?```/g;
const CANVAS_BLOCK_REGEX = new RegExp(
  '```(?:' + MOSS_CANVAS_FENCE_PATTERN_SOURCE + ')\\b[\\s\\S]*?```',
  'g'
);
const CODE_BLOCK_REGEX = new RegExp(
  '```(?!(?:moss-chart|' +
    MOSS_CANVAS_FENCE_PATTERN_SOURCE +
    ')\\b)[^\\n]*\\n[\\s\\S]*?```',
  'g'
);
const INDENTED_CODE_LINE_REGEX = /^(?: {4}|\t).+/gm;
const MARKDOWN_TABLE_SEPARATOR_REGEX = /^\s*\|?(?:\s*:?-{3,}:?\s*\|)+\s*:?-{3,}:?\s*$/gm;
const IMAGE_MARKDOWN_REGEX = /!\[[^\]]*\]\((?:[^()\n]|\\\(|\\\))*\)/g;
const EMPTY_NOTE_MAX_NON_EMPTY_LINES = 2;
const EMPTY_NOTE_MAX_TEXT_CHARS = 120;
const LARGE_NOTE_MIN_TEXT_CHARS = 2000;
const BLOCK_DOMINANCE_THRESHOLD = 0.6;

export const extractFirstH1TitleFromMarkdown = (markdown: string): string | undefined => {
  // Strip frontmatter first — extractLeadingH1 uses ^ anchor which fails
  // when the string starts with --- YAML block.
  const { body } = splitFrontmatter(markdown);
  const { h1Title } = extractLeadingH1(body);
  if (!h1Title) return undefined;
  const sanitized = stripWikiLinks(h1Title).trim();
  return sanitized.length > 0 ? sanitizeTitle(sanitized) : undefined;
};

const countMatches = (value: string, pattern: RegExp): number => {
  const matches = value.match(pattern);
  return matches ? matches.length : 0;
};

const stripFrontmatterAndFooter = (content: string): string => {
  let body = content.replace(FRONTMATTER_REGEX, '');
  if (hasLegacyCommentFooter(body)) {
    body = parseCommentFooter(body).strippedContent;
  }
  body = stripCommentAnchors(body);
  return body.trim();
};

export const splitMarkdownForEditorReadMigrations = (
  markdown: string
): { prefix: string; body: string; suffix: string } => {
  const frontmatter = splitFrontmatter(markdown);
  const frontmatterPrefix = frontmatter.hasFrontmatter
    ? markdown.slice(0, markdown.length - frontmatter.body.length)
    : '';
  const footerResult = hasLegacyCommentFooter(frontmatter.body)
    ? parseCommentFooter(frontmatter.body)
    : { strippedContent: frontmatter.body };
  const footerSuffix = frontmatter.body.slice(footerResult.strippedContent.length);
  const h1PrefixMatch = footerResult.strippedContent.match(/^#(?!#)[^\r\n]*(?:\r?\n|$)(?:\r?\n)*/);
  const h1Prefix = h1PrefixMatch?.[0] ?? '';

  return {
    prefix: `${frontmatterPrefix}${h1Prefix}`,
    body: footerResult.strippedContent.slice(h1Prefix.length),
    suffix: footerSuffix
  };
};

export const classifyNoteContentType = (content: string): string => {
  const body = stripFrontmatterAndFooter(content);
  if (body.length === 0) {
    return 'empty';
  }

  const chartBlocks = countMatches(body, CHART_BLOCK_REGEX);
  const canvasBlocks = countMatches(body, CANVAS_BLOCK_REGEX);
  const fencedCodeBlocks = countMatches(body, CODE_BLOCK_REGEX);
  const indentedCodeLines = countMatches(body, INDENTED_CODE_LINE_REGEX);
  const indentedCodeBlocks = indentedCodeLines > 0 ? Math.max(1, Math.floor(indentedCodeLines / 8)) : 0;
  const codeBlocks = fencedCodeBlocks + indentedCodeBlocks;
  const tableBlocks = countMatches(body, MARKDOWN_TABLE_SEPARATOR_REGEX);
  const imageBlocks = countMatches(body, IMAGE_MARKDOWN_REGEX);

  const blockTotal = chartBlocks + tableBlocks + canvasBlocks + codeBlocks + imageBlocks;
  if (blockTotal > 0) {
    const dominantType = [
      { type: 'code', count: codeBlocks },
      { type: 'charts', count: chartBlocks + tableBlocks },
      { type: 'images', count: imageBlocks },
      { type: 'media', count: canvasBlocks }
    ].sort((a, b) => b.count - a.count)[0];

    if (dominantType && dominantType.count / blockTotal >= BLOCK_DOMINANCE_THRESHOLD) {
      return dominantType.type;
    }
  }

  const textOnly = body
    .replace(CHART_BLOCK_REGEX, ' ')
    .replace(CANVAS_BLOCK_REGEX, ' ')
    .replace(CODE_BLOCK_REGEX, ' ')
    .replace(IMAGE_MARKDOWN_REGEX, ' ')
    .replace(/\[\[[^\]]+\]\]/g, ' ')
    .replace(/`[^`]+`/g, ' ')
    .replace(/\[[^\]]*\]\((?:[^()\n]|\\\(|\\\))*\)/g, ' ')
    .replace(/[>#*_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const textChars = textOnly.length;
  const nonEmptyLines = body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0).length;

  if (nonEmptyLines <= EMPTY_NOTE_MAX_NON_EMPTY_LINES && textChars <= EMPTY_NOTE_MAX_TEXT_CHARS) {
    return 'empty';
  }

  if (textChars >= LARGE_NOTE_MIN_TEXT_CHARS) {
    return 'large-text';
  }

  return 'medium-text';
};

// note-store.ts:909-1033
const MIGRATION_MANAGED_METADATA_FIELDS = [
  'stickyTabs',
  'frontmatterMeta',
  'frontmatterInference',
  'noteHierarchyCache',
  'nextCommentColorIndex',
  'commentColors',
  'collapsedHeadings'
];

const stripMigrationManagedMetadataFields = (metadata: NoteMetadataFile): NoteMetadataFile => {
  const base: Record<string, unknown> = { ...metadata };
  for (const key of MIGRATION_MANAGED_METADATA_FIELDS) delete base[key];
  return base as NoteMetadataFile;
};

type NoteMetadataReadMigration = (
  metadata: NoteMetadataFile,
  rawMetadata: NoteMetadataFile,
  context: { cleanupOrphanedTabs: boolean }
) => NoteMetadataFile;

const NOTE_METADATA_READ_MIGRATIONS: readonly NoteMetadataReadMigration[] = Object.freeze([
  (metadata, rawMetadata, context) => {
    const normalizedStickyTabs = normalizeStickyTabs(rawMetadata.stickyTabs, {
      cleanupOrphaned: context.cleanupOrphanedTabs
    });

    return {
      ...metadata,
      stickyTabs: normalizedStickyTabs
    };
  },
  (metadata, rawMetadata) => {
    const normalizedFrontmatterMeta = coerceFrontmatterMeta(rawMetadata.frontmatterMeta);
    const normalizedFrontmatterInference = coerceFrontmatterInference(rawMetadata.frontmatterInference);
    const normalizedHierarchyCache = coerceNoteHierarchyCache(rawMetadata.noteHierarchyCache);

    return {
      ...metadata,
      ...(normalizedFrontmatterMeta !== undefined ? { frontmatterMeta: normalizedFrontmatterMeta } : {}),
      ...(normalizedFrontmatterInference ? { frontmatterInference: normalizedFrontmatterInference } : {}),
      ...(normalizedHierarchyCache ? { noteHierarchyCache: normalizedHierarchyCache } : {})
    };
  },
  (metadata, rawMetadata) => {
    const rawColorIndex = rawMetadata.nextCommentColorIndex;
    const normalizedColorIndex =
      typeof rawColorIndex === 'number' &&
      Number.isFinite(rawColorIndex) &&
      rawColorIndex >= 0 &&
      Number.isInteger(rawColorIndex)
        ? rawColorIndex
        : undefined;

    const rawCommentColors = rawMetadata.commentColors;
    const normalizedCommentColors =
      rawCommentColors && typeof rawCommentColors === 'object' && !Array.isArray(rawCommentColors)
        ? (Object.fromEntries(
            Object.entries(rawCommentColors as Record<string, unknown>)
              .filter(([, v]) => typeof v === 'number' && Number.isInteger(v as number) && (v as number) >= 0)
          ) as Record<string, number>)
        : undefined;

    return {
      ...metadata,
      ...(normalizedColorIndex !== undefined ? { nextCommentColorIndex: normalizedColorIndex } : {}),
      ...(normalizedCommentColors !== undefined && Object.keys(normalizedCommentColors).length > 0
        ? { commentColors: normalizedCommentColors }
        : {}),
      ...(Array.isArray(rawMetadata.collapsedHeadings) &&
      rawMetadata.collapsedHeadings.every((h: unknown) => typeof h === 'string')
        ? { collapsedHeadings: rawMetadata.collapsedHeadings }
        : {})
    };
  }
]);

const applyNoteMetadataReadMigrations = (
  rawMetadata: NoteMetadataFile,
  options: { cleanupOrphanedTabs?: boolean }
): NoteMetadataFile => {
  const context = {
    cleanupOrphanedTabs: options.cleanupOrphanedTabs === true
  };

  let metadata = stripMigrationManagedMetadataFields(rawMetadata);

  for (const migration of NOTE_METADATA_READ_MIGRATIONS) {
    metadata = migration(metadata, rawMetadata, context);
  }

  return metadata;
};

/** `readMetadata(metaPath, { cleanupOrphanedTabs: true })` over the file's text, as `readNoteMetadata` calls it. */
export const readMetadataText = (contents: string): NoteMetadataFile | undefined => {
  try {
    const parsed = JSON.parse(contents) as NoteMetadataFile;

    if (!parsed.id || !parsed.title) {
      return undefined;
    }

    return applyNoteMetadataReadMigrations(parsed, { cleanupOrphanedTabs: true });
  } catch {
    return undefined;
  }
};

// note-store.ts:1087-1181
const applyActionTabRetention = (entries: StickyTabMetadataFile[]): StickyTabMetadataFile[] => {
  if (entries.length === 0) {
    return [];
  }

  const now = currentUnixSeconds();
  const cutoff = now - STICKY_TAB_RETENTION_SECONDS;
  const withinWindow = entries.filter((tab) => tab.createdAt >= cutoff);

  // If all tabs are expired, keep the most recent one
  const retainedHistory =
    withinWindow.length > 0
      ? withinWindow
      : entries.sort((a, b) => b.createdAt - a.createdAt).slice(0, 1);

  // Sort oldest first for consistent display order
  return retainedHistory.sort((a, b) => a.createdAt - b.createdAt);
};

const migrateActionTabs = (entries: StickyTabMetadataFile[]): StickyTabMetadataFile[] => {
  return entries.filter((tab) => tab.status !== 'draft');
};

const cleanupOrphanedAgentTabs = (entries: StickyTabMetadataFile[]): StickyTabMetadataFile[] => {
  const now = currentUnixSeconds();
  return entries.map((tab) => {
    // Only cleanup pending tabs that DON'T have an active session
    if (tab.status === 'pending' && !agentSessionRegistry.has(tab.id)) {
      return {
        ...tab,
        status: 'interrupted' as const,
        interruptReason: 'app-reload' as const,
        messages: [...(tab.messages ?? []), 'Agent stopped: App was closed'],
        completedAt: now
      };
    }
    return tab;
  });
};

export const normalizeStickyTabs = (
  value: unknown,
  options: { cleanupOrphaned?: boolean } = {}
): StickyTabMetadataFile[] => {
  if (!Array.isArray(value)) {
    return [];
  }

  const normalized: StickyTabMetadataFile[] = [];

  for (const entry of value) {
    const parsed = coerceActionTab(entry);
    if (parsed) {
      normalized.push(parsed);
    }
  }

  // Filter out draft tabs (migration from old pattern)
  const withoutDrafts = migrateActionTabs(normalized);

  // Cleanup orphaned pending tabs only during startup (when cleanupOrphaned is true).
  // After initialization, pending tabs are legitimate active sessions.
  const withOrphanedCleanup = options.cleanupOrphaned
    ? cleanupOrphanedAgentTabs(withoutDrafts)
    : withoutDrafts;

  return applyActionTabRetention(withOrphanedCleanup);
};

// note-store.ts:1183-1422
const coerceTodos = (value: unknown): any[] | undefined => {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const todos = value
    .map((entry) => {
      if (!entry || typeof entry !== 'object') {
        return null;
      }

      const { id, text, completed } = entry as Record<string, unknown>;
      if (typeof id !== 'string' || id.trim().length === 0) {
        return null;
      }

      if (typeof text !== 'string' || text.trim().length === 0) {
        return null;
      }

      return {
        id: id.trim(),
        text: text.trim(),
        completed: typeof completed === 'boolean' ? completed : false
      };
    })
    .filter((todo) => Boolean(todo));

  return todos.length > 0 ? todos : [];
};

const ACTION_CHANGE_TYPES: ReadonlyArray<string> = [
  'note_updated',
  'note_created',
  'created',
  'modified',
  'deleted'
];

const isChangeType = (value: unknown): value is string =>
  typeof value === 'string' && (ACTION_CHANGE_TYPES as ReadonlyArray<string>).includes(value);

const coerceChanges = (value: unknown): any[] | undefined => {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const changes = value
    .map((entry) => {
      if (!entry || typeof entry !== 'object') {
        return null;
      }

      const {
        type,
        noteTitle,
        description,
        path,
        additions,
        deletions
      } = entry as Record<string, unknown>;

      if (!isChangeType(type)) {
        return null;
      }

      if (type === 'note_updated' || type === 'note_created') {
        const change: Record<string, unknown> = { type };

        if (typeof noteTitle === 'string' && noteTitle.trim().length > 0) {
          change.noteTitle = noteTitle.trim();
        }

        if (typeof description === 'string' && description.trim().length > 0) {
          change.description = description.trim();
        }

        return change;
      }

      if (typeof path !== 'string' || path.trim().length === 0) {
        return null;
      }

      const fileChange: Record<string, unknown> = {
        type,
        path: path.trim()
      };

      if (typeof additions === 'number' && Number.isFinite(additions)) {
        fileChange.additions = additions;
      }

      if (typeof deletions === 'number' && Number.isFinite(deletions)) {
        fileChange.deletions = deletions;
      }

      return fileChange;
    })
    .filter((change) => Boolean(change));

  return changes.length > 0 ? changes : [];
};

const coercePromptMentions = (value: unknown): any[] | undefined => {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const mentions = value
    .map((entry) => {
      if (!entry || typeof entry !== 'object') {
        return null;
      }

      const { id, title, type } = entry as Record<string, unknown>;
      if (
        typeof id !== 'string' ||
        id.trim().length === 0 ||
        typeof title !== 'string' ||
        title.trim().length === 0 ||
        (type !== 'note' && type !== 'directory' && type !== 'folder')
      ) {
        return null;
      }

      return {
        id: id.trim(),
        title: title.trim(),
        type
      };
    })
    .filter((mention) => mention !== null);

  return mentions.length > 0 ? mentions : undefined;
};

const coerceImageUrls = (value: unknown): string[] | undefined => {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const urls = value.filter(
    (entry): entry is string => typeof entry === 'string' && entry.trim().length > 0
  );
  return urls.length > 0 ? urls : undefined;
};

const coerceTrigger = (value: unknown): 'agent' | undefined => {
  if (value === 'agent') {
    return value;
  }

  return undefined;
};

const coerceModel = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;

const coerceProfile = (value: unknown): string | undefined => {
  if (value === 'fast' || value === 'balanced' || value === 'quality') {
    return value;
  }
  return undefined;
};

const isFrontmatterFieldSource = (value: unknown): value is 'user' | 'inferred' | 'user-removed' =>
  value === 'user' || value === 'inferred' || value === 'user-removed';

export const coerceFrontmatterFieldMeta = (value: unknown): Record<string, any> | undefined => {
  if (!value || typeof value !== 'object') {
    return undefined;
  }

  const raw = value as Record<string, unknown>;
  const source = isFrontmatterFieldSource(raw.source) ? raw.source : undefined;
  const lastModified =
    typeof raw.lastModified === 'number' && Number.isFinite(raw.lastModified)
      ? raw.lastModified
      : undefined;

  if (!source || lastModified === undefined) {
    return undefined;
  }

  // Preserve the stale-inference lifecycle counter through the meta.json round-trip
  // (this coercion runs on BOTH the read-normalize and updateNote write paths). If
  // it were dropped, a recorded miss would read back as 0 and the two-pass age-out
  // (mergeFrontmatterInference) + frontmatterMetaRemovals would never trigger. Keep
  // only a finite, non-negative integer; treat anything else as absent.
  const missedInferenceCount =
    typeof raw.missedInferenceCount === 'number' &&
    Number.isInteger(raw.missedInferenceCount) &&
    raw.missedInferenceCount >= 0
      ? raw.missedInferenceCount
      : undefined;

  return {
    source,
    lastModified,
    ...(missedInferenceCount !== undefined ? { missedInferenceCount } : {})
  };
};

export const coerceFrontmatterMeta = (value: unknown): Record<string, any> | undefined => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }

  const raw = value as Record<string, unknown>;
  const metadata: Record<string, any> = {};

  for (const [field, fieldMeta] of Object.entries(raw)) {
    const normalizedField = field.trim();
    if (normalizedField.length === 0) {
      continue;
    }
    const parsedMeta = coerceFrontmatterFieldMeta(fieldMeta);
    if (parsedMeta) {
      metadata[normalizedField] = parsedMeta;
    }
  }

  return Object.keys(metadata).length > 0 ? metadata : {};
};

// note-store.ts:1424-1798
const coerceFrontmatterInference = (value: unknown): Record<string, any> | undefined => {
  if (!value || typeof value !== 'object') {
    return undefined;
  }

  const raw = value as Record<string, unknown>;
  const contentHash = typeof raw.contentHash === 'string' ? raw.contentHash.trim() : '';
  const updatedAt =
    typeof raw.updatedAt === 'number' && Number.isFinite(raw.updatedAt) ? raw.updatedAt : undefined;

  if (contentHash.length === 0 || updatedAt === undefined) {
    return undefined;
  }

  return { contentHash, updatedAt };
};

const coerceStringArray = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    : [];

const coerceStringRecord = (value: unknown): Record<string, string> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  const record: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry !== 'string') {
      continue;
    }
    const normalizedKey = key.trim();
    const normalizedValue = entry.trim();
    if (normalizedKey.length > 0 && normalizedValue.length > 0) {
      record[normalizedKey] = normalizedValue;
    }
  }
  return record;
};

const coerceNoteHierarchyCache = (value: unknown): Record<string, any> | undefined => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }

  const raw = value as Record<string, unknown>;
  const contentHash = typeof raw.contentHash === 'string' ? raw.contentHash.trim() : '';
  const updatedAt =
    typeof raw.updatedAt === 'number' && Number.isFinite(raw.updatedAt) ? raw.updatedAt : undefined;
  const blockHashes = coerceStringRecord(raw.blockHashes);

  if (contentHash.length === 0 || updatedAt === undefined) {
    return undefined;
  }

  const diffRaw = raw.changedBlocksDiff;
  const diffObject =
    diffRaw && typeof diffRaw === 'object' && !Array.isArray(diffRaw)
      ? (diffRaw as Record<string, unknown>)
      : undefined;
  if (!diffObject) {
    return undefined;
  }

  const changedBlocksDiff = {
    added: coerceStringArray(diffObject.added),
    removed: coerceStringArray(diffObject.removed),
    modified: coerceStringArray(diffObject.modified),
    unchanged: coerceStringArray(diffObject.unchanged)
  };

  const hierarchyRaw = raw.hierarchy;
  if (!hierarchyRaw || typeof hierarchyRaw !== 'object' || Array.isArray(hierarchyRaw)) {
    return undefined;
  }

  const hierarchy = hierarchyRaw as Record<string, any>;
  if (
    !Array.isArray(hierarchy.headings) ||
    !Array.isArray(hierarchy.nodeTypes) ||
    typeof hierarchy.wordCount !== 'number' ||
    !hierarchy.links ||
    typeof hierarchy.links !== 'object' ||
    !hierarchy.taskCount ||
    typeof hierarchy.taskCount !== 'object'
  ) {
    return undefined;
  }

  return {
    contentHash,
    updatedAt,
    blockHashes,
    changedBlocksDiff,
    hierarchy
  };
};

const coerceTiming = (value: unknown): Record<string, any> | undefined => {
  if (!value || typeof value !== 'object') {
    return undefined;
  }

  const raw = value as Record<string, unknown>;
  const startedAt =
    typeof raw.startedAt === 'number' && Number.isFinite(raw.startedAt) ? raw.startedAt : undefined;
  const firstTextAt =
    typeof raw.firstTextAt === 'number' && Number.isFinite(raw.firstTextAt) ? raw.firstTextAt : undefined;
  const lastTextAt =
    typeof raw.lastTextAt === 'number' && Number.isFinite(raw.lastTextAt) ? raw.lastTextAt : undefined;
  const firstToolStartAt =
    typeof raw.firstToolStartAt === 'number' && Number.isFinite(raw.firstToolStartAt) ? raw.firstToolStartAt : undefined;
  const firstEditorUpdateAt =
    typeof raw.firstEditorUpdateAt === 'number' && Number.isFinite(raw.firstEditorUpdateAt) ? raw.firstEditorUpdateAt : undefined;
  const lastToolEndAt =
    typeof raw.lastToolEndAt === 'number' && Number.isFinite(raw.lastToolEndAt) ? raw.lastToolEndAt : undefined;
  const completedAt =
    typeof raw.completedAt === 'number' && Number.isFinite(raw.completedAt) ? raw.completedAt : undefined;
  const persistedAt =
    typeof raw.persistedAt === 'number' && Number.isFinite(raw.persistedAt) ? raw.persistedAt : undefined;

  if (
    startedAt === undefined &&
    firstTextAt === undefined &&
    lastTextAt === undefined &&
    firstToolStartAt === undefined &&
    firstEditorUpdateAt === undefined &&
    lastToolEndAt === undefined &&
    completedAt === undefined &&
    persistedAt === undefined
  ) {
    return undefined;
  }

  return {
    startedAt,
    firstTextAt,
    lastTextAt,
    firstToolStartAt,
    firstEditorUpdateAt,
    lastToolEndAt,
    completedAt,
    persistedAt
  };
};

const coerceMetricNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

const coerceMetricBoolean = (value: unknown): boolean | undefined =>
  typeof value === 'boolean' ? value : undefined;

const coerceStageMetrics = (value: unknown): Record<string, any> | undefined => {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;

  const stage = {
    submitClickedAtMs: coerceMetricNumber(raw.submitClickedAtMs),
    preflightDoneAtMs: coerceMetricNumber(raw.preflightDoneAtMs),
    ipcExecuteSentAtMs: coerceMetricNumber(raw.ipcExecuteSentAtMs),
    mainExecuteStartedAtMs: coerceMetricNumber(raw.mainExecuteStartedAtMs),
    sdkQueryStartedAtMs: coerceMetricNumber(raw.sdkQueryStartedAtMs),
    firstStreamEventAtMs: coerceMetricNumber(raw.firstStreamEventAtMs),
    firstToolStartAtMs: coerceMetricNumber(raw.firstToolStartAtMs),
    firstTextAtMs: coerceMetricNumber(raw.firstTextAtMs),
    executionCompletedAtMs: coerceMetricNumber(raw.executionCompletedAtMs)
  };

  return Object.values(stage).some((entry) => entry !== undefined) ? stage : undefined;
};

const coerceSdkMetrics = (value: unknown): Record<string, any> | undefined => {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;

  const sdk = {
    durationMs: coerceMetricNumber(raw.durationMs),
    durationApiMs: coerceMetricNumber(raw.durationApiMs),
    numTurns: coerceMetricNumber(raw.numTurns),
    inputTokens: coerceMetricNumber(raw.inputTokens),
    outputTokens: coerceMetricNumber(raw.outputTokens),
    totalCostUsd: coerceMetricNumber(raw.totalCostUsd),
    cacheReadInputTokens: coerceMetricNumber(raw.cacheReadInputTokens),
    cacheCreationInputTokens: coerceMetricNumber(raw.cacheCreationInputTokens),
    editToolCalls: coerceMetricNumber(raw.editToolCalls)
  };

  return Object.values(sdk).some((entry) => entry !== undefined) ? sdk : undefined;
};

const coerceContextMetrics = (value: unknown): Record<string, any> | undefined => {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;

  const promptSource =
    raw.promptSource === 'prompt' || raw.promptSource === 'comment'
      ? raw.promptSource
      : undefined;
  const mode = raw.mode === 'prompt' ? raw.mode : undefined;

  const context = {
    promptChars: coerceMetricNumber(raw.promptChars),
    contentChars: coerceMetricNumber(raw.contentChars),
    referencedNotesCount: coerceMetricNumber(raw.referencedNotesCount),
    promptSource,
    mode,
    nonEmptyNoteAtStart: coerceMetricBoolean(raw.nonEmptyNoteAtStart)
  };

  return Object.values(context).some((entry) => entry !== undefined) ? context : undefined;
};

const coerceDerivedMetrics = (value: unknown): Record<string, any> | undefined => {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;

  const derived = {
    preflightMs: coerceMetricNumber(raw.preflightMs),
    ipcToSdkMs: coerceMetricNumber(raw.ipcToSdkMs),
    sdkToFirstEventMs: coerceMetricNumber(raw.sdkToFirstEventMs),
    sdkToFirstTextMs: coerceMetricNumber(raw.sdkToFirstTextMs),
    ttftMs: coerceMetricNumber(raw.ttftMs),
    endToEndMs: coerceMetricNumber(raw.endToEndMs),
    apiShare: coerceMetricNumber(raw.apiShare),
    cacheReuseRatio: coerceMetricNumber(raw.cacheReuseRatio),
    writeRateOnNonEmptyNote: coerceMetricNumber(raw.writeRateOnNonEmptyNote)
  };

  return Object.values(derived).some((entry) => entry !== undefined) ? derived : undefined;
};

const coerceMetrics = (value: unknown): Record<string, any> | undefined => {
  if (!value || typeof value !== 'object') {
    return undefined;
  }

  const raw = value as Record<string, unknown>;
  const stage = coerceStageMetrics(raw.stage);
  const sdk = coerceSdkMetrics(raw.sdk);
  const context = coerceContextMetrics(raw.context);
  const derived = coerceDerivedMetrics(raw.derived);

  if (!stage && !sdk && !context && !derived) {
    return undefined;
  }

  return { stage, sdk, context, derived };
};

const coerceMessages = (value: unknown): string[] | undefined => {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const messages = value.filter((item): item is string => typeof item === 'string' && item.length > 0);
  return messages.length > 0 ? messages : undefined;
};

const VALID_INTERRUPT_REASONS = ['trashed', 'user-cancelled', 'app-reload'] as const;
type InterruptReason = typeof VALID_INTERRUPT_REASONS[number];

const isValidInterruptReason = (value: unknown): value is InterruptReason =>
  typeof value === 'string' && (VALID_INTERRUPT_REASONS as readonly string[]).includes(value);

const coerceActionTab = (value: unknown): StickyTabMetadataFile | null => {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const {
    id,
    status,
    prompt,
    promptMentions,
    contextMentions,
    imageUrls,
    responseSummary,
    errorMessage,
    errorCode,
    errorClassification,
    errorRetryable,
    errorSeverity,
    createdAt,
    completedAt,
    todos,
    changes,
    trigger,
    messages,
    scratchPadContent,
    interruptReason,
    model,
    profile,
    timing,
    metrics,
    syntheticAck,
    sourceContextIconUrl,
    contentSnapshot
  } = value as Record<string, unknown>;

  if (typeof id !== 'string' || id.trim().length === 0) {
    return null;
  }

  // Accept 'draft' for backward compatibility during migration
  // It will be filtered out by migrateActionTabs
  if (
    status !== 'draft' &&
    status !== 'pending' &&
    status !== 'completed' &&
    status !== 'error' &&
    status !== 'interrupted'
  ) {
    return null;
  }

  const created = typeof createdAt === 'number' && Number.isFinite(createdAt) ? createdAt : currentUnixSeconds();
  const completed =
    typeof completedAt === 'number' && Number.isFinite(completedAt) ? completedAt : null;
  const normalizedTodos = coerceTodos(todos);
  const normalizedChanges = coerceChanges(changes);
  const normalizedPromptMentions = coercePromptMentions(promptMentions);
  const normalizedContextMentions = coercePromptMentions(contextMentions);
  const normalizedImageUrls = coerceImageUrls(imageUrls);
  const normalizedTrigger = coerceTrigger(trigger);
  const normalizedMessages = coerceMessages(messages);
  const normalizedModel = coerceModel(model);
  const normalizedProfile = coerceProfile(profile);
  const normalizedTiming = coerceTiming(timing);
  const normalizedMetrics = coerceMetrics(metrics);

  return {
    id: id.trim(),
    status,
    prompt: typeof prompt === 'string' ? prompt : null,
    promptMentions: normalizedPromptMentions,
    contextMentions: normalizedContextMentions,
    imageUrls: normalizedImageUrls,
    responseSummary: typeof responseSummary === 'string' ? responseSummary : null,
    errorMessage: typeof errorMessage === 'string' ? errorMessage : null,
    errorCode: typeof errorCode === 'string' ? errorCode : undefined,
    errorClassification:
      typeof errorClassification === 'string' ? errorClassification : undefined,
    errorRetryable: typeof errorRetryable === 'boolean' ? errorRetryable : undefined,
    errorSeverity:
      errorSeverity === 'neutral' || errorSeverity === 'error' ? errorSeverity : undefined,
    createdAt: created,
    completedAt: completed,
    todos: normalizedTodos,
    changes: normalizedChanges,
    trigger: normalizedTrigger,
    messages: normalizedMessages,
    scratchPadContent: typeof scratchPadContent === 'string' ? scratchPadContent : undefined,
    interruptReason: isValidInterruptReason(interruptReason) ? interruptReason : undefined,
    model: normalizedModel,
    profile: normalizedProfile,
    timing: normalizedTiming,
    metrics: normalizedMetrics,
    syntheticAck: typeof syntheticAck === 'string' && syntheticAck.length > 0 ? syntheticAck : undefined,
    sourceContextIconUrl:
      typeof sourceContextIconUrl === 'string' && sourceContextIconUrl.length > 0
        ? sourceContextIconUrl
        : undefined,
    contentSnapshot: typeof contentSnapshot === 'string' ? contentSnapshot : undefined
  };
};

// note-store.ts:2421-2560
export const coerceLayoutMetadata = (value: unknown): NoteLayoutMetadata | undefined => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  if (record.version !== 1) {
    return undefined;
  }

  const tableCount = record.tableCount;
  const tables = record.tables;
  if (
    typeof tableCount !== 'number' ||
    !Number.isInteger(tableCount) ||
    tableCount < 0 ||
    !Array.isArray(tables)
  ) {
    return undefined;
  }

  const normalizedTables: { columnWidths?: number[] }[] = tables.slice(0, tableCount).map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return {};
    }

    const widths = (entry as Record<string, unknown>).columnWidths;
    if (!Array.isArray(widths)) {
      return {};
    }

    const columnWidths = widths
      .map((width) => typeof width === 'number' ? Math.round(width) : Number.NaN)
      .filter((width) => Number.isFinite(width) && width > 0);
    return columnWidths.length > 0 ? { columnWidths } : {};
  });
  while (normalizedTables.length < tableCount) {
    normalizedTables.push({});
  }

  const normalized: NoteLayoutMetadata = {
    version: 1,
    tableCount,
    tables: normalizedTables
  };

  const tabGroupCount = record.tabGroupCount;
  const tabGroups = record.tabGroups;
  if (
    typeof tabGroupCount === 'number' &&
    Number.isInteger(tabGroupCount) &&
    tabGroupCount >= 0 &&
    Array.isArray(tabGroups)
  ) {
    const normalizedTabGroups: { tabWidths?: (number | null)[]; panelLabels?: string[] }[] = tabGroups.slice(0, tabGroupCount).map((entry) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        return {};
      }

      const panelLabels = (entry as Record<string, unknown>).panelLabels;
      const normalizedPanelLabels = Array.isArray(panelLabels)
        ? panelLabels.map((label) => typeof label === 'string' ? label : '')
        : undefined;
      const widths = (entry as Record<string, unknown>).tabWidths;
      if (!Array.isArray(widths)) {
        return normalizedPanelLabels ? { panelLabels: normalizedPanelLabels } : {};
      }

      const tabWidths = widths.map((width) => {
        if (typeof width !== 'number') {
          return null;
        }
        const rounded = Math.round(width);
        return Number.isFinite(rounded) && rounded > 0 ? rounded : null;
      });
      return tabWidths.some((width) => width !== null)
        ? {
            tabWidths,
            ...(normalizedPanelLabels ? { panelLabels: normalizedPanelLabels } : {})
          }
        : normalizedPanelLabels
          ? { panelLabels: normalizedPanelLabels }
          : {};
    });
    while (normalizedTabGroups.length < tabGroupCount) {
      normalizedTabGroups.push({});
    }

    normalized.tabGroupCount = tabGroupCount;
    normalized.tabGroups = normalizedTabGroups;
  }

  return normalized;
};

export const layoutMetadataHasWidths = (
  layoutMetadata: NoteLayoutMetadata | undefined
): boolean =>
  Boolean(
    layoutMetadata?.tables.some(
      (table) => Array.isArray(table.columnWidths) && table.columnWidths.length > 0
    ) ||
    layoutMetadata?.tabGroups?.some(
      (tabGroup) =>
        Array.isArray(tabGroup.tabWidths) &&
        tabGroup.tabWidths.some((width) => typeof width === 'number')
    )
  );

export const buildLayoutMetadataComparison = (
  layoutMetadata: NoteLayoutMetadata | undefined
): string => {
  if (!layoutMetadataHasWidths(layoutMetadata) || !layoutMetadata) {
    return '';
  }

  const tabGroups = (layoutMetadata.tabGroups ?? [])
    .map((tabGroup, index): [number, (number | null)[]] => [index, tabGroup.tabWidths ?? []])
    .filter(([, tabWidths]) => tabWidths.some((width) => typeof width === 'number'));

  return JSON.stringify({
    version: layoutMetadata.version,
    tableCount: layoutMetadata.tableCount,
    tables: layoutMetadata.tables.map((table) => table.columnWidths ?? []),
    tabGroups
  });
};

export const rebaseLayoutTablesForMarkdown = (
  layoutMetadata: NoteLayoutMetadata,
  content: string
): void => {
  const markdownTableCount = countMarkdownTables(content);
  if (markdownTableCount === layoutMetadata.tableCount) {
    return;
  }

  layoutMetadata.tableCount = markdownTableCount;
  layoutMetadata.tables = Array.from({ length: markdownTableCount }, () => ({}));
};

/** The tab-group half of `readLayoutMetadata` and of updateNote's preserve path (2595-2613, 10685-10702). */
export const rebaseLayoutTabGroupsForMarkdown = (layoutMetadata: NoteLayoutMetadata, content: string): void => {
  if (layoutMetadata.tabGroups !== undefined) {
    const tabGroupShapes = getMarkdownTabGroupShapes(content);
    if (tabGroupShapes.length !== layoutMetadata.tabGroupCount) {
      layoutMetadata.tabGroups = undefined;
      layoutMetadata.tabGroupCount = undefined;
    } else {
      layoutMetadata.tabGroups = layoutMetadata.tabGroups.map((tabGroup, index) => {
        const expectedLabels = tabGroupShapes[index]?.panelLabels ?? [];
        if (
          !Array.isArray(tabGroup.panelLabels) ||
          tabGroup.panelLabels.length !== expectedLabels.length ||
          tabGroup.panelLabels.some((label, labelIndex) => label !== expectedLabels[labelIndex])
        ) {
          return {};
        }
        return tabGroup;
      });
    }
  }
};

// note-store.ts:2562-2621 (`readLayoutSidecarRaw` and `readLayoutMetadata`) over the sidecar's text.
export const readLayoutMetadataText = (
  raw: string | null,
  content: string | undefined
): NoteLayoutMetadata | undefined => {
  if (raw === null) {
    return undefined;
  }
  let layoutMetadata: NoteLayoutMetadata | undefined;
  try {
    layoutMetadata = coerceLayoutMetadata(JSON.parse(raw));
  } catch {
    return undefined;
  }
  if (!layoutMetadata) {
    return undefined;
  }

  if (content !== undefined) {
    rebaseLayoutTablesForMarkdown(layoutMetadata, content);
    rebaseLayoutTabGroupsForMarkdown(layoutMetadata, content);

    if (!layoutMetadataHasWidths(layoutMetadata)) {
      return undefined;
    }
  }

  return layoutMetadata;
};

/** `writeLayoutMetadata`'s bytes (2623-2641): null means the sidecar is removed. */
export const serializeLayoutMetadata = (layoutMetadata: NoteLayoutMetadata | undefined): string | null => {
  const normalized = coerceLayoutMetadata(layoutMetadata);
  if (!layoutMetadataHasWidths(normalized)) {
    return null;
  }
  return JSON.stringify(normalized, null, 2);
};

// note-store.ts:3915-3973, with the resolved folder path supplied by the caller (`location.folderPath`).
export const normalizeFolderPathValue = (value?: string | null): string => {
  if (typeof value !== 'string') {
    return '';
  }

  return value
    .split(/[/\\]+/)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0)
    .join('/');
};

export const ensureMetadataFolderPath = (
  metadata: NoteMetadataFile,
  resolved: string
): NoteMetadataFile => {
  const existing = normalizeFolderPathValue(metadata.folderPath);
  if (existing === resolved) {
    if (metadata.folderPath === resolved) {
      return metadata;
    }
    return {
      ...metadata,
      folderPath: resolved
    };
  }

  return {
    ...metadata,
    folderPath: resolved
  };
};

/** `writeMetadata`'s bytes (4020-4031). */
export const serializeMetadata = (metadata: NoteMetadataFile, resolvedFolderPath: string): string => {
  const persistedMetadata: Record<string, unknown> = { ...ensureMetadataFolderPath(metadata, resolvedFolderPath) };
  delete persistedMetadata.cacheHydrationState;
  return JSON.stringify(persistedMetadata, null, 2);
};

// ipc-handlers.ts:1161-1191, 2532-2545
export const ALLOWED_COPY_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.mp4', '.webm', '.mov'];
const FILENAME_UNICODE_WHITESPACE = /[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/g;

export const getImageExtension = (mimeType: string): string => {
  const mimeToExt: Record<string, string> = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'image/svg+xml': '.svg',
    'video/mp4': '.mp4',
    'video/webm': '.webm',
    'video/quicktime': '.mov'
  };
  return mimeToExt[mimeType] || '.png';
};

const sanitizeFilename = (name: string): string => {
  // Remove path separators and other problematic characters
  const normalizedWhitespace = name
    .normalize('NFKC')
    .replace(FILENAME_UNICODE_WHITESPACE, ' ');
  // eslint-disable-next-line no-control-regex -- Moss strips control characters
  return normalizedWhitespace.replace(/[<>:"/\\|?*\u0000-\u001F]/g, '-').replace(/^\.+/, '');
};

/** Node's path.posix.extname for one path component. */
export const extnameOf = (path: string): string => {
  const name = path.slice(path.lastIndexOf('/') + 1);
  let startDot = -1;
  let preDotState = 0;
  for (let i = name.length - 1; i >= 0; i -= 1) {
    if (name[i] === '.') {
      if (startDot === -1) startDot = i;
      else if (preDotState !== 1) preDotState = 1;
    } else if (startDot !== -1) {
      preDotState = -1;
    }
  }
  if (startDot === -1 || preDotState === 0 || (preDotState === 1 && startDot === name.length - 1 && startDot === 1)) return '';
  return name.slice(startDot);
};
/** Node's path.posix.basename(name, ext) for one path component. */
const basenameOf = (path: string, ext: string): string => {
  const name = path.slice(path.lastIndexOf('/') + 1);
  return ext && name.endsWith(ext) && name !== ext ? name.slice(0, name.length - ext.length) : name;
};

export const buildImageFilename = (
  filename: string | undefined,
  extension: string,
  timestamp: number,
  uuid: string
): string => {
  const fallbackBase = 'image';
  const normalizedBase = filename
    ? sanitizeFilename(basenameOf(filename, extnameOf(filename)))
    : fallbackBase;
  const safeBase = normalizedBase.trim().length > 0 ? normalizedBase : fallbackBase;
  const isMockupAsset = safeBase.endsWith('-mockup');
  const baseName = isMockupAsset ? safeBase.slice(0, -'-mockup'.length) : safeBase;
  const uniqueId = uuid.slice(0, 8);
  return isMockupAsset
    ? `${baseName}-${timestamp}-${uniqueId}-mockup${extension}`
    : `${safeBase}-${timestamp}-${uniqueId}${extension}`;
};
