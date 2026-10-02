// The family corpus (S-conv §5.4) shared by L1 (Node), L2 (workerd) and L3 (pristine parity). Vite inlines the
// files, so the same list loads in workerd, which has no file system. onboarding-*.md are moss's own onboarding
// notes at 762abb777 (packages/desktop/Moss/onboarding).
import type { Transformer } from '@lexical/markdown';
import type { NoteBodyImportOptions } from './index.ts';
import scaleExclusions from './fixtures/scale.json';

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

// A3 has two halves: the export is idempotent after one pass, and the first import is already the tree that
// export carries. These inputs miss a half in moss's own pipeline at the pin (L3 holds them equal to moss);
// A3 pins each so that a change in behavior shows up.
export const CANONICALIZED: Record<string, string> = {
  composition: "a space inside bold before a wiki link moves outside the bold",
  'embed-pills': 'a legacy ?[label](url) pill exports as its bare URL, dropping the label',
  tables: 'legacy column widths are per-viewer layout, so the export drops them',
};
export const NOT_IDEMPOTENT: Record<string, string> = {
  'code-blocks': 'a fence inside a 4-backtick block exports inside a 3-backtick fence, which splits the block',
  entities: '&#160; imports as a no-break space between zero-width spaces, and both reach the export',
};

// The scale note (S-conv §5.4 Scale; SP2): every fixture without a comments sidecar, except scale.json's
// exclusions, joined into one unit that repeats. scripts/measure-converter.mjs builds the same note.
export const SCALE_EXCLUDED: Record<string, string> = scaleExclusions;
export const SCALE_FIXTURES = FIXTURES.filter((f) => !f.options.comments && !(f.name in SCALE_EXCLUDED));
export const SCALE_UNIT = SCALE_FIXTURES.map((f) => f.markdown).join('\n\n');
export const scaleNote = (units: number): string => Array.from({ length: units }, () => SCALE_UNIT).join('\n\n');

// One line per transformer, in list order, so a golden and moss's own list can pin the order (A§12).
export function transformerSignature(transformer: Transformer): string {
  const t = transformer as Transformer & Record<string, unknown>;
  const source = (value: unknown) => (value instanceof RegExp ? value.source : '');
  const dependencies = ((t.dependencies as { getType(): string }[] | undefined) ?? []).map((klass) => klass.getType());
  return [t.type, t.tag ?? '', source(t.regExpStart ?? t.regExp), source(t.importRegExp), dependencies.join(',')].join(' ');
}
