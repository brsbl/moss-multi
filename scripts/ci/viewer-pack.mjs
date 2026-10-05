#!/usr/bin/env node
// The viewer's release artifact (T3.8): `pnpm pack` of packages/viewer (after its build), beside the build's
// viewer.json, the tarball's SHA-256 and release.json naming the source commit. CI uploads the directory as the
// `moss-viewer` artifact; the coordinator publishes it as the GitHub Release `viewer-v<version>`.
//   node scripts/ci/viewer-pack.mjs <outDir>
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const VIEWER = fileURLToPath(new URL('../../packages/viewer/', import.meta.url));

export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** What release.json records, from the package, the build's manifest and the packed bytes. */
export function releaseRecord(pkg, manifest, tarball, bytes) {
  if (pkg.private) throw new Error(`${pkg.name} is private, so it cannot be released`);
  if (!/^\d+\.\d+\.\d+$/.test(pkg.version)) throw new Error(`${pkg.name}@${pkg.version} is not a release version`);
  if (manifest.name !== pkg.name || manifest.version !== pkg.version) {
    throw new Error(`viewer.json is ${manifest.name}@${manifest.version}, the package ${pkg.name}@${pkg.version}: rebuild`);
  }
  if (manifest.source.dirty) throw new Error('viewer.json was built from a dirty tree');
  return {
    name: pkg.name,
    version: pkg.version,
    tag: `viewer-v${pkg.version}`,
    api: manifest.api,
    tarball,
    sha256: sha256(bytes),
    bytes: bytes.length,
    source: { repo: manifest.source.repo, commit: manifest.source.commit, headSha: manifest.source.headSha },
    moss: manifest.moss,
    bundleHash: manifest.bundleHash,
  };
}

function main(outDir) {
  const out = resolve(outDir);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const pkg = JSON.parse(readFileSync(join(VIEWER, 'package.json'), 'utf8'));
  const manifest = JSON.parse(readFileSync(join(VIEWER, 'dist/viewer.json'), 'utf8'));
  const packed = spawnSync('pnpm', ['pack', '--pack-destination', out], { cwd: VIEWER, encoding: 'utf8' });
  if (packed.status !== 0) throw new Error(`pnpm pack: ${packed.stderr || packed.stdout}`);
  const [tarball, ...others] = readdirSync(out).filter((name) => name.endsWith('.tgz'));
  if (!tarball || others.length) throw new Error(`expected one tarball in ${out}`);
  const bytes = readFileSync(join(out, tarball));
  const record = releaseRecord(pkg, manifest, tarball, bytes);
  copyFileSync(join(VIEWER, 'dist/viewer.json'), join(out, 'viewer.json'));
  writeFileSync(join(out, `${tarball}.sha256`), `${record.sha256}  ${tarball}\n`);
  writeFileSync(join(out, 'release.json'), `${JSON.stringify(record, null, 2)}\n`);
  console.log(JSON.stringify(record, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main(process.argv[2] ?? 'packages/viewer/release');
  } catch (error) {
    console.error(`viewer-pack: ${error.message}`);
    process.exitCode = 1;
  }
}
