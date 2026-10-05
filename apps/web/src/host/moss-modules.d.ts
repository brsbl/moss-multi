// Vendored moss modules the host imports through vite's @moss-desktop alias. Declared here so apps/web's
// typecheck stops at the vendor boundary: moss's own tsconfig checks moss upstream, and the vendor tree stays
// byte-identical (A§2.1).
declare module '@moss-desktop/renderer/editor/plugins/code-block/prism-setup' {}

declare module '@moss-desktop/renderer/App' {
  import type { ComponentType } from 'react';
  const App: ComponentType;
  export default App;
}

declare module '@moss-desktop/renderer/error-analytics' {
  export function installRendererErrorAnalytics(): void;
}

declare module '@moss-desktop/renderer/PdfExportApp' {
  import type { ComponentType } from 'react';
  const PdfExportApp: ComponentType;
  export default PdfExportApp;
}

declare module '@moss-desktop/renderer/editor/utils/note-link-clipboard' {
  export interface MossNoteLinkClipboardPayload {
    noteId: string;
    noteTitle: string;
    wikiLink: string;
  }
  export function buildCopyNoteLinkClipboardData(input: {
    noteId: string;
    noteTitle: string;
    folderPath?: string | null;
    filesystemPath?: string | null;
    headingText?: string | null;
  }): { payload: MossNoteLinkClipboardPayload; plainText: string };
  export function buildMossNoteLinkClipboardHtml(payload: MossNoteLinkClipboardPayload): string;
}

declare module '@moss-desktop/renderer/editor/utils/editorUpdateTags' {
  export const DIRTY_TRACKER_DERIVED_TAGS: ReadonlySet<string>;
}

// Moss's note and split atoms, as the one-doc-per-tab unit test drives them (A§10.1).
declare module '@moss/shared/state/atoms' {
  import type { WritableAtom } from 'jotai';
  export const syncNoteEntityAtom: WritableAtom<null, [{ noteId: string; updates: { title?: string; updatedAt?: number } }], void>;
  export const activeNoteIdAtom: WritableAtom<string | null, [string | null], void>;
  export const activeFolderPathAtom: WritableAtom<string, [string], void>;
  export const revealFolderPathAtom: WritableAtom<null, [string | null | undefined], void>;
  export const hydrateNotesAtom: WritableAtom<null, [], Promise<void>>;
  export const splitTabNoteIdAtom: WritableAtom<string | null, [string | null], void>;
  export const openSplitTabAtom: WritableAtom<null, [string], void>;
  export const splitNavigateToNoteAtom: WritableAtom<null, [string], void>;
  export const splitGoBackAtom: WritableAtom<null, [], void>;
  export const splitGoForwardAtom: WritableAtom<null, [], void>;
}

declare module '@moss/shared/state/note-atoms' {
  import type { PrimitiveAtom } from 'jotai';
  export function noteEntityAtom(noteId: string): PrimitiveAtom<object | null>;
  export function noteFrontmatterAtom(noteId: string): PrimitiveAtom<Record<string, unknown> | null>;
  export function frontmatterDirtySignalAtom(noteId: string): PrimitiveAtom<number>;
  export const noteIdsAtom: PrimitiveAtom<Set<string>>;
}

// @lexical/react 0.48.0's collaboration plugin, vendored with moss-multi seams (A§10.2), through vite's alias.
declare module '@moss-multi/lexical-react/LexicalCollaborationPlugin' {
  import type { ExcludedProperties, Provider, SyncCursorPositionsFn } from '@lexical/yjs';
  import type { JSX, RefObject } from 'react';
  import type { Doc } from 'yjs';
  export function CollaborationPlugin(props: {
    id: string;
    providerFactory: (id: string, yjsDocMap: Map<string, Doc>) => Provider;
    shouldBootstrap: boolean;
    username?: string;
    cursorColor?: string;
    cursorsContainerRef?: RefObject<HTMLElement | null>;
    excludedProperties?: ExcludedProperties;
    awarenessData?: object;
    syncCursorPositionsFn?: SyncCursorPositionsFn;
  }): JSX.Element;
}

// moss's DS primitives the host surfaces compose (T0.10), typed as moss declares them.
declare module '@moss/shared/components/ui/button' {
  import type { ButtonHTMLAttributes, ForwardRefExoticComponent, RefAttributes } from 'react';
  export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
    variant?: 'default' | 'danger' | 'secondary' | 'outline' | 'ghost' | 'link' | 'stop' | null;
    size?: 'default' | 'sm' | 'lg' | 'icon' | null;
    asChild?: boolean;
  }
  export const Button: ForwardRefExoticComponent<ButtonProps & RefAttributes<HTMLButtonElement>>;
}

declare module '@moss/shared/components/ui/card' {
  import type { ForwardRefExoticComponent, HTMLAttributes, RefAttributes } from 'react';
  export const Card: ForwardRefExoticComponent<HTMLAttributes<HTMLDivElement> & RefAttributes<HTMLDivElement>>;
}

declare module '@moss/shared/components/ui/dropdown-menu' {
  import type { ComponentType, HTMLAttributes, ButtonHTMLAttributes, ReactNode } from 'react';
  export const DropdownMenu: ComponentType<{ children: ReactNode }>;
  export const DropdownMenuTrigger: ComponentType<ButtonHTMLAttributes<HTMLButtonElement> & { asChild?: boolean }>;
  export const DropdownMenuContent: ComponentType<HTMLAttributes<HTMLDivElement> & { align?: 'start' | 'center' | 'end' }>;
  export const DropdownMenuItem: ComponentType<HTMLAttributes<HTMLDivElement> & { onSelect?: () => void }>;
  export const DropdownMenuSeparator: ComponentType<HTMLAttributes<HTMLDivElement>>;
}

// The notes list's context-menu item, which the folder "Share…" slot renders (T2.4).
declare module '@moss/shared/components/ui/context-menu' {
  import type { ComponentType, HTMLAttributes } from 'react';
  export const ContextMenuItem: ComponentType<HTMLAttributes<HTMLDivElement> & { onSelect?: () => void }>;
}

declare module '@moss/shared/components/ui/context-menu' {
  import type { ComponentType, ForwardRefExoticComponent, HTMLAttributes, ReactElement, ReactNode, RefAttributes } from 'react';
  export const ContextMenu: ComponentType<{ children: ReactNode }>;
  export const ContextMenuTrigger: ForwardRefExoticComponent<{ render?: ReactElement } & RefAttributes<HTMLElement>>;
  export const ContextMenuContent: ComponentType<HTMLAttributes<HTMLDivElement> & { onCloseAutoFocus?: (event: Event) => void }>;
  export const ContextMenuItem: ComponentType<HTMLAttributes<HTMLDivElement> & { disabled?: boolean; onSelect?: (event: Event) => void }>;
}

declare module '@moss/shared/components/ui/input' {
  import type { ComponentProps, ForwardRefExoticComponent } from 'react';
  export const Input: ForwardRefExoticComponent<ComponentProps<'input'>>;
}

declare module '@moss/shared/components/ui/label' {
  import type { ForwardRefExoticComponent, LabelHTMLAttributes, RefAttributes } from 'react';
  export const Label: ForwardRefExoticComponent<LabelHTMLAttributes<HTMLLabelElement> & RefAttributes<HTMLLabelElement>>;
}

// moss's modal frame (Settings' shell), which the Share dialog (T1.1) is built in.
declare module '@moss-desktop/renderer/components/ModalShell' {
  import type { ComponentType, ReactNode } from 'react';
  export const ModalShell: ComponentType<{
    open: boolean;
    onOpenChange: (open: boolean) => void;
    title: string;
    description: string;
    footer?: ReactNode;
    children: ReactNode;
  }>;
}

declare module '@moss-desktop/common/markdown-layers' {
  export function splitFrontmatter(text: string): { data: Record<string, unknown> | null };
}

declare module '@moss/shared/components/ui/confirmation-dialog' {
  import type { ComponentType, ReactNode } from 'react';
  export const ConfirmationDialog: ComponentType<{
    open: boolean; onOpenChange: (open: boolean) => void;
    title: ReactNode; description?: ReactNode;
    confirmLabel?: string; cancelLabel?: string;
    onConfirm: () => void; onCancel?: () => void;
    variant?: 'default' | 'danger'; cancelAutoFocus?: boolean;
  }>;
}

declare module '@moss-desktop/renderer/editor/markdown/transformers' {
  export interface LocalLayoutMetadata {
    version: 1; tableCount: number; tables: { columnWidths?: number[] }[];
    tabGroupCount?: number; tabGroups?: { panelLabels: string[]; tabWidths?: (number | null)[] }[];
  }
  export function $collectTableLayoutMetadata(): LocalLayoutMetadata;
  export function $collectTabGroupLayoutMetadata(): Pick<LocalLayoutMetadata, 'tabGroupCount' | 'tabGroups'>;
}

// The module a substitute replaces, at the pin (A§2.1; vite.config.ts `substitutes`).
declare module '@moss-pristine/asset-url' {
  export const REMOTE_URL_PATTERN: RegExp;
  export function normalizeLocalAssetPathForDisplay(src: string): string;
  export function toDisplaySrc(src: string, noteId?: string | null): string;
  export function fromDisplaySrc(src: string, currentNoteId?: string | null): string;
}

declare module '@moss-desktop/renderer/panels/notesPanelUtils' {
  /** moss's sidebar time: `timestamp` in seconds. */
  export function formatRelativeTime(timestamp: number): string;
}
