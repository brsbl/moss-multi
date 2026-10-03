// Frontmatter in Y.Text('frontmatter') (A§10.4): the YAML between the fences, each line ending in a newline. The
// fences are added only at the markdown boundary, so two people adding the first keys of an empty block at once
// both land inside one block. A property edit rewrites only its own key's lines, never the whole block: a js-yaml
// re-dump would rewrite a hand-formatted block wholesale, and a concurrent edit to another key would then merge
// into broken YAML.
import jsYaml from 'js-yaml';
import type * as Y from 'yjs';
import { readField, writeField } from './doc-fields.ts';

/** moss's own dump options (`joinFrontmatter` in markdown-layers.ts). */
const DUMP = { lineWidth: -1, noRefs: true, sortKeys: false, quotingType: '"' } as const;

/** The top-level key a line opens, or null for a continuation, comment or blank line. */
function keyOf(line: string): string | null {
  const quoted = /^"((?:[^"\\]|\\.)*)"\s*:(?:\s|$)/.exec(line);
  if (quoted) {
    try {
      return JSON.parse(`"${quoted[1]}"`) as string;
    } catch {
      return quoted[1];
    }
  }
  const single = /^'((?:[^']|'')*)'\s*:(?:\s|$)/.exec(line);
  if (single) return single[1].replace(/''/g, "'");
  const plain = /^([^\s#'"-][^:]*?)\s*:(?:\s|$)/.exec(line);
  return plain ? plain[1] : null;
}

/** A line that belongs to the key above it: indented, or a sequence item at column 0. */
const continues = (line: string): boolean => /^[ \t-]/.test(line);

/** The character range of `key`'s lines (its own line, its continuation lines, and their newlines), or null. */
function keyRange(yaml: string, key: string): [number, number] | null {
  const lines = yaml.split('\n');
  let offset = 0;
  for (let i = 0; i < lines.length; i += 1) {
    if (keyOf(lines[i]) === key) {
      let end = i + 1;
      // Continuation lines, and blank lines that sit between continuation lines.
      for (let j = i + 1; j < lines.length; j += 1) {
        if (continues(lines[j])) end = j + 1;
        else if (lines[j].trim() !== '') break;
      }
      let endOffset = offset;
      for (let j = i; j < end; j += 1) endOffset += lines[j].length + 1;
      return [offset, Math.min(endOffset, yaml.length)];
    }
    offset += lines[i].length + 1;
  }
  return null;
}

/** `yaml` with `key` set to `value` (removed when `value` is undefined), every other line kept byte for byte. */
export function setFrontmatterKey(yaml: string, key: string, value: unknown): string {
  const lines = value === undefined ? '' : jsYaml.dump({ [key]: value }, DUMP);
  const range = keyRange(yaml, key);
  if (range) return `${yaml.slice(0, range[0])}${lines}${yaml.slice(range[1])}`;
  if (!lines) return yaml;
  return `${yaml && !yaml.endsWith('\n') ? `${yaml}\n` : yaml}${lines}`;
}

/** Sets one key in the doc's frontmatter, touching only that key's lines; false when nothing changed. */
export function writeFrontmatterKey(doc: Y.Doc, key: string, value: unknown, origin: unknown): boolean {
  return writeField(doc, 'frontmatter', setFrontmatterKey(readField(doc, 'frontmatter'), key, value), origin);
}

/** The `.md` file's start: the block in its fences, then the body; no block for none. */
export function composeFrontmatter(yaml: string, body: string): string {
  if (!yaml.trim()) return body;
  return `---\n${yaml.endsWith('\n') ? yaml : `${yaml}\n`}---\n${body}`;
}
