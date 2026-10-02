import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import * as detectors from '../e2e/lib/detectors.js';
import { buildPrelude, closeSession, loadContract, openSession, parseArgs, pngSize, runScript, shotBody } from './qa.mjs';

const ADA = { label: 'ada', name: 'Ada r1', email: 'mm-r1-ada@example.invalid', password: 'pw-ada', id: 'u1' };
const BEN = { label: 'ben', name: 'Ben r1', email: 'mm-r1-ben@example.invalid', password: 'pw-ben', id: 'u2' };
const EXPECTED = { commit: 'c'.repeat(40), bundleHash: 'b'.repeat(64), clientHash: 'e'.repeat(64) };

const dirs = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function png(width, height) {
  const buffer = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0);
  buffer.writeUInt32BE(13, 8);
  buffer.write('IHDR', 12, 'ascii');
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}

/** A stack run directory as scripts/stack.mjs leaves it, under a temp runs dir. */
function stackRun({ status = 'running', session = null } = {}) {
  const runsDir = mkdtempSync(join(tmpdir(), 'qa-runs-'));
  dirs.push(runsDir);
  const dir = join(runsDir, 'r1');
  mkdirSync(dir);
  const state = { runId: 'r1', status, baseUrl: 'http://127.0.0.1:8851', expected: EXPECTED, statePath: join(dir, 'state.json') };
  writeFileSync(join(dir, 'state.json'), JSON.stringify(state));
  writeFileSync(join(dir, 'principals.json'), JSON.stringify([ADA, BEN]));
  if (session) writeFileSync(join(dir, 'qa.json'), JSON.stringify({ sessionId: session, machine: 'host_test' }));
  return { runsDir, dir, state };
}

/** A fake `bb browser-automation`: records every call; `run` writes a 2x PNG where the script would. */
function fakeBb({ onRun = null } = {}) {
  const calls = [];
  const bb = async (args) => {
    calls.push(args);
    const [command] = args;
    if (command === 'open') return { id: 'sid-1', state: 'ready', previewDirective: '::browser-preview{session="sid-1"}' };
    if (command === 'close') return { id: args[1], state: 'closed' };
    if (command === 'run') return onRun ? onRun(args) : { text: 'ok', images: [], exitCode: 0, hostId: 'host_test' };
    throw new Error(`unexpected bb ${command}`);
  };
  return { bb, calls };
}

describe('parseArgs', () => {
  it('reads the command, flags and the script path', () => {
    expect(parseArgs(['run', '--run-id', 'r1', 'e2e/qa/x.js', '--timeout', '60s'])).toEqual({
      command: 'run',
      opts: { 'run-id': 'r1', timeout: '60s' },
      positional: ['e2e/qa/x.js'],
    });
  });
});

describe('pngSize', () => {
  it('reads a PNG header, and refuses anything else', () => {
    expect(pngSize(png(2880, 2000))).toEqual({ width: 2880, height: 2000 });
    expect(() => pngSize(Buffer.from('not a png at all, really not'))).toThrow(/PNG/);
  });
});

describe('the prelude', () => {
  it('carries the stack, principals, DOM contract, every e2e detector and the helpers into one script', async () => {
    const { dir, state } = stackRun();
    const prelude = buildPrelude({ state, principals: [ADA, BEN], sessionId: 'sid-1', shotsDir: join(dir, 'shots'), ...(await loadContract()) });
    const scope = new Function(
      `${prelude}\nreturn { STACK, P, DOM, NAMES, D, MOD, actor, visit, signIn, waitReady, waitAttr, typeBody, bodyText, shot, detect, sockets, freeze };`,
    )();
    expect(scope.STACK).toEqual({ baseUrl: 'http://127.0.0.1:8851', runId: 'r1', ...EXPECTED, shotsDir: join(dir, 'shots'), sessionId: 'sid-1' });
    expect(scope.P.ada).toMatchObject({ email: ADA.email, password: ADA.password });
    expect(scope.P.ben.email).toBe(BEN.email);
    expect(scope.DOM.APP_STATE_ATTR).toBe('data-app-state');
    expect(scope.DOM.DOC_SOCKET_PATH).toBe('/parties/doc-d-o/');
    expect(scope.NAMES.buildMeta).toBe('moss-build');
    expect(Object.keys(scope.D).sort()).toEqual(Object.keys(detectors).sort());
    for (const [name, fn] of Object.entries(detectors)) expect(String(scope.D[name])).toBe(String(fn));
    for (const helper of ['actor', 'visit', 'signIn', 'waitReady', 'waitAttr', 'typeBody', 'bodyText', 'shot', 'detect', 'sockets', 'freeze']) {
      expect(typeof scope[helper], helper).toBe('function');
    }
  });
});

describe('open', () => {
  it('opens one local headless session for a running stack and records it', async () => {
    const { runsDir, dir } = stackRun();
    const { bb, calls } = fakeBb();
    const opened = await openSession({ runId: 'r1', machine: 'host_test' }, { runsDir, bb });
    expect(calls).toEqual([['open', '--backend', 'local', '--headless', '--machine', 'host_test']]);
    expect(opened).toMatchObject({ sessionId: 'sid-1', previewDirective: '::browser-preview{session="sid-1"}' });
    expect(JSON.parse(readFileSync(join(dir, 'qa.json'), 'utf8'))).toMatchObject({ sessionId: 'sid-1', machine: 'host_test' });
  });

  it('refuses a stack that is not running, and a second session', async () => {
    const { bb, calls } = fakeBb();
    await expect(openSession({ runId: 'r1', machine: 'host_test' }, { runsDir: stackRun({ status: 'stopped' }).runsDir, bb })).rejects.toThrow(/not running/);
    await expect(openSession({ runId: 'r1', machine: 'host_test' }, { runsDir: stackRun({ session: 'sid-0' }).runsDir, bb })).rejects.toThrow(/sid-0/);
    expect(calls).toEqual([]);
  });
});

describe('run', () => {
  it('runs the prelude and the script in the session from a private temp file, then reports the new 2x PNGs', async () => {
    const { runsDir, dir } = stackRun({ session: 'sid-1' });
    const scriptPath = join(dir, 'body.js');
    writeFileSync(scriptPath, "const page = await actor('ada');\n({ shot: await shot(page, 'shell') })\n");
    let seen = null;
    const { bb, calls } = fakeBb({
      onRun: (args) => {
        const file = args[args.indexOf('--script-file') + 1];
        seen = { file, mode: statSync(file).mode & 0o777, text: readFileSync(file, 'utf8') };
        writeFileSync(join(dir, 'shots', '1-shell.png'), png(2880, 2000));
        return { text: '{"shot":"x"}', images: [], exitCode: 0, hostId: 'host_test' };
      },
    });
    const result = await runScript({ runId: 'r1', file: scriptPath, timeout: '90s' }, { runsDir, bb });
    expect(calls[0]).toEqual(['run', 'sid-1', '--script-file', seen.file, '--script-host', 'host_test', '--timeout', '90s']);
    expect(seen.mode).toBe(0o600);
    expect(seen.text).toMatch(/^\/\/ qa\.mjs prelude/);
    expect(seen.text.trimEnd().endsWith("({ shot: await shot(page, 'shell') })")).toBe(true);
    expect(seen.text).toContain(ADA.password);
    expect(existsSync(seen.file), 'the script holding passwords is deleted').toBe(false);
    expect(result).toEqual({ result: '{"shot":"x"}', exitCode: 0, shots: [{ path: join(dir, 'shots', '1-shell.png'), width: 2880, height: 2000 }] });
  });

  it('deletes the script even when the run fails', async () => {
    const { runsDir, dir } = stackRun({ session: 'sid-1' });
    writeFileSync(join(dir, 'body.js'), '1');
    let file = null;
    const { bb } = fakeBb({
      onRun: (args) => {
        file = args[args.indexOf('--script-file') + 1];
        throw new Error('session_unavailable');
      },
    });
    await expect(runScript({ runId: 'r1', file: join(dir, 'body.js') }, { runsDir, bb })).rejects.toThrow(/session_unavailable/);
    expect(existsSync(file)).toBe(false);
  });

  it('needs an open session', async () => {
    const { runsDir, dir } = stackRun();
    writeFileSync(join(dir, 'body.js'), '1');
    await expect(runScript({ runId: 'r1', file: join(dir, 'body.js') }, { runsDir, bb: fakeBb().bb })).rejects.toThrow(/qa\.mjs open/);
  });
});

describe('shot', () => {
  it('signs the principal in on their own context, visits the path and writes one PNG', () => {
    const body = shotBody({ as: 'ben', path: '/d/x', name: 'doc' });
    expect(body).toMatch(/actor\(["']ben["']/);
    expect(body).toMatch(/visit\(page, ["']\/d\/x["']\)/);
    expect(body).toMatch(/shot\(page, ["']doc["']\)/);
  });
});

describe('close', () => {
  it('closes the session and forgets it', async () => {
    const { runsDir, dir } = stackRun({ session: 'sid-1' });
    const { bb, calls } = fakeBb();
    await closeSession({ runId: 'r1' }, { runsDir, bb });
    expect(calls).toEqual([['close', 'sid-1']]);
    expect(existsSync(join(dir, 'qa.json'))).toBe(false);
  });
});
