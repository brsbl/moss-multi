#!/usr/bin/env node
// Vendors moss@762abb777 and @lexical/react 0.48.0's collab plugin into vendor/ (ARCHITECTURE §2.1).
//   node scripts/moss-vendor.mjs drift [--root <name>] [--upstream <dir>]
//       CI check: every vendored file is its upstream bytes (plus its recorded patch) under a ported-from header.
//       With --upstream <snapshot dir>, also reports upstream files changed, added or deleted since the pin.
//   node scripts/moss-vendor.mjs vendor [--root <name>] [--from <dir>]
//       Re-copies the pinned upstream (default .refs/moss; lexical-react is fetched at its commit) and writes PORTED.json.
//   node scripts/moss-vendor.mjs repin <pin> --root <name> --from <dir> [--commit <sha>]
//       Moves a root to a new pin: header plus upstream bytes, a 3-way merge per patch, new and deleted files reported.
//   node scripts/moss-vendor.mjs pristine <outDir> [--root <name>]
//       Writes the upstream bytes of every vendored file in upstream layout (the Ladle oracle fallback, §22 OA1).
// Never reads ~/Code/moss. Patches live in vendor/patches/<root>/<path>.patch, made against the pristine bytes.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, extname, join, posix, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = fileURLToPath(new URL('..', import.meta.url));

// `pin` and `commit` seed the first vendor; afterwards each root's PORTED.json is the pin of record.
export const ROOTS = [
  {
    name: 'moss',
    dir: 'vendor/moss',
    upstream: 'brsbl/moss',
    pin: '762abb777',
    commit: '762abb7770714a49d912f6081384aabb958a7ea6',
    base: '',
    source: '.refs/moss',
    include: [
      'logos/moss-sprout-icon.png',
      'tsconfig.base.json', // packages/shared/tsconfig.json extends it
      'packages/shared/src/',
      'packages/shared/tailwind.config.ts',
      'packages/shared/tsconfig.json',
      'packages/desktop/src/renderer/',
      'packages/desktop/src/common/',
      'packages/desktop/src/types/electron-api.d.ts',
      'packages/desktop/src/renderer-env.d.ts',
      // Ladle inputs, so `pristine` can build the oracle without access to brsbl/moss (§22 OA1 fallback).
      '.ladle/',
      'packages/desktop/stories/',
    ],
    exclude: ['packages/desktop/src/renderer/dev/base-ui-sandbox/'],
  },
  {
    name: 'lexical-react',
    dir: 'vendor/lexical-react',
    upstream: 'facebook/lexical',
    pin: 'v0.48.0',
    commit: '284b7491d014c412a11ecc8e4b8ea8e09e07f7e9',
    base: 'packages/lexical-react/src',
    include: ['LexicalCollaborationPlugin.tsx', 'shared/useYjsCollaboration.tsx'],
    exclude: [],
  },
];

const SLASH_COMMENT = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']);
const BLOCK_COMMENT = { '.css': ['/* ', ' */'], '.html': ['<!-- ', ' -->'] };

// JSON, markdown and binaries get no header (null); they are still listed and hashed.
export function headerFor(root, path, pin) {
  const ext = extname(path);
  const text = `ported-from: ${posix.join(root.base, path)} @ ${pin}`;
  if (SLASH_COMMENT.has(ext)) return `// ${text}`;
  if (BLOCK_COMMENT[ext]) return `${BLOCK_COMMENT[ext][0]}${text}${BLOCK_COMMENT[ext][1]}`;
  return null;
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const withHeader = (header, bytes) => (header ? Buffer.concat([Buffer.from(`${header}\n`), bytes]) : bytes);
const patchesDir = (root) => posix.join(posix.dirname(root.dir), 'patches', root.name);
const patchRef = (root, path) => posix.join('patches', root.name, `${path}.patch`);

function withTemp(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'moss-vendor-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function put(file, bytes) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, bytes);
}

function walk(dir, prefix = '') {
  const files = [];
  for (const entry of readdirSync(join(dir, prefix), { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...walk(dir, path));
    else if (entry.isSymbolicLink()) throw new Error(`${join(dir, path)}: symlinks are not vendored`);
    else if (entry.name !== '.DS_Store') files.push(path);
  }
  return files;
}

function selectFiles(from, root) {
  const base = join(from, root.base);
  const files = [];
  for (const entry of root.include) {
    if (!existsSync(join(base, entry))) continue;
    if (entry.endsWith('/')) files.push(...walk(base, entry.slice(0, -1)));
    else files.push(entry);
  }
  return [...new Set(files)].filter((path) => !root.exclude.some((prefix) => path.startsWith(prefix))).sort();
}

function readManifest(repo, root) {
  const file = join(repo, root.dir, 'PORTED.json');
  if (!existsSync(file)) return null;
  const manifest = JSON.parse(readFileSync(file, 'utf8'));
  if (!manifest || typeof manifest.pin !== 'string' || !Array.isArray(manifest.files)) {
    throw new Error(`${root.dir}/PORTED.json: expected {pin, files[]}`);
  }
  return manifest;
}

// One entry per line keeps re-pin diffs readable.
function writeManifest(repo, root, manifest) {
  const { files, ...head } = manifest;
  const lines = Object.entries(head).map(([key, value]) => `  ${JSON.stringify(key)}: ${JSON.stringify(value)},`);
  const entries = files.map((file, i) => `    ${JSON.stringify(file)}${i < files.length - 1 ? ',' : ''}`);
  put(join(repo, root.dir, 'PORTED.json'), `{\n${lines.join('\n')}\n  "files": [\n${entries.join('\n')}\n  ]\n}\n`);
}

// Runs in a temp dir; the ceiling keeps git from finding an enclosing repository.
function git(args, cwd) {
  const env = { ...process.env, GIT_CEILING_DIRECTORIES: dirname(cwd) };
  const result = spawnSync('git', args, { cwd, env, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });
  if (result.error) throw result.error;
  return result;
}

// A unified diff of before → after for one vendored path, applied with `git apply` from the root.
export function makePatch(path, before, after) {
  return withTemp((dir) => {
    put(join(dir, 'a', path), before);
    put(join(dir, 'b', path), after);
    const result = git(['diff', '--no-index', '--no-color', '--no-ext-diff', '--no-prefix', '--', `a/${path}`, `b/${path}`], dir);
    if (result.status !== 0 && result.status !== 1) throw new Error(`git diff ${path}: ${result.stderr}`);
    const text = result.stdout.toString('utf8');
    if (/^Binary files /m.test(text)) throw new Error(`${path}: binary files cannot be patched`);
    return text.replace(/^index [0-9a-f]+\.\.[0-9a-f]+.*\n/m, '');
  });
}

function unpatch(path, bytes, patch) {
  return withTemp((dir) => {
    put(join(dir, path), bytes);
    put(join(dir, 'change.patch'), patch);
    const result = git(['apply', '-R', '--whitespace=nowarn', 'change.patch'], dir);
    return result.status === 0 ? readFileSync(join(dir, path)) : null;
  });
}

function merge3(path, ours, base, theirs) {
  return withTemp((dir) => {
    put(join(dir, 'ours'), ours);
    put(join(dir, 'base'), base);
    put(join(dir, 'theirs'), theirs);
    const labels = ['-L', `${path} (vendored)`, '-L', `${path} (old pin)`, '-L', `${path} (new pin)`];
    const result = git(['merge-file', '-p', ...labels, 'ours', 'base', 'theirs'], dir);
    if (result.status === null || result.status > 127) throw new Error(`git merge-file ${path}: ${result.stderr}`);
    return { bytes: result.stdout, conflicts: result.status };
  });
}

// Reads one vendored file back to its upstream bytes, or says why it cannot.
function readEntry(repo, root, manifest, entry) {
  const file = join(repo, root.dir, entry.path);
  if (!existsSync(file)) return { problem: 'listed in PORTED.json but missing' };
  let content = readFileSync(file);
  const header = headerFor(root, entry.path, manifest.pin);
  if (header) {
    const newline = content.indexOf(0x0a);
    const first = content.subarray(0, newline < 0 ? content.length : newline).toString('utf8');
    if (newline < 0 || first !== header) {
      return { problem: first.includes('ported-from:') ? `wrong ported-from header (expected "${header}")` : 'missing ported-from header' };
    }
    content = content.subarray(newline + 1);
  }
  const current = content;
  if (entry.mode === 'patched') {
    const patchFile = entry.patch ? join(repo, posix.dirname(root.dir), entry.patch) : null;
    if (!patchFile || !existsSync(patchFile)) return { problem: `patch ${entry.patch ?? '(none)'} is missing` };
    content = unpatch(entry.path, content, readFileSync(patchFile));
    if (!content) return { problem: 'does not equal upstream plus its patch' };
  } else if (entry.mode === 'extracted') {
    return { problem: 'mode extracted needs `moss-vendor.mjs extract`, which does not exist yet' };
  } else if (entry.mode !== 'verbatim' && entry.mode !== 'substituted') {
    return { problem: `unknown mode ${JSON.stringify(entry.mode)}` };
  }
  if (sha256(content) !== entry.upstreamSha256) {
    return { problem: entry.mode === 'patched' ? 'does not equal upstream plus its patch' : 'differs from upstream' };
  }
  return { pristine: content, current };
}

export function checkDrift({ repo = REPO, root }) {
  let manifest;
  try {
    manifest = readManifest(repo, root);
  } catch (error) {
    return { problems: [error.message], files: 0, patched: 0, pin: null };
  }
  if (!manifest) return { problems: [`${root.dir}/PORTED.json is missing`], files: 0, patched: 0, pin: null };
  const problems = [];
  const listed = new Set();
  const claimed = new Set();
  for (const entry of manifest.files) {
    const where = `${root.dir}/${entry.path}`;
    if (listed.has(entry.path)) problems.push(`${where}: listed twice in PORTED.json`);
    listed.add(entry.path);
    if (entry.mode === 'patched') claimed.add(entry.patch);
    if (entry.pin !== manifest.pin) problems.push(`${where}: pin ${entry.pin} differs from the root pin ${manifest.pin}`);
    const { problem } = readEntry(repo, root, manifest, entry);
    if (problem) problems.push(`${where}: ${problem}`);
  }
  for (const path of walk(join(repo, root.dir))) {
    if (path !== 'PORTED.json' && !listed.has(path)) problems.push(`${root.dir}/${path}: not listed in PORTED.json`);
  }
  const patches = join(repo, patchesDir(root));
  if (existsSync(patches)) {
    for (const path of walk(patches)) {
      const ref = posix.join('patches', root.name, path);
      if (!claimed.has(ref)) problems.push(`${patchesDir(root)}/${path}: no patched PORTED.json entry claims it`);
    }
  }
  const patched = manifest.files.filter((entry) => entry.mode === 'patched').length;
  return { problems, files: manifest.files.length, patched, pin: manifest.pin };
}

function assertClean(repo, root) {
  const { problems } = checkDrift({ repo, root });
  if (problems.length > 0) throw new Error(`${root.dir} has drifted; fix it before re-pinning:\n  ${problems.join('\n  ')}`);
}

// Writes header plus upstream bytes for every selected file at `pin`, carrying each patch by a 3-way merge.
export function repin({ repo = REPO, root, from, pin, commit = pin }) {
  const old = readManifest(repo, root);
  if (old) assertClean(repo, root);
  const oldEntries = new Map((old?.files ?? []).map((entry) => [entry.path, entry]));
  if ([...oldEntries.values()].some((entry) => entry.mode === 'extracted')) {
    throw new Error('extracted files need `moss-vendor.mjs extract`, which does not exist yet');
  }
  const selected = selectFiles(from, root);
  const report = { pin, files: selected.length, added: [], deleted: [], changed: [], conflicts: [], patched: [] };
  const files = [];
  for (const path of selected) {
    const upstream = readFileSync(join(from, root.base, path));
    const header = headerFor(root, path, pin);
    if (header && (upstream.subarray(0, 2).toString() === '#!' || upstream.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])))) {
      throw new Error(`${path}: starts with a shebang or BOM, so a line-1 header would break it`);
    }
    const entry = { path, pin, upstreamSha256: sha256(upstream), mode: 'verbatim' };
    const was = oldEntries.get(path);
    if (old && !was) report.added.push(path);
    if (was && was.upstreamSha256 !== entry.upstreamSha256) report.changed.push(path);
    let body = upstream;
    if (was?.mode === 'patched') {
      const { pristine, current } = readEntry(repo, root, old, was);
      const merged = merge3(path, current, pristine, upstream);
      body = merged.bytes;
      if (merged.conflicts > 0) report.conflicts.push(path);
      const patchFile = join(repo, patchesDir(root), `${path}.patch`);
      rmSync(join(repo, posix.dirname(root.dir), was.patch), { force: true });
      if (!body.equals(upstream)) {
        put(patchFile, makePatch(path, upstream, body));
        Object.assign(entry, { mode: 'patched', patch: patchRef(root, path) });
        report.patched.push(path);
      }
    } else if (was?.mode === 'substituted') {
      entry.mode = 'substituted';
    }
    put(join(repo, root.dir, path), withHeader(header, body));
    files.push(entry);
  }
  const keep = new Set(selected);
  for (const [path, entry] of oldEntries) {
    if (keep.has(path)) continue;
    report.deleted.push(path);
    rmSync(join(repo, root.dir, path), { force: true });
    if (entry.patch) rmSync(join(repo, posix.dirname(root.dir), entry.patch), { force: true });
  }
  writeManifest(repo, root, { upstream: root.upstream, pin, commit, base: root.base, files });
  return report;
}

// Upstream bytes of every vendored file, in upstream layout under `out`.
export function writePristine({ repo = REPO, root, out }) {
  const manifest = readManifest(repo, root);
  if (!manifest) throw new Error(`${root.dir}/PORTED.json is missing`);
  assertClean(repo, root);
  let count = 0;
  for (const entry of manifest.files) {
    if (entry.mode === 'extracted') continue;
    put(join(out, root.base, entry.path), readEntry(repo, root, manifest, entry).pristine);
    count += 1;
  }
  return { files: count };
}

// What changed upstream since the pin, for files under the vendored roots. Changes nothing.
export function reportUpstream({ repo = REPO, root, from }) {
  const manifest = readManifest(repo, root);
  if (!manifest) throw new Error(`${root.dir}/PORTED.json is missing`);
  const upstream = new Set(selectFiles(from, root));
  const vendored = manifest.files.filter((entry) => entry.mode !== 'extracted');
  const listed = new Set(vendored.map((entry) => entry.path));
  return {
    changed: vendored
      .filter((entry) => upstream.has(entry.path))
      .filter((entry) => sha256(readFileSync(join(from, root.base, entry.path))) !== entry.upstreamSha256)
      .map((entry) => entry.path),
    added: [...upstream].filter((path) => !listed.has(path)),
    deleted: vendored.filter((entry) => !upstream.has(entry.path)).map((entry) => entry.path),
  };
}

function checkSource(from) {
  const forbidden = join(homedir(), 'Code', 'moss');
  const real = existsSync(from) ? realpathSync(from) : resolve(from);
  if (real === forbidden || real.startsWith(forbidden + sep)) {
    throw new Error('never read ~/Code/moss; use .refs/moss or a git archive of a temp clone (ARCHITECTURE §2.1)');
  }
  if (!existsSync(from)) throw new Error(`${from}: no such source directory`);
  return real;
}

// Fetches a root's listed files at a commit from GitHub, for roots with no local snapshot.
async function fetchSnapshot(root, commit, dir) {
  for (const path of root.include) {
    if (path.endsWith('/')) throw new Error(`${root.name}: cannot fetch directory ${path}; pass --from`);
    const url = `https://raw.githubusercontent.com/${root.upstream}/${commit}/${posix.join(root.base, path)}`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
    put(join(dir, root.base, path), Buffer.from(await response.arrayBuffer()));
  }
}

function parseArgs(argv) {
  const args = { positional: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = /^--(root|from|upstream|commit)$/.exec(argv[i]);
    if (!flag) {
      if (argv[i].startsWith('--')) throw new Error(`unknown option ${argv[i]}`);
      args.positional.push(argv[i]);
      continue;
    }
    if (argv[i + 1] === undefined) throw new Error(`${argv[i]} needs a value`);
    args[flag[1]] = argv[i + 1];
    i += 1;
  }
  return args;
}

function rootNamed(name) {
  const root = ROOTS.find((candidate) => candidate.name === name);
  if (!root) throw new Error(`unknown root ${name}; expected ${ROOTS.map((r) => r.name).join(' or ')}`);
  return root;
}

function printReport(root, report) {
  const counts = ['changed', 'added', 'deleted', 'patched'].map((key) => `${report[key].length} ${key}`).join(', ');
  console.log(`${root.name} @ ${report.pin}: ${report.files} files; ${counts}`);
  for (const key of ['added', 'deleted', 'conflicts']) {
    for (const path of report[key]) console.log(`  ${key === 'conflicts' ? 'CONFLICT' : key} ${path}`);
  }
  return report.conflicts.length;
}

const USAGE = 'usage: moss-vendor.mjs drift|vendor|repin <pin>|pristine <outDir> [--root moss|lexical-react] [--from <dir>] [--upstream <dir>] [--commit <sha>]';

async function main(argv) {
  const [mode, ...rest] = argv;
  const args = parseArgs(rest);
  if (mode === 'drift') {
    const roots = args.root ? [rootNamed(args.root)] : args.upstream ? [rootNamed('moss')] : ROOTS;
    let failed = false;
    for (const root of roots) {
      const result = checkDrift({ root });
      failed ||= result.problems.length > 0;
      console.log(`drift ${root.name}: ${result.files} files, ${result.patched} patched, pin ${result.pin ?? '?'}: ${result.problems.length > 0 ? 'FAIL' : 'ok'}`);
      for (const problem of result.problems) console.log(`  FAIL ${problem}`);
      if (args.upstream) {
        const report = reportUpstream({ root, from: checkSource(args.upstream) });
        console.log(`upstream since ${result.pin}: ${report.changed.length} changed, ${report.added.length} added, ${report.deleted.length} deleted`);
        for (const key of ['changed', 'added', 'deleted']) for (const path of report[key]) console.log(`  ${key} ${path}`);
      }
    }
    return failed ? 1 : 0;
  }
  if (mode === 'vendor' || mode === 'repin') {
    const roots = args.root ? [rootNamed(args.root)] : ROOTS;
    if (args.from && roots.length > 1) throw new Error('--from needs --root');
    if (mode === 'repin' && (!args.positional[0] || !args.root)) throw new Error('repin needs <pin> and --root');
    // A local snapshot is at the old pin, so re-pinning a root that has one needs --from.
    if (mode === 'repin' && roots[0].source && !args.from) throw new Error(`repin ${roots[0].name} needs --from <snapshot at the new pin>`);
    let conflicts = 0;
    for (const root of roots) {
      const current = readManifest(REPO, root);
      const pin = mode === 'repin' ? args.positional[0] : (current?.pin ?? root.pin);
      const commit = args.commit ?? (mode === 'repin' ? pin : (current?.commit ?? root.commit));
      const run = (from) => {
        conflicts += printReport(root, repin({ root, from, pin, commit }));
      };
      if (args.from || root.source) run(checkSource(args.from ?? join(REPO, root.source)));
      else await withTempAsync((dir) => fetchSnapshot(root, commit, dir).then(() => run(dir)));
    }
    if (conflicts > 0) console.log(`${conflicts} patch conflict(s): resolve the markers, then run drift`);
    return conflicts > 0 ? 1 : 0;
  }
  if (mode === 'pristine') {
    const out = args.positional[0];
    if (!out) throw new Error('pristine needs <outDir>');
    const root = rootNamed(args.root ?? 'moss');
    const { files } = writePristine({ root, out: resolve(out) });
    console.log(`pristine ${root.name}: ${files} files written to ${resolve(out)}`);
    return 0;
  }
  console.error(USAGE);
  return 2;
}

async function withTempAsync(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'moss-vendor-'));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error(`moss-vendor: ${error.message}`);
      process.exitCode = 1;
    },
  );
}
