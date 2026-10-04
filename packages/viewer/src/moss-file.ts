// A moss note as the viewer reads it, through the moss interchange path (A§12): moss's own disassembleNote splits
// a note file into frontmatter, the leading `# Title` line and the body, so the title is painted once, above the
// body, as moss's canvas does. The layout sidecar is coerced the way moss's note store reads layout.json.
import { disassembleNote, splitFrontmatter } from '@moss-desktop/common/markdown-layers';
import { stripWikiLinks } from '@moss-desktop/common/utils';
import type { NoteLayoutMetadata } from '@moss-desktop/common/noteTypes';
import type { MossViewerOptions } from './types.ts';

export interface MossNoteContent {
  title: string;
  frontmatter: Record<string, unknown> | null;
  /** The body markdown, for moss's MarkdownEditor `value`; empty when `state` is given. */
  body: string;
  /** A serialized editor state, for moss's MarkdownEditor `initialSerializedState`. */
  state: object | undefined;
  layout: NoteLayoutMetadata | undefined;
}

function readFrontmatter(value: MossViewerOptions['frontmatter']): Record<string, unknown> | null {
  if (!value) return null;
  if (typeof value !== 'string') return value;
  return splitFrontmatter(`---\n${value.replace(/\n$/, '')}\n---\n`).data;
}

function readState(value: unknown): object | undefined {
  if (value === undefined || value === null) return undefined;
  const state: unknown = typeof value === 'string' ? JSON.parse(value) : value;
  if (!state || typeof state !== 'object' || !('root' in state)) throw new Error('moss-viewer: state must be a serialized Lexical editor state');
  return state;
}

const positiveNumbers = (value: unknown): number[] | undefined =>
  Array.isArray(value) ? value.filter((width): width is number => typeof width === 'number' && Number.isFinite(width) && width > 0) : undefined;

/** layout.json, or undefined when it is not moss's version 1 shape. */
export function readLayout(value: unknown): NoteLayoutMetadata | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const { version, tableCount, tables, tabGroupCount, tabGroups } = value as Record<string, unknown>;
  if (version !== 1 || typeof tableCount !== 'number' || !Number.isInteger(tableCount) || !Array.isArray(tables)) return undefined;
  const entry = (item: unknown): Record<string, unknown> => (item && typeof item === 'object' && !Array.isArray(item) ? (item as Record<string, unknown>) : {});
  const layout: NoteLayoutMetadata = {
    version: 1,
    tableCount,
    tables: tables.map((table) => {
      const columnWidths = positiveNumbers(entry(table).columnWidths);
      return columnWidths?.length ? { columnWidths } : {};
    }),
  };
  if (typeof tabGroupCount === 'number' && Number.isInteger(tabGroupCount) && Array.isArray(tabGroups)) {
    layout.tabGroupCount = tabGroupCount;
    layout.tabGroups = tabGroups.map((group) => {
      const widths = entry(group).tabWidths;
      return Array.isArray(widths) ? { tabWidths: widths.map((width) => (typeof width === 'number' && width > 0 ? width : null)) } : {};
    });
  }
  return layout;
}

export function readMossNote(options: MossViewerOptions): MossNoteContent {
  const layout = readLayout(options.layout);
  const fallbackTitle = options.title?.trim() ?? '';
  if (typeof options.markdown === 'string') {
    const note = disassembleNote(options.markdown);
    const title = note.h1Title ? stripWikiLinks(note.h1Title).trim() : '';
    return { title: title || fallbackTitle, frontmatter: note.frontmatter, body: note.body, state: undefined, layout };
  }
  const state = readState(options.state);
  if (!state) throw new Error('moss-viewer: pass markdown or state');
  return { title: fallbackTitle, frontmatter: readFrontmatter(options.frontmatter), body: '', state, layout };
}
