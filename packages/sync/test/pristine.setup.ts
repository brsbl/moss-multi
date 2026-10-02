// Writes moss's files at the pin (moss-vendor `pristine`) to .cache/moss-pristine once per vendored tree.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ROOTS, writePristine } from '../../../scripts/moss-vendor.mjs';

const repo = fileURLToPath(new URL('../../../', import.meta.url));

export default function setup(): void {
  const root = ROOTS.find((r) => r.name === 'moss')!;
  const out = `${repo}.cache/moss-pristine`;
  const marker = `${out}/.ported-sha256`;
  const stamp = createHash('sha256').update(readFileSync(`${repo}${root.dir}/PORTED.json`)).digest('hex');
  if (existsSync(marker) && readFileSync(marker, 'utf8') === stamp) return;
  const temp = `${out}.${process.pid}.${Date.now()}`;
  writePristine({ root, out: temp });
  writeFileSync(`${temp}/.ported-sha256`, stamp);
  rmSync(out, { recursive: true, force: true });
  try {
    renameSync(temp, out);
  } catch {
    rmSync(temp, { recursive: true, force: true }); // another project's setup won the race
  }
}
