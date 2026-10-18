#!/usr/bin/env node
// Asserts a deployed Worker serves the tested bytes and no test hook (A§4.1, A§19, A§21): /api/version equals the
// tested commit, bundleHash and clientHash with no-store, / carries the same build and its assets serve, and each hook
// path, with and without a hook header, answers exactly as an unknown route: a 404. deploy-staging.yml runs it against
// staging; ci.yml's build job runs it against the production-mode smoke stack. ASSERT_HOOK_SECRET adds a probe with
// that header: an e2e shard passes its hooks stack's secret and expects a failure, the check's negative control.
// --pilot adds the pilot's read-only smoke (T8.P1): signed-out reads are 401 and a stranger's sign-up is refused.
//   node scripts/deploy/assert-deployed.mjs --base-url URL --expect-commit SHA --expect-bundle HASH --expect-client HASH [--wait SECONDS] [--pilot]
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { servingProblems } from '../stack.mjs';

const HOOKS = [['GET', 'instance'], ['POST', 'reset']];

/**
 * The SSR 404 without what differs per response: its CSP nonce and its inline scripts (the router's dehydrated
 * state carries a timestamp). The document, head and visible page must be identical.
 */
export function comparable(html) {
  const at = html.indexOf('nonce="');
  const end = at < 0 ? -1 : html.indexOf('"', at + 7);
  const text = end > at + 7 ? html.split(html.slice(at + 7, end)).join('NONCE') : html;
  let out = '';
  let from = 0;
  for (;;) {
    const open = text.indexOf('<script', from);
    const close = open < 0 ? -1 : text.indexOf('</script>', open);
    if (close < 0) return out + text.slice(from);
    out += `${text.slice(from, open)}<script>`;
    from = close;
  }
}

async function answer(url, method, headers = {}) {
  const response = await fetch(url, { method, headers, redirect: 'manual', signal: AbortSignal.timeout(15_000) });
  return { status: response.status, type: response.headers.get('content-type') ?? '', body: comparable(await response.text()) };
}

/** Every hook path that answers other than the unknown-route 404, or [] when none does. */
export async function hookProblems(baseUrl, { secret = '' } = {}) {
  const problems = [];
  const token = () => randomBytes(6).toString('hex');
  for (const [method, hook] of HOOKS) {
    const unknown = await answer(`${baseUrl}/__no-such-route-${token()}`, method);
    if (unknown.status !== 404) problems.push(`${method} unknown route: ${unknown.status}, expected 404`);
    const variants = [['', {}], [' with a hook header', { 'x-moss-test-hook': token() }]];
    if (secret) variants.push([' with the hook secret', { 'x-moss-test-hook': secret }]);
    for (const [header, headers] of variants) {
      const path = `/__test/docs/doc-${token()}/${hook}`;
      const hooked = await answer(`${baseUrl}${path}`, method, headers);
      if (hooked.status !== 404) problems.push(`${method} ${path}${header}: ${hooked.status}, expected 404`);
      else if (hooked.type !== unknown.type || hooked.body !== unknown.body) {
        problems.push(`${method} ${path}${header}: a 404 that differs from the unknown route's`);
      }
    }
  }
  return problems;
}

/** Problems with what `baseUrl` serves against the tested build; [] when it is exactly that build, hook-free. */
export async function deployedProblems(baseUrl, expected, hookOptions = {}) {
  return [...(await servingProblems(baseUrl, expected)), ...(await hookProblems(baseUrl, hookOptions))];
}

/**
 * The pilot's read-only smoke (T8.P1), which can create no account: /api/me without a session is 401, and a sign-up
 * for an email off the allowlist is refused SIGN_UP_NOT_ALLOWED. That sign-up uses an `@example.invalid` address and a
 * password below every minimum, so even an open sign-up would refuse it.
 */
export async function pilotProblems(baseUrl) {
  const problems = [];
  const me = await fetch(`${baseUrl}/api/me`, { redirect: 'manual', signal: AbortSignal.timeout(15_000) });
  await me.body?.cancel();
  if (me.status !== 401) problems.push(`GET /api/me signed out: ${me.status}, expected 401`);
  const email = `pilot-smoke-${randomBytes(6).toString('hex')}@example.invalid`;
  const signUp = await fetch(`${baseUrl}/api/auth/sign-up/email`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/json', origin: baseUrl },
    body: JSON.stringify({ email, password: 'x', name: 'Pilot smoke' }),
    signal: AbortSignal.timeout(15_000),
  });
  const code = await signUp.json().then((body) => body?.code, () => null);
  if (signUp.status !== 403 || code !== 'SIGN_UP_NOT_ALLOWED') problems.push(`POST sign-up off the allowlist: ${signUp.status} ${code}, expected 403 SIGN_UP_NOT_ALLOWED`);
  return problems;
}

function parse(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i].replace(/^--/, '');
    if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) opts[key] = argv[(i += 1)];
    else opts[key] = true;
  }
  return opts;
}

async function main(argv) {
  const opts = parse(argv);
  const baseUrl = (opts['base-url'] ?? '').replace(/\/$/, '');
  const expected = { commit: opts['expect-commit'], bundleHash: opts['expect-bundle'], clientHash: opts['expect-client'] };
  if (!baseUrl || !expected.commit || !expected.bundleHash || !expected.clientHash) {
    console.error('usage: assert-deployed.mjs --base-url URL --expect-commit SHA --expect-bundle HASH --expect-client HASH [--wait SECONDS]');
    return 2;
  }
  // A fresh deploy takes a while to propagate (about 20 s; L§5.4), and a first workers.dev certificate longer.
  const deadline = Date.now() + Number(opts.wait ?? 0) * 1000;
  for (;;) {
    let problems;
    try {
      problems = await deployedProblems(baseUrl, expected, { secret: process.env.ASSERT_HOOK_SECRET ?? '' });
      if (opts.pilot) problems.push(...(await pilotProblems(baseUrl)));
    } catch (error) {
      problems = [`${baseUrl}: ${error.cause?.code ?? error.message}`];
    }
    if (problems.length === 0) {
      console.log(`deployed: ${baseUrl} serves ${expected.commit}:${expected.bundleHash}, and every test hook is the unknown-route 404`);
      if (opts.pilot) console.log('pilot: signed-out reads are 401 and sign-up off the allowlist is refused');
      return 0;
    }
    if (Date.now() >= deadline) {
      for (const problem of problems) console.error(`::error::${problem}`);
      return 1;
    }
    await new Promise((done) => setTimeout(done, 5_000));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
