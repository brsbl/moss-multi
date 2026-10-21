// Bundles the CLI into one self-contained file, dist/moss-multi.mjs, stamped with its version, the commit it was built
// from (a pull request's head in CI) and the Node it needs (.node-version), for `moss-multi --version` (T7.P3).
import { execFileSync } from 'node:child_process';
import { chmodSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const here = fileURLToPath(new URL('.', import.meta.url));
const pkg = JSON.parse(readFileSync(new URL('package.json', import.meta.url), 'utf8'));
const node = readFileSync(new URL('../../.node-version', import.meta.url), 'utf8').trim();
let commit = process.env.MOSS_PR_HEAD_SHA || '';
if (!commit) {
  try {
    commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: here, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    commit = 'unknown';
  }
}
const outfile = `${here}dist/moss-multi.mjs`;
await build({
  entryPoints: [`${here}src/bin.ts`],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  outfile,
  define: { MOSS_MULTI_BUILD: JSON.stringify({ version: pkg.version, commit, node }) },
  logLevel: 'warning',
});
chmodSync(outfile, 0o755);
