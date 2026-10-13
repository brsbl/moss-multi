import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
    expect(checkText('`moss:<path>` `moss:packages/desktop/src/renderer/<file>`', { repo: REPO })).toEqual([]);
    expect(checkText('`moss:packages/nope/<file>`', { repo: REPO })[0]).toMatch(/moss no directory packages\/nope\//);
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

  it('does not take a call statement for a member declaration', () => {
    expect(declares('mkdirSync("x");', 'mkdirSync', 'a.mjs')).toBe(false);
    expect(declares('  mkdirSync("x");', 'mkdirSync', 'a.mjs')).toBe(false);
    expect(declares('    mkdirSync(\n      "x",\n    );', 'mkdirSync', 'a.mjs')).toBe(false);
    expect(declares('  run?.(x);', 'run', 'a.ts')).toBe(false);
    // Controls: a method, a multi-line method with a return type, a typed field, an assigned field and a function.
    expect(declares('  async onMessage(conn) {}', 'onMessage', 'a.ts')).toBe(true);
    expect(declares('  plan<T>(\n    a: T,\n  ): void {', 'plan', 'a.ts')).toBe(true);
    expect(declares('  readonly limit: number;', 'limit', 'a.ts')).toBe(true);
    expect(declares('  #count = 0;', 'count', 'a.ts')).toBe(true);
    expect(declares('export function mkdirSync(path) {}', 'mkdirSync', 'a.mjs')).toBe(true);
  });

  it('checks a citation whose root no longer exists, and still ignores code that is not a path', () => {
    const repo = mkdtempSync(join(tmpdir(), 'doc-links-'));
    mkdirSync(join(repo, 'src'));
    writeFileSync(join(repo, 'src/a.ts'), 'export const a = 1;\n');
    writeFileSync(join(repo, 'README.md'), '# readme\n');
    const text = [
      '`gone/file.ts`',
      '`GONE.md`',
      '`src/a.ts#a` `README.md` `Y.Text` `App.tsx` `text/html` `/api/docs/:id` `@moss-multi/editor`',
      '`https://example.invalid/x.md` `assets/<file>` `.moss-multi/<docId>/` `<HistoryPlugin/>`',
    ].join('\n');
    expect(checkText(text, { repo, ported: new Set() })).toEqual(['line 1: no such path: gone/file.ts', 'line 2: no such path: GONE.md']);
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

  // B380: the bridge's getContent answers an empty body; the export is REST's.
  it('describes notes.getContent as the bridge implements it', () => {
    const bridge = readFileSync(join(REPO, 'apps/web/src/host/bridge/index.ts'), 'utf8');
    expect(/getContent: async \(id: string\) => \(\(await byId\(id\)\) \? \{ id, content: '', version: 1 \}/.test(bridge), 'getContent is an empty-content stub').toBe(true);
    const claim = text.split('\n').find((line) => line.includes('`notes.getContent`')) ?? '';
    expect(claim).not.toMatch(/is the server export/);
    expect(claim).toMatch(/stub/);
    expect(claim).toContain('GET /api/docs/:id/content');
    expect(claim).toContain('apps/web/src/api/docs.ts#readContent');
    expect(claim).toMatch(/binding/);
  });

  // B381: every renderer path at the pin that writes content through notes.update is in the audit.
  it('lists every notes.update content writer at the pin and the seam that suppresses them', () => {
    const canvas = readFileSync(join(REPO, 'vendor/moss/packages/desktop/src/renderer/panels/CanvasAreaContent.tsx'), 'utf8');
    const writers = [...canvas.matchAll(/const (\w+) = (?:async )?\([^)]*\)\s*=>\s*(?:\{\s*const \w+ = await\s+)?notesApi\.update\.invoke\(\s*noteId,\s*\{\s*content:/g)].map((m) => m[1]);
    expect(writers).toEqual(['saveWithExpectedContent', 'saveUserWinsUnderNoteLock']);
    const audit = text.split('\n').find((line) => line.includes('At the pin')) ?? '';
    for (const writer of writers) expect(audit, writer).toContain(`CanvasAreaContent.tsx#${writer}`);
    expect(audit).toContain('CanvasAreaContent.tsx#saveContent');
    expect(audit).toMatch(/bound-pane/);
  });

  it('cites only paths and symbols that exist', () => {
    expect(existsSync(MIGRATION) ? checkDoc('MIGRATION.md', REPO) : ['MIGRATION.md is missing']).toEqual([]);
  });
});
