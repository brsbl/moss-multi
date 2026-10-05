// The viewer's release (T3.8): a publishable 1.0.0 package whose tarball carries only the self-contained bundle,
// and a release record that ties the tarball's SHA-256 to the build's viewer.json and source commit.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { releaseRecord, sha256 } from './viewer-pack.mjs';

const pkg = JSON.parse(readFileSync(new URL('../../packages/viewer/package.json', import.meta.url), 'utf8'));

const manifest = (over = {}) => ({
  name: '@moss-multi/viewer',
  version: '1.0.0',
  api: 1,
  moss: { upstream: 'brsbl/moss', pin: '762abb777', commit: '762abb7770714a49d912f6081384aabb958a7ea6' },
  source: { repo: 'brsbl/moss-multi', commit: 'a'.repeat(40), headSha: 'a'.repeat(40), dirty: false, diffHash: '' },
  bundleHash: 'b'.repeat(64),
  ...over,
});

describe('packages/viewer/package.json', () => {
  it('is the public 1.0.0 release', () => {
    expect(pkg.version).toBe('1.0.0');
    expect(pkg.private).not.toBe(true);
    expect(pkg.license).toBe('MIT');
  });

  it('packs the built bundle and its release notes, and exports its entry, stylesheet, frame document and manifest', () => {
    expect(pkg.files).toEqual(['dist', 'CHANGELOG.md']);
    expect(pkg.exports).toEqual({
      '.': './dist/moss-viewer.js',
      './moss-viewer.css': './dist/moss-viewer.css',
      './moss-viewer-frame.html': './dist/moss-viewer-frame.html',
      './viewer.json': './dist/viewer.json',
    });
  });

  it('installs nothing: the bundle carries its dependencies', () => {
    expect(pkg.dependencies ?? {}).toEqual({});
  });
});

describe('releaseRecord', () => {
  const bytes = Buffer.from('tarball bytes');
  const publishable = { name: '@moss-multi/viewer', version: '1.0.0' };

  it("names the tarball's SHA-256, the source commit and the release tag", () => {
    expect(releaseRecord(publishable, manifest(), 'moss-multi-viewer-1.0.0.tgz', bytes)).toEqual({
      name: '@moss-multi/viewer',
      version: '1.0.0',
      tag: 'viewer-v1.0.0',
      api: 1,
      tarball: 'moss-multi-viewer-1.0.0.tgz',
      sha256: sha256(bytes),
      bytes: bytes.length,
      source: { repo: 'brsbl/moss-multi', commit: 'a'.repeat(40), headSha: 'a'.repeat(40) },
      moss: manifest().moss,
      bundleHash: 'b'.repeat(64),
    });
    expect(sha256(bytes)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('refuses a private package, a prerelease, a stale manifest and a dirty build', () => {
    expect(() => releaseRecord({ ...publishable, private: true }, manifest(), 'x.tgz', bytes)).toThrow(/private/);
    expect(() => releaseRecord({ ...publishable, version: '1.0.0-rc.1' }, manifest(), 'x.tgz', bytes)).toThrow(/release version/);
    expect(() => releaseRecord(publishable, manifest({ version: '0.2.0' }), 'x.tgz', bytes)).toThrow(/rebuild/);
    expect(() => releaseRecord(publishable, manifest({ source: { ...manifest().source, dirty: true } }), 'x.tgz', bytes)).toThrow(/dirty/);
  });
});
