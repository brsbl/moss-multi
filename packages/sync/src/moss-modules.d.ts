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

declare module '@moss-desktop/common/markdown-layers' {
  export function splitFrontmatter(raw: string): { body: string; hasFrontmatter: boolean; error?: string };
}

declare module '@moss-desktop/renderer/editor/markdown/format-whitespace' {
  import type { TextNode } from 'lexical';
  export function $normalizeFormatWhitespace(node: TextNode): void;
}

declare module '@moss-desktop/renderer/editor/utils/formula-runtime' {
  export interface FormulaInput {
    noteId: string; noteTitle: string; formulaId: string; name: string | null;
    expression: string; result: string; stale: boolean;
  }
  export function evaluateWorkspaceFormulas(inputs: FormulaInput[]): {
    byKey: Map<string, FormulaInput & { sourceMode: string }>;
  };
}
