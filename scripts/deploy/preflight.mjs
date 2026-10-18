#!/usr/bin/env node
// The deploy workflows' first step: fail fast, with the fix, until the owner has added the secrets docs/DEPLOY.md
// lists. Reads them from the environment and never prints a value.
//   node scripts/deploy/preflight.mjs [staging|pilot]
import { pathToFileURL } from 'node:url';

export const REQUIRED = ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'STAGING_URL', 'STAGING_BETTER_AUTH_SECRET', 'CANARY_POOL_SECRET'];
/** The pilot (T8.P1) needs no staging or canary secret. */
export const REQUIRED_PILOT = ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'PILOT_URL', 'PILOT_BETTER_AUTH_SECRET', 'PILOT_ALLOWED_EMAILS'];
const TARGETS = {
  staging: { required: REQUIRED, url: 'STAGING_URL', long: ['STAGING_BETTER_AUTH_SECRET', 'CANARY_POOL_SECRET'] },
  pilot: { required: REQUIRED_PILOT, url: 'PILOT_URL', long: ['PILOT_BETTER_AUTH_SECRET'] },
};
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '0.0.0.0']);
const EMAIL = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;

const parseUrl = (value) => {
  try {
    return new URL(value);
  } catch {
    return null;
  }
};

export function preflightProblems(env, target = 'staging') {
  const spec = TARGETS[target];
  if (!spec) return [`unknown target ${JSON.stringify(target)}`];
  const missing = spec.required.filter((name) => !env[name]);
  if (missing.length > 0) return missing.map((name) => `secret ${name} is not set`);
  const problems = [];
  const url = parseUrl(env[spec.url]);
  if (!url || url.protocol !== 'https:' || LOOPBACK.has(url.hostname)) problems.push(`secret ${spec.url} must be an https URL that is not loopback`);
  for (const name of spec.long) if (env[name].length < 32) problems.push(`secret ${name} must be at least 32 characters`);
  if (target === 'pilot') {
    const emails = env.PILOT_ALLOWED_EMAILS.split(/[\s,;]+/).filter(Boolean);
    if (emails.length === 0 || !emails.every((email) => EMAIL.test(email))) {
      problems.push('secret PILOT_ALLOWED_EMAILS must list at least one email address, and only email addresses');
    }
    if (url?.hostname.startsWith('moss-multi-staging.')) {
      problems.push('secret PILOT_URL must not be the staging Worker');
    }
  }
  return problems;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const target = process.argv[2] ?? 'staging';
  const problems = preflightProblems(process.env, target);
  for (const problem of problems) console.error(`::error::${problem}`);
  if (problems.length > 0) console.error(`::error::deploy-${target} is not set up yet: add the repository secrets listed in docs/DEPLOY.md, then run it again.`);
  else console.log(`deploy-${target}: every secret is configured`);
  process.exitCode = problems.length > 0 ? 1 : 0;
}
