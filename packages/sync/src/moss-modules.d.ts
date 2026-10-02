// The two vendored converter modules the DocDO reaches through converter/index.ts. Declared here so the sync and
// apps/web typechecks stop at the vendor boundary; tsconfig.converter.json checks the real closure.
declare module '@moss-desktop/renderer/editor/markdown/pipeline' {
  export interface NoteBodyImportOptions {
    comments?: unknown;
    layout?: unknown;
  }
  /** Call inside editor.update(); replaces the root's children. */
  export function $importNoteBody(markdown: string, options?: NoteBodyImportOptions): void;
  /** Call inside editor.read() or editor.update(). */
  export function $exportNoteBody(): string;
}

declare module '@moss-desktop/renderer/editor/markdown/transformers' {
  import type { Transformer } from '@lexical/markdown';
  import type { Klass, LexicalNode } from 'lexical';

  export const MARKDOWN_EDITOR_TRANSFORMERS: Transformer[];
  export const MARKDOWN_EDITOR_NODES: Klass<LexicalNode>[];
}
