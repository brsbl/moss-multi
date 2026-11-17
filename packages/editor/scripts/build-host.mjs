#!/usr/bin/env node
// Assembles the moss-editor-host artifact in dist/moss-editor-host/: moss-editor-host.js (copied byte for byte),
// contract.d.ts (emitted first by `tsc -p tsconfig.contract.json`), LICENSE, and editor-host.json recording the
// version, API, moss pin, source commit and the SHA-256 of every file.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const pkgDir = fileURLToPath(new URL('..', import.meta.url));
const repo = fileURLToPath(new URL('../../..', import.meta.url));
const out = `${pkgDir}dist/moss-editor-host`;
const FILES = ['LICENSE', 'contract.d.ts', 'moss-editor-host.js'];

copyFileSync(`${pkgDir}src/host/moss-editor-host.js`, `${out}/moss-editor-host.js`);
copyFileSync(`${repo}LICENSE`, `${out}/LICENSE`);
const present = readdirSync(out).filter((name) => name !== 'editor-host.json').sort();
if (present.join() !== FILES.join()) throw new Error(`build-host: expected ${FILES.join(', ')}, found ${present.join(', ')}`);

const host = await import(`${out}/moss-editor-host.js`);
const pkg = JSON.parse(readFileSync(`${pkgDir}package.json`, 'utf8'));
if (host.MOSS_EDITOR_INFO.version !== pkg.version) throw new Error(`build-host: MOSS_EDITOR_INFO.version ${host.MOSS_EDITOR_INFO.version} != package ${pkg.version}`);

const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
const commit = git('rev-parse', 'HEAD');
const ported = JSON.parse(readFileSync(`${repo}vendor/moss/PORTED.json`, 'utf8'));
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const record = {
  name: '@moss-multi/editor-host',
  version: pkg.version,
  api: host.MOSS_EDITOR_API,
  entry: 'moss-editor-host.js',
  types: 'contract.d.ts',
  moss: { upstream: ported.upstream, pin: ported.pin, commit: ported.commit },
  source: {
    repo: 'brsbl/moss-multi',
    commit,
    headSha: process.env.MOSS_PR_HEAD_SHA || commit,
    dirty: git('status', '--porcelain', '--untracked-files=no').length > 0,
  },
  build: { run: process.env.GITHUB_RUN_ID ? `https://github.com/brsbl/moss-multi/actions/runs/${process.env.GITHUB_RUN_ID}` : null },
  files: Object.fromEntries(
    FILES.map((name) => {
      const bytes = readFileSync(`${out}/${name}`);
      return [name, { bytes: bytes.length, sha256: sha256(bytes) }];
    }),
  ),
};
writeFileSync(`${out}/editor-host.json`, `${JSON.stringify(record, null, 2)}\n`);
console.log(JSON.stringify(record, null, 2));
