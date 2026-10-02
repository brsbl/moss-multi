import { appendFileSync, cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { checkBoundary, runtimeImports } from './deps.mjs';

const REPO = fileURLToPath(new URL('../..', import.meta.url));
const temps = [];
afterEach(() => {
  while (temps.length > 0) rmSync(temps.pop(), { recursive: true, force: true });
});

function tree(files) {
  const repo = mkdtempSync(join(tmpdir(), 'deps-'));
  temps.push(repo);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), text);
  }
  return repo;
}

const rulesOf = (result) => result.violations.map((v) => v.rule);

describe('runtime imports', () => {
  it('ignores type-only imports and bindings used only as types', () => {
    const text = [
      "import type { A } from './a';",
      "import { type B } from './b';",
      "import { C } from './c';",
      "import { D } from './d';",
      "import './e.css';",
      "export type { F } from './f';",
      "export { G } from './g';",
      'let x: C;',
      'D();',
    ].join('\n');
    expect(runtimeImports('x.ts', text).map((i) => i.spec)).toEqual(['./d', './e.css', './g']);
  });

  it('keeps a class imported only to extend it, but not one only implemented', () => {
    const text = [
      "import { CodeNode } from '@lexical/code';",
      "import { ChartView } from './nodes/ChartNode.view';",
      "import { Shape } from './shape';",
      'export class X extends CodeNode {}',
      'export class Y extends ChartView<string> implements Shape {}',
    ].join('\n');
    expect(runtimeImports('x.ts', text).map((i) => i.spec)).toEqual(['@lexical/code', './nodes/ChartNode.view']);
  });
});

describe('bundle boundary (A§4.4) @p:tech-4', () => {
  const base = {
    'packages/sync/package.json': JSON.stringify({ name: '@moss-multi/sync', exports: { './converter': './src/converter/index.ts' } }),
    'packages/sync/src/converter/index.ts': "import { pure } from './pure';\nexport const value = pure;\n",
    'packages/sync/src/converter/pure.ts': "import { $getRoot } from 'lexical';\nexport const pure = $getRoot;\n",
  };
  const entries = ['packages/sync/src/converter/index.ts'];

  it('passes a closure of pure modules', () => {
    expect(checkBoundary({ repo: tree(base), entries }).violations).toEqual([]);
  });

  it('reports a missing entry instead of dropping it', () => {
    const result = checkBoundary({ repo: tree(base), entries: [...entries, 'apps/web/src/server.ts'] });
    expect(result.entries).toEqual(entries);
    expect(result.missing).toEqual(['apps/web/src/server.ts']);
  });

  it.each([
    ['a node view (*.view.tsx)', { 'packages/sync/src/converter/Thing.view.tsx': 'export const view = 1;\n' }, "import { view } from './Thing.view';\nexport const v = view;\n"],
    ['CSS', { 'packages/sync/src/converter/x.css': '.x {}\n' }, "import './x.css';\n"],
    ['react-dom', {}, "import { createPortal } from 'react-dom';\nexport const p = createPortal;\n"],
    ['jotai', {}, "import { atom } from 'jotai';\nexport const a = atom(0);\n"],
    ['@lexical/code (use @lexical/code-core)', {}, "import { CodeNode } from '@lexical/code';\nexport const c = CodeNode;\n"],
    ['the @moss/shared barrel', { 'vendor/moss/packages/shared/src/index.ts': 'export const s = 1;\n' }, "import { s } from '@moss/shared';\nexport const shared = s;\n"],
    ['the Electron API (api/electron)', { 'vendor/moss/packages/desktop/src/renderer/api/electron.ts': 'export const e = 1;\n' }, "import { e } from '@moss-desktop/renderer/api/electron';\nexport const el = e;\n"],
  ])('fails on %s reached through the closure', (rule, extra, line) => {
    const repo = tree({ ...base, ...extra, 'packages/sync/src/converter/pure.ts': `${base['packages/sync/src/converter/pure.ts']}${line}` });
    const result = checkBoundary({ repo, entries });
    expect(rulesOf(result)).toEqual([rule]);
    expect(result.violations[0].chain).toContain('packages/sync/src/converter/pure.ts');
  });

  it('passes the real converter closure', () => {
    const result = checkBoundary({ repo: REPO });
    expect(result.entries).toContain('packages/sync/src/converter/index.ts');
    expect(result.violations).toEqual([]);
    expect(result.unresolved).toEqual([]);
  });

  it('negative control: importing a node view into the real converter fails', () => {
    const repo = mkdtempSync(join(tmpdir(), 'deps-real-'));
    temps.push(repo);
    for (const dir of ['vendor/moss', 'packages/sync']) cpSync(join(REPO, dir), join(repo, dir), { recursive: true, filter: (src) => !src.includes('node_modules') });
    appendFileSync(join(repo, 'packages/sync/src/converter/index.ts'), "import '@moss-desktop/renderer/editor/nodes/ChartNode.view';\n");
    const result = checkBoundary({ repo, entries });
    expect(rulesOf(result)).toEqual(['a node view (*.view.tsx)']);
  });
});
