import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkDrift, makePatch, repin, reportUpstream, ROOTS, writePristine } from './moss-vendor.mjs';

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
  it.each(ROOTS.map((root) => [root.name, root]))('%s matches its pin with no patched files', (_name, root) => {
    const result = checkDrift({ root });
    expect(result.problems).toEqual([]);
    expect(result.patched).toBe(0);
  });

  it('pins moss at 762abb777 and @lexical/react at 0.48.0', () => {
    const results = Object.fromEntries(ROOTS.map((root) => [root.name, checkDrift({ root })]));
    expect(results.moss).toMatchObject({ pin: '762abb777' });
    expect(results.moss.files).toBeGreaterThan(300);
    expect(results['lexical-react']).toMatchObject({ pin: 'v0.48.0', files: 2 });
  });
});
