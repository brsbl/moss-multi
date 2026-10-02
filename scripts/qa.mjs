#!/usr/bin/env node
// Local QA through bb Browser Automation (A§20; S-test §4.4): one local headless Chrome for Testing session per
// stack run, each script prefixed with a generated prelude (the stack, its principals, the DOM contract, e2e's
// detectors and the e2e/qa/prelude.js helpers), evidence as 2x PNGs in the run's shots/. No tests run locally.
//   open   --run-id ID [--machine HOST]                   one session; the browser shares the stack's host
//   run    --run-id ID FILE.js [--timeout 90s]            the prelude, then FILE.js; prints {result, exitCode, shots}
//   shot   --run-id ID [--as ada] [--path /] [--name shot]  a signed-in 2880x2000 PNG (1440x1000 CSS px at 2x)
//   close  --run-id ID
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const RUNS = join(REPO, '.local-stack/runs');
const HELPERS = join(REPO, 'e2e/qa/prelude.js');
const FALLBACK_MACHINE = 'host_37m3sgpq59';
const DEFAULT_TIMEOUT = '90s';
const ENDED_SESSION = /^(closed|expired|stopped|failed)$/;
const run = promisify(execFile);

class QaError extends Error {}
const fail = (message) => {
  throw new QaError(message);
};
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
const writePrivate = (path, text) => {
  writeFileSync(path, text, { mode: 0o600 });
  chmodSync(path, 0o600);
};

export function parseArgs(argv) {
  const [command, ...rest] = argv;
  const opts = {};
  const positional = [];
  for (let i = 0; i < rest.length; i += 1) {
    const match = /^--([a-z-]+)(?:=(.*))?$/.exec(rest[i]);
    if (!match) {
      positional.push(rest[i]);
      continue;
    }
    const [, key, inline] = match;
    if (inline !== undefined) opts[key] = inline;
    else if (rest[i + 1] !== undefined && !rest[i + 1].startsWith('--')) opts[key] = rest[(i += 1)];
    else opts[key] = true;
  }
  return { command, opts, positional };
}

/** Width and height from a PNG's IHDR. */
export function pngSize(buffer) {
  const png = buffer.length >= 24 && buffer.subarray(0, 8).toString('hex') === '89504e470d0a1a0a' && buffer.toString('ascii', 12, 16) === 'IHDR';
  if (!png) fail('not a PNG');
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

/** The DOM contract, e2e's NAMES and its detectors: the same modules CI's journeys use (A§19). */
export async function loadContract() {
  const dom = { ...(await import('../packages/protocol/src/dom-contract.ts')) };
  const { NAMES } = await import('../e2e/lib/contract.ts');
  const detectors = { ...(await import('../e2e/lib/detectors.js')) };
  return { dom, names: NAMES, detectors };
}

/** The script text every run starts with; it declares and never executes. */
export function buildPrelude({ state, principals, sessionId, shotsDir, dom, names, detectors }) {
  const { commit, bundleHash, clientHash } = state.expected;
  const stack = { baseUrl: state.baseUrl, runId: state.runId, commit, bundleHash, clientHash, shotsDir, sessionId };
  const people = Object.fromEntries(principals.map(({ label, name, email, password, id }) => [label, { label, name, email, password, id }]));
  const detectorSource = Object.entries(detectors)
    .filter(([, fn]) => typeof fn === 'function')
    .map(([name, fn]) => `  ${name}: ${fn.toString()},`);
  return [
    '// qa.mjs prelude (generated): the stack, its principals, the DOM contract, e2e detectors and helpers.',
    `const STACK = ${JSON.stringify(stack)};`,
    `const P = ${JSON.stringify(people)};`,
    `const DOM = ${JSON.stringify(dom)};`,
    `const NAMES = ${JSON.stringify(names)};`,
    `const D = {\n${detectorSource.join('\n')}\n};`,
    `const MOD = ${JSON.stringify(process.platform === 'darwin' ? 'Meta' : 'Control')};`,
    readFileSync(HELPERS, 'utf8').replace(/^export /gm, ''),
  ].join('\n');
}

/** The `shot` command's script: a principal's own signed-in page at `path`, captured once. */
export function shotBody({ as = 'ada', path = '/', name = 'shot' } = {}) {
  return [
    `const page = await actor(${JSON.stringify(as)});`,
    `await visit(page, ${JSON.stringify(path)});`,
    `({ url: page.url(), shot: await shot(page, ${JSON.stringify(name)}) })`,
  ].join('\n');
}

function runDir(runId, runsDir) {
  if (!/^[A-Za-z0-9._-]+$/.test(runId ?? '')) fail(`bad --run-id ${JSON.stringify(runId)}`);
  return join(runsDir, runId);
}

function loadRun(runId, runsDir) {
  const dir = runDir(runId, runsDir);
  const statePath = join(dir, 'state.json');
  if (!existsSync(statePath)) fail(`no stack run ${runId}; start one with node scripts/stack.mjs start`);
  const state = readJson(statePath);
  if (state.status !== 'running') fail(`stack run ${runId} is ${state.status}, not running`);
  const principalsPath = join(dir, 'principals.json');
  return {
    dir,
    state,
    principals: existsSync(principalsPath) ? readJson(principalsPath) : [],
    qaPath: join(dir, 'qa.json'),
    shotsDir: join(dir, 'shots'),
  };
}

/** `bb browser-automation <args> --json`; a failure with --json prints `{ok:false, error}` on stdout. */
async function bbCli(args) {
  let stdout;
  try {
    ({ stdout } = await run('bb', ['browser-automation', ...args, '--json'], { timeout: 180_000, maxBuffer: 16 * 1024 * 1024 }));
  } catch (error) {
    stdout = error.stdout ?? '';
    if (!stdout.trim()) throw new QaError(`bb browser-automation ${args[0]} failed: ${error.stderr || error.message}`);
  }
  const value = JSON.parse(stdout);
  if (value?.ok === false) fail(`bb browser-automation ${args[0]}: ${value.error?.code ?? 'error'}: ${value.error?.message ?? stdout}`);
  return value;
}

function defaultMachine() {
  if (process.env.QA_MACHINE) return process.env.QA_MACHINE;
  try {
    return readFileSync(join(os.homedir(), '.bb/host-id'), 'utf8').trim() || FALLBACK_MACHINE;
  } catch {
    return FALLBACK_MACHINE;
  }
}

const defaultDeps = () => ({ runsDir: RUNS, bb: bbCli });

/** Opens the run's one local headless session and records it in the run's qa.json. */
export async function openSession({ runId, machine = defaultMachine() }, deps = defaultDeps()) {
  const target = loadRun(runId, deps.runsDir);
  if (existsSync(target.qaPath)) {
    const { sessionId } = readJson(target.qaPath);
    const sessions = await deps.bb(['list']);
    if (sessions.some((session) => session.id === sessionId && !ENDED_SESSION.test(session.state))) {
      fail(`stack run ${runId} already has session ${sessionId}; close it with node scripts/qa.mjs close --run-id ${runId}`);
    }
  }
  const opened = await deps.bb(['open', '--backend', 'local', '--headless', '--machine', machine]);
  writePrivate(target.qaPath, `${JSON.stringify({ sessionId: opened.id, machine, openedAt: new Date().toISOString() }, null, 2)}\n`);
  return { sessionId: opened.id, machine, previewDirective: opened.previewDirective ?? null };
}

/**
 * Runs the prelude plus a script (a file, or `body`) in the run's session from a 0600 temp file that is always
 * deleted, since it holds the principals' passwords. Reports the PNGs the run added to shots/.
 */
export async function runScript({ runId, file = null, body = null, timeout = DEFAULT_TIMEOUT }, deps = defaultDeps()) {
  const target = loadRun(runId, deps.runsDir);
  if (!existsSync(target.qaPath)) fail(`no browser session for stack run ${runId}; open one with node scripts/qa.mjs open --run-id ${runId}`);
  const { sessionId, machine } = readJson(target.qaPath);
  const source = body ?? readFileSync(resolve(file), 'utf8');
  mkdirSync(target.shotsDir, { recursive: true });
  const prelude = buildPrelude({ state: target.state, principals: target.principals, sessionId, shotsDir: target.shotsDir, ...(await loadContract()) });
  const scriptPath = join(target.dir, `qa-${Date.now()}-${randomBytes(3).toString('hex')}.js`);
  const before = new Set(readdirSync(target.shotsDir));
  writePrivate(scriptPath, `${prelude}\n${source}`);
  let output;
  try {
    output = await deps.bb(['run', sessionId, '--script-file', scriptPath, '--script-host', machine, '--timeout', String(timeout)]);
  } finally {
    rmSync(scriptPath, { force: true });
  }
  const shots = readdirSync(target.shotsDir)
    .filter((name) => name.endsWith('.png') && !before.has(name))
    .sort()
    .map((name) => ({ path: join(target.shotsDir, name), ...pngSize(readFileSync(join(target.shotsDir, name))) }));
  return { result: output.text ?? '', exitCode: output.exitCode ?? 0, shots };
}

/** Closes the run's session (an already expired one too) and forgets it. */
export async function closeSession({ runId }, deps = defaultDeps()) {
  const qaPath = join(runDir(runId, deps.runsDir), 'qa.json');
  if (!existsSync(qaPath)) fail(`no browser session recorded for stack run ${runId}`);
  const { sessionId } = readJson(qaPath);
  try {
    await deps.bb(['close', sessionId]);
  } catch (error) {
    if (!/session_unavailable|not found|closed|expired/i.test(error.message)) throw error;
  } finally {
    rmSync(qaPath, { force: true });
  }
  return { closed: sessionId };
}

function printRun(output) {
  let result = output.result;
  try {
    result = JSON.parse(result);
  } catch {
    // plain text stays text
  }
  console.log(JSON.stringify({ ...output, result }, null, 2));
  return output.exitCode === 0 ? 0 : 1;
}

async function main(argv) {
  const { command, opts, positional } = parseArgs(argv);
  const runId = opts['run-id'];
  switch (command) {
    case 'open':
      console.log(JSON.stringify(await openSession({ runId, machine: opts.machine ?? defaultMachine() }), null, 2));
      return 0;
    case 'run':
      if (!positional[0]) fail('usage: node scripts/qa.mjs run --run-id ID FILE.js [--timeout 90s]');
      return printRun(await runScript({ runId, file: positional[0], timeout: opts.timeout ?? DEFAULT_TIMEOUT }));
    case 'shot': {
      const as = opts.as ?? 'ada';
      if (!loadRun(runId, RUNS).principals.some((principal) => principal.label === as)) {
        await run(process.execPath, [join(REPO, 'scripts/stack.mjs'), 'principals', '--run-id', runId, '--labels', as], { timeout: 60_000 });
      }
      const body = shotBody({ as, path: opts.path ?? '/', name: opts.name ?? 'shot' });
      return printRun(await runScript({ runId, body, timeout: opts.timeout ?? DEFAULT_TIMEOUT }));
    }
    case 'close':
      console.log(JSON.stringify(await closeSession({ runId }), null, 2));
      return 0;
    default:
      console.error('usage: node scripts/qa.mjs open|run|shot|close --run-id ID [options]');
      return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error(error instanceof QaError ? `qa: ${error.message}` : error);
      process.exitCode = 1;
    },
  );
}
