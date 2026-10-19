#!/usr/bin/env node
// The editor's release artifact (T3.9): `moss-editor-<version>.tgz`, which unpacks to `moss-editor/` (the built
// dist/ with editor.json at its root, plus LICENSE and CHANGELOG.md), beside editor.json, SHA256SUMS and
// release.json naming the source commit and the CI run. CI uploads the
// directory as the `moss-editor` artifact; the coordinator publishes it as the GitHub Release `editor-v<version>`.
//   node scripts/ci/editor-pack.mjs <outDir>
import { spawnSync } from 'node:child_process';
import { copyFileSync, cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { sha256 } from './viewer-pack.mjs';

const EDITOR = fileURLToPath(new URL('../../packages/editor/', import.meta.url));

/** What release.json records, from the package, the build's manifest and the packed bytes. */
export function editorReleaseRecord(pkg, manifest, tarball, bytes) {
  if (!/^\d+\.\d+\.\d+$/.test(pkg.version)) throw new Error(`${pkg.name}@${pkg.version} is not a release version`);
  if (manifest.name !== pkg.name || manifest.version !== pkg.version) {
    throw new Error(`editor.json is ${manifest.name}@${manifest.version}, the package ${pkg.name}@${pkg.version}: rebuild`);
  }
  if (manifest.api !== 2) throw new Error(`editor.json declares API ${manifest.api}; this release line is API 2`);
  if (manifest.source.dirty) throw new Error('editor.json was built from a dirty tree');
  for (const file of [manifest.entry, manifest.css, manifest.hostEntry, manifest.htmlFrame?.file]) {
    if (!manifest.files[file]) throw new Error(`editor.json lists no ${file}`);
  }
  return {
    name: pkg.name,
    version: pkg.version,
    tag: `editor-v${pkg.version}`,
    api: manifest.api,
    features: manifest.features,
    tarball,
    sha256: sha256(bytes),
    bytes: bytes.length,
    source: { repo: manifest.source.repo, commit: manifest.source.commit, headSha: manifest.source.headSha },
    moss: manifest.moss,
    build: manifest.build,
    bundleHash: manifest.bundleHash,
  };
}

function main(outDir) {
  const out = resolve(outDir);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const pkg = JSON.parse(readFileSync(join(EDITOR, 'package.json'), 'utf8'));
  const manifest = JSON.parse(readFileSync(join(EDITOR, 'dist/editor.json'), 'utf8'));
  const stage = join(out, 'moss-editor');
  cpSync(join(EDITOR, 'dist'), stage, { recursive: true });
  copyFileSync(join(EDITOR, '../../LICENSE'), join(stage, 'LICENSE'));
  copyFileSync(join(EDITOR, 'CHANGELOG.md'), join(stage, 'CHANGELOG.md'));
  const tarball = `moss-editor-${pkg.version}.tgz`;
  const packed = spawnSync('tar', ['-czf', tarball, 'moss-editor'], { cwd: out, encoding: 'utf8' });
  if (packed.status !== 0) throw new Error(`tar: ${packed.stderr || packed.stdout}`);
  rmSync(stage, { recursive: true, force: true });
  const bytes = readFileSync(join(out, tarball));
  const record = editorReleaseRecord(pkg, manifest, tarball, bytes);
  copyFileSync(join(EDITOR, 'dist/editor.json'), join(out, 'editor.json'));
  writeFileSync(join(out, 'SHA256SUMS'), `${record.sha256}  ${tarball}\n`);
  writeFileSync(join(out, 'release.json'), `${JSON.stringify(record, null, 2)}\n`);
  console.log(JSON.stringify(record, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main(process.argv[2] ?? 'packages/editor/release');
  } catch (error) {
    console.error(`editor-pack: ${error.message}`);
    process.exitCode = 1;
  }
}
