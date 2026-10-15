#!/usr/bin/env node
// deploy-staging.yml's first step: fail fast, with the fix, until the owner has added the secrets docs/DEPLOY.md
// lists. Reads them from the environment and never prints a value.
import { pathToFileURL } from 'node:url';

export const REQUIRED = ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'STAGING_URL', 'STAGING_BETTER_AUTH_SECRET', 'CANARY_POOL_SECRET'];
const LONG = ['STAGING_BETTER_AUTH_SECRET', 'CANARY_POOL_SECRET'];
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '0.0.0.0']);

export function preflightProblems(env) {
  const missing = REQUIRED.filter((name) => !env[name]);
  if (missing.length > 0) return missing.map((name) => `secret ${name} is not set`);
  const problems = [];
  let url = null;
  try {
    url = new URL(env.STAGING_URL);
  } catch {
    // reported below
  }
  if (!url || url.protocol !== 'https:' || LOOPBACK.has(url.hostname)) problems.push('secret STAGING_URL must be an https URL that is not loopback');
  for (const name of LONG) if (env[name].length < 32) problems.push(`secret ${name} must be at least 32 characters`);
  return problems;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const problems = preflightProblems(process.env);
  for (const problem of problems) console.error(`::error::${problem}`);
  if (problems.length > 0) console.error('::error::deploy-staging is not set up yet: add the repository secrets listed in docs/DEPLOY.md, then run it again.');
  else console.log('deploy-staging: every secret is configured');
  process.exitCode = problems.length > 0 ? 1 : 0;
}
