// What Moss desktop does with a note's files around its renderer, as one pure pipeline: the read (`getNote`:
// note-store.ts:6197-6247 with `readInternalMarkdownContent`, `applyEditorReadMigrations`,
// `readPersistedCommentMetadata` and `readLayoutMetadata`), the renderer's save decision (CanvasAreaContent.tsx
// `saveContent`, 2517-2885: the idempotent skip and the layout write rule), and the main-process save
// (`updateNote`, note-store.ts:10218-10787) for an internal note. The bytes it plans for each file are the bytes
// desktop writes; the host only moves them (contract.ts, MossNoteWrite).
import {
  assembleNote,
  buildCommentMetadataSignature,
  coerceCommentMetadataMap,
  disassembleNote,
  hasLegacyCommentFooter,
  parseCommentFooter,
  serializeCommentMetadata,
  type CommentMetadataMap,
} from '@moss-desktop/common/markdown-layers';
import { migrateLegacyCommentMarkersToModern } from '@moss-desktop/common/comment-markers';
import { runReadOnlyMarkdownMigrations } from '@moss-desktop/common/note-markdown-migrations';
import type {
  MossCompanionExpectation,
  MossCompanionVersion,
  MossFileOp,
  MossFolderRename,
  MossMetaIntents,
  MossMetaVersion,
  MossNoteFiles,
  MossNoteLocation,
  MossNoteVersion,
  MossNoteWrite,
} from '../contract';
import {
  NOTES_FOLDER_NAME,
  buildLayoutMetadataComparison,
  classifyNoteContentType,
  coerceFrontmatterMeta,
  coerceLayoutMetadata,
  extractFirstH1TitleFromMarkdown,
  isNoteRelativeCompanionPath,
  layoutMetadataHasWidths,
  preserveUnknownMetadataFields,
  readLayoutMetadataText,
  readMetadataText,
  rebaseLayoutTablesForMarkdown,
  rebaseLayoutTabGroupsForMarkdown,
  serializeLayoutMetadata,
  serializeMetadata,
  ensureMetadataFolderPath,
  splitMarkdownForEditorReadMigrations,
  toFolderBaseName,
  type NoteLayoutMetadata,
  type NoteMetadataFile,
} from './note-store.port';

export type { CommentMetadataMap, NoteLayoutMetadata, NoteMetadataFile };


/** One `bridge.read` result. */
export interface DiskNote {
  files: MossNoteFiles;
  location: MossNoteLocation;
  version: MossNoteVersion;
  metaVersion: MossMetaVersion;
}

/** A note as desktop's renderer receives it, plus the baselines its save compares against. */
export interface NoteRead {
  disk: DiskNote;
  /** Companion files the read migrations consumed, with the state each was in. */
  companions: MossCompanionExpectation[];
  /** `getNote`'s `content`: the markdown after the editor-read migrations. */
  content: string;
  commentMetadata: CommentMetadataMap;
  layoutMetadata: NoteLayoutMetadata | undefined;
  commentColors: Record<string, number> | undefined;
  /** meta.json `title`, or undefined when meta.json does not parse as desktop's readMetadata requires. */
  metaTitle: string | undefined;
  /** The renderer's `lastKnownDiskContentRef`: `content` without a legacy comment footer. */
  diskContent: string;
  diskCommentSignature: string;
  diskLayoutComparison: string;
}

export type CompanionReader = (relativePath: string) => Promise<{ text: string | null; version: MossCompanionVersion }>;

/** `applyEditorReadMigrations` (note-store.ts:3144-3169): a migration that throws leaves the markdown as read. */
export async function migrateForEditor(
  markdown: string,
  readCompanion: CompanionReader,
): Promise<{ content: string; companions: MossCompanionExpectation[]; error: unknown }> {
  const companions: MossCompanionExpectation[] = [];
  const migrationInput = splitMarkdownForEditorReadMigrations(markdown);
  try {
    const migrated = await runReadOnlyMarkdownMigrations(migrationInput.body, {
      readNoteRelativeFile: async (relativePath: string) => {
        // readNoteRelativeCompanionFile (3047-3069) returns null for a path outside the note folder, unread.
        if (!isNoteRelativeCompanionPath(relativePath)) return null;
        const read = await readCompanion(relativePath);
        companions.push({ relativePath, version: read.version });
        return read.text;
      },
      phase: 'editor-read',
    });
    if (migrated.markdown === migrationInput.body) return { content: markdown, companions, error: null };
    return { content: `${migrationInput.prefix}${migrated.markdown}${migrationInput.suffix}`, companions, error: null };
  } catch (error) {
    return { content: markdown, companions: [], error };
  }
}

/** `readPersistedCommentMetadata` (2776-2797) over comments.json's text. */
export function readCommentMetadata(sidecar: string | null, content: string): CommentMetadataMap {
  let sidecarMetadata: CommentMetadataMap | undefined;
  if (sidecar !== null) {
    try {
      sidecarMetadata = coerceCommentMetadataMap(JSON.parse(sidecar));
    } catch {
      sidecarMetadata = undefined;
    }
  }
  if (sidecarMetadata !== undefined) return sidecarMetadata;
  const footerResult = hasLegacyCommentFooter(content)
    ? parseCommentFooter(content)
    : { strippedContent: content, metadata: {} as CommentMetadataMap };
  return coerceCommentMetadataMap(footerResult.metadata);
}

/** The read for a given (already migrated) markdown: what getNote returns and the renderer's baselines. */
export function deriveRead(disk: DiskNote, content: string, companions: MossCompanionExpectation[]): NoteRead {
  const metadata = readMetadataText(disk.files.meta);
  const commentMetadata = readCommentMetadata(disk.files.comments, content);
  const layoutMetadata = readLayoutMetadataText(disk.files.layout, content);
  const diskContent = content.includes('<!--moss:comments') ? parseCommentFooter(content).strippedContent : content;
  return {
    disk,
    companions,
    content,
    commentMetadata,
    layoutMetadata,
    commentColors: metadata?.commentColors,
    metaTitle: metadata?.title,
    diskContent,
    diskCommentSignature: buildCommentMetadataSignature(commentMetadata),
    diskLayoutComparison: buildLayoutMetadataComparison(layoutMetadata),
  };
}

export async function readNote(disk: DiskNote, readCompanion: CompanionReader): Promise<NoteRead & { migrationError: unknown }> {
  const { content, companions, error } = await migrateForEditor(disk.files.markdown, readCompanion);
  return { ...deriveRead(disk, content, companions), migrationError: error };
}

/** What moss's renderer hands `notes.update` at a save, before its own idempotent check. */
export interface RendererSnapshot {
  /** `buildMarkdownForSave`: frontmatter, `# <title>` and the exported body. */
  content: string;
  /** `buildCommentMetadata(pruneCommentsWithoutAnchors(...))`. */
  commentMetadata: CommentMetadataMap;
  /** `$collectTableLayoutMetadata` plus `$collectTabGroupLayoutMetadata`. */
  layoutMetadata: NoteLayoutMetadata;
  intents: MossMetaIntents;
}

/** The final text of every note file after a save; `null` sidecars do not exist. */
export interface PlannedFiles {
  markdown: string;
  comments: string | null;
  layout: string | null;
  meta: string;
}

export type SavePlan =
  | { kind: 'skip' }
  | { kind: 'write'; write: MossNoteWrite; files: PlannedFiles; title: string };

export interface PlanOptions {
  /** Unix seconds, meta.json `updatedAt`. */
  now: number;
  /** Write even when the renderer's idempotent check finds nothing new (a restored draft's intents, Overwrite). */
  force?: boolean;
}

/**
 * One save. Mirrors desktop exactly: the renderer skips a save whose markdown, comment signature and layout match
 * the disk baseline; otherwise main rewrites meta.json and the content layers as below, and renames the folder when
 * the first H1 changed. Asset lifecycle (trashing unreferenced media) is not done (design §7).
 */
export function planSave(read: NoteRead, snapshot: RendererSnapshot, options: PlanOptions): SavePlan {
  const pendingContent = snapshot.content;
  const currentCommentSignature = buildCommentMetadataSignature(snapshot.commentMetadata);
  const currentLayoutComparison = buildLayoutMetadataComparison(snapshot.layoutMetadata);
  // CanvasAreaContent.tsx:2662-2675, the content-level idempotent skip.
  if (
    !options.force &&
    pendingContent === read.diskContent &&
    currentCommentSignature === read.diskCommentSignature &&
    currentLayoutComparison === read.diskLayoutComparison
  ) {
    return { kind: 'skip' };
  }

  // CanvasAreaContent.tsx:2588-2607: layout is sent only when this editor changed it; otherwise the baseline rides
  // as `expectedLayoutMetadata` when it has widths, which lets main preserve and rebase it.
  const hasLocalLayoutChanges = currentLayoutComparison !== read.diskLayoutComparison;
  const layoutMetadataForWrite = hasLocalLayoutChanges ? snapshot.layoutMetadata : undefined;
  const sendsExpectedLayout = hasLocalLayoutChanges || read.diskLayoutComparison !== '';

  // updateNote (note-store.ts:10241-10425) for an internal note with the renderer's input.
  const metadata = readMetadataText(read.disk.files.meta);
  if (!metadata) throw new Error('meta.json does not hold a note Moss can read');
  const resolvedFolderPath = read.disk.location.folderPath;
  const existing = ensureMetadataFolderPath(metadata, resolvedFolderPath);
  const updates: Record<string, unknown> = {};
  const nextCommentMetadata = coerceCommentMetadataMap(snapshot.commentMetadata);
  let contentToWrite = pendingContent;
  if (hasLegacyCommentFooter(contentToWrite)) {
    contentToWrite = parseCommentFooter(contentToWrite).strippedContent;
  }
  const markerMigration = migrateLegacyCommentMarkersToModern(contentToWrite);
  if (markerMigration.migrated) {
    contentToWrite = markerMigration.markdown;
  }
  const derivedTitle = extractFirstH1TitleFromMarkdown(contentToWrite);
  if (typeof derivedTitle === 'string' && derivedTitle !== existing.title) {
    updates.title = derivedTitle;
  }
  const frontmatterMetaUpdates = snapshot.intents.frontmatterMetaUpdates;
  if (Object.keys(frontmatterMetaUpdates).length > 0) {
    const parsedUpdates = coerceFrontmatterMeta(frontmatterMetaUpdates);
    if (parsedUpdates) {
      updates.frontmatterMeta = { ...(existing.frontmatterMeta ?? {}), ...parsedUpdates };
    }
  }
  const raw = snapshot.intents.commentColors;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    updates.commentColors = Object.fromEntries(
      Object.entries(raw).filter(([, v]) => typeof v === 'number' && Number.isInteger(v) && v >= 0),
    );
  }
  updates.updatedAt = options.now;
  const contentType = classifyNoteContentType(contentToWrite);

  const nextMetadata: NoteMetadataFile = preserveUnknownMetadataFields(existing, {
    id: existing.id,
    title: (updates.title as string | undefined) ?? existing.title,
    createdAt: existing.createdAt,
    updatedAt: (updates.updatedAt as number | undefined) ?? existing.updatedAt,
    stickyTabs: existing.stickyTabs,
    frontmatterMeta: updates.frontmatterMeta ?? existing.frontmatterMeta ?? {},
    ...(existing.frontmatterInference ? { frontmatterInference: existing.frontmatterInference } : {}),
    ...(existing.noteHierarchyCache ? { noteHierarchyCache: existing.noteHierarchyCache } : {}),
    folderPath: existing.folderPath ?? NOTES_FOLDER_NAME,
    trashedAt: existing.trashedAt ?? null,
    lastOpenedAt: existing.lastOpenedAt ?? null,
    contentType: contentType ?? 'empty',
    ...(existing.previousFolderPath ? { previousFolderPath: existing.previousFolderPath } : {}),
    ...(existing.systemNoteType ? { systemNoteType: existing.systemNoteType } : {}),
    ...(existing.externalFilePath ? { externalFilePath: existing.externalFilePath } : {}),
    ...(existing.externalRootPath ? { externalRootPath: existing.externalRootPath } : {}),
    ...(existing.externalContentHash ? { externalContentHash: existing.externalContentHash } : {}),
    ...(existing.externalContentHashVersion != null ? { externalContentHashVersion: existing.externalContentHashVersion } : {}),
    ...(existing.externalFileIdentity ? { externalFileIdentity: existing.externalFileIdentity } : {}),
    ...(existing.nextCommentColorIndex != null ? { nextCommentColorIndex: existing.nextCommentColorIndex } : {}),
    ...(((updates.commentColors as Record<string, number> | undefined) ?? existing.commentColors) != null
      ? { commentColors: (updates.commentColors as Record<string, number> | undefined) ?? existing.commentColors }
      : {}),
    ...(existing.collapsedHeadings != null ? { collapsedHeadings: existing.collapsedHeadings } : {}),
    ...(existing.pinned != null || existing.pinnedAt != null
      ? { pinned: existing.pinned ?? false, pinnedAt: existing.pinnedAt ?? null }
      : {}),
  });

  // 10636-10650: the folder follows the final H1.
  const finalContentTitle = extractFirstH1TitleFromMarkdown(contentToWrite);
  if (finalContentTitle) nextMetadata.title = finalContentTitle;
  const rename: MossFolderRename | null =
    nextMetadata.title !== existing.title ? { kind: 'renameFolder', desiredName: toFolderBaseName(nextMetadata.title) } : null;

  // 10751-10753, writeCommentSidecar (2840-2872): an empty map removes the sidecar.
  const comments = Object.keys(nextCommentMetadata).length === 0 ? null : serializeCommentMetadata(nextCommentMetadata);

  // 10755-10781: layout.json only when this editor changed it, or when content is written over a sidecar with widths.
  let layout: string | null | undefined;
  if (layoutMetadataForWrite !== undefined) {
    layout = serializeLayoutMetadata(coerceLayoutMetadata(layoutMetadataForWrite));
  } else if (sendsExpectedLayout) {
    const current = readLayoutMetadataText(read.disk.files.layout, read.content);
    if (layoutMetadataHasWidths(current)) {
      const preserved: NoteLayoutMetadata = { ...current! };
      rebaseLayoutTablesForMarkdown(preserved, contentToWrite);
      rebaseLayoutTabGroupsForMarkdown(preserved, contentToWrite);
      layout = serializeLayoutMetadata(preserved);
    }
  }

  const meta = serializeMetadata(nextMetadata, resolvedFolderPath);
  const { files: disk, location } = read.disk;
  const ops: MossFileOp[] = [];
  // ensureContentFile runs on every content save and moves a legacy name to `<folderName>.md`.
  if (contentToWrite !== disk.markdown || rename !== null || location.markdownName !== `${location.folderName}.md`) {
    ops.push({ kind: 'put', file: 'markdown', text: contentToWrite });
  }
  if (comments !== disk.comments) ops.push(comments === null ? { kind: 'delete', file: 'comments' } : { kind: 'put', file: 'comments', text: comments });
  const finalLayout = layout === undefined ? disk.layout : layout;
  if (finalLayout !== disk.layout) ops.push(finalLayout === null ? { kind: 'delete', file: 'layout' } : { kind: 'put', file: 'layout', text: finalLayout });
  ops.push({ kind: 'put', file: 'meta', text: meta });

  return {
    kind: 'write',
    title: nextMetadata.title,
    write: { baseVersion: read.disk.version, baseMetaVersion: read.disk.metaVersion, companions: read.companions, rename, ops },
    files: { markdown: contentToWrite, comments, layout: finalLayout, meta },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// The renderer's layers (CanvasAreaContent.tsx at the pin, desktop's behaviour without moss-multi's seams): what
// the title field and the body show for a note, and the markdown `buildMarkdownForSave` assembles from them.
// ---------------------------------------------------------------------------------------------------------------

// CanvasAreaContent.tsx:708-752 and 806-809.
const stableStringifyUnknown = (value: unknown): string => {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringifyUnknown(item)).join(',')}]`;
  }

  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringifyUnknown(record[key])}`).join(',')}}`;
  }

  return JSON.stringify(value);
};

const buildFrontmatterSignature = (data: Record<string, unknown> | null): string | null => {
  if (!data) {
    return null;
  }
  return stableStringifyUnknown(data);
};

const extractFrontmatterRawBlock = (rawMarkdown: string, splitResult: { hasFrontmatter: boolean; body: string }): string | null => {
  if (!splitResult.hasFrontmatter) {
    return null;
  }
  const rawBlockLength = rawMarkdown.length - splitResult.body.length;
  if (rawBlockLength <= 0) {
    return null;
  }
  const rawBlock = rawMarkdown.slice(0, rawBlockLength);
  return rawBlock.startsWith('---') ? rawBlock : null;
};

const normalizeTitleDisplayValue = (rawTitle: string | null | undefined): string => {
  const trimmed = (rawTitle ?? '').trim();
  return trimmed === 'Untitled' ? '' : trimmed;
};

export interface FrontmatterSnapshot {
  signature: string | null;
  rawBlock: string | null;
  preserveWhenDataNull: boolean;
}

/** One note as the editor shows it. */
export interface EditorContent {
  /** The title field's text: the leading H1, else meta.json `title` ('' for "Untitled"). */
  title: string;
  frontmatter: Record<string, unknown> | null;
  frontmatterSnapshot: FrontmatterSnapshot;
  /** The body markdown moss's MarkdownEditor imports: no frontmatter, footer or leading H1. */
  body: string;
  commentMetadata: CommentMetadataMap;
  commentColors: Record<string, number> | undefined;
  layoutMetadata: NoteLayoutMetadata | undefined;
}

/** hydrateFetchedNoteRecord (1515-1611): a note's markdown and layers as the title field and the body take them. */
export function editorContentOf(
  rawContent: string,
  commentMetadata: CommentMetadataMap,
  layoutMetadata: NoteLayoutMetadata | undefined,
  commentColors: Record<string, number> | undefined,
  metaTitle: string | undefined,
): EditorContent {
  const layers = disassembleNote(rawContent);
  const split = { data: layers.frontmatter, body: layers.bodyAfterFrontmatter, hasFrontmatter: layers.rawYaml !== undefined };
  return {
    title: normalizeTitleDisplayValue(layers.h1Title ?? metaTitle),
    frontmatter: layers.frontmatter,
    frontmatterSnapshot: {
      signature: buildFrontmatterSignature(split.data),
      rawBlock: extractFrontmatterRawBlock(rawContent, split),
      preserveWhenDataNull: split.hasFrontmatter && split.data === null,
    },
    body: layers.body,
    commentMetadata,
    commentColors,
    layoutMetadata,
  };
}

export function editorContentOfRead(read: NoteRead): EditorContent {
  return editorContentOf(read.content, read.commentMetadata, read.layoutMetadata, read.commentColors, read.metaTitle);
}

/** A draft's or receipt's files as the editor shows them. */
export function editorContentOfFiles(
  files: { markdown: string; comments: string | null; layout: string | null },
  commentColors: Record<string, number> | undefined,
  metaTitle: string | undefined,
): EditorContent {
  const commentMetadata = readCommentMetadata(files.comments, files.markdown);
  return editorContentOf(files.markdown, commentMetadata, readLayoutMetadataText(files.layout, files.markdown), commentColors, metaTitle);
}

/** buildMarkdownForSave (2273-2306): the frontmatter (its raw block while unchanged), `# <title>`, then the body. */
export function assembleContent(
  content: Pick<EditorContent, 'frontmatter' | 'frontmatterSnapshot'>,
  live: { title: string; body: string },
): string {
  const fmData = content.frontmatter;
  const snapshot = content.frontmatterSnapshot;
  const currentSignature = buildFrontmatterSignature(fmData);
  return assembleNote({
    frontmatter: fmData,
    rawFrontmatterBlock:
      snapshot.rawBlock &&
      ((fmData !== null && snapshot.signature === currentSignature) || (fmData === null && snapshot.preserveWhenDataNull))
        ? snapshot.rawBlock
        : null,
    h1Title: live.title.trim() || 'Untitled',
    body: live.body,
  });
}
