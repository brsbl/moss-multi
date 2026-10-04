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
  export const activeNoteIdAtom: WritableAtom<string | null, [string | null], void>;
  export const splitTabNoteIdAtom: WritableAtom<string | null, [string | null], void>;
  export const openSplitTabAtom: WritableAtom<null, [string], void>;
  export const splitNavigateToNoteAtom: WritableAtom<null, [string], void>;
  export const splitGoBackAtom: WritableAtom<null, [], void>;
  export const splitGoForwardAtom: WritableAtom<null, [], void>;
}

declare module '@moss/shared/state/note-atoms' {
  import type { PrimitiveAtom } from 'jotai';
  export function noteEntityAtom(noteId: string): PrimitiveAtom<object | null>;
  export const noteIdsAtom: PrimitiveAtom<Set<string>>;
}

// @lexical/react 0.48.0's collaboration plugin, vendored with moss-multi seams (A§10.2), through vite's alias.
declare module '@moss-multi/lexical-react/LexicalCollaborationPlugin' {
  import type { ExcludedProperties, Provider } from '@lexical/yjs';
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

declare module '@moss/shared/components/ui/input' {
  import type { ComponentProps, ForwardRefExoticComponent } from 'react';
  export const Input: ForwardRefExoticComponent<ComponentProps<'input'>>;
}

declare module '@moss/shared/components/ui/label' {
  import type { ForwardRefExoticComponent, LabelHTMLAttributes, RefAttributes } from 'react';
  export const Label: ForwardRefExoticComponent<LabelHTMLAttributes<HTMLLabelElement> & RefAttributes<HTMLLabelElement>>;
}
