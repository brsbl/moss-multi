#!/usr/bin/env node
// The CLI's release artifact (T7.P3, docs/SYNC.md): the bundled packages/cli/dist/moss-multi.mjs, one self-contained
// file with no install step, beside the service wrappers, SHA256SUMS and release.json naming the source commit. It is
// checked as a replica installs it: copied alone into an empty folder, where `moss-multi --version` must name the
// commit it was built from. CI uploads the directory as the `moss-multi-cli` artifact.
//   node scripts/ci/cli-pack.mjs <outDir>
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = fileURLToPath(new URL('../../', import.meta.url));
const CLI = join(REPO, 'packages/cli');
const BUNDLE = 'moss-multi.mjs';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** The commit the bundle must name: a pull request's head, else the checkout's HEAD. */
const sourceCommit = () => process.env.MOSS_PR_HEAD_SHA || execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).trim();

function main(outDir) {
  const out = resolve(outDir);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const pkg = JSON.parse(readFileSync(join(CLI, 'package.json'), 'utf8'));
  const node = readFileSync(join(REPO, '.node-version'), 'utf8').trim();
  const commit = sourceCommit();

  copyFileSync(join(CLI, 'dist', BUNDLE), join(out, BUNDLE));
  chmodSync(join(out, BUNDLE), 0o755);
  for (const name of readdirSync(join(CLI, 'service'))) copyFileSync(join(CLI, 'service', name), join(out, name));
  chmodSync(join(out, 'moss-multi-watch.sh'), 0o755);

  // As installed: the bundle alone in an empty folder, with no node_modules anywhere above it.
  const alone = mkdtempSync(join(tmpdir(), 'moss-multi-cli-'));
  try {
    copyFileSync(join(out, BUNDLE), join(alone, BUNDLE));
    const run = spawnSync(process.execPath, [join(alone, BUNDLE), '--version'], { cwd: alone, env: { PATH: process.env.PATH ?? '', HOME: alone }, encoding: 'utf8', timeout: 30_000 });
    const want = `moss-multi ${pkg.version} (commit ${commit})\n`;
    if (run.status !== 0 || run.stdout !== want) {
      throw new Error(`the bundle run alone printed ${JSON.stringify(run.stdout)} (exit ${run.status}; ${run.stderr.trim()}), not ${JSON.stringify(want)}`);
    }
  } finally {
    rmSync(alone, { recursive: true, force: true });
  }

  const files = readdirSync(out).sort();
  const sums = files.map((name) => `${sha256(readFileSync(join(out, name)))}  ${name}\n`).join('');
  writeFileSync(join(out, 'SHA256SUMS'), sums);
  const bundle = readFileSync(join(out, BUNDLE));
  const record = { name: 'moss-multi', version: pkg.version, commit, node: `>=${node}`, file: BUNDLE, sha256: sha256(bundle), bytes: bundle.length };
  writeFileSync(join(out, 'release.json'), `${JSON.stringify(record, null, 2)}\n`);
  console.log(JSON.stringify(record, null, 2));
  process.stdout.write(sums);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main(process.argv[2] ?? 'packages/cli/release');
  } catch (error) {
    console.error(`cli-pack: ${error.message}`);
    process.exit(1);
  }
}
