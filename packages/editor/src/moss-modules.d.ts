// Vendored moss modules the editor imports through its aliases, declared so the editor's typecheck stops at the
// vendor boundary as apps/web's and the viewer's do (moss's own tsconfig checks moss upstream).
declare module '@moss-desktop/renderer/editor/plugins/code-block/prism-setup' {}

declare module '@moss-desktop/common/noteTypes' {
  export interface NoteLayoutMetadata {
    version: 1;
    tableCount: number;
    tables: { columnWidths?: number[] }[];
    tabGroupCount?: number;
    tabGroups?: { tabWidths?: (number | null)[]; panelLabels?: string[] }[];
  }
}

declare module '@moss-desktop/renderer/editor/MarkdownEditor' {
  import type { ForwardRefExoticComponent, RefAttributes } from 'react';
  import type { LexicalEditor } from 'lexical';
  import type { Transformer } from '@lexical/markdown';
  import type { NoteLayoutMetadata } from '@moss-desktop/common/noteTypes';
  import type { CommentMetadataMap } from '@moss-desktop/common/markdown-layers';
  export interface MarkdownEditorHandle {
    updateContentFromMarkdown(
      markdown: string,
      options?: { clearHistory?: boolean; scrollContainer?: HTMLElement | null; commentMetadata?: CommentMetadataMap; layoutMetadata?: NoteLayoutMetadata },
    ): { success: boolean };
  }
  export const MarkdownEditor: ForwardRefExoticComponent<
    {
      noteId: string;
      value: string;
      layoutMetadata?: NoteLayoutMetadata;
      onChange: (...args: never[]) => void;
      placeholder?: string;
      readOnly?: boolean;
      onReady?: (editor: LexicalEditor) => void;
      onNavigateToNote?: (noteId: string, heading?: string | null) => void;
      enableSearchPlugin?: boolean;
      editorMountVersion?: number;
    } & RefAttributes<MarkdownEditorHandle>
  >;
  export const MARKDOWN_EDITOR_TRANSFORMERS: Transformer[];
  export function unescapeHtmlEntities(markdown: string): string;
  export function $collectTableLayoutMetadata(): NoteLayoutMetadata;
  export function $collectTabGroupLayoutMetadata(): Pick<NoteLayoutMetadata, 'tabGroupCount' | 'tabGroups'>;
}

declare module '@moss/shared/components/layout/CanvasArea' {
  import type { ReactNode, RefObject } from 'react';
  export function CanvasArea(props: {
    className?: string;
    children?: ReactNode;
    contentClassName?: string;
    innerClassName?: string;
    responsiveLayout?: boolean;
    scrollContainerRef?: RefObject<HTMLDivElement | null>;
  }): ReactNode;
}

declare module '@moss/shared/state/note-atoms' {
  import type { PrimitiveAtom } from 'jotai';
  export interface NoteComment {
    id: string;
    text: string;
    createdAt: number;
    updatedAt: number;
    source?: 'user' | 'agent' | 'external';
    color?: number;
    parentId?: string;
    imageUrl?: string;
    imageUrls?: string[];
    resolvedAt?: number;
    resolvedBy?: 'user' | 'agent' | 'external';
  }
  export function noteEntityAtom(noteId: string): PrimitiveAtom<object | null>;
  export const noteIdsAtom: PrimitiveAtom<Set<string>>;
  export function noteCommentsMapAtom(noteId: string): PrimitiveAtom<Record<string, NoteComment>>;
  export function commentDirtySignalAtom(noteId: string): PrimitiveAtom<number>;
}

declare module '@moss/shared/state/atoms' {
  import type { PrimitiveAtom } from 'jotai';
  export interface WebBrowserTarget {
    url: string;
    title: string;
    sourceNoteId?: string;
  }
  export const browserSplitTargetAtom: PrimitiveAtom<WebBrowserTarget | null>;
  export const webEmbedLightboxTargetAtom: PrimitiveAtom<WebBrowserTarget | null>;
  export const splitTabNoteIdAtom: PrimitiveAtom<string | null>;
  export function mapNoteMetadataToNoteEntity(record: {
    id: string;
    title: string;
    createdAt: number;
    updatedAt?: number;
    folderPath?: string;
  }): object;
}

declare module '@moss-desktop/common/markdown-layers' {
  export interface CommentMetadata {
    text: string;
    createdAt: number;
    updatedAt: number;
    source?: 'user' | 'agent' | 'external';
    parentId?: string;
    imageUrl?: string;
    imageUrls?: string[];
    resolvedAt?: number;
    resolvedBy?: 'user' | 'agent' | 'external';
  }
  export type CommentMetadataMap = Record<string, CommentMetadata>;
  export function splitFrontmatter(raw: string): { data: Record<string, unknown> | null; body: string; hasFrontmatter: boolean; rawYaml?: string };
  export function disassembleNote(raw: string): {
    frontmatter: Record<string, unknown> | null;
    rawYaml?: string;
    bodyAfterFrontmatter: string;
    h1Title: string | null;
    body: string;
    comments: CommentMetadataMap;
  };
  export function assembleNote(layers: {
    frontmatter?: Record<string, unknown> | null;
    rawFrontmatterBlock?: string | null;
    h1Title?: string | null;
    body: string;
  }): string;
  export function coerceCommentMetadataMap(value: unknown): CommentMetadataMap;
  export function serializeCommentMetadata(metadata: CommentMetadataMap): string;
  export function buildCommentMetadataSignature(metadata: CommentMetadataMap): string;
  export function hasLegacyCommentFooter(markdown: string): boolean;
  export function parseCommentFooter(markdown: string): { strippedContent: string; metadata: CommentMetadataMap };
  export function stripCommentAnchors(markdown: string): string;
  export function extractCommentAnchorIds(markdown: string): Set<string>;
  export function collectReachableCommentThreadIds(anchorIds: Iterable<string>, commentsMap: Record<string, object | undefined>): Set<string>;
}

declare module '@moss-desktop/common/comment-markers' {
  export function migrateLegacyCommentMarkersToModern(markdown: string): { markdown: string; migrated: boolean };
}

declare module '@moss-desktop/common/markdown-utils' {
  export function extractLeadingH1(markdown: string): { h1Title: string | null; body: string };
  export function countMarkdownTables(markdown: string): number;
  export function getMarkdownTabGroupShapes(markdown: string): { panelLabels: string[] }[];
}

declare module '@moss-desktop/common/markdown-fences' {
  export const MOSS_CANVAS_FENCE_PATTERN_SOURCE: string;
}

declare module '@moss-desktop/common/note-markdown-migrations' {
  export function runReadOnlyMarkdownMigrations(
    markdown: string,
    context: { readNoteRelativeFile(relativePath: string): Promise<string | null>; phase: 'editor-read' | 'asset-reference-scan' },
  ): Promise<{ markdown: string; warnings: string[] }>;
}

declare module '@moss-desktop/common/utils' {
  export function stripWikiLinks(text: string): string;
}

declare module '@moss-desktop/renderer/editor/utils/markdown-export' {
  export function stripTableColumnWidthComments(markdown: string): string;
}

declare module '@moss-desktop/renderer/editor/utils/comment-export' {
  import type { CommentMetadataMap } from '@moss-desktop/common/markdown-layers';
  export function buildCommentMetadata(commentsMap: Record<string, { text: string; createdAt: number; updatedAt: number }>): CommentMetadataMap;
}

declare module '@moss-desktop/renderer/editor/utils/comment-import' {
  import type { CommentMetadataMap } from '@moss-desktop/common/markdown-layers';
  import type { NoteComment } from '@moss/shared/state/note-atoms';
  export function hydrateComments(map: CommentMetadataMap, storedColors?: Record<string, number>): Record<string, NoteComment>;
}

declare module '@moss-desktop/renderer/editor/utils/decoratorDraftRegistry' {
  export function flushDecoratorDrafts(editorId?: string): void;
}

declare module '@moss-desktop/renderer/editor/utils/editorUpdateTags' {
  export const DIRTY_TRACKER_IGNORED_TAGS: ReadonlySet<string>;
  export const DIRTY_TRACKER_CONTENT_TAGS: ReadonlySet<string>;
  export function hasTrackedEditorUpdateTag(tags: Set<string>, trackedTags: ReadonlySet<string>): boolean;
}

declare module '@moss-desktop/common/web-embed-preview' {
  export interface WebEmbedPreviewDescriptor {
    normalizedUrl: string;
    urlHash: string;
    cacheKey: string;
  }
  export function getWebEmbedPreviewDescriptor(url: string): WebEmbedPreviewDescriptor | null;
  export function createWebEmbedPreviewResult(input: {
    descriptor: WebEmbedPreviewDescriptor;
    status: 'resolved' | 'fallback' | 'failed';
    assetRelativePath?: string;
    metadata?: Record<string, string | number | boolean | null>;
  }): object;
}

// moss's own asset-url module, which the editor's substitute wraps (vite.config.ts).
declare module '@moss-pristine/asset-url' {
  export const REMOTE_URL_PATTERN: RegExp;
  export function normalizeLocalAssetPathForDisplay(src: string): string;
  export function toDisplaySrc(src: string, noteId?: string | null): string;
  export function fromDisplaySrc(src: string, currentNoteId?: string | null): string;
}
