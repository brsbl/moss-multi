#!/usr/bin/env node
import { BUILD, runCli } from './program.ts';

/** Whether Node `have` is older than `need` (both `major.minor.patch`). */
const older = (have: string, need: string): boolean => {
  const [a, b] = [have, need].map((version) => version.split('.').map(Number)) as [number[], number[]];
  for (let i = 0; i < 3; i += 1) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) < (b[i] ?? 0);
  return false;
};

if (BUILD.node && older(process.versions.node, BUILD.node)) {
  process.stderr.write(`moss-multi: needs Node ${BUILD.node} or later; this is Node ${process.versions.node}\n`);
  process.exitCode = 1;
} else process.exitCode = await runCli(process.argv.slice(2));
