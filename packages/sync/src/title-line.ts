// The moss title line (A§12 moss interchange): moss saves a note's title as a leading `# Title` line after its
// frontmatter. Only a line in that place counts, and only when it is the title: an H1 anywhere else, or one that
// differs from a title the caller gave, stays body content.
import { splitFrontmatter } from '@moss-desktop/common/markdown-layers';
import { matchTitleLine } from '@moss-multi/protocol/title-line';

const BLANK_LINES = /^(?:[^\S\r\n]*\r?\n)*/;

/**
 * Lifts a leading `# X` line out of `markdown`. With no `title`, X becomes the title; with one, the line is dropped
 * only when X is that title. Anything else returns the markdown unchanged.
 */
export function liftTitleLine(markdown: string, title?: string): { title: string | undefined; markdown: string } {
  const { body } = splitFrontmatter(markdown);
  const head = markdown.slice(0, markdown.length - body.length);
  const lead = BLANK_LINES.exec(body)![0].length;
  const match = matchTitleLine(body.slice(lead));
  const line = match?.line.trim();
  if (!match || !line || (title !== undefined && title.trim() !== line)) return { title, markdown };
  const rest = body.slice(lead + match.length).replace(BLANK_LINES, '');
  return { title: title ?? line, markdown: head + rest };
}
