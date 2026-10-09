#!/usr/bin/env node
// Demo content and the signature shot, against any stack (T8.5p; R8). Two test principals build a demo folder through
// the real UI in one bb Browser Automation session (scripts/qa.mjs): a launch plan and an every-node note with media,
// comment threads with replies and reactions, a suggestion from the second person, an agent's suggestion pushed
// through the CLI, named versions and a view link to the folder. Then it captures the signature shot (a peer's
// caret and a suggestion in a long sentence beside rich blocks) and a short tour, as 2x PNGs. Each step reads what
// is there first, so a re-run converges instead of duplicating. Principals are @example.invalid only, with passwords
// derived from MOSS_DEMO_SECRET, so a re-run from any machine signs the same accounts in.
//   node scripts/demo.mjs --url URL [--prefix demo] [--machine HOST] [--skip-agent]
//   node scripts/demo.mjs --run-id RUN                  a local stack from scripts/stack.mjs
import { execFile } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { pendingBy, STEPS } from '../e2e/qa/demo.js';
import { closeSession, openSession, parseArgs, runScript } from './qa.mjs';

export { STEPS };

const REPO = fileURLToPath(new URL('..', import.meta.url));
const RUNS = join(REPO, '.local-stack/runs');
const LOCAL_SECRET = join(REPO, '.local-stack/demo-secret');
const CLI = join(REPO, 'packages/cli/dist/moss-multi.mjs');
const STEP_SOURCE = join(REPO, 'e2e/qa/demo.js');
const FIXTURES = join(REPO, 'e2e/fixtures');
const STEP_TIMEOUT = '120s';
const execFileAsync = promisify(execFile);

class DemoError extends Error {}
const fail = (message) => {
  throw new DemoError(message);
};

const writePrivate = (path, text) => {
  writeFileSync(path, text, { mode: 0o600 });
  chmodSync(path, 0o600);
};

// ---------- the content ----------

export const FOLDER = 'Multiplayer beta';
export const AGENT = 'Demo agent';
export const PEOPLE = { ada: 'Ada Okafor', ben: 'Ben Lindqvist' };

const fixture = (path) => readFileSync(join(FIXTURES, path), 'utf8');

export const NOTES = [
  { key: 'launch', title: 'Launch plan', markdown: fixture('demo/launch-plan.md') },
  {
    key: 'every',
    title: 'Every node family',
    markdown: fixture('demo/every-node.md'),
    mediaAfter: 'Media uploaded from this machine:',
    media: [
      { name: 'pattern.png', type: 'image/png', path: 'media/pattern.png' },
      { name: 'clip.mp4', type: 'video/mp4', path: 'media/clip.mp4' },
    ],
  },
];

/** The long sentence of the signature shot, the words Ben replaces in it, and what he writes instead. */
export const SENTENCE = { text: 'When three people open the same note at once', find: 'within a heartbeat', replace: 'in under a second' };
export const AGENT_EDIT = {
  find: 'Everyone edits this note together.',
  replace: 'Everyone edits this note together, and an agent keeps the checklist current.',
};

export const THREADS = [
  {
    by: 'ada',
    quote: 'first 200 teams',
    text: 'Is 200 the right cap? Support can onboard about 150 teams a week.',
    replies: [{ by: 'ben', text: 'Keep 200 and send the invites in two waves, a week apart.' }],
    reactions: [{ by: 'ada', on: 'Keep 200 and send the invites', emoji: '👍' }],
  },
  {
    by: 'ben',
    quote: 'General availability',
    text: 'GA depends on the export work landing first.',
    replies: [{ by: 'ada', text: 'Agreed. It is the first item on the checklist after launch.' }],
    reactions: [{ by: 'ben', on: 'Agreed. It is the first item', emoji: '🎉' }],
  },
];

/**
 * Who runs the comments step, in order. A pass adds the person's roots, then their replies under roots that exist,
 * then their reactions on messages that exist, so a reaction on a later reply needs its own later pass.
 */
export function commentPasses(threads) {
  const people = [...new Set(threads.flatMap((t) => [t.by, ...(t.replies ?? []).map((r) => r.by), ...(t.reactions ?? []).map((r) => r.by)]))];
  const have = new Set();
  const left = new Set(threads.flatMap((t) => [t, ...(t.replies ?? []), ...(t.reactions ?? [])]));
  const passes = [];
  for (let round = 0; left.size && round < 2 * threads.length + 2; round += 1) {
    for (const me of people) {
      let did = false;
      const add = (item, text) => {
        if (text) have.add(text);
        left.delete(item);
        did = true;
      };
      for (const t of threads) if (t.by === me && left.has(t)) add(t, t.text);
      for (const t of threads) for (const r of t.replies ?? []) if (r.by === me && left.has(r) && have.has(t.text)) add(r, r.text);
      for (const t of threads) {
        const messages = [t.text, ...(t.replies ?? []).map((r) => r.text)].filter((text) => have.has(text));
        for (const r of t.reactions ?? []) if (r.by === me && left.has(r) && messages.some((text) => text.includes(r.on))) add(r);
      }
      if (did) passes.push(me);
    }
  }
  if (left.size) fail('some comment thread waits on a message nobody writes');
  return passes;
}

// ---------- configuration and principals ----------

/** The stack's base URL and the one demo run id for it: the same URL always maps to the same run. */
export function demoConfig({ url } = {}) {
  if (!url) fail('pass the stack with --url URL (or --run-id RUN for a local stack)');
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    fail(`--url ${url} is not a URL`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') fail(`--url must be http(s), not ${parsed.protocol}`);
  const baseUrl = parsed.origin;
  const runId = `demo-${parsed.host.replace(/[^A-Za-z0-9.-]/g, '-')}`;
  return { baseUrl, runId, loopback: ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname) };
}

/** Ada and Ben for this prefix: test addresses only, each password an HMAC of the secret and the address. */
export function demoPrincipals({ prefix = 'demo', secret }) {
  if (!/^[a-z][a-z0-9-]{0,30}$/.test(prefix)) fail(`bad --prefix ${JSON.stringify(prefix)}: lowercase letters, digits and dashes`);
  if (!secret) fail('no demo secret: set MOSS_DEMO_SECRET');
  return Object.entries(PEOPLE).map(([label, name]) => {
    const email = `${prefix}-${label}@example.invalid`;
    const password = createHmac('sha256', secret).update(email).digest('base64url').slice(0, 32);
    return { label, name, email, password };
  });
}

/** Signs the principal in, or signs it up when it does not exist yet; returns its user id. */
export async function ensurePrincipal(baseUrl, principal, fetchImpl = fetch, wait = (ms) => new Promise((done) => setTimeout(done, ms))) {
  // Auth allows 10 sign-ins a minute per address: a 429 waits out its window, up to three times.
  const post = async (path, body) => {
    for (let attempt = 1; ; attempt += 1) {
      const response = await fetchImpl(`${baseUrl}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: baseUrl },
        body: JSON.stringify(body),
        redirect: 'manual',
        signal: AbortSignal.timeout(15_000),
      });
      if (response.status !== 429 || attempt === 3) return response;
      await wait(1000 * (Number(response.headers.get('retry-after')) || 60));
    }
  };
  const signedIn = await post('/api/auth/sign-in/email', { email: principal.email, password: principal.password });
  if (signedIn.ok) return (await signedIn.json()).user.id;
  if (signedIn.status !== 401) fail(`sign-in for ${principal.email}: ${signedIn.status}`);
  const signedUp = await post('/api/auth/sign-up/email', { email: principal.email, password: principal.password, name: principal.name });
  if (signedUp.ok) return (await signedUp.json()).user.id;
  if (signedUp.status === 422) fail(`${principal.email} exists with another password: the demo secret changed (MOSS_DEMO_SECRET), or pass another --prefix`);
  fail(`sign-up for ${principal.email}: ${signedUp.status}`);
}

/** A qa.mjs run directory for a stack this machine did not start: its URL, the build it serves and the principals. */
export function writeDemoRun({ runsDir = RUNS, runId, baseUrl, version, principals }) {
  const dir = join(runsDir, runId);
  mkdirSync(join(dir, 'shots'), { recursive: true });
  const expected = { commit: version.commit, bundleHash: version.bundleHash, clientHash: version.clientHash };
  writePrivate(join(dir, 'state.json'), `${JSON.stringify({ runId, status: 'running', demo: true, baseUrl, expected }, null, 2)}\n`);
  writePrivate(join(dir, 'principals.json'), `${JSON.stringify(principals, null, 2)}\n`);
  return dir;
}

/** One step's script: the step module (exports stripped, like the prelude's helpers), then the call. */
export function stepScript(name, params) {
  if (!Object.hasOwn(STEPS, name)) fail(`unknown step ${name}`);
  const source = readFileSync(STEP_SOURCE, 'utf8').replace(/^export /gm, '');
  return `${source}\nawait STEPS[${JSON.stringify(name)}](${JSON.stringify(params)})\n`;
}

function demoSecret(config) {
  if (process.env.MOSS_DEMO_SECRET) return process.env.MOSS_DEMO_SECRET;
  if (!config.loopback) fail('a remote stack needs MOSS_DEMO_SECRET, so every re-run signs the same demo accounts in');
  if (!existsSync(LOCAL_SECRET)) {
    mkdirSync(join(REPO, '.local-stack'), { recursive: true });
    writePrivate(LOCAL_SECRET, randomBytes(32).toString('hex'));
  }
  return readFileSync(LOCAL_SECRET, 'utf8').trim();
}

// ---------- the agent ----------

async function cli(args, env, cwd) {
  try {
    const { stdout } = await execFileAsync(process.execPath, [CLI, ...args], { cwd, env, timeout: 60_000 });
    return stdout;
  } catch (error) {
    fail(`moss-multi ${args[0]}: ${(error.stderr || error.message).trim()}`);
  }
}

async function buildCli() {
  if (existsSync(CLI)) return;
  console.error('demo: building the CLI');
  await execFileAsync('corepack', ['pnpm', '--filter', '@moss-multi/cli', 'build'], { cwd: REPO, timeout: 120_000 });
}

/** The agent pulls the launch plan, adds a checklist item and pushes it as a suggestion (MOSS_MULTI_NO_OPEN=1). */
async function agentSuggests({ baseUrl, key, docId }) {
  await buildCli();
  const dir = mkdtempSync(join(tmpdir(), 'moss-demo-cli-'));
  const env = { PATH: process.env.PATH ?? '', HOME: dir, MOSS_MULTI_SERVER: baseUrl, MOSS_MULTI_API_KEY: key, MOSS_MULTI_CONFIG_DIR: join(dir, 'config'), MOSS_MULTI_NO_OPEN: '1' };
  try {
    await cli(['pull', docId, 'launch-plan.md'], env, dir);
    const file = join(dir, 'launch-plan.md');
    const text = readFileSync(file, 'utf8');
    if (!text.includes(AGENT_EDIT.find)) fail(`the pulled launch plan lacks ${JSON.stringify(AGENT_EDIT.find)}`);
    writeFileSync(file, text.replace(AGENT_EDIT.find, AGENT_EDIT.replace));
    return (await cli(['push', 'launch-plan.md', '--suggest'], env, dir)).trim();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------- the run ----------

async function stackVersion(baseUrl) {
  const response = await fetch(`${baseUrl}/api/version`, { redirect: 'manual', signal: AbortSignal.timeout(15_000) });
  if (response.status !== 200) fail(`${baseUrl}/api/version: ${response.status}`);
  return response.json();
}

function urlFor(opts) {
  if (opts.url) return opts.url;
  if (!opts['run-id']) return undefined;
  const statePath = join(RUNS, opts['run-id'], 'state.json');
  if (!existsSync(statePath)) fail(`no stack run ${opts['run-id']}`);
  return JSON.parse(readFileSync(statePath, 'utf8')).baseUrl;
}

export async function buildDemo(opts) {
  const config = demoConfig({ url: urlFor(opts) });
  const { baseUrl, runId } = config;
  const version = await stackVersion(baseUrl);
  const principals = demoPrincipals({ prefix: opts.prefix ?? 'demo', secret: demoSecret(config) });
  for (const principal of principals) principal.id = await ensurePrincipal(baseUrl, principal);
  const dir = writeDemoRun({ runId, baseUrl, version, principals });
  const log = (line) => console.error(`demo: ${line}`);
  log(`${baseUrl} serves ${version.commit}; principals ${principals.map((p) => p.email).join(', ')}`);

  if (existsSync(join(dir, 'qa.json'))) await closeSession({ runId }).catch(() => {});
  await openSession({ runId, ...(opts.machine ? { machine: opts.machine } : {}) });
  const step = async (name, params = {}) => {
    const output = await runScript({ runId, body: stepScript(name, params), timeout: STEP_TIMEOUT });
    if (output.exitCode !== 0) fail(`step ${name} failed: ${output.result}`);
    return typeof output.result === 'string' && output.result ? JSON.parse(output.result) : output.result;
  };
  const shots = [];
  try {
    const { folderId } = await step('folder', { folderName: FOLDER });
    const ids = {};
    for (const note of NOTES) {
      const media = (note.media ?? []).map(({ name, type, path }) => ({ name, type, base64: readFileSync(join(FIXTURES, path)).toString('base64') }));
      const made = await step('note', { folderName: FOLDER, title: note.title, markdown: note.markdown, media, mediaAfter: note.mediaAfter ?? null });
      ids[note.key] = made.id;
      log(`${made.created ? 'built' : 'kept'} "${note.title}" ${baseUrl}/d/${made.id}`);
    }
    await step('version', { docId: ids.launch, name: 'First outline' });

    const ben = principals.find((p) => p.label === 'ben');
    const shared = await step('share', { folderName: FOLDER, email: ben.email, access: 'Can suggest', linkAccess: 'Can view' });
    if (shared.invite) await step('accept', { invite: shared.invite });
    log(`folder shared with ${ben.email}; view link ${shared.link}`);

    for (const me of commentPasses(THREADS)) await step('comments', { docId: ids.launch, me, mode: me === 'ben' ? 'suggest' : 'edit', threads: THREADS });
    await step('suggest', { docId: ids.launch, find: SENTENCE.find, replace: SENTENCE.replace });
    if (!opts['skip-agent']) {
      const { suggestions } = await step('suggestions', { docId: ids.launch });
      if (pendingBy(suggestions, AGENT)) log('the agent suggestion is already pending');
      else log(await agentSuggests({ baseUrl, key: (await step('agentKey', { name: AGENT })).key, docId: ids.launch }));
    }
    await step('version', { docId: ids.launch, name: 'Ready for review' });

    shots.push((await step('signature', { docId: ids.launch, sentence: SENTENCE.text, replace: SENTENCE.replace })).shot);
    shots.push(...(await step('everyNode', { docId: ids.every, htmlResult: 'Ran on click' })).shots);
    shots.push(...(await step('review', { docId: ids.launch, rootText: THREADS[0].text })).shots);
    shots.push((await step('history', { docId: ids.launch })).shot);
    shots.push((await step('visitor', { link: shared.link })).shot);
    return { baseUrl, folderId, folderLink: shared.link, notes: Object.fromEntries(NOTES.map((n) => [n.title, `${baseUrl}/d/${ids[n.key]}`])), principals: principals.map((p) => p.email), shots };
  } finally {
    await closeSession({ runId }).catch((error) => log(`closing the browser session: ${error.message}`));
    const statePath = join(dir, 'state.json');
    writePrivate(statePath, `${JSON.stringify({ ...JSON.parse(readFileSync(statePath, 'utf8')), status: 'done' }, null, 2)}\n`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { opts } = parseArgs(['build', ...process.argv.slice(2)]);
  buildDemo(opts).then(
    (summary) => console.log(JSON.stringify(summary, null, 2)),
    (error) => {
      console.error(error instanceof DemoError ? `demo: ${error.message}` : error);
      process.exitCode = 1;
    },
  );
}

