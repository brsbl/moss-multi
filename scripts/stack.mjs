#!/usr/bin/env node
// The one stack launcher, for local work and CI (A§20, S-test §4.1–4.2): `wrangler dev --local` on built bytes,
// in its own process group, at most MAX_STACKS (5; MOSS_MAX_STACKS overrides) live stacks per machine, orphans reaped. Every run records host state
// (load, a bb dev stack or Nightly running) so a local death can be classed as infrastructure (L§5.1).
//   start      [--run-id ID] [--port P] [--prebuilt DIST] [--hooks] [--expect-commit SHA] [--expect-bundle HASH] [--state-dir DIR] [--json]
//   restart    --run-id ID                same bytes, storage, secrets and port
//   stop       --run-id ID [--purge]      --purge deletes state/ but never shots/
//   pause|resume --run-id ID              SIGSTOP / SIGCONT the group
//   status     [--run-id ID]
//   verify     --run-id ID                provenance and assets re-checked
//   principals --run-id ID [--count N] [--labels ada,ben]
//   reap       [--ttl 4h] [--dry-run] [--purge-shots]
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  appendFileSync, chmodSync, cpSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, statSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import os from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readProvenance } from './provenance.mjs';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const WEB = join(REPO, 'apps/web');
const RUNS = join(REPO, '.local-stack/runs');
const BUILDS = join(REPO, '.local-stack/builds');
const REGISTRY = process.env.MOSS_STACK_REGISTRY || join(os.homedir(), '.cache/moss-multi/stacks');
const MAX_STACKS = Number(process.env.MOSS_MAX_STACKS) || 5;
const PORT_RANGE = [8850, 8869];
const READY_MS = 60_000;
const BLANK_VARS = ['GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'RESEND_API_KEY',
  'EMAIL_FROM', 'POSTHOG_KEY', 'POSTHOG_HOST'];
const LABELS = ['ada', 'ben', 'cy', 'dee', 'eve', 'fay', 'gus', 'hal'];
const ENDED = new Set(['stopped', 'failed', 'reaped']);
const RUN_PATH = /(\S*\/\.local-stack\/runs\/([A-Za-z0-9._-]+))\/state(?:\s|$)/;

const bin = (path) => join(WEB, 'node_modules', path); // apps/web's own vite and wrangler

class StackError extends Error {}
const fail = (message) => { throw new StackError(message); };
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
const writePrivate = (path, value) => {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
};

// ---------- host and processes ----------

function translated() {
  if (process.platform !== 'darwin') return false;
  try {
    return execFileSync('sysctl', ['-n', 'sysctl.proc_translated'], { encoding: 'utf8' }).trim() === '1';
  } catch {
    return false; // no such key on Intel
  }
}

export function parseEtime(text) {
  const [days, clock] = text.includes('-') ? text.split('-') : ['0', text];
  const parts = clock.split(':').map(Number);
  while (parts.length < 3) parts.unshift(0);
  return ((Number(days) * 24 + parts[0]) * 60 + parts[1]) * 60 + parts[2];
}

/**
 * Where wrangler keeps D1 and Durable Object storage. workerd syncs every commit on its one thread, so on a busy shared
 * disk one sync stalls every request; CI passes --state-dir on tmpfs (/dev/shm) to keep storage in memory (T0.9d).
 */
export function persistDirFor(runDir, runId, stateDir) {
  return typeof stateDir === 'string' ? join(resolve(stateDir), runId) : join(runDir, 'state');
}

export function parsePs(text) {
  return text.split('\n').flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    return match ? [{ pid: Number(match[1]), pgid: Number(match[2]), age: parseEtime(match[3]), command: match[4] }] : [];
  });
}

const processes = () => parsePs(execFileSync('ps', ['-A', '-ww', '-o', 'pid=,pgid=,etime=,command='], { encoding: 'utf8' }));

export function hostState(list = processes()) {
  return {
    at: new Date().toISOString(),
    platform: process.platform,
    arch: process.arch,
    translated: translated(),
    node: process.version,
    load1: Number(os.loadavg()[0].toFixed(2)),
    cpus: os.cpus().length,
    nightly: list.some((p) => /bb Nightly\.app\/Contents\/MacOS\/bb Nightly(?:\s|$)/.test(p.command)),
    bbDevStack: list.some((p) => /turbo(?:\/bin\/turbo)? run dev\b.*@bb\/|bb-dev-app/.test(p.command)),
  };
}

function recordHost(run, event) {
  const host = { event, ...hostState() };
  appendFileSync(join(run.dir, 'host.jsonl'), `${JSON.stringify(host)}\n`);
  return host;
}

function preflight() {
  if (process.platform === 'darwin' && (process.arch !== 'arm64' || translated())) {
    fail(`refusing ${process.arch}${translated() ? ' (Rosetta)' : ''} Node: use arm64 Node 24, e.g. ~/.local/node-v24.18.1-darwin-arm64/bin`);
  }
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 7)) fail(`Node ${process.version} is too old; .node-version pins 24`);
}

const groupMembers = (pgid, list = processes()) => list.filter((p) => p.pgid === pgid);

async function killGroup(pgid) {
  for (const signal of ['SIGCONT', 'SIGTERM', 'SIGKILL']) {
    try {
      process.kill(-pgid, signal);
    } catch {
      return; // the group is gone
    }
    if (signal === 'SIGCONT') continue; // a paused group cannot act on SIGTERM
    for (let waited = 0; waited < 5000; waited += 200) {
      if (groupMembers(pgid).length === 0) return;
      await sleep(200);
    }
  }
}

// A live leader must name this run's state dir. A dead leader whose group still has members is ours:
// a pgid cannot be reused while its group exists.
const namesPersistDir = (command, persistDir) => command.includes(`--persist-to ${persistDir}`);

function ownsGroup(run, list = processes()) {
  const leader = list.find((p) => p.pid === run.state.pgid);
  if (leader) return leader.pgid === run.state.pgid && namesPersistDir(leader.command, run.state.persistDir);
  return groupMembers(run.state.pgid, list).length > 0;
}

// ---------- runs and the machine-wide registry ----------

function runFor(runId) {
  if (!/^[A-Za-z0-9._-]+$/.test(runId ?? '')) fail(`bad --run-id ${JSON.stringify(runId)}`);
  const dir = join(RUNS, runId);
  const statePath = join(dir, 'state.json');
  return { id: runId, dir, statePath, state: existsSync(statePath) ? readJson(statePath) : null };
}

function existingRun(runId) {
  const run = runFor(runId);
  if (!run.state) fail(`no run ${runId} (${run.statePath} missing)`);
  return run;
}

function saveState(run, patch) {
  run.state = { ...run.state, ...patch };
  writePrivate(run.statePath, run.state);
}

function registryEntries() {
  if (!existsSync(REGISTRY)) return [];
  return readdirSync(REGISTRY).flatMap((name) => {
    const path = join(REGISTRY, name);
    try {
      return [{ path, ...readJson(path) }];
    } catch {
      return [{ path, broken: true }];
    }
  });
}

function register(run) {
  mkdirSync(REGISTRY, { recursive: true });
  const { port, pgid, startedAt } = run.state;
  writePrivate(join(REGISTRY, `${port}.json`), { repo: REPO, runId: run.id, runDir: run.dir, pgid, port, startedAt });
}

function unregister(run) {
  rmSync(join(REGISTRY, `${run.state.port}.json`), { force: true });
}

function portFree(port) {
  return new Promise((done) => {
    const server = createServer();
    server.once('error', () => done(false));
    server.listen(port, '127.0.0.1', () => server.close(() => done(true)));
  });
}

async function choosePort(requested) {
  const taken = new Set(registryEntries().map((entry) => entry.port));
  const candidates = requested ? [requested] : Array.from({ length: PORT_RANGE[1] - PORT_RANGE[0] + 1 }, (_, i) => PORT_RANGE[0] + i);
  for (const port of candidates) {
    if (!taken.has(port) && (await portFree(port)) && (await portFree(port + 1000))) return port;
  }
  fail(requested ? `port ${requested} or ${requested + 1000} is busy` : `no free port in ${PORT_RANGE.join('-')}`);
}

// ---------- build ----------

function git(args) {
  return execFileSync('git', args, { cwd: REPO, encoding: 'buffer', maxBuffer: 256 * 1024 * 1024 });
}

function buildKey() {
  const digest = createHash('sha256').update(git(['rev-parse', 'HEAD'])).update(git(['diff', 'HEAD', '--binary']));
  const untracked = git(['ls-files', '--others', '--exclude-standard', '-z']).toString().split('\0').filter(Boolean);
  for (const path of untracked.sort()) digest.update(`\0${path}\0`).update(readFileSync(join(REPO, path)));
  return digest.digest('hex').slice(0, 16);
}

function build() {
  const key = buildKey();
  const dir = join(BUILDS, key);
  if (existsSync(join(dir, 'server/wrangler.json'))) return dir;
  const vite = bin('vite/bin/vite.js');
  console.error(`stack: building ${key} (vite build)`);
  execFileSync(process.execPath, [vite, 'build'], {
    cwd: WEB,
    stdio: ['ignore', 'inherit', 'inherit'],
    env: { ...process.env, MOSS_BUILD_ENV: 'local', CLOUDFLARE_ENV: '' },
    timeout: 300_000,
  });
  mkdirSync(BUILDS, { recursive: true });
  cpSync(join(WEB, 'dist'), dir, { recursive: true });
  for (const name of readdirSync(join(dir, 'server'))) {
    if (name.startsWith('.dev.vars') || name === '.env') rmSync(join(dir, 'server', name), { force: true });
  }
  const builds = readdirSync(BUILDS).map((name) => join(BUILDS, name)).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  for (const old of builds.slice(3)) rmSync(old, { recursive: true, force: true });
  return dir;
}

// ---------- serving checks ----------

async function fetchText(url, init) {
  const response = await fetch(url, { redirect: 'follow', ...init, signal: AbortSignal.timeout(5000) });
  return { status: response.status, type: response.headers.get('content-type') ?? '', headers: response.headers, text: await response.text() };
}

const attrs = (tag) => Object.fromEntries([...tag.matchAll(/([\w-]+)\s*=\s*"([^"]*)"/g)].map((m) => [m[1].toLowerCase(), m[2]]));

/** Problems with what the stack serves; empty when it serves exactly `expected`. */
export async function servingProblems(baseUrl, expected) {
  const problems = [];
  const version = await fetchText(`${baseUrl}/api/version`, { redirect: 'manual' });
  let body = null;
  try {
    body = JSON.parse(version.text);
  } catch {
    problems.push(`/api/version: ${version.status} ${version.type || 'no content-type'}, not JSON`);
  }
  if (body) {
    if (version.status !== 200) problems.push(`/api/version: status ${version.status}`);
    if (!/no-store/.test(version.headers.get('cache-control') ?? '')) problems.push('/api/version: missing cache-control no-store');
    for (const key of ['commit', 'bundleHash', 'clientHash']) {
      if (expected[key] && body[key] !== expected[key]) problems.push(`/api/version ${key}: expected ${expected[key]}, got ${body[key]}`);
    }
  }
  const page = await fetchText(`${baseUrl}/`);
  if (page.status !== 200 || !page.type.startsWith('text/html')) problems.push(`/: ${page.status} ${page.type}`);
  const meta = [...page.text.matchAll(/<meta\b[^>]*>/g)].map((m) => attrs(m[0])).find((a) => a.name === 'moss-build');
  const wantMeta = `${expected.commit}:${expected.bundleHash}`;
  if (meta?.content !== wantMeta) problems.push(`/: meta moss-build is ${meta?.content ?? 'missing'}, expected ${wantMeta}`);
  const tags = [...page.text.matchAll(/<(?:link|script)\b[^>]*>/g)].map((m) => ({ tag: m[0], ...attrs(m[0]) }));
  const sheets = tags.filter((t) => t.tag.startsWith('<link') && t.rel === 'stylesheet').map((t) => t.href);
  const modules = tags.filter((t) => (t.tag.startsWith('<script') && t.type === 'module' && t.src) || t.rel === 'modulepreload')
    .map((t) => t.src ?? t.href);
  if (sheets.length === 0) problems.push('/: no stylesheet linked');
  for (const [paths, kind] of [[sheets, /^text\/css/], [modules, /javascript/]]) {
    for (const path of paths) {
      const asset = await fetchText(new URL(path, baseUrl));
      if (asset.status !== 200 || !kind.test(asset.type)) problems.push(`${path}: ${asset.status} ${asset.type}`);
    }
  }
  return problems;
}

async function waitServing(baseUrl, expected, alive) {
  const deadline = Date.now() + READY_MS;
  let last = ['no answer yet'];
  while (Date.now() < deadline) {
    if (!alive()) return ['wrangler exited'];
    try {
      last = await servingProblems(baseUrl, expected);
      if (last.length === 0) return [];
    } catch (error) {
      last = [`${baseUrl}: ${error.cause?.code ?? error.message}`];
    }
    await sleep(500);
  }
  return last;
}

// ---------- start, restart, stop ----------

function wranglerArgs(state, secrets) {
  const wrangler = bin('wrangler/bin/wrangler.js');
  const vars = {
    BETTER_AUTH_SECRET: secrets.betterAuthSecret,
    BETTER_AUTH_URL: state.baseUrl,
    ...(state.hooks ? { MOSS_TEST_HOOKS: '1', MOSS_TEST_HOOKS_SECRET: secrets.testHooksSecret } : {}),
    ...Object.fromEntries(BLANK_VARS.map((name) => [name, ''])),
  };
  return [
    wrangler, 'dev', '--config', join(state.buildDir, 'server/wrangler.json'), '--local', '--ip', '127.0.0.1',
    '--port', String(state.port), '--inspector-port', String(state.port + 1000), '--persist-to', state.persistDir,
    '--show-interactive-dev-session=false', '--log-level', 'info',
    ...Object.entries(vars).flatMap(([name, value]) => ['--var', `${name}:${value}`]),
  ];
}

function migrate(state) {
  const dir = join(WEB, 'drizzle');
  if (!existsSync(dir) || !readdirSync(dir).some((name) => name.endsWith('.sql'))) return;
  const wrangler = bin('wrangler/bin/wrangler.js');
  execFileSync(process.execPath, [wrangler, 'd1', 'migrations', 'apply', 'DB', '--local', '--persist-to', state.persistDir,
    '--config', join(WEB, 'wrangler.jsonc')], { cwd: WEB, stdio: ['ignore', 'inherit', 'inherit'], env: { ...process.env, CI: 'true' }, timeout: 120_000 });
}

const logTail = (path, lines = 40) => (existsSync(path) ? readFileSync(path, 'utf8').split('\n').slice(-lines).join('\n') : '');

async function launch(run, event) {
  const secrets = readJson(run.state.secretsPath);
  const log = openSync(run.state.logPath, 'a');
  const child = spawn(process.execPath, wranglerArgs(run.state, secrets), {
    cwd: join(run.state.buildDir, 'server'),
    detached: true,
    stdio: ['ignore', log, log],
    env: { ...process.env, CI: 'true', WRANGLER_SEND_METRICS: 'false' },
  });
  if (!child.pid) fail(`could not spawn wrangler for run ${run.id}`);
  let exited = false;
  child.on('exit', () => { exited = true; });
  child.unref();
  saveState(run, { status: 'starting', pgid: child.pid, startedAt: new Date().toISOString(), host: recordHost(run, event) });
  register(run);
  const problems = await waitServing(run.state.baseUrl, run.state.expected, () => !exited);
  if (problems.length > 0) {
    await killGroup(child.pid);
    unregister(run);
    saveState(run, { status: 'failed', problems });
    fail(`run ${run.id} never served the expected build:\n  ${problems.join('\n  ')}\n--- ${run.state.logPath} (tail)\n${logTail(run.state.logPath)}`);
  }
  saveState(run, { status: 'running' });
}

// At most MAX_STACKS live stacks per machine, counted after reaping orphans.
async function assertCapacity() {
  await reap({ ttl: '4h', quiet: true });
  const live = registryEntries().filter((entry) => !entry.broken);
  if (live.length >= MAX_STACKS) {
    const list = live.map((e) => `${e.runId} :${e.port} (${e.repo})`).join('\n  ');
    fail(`${live.length} live stacks already (at most ${MAX_STACKS} per machine):\n  ${list}\nStop one with: node scripts/stack.mjs stop --run-id <id>`);
  }
}

async function start(opts) {
  preflight();
  await assertCapacity();
  const runId = opts['run-id'] ?? `local-${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}-${randomBytes(2).toString('hex')}`;
  const run = runFor(runId);
  if (run.state && !ENDED.has(run.state.status)) fail(`run ${runId} exists (${run.state.status}); restart or stop it`);
  const buildDir = opts.prebuilt ? resolve(opts.prebuilt) : build();
  const provenance = readProvenance(buildDir);
  for (const [flag, key] of [['expect-commit', 'commit'], ['expect-bundle', 'bundleHash']]) {
    if (opts[flag] && opts[flag] !== provenance[key]) fail(`--${flag} ${opts[flag]} but the build has ${key} ${provenance[key]}`);
  }
  const port = await choosePort(opts.port ? Number(opts.port) : null);
  const persistDir = persistDirFor(run.dir, runId, opts['state-dir']);
  for (const dir of [run.dir, persistDir]) mkdirSync(dir, { recursive: true });
  const secretsPath = join(run.dir, 'secrets.json');
  if (!existsSync(secretsPath)) {
    writePrivate(secretsPath, { betterAuthSecret: randomBytes(32).toString('hex'), testHooksSecret: randomBytes(24).toString('hex') });
  }
  run.state = {
    runId, repo: REPO, status: 'new', port, baseUrl: `http://127.0.0.1:${port}`, buildDir, hooks: Boolean(opts.hooks),
    expected: provenance, persistDir, logPath: join(run.dir, 'wrangler.log'), secretsPath,
    statePath: run.statePath,
  };
  migrate(run.state);
  await launch(run, 'start');
  return run;
}

async function stop(run, { purge = false } = {}) {
  if (run.state.pgid && ownsGroup(run)) await killGroup(run.state.pgid);
  unregister(run);
  recordHost(run, 'stop');
  saveState(run, { status: 'stopped', stoppedAt: new Date().toISOString() });
  if (purge) rmSync(run.state.persistDir, { recursive: true, force: true });
}

async function restart(run) {
  preflight();
  if (run.state.pgid && ownsGroup(run)) await killGroup(run.state.pgid);
  else await assertCapacity();
  unregister(run);
  await launch(run, 'restart');
}

function signalGroup(run, signal, status) {
  if (!ownsGroup(run)) fail(`run ${run.id} has no live process group`);
  process.kill(-run.state.pgid, signal);
  saveState(run, { status });
}

// ---------- reaper ----------

function ttlSeconds(text) {
  const match = /^(\d+)([smhd])$/.exec(text);
  if (!match) fail(`bad --ttl ${text}`);
  return Number(match[1]) * { s: 1, m: 60, h: 3600, d: 86400 }[match[2]];
}

/**
 * Why a process group attributed to `runDir` should be reaped, or null to keep it. A group is ours only while
 * its leader names the run's recorded state dir (default storage or --state-dir); a leaderless group is an orphan.
 * Not ours: `{ ours: false }`.
 */
export function judgeGroup({ pgid, runDir, state, list, maxAge, now = Date.now() }) {
  const leader = list.find((p) => p.pid === pgid);
  if (leader && !namesPersistDir(leader.command, state?.persistDir ?? join(runDir, 'state'))) return { ours: false, why: null };
  const age = state?.startedAt ? (now - Date.parse(state.startedAt)) / 1000 : (leader?.age ?? 0);
  let why = null;
  if (!state) why = 'state.json missing';
  else if (ENDED.has(state.status)) why = `run ${state.status}`;
  else if (state.pgid !== pgid) why = "not the run's recorded group";
  else if (!leader) why = 'leader dead';
  else if (age > maxAge) why = `older than ${maxAge} s`;
  return { ours: true, why };
}

// A run dir belongs to a moss-multi checkout (another project's .local-stack is never touched).
function mossRunDir(runDir) {
  try {
    return readJson(join(runDir, '../../../package.json')).name === 'moss-multi';
  } catch {
    return false;
  }
}

export async function reap({ ttl = '4h', dryRun = false, quiet = false, purgeShots = false } = {}) {
  const maxAge = ttlSeconds(ttl);
  const list = processes();
  const groups = new Map(); // pgid -> { runDir, why }
  const judge = (pgid, runDir) => {
    if (groups.has(pgid)) return;
    const statePath = join(runDir, 'state.json');
    const state = existsSync(statePath) ? readJson(statePath) : null;
    const verdict = judgeGroup({ pgid, runDir, state, list, maxAge });
    if (verdict.ours) groups.set(pgid, { runDir, why: verdict.why });
  };
  for (const entry of registryEntries()) {
    const alive = !entry.broken && entry.pgid && entry.runDir && groupMembers(entry.pgid, list).length > 0;
    if (alive) judge(entry.pgid, entry.runDir);
    if ((!alive || !groups.has(entry.pgid)) && !dryRun) rmSync(entry.path, { force: true });
  }
  for (const p of list) {
    const match = RUN_PATH.exec(p.command);
    if (match && mossRunDir(match[1])) judge(p.pgid, match[1]);
  }
  const all = [...groups].map(([pgid, { runDir, why }]) => ({ pgid, runDir, why }));
  const reaped = all.filter((g) => g.why);
  const kept = all.filter((g) => !g.why).map(({ pgid, runDir }) => ({ pgid, runDir }));
  if (!dryRun) {
    for (const { pgid, runDir } of reaped) {
      await killGroup(pgid);
      const statePath = join(runDir, 'state.json');
      if (existsSync(statePath)) writePrivate(statePath, { ...readJson(statePath), status: 'reaped', reapedAt: new Date().toISOString() });
      for (const entry of registryEntries()) if (entry.pgid === pgid || entry.runDir === runDir) rmSync(entry.path, { force: true });
    }
    pruneRuns(new Set(kept.map((k) => k.runDir)), purgeShots);
  }
  if (!quiet) console.log(JSON.stringify({ reaped, kept }, null, 2));
  return { reaped, kept };
}

// Run directories of dead stacks older than a day lose everything but shots/ (task evidence; --purge-shots removes it).
function pruneRuns(live, purgeShots) {
  if (!existsSync(RUNS)) return;
  for (const name of readdirSync(RUNS)) {
    const dir = join(RUNS, name);
    if (live.has(dir) || Date.now() - statSync(dir).mtimeMs < 86_400_000) continue;
    for (const child of readdirSync(dir)) {
      if (child !== 'shots' || purgeShots) rmSync(join(dir, child), { recursive: true, force: true });
    }
    if (readdirSync(dir).length === 0) rmSync(dir, { recursive: true, force: true });
  }
}

// ---------- principals ----------

async function principals(run, { count = 2, labels } = {}) {
  const names = labels ? labels.split(',').map((l) => l.trim().toLowerCase()).filter(Boolean) : LABELS.slice(0, Number(count));
  const path = join(run.dir, 'principals.json');
  const existing = existsSync(path) ? readJson(path) : [];
  const minted = [];
  for (const label of names) {
    if (!/^[a-z][a-z0-9-]*$/.test(label)) fail(`bad label ${label}`);
    const email = `mm-${run.id.toLowerCase()}-${label}@example.invalid`;
    if (!email.endsWith('@example.invalid')) fail('principals must be @example.invalid');
    const name = `${label[0].toUpperCase()}${label.slice(1)} ${run.id.slice(-4)}`;
    const password = randomBytes(18).toString('base64url');
    const response = await fetch(`${run.state.baseUrl}/api/auth/sign-up/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: run.state.baseUrl },
      body: JSON.stringify({ email, password, name }),
      signal: AbortSignal.timeout(10_000),
    });
    const text = await response.text();
    if (!response.ok) fail(`sign-up for ${email}: ${response.status} ${text.slice(0, 200)}`);
    let id = null;
    try {
      id = JSON.parse(text).user?.id ?? null;
    } catch {
      // keep id null
    }
    // Minted means the stack resolves the new session to this principal.
    const cookie = response.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
    const me = await fetch(`${run.state.baseUrl}/api/me`, { headers: { cookie }, signal: AbortSignal.timeout(10_000) });
    const principal = me.ok ? (await me.json()).principal : null;
    if (!id || principal?.id !== id || principal?.email !== email) {
      fail(`/api/me for ${email}: ${me.status}, expected principal ${id}`);
    }
    minted.push({ label, name, email, password, id });
  }
  writePrivate(path, [...existing.filter((p) => !names.includes(p.label)), ...minted]);
  return minted.map(({ label, email, id }) => ({ label, email, id }));
}

// ---------- CLI ----------

export function parseArgs(argv) {
  const [command, ...rest] = argv;
  const opts = {};
  for (let i = 0; i < rest.length; i += 1) {
    const match = /^--([a-z-]+)(?:=(.*))?$/.exec(rest[i]);
    if (!match) fail(`unexpected argument ${rest[i]}`);
    const [, key, inline] = match;
    if (inline !== undefined) opts[key] = inline;
    else if (rest[i + 1] !== undefined && !rest[i + 1].startsWith('--')) opts[key] = rest[(i += 1)];
    else opts[key] = true;
  }
  return { command, opts };
}

function report(run, json) {
  if (json) {
    console.log(JSON.stringify(run.state, null, 2));
    return;
  }
  const { state } = run;
  const host = state.host ?? {};
  console.log(`stack ${run.id} ${state.status}: ${state.baseUrl}`);
  console.log(`  commit ${state.expected.commit} bundle ${state.expected.bundleHash.slice(0, 12)} build ${state.buildDir}`);
  console.log(`  host load1 ${host.load1} on ${host.cpus} cpus; Nightly ${host.nightly ? 'running' : 'not running'}; bb dev stack ${host.bbDevStack ? 'running' : 'not running'}`);
  console.log(`  stop: node scripts/stack.mjs stop --run-id ${run.id}`);
}

async function main(argv) {
  const { command, opts } = parseArgs(argv);
  switch (command) {
    case 'start':
      report(await start(opts), opts.json);
      return 0;
    case 'restart': {
      const run = existingRun(opts['run-id']);
      await restart(run);
      report(run, opts.json);
      return 0;
    }
    case 'stop':
      await stop(existingRun(opts['run-id']), { purge: Boolean(opts.purge) });
      console.log(`stopped ${opts['run-id']}`);
      return 0;
    case 'pause':
    case 'resume': {
      const run = existingRun(opts['run-id']);
      signalGroup(run, command === 'pause' ? 'SIGSTOP' : 'SIGCONT', command === 'pause' ? 'paused' : 'running');
      console.log(`${command}d ${run.id}`);
      return 0;
    }
    case 'status': {
      const runs = opts['run-id'] ? [existingRun(opts['run-id'])] : (existsSync(RUNS) ? readdirSync(RUNS) : []).map(runFor).filter((r) => r.state);
      const list = processes();
      console.log(JSON.stringify(runs.map((r) => ({ ...r.state, alive: Boolean(r.state.pgid) && ownsGroup(r, list) })), null, 2));
      return 0;
    }
    case 'verify': {
      const run = existingRun(opts['run-id']);
      const host = recordHost(run, 'verify');
      const problems = await servingProblems(run.state.baseUrl, run.state.expected).catch((error) => [`${run.state.baseUrl}: ${error.cause?.code ?? error.message}`]);
      if (problems.length > 0) fail(`run ${run.id} does not serve its build (host load1 ${host.load1}):\n  ${problems.join('\n  ')}`);
      console.log(`verified ${run.id}: ${run.state.baseUrl} serves ${run.state.expected.commit}:${run.state.expected.bundleHash}`);
      return 0;
    }
    case 'principals': {
      const run = existingRun(opts['run-id']);
      console.log(JSON.stringify(await principals(run, opts), null, 2));
      return 0;
    }
    case 'reap':
      await reap({ ttl: opts.ttl ?? '4h', dryRun: Boolean(opts['dry-run']), purgeShots: Boolean(opts['purge-shots']) });
      return 0;
    default:
      console.error('usage: node scripts/stack.mjs start|restart|stop|pause|resume|status|verify|principals|reap [options]');
      return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => { process.exitCode = code; },
    (error) => {
      console.error(error instanceof StackError ? `stack: ${error.message}` : error);
      process.exitCode = 1;
    },
  );
}
