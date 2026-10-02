// The family corpus (S-conv §5.4) shared by L1 (Node), L2 (workerd) and L3 (pristine parity). Vite inlines the
// files, so the same list loads in workerd, which has no file system.
import type { NoteBodyImportOptions } from './index.ts';

const markdown = import.meta.glob<string>('./fixtures/*.md', { query: '?raw', import: 'default', eager: true });
const comments = import.meta.glob<Record<string, unknown>>('./fixtures/*.comments.json', { import: 'default', eager: true });
const goldens = import.meta.glob<string>('./fixtures/goldens/*', { query: '?raw', import: 'default', eager: true });

export interface Fixture {
  name: string;
  markdown: string;
  options: NoteBodyImportOptions;
}

const nameOf = (path: string) => path.replace(/^.*\//, '').replace(/\.md$/, '');

export const FIXTURES: Fixture[] = Object.entries(markdown)
  .map(([path, text]) => {
    const name = nameOf(path);
    const sidecar = comments[`./fixtures/${name}.comments.json`];
    return { name, markdown: text, options: sidecar ? { comments: sidecar as NoteBodyImportOptions['comments'] } : {} };
  })
  .sort((a, b) => (a.name < b.name ? -1 : 1));

export function fixture(name: string): Fixture {
  const found = FIXTURES.find((f) => f.name === name);
  if (!found) throw new Error(`no fixture ${name}`);
  return found;
}

// Committed goldens: `<name>.json` (A1, the imported tree) and `<name>.export.md` (A2, the export).
export function golden(file: string): string | undefined {
  return goldens[`./fixtures/goldens/${file}`];
}

// Lexical JSON carries no node keys, so a stable stringify is the comparable form.
export const stringify = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

// Fixtures whose moss behavior the converter deliberately changes (docs/DEVIATIONS.md): L3 expects a difference.
export const DEVIATING = new Set(['line-loss']);
