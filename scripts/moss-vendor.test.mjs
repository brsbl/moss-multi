import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import * as vendor from './moss-vendor.mjs';
import { checkDrift, makePatch, repin, reportUpstream, ROOTS, writePristine } from './moss-vendor.mjs';

const REPO = fileURLToPath(new URL('..', import.meta.url));

// path → bytes (as base64) for every file under dir.
function snapshot(dir, prefix = '') {
  const files = {};
  for (const entry of readdirSync(join(dir, prefix), { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) Object.assign(files, snapshot(dir, path));
    else files[path] = readFileSync(join(dir, path)).toString('base64');
  }
  return files;
}

const UPSTREAM = {
  'packages/app/src/App.tsx': 'export const App = () => null;\n',
  'packages/app/src/styles.css': 'body { margin: 0; }\n',
  'packages/app/src/mock.json': '{"a":1}\n',
  'packages/app/src/note.md': '# Note\n',
  'packages/app/src/dev/Sandbox.tsx': 'export const Sandbox = 1;\n',
  'packages/other/Skip.ts': 'export const skip = 1;\n',
  'logo.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1, 2, 255]),
};
const PATCHABLE = ['line one', 'line two', 'line three', 'line four', 'line five', 'line six', 'line seven', 'line eight', 'line nine'];

const temps = [];
afterEach(() => {
  while (temps.length > 0) rmSync(temps.pop(), { recursive: true, force: true });
});

function write(dir, path, bytes) {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), bytes);
}

function fixture(files = UPSTREAM) {
  const repo = mkdtempSync(join(tmpdir(), 'moss-vendor-'));
  temps.push(repo);
  const upstream = join(repo, 'upstream');
  for (const [path, bytes] of Object.entries(files)) write(upstream, path, bytes);
  const root = {
    name: 'fix',
    dir: 'vendor/fix',
    upstream: 'example/fix',
    pin: 'abc1234',
    base: '',
    include: ['packages/app/src/', 'logo.png'],
    exclude: ['packages/app/src/dev/'],
  };
  repin({ repo, root, from: upstream, pin: root.pin });
  return { repo, upstream, root, vendored: (path) => join(repo, root.dir, path) };
}

const manifestOf = ({ repo, root }) => JSON.parse(readFileSync(join(repo, root.dir, 'PORTED.json'), 'utf8'));
const problemsOf = (f) => checkDrift({ repo: f.repo, root: f.root }).problems;

// Turns the fixture's verbatim Patchable.ts into a patched file: in-tree edit plus its patch.
function patchFixture() {
  const files = { ...UPSTREAM, 'packages/app/src/Patchable.ts': `${PATCHABLE.join('\n')}\n` };
  const f = fixture(files);
  const path = 'packages/app/src/Patchable.ts';
  const pristine = files[path];
  const edited = pristine.replace('line two', 'line two // moss-multi seam: test (fixture)');
  const header = readFileSync(f.vendored(path), 'utf8').split('\n')[0];
  writeFileSync(f.vendored(path), `${header}\n${edited}`);
  write(join(f.repo, 'vendor'), `patches/fix/${path}.patch`, makePatch(path, pristine, edited));
  const manifest = manifestOf(f);
  const entry = manifest.files.find((file) => file.path === path);
  entry.mode = 'patched';
  entry.patch = `patches/fix/${path}.patch`;
  writeFileSync(join(f.repo, f.root.dir, 'PORTED.json'), JSON.stringify(manifest, null, 2));
  return { ...f, path, pristine, edited };
}

describe('vendor', () => {
  it('copies the selected upstream files with ported-from headers and lists each in PORTED.json', () => {
    const f = fixture();
    expect(readFileSync(f.vendored('packages/app/src/App.tsx'), 'utf8')).toBe(
      `// ported-from: packages/app/src/App.tsx @ abc1234\n${UPSTREAM['packages/app/src/App.tsx']}`,
    );
    expect(readFileSync(f.vendored('packages/app/src/styles.css'), 'utf8')).toBe(
      `/* ported-from: packages/app/src/styles.css @ abc1234 */\n${UPSTREAM['packages/app/src/styles.css']}`,
    );
    expect(readFileSync(f.vendored('packages/app/src/mock.json'), 'utf8')).toBe(UPSTREAM['packages/app/src/mock.json']);
    expect(readFileSync(f.vendored('packages/app/src/note.md'), 'utf8')).toBe(UPSTREAM['packages/app/src/note.md']);
    expect(readFileSync(f.vendored('logo.png')).equals(UPSTREAM['logo.png'])).toBe(true);
    const manifest = manifestOf(f);
    expect(manifest.pin).toBe('abc1234');
    expect(manifest.files.map((file) => file.path)).toEqual([
      'logo.png',
      'packages/app/src/App.tsx',
      'packages/app/src/mock.json',
      'packages/app/src/note.md',
      'packages/app/src/styles.css',
    ]);
    expect(manifest.files.every((file) => file.mode === 'verbatim' && file.pin === 'abc1234')).toBe(true);
    expect(manifest.files.every((file) => /^[0-9a-f]{64}$/.test(file.upstreamSha256))).toBe(true);
  });
});

describe('drift check @p:R1', () => {
  it('passes a freshly vendored tree', () => {
    expect(problemsOf(fixture())).toEqual([]);
  });

  it('fails on a one-byte change to a verbatim file', () => {
    const f = fixture();
    const file = f.vendored('packages/app/src/App.tsx');
    writeFileSync(file, readFileSync(file, 'utf8').replace('null', 'nulL'));
    expect(problemsOf(f)).toEqual(['vendor/fix/packages/app/src/App.tsx: differs from upstream']);
  });

  it('fails on a one-byte change to a binary file', () => {
    const f = fixture();
    const bytes = readFileSync(f.vendored('logo.png'));
    bytes[bytes.length - 1] ^= 1;
    writeFileSync(f.vendored('logo.png'), bytes);
    expect(problemsOf(f)).toEqual(['vendor/fix/logo.png: differs from upstream']);
  });

  it('fails on a missing header', () => {
    const f = fixture();
    writeFileSync(f.vendored('packages/app/src/App.tsx'), UPSTREAM['packages/app/src/App.tsx']);
    expect(problemsOf(f)).toEqual(['vendor/fix/packages/app/src/App.tsx: missing ported-from header']);
  });

  it('fails on a header naming another pin or path', () => {
    const f = fixture();
    const file = f.vendored('packages/app/src/styles.css');
    writeFileSync(file, readFileSync(file, 'utf8').replace('@ abc1234', '@ 26df579d5'));
    expect(problemsOf(f)).toEqual([
      'vendor/fix/packages/app/src/styles.css: wrong ported-from header (expected "/* ported-from: packages/app/src/styles.css @ abc1234 */")',
    ]);
  });

  it('fails on an unlisted file and on a listed file that is gone', () => {
    const f = fixture();
    write(join(f.repo, f.root.dir), 'packages/app/src/Extra.ts', '// ported-from: packages/app/src/Extra.ts @ abc1234\n');
    unlinkSync(f.vendored('packages/app/src/note.md'));
    expect(problemsOf(f).sort()).toEqual([
      'vendor/fix/packages/app/src/Extra.ts: not listed in PORTED.json',
      'vendor/fix/packages/app/src/note.md: listed in PORTED.json but missing',
    ]);
  });

  it('fails when one file carries a different pin', () => {
    const f = fixture();
    const manifest = manifestOf(f);
    manifest.files[1].pin = '26df579d5';
    writeFileSync(join(f.repo, f.root.dir, 'PORTED.json'), JSON.stringify(manifest));
    expect(problemsOf(f)).toEqual(['vendor/fix/packages/app/src/App.tsx: pin 26df579d5 differs from the root pin abc1234']);
  });

  it('accepts a patched file that equals upstream plus its patch', () => {
    const f = patchFixture();
    expect(problemsOf(f)).toEqual([]);
    expect(checkDrift({ repo: f.repo, root: f.root }).patched).toBe(1);
  });

  it('fails on a patched file changed outside its patch', () => {
    const f = patchFixture();
    const file = f.vendored(f.path);
    writeFileSync(file, readFileSync(file, 'utf8').replace('line eight', 'line 8'));
    expect(problemsOf(f)).toEqual([`vendor/fix/${f.path}: does not equal upstream plus its patch`]);
  });

  it('fails on a patch file that no entry claims', () => {
    const f = fixture();
    write(join(f.repo, 'vendor'), 'patches/fix/packages/app/src/App.tsx.patch', 'stale\n');
    expect(problemsOf(f)).toEqual(['vendor/patches/fix/packages/app/src/App.tsx.patch: no patched PORTED.json entry claims it']);
  });
});

describe('pristine', () => {
  it('writes the exact upstream bytes, patches reversed and headers stripped', () => {
    const f = patchFixture();
    const out = join(f.repo, 'pristine');
    writePristine({ repo: f.repo, root: f.root, out });
    for (const path of ['packages/app/src/App.tsx', 'packages/app/src/styles.css', 'packages/app/src/mock.json', 'logo.png', f.path]) {
      expect(readFileSync(join(out, path)).equals(readFileSync(join(f.upstream, path))), path).toBe(true);
    }
  });
});

describe('repin', () => {
  it('moves every file to the new pin, carries patches by 3-way merge and reports new and deleted files', () => {
    const f = patchFixture();
    write(f.upstream, f.path, `${PATCHABLE.join('\n').replace('line eight', 'line eight, upstream')}\n`);
    write(f.upstream, 'packages/app/src/New.ts', 'export const added = 1;\n');
    unlinkSync(join(f.upstream, 'packages/app/src/note.md'));
    const report = repin({ repo: f.repo, root: f.root, from: f.upstream, pin: 'def5678' });
    expect(report).toMatchObject({ added: ['packages/app/src/New.ts'], deleted: ['packages/app/src/note.md'], conflicts: [] });
    expect(report.changed).toEqual([f.path]);
    expect(problemsOf(f)).toEqual([]);
    expect(manifestOf(f).pin).toBe('def5678');
    const merged = readFileSync(f.vendored(f.path), 'utf8');
    expect(merged.split('\n')[0]).toBe(`// ported-from: ${f.path} @ def5678`);
    expect(merged).toContain('line two // moss-multi seam: test (fixture)');
    expect(merged).toContain('line eight, upstream');
  });

  it('reports upstream drift since the pin without changing the tree', () => {
    const f = fixture();
    write(f.upstream, 'packages/app/src/App.tsx', 'export const App = () => 1;\n');
    write(f.upstream, 'packages/app/src/New.ts', 'export const added = 1;\n');
    unlinkSync(join(f.upstream, 'packages/app/src/note.md'));
    const before = readFileSync(join(f.repo, f.root.dir, 'PORTED.json'), 'utf8');
    expect(reportUpstream({ repo: f.repo, root: f.root, from: f.upstream })).toEqual({
      changed: ['packages/app/src/App.tsx'],
      added: ['packages/app/src/New.ts'],
      deleted: ['packages/app/src/note.md'],
    });
    expect(readFileSync(join(f.repo, f.root.dir, 'PORTED.json'), 'utf8')).toBe(before);
    expect(problemsOf(f)).toEqual([]);
  });
});

describe('the committed vendor tree @p:R1', () => {
  it.each(ROOTS.map((root) => [root.name, root]))('%s matches its pin with no hand-patched files', (_name, root) => {
    const result = checkDrift({ root });
    expect(result.problems).toEqual([]);
    expect(result.patched).toBe(0);
  });

  it('carries the converter split as generated files (A§12)', () => {
    const moss = ROOTS.find((root) => root.name === 'moss');
    const manifest = JSON.parse(readFileSync(join(REPO, moss.dir, 'PORTED.json'), 'utf8'));
    const byPath = new Map(manifest.files.map((entry) => [entry.path, entry]));
    const editor = 'packages/desktop/src/renderer/editor';
    for (const path of ['commands.ts', 'markdown/text-style.ts', 'markdown/transformers.ts', 'markdown/normalize.ts', 'markdown/pipeline.ts', 'nodes/node-views.ts']) {
      expect(byPath.get(`${editor}/${path}`)?.mode, path).toBe('extracted');
    }
    for (const node of ['Chart', 'CodeBlock', 'EmbedPill', 'HtmlBlockquote', 'Image', 'Sketch', 'Video', 'WebEmbed']) {
      expect(byPath.get(`${editor}/nodes/${node}Node.ts`)?.mode, node).toBe('extracted');
      expect(byPath.get(`${editor}/nodes/${node}Node.view.tsx`), node).toMatchObject({ mode: 'patched', generated: 'extract', upstreamPath: `${editor}/nodes/${node}Node.tsx` });
      expect(byPath.has(`${editor}/nodes/${node}Node.tsx`), node).toBe(false);
    }
    expect(byPath.get(`${editor}/MarkdownEditor.tsx`)).toMatchObject({ mode: 'patched', generated: 'extract' });
  });

  it('re-extraction from pristine reproduces the committed bytes (A§2.1)', () => {
    const moss = ROOTS.find((root) => root.name === 'moss');
    const repo = mkdtempSync(join(tmpdir(), 'moss-reextract-'));
    temps.push(repo);
    for (const dir of [moss.dir, 'vendor/patches', 'vendor/extract']) {
      if (existsSync(join(REPO, dir))) cpSync(join(REPO, dir), join(repo, dir), { recursive: true });
    }
    const before = snapshot(join(repo, 'vendor'));
    const report = vendor.extractRoot({ repo, root: moss });
    expect(report.conflicts).toEqual([]);
    expect(report.removed).toEqual([]);
    expect(snapshot(join(repo, 'vendor'))).toEqual(before);
  });

  it('pins moss at 762abb777 and @lexical/react at 0.48.0', () => {
    const results = Object.fromEntries(ROOTS.map((root) => [root.name, checkDrift({ root })]));
    expect(results.moss).toMatchObject({ pin: '762abb777' });
    expect(results.moss.files).toBeGreaterThan(300);
    expect(results['lexical-react']).toMatchObject({ pin: 'v0.48.0', files: 2 });
  });
});

// A small upstream with every kind of generated file: a range and a symbol take, a class/view split with a rename,
// a rerouted importer, a rewritten specifier, a side-effect import and a template.
const EX_UPSTREAM = {
  'src/editor/Editor.tsx': [
    "import { useState } from 'react';",
    "import { helper } from './util';",
    "import { ThingNode, $isThingNode } from './nodes/ThingNode';",
    "import './Editor.css';",
    '',
    "export const RULES = [ThingNode.getType(), helper('a')];",
    '',
    "const PRIVATE_SUFFIX = '!';",
    '',
    '// Joins the rules.',
    'export function describeRules(): string {',
    "  return RULES.join(',') + PRIVATE_SUFFIX;",
    '}',
    '',
    'export function Editor() {',
    '  const [n] = useState(0);',
    '  return <div>{describeRules()}{n}{String($isThingNode(null))}</div>;',
    '}',
    '',
  ].join('\n'),
  'src/editor/Editor.css': '.editor { color: red; }\n',
  'src/editor/util.ts': 'export const helper = (s: string) => s.toUpperCase();\n',
  'src/editor/nodes/ThingNode.tsx': [
    "import type { JSX } from 'react';",
    "import { OPEN } from '../plugins/Plugin';",
    '',
    'export class ThingNode {',
    "  static getType(): string { return 'thing'; }",
    "  getType(): string { return 'thing'; }",
    '  decorate(): JSX.Element {',
    "    return <ThingView label={'x'} />;",
    '  }',
    '}',
    '',
    'export function $isThingNode(node: unknown): node is ThingNode {',
    '  return node instanceof ThingNode;',
    '}',
    '',
    'function ThingView({ label }: { label: string }): JSX.Element {',
    '  return <button onClick={() => OPEN}>{label}</button>;',
    '}',
    '',
  ].join('\n'),
  'src/editor/plugins/Plugin.tsx': [
    "import { describeRules } from '../Editor';",
    "export const OPEN = 'open';",
    'export function Plugin() {',
    '  return describeRules();',
    '}',
    '',
  ].join('\n'),
  'src/editor/consumer.ts': "import { describeRules } from './Editor';\nexport const consumed = describeRules();\n",
  'src/editor/palette.ts': "import { COLORS } from '@lib';\nexport const first = COLORS[0];\n",
};

const EX_MANIFEST = {
  base: 'src/editor',
  modules: [
    { path: 'rules.ts', take: [{ from: 'Editor.tsx', range: ['RULES', 'describeRules'] }] },
    { path: 'commands.ts', take: [{ from: 'plugins/Plugin.tsx', symbols: ['OPEN'] }] },
    { path: 'nodes/ThingNode.ts', views: ['ThingNode'], take: [{ from: 'nodes/ThingNode.tsx', symbols: ['ThingNode', '$isThingNode'] }] },
  ],
  rename: { 'nodes/ThingNode.tsx': 'nodes/ThingNode.view.tsx' },
  reroute: ['consumer.ts'],
  rewrite: [{ file: 'palette.ts', from: '@lib', to: '@lib/colors' }],
  imports: { 'Editor.tsx': ['./nodes/register'] },
  templates: ['nodes/node-views.ts'],
};

const EX_TEMPLATE = [
  'export function registerNodeView(_type: string, _view: unknown): void {}',
  'export function renderNodeView<T>(_node: unknown): T {',
  '  return null as T;',
  '}',
  '',
].join('\n');

function extractFixture() {
  const repo = mkdtempSync(join(tmpdir(), 'moss-extract-'));
  temps.push(repo);
  const upstream = join(repo, 'upstream');
  for (const [path, text] of Object.entries(EX_UPSTREAM)) write(upstream, path, text);
  write(repo, 'vendor/extract/ex.json', JSON.stringify(EX_MANIFEST));
  write(repo, 'vendor/extract/ex/nodes/node-views.ts', EX_TEMPLATE);
  const root = { name: 'ex', dir: 'vendor/ex', upstream: 'example/ex', pin: 'abc1234', base: '', include: ['src/'], exclude: [], extract: 'vendor/extract/ex.json' };
  repin({ repo, root, from: upstream, pin: root.pin });
  const read = (path) => readFileSync(join(repo, root.dir, 'src/editor', path), 'utf8');
  return { repo, upstream, root, read, file: (path) => join(repo, root.dir, 'src/editor', path) };
}

describe('extract (A§2.1, A§12)', () => {
  it('moves statements byte for byte and gives each a module that imports only what it uses', () => {
    const f = extractFixture();
    const rules = f.read('rules.ts');
    expect(rules.split('\n')[0]).toBe('// ported-from: src/editor/Editor.tsx @ abc1234 (extracted)');
    expect(rules).toContain("export const RULES = [ThingNode.getType(), helper('a')];");
    expect(rules).toContain("const PRIVATE_SUFFIX = '!';");
    expect(rules).toContain("// Joins the rules.\nexport function describeRules(): string {\n  return RULES.join(',') + PRIVATE_SUFFIX;\n}");
    expect(rules).toContain("import { helper } from './util';");
    expect(rules).toContain("import { ThingNode } from './nodes/ThingNode';");
    expect(rules).not.toMatch(/from '\.\/Editor'|useState/);
  });

  it('leaves a residual that imports and re-exports what moved', () => {
    const f = extractFixture();
    const editor = f.read('Editor.tsx');
    expect(editor.split('\n')[0]).toBe('// ported-from: src/editor/Editor.tsx @ abc1234');
    expect(editor).not.toContain('export const RULES');
    expect(editor).toContain("import { describeRules } from './rules';");
    expect(editor).toContain("export { RULES, describeRules } from './rules';");
    expect(editor).toContain("import './nodes/register';");
    expect(editor).toContain("import { $isThingNode } from './nodes/ThingNode';");
    expect(editor).not.toContain("from './util'");
    expect(editor).toContain("import './Editor.css';");
    expect(f.read('plugins/Plugin.tsx')).toContain("import { describeRules } from '../rules';");
    expect(f.read('plugins/Plugin.tsx')).toContain("export { OPEN } from '../commands';");
  });

  it('splits a decorator class from its view through the registry', () => {
    const f = extractFixture();
    const node = f.read('nodes/ThingNode.ts');
    expect(node).toContain('decorate(): JSX.Element {\n    // moss-multi seam: node-views (A§12)\n    return renderNodeView(this);\n  }');
    expect(node).toContain("import { renderNodeView } from './node-views';");
    expect(node).toContain("import type { JSX } from 'react';");
    expect(node).not.toMatch(/Plugin|ThingView/);
    const view = f.read('nodes/ThingNode.view.tsx');
    expect(view.split('\n')[0]).toBe('// ported-from: src/editor/nodes/ThingNode.tsx @ abc1234');
    expect(view).toContain("registerNodeView(ThingNode.getType(), function decorate(this: ThingNode): JSX.Element {\n    return <ThingView label={'x'} />;\n  });");
    expect(view).toContain("import { OPEN } from '../commands';");
    expect(view).toContain("import { ThingNode } from './ThingNode';");
    expect(existsSync(f.file('nodes/ThingNode.tsx'))).toBe(false);
  });

  it('reroutes importers and rewrites listed specifiers', () => {
    const f = extractFixture();
    expect(f.read('consumer.ts')).toContain("import { describeRules } from './rules';");
    expect(f.read('palette.ts')).toContain("import { COLORS } from '@lib/colors';");
  });

  it('records every generated file in PORTED.json, passes drift and restores upstream in pristine', () => {
    const f = extractFixture();
    expect(problemsOf(f)).toEqual([]);
    const byPath = new Map(manifestOf(f).files.map((entry) => [entry.path, entry]));
    expect(byPath.get('src/editor/rules.ts')).toMatchObject({ mode: 'extracted', sources: ['src/editor/Editor.tsx'], symbols: ['RULES', 'PRIVATE_SUFFIX', 'describeRules'] });
    expect(byPath.get('src/editor/nodes/ThingNode.view.tsx')).toMatchObject({ mode: 'patched', generated: 'extract', upstreamPath: 'src/editor/nodes/ThingNode.tsx' });
    expect(byPath.get('src/editor/Editor.css')).toMatchObject({ mode: 'verbatim' });
    const out = join(f.repo, 'pristine');
    writePristine({ repo: f.repo, root: f.root, out });
    for (const path of Object.keys(EX_UPSTREAM)) expect(readFileSync(join(out, path), 'utf8'), path).toBe(EX_UPSTREAM[path]);
  });

  it('drift fails on a one-byte change to an extracted file', () => {
    const f = extractFixture();
    writeFileSync(f.file('rules.ts'), f.read('rules.ts').replace("'!'", "'?'"));
    expect(problemsOf(f)).toEqual(['vendor/ex/src/editor/rules.ts: does not equal a fresh extraction from pristine']);
  });

  it('drift fails when a renamed source is vendored beside its residual', () => {
    const f = extractFixture();
    write(join(f.repo, f.root.dir), 'src/editor/nodes/ThingNode.tsx', `// ported-from: src/editor/nodes/ThingNode.tsx @ abc1234\n${EX_UPSTREAM['src/editor/nodes/ThingNode.tsx']}`);
    const manifest = manifestOf(f);
    manifest.files.push({ path: 'src/editor/nodes/ThingNode.tsx', pin: 'abc1234', upstreamSha256: manifest.files.find((e) => e.upstreamPath === 'src/editor/nodes/ThingNode.tsx').upstreamSha256, mode: 'verbatim' });
    writeFileSync(join(f.repo, f.root.dir, 'PORTED.json'), JSON.stringify(manifest));
    expect(problemsOf(f)).toEqual([
      'vendor/ex/src/editor/nodes/ThingNode.tsx: its remainder is src/editor/nodes/ThingNode.view.tsx; the source itself must not be vendored',
    ]);
  });

  it('keeps a hand edit to a generated file as its seam, and repin carries it through an upstream change', () => {
    const f = extractFixture();
    writeFileSync(f.file('rules.ts'), f.read('rules.ts').replace("const PRIVATE_SUFFIX = '!';", "const PRIVATE_SUFFIX = '!'; // moss-multi seam: test (fixture)"));
    expect(problemsOf(f)).toEqual(['vendor/ex/src/editor/rules.ts: does not equal a fresh extraction from pristine']);
    expect(vendor.extractRoot({ repo: f.repo, root: f.root }).seams).toEqual(['src/editor/rules.ts']);
    expect(problemsOf(f)).toEqual([]);
    write(f.upstream, 'src/editor/Editor.tsx', EX_UPSTREAM['src/editor/Editor.tsx'].replace("RULES.join(',')", "RULES.join(';')"));
    const report = repin({ repo: f.repo, root: f.root, from: f.upstream, pin: 'def5678' });
    expect(report).toMatchObject({ changed: ['src/editor/Editor.tsx'], conflicts: [] });
    expect(problemsOf(f)).toEqual([]);
    const rules = f.read('rules.ts');
    expect(rules.split('\n')[0]).toBe('// ported-from: src/editor/Editor.tsx @ def5678 (extracted)');
    expect(rules).toContain("RULES.join(';')");
    expect(rules).toContain('// moss-multi seam: test (fixture)');
  });
});
