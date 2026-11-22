// Engine evidence for a failed WebKit test (T9.48g): the browser's stderr, page crashes and browser disconnects, the
// browser's age and context count, the runner's process, descriptor, memory and shared-memory state, how long each
// close took, and a probe of what still answers. Evidence only: nothing here classifies a failure or retries one.
import { execFile } from 'node:child_process';
import { appendFileSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { format, promisify } from 'node:util';
import type { Browser, BrowserContext, Page } from '@playwright/test';

const run = promisify(execFile);
const RING = 500;
const PROBE_MS = 5_000;

// Playwright 1.61 logs every line the browser process writes to stdout or stderr to its `pw:browser` debug namespace
// for the browser's whole life (launchProcess in playwright-core). The namespace is enabled here and its lines kept
// instead of printed, unless DEBUG already asked for them. The first lines (each launch) are kept whole, then a ring
// of the latest.
const HEAD = 40;
const head: string[] = [];
const lines: string[] = [];
let dropped = 0;

interface Debug {
  (namespace: string): unknown;
  enable(namespaces: string): void;
  disable(): string;
  enabled(namespace: string): boolean;
  log: (...args: unknown[]) => unknown;
}

function playwrightDebug(): Debug {
  const fromTest = createRequire(createRequire(import.meta.url).resolve('@playwright/test'));
  const fromPlaywright = createRequire(fromTest.resolve('playwright'));
  return (fromPlaywright('playwright-core/lib/utilsBundle') as { debug: Debug }).debug;
}

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');

function installBrowserLog(): void {
  const debug = playwrightDebug();
  const env = process.env.DEBUG;
  const printed = debug.enabled('pw:browser');
  const previous = debug.disable();
  debug.enable(previous ? `${previous},pw:browser` : 'pw:browser');
  // enable() writes DEBUG back to the environment, which the browser would inherit.
  if (env === undefined) delete process.env.DEBUG;
  else process.env.DEBUG = env;
  const original = debug.log;
  debug.log = function log(this: { namespace?: string } | undefined, ...args: unknown[]) {
    if (this?.namespace !== 'pw:browser') return original.apply(this, args);
    const text = format(...args).replace(ANSI, '').replace(/^\s*(?:\S+Z )?pw:browser /, '').replace(/ \+\d+m?s$/, '');
    const line = `${new Date().toISOString()} ${text}`;
    if (head.length < HEAD) head.push(line);
    else {
      lines.push(line);
      dropped += Math.max(0, lines.length - RING);
      if (lines.length > RING) lines.splice(0, lines.length - RING);
    }
    if (printed) return original.apply(this, args);
    return undefined;
  };
}

installBrowserLog();

/** What the worker's browsers wrote, with Playwright's launch and close lines: the first lines, then the latest. */
export function browserLog(): string[] {
  return [...head, ...(dropped > 0 ? [`… ${dropped} line(s) dropped`] : []), ...lines];
}

interface EngineState { name: string; launchedAt: number; contexts: number; disconnectedAt: number[] }
const state: EngineState = { name: '', launchedAt: 0, contexts: 0, disconnectedAt: [] };

/** The worker's browser fixture calls this once it has its browser. */
export function watchBrowser(browser: Browser): void {
  state.name = browser.browserType().name();
  state.launchedAt = Date.now();
  browser.on('disconnected', () => state.disconnectedAt.push(Date.now()));
}

/** Counts a context the worker created for a test (the probe's own context is not counted). */
export function contextCreated(): void {
  state.contexts += 1;
}

export function engineState(): { browser: string; launchedSecondsAgo: number | null; contextsCreated: number; disconnectedAt: number[] } {
  return {
    browser: state.name,
    launchedSecondsAgo: state.launchedAt ? Math.round((Date.now() - state.launchedAt) / 100) / 10 : null,
    contextsCreated: state.contexts,
    disconnectedAt: [...state.disconnectedAt],
  };
}

/** Closes the worker's browser, timed, and appends the record to `<outputDir>/engine-lifecycle.jsonl`. */
export async function closeBrowserTimed(browser: Browser, outputDir: string, label: string): Promise<number> {
  const start = Date.now();
  await browser.close().catch(() => undefined);
  const closeMs = Date.now() - start;
  const record = { at: new Date().toISOString(), label, ...engineState(), closeMs };
  mkdirSync(outputDir, { recursive: true });
  appendFileSync(join(outputDir, 'engine-lifecycle.jsonl'), `${JSON.stringify(record)}\n`);
  console.log(`engine: ${label} browser close took ${closeMs} ms after ${record.launchedSecondsAgo} s and ${record.contextsCreated} contexts`);
  return closeMs;
}

async function shell(command: string, args: string[]): Promise<string> {
  try {
    const { stdout, stderr } = await run(command, args, { timeout: PROBE_MS, maxBuffer: 4 << 20 });
    return `${stdout}${stderr ? `\n[stderr] ${stderr}` : ''}`.trimEnd();
  } catch (error) {
    return `unavailable: ${String((error as Error).message ?? error).split('\n')[0]}`;
  }
}

function read(path: string): string {
  try {
    return readFileSync(path, 'utf8').trimEnd();
  } catch (error) {
    return `unavailable: ${(error as Error).message}`;
  }
}

function descriptors(pid: string): number | string {
  try {
    return readdirSync(`/proc/${pid}/fd`).length;
  } catch (error) {
    return `unavailable: ${(error as Error).message}`;
  }
}

export interface NetworkProcess { pid: string; line: string; fds: number | string; status: string; maxOpenFiles: string }

/** The runner's state as WebKit sees it: its processes, each network process's descriptors, limits and memory. */
export async function systemSnapshot(): Promise<Record<string, unknown>> {
  const ps = await shell('ps', ['-ww', '-eo', 'pid,ppid,rss,nlwp,etime,args']);
  const [header, ...rows] = ps.split('\n');
  const webkit = rows.filter((row) => /webkit|wpe|pw_run|minibrowser|playwright\.app/i.test(row));
  const network: NetworkProcess[] = webkit
    .filter((row) => /NetworkProcess/.test(row))
    .map((row) => {
      const pid = row.trim().split(/\s+/)[0];
      const limits = read(`/proc/${pid}/limits`);
      return {
        pid,
        line: row.trim(),
        fds: descriptors(pid),
        status: read(`/proc/${pid}/status`),
        maxOpenFiles: limits.split('\n').find((l) => /Max open files/.test(l)) ?? limits,
      };
    });
  return {
    ps: ps.startsWith('unavailable') ? ps : [header, ...webkit].join('\n'),
    networkProcesses: network,
    ulimitN: await shell('sh', ['-c', 'ulimit -n']),
    meminfo: read('/proc/meminfo'),
    shm: await shell('df', ['-k', '/dev/shm']),
    dmesg: await shell('sh', ['-c', 'dmesg 2>&1 | tail -n 40']),
  };
}

async function timed<T>(what: () => Promise<T>): Promise<{ ms: number; value?: T; error?: string }> {
  const start = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const value = await Promise.race([
      what(),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`no answer in ${PROBE_MS} ms`)), PROBE_MS); }),
    ]);
    return { ms: Date.now() - start, value };
  } catch (error) {
    return { ms: Date.now() - start, error: String((error as Error).message ?? error).split('\n')[0] };
  } finally {
    clearTimeout(timer);
  }
}

async function loadIn(context: BrowserContext, url: string): Promise<number | null> {
  const page = await context.newPage();
  try {
    return (await page.goto(url, { timeout: PROBE_MS }))?.status() ?? null;
  } finally {
    await page.close().catch(() => undefined);
  }
}

/**
 * What still answers, as evidence for a silent hang: each page's main thread, a fresh page in each actor's context, a
 * fresh context in the same browser, and Node, each loading `/api/version`. It never decides anything: "Node is
 * answered and the page is not" is also what a stalled product page looks like.
 */
export async function hangProbe(browser: Browser, actors: { label: string; context: BrowserContext; page: Page }[], baseUrl: string | null): Promise<Record<string, unknown>> {
  const url = baseUrl ? new URL('/api/version', baseUrl).href : null;
  const open = actors.filter((actor) => !actor.page.isClosed());
  const [mainThread, freshPage, freshContext, node] = await Promise.all([
    Promise.all(open.map(async (actor) => ({ label: actor.label, ...(await timed(() => actor.page.evaluate(() => 1))) }))),
    url ? Promise.all(open.map(async (actor) => ({ label: actor.label, ...(await timed(() => loadIn(actor.context, url))) }))) : [],
    url
      ? (() => {
          // A context that answers after the race gave up is closed as soon as it arrives, not left open.
          const created = browser.newContext();
          return timed(async () => {
            const context = await created;
            try {
              return await loadIn(context, url);
            } finally {
              await context.close().catch(() => undefined);
            }
          }).then(async (result) => {
            if (result.error) void created.then((context) => context.close().catch(() => undefined), () => undefined);
            return result;
          });
        })()
      : null,
    url ? timed(async () => (await fetch(url, { signal: AbortSignal.timeout(PROBE_MS) })).status) : null,
  ]);
  return { url, mainThread, freshPage, freshContext, node };
}
