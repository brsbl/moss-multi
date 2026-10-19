// The replicas' service wrappers (T7.P3, docs/SYNC.md): a launchd agent on the Mac and a systemd user unit on Linux
// run `moss-multi watch <workspace>` through moss-multi-watch.sh, which reads the agent key from a 0600 env file and
// never opens a browser. @p:agt-2
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SERVICE = fileURLToPath(new URL('../service/', import.meta.url));
const WRAPPER = join(SERVICE, 'moss-multi-watch.sh');
const KEY = `mm_sk_${'b'.repeat(64)}`;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mm-service-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** The wrapper with a stub in place of the CLI: the stub prints what it was started with. */
function start(mode: number | null) {
  const envFile = join(dir, 'watch.env');
  rmSync(envFile, { force: true });
  if (mode !== null) {
    writeFileSync(envFile, `MOSS_MULTI_SERVER=https://notes.example.invalid\nMOSS_MULTI_API_KEY=${KEY}\n`);
    chmodSync(envFile, mode);
  }
  const stub = join(dir, 'stub.mjs');
  writeFileSync(stub, 'console.log(JSON.stringify({ argv: process.argv.slice(2), server: process.env.MOSS_MULTI_SERVER, key: process.env.MOSS_MULTI_API_KEY, noOpen: process.env.MOSS_MULTI_NO_OPEN }));\n');
  const workspace = join(dir, 'Moss Notes');
  const run = spawnSync('sh', [WRAPPER, envFile, workspace], {
    env: { PATH: process.env.PATH ?? '', HOME: dir, MOSS_MULTI_NODE: process.execPath, MOSS_MULTI_CLI: stub },
    encoding: 'utf8',
    timeout: 30_000,
  });
  return { ...run, workspace };
}

describe('the watch service', () => {
  it('runs moss-multi watch on the workspace with the env file\'s server and key, and MOSS_MULTI_NO_OPEN=1', () => {
    const run = start(0o600);
    expect(run.status, run.stderr).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual({ argv: ['watch', run.workspace], server: 'https://notes.example.invalid', key: KEY, noOpen: '1' });
  });

  it('refuses an env file others can read, or none at all, without starting the CLI', () => {
    for (const mode of [0o644, 0o640, null]) {
      const run = start(mode);
      expect(run.status, `mode ${mode?.toString(8) ?? 'missing'}`).toBe(78);
      expect(run.stdout).toBe('');
      expect(run.stderr).toMatch(mode === null ? /no env file/ : /chmod 600/);
      expect(run.stderr).not.toContain(KEY);
    }
  });

  it('the systemd user unit restarts on failure but not on a bad env file, logs to a file and starts with the user manager', () => {
    const unit = readFileSync(join(SERVICE, 'moss-multi-watch.service'), 'utf8');
    for (const line of ['Restart=on-failure', 'RestartPreventExitStatus=78', 'Environment=MOSS_MULTI_NO_OPEN=1', 'WantedBy=default.target']) expect(unit).toContain(line);
    expect(unit).toMatch(/^ExecStart=\/bin\/sh %h\/\.local\/lib\/moss-multi\/moss-multi-watch\.sh %h\/\.config\/moss-multi\/watch\.env /m);
    expect(unit).toMatch(/^StandardOutput=append:%h\/\.local\/state\/moss-multi\/watch\.log$/m);
    expect(unit).toMatch(/^StandardError=append:%h\/\.local\/state\/moss-multi\/watch\.log$/m);
  });

  it('docs/SYNC.md never puts an agent key on a command line: the env file is made private before the key goes in, and login reads it from stdin', () => {
    const doc = readFileSync(fileURLToPath(new URL('../../../docs/SYNC.md', import.meta.url)), 'utf8');
    const blocks = [...doc.matchAll(/^ *```[^\n]*\n([\s\S]*?)^ *```/gm)].map((match) => match[1]!);
    expect(blocks.length).toBeGreaterThan(0);
    for (const line of blocks.join('\n').split('\n')) {
      expect(line, 'no key, real or placeholder, in an example').not.toMatch(/mm_sk_/);
      expect(line, 'login --key reads the key from stdin').not.toMatch(/--key(?:=|\s+)(?!-(?:\s|$))\S/);
      expect(line, 'no shell assignment of the key').not.toMatch(/(?:^|[\s;&|])(?:export\s+)?MOSS_MULTI_API_KEY=/);
    }
    expect(doc).toMatch(/install -m 600 \/dev\/null ~\/\.config\/moss-multi\/watch\.env/);
    expect(doc).toMatch(/moss-multi login --server \S+ --key -/);
  });

  it('the launchd agent starts at login, restarts after a failure, logs to a file and never opens a browser', () => {
    const plist = readFileSync(join(SERVICE, 'app.moss-multi.watch.plist'), 'utf8').replace(/\s+/g, ' ');
    expect(plist).toContain('<key>RunAtLoad</key> <true/>');
    expect(plist).toContain('<key>KeepAlive</key> <dict> <key>SuccessfulExit</key> <false/> </dict>');
    expect(plist).toContain('<key>MOSS_MULTI_NO_OPEN</key> <string>1</string>');
    expect(plist).toContain('<string>/bin/sh</string> <string>/Users/YOU/.local/lib/moss-multi/moss-multi-watch.sh</string> <string>/Users/YOU/.config/moss-multi/watch.env</string>');
    expect(plist).toContain('<key>StandardOutPath</key> <string>/Users/YOU/Library/Logs/moss-multi/watch.log</string>');
    expect(plist).toContain('<key>StandardErrorPath</key> <string>/Users/YOU/Library/Logs/moss-multi/watch.log</string>');
  });
});
