import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { checkDoc, checkText, declares } from './doc-links.mjs';

const REPO = fileURLToPath(new URL('../..', import.meta.url));
const MIGRATION = fileURLToPath(new URL('../../MIGRATION.md', import.meta.url));

describe('doc-links checker', () => {
  it('accepts existing paths, directories and declared symbols', () => {
    const text = 'See `scripts/ci/plan.mjs#isDocsOnlyPath`, `packages/sync/src/` and `PRODUCT.md`, and [arch](docs/ARCHITECTURE.md).';
    expect(checkText(text, { repo: REPO })).toEqual([]);
  });

  it('reports a missing path, a missing symbol and a broken link', () => {
    const text = [
      '`packages/sync/src/no-such-file.ts`',
      '`scripts/ci/plan.mjs#noSuchSymbol`',
      '[gone](docs/NOPE.md)',
    ].join('\n');
    const problems = checkText(text, { repo: REPO });
    expect(problems).toHaveLength(3);
    expect(problems[0]).toMatch(/no such path: packages\/sync\/src\/no-such-file\.ts/);
    expect(problems[1]).toMatch(/does not declare noSuchSymbol/);
    expect(problems[2]).toMatch(/broken link docs\/NOPE\.md/);
  });

  it('checks moss paths against the vendor tree and ported-from headers', () => {
    const ok = '`moss:packages/desktop/src/renderer/App.tsx` `moss:packages/desktop/src/main/storage/note-store.ts`';
    expect(checkText(ok, { repo: REPO })).toEqual([]);
    expect(checkText('`moss:packages/desktop/src/main/no-such.ts`', { repo: REPO })[0]).toMatch(/neither vendored nor ported/);
  });

  it('checks the directory before a placeholder, and ignores code that is not a path', () => {
    expect(checkText('`vendor/patches/moss/<path>.patch` `Y.Text(\'title\')` `root`', { repo: REPO })).toEqual([]);
    expect(checkText('`vendor/nope/<path>.patch`', { repo: REPO })[0]).toMatch(/no directory vendor\/nope\//);
  });

  it('finds declarations, members and re-exports, not mere mentions, in source', () => {
    expect(declares('export class DocDO extends YServer {}', 'DocDO', 'a.ts')).toBe(true);
    expect(declares('  async onMessage(conn) {}', 'onMessage', 'a.ts')).toBe(true);
    expect(declares('export { readRegister } from "x";', 'readRegister', 'a.ts')).toBe(true);
    expect(declares('call(DocDO)', 'DocDO', 'a.ts')).toBe(false);
  });
});

// T8.4: how each part of moss-multi maps back onto moss desktop.
const SECTIONS = [
  'Vendor seams and patches',
  'Bridge namespaces',
  'Converter extraction',
  'Collaboration layer',
  'Registers and payload docs',
  'Comments',
  'Suggestions',
  'History',
  'Server model',
  'CLI and daemon',
  'Viewer and editor packages',
];
const LABELS = ['**Here.**', '**Where.**', '**Desktop changes.**', '**Risks.**'];

function sections(text) {
  const out = new Map();
  let current = null;
  for (const line of text.split('\n')) {
    const heading = /^## (?:\d+\. )?(.+)$/.exec(line);
    if (heading) {
      current = heading[1].trim();
      out.set(current, []);
    } else if (current) out.get(current).push(line);
  }
  return new Map([...out].map(([name, lines]) => [name, lines.join('\n')]));
}

describe('MIGRATION.md', () => {
  const text = existsSync(MIGRATION) ? readFileSync(MIGRATION, 'utf8') : '';

  it('exists', () => {
    expect(existsSync(MIGRATION), 'MIGRATION.md').toBe(true);
  });

  it('leads with a summary table that has a row per section', () => {
    const first = [...sections(text)][0];
    expect(first?.[0]).toBe('Summary');
    const rows = (first?.[1] ?? '').split('\n').filter((line) => line.startsWith('|'));
    for (const name of SECTIONS) expect(rows.some((row) => row.includes(name)), `summary row for ${name}`).toBe(true);
  });

  it.each(SECTIONS)('has a section on %s with what exists, where, desktop changes and risks', (name) => {
    const body = sections(text).get(name);
    expect(body, `## ${name}`).toBeDefined();
    for (const label of LABELS) expect(body.includes(label), `${name}: ${label}`).toBe(true);
  });

  it('cites only paths and symbols that exist', () => {
    expect(existsSync(MIGRATION) ? checkDoc('MIGRATION.md', REPO) : ['MIGRATION.md is missing']).toEqual([]);
  });
});
