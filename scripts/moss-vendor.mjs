#!/usr/bin/env node
// Vendors moss@762abb777 and @lexical/react 0.48.0's collab plugin into vendor/ (ARCHITECTURE §2.1).
// Tests-first harness: the drift check below does not verify bytes or headers yet.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('..', import.meta.url));

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
      'tsconfig.base.json',
      'packages/shared/src/',
      'packages/shared/tailwind.config.ts',
      'packages/shared/tsconfig.json',
      'packages/desktop/src/renderer/',
      'packages/desktop/src/common/',
      'packages/desktop/src/types/electron-api.d.ts',
      'packages/desktop/src/renderer-env.d.ts',
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

export function headerFor(root, path, pin) {
  const ext = extname(path);
  const text = `ported-from: ${posix.join(root.base, path)} @ ${pin}`;
  if (SLASH_COMMENT.has(ext)) return `// ${text}`;
  if (BLOCK_COMMENT[ext]) return `${BLOCK_COMMENT[ext][0]}${text}${BLOCK_COMMENT[ext][1]}`;
  return null;
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

function walk(dir, prefix = '') {
  const files = [];
  for (const entry of readdirSync(join(dir, prefix), { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...walk(dir, path));
    else if (entry.name !== '.DS_Store') files.push(path);
  }
  return files;
}

function selectFiles(from, root) {
  const base = join(from, root.base);
  const files = [];
  for (const entry of root.include) {
    if (entry.endsWith('/')) {
      if (existsSync(join(base, entry))) files.push(...walk(base, entry.slice(0, -1)));
    } else if (existsSync(join(base, entry))) {
      files.push(entry);
    }
  }
  return [...new Set(files)].filter((path) => !root.exclude.some((prefix) => path.startsWith(prefix))).sort();
}

export function repin({ repo = REPO, root, from, pin, commit = pin }) {
  const files = [];
  for (const path of selectFiles(from, root)) {
    const upstream = readFileSync(join(from, root.base, path));
    const header = headerFor(root, path, pin);
    const target = join(repo, root.dir, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, header ? Buffer.concat([Buffer.from(`${header}\n`), upstream]) : upstream);
    files.push({ path, pin, upstreamSha256: sha256(upstream), mode: 'verbatim' });
  }
  const manifest = { upstream: root.upstream, pin, commit, base: root.base, files };
  writeFileSync(join(repo, root.dir, 'PORTED.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return { pin, added: [], deleted: [], changed: [], conflicts: [] };
}

export function checkDrift({ repo = REPO, root }) {
  const file = join(repo, root.dir, 'PORTED.json');
  if (!existsSync(file)) return { problems: [`${root.dir}/PORTED.json is missing`], files: 0, patched: 0, pin: null };
  const manifest = JSON.parse(readFileSync(file, 'utf8'));
  return { problems: [], files: manifest.files.length, patched: 0, pin: manifest.pin };
}

export function makePatch() {
  throw new Error('makePatch: not implemented yet');
}

export function writePristine() {
  throw new Error('pristine: not implemented yet');
}

export function reportUpstream() {
  throw new Error('drift --upstream: not implemented yet');
}
