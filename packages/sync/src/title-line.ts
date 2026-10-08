// The moss title line (A§12 moss interchange): moss saves a note's title as a leading `# Title` line after its
// frontmatter. Only a line in that place counts, and only when it is the title: an H1 anywhere else, or one that
// differs from a title the caller gave, stays body content.
import { splitFrontmatter } from '@moss-desktop/common/markdown-layers';

/** moss's LEADING_H1_RE (common/markdown-utils.ts), anchored to the start of the body. */
const TITLE_LINE = /^#(?!#)[^\S\r\n]+(.*?)(?:[^\S\r\n]+#+)?[^\S\r\n]*(?:\r?\n|$)/;
const BLANK_LINES = /^(?:[^\S\r\n]*\r?\n)*/;

/**
 * Lifts a leading `# X` line out of `markdown`. With no `title`, X becomes the title; with one, the line is dropped
 * only when X is that title. Anything else returns the markdown unchanged.
 */
export function liftTitleLine(markdown: string, title?: string): { title: string | undefined; markdown: string } {
  const { body } = splitFrontmatter(markdown);
  const head = markdown.slice(0, markdown.length - body.length);
  const lead = BLANK_LINES.exec(body)![0].length;
  const match = TITLE_LINE.exec(body.slice(lead));
  const line = match?.[1]?.trim();
  if (!match || !line || (title !== undefined && title.trim() !== line)) return { title, markdown };
  const rest = body.slice(lead + match[0].length).replace(BLANK_LINES, '');
  return { title: title ?? line, markdown: head + rest };
}
