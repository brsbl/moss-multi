// ported-from: brsbl/moss@762abb777 (762abb7770714a49d912f6081384aabb958a7ea6), test-only reference.
//   packages/desktop/src/main/storage/note-store.ts (sha256 359f74f66a18151a35134645ec91612468ccb987e7e0687191ea163244055a0d)
//     1818-1862 (persistFile), 2583-2641, 2734-2797, 2840-2872, 3047-3069, 3144-3169, 3430-3470, 4020-4031,
//     4990-5038, 5040-5114, 5116-5178, 6197-6247 (getNote), 10218-10787 (updateNote)
//   packages/desktop/src/renderer/panels/CanvasAreaContent.tsx (sha256 85427cb6185bec85cc3f7beb39311719621833a17419063488d5b0fc031883cd)
//     1515-1556 (hydrateFetchedNoteRecord's baselines), 2517-2675 and 2855-2885 (saveContent's update input)
// Moss desktop's own save path, for the golden tests: what the renderer reads, what it sends to `notes.update`,
// and what `updateNote` writes, run against a MemoryVolume. The function bodies are copied verbatim from the
// lines above. The only changes: the filesystem is the injected volume; caches, locks, telemetry, backlinks,
// external-note branches and the asset lifecycle (which the editor does not reproduce, design §7) are left out;
// and the pure helpers come from note-store.port.ts, itself a verbatim copy.
import { basename, dirname, join } from 'node:path';
import {
  buildCommentMetadataSignature,
  coerceCommentMetadataMap,
  hasLegacyCommentFooter,
  parseCommentFooter,
  serializeCommentMetadata,
  type CommentMetadataMap,
} from '@moss-desktop/common/markdown-layers';
import { migrateLegacyCommentMarkersToModern } from '@moss-desktop/common/comment-markers';
import { runReadOnlyMarkdownMigrations } from '@moss-desktop/common/note-markdown-migrations';
import { createDesktopRef } from '../host/moss-desktop.ref';
import {
  NOTES_FOLDER_NAME,
  buildLayoutMetadataComparison,
  classifyNoteContentType,
  coerceFrontmatterMeta,
  coerceLayoutMetadata,
  ensureMetadataFolderPath,
  extractFirstH1TitleFromMarkdown,
  isNoteRelativeCompanionPath,
  layoutMetadataHasWidths,
  preserveUnknownMetadataFields,
  readLayoutMetadataText,
  readMetadataText,
  rebaseLayoutTablesForMarkdown,
  rebaseLayoutTabGroupsForMarkdown,
  splitMarkdownForEditorReadMigrations,
  toFolderBaseName,
  type NoteLayoutMetadata,
  type NoteMetadataFile,
} from './note-store.port';

export interface Volume {
  caseInsensitive: boolean;
  exists(path: string): boolean;
  isFile(path: string): boolean;
  readFile(path: string): string;
  mtimeMs(path: string): number;
  writeFile(path: string, data: string): void;
  rename(from: string, to: string): void;
  unlink(path: string): void;
  readdir(dir: string): Array<{ name: string; isFile: boolean }>;
}

/** What the renderer holds when it saves: the editor's state, before CanvasAreaContent builds the update. */
export interface RendererState {
  pendingContent: string;
  currentCommentMetadata: CommentMetadataMap;
  currentLayoutMetadata: NoteLayoutMetadata;
  commentColorsSnapshot: Record<string, number>;
  frontmatterMetaUpdatesSnapshot: Record<string, unknown>;
}

export function createDesktopSave(volume: Volume, workspaceRoot = '/Moss') {
  const activeNotesRoot = `${workspaceRoot}/Notes`;
  const refFs = {
    exists: (path: string) => volume.exists(path),
    readdir: (dir: string) => volume.readdir(dir).map((entry) => ({ name: entry.name, isFile: () => entry.isFile })),
    mtimeMs: (path: string) => volume.mtimeMs(path),
    readFile: (path: string) => volume.readFile(path),
  };
  const ref = createDesktopRef(refFs, { workspaceRoot, activeNotesRoot });
  let uuid = 0;

  const readFile = async (path: string): Promise<string> => volume.readFile(path);
  const rm = async (path: string): Promise<void> => {
    if (volume.isFile(path)) volume.unlink(path);
  };
  const persistFile = async (filePath: string, payload: string): Promise<void> => {
    const tempPath = join(dirname(filePath), `.${basename(filePath)}.${(uuid += 1)}.tmp`);
    volume.writeFile(tempPath, payload);
    volume.rename(tempPath, filePath);
  };

  // getNoteDirectory (4990-5038), scanning every folder under Notes for the id.
  const getNoteDirectory = async (noteId: string): Promise<{ dirPath: string; folderName: string }> => {
    const normalized = noteId.trim();
    const scan = (dir: string): { dirPath: string; folderName: string } | undefined => {
      for (const entry of volume.readdir(dir)) {
        if (entry.isFile) continue;
        const dirPath = join(dir, entry.name);
        const metaPath = join(dirPath, 'meta.json');
        if (volume.isFile(metaPath)) {
          try {
            if (JSON.parse(volume.readFile(metaPath)).id === normalized) return { dirPath, folderName: entry.name };
          } catch {
            // unreadable: not this note
          }
        }
        const nested = scan(dirPath);
        if (nested) return nested;
      }
      return undefined;
    };
    const found = scan(activeNotesRoot);
    if (found) return found;
    throw new Error(`Note ${noteId} not found on disk`);
  };

  const readNoteMetadata = async (noteId: string) => {
    const location = await getNoteDirectory(noteId);
    const metaPath = join(location.dirPath, 'meta.json');
    const parsed = volume.isFile(metaPath) ? readMetadataText(volume.readFile(metaPath)) : undefined;
    const metadata = parsed ? ensureMetadataFolderPath(parsed, ref.resolveFolderPathForDirectory(location.dirPath)) : undefined;
    if (!metadata) return undefined;
    return { metadata, dirPath: location.dirPath, folderName: location.folderName };
  };

  // readNoteRelativeCompanionFile (3047-3069), confined to the note folder.
  const readNoteRelativeCompanionFile = async (noteDirPath: string, relativePath: string): Promise<string | null> => {
    if (!isNoteRelativeCompanionPath(relativePath)) {
      return null;
    }
    const absolute = join(noteDirPath, relativePath);
    if (!volume.isFile(absolute)) {
      return null;
    }
    return volume.readFile(absolute);
  };

  const applyEditorReadMigrations = async (markdown: string, noteDirPath: string): Promise<string> => {
    const migrationInput = splitMarkdownForEditorReadMigrations(markdown);
    try {
      const migrated = await runReadOnlyMarkdownMigrations(
        migrationInput.body,
        {
          readNoteRelativeFile: (relativePath) => readNoteRelativeCompanionFile(noteDirPath, relativePath),
          phase: 'editor-read'
        }
      );
      if (migrated.markdown === migrationInput.body) {
        return markdown;
      }
      return `${migrationInput.prefix}${migrated.markdown}${migrationInput.suffix}`;
    } catch {
      return markdown;
    }
  };

  const readInternalMarkdownContent = async (noteId: string, dirPath: string, folderName: string) => {
    const contentPath = await ref.resolveContentPathForRead(dirPath, folderName, noteId);
    if (!contentPath) return { content: undefined, contentPath: undefined };
    const content = await readFile(contentPath);
    return { content: await applyEditorReadMigrations(content, dirname(contentPath)), contentPath };
  };

  const readCommentSidecar = async (dirPath: string): Promise<CommentMetadataMap | undefined> => {
    try {
      const raw = await readFile(join(dirPath, 'comments.json'));
      return coerceCommentMetadataMap(JSON.parse(raw));
    } catch {
      return undefined;
    }
  };

  const readPersistedCommentMetadata = async (dirPath: string, content: string): Promise<CommentMetadataMap> => {
    const sidecarMetadata = await readCommentSidecar(dirPath);
    if (sidecarMetadata !== undefined) {
      return sidecarMetadata;
    }

    const footerResult = hasLegacyCommentFooter(content)
      ? parseCommentFooter(content)
      : { strippedContent: content, metadata: {} as CommentMetadataMap };
    const commentMetadata = coerceCommentMetadataMap(footerResult.metadata);
    return commentMetadata;
  };

  const readLayoutMetadata = async (dirPath: string, content: string | undefined): Promise<NoteLayoutMetadata | undefined> => {
    const path = join(dirPath, 'layout.json');
    return readLayoutMetadataText(volume.isFile(path) ? volume.readFile(path) : null, content);
  };

  const writeLayoutMetadata = async (dirPath: string, layoutMetadata: NoteLayoutMetadata | undefined): Promise<void> => {
    const sidecarPath = join(dirPath, 'layout.json');
    const normalized = coerceLayoutMetadata(layoutMetadata);
    if (!layoutMetadataHasWidths(normalized)) {
      await rm(sidecarPath);
      return;
    }

    await persistFile(sidecarPath, JSON.stringify(normalized, null, 2));
  };

  const writeCommentSidecar = async (dirPath: string, commentMetadata: CommentMetadataMap): Promise<void> => {
    const sidecarPath = join(dirPath, 'comments.json');
    const normalizedMetadata = coerceCommentMetadataMap(commentMetadata);
    if (Object.keys(normalizedMetadata).length === 0) {
      await rm(sidecarPath);
      return;
    }

    await persistFile(sidecarPath, serializeCommentMetadata(normalizedMetadata));
  };

  const writeMetadata = async (metaPath: string, metadata: NoteMetadataFile, dirPath: string): Promise<void> => {
    const normalizedMetadata = ensureMetadataFolderPath(metadata, ref.resolveFolderPathForDirectory(dirPath));
    const { cacheHydrationState: _cacheHydrationState, ...persistedMetadata } = normalizedMetadata;
    await persistFile(metaPath, JSON.stringify(persistedMetadata, null, 2));
  };

  const ensureContentFile = async (dirPath: string, folderName: string, payload: string, noteId: string): Promise<string> => {
    const normalizedName = folderName.trim();
    const preferredContentPath = join(dirPath, `${normalizedName.length > 0 ? normalizedName : 'Untitled'}.md`);
    const existingContentPath = await ref.resolveContentPathForRead(dirPath, folderName, noteId);
    const contentPath = existingContentPath ?? preferredContentPath;

    if (existingContentPath && existingContentPath !== preferredContentPath) {
      // Write new content to preferred path FIRST, then remove old file.
      // This ensures the new content is always on disk at the canonical
      // path before the old path is cleaned up.
      await persistFile(preferredContentPath, payload);
      try {
        volume.unlink(existingContentPath);
      } catch {
        // Old file cleanup is best-effort
      }
      return preferredContentPath;
    }

    await persistFile(contentPath, payload);
    return contentPath;
  };

  const renameNoteFolder = async (noteId: string, nextTitle: string): Promise<void> => {
    const baseName = toFolderBaseName(nextTitle);
    const { dirPath: currentDir, folderName: currentFolderName } = await getNoteDirectory(noteId);
    const currentParentDir = dirname(currentDir);
    const { folderName: desiredFolderName, dirPath: desiredDir } = await ref.allocateFolder(baseName, {
      noteId,
      targetRoot: currentParentDir
    });

    if (currentFolderName === desiredFolderName && currentDir === desiredDir) {
      return;
    }

    if (currentDir !== desiredDir) {
      volume.rename(currentDir, desiredDir);
    }
  };

  /** getNote (6197-6247), editor read mode. */
  const getNote = async (noteId: string) => {
    const result = await readNoteMetadata(noteId);
    if (!result) return undefined;
    const { metadata, dirPath, folderName } = result;
    const markdownResult = await readInternalMarkdownContent(noteId, dirPath, folderName);
    if (markdownResult.content === undefined) return undefined;
    const content = markdownResult.content;
    const commentMetadata = await readPersistedCommentMetadata(dirPath, content);
    const layoutMetadata = await readLayoutMetadata(dirPath, content);
    return { content, commentMetadata, layoutMetadata, commentColors: metadata.commentColors as Record<string, number> | undefined };
  };

  /** updateNote (10218-10787) for an internal note. */
  const updateNote = async (noteId: string, input: Record<string, any>): Promise<void> => { // eslint-disable-line @typescript-eslint/no-explicit-any
    const normalizedNoteId = noteId.trim();
    const existing = await readNoteMetadata(normalizedNoteId);
    if (!existing) {
      return undefined;
    }

    const { metadata } = existing;
    const updates: Partial<NoteMetadataFile> = {};
    let shouldWriteContent = false;
    let contentToWrite = '';
    let nextCommentMetadata =
      input.commentMetadata !== undefined
        ? coerceCommentMetadataMap(input.commentMetadata)
        : undefined;
    const nextLayoutMetadata =
      input.layoutMetadata !== undefined
        ? coerceLayoutMetadata(input.layoutMetadata)
        : undefined;

    if (typeof input.content === 'string') {
      shouldWriteContent = true;
      contentToWrite = input.content;
      if (hasLegacyCommentFooter(contentToWrite)) {
        const footerResult = parseCommentFooter(contentToWrite);
        contentToWrite = footerResult.strippedContent;
        if (nextCommentMetadata === undefined) {
          nextCommentMetadata = coerceCommentMetadataMap(footerResult.metadata);
        }
      }
      const markerMigration = migrateLegacyCommentMarkersToModern(contentToWrite);
      if (markerMigration.migrated) {
        contentToWrite = markerMigration.markdown;
      }
    }

    if (updates.title === undefined && shouldWriteContent) {
      const derivedTitle = extractFirstH1TitleFromMarkdown(contentToWrite);
      if (typeof derivedTitle === 'string' && derivedTitle !== metadata.title) {
        updates.title = derivedTitle;
      }
    }

    if (input.frontmatterMetaUpdates && typeof input.frontmatterMetaUpdates === 'object') {
      const parsedUpdates = coerceFrontmatterMeta(input.frontmatterMetaUpdates);
      if (parsedUpdates) {
        updates.frontmatterMeta = {
          ...(metadata.frontmatterMeta ?? {}),
          ...parsedUpdates
        };
      }
    }

    if ('commentColors' in input) {
      const raw = input.commentColors;
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        updates.commentColors = Object.fromEntries(
          Object.entries(raw).filter(([, v]) => typeof v === 'number' && Number.isInteger(v) && v >= 0)
        );
      }
    }

    const updatedAt = input.updatedAt;
    updates.updatedAt = updatedAt;
    let { dirPath, folderName } = await getNoteDirectory(normalizedNoteId);

    let contentType = metadata.contentType;
    if (shouldWriteContent) {
      contentType = classifyNoteContentType(contentToWrite);
    }

    const nextMetadata: NoteMetadataFile = preserveUnknownMetadataFields(metadata, {
      id: metadata.id,
      title: updates.title ?? metadata.title,
      createdAt: metadata.createdAt,
      updatedAt: updates.updatedAt ?? metadata.updatedAt,
      stickyTabs: updates.stickyTabs ?? metadata.stickyTabs,
      frontmatterMeta: updates.frontmatterMeta ?? metadata.frontmatterMeta ?? {},
      ...(updates.frontmatterInference !== undefined
        ? (updates.frontmatterInference ? { frontmatterInference: updates.frontmatterInference } : {})
        : metadata.frontmatterInference
          ? { frontmatterInference: metadata.frontmatterInference }
          : {}),
      ...(updates.noteHierarchyCache
        ? { noteHierarchyCache: updates.noteHierarchyCache }
        : metadata.noteHierarchyCache
          ? { noteHierarchyCache: metadata.noteHierarchyCache }
          : {}),
      folderPath: metadata.folderPath ?? NOTES_FOLDER_NAME,
      trashedAt:
        'trashedAt' in updates ? updates.trashedAt ?? null : metadata.trashedAt ?? null,
      lastOpenedAt:
        'lastOpenedAt' in updates
          ? updates.lastOpenedAt ?? null
          : metadata.lastOpenedAt ?? null,
      contentType: contentType ?? 'empty',
      ...(metadata.previousFolderPath ? { previousFolderPath: metadata.previousFolderPath } : {}),
      ...(metadata.systemNoteType ? { systemNoteType: metadata.systemNoteType } : {}),
      ...(metadata.externalFilePath ? { externalFilePath: metadata.externalFilePath } : {}),
      ...(metadata.externalRootPath ? { externalRootPath: metadata.externalRootPath } : {}),
      ...(metadata.externalContentHash ? { externalContentHash: metadata.externalContentHash } : {}),
      ...(metadata.externalContentHashVersion != null
        ? { externalContentHashVersion: metadata.externalContentHashVersion }
        : {}),
      ...(metadata.externalFileIdentity
        ? { externalFileIdentity: metadata.externalFileIdentity }
        : {}),
      ...((updates.nextCommentColorIndex ?? metadata.nextCommentColorIndex) != null
        ? { nextCommentColorIndex: updates.nextCommentColorIndex ?? metadata.nextCommentColorIndex }
        : {}),
      ...((updates.commentColors ?? metadata.commentColors) != null
        ? { commentColors: updates.commentColors ?? metadata.commentColors }
        : {}),
      ...((updates.collapsedHeadings ?? metadata.collapsedHeadings) != null
        ? { collapsedHeadings: updates.collapsedHeadings ?? metadata.collapsedHeadings }
        : {}),
      ...('pinned' in updates || metadata.pinned != null || metadata.pinnedAt != null
        ? {
            pinned: ('pinned' in updates ? updates.pinned : metadata.pinned) ?? false,
            pinnedAt: 'pinnedAt' in updates ? updates.pinnedAt ?? null : metadata.pinnedAt ?? null,
          }
        : {})
    });

    let currentDiskContent: string | undefined;
    let currentLayoutMetadataForPreserve: NoteLayoutMetadata | undefined;
    const internalRead = await readInternalMarkdownContent(normalizedNoteId, dirPath, folderName);
    currentDiskContent = internalRead.content;
    if (currentDiskContent === undefined) {
      throw new Error('Unable to verify note content on disk before saving. Reload and try again.');
    }
    if (typeof input.expectedDiskContent === 'string' && currentDiskContent !== input.expectedDiskContent) {
      throw new Error('Note content changed on disk. Reload and merge before saving.');
    }
    const currentDiskCommentMetadata = await readPersistedCommentMetadata(dirPath, currentDiskContent);
    if (
      input.expectedCommentMetadata !== undefined &&
      buildCommentMetadataSignature(currentDiskCommentMetadata) !== buildCommentMetadataSignature(coerceCommentMetadataMap(input.expectedCommentMetadata))
    ) {
      throw new Error('Note content changed on disk. Reload and merge before saving.');
    }

    if ('expectedLayoutMetadata' in input) {
      const currentLayoutMetadata = await readLayoutMetadata(dirPath, currentDiskContent);
      currentLayoutMetadataForPreserve = currentLayoutMetadata;
    }

    const finalContentTitle = extractFirstH1TitleFromMarkdown(contentToWrite);
    if (typeof input.title !== 'string' && finalContentTitle) {
      nextMetadata.title = finalContentTitle;
    }
    if (nextMetadata.title !== metadata.title) {
      await renameNoteFolder(normalizedNoteId, nextMetadata.title);
      ({ dirPath, folderName } = await getNoteDirectory(normalizedNoteId));
    }

    if (shouldWriteContent) {
      await ensureContentFile(dirPath, folderName, contentToWrite, normalizedNoteId);
    }

    if (nextCommentMetadata !== undefined) {
      await writeCommentSidecar(dirPath, nextCommentMetadata);
    }

    if (input.layoutMetadata !== undefined) {
      await writeLayoutMetadata(dirPath, nextLayoutMetadata);
    } else if (
      shouldWriteContent &&
      'expectedLayoutMetadata' in input &&
      layoutMetadataHasWidths(currentLayoutMetadataForPreserve)
    ) {
      const preserved: NoteLayoutMetadata = { ...currentLayoutMetadataForPreserve! };
      rebaseLayoutTablesForMarkdown(preserved, contentToWrite);
      rebaseLayoutTabGroupsForMarkdown(preserved, contentToWrite);
      await writeLayoutMetadata(dirPath, preserved);
    }

    await writeMetadata(join(dirPath, 'meta.json'), nextMetadata, dirPath);
  };

  /**
   * The renderer side: the baselines hydrateFetchedNoteRecord keeps from getNote (1531-1556), then saveContent's
   * idempotent skip (2662-2675) and its `notes.update` input (2588-2607, 2855-2885). Returns false when it skips.
   */
  const save = async (
    noteId: string,
    record: NonNullable<Awaited<ReturnType<typeof getNote>>>,
    state: RendererState,
    timestamp: number
  ): Promise<boolean> => {
    const rawContent = record.content ?? '';
    const { strippedContent } = rawContent.includes('<!--moss:comments')
      ? parseCommentFooter(rawContent)
      : { strippedContent: rawContent };
    const lastKnownDiskContent = strippedContent;
    const diskCommentMetadata = record.commentMetadata;
    const lastKnownDiskCommentSignature = buildCommentMetadataSignature(diskCommentMetadata);
    const baselineLayoutMetadata = record.layoutMetadata;
    const baselineLayoutComparison = buildLayoutMetadataComparison(record.layoutMetadata);

    const { pendingContent, currentCommentMetadata, currentLayoutMetadata } = state;
    const currentCommentSignature = buildCommentMetadataSignature(currentCommentMetadata);
    const currentLayoutComparison = buildLayoutMetadataComparison(currentLayoutMetadata);
    const hasLocalLayoutChanges = currentLayoutComparison !== baselineLayoutComparison;
    const layoutMetadataForWrite: NoteLayoutMetadata | undefined =
      hasLocalLayoutChanges ? currentLayoutMetadata : undefined;
    const expectedLayoutMetadataForWrite: NoteLayoutMetadata | null | undefined =
      hasLocalLayoutChanges
        ? baselineLayoutMetadata ?? null
        : baselineLayoutComparison !== ''
          ? baselineLayoutMetadata ?? null
          : undefined;

    if (
      pendingContent === lastKnownDiskContent &&
      currentCommentSignature === lastKnownDiskCommentSignature &&
      currentLayoutComparison === baselineLayoutComparison
    ) {
      return false;
    }
    const frontmatterMetaUpdatesSnapshot = state.frontmatterMetaUpdatesSnapshot;
    const hasFrontmatterMetaUpdates = Object.keys(frontmatterMetaUpdatesSnapshot).length > 0;
    await updateNote(noteId, {
      content: pendingContent,
      expectedDiskContent: lastKnownDiskContent,
      commentMetadata: currentCommentMetadata,
      expectedCommentMetadata: diskCommentMetadata,
      ...(layoutMetadataForWrite !== undefined
        ? {
            layoutMetadata: layoutMetadataForWrite,
            expectedLayoutMetadata: expectedLayoutMetadataForWrite ?? null
          }
        : expectedLayoutMetadataForWrite !== undefined
        ? {
            expectedLayoutMetadata: expectedLayoutMetadataForWrite
          }
        : {}),
      updatedAt: timestamp,
      ...(hasFrontmatterMetaUpdates
        ? { frontmatterMetaUpdates: frontmatterMetaUpdatesSnapshot }
        : {}),
      commentColors: state.commentColorsSnapshot
    });
    return true;
  };

  return { getNote, updateNote, save };
}
