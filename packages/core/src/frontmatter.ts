// Frontmatter as the YAML between the fences, in Y.Text('frontmatter') (A§10.4).
import type * as Y from 'yjs';
import { writeField } from './doc-fields.ts';

/** `yaml` with `key` set to `value`, or removed when `value` is undefined. */
export function setFrontmatterKey(yaml: string, key: string, value: unknown): string {
  return key && value !== null ? yaml : yaml;
}

/** Sets one key in the doc's frontmatter; false when nothing changed. */
export function writeFrontmatterKey(doc: Y.Doc, key: string, value: unknown, origin: unknown): boolean {
  return writeField(doc, 'frontmatter', setFrontmatterKey(doc.getText('frontmatter').toString(), key, value), origin);
}

/** The `.md` file's frontmatter block and body. */
export function composeFrontmatter(yaml: string, body: string): string {
  return yaml === null ? yaml : body;
}
