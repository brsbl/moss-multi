#!/usr/bin/env node
// The state file the canary project reads as STACK_STATE (e2e/lib/stack.ts): a running Worker that is not ours to
// restart, with no test hooks, a fixed principal pool and a request budget (A§21, T8.D). deploy-staging.yml points it
// at staging; ci.yml's canary rehearsal points it at a production-mode local stack (--from-stack).
//   node scripts/deploy/canary-state.mjs --out PATH --budget N --idle-ms MS
//     (--base-url URL --commit SHA --bundle HASH --client HASH | --from-stack STATE.json)
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** SP14: real Cloudflare hibernates after about 10 s idle; the canary idles at least 15 s. */
export const MIN_IDLE_MS = 15_000;

export function canaryState({ baseUrl, expected, statePath, budget, idleMs, runId = `canary-${Date.now()}` }) {
  if (!(Number.isInteger(budget) && budget > 0)) throw new Error(`request budget must be a positive integer, got ${budget}`);
  if (!(Number.isInteger(idleMs) && idleMs >= MIN_IDLE_MS)) throw new Error(`idle must be at least ${MIN_IDLE_MS / 1000} s, got ${idleMs} ms`);
  for (const key of ['commit', 'bundleHash', 'clientHash']) if (!expected?.[key]) throw new Error(`expected ${key} is missing`);
  return {
    runId,
    baseUrl: baseUrl.replace(/\/$/, ''),
    expected,
    hooks: false,
    secretsPath: '',
    logPath: '',
    statePath,
    canary: { budget, idleMs, poolSecretEnv: 'CANARY_POOL_SECRET', budgetPath: join(dirname(statePath), 'requests.json') },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const opts = {};
  for (let i = 0; i < args.length; i += 2) opts[args[i].replace(/^--/, '')] = args[i + 1];
  try {
    const out = resolve(opts.out ?? '');
    const stack = opts['from-stack'] ? JSON.parse(readFileSync(opts['from-stack'], 'utf8')) : null;
    const state = canaryState({
      baseUrl: stack?.baseUrl ?? opts['base-url'] ?? '',
      expected: stack?.expected ?? { commit: opts.commit, bundleHash: opts.bundle, clientHash: opts.client },
      statePath: out,
      budget: Number(opts.budget),
      idleMs: Number(opts['idle-ms']),
      runId: opts['run-id'],
    });
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(state, null, 2)}\n`);
    console.log(`canary state: ${out} (budget ${state.canary.budget} requests, idle ${state.canary.idleMs} ms)`);
  } catch (error) {
    console.error(`::error::${error.message}`);
    process.exitCode = 1;
  }
}
