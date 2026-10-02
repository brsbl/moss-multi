// Build provenance (A§4.1, S-test §2.4). The Worker gets every field through __MOSS_BUILD__; the client gets
// only commit and clientHash. Hashes are taken over the output with the placeholders in place, then filled in,
// so the same sources hash the same on any machine. The client builds before the Worker (Start's buildApp).
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Plugin } from 'vite';

// Same length as the values that replace them, so columns don't shift.
export const BUNDLE_HASH_SLOT = 'moss-bundle-hash:'.padEnd(64, '0');
export const CLIENT_HASH_SLOT = 'moss-client-hash:'.padEnd(64, '0');
export const BUILD_TIME_SLOT = 'moss-build-time:'.padEnd(24, '0');

interface Source {
  commit: string;
  headSha: string;
  dirty: boolean;
  diffHash: string;
  env: string;
}

const git = (root: string, args: string[]) =>
  execFileSync('git', args, { cwd: root, encoding: 'buffer', maxBuffer: 256 * 1024 * 1024 });

export function readSource(root: string, environ: NodeJS.ProcessEnv = process.env): Source {
  const commit = git(root, ['rev-parse', 'HEAD']).toString().trim();
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error(`provenance: no full commit SHA (got ${JSON.stringify(commit)})`);
  const dirty = git(root, ['status', '--porcelain']).length > 0;
  let diffHash = '';
  if (dirty) {
    const digest = createHash('sha256').update(git(root, ['diff', 'HEAD', '--binary']));
    const untracked = git(root, ['ls-files', '--others', '--exclude-standard', '-z']).toString().split('\0').filter(Boolean);
    for (const path of untracked.sort()) digest.update(`\0${path}\0`).update(readFileSync(join(root, path)));
    diffHash = digest.digest('hex');
  }
  return {
    commit,
    headSha: environ.MOSS_PR_HEAD_SHA || commit,
    dirty,
    diffHash,
    env: environ.CLOUDFLARE_ENV || environ.MOSS_BUILD_ENV || 'local',
  };
}

const count = (text: string, slot: string) => text.split(slot).length - 1;

function hashOutputs(entries: Array<{ fileName: string; content: string | Uint8Array }>): string {
  const digest = createHash('sha256');
  for (const { fileName, content } of [...entries].sort((a, b) => (a.fileName < b.fileName ? -1 : 1))) {
    const bytes = typeof content === 'string' ? Buffer.from(content) : content;
    digest.update(`${fileName}\0${bytes.length}\0`).update(bytes);
  }
  return digest.digest('hex');
}

export function provenance(repoRoot: string): Plugin {
  const source = readSource(repoRoot);
  let clientHash: string | null = null;

  return {
    name: 'moss-provenance',
    enforce: 'post',
    sharedDuringBuild: true,
    configEnvironment(name) {
      const build =
        name === 'client'
          ? { commit: source.commit, clientHash: CLIENT_HASH_SLOT }
          : { ...source, bundleHash: BUNDLE_HASH_SLOT, clientHash: CLIENT_HASH_SLOT, buildTime: BUILD_TIME_SLOT };
      return { define: { __MOSS_BUILD__: JSON.stringify(build) } };
    },
    generateBundle(_options, bundle) {
      if (this.environment.config.command !== 'build') return;
      const outputs = Object.values(bundle);
      const chunks = outputs.flatMap((output) => (output.type === 'chunk' ? [output] : []));
      const slots = (slot: string) => chunks.reduce((sum, chunk) => sum + count(chunk.code, slot), 0);

      if (this.environment.name === 'client') {
        if (slots(CLIENT_HASH_SLOT) !== 1) throw new Error(`provenance: client has ${slots(CLIENT_HASH_SLOT)} clientHash slots, expected 1`);
        clientHash = hashOutputs(
          outputs.map((output) => ({ fileName: output.fileName, content: output.type === 'chunk' ? output.code : output.source })),
        );
        for (const chunk of chunks) chunk.code = chunk.code.replace(CLIENT_HASH_SLOT, clientHash);
        return;
      }

      const found = [BUNDLE_HASH_SLOT, CLIENT_HASH_SLOT, BUILD_TIME_SLOT].map(slots);
      if (found.every((n) => n === 0)) return; // an environment without the Worker entry
      if (found.some((n) => n !== 1)) throw new Error(`provenance: ${this.environment.name} has slots ${found.join('/')}, expected 1/1/1`);
      if (!clientHash) throw new Error('provenance: the client must build before the Worker');
      const bundleHash = hashOutputs(chunks.map((chunk) => ({ fileName: chunk.fileName, content: chunk.code })));
      const buildTime = new Date().toISOString();
      for (const chunk of chunks) {
        chunk.code = chunk.code
          .replace(BUNDLE_HASH_SLOT, bundleHash)
          .replace(CLIENT_HASH_SLOT, clientHash)
          .replace(BUILD_TIME_SLOT, buildTime);
      }
    },
  };
}
