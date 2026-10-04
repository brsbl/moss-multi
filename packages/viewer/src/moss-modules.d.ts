// Vendored moss modules the viewer imports through its aliases, declared so the viewer's typecheck stops at the
// vendor boundary as apps/web's does (moss's own tsconfig checks moss upstream).
declare module '@moss-desktop/renderer/editor/plugins/code-block/prism-setup' {}

declare module '@moss-desktop/renderer/editor/MarkdownEditor' {
  import type { ComponentType } from 'react';
  import type { LexicalEditor } from 'lexical';
  import type { NoteLayoutMetadata } from '@moss-desktop/common/noteTypes';
  export const MarkdownEditor: ComponentType<{
    noteId: string;
    value: string;
    layoutMetadata?: NoteLayoutMetadata;
    onChange: (...args: never[]) => void;
    placeholder?: string;
    readOnly?: boolean;
    initialSerializedState?: object | null;
    onReady?: (editor: LexicalEditor) => void;
    onNavigateToNote?: (noteId: string, heading?: string | null) => void;
    enableSearchPlugin?: boolean;
  }>;
}

declare module '@moss/shared/components/layout/CanvasArea' {
  import type { ReactNode } from 'react';
  export function CanvasArea(props: {
    className?: string;
    children?: ReactNode;
    contentClassName?: string;
    innerClassName?: string;
    responsiveLayout?: boolean;
  }): ReactNode;
}

declare module '@moss/shared/state/note-atoms' {
  import type { PrimitiveAtom } from 'jotai';
  export function noteEntityAtom(noteId: string): PrimitiveAtom<object | null>;
  export const noteIdsAtom: PrimitiveAtom<Set<string>>;
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

declare module '@moss-desktop/common/noteTypes' {
  export interface NoteLayoutMetadata {
    version: 1;
    tableCount: number;
    tables: { columnWidths?: number[] }[];
    tabGroupCount?: number;
    tabGroups?: { tabWidths?: (number | null)[]; panelLabels?: string[] }[];
  }
}

declare module '@moss-desktop/common/markdown-layers' {
  export function splitFrontmatter(raw: string): { data: Record<string, unknown> | null; body: string };
  export function disassembleNote(raw: string): {
    frontmatter: Record<string, unknown> | null;
    h1Title: string | null;
    body: string;
  };
}

declare module '@moss-desktop/common/utils' {
  export function stripWikiLinks(text: string): string;
}

declare module '@moss-desktop/renderer/editor/utils/video-url' {
  export function isLocalVideoPath(text: string): boolean;
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

// moss's own asset-url module, which the viewer's substitute wraps (vite.config.ts).
declare module '@moss-pristine/asset-url' {
  export const REMOTE_URL_PATTERN: RegExp;
  export function normalizeLocalAssetPathForDisplay(src: string): string;
  export function toDisplaySrc(src: string, noteId?: string | null): string;
  export function fromDisplaySrc(src: string, currentNoteId?: string | null): string;
}
