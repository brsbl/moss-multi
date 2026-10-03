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
  if (/^-(?:\s|$)/.test(line)) return null;
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
  const plain = /^([^\s#'"][^:]*?)\s*:(?:\s|$)/.exec(line);
  return plain ? plain[1] : null;
}

/** A line that belongs to the key above it: indented, or a sequence item at column 0. */
const continues = (line: string): boolean => /^(?:[ \t]|-(?:\s|$))/.test(line);

/** Every occurrence of `key`, including continuation lines; concurrent additions can produce duplicates. */
function keyRanges(yaml: string, key: string): [number, number][] {
  const lines = yaml.split('\n');
  const ranges: [number, number][] = [];
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
      ranges.push([offset, Math.min(endOffset, yaml.length)]);
    }
    offset += lines[i].length + 1;
  }
  return ranges;
}

/** `yaml` with `key` set to `value` (removed when `value` is undefined), every other line kept byte for byte. */
export function setFrontmatterKey(yaml: string, key: string, value: unknown): string {
  const lines = value === undefined ? '' : jsYaml.dump({ [key]: value }, DUMP);
  const ranges = keyRanges(yaml, key);
  if (ranges.length) {
    // Keep one occurrence, removing all duplicates without touching intervening keys or comments.
    for (let i = ranges.length - 1; i >= 0; i -= 1) {
      const [start, end] = ranges[i];
      yaml = `${yaml.slice(0, start)}${i === 0 ? lines : ''}${yaml.slice(end)}`;
    }
    return yaml;
  }
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
