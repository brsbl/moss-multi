// ported-from: packages/shared/src/lib/markdown-inline.tsx @ 762abb777
import type { ReactNode } from 'react';

/**
 * Parse inline markdown tokens (bold, italic, code, links).
 * Used internally by renderInlineMarkdown.
 */
export function parseInlineTokens(text: string): ReactNode[] {
  const parts: ReactNode[] = [];
  let remaining = text;
  let key = 0;

  while (remaining.length > 0) {
    // Tool use error tags - render with error styling
    if (remaining.startsWith('<tool_use_error>')) {
      const endTag = '</tool_use_error>';
      const endIndex = remaining.indexOf(endTag);
      if (endIndex !== -1) {
        const errorContent = remaining.slice('<tool_use_error>'.length, endIndex);
        parts.push(
          <span
            key={key++}
            className="inline-block rounded border border-status-error-border bg-status-error-surface px-1.5 py-0.5 text-xs text-status-error-text"
          >
            {errorContent}
          </span>
        );
        remaining = remaining.slice(endIndex + endTag.length);
        continue;
      }
      // Incomplete tag - render as plain text
      parts.push('<tool_use_error>');
      remaining = remaining.slice('<tool_use_error>'.length);
      continue;
    }

    // Inline code - check for closing backtick
    if (remaining[0] === '`') {
      const endIndex = remaining.indexOf('`', 1);
      if (endIndex !== -1 && endIndex > 1) {
        parts.push(
          <code key={key++} className="rounded bg-surface-panel px-1 py-0.5 font-mono text-xs">
            {remaining.slice(1, endIndex)}
          </code>
        );
        remaining = remaining.slice(endIndex + 1);
        continue;
      }
      parts.push('`');
      remaining = remaining.slice(1);
      continue;
    }

    // Bold (**text**)
    if (remaining.startsWith('**')) {
      const endIndex = remaining.indexOf('**', 2);
      if (endIndex !== -1 && endIndex > 2) {
        parts.push(<strong key={key++}>{remaining.slice(2, endIndex)}</strong>);
        remaining = remaining.slice(endIndex + 2);
        continue;
      }
      parts.push('**');
      remaining = remaining.slice(2);
      continue;
    }

    // Italic (*text*)
    if (remaining[0] === '*' && remaining[1] !== '*') {
      const endIndex = remaining.indexOf('*', 1);
      if (endIndex !== -1 && endIndex > 1) {
        parts.push(<em key={key++}>{remaining.slice(1, endIndex)}</em>);
        remaining = remaining.slice(endIndex + 1);
        continue;
      }
      parts.push('*');
      remaining = remaining.slice(1);
      continue;
    }

    // Links [text](url) - validate protocol to prevent XSS
    const linkMatch = remaining.match(/^\[([^\]]+)\]\(([^)]+)\)/);
    if (linkMatch) {
      const linkText = linkMatch[1];
      const linkUrl = linkMatch[2];
      let isSafeUrl = false;

      try {
        const parsed = new URL(linkUrl, 'https://example.com');
        const safeProtocols = ['http:', 'https:', 'mailto:'];
        isSafeUrl = safeProtocols.includes(parsed.protocol);
      } catch {
        // Invalid URL - treat as unsafe
      }

      if (isSafeUrl) {
        parts.push(
          <a
            key={key++}
            href={linkUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-accent-brand underline hover:text-accent-brand-pressed"
          >
            {parseInlineTokens(linkText)}
          </a>
        );
      } else {
        // Render unsafe URLs as plain text
        parts.push(`[${linkText}](${linkUrl})`);
      }
      remaining = remaining.slice(linkMatch[0].length);
      continue;
    }

    // Plain text - consume until next potential markdown token
    const nextToken = remaining.slice(1).search(/[`*\[]/);
    if (nextToken === -1) {
      parts.push(remaining);
      break;
    }
    parts.push(remaining.slice(0, nextToken + 1));
    remaining = remaining.slice(nextToken + 1);
  }

  return parts;
}

/** Check if a line is a bullet list item (- or *), allowing leading whitespace */
function isBulletLine(line: string): boolean {
  return /^\s*[-*]\s/.test(line);
}

/** Split a GFM-style pipe table row, honoring escaped pipes. */
function splitTableRow(line: string): string[] | null {
  let content = line.trim();
  if (!content.includes('|')) {
    return null;
  }

  if (content.startsWith('|')) {
    content = content.slice(1);
  }
  if (content.endsWith('|') && !content.endsWith('\\|')) {
    content = content.slice(0, -1);
  }

  const cells: string[] = [];
  let current = '';

  for (let i = 0; i < content.length; i++) {
    const char = content[i];
    const previousChar = i > 0 ? content[i - 1] : '';

    if (char === '|' && previousChar !== '\\') {
      cells.push(current.trim().replace(/\\\|/g, '|'));
      current = '';
      continue;
    }

    current += char;
  }

  cells.push(current.trim().replace(/\\\|/g, '|'));
  return cells.length >= 2 ? cells : null;
}

function isTableSeparatorCell(cell: string): boolean {
  return /^:?-{3,}:?$/.test(cell.trim());
}

function isTableSeparatorRow(line: string, columnCount: number): boolean {
  const cells = splitTableRow(line);
  return cells !== null &&
    cells.length === columnCount &&
    cells.every(isTableSeparatorCell);
}

interface ParsedMarkdownTable {
  headers: string[];
  rows: string[][];
  nextIndex: number;
}

function parseMarkdownTable(lines: string[], startIndex: number): ParsedMarkdownTable | null {
  const headers = splitTableRow(lines[startIndex]);
  if (!headers) {
    return null;
  }

  const columnCount = headers.length;
  const separatorLine = lines[startIndex + 1];
  if (!separatorLine || !isTableSeparatorRow(separatorLine, columnCount)) {
    return null;
  }

  const rows: string[][] = [];
  let nextIndex = startIndex + 2;

  while (nextIndex < lines.length) {
    const line = lines[nextIndex];
    if (line.trim() === '') {
      break;
    }

    const cells = splitTableRow(line);
    if (!cells) {
      if (line.includes('|')) {
        return null;
      }
      break;
    }
    if (cells.length !== columnCount) {
      return null;
    }

    rows.push(cells);
    nextIndex++;
  }

  if (rows.length === 0) {
    return null;
  }

  return { headers, rows, nextIndex };
}

function renderMarkdownTable(table: ParsedMarkdownTable, key: number): ReactNode {
  return (
    <div key={key} className="my-1 max-w-full overflow-x-auto whitespace-normal">
      <table className="w-full table-auto border-separate border-spacing-0 text-xs leading-normal">
        <thead>
          <tr>
            {table.headers.map((header, index) => (
              <th
                key={`header-${index}`}
                className="border-b border-r border-border-subtle bg-surface-panel px-2 py-1.5 text-left font-semibold text-ink-default last:border-r-0"
              >
                {parseInlineTokens(header)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.rows.map((row, rowIndex) => (
            <tr key={`row-${rowIndex}`}>
              {row.map((cell, cellIndex) => (
                <td
                  key={`cell-${rowIndex}-${cellIndex}`}
                  className={`border-r border-border-subtle px-2 py-1.5 text-left align-top text-ink-default last:border-r-0 ${
                    rowIndex === table.rows.length - 1 ? '' : 'border-b'
                  }`}
                >
                  {parseInlineTokens(cell)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Extract bullet content (text after optional whitespace and "- " or "* ") */
function getBulletContent(line: string): string {
  return line.replace(/^\s*[-*]\s/, '');
}

interface RenderInlineMarkdownOptions {
  tables?: boolean;
}

/**
 * Simple inline markdown renderer for agent messages.
 * Handles bold, italic, code, links, bulleted lists, tables, and tool errors without heavy async compilation.
 * Gracefully handles incomplete/malformed patterns during streaming.
 */
export function renderInlineMarkdown(text: string, options: RenderInlineMarkdownOptions = {}): ReactNode {
  const result: ReactNode[] = [];
  let key = 0;

  // First, handle code blocks and tool_use_error blocks by splitting around them
  const blockPattern = /```[\s\S]*?```|<tool_use_error>[\s\S]*?<\/tool_use_error>/g;
  const segments: { type: 'text' | 'code' | 'error'; content: string }[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = blockPattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ type: 'text', content: text.slice(lastIndex, match.index) });
    }
    const matchedText = match[0];
    if (matchedText.startsWith('```')) {
      segments.push({ type: 'code', content: matchedText });
    } else {
      segments.push({ type: 'error', content: matchedText });
    }
    lastIndex = match.index + matchedText.length;
  }
  if (lastIndex < text.length) {
    segments.push({ type: 'text', content: text.slice(lastIndex) });
  }

  for (const segment of segments) {
    if (segment.type === 'code') {
      // Render code block, stripping language specifier (e.g., ```javascript\n)
      const code = segment.content
        .slice(3, -3)
        .replace(/^[a-z]*\n?/, '')  // Strip language identifier
        .replace(/^\n/, '')
        .replace(/\n$/, '');
      result.push(
        <pre key={key++} className="my-1 rounded bg-surface-panel px-2 py-1 text-xs">
          <code>{code}</code>
        </pre>
      );
      continue;
    }

    if (segment.type === 'error') {
      // Render tool_use_error block
      const errorContent = segment.content
        .slice('<tool_use_error>'.length, -'</tool_use_error>'.length)
        .trim();
      result.push(
        <div
          key={key++}
          className="my-1 rounded border border-status-error-border bg-status-error-surface px-2 py-1.5 text-xs text-status-error-text"
        >
          <pre className="whitespace-pre-wrap">{errorContent}</pre>
        </div>
      );
      continue;
    }

    // Process text segment line by line for bullet lists
    const lines = segment.content.split('\n');
    let i = 0;

    while (i < lines.length) {
      const line = lines[i];

      const table = options.tables ? parseMarkdownTable(lines, i) : null;
      if (table) {
        result.push(renderMarkdownTable(table, key++));
        i = table.nextIndex;

        if (i < lines.length - 1) {
          result.push(<br key={key++} />);
        }
        continue;
      }

      // Check for bullet list
      if (isBulletLine(line)) {
        const listItems: ReactNode[] = [];
        while (i < lines.length && isBulletLine(lines[i])) {
          listItems.push(
            <li key={key++}>{parseInlineTokens(getBulletContent(lines[i]))}</li>
          );
          i++;
        }
        result.push(
          <ul key={key++} className="my-1 ml-4 list-disc space-y-0.5">
            {listItems}
          </ul>
        );
        continue;
      }

      // Regular line - render with inline tokens
      if (line.length > 0) {
        result.push(<span key={key++}>{parseInlineTokens(line)}</span>);
      }

      // Add line break between lines (but not after last line)
      if (i < lines.length - 1) {
        result.push(<br key={key++} />);
      }
      i++;
    }
  }

  return result;
}
