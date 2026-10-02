import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { checkSingleVersions, parseLockfile } from './single-version.mjs';

const SCRIPT = fileURLToPath(new URL('./single-version.mjs', import.meta.url));
const SPLIT = fileURLToPath(new URL('./fixtures/pnpm-lock.split.yaml', import.meta.url));

function lockfile({ overrides = { lexical: '0.48.0', yjs: '13.6.31' }, packages = [] } = {}) {
  const lines = ["lockfileVersion: '9.0'", '', 'settings:', '  autoInstallPeers: true', ''];
  if (Object.keys(overrides).length > 0) {
    lines.push('overrides:');
    for (const [name, version] of Object.entries(overrides)) lines.push(`  '${name}': ${version}`);
    lines.push('');
  }
  lines.push('importers:', '', '  .: {}', '', 'packages:', '');
  for (const key of packages) lines.push(`  '${key}':`, '    resolution: {integrity: sha512-fixture}', '');
  lines.push('snapshots:', '');
  for (const key of packages) lines.push(`  '${key}': {}`, '');
  return lines.join('\n');
}

describe('parseLockfile', () => {
  it('reads overrides and resolved versions', () => {
    const lock = parseLockfile(readFileSync(SPLIT, 'utf8'));
    expect(lock.version).toBe('9.0');
    expect(lock.overrides.get('lexical')).toBe('0.48.0');
    expect([...lock.packages.get('lexical')].sort()).toEqual(['0.45.0', '0.48.0']);
    expect([...lock.packages.get('@lexical/yjs')]).toEqual(['0.48.0']);
    expect([...lock.packages.get('yjs')].sort()).toEqual(['13.6.27', '13.6.31']);
  });
});

describe('checkSingleVersions', () => {
  it('is red on a fixture lockfile with two lexical and two yjs versions', () => {
    const { problems } = checkSingleVersions(readFileSync(SPLIT, 'utf8'));
    expect(problems.some((p) => /^lexical resolves to 2 versions/.test(p))).toBe(true);
    expect(problems.some((p) => /^yjs resolves to 2 versions/.test(p))).toBe(true);
  });

  it('passes one version of each', () => {
    const text = lockfile({
      overrides: { lexical: '0.48.0', '@lexical/utils': '0.48.0', '@lexical/yjs': '0.48.0', yjs: '13.6.31' },
      packages: ['lexical@0.48.0', '@lexical/utils@0.48.0', '@lexical/yjs@0.48.0', 'yjs@13.6.31'],
    });
    const { problems, resolved } = checkSingleVersions(text);
    expect(problems).toEqual([]);
    expect(resolved.get('lexical')).toEqual(['0.48.0']);
    expect(resolved.get('yjs')).toEqual(['13.6.31']);
  });

  it('passes before any tracked package is installed, as long as the pins exist', () => {
    expect(checkSingleVersions(lockfile()).problems).toEqual([]);
  });

  it('requires the lexical and yjs overrides', () => {
    const { problems } = checkSingleVersions(lockfile({ overrides: {}, packages: ['lexical@0.48.0', 'yjs@13.6.31'] }));
    expect(problems).toContain('pnpm override missing for lexical');
    expect(problems).toContain('pnpm override missing for yjs');
  });

  it('flags a resolution that differs from its override', () => {
    const { problems } = checkSingleVersions(lockfile({ packages: ['lexical@0.47.0', 'yjs@13.6.31'] }));
    expect(problems).toContain('lexical resolves to 0.47.0 but is overridden to 0.48.0');
  });

  it('flags a @lexical package with no override, since overrides have no wildcard', () => {
    const { problems } = checkSingleVersions(lockfile({ packages: ['lexical@0.48.0', '@lexical/offset@0.48.0'] }));
    expect(problems).toContain('@lexical/offset has no pnpm override');
  });

  it('flags Lexical packages that disagree with each other', () => {
    const text = lockfile({
      overrides: { lexical: '0.48.0', '@lexical/utils': '0.47.0', yjs: '13.6.31' },
      packages: ['lexical@0.48.0', '@lexical/utils@0.47.0'],
    });
    expect(checkSingleVersions(text).problems).toContain('Lexical packages span versions 0.47.0, 0.48.0');
  });

  it('refuses a lockfile format it cannot read', () => {
    expect(checkSingleVersions("lockfileVersion: '6.0'\n").problems).toContain('unsupported lockfileVersion 6.0');
  });
});

describe('CLI', () => {
  it('exits 1 and names the split package on the fixture lockfile', () => {
    let failure;
    try {
      execFileSync(process.execPath, [SCRIPT, SPLIT], { encoding: 'utf8', stdio: 'pipe' });
    } catch (error) {
      failure = error;
    }
    expect(failure?.status).toBe(1);
    expect(`${failure?.stdout}${failure?.stderr}`).toMatch(/lexical resolves to 2 versions/);
  });
});
