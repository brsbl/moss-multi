#!/usr/bin/env node
// DocDO memory in workerd (T3.B31a). A Cloudflare isolate may use 128 MB. Each near-cap note the j01 journeys import
// through POST /api/docs (e2e/lib/large-notes.ts) is created through the real DocDO (packages/sync/measure/doc-worker.ts)
// in a fresh workerd that runs with V8's `--trace-gc` and `--expose-gc`, in phases: the create, its debounced save, an
// export (what the search feed and a download read), each followed by a full GC. Every GC line gives the heap before
// and after it, so a phase's figures are its highest heap in use before a GC (garbage included) and its highest heap
// left after a full GC. Each note runs twice: untraced (the phase table, and the note at rest: the heap after the
// save's full GC) and traced (the DocDO also collects garbage at each named step of a server write and an export, so
// the heap at each step is known; those in-phase collections keep that phase's garbage from later gc() calls, so its
// figures are detail only). Then each phase's need is bisected: the smallest `--max-heap-size` it completes under in
// three of three fresh workerds (create, a wake of the saved note, and an export after a wake). The verdict is relative:
// for every budgeted note, the create needs at most CREATE_BUDGET and the export at most EXPORT_BUDGET times the note at
// rest. Each note's structs per block (packages/sync/measure/structs-per-block.ts) are held to its block's bound
// (T3.B31b): a plain paragraph 5, a list item 6, a two-cell table row 16. Prints markdown tables (and appends them to $GITHUB_STEP_SUMMARY), writes the figures to
// .cache/measure/memory.json, and exits non-zero when a note misses a budget. Linux needs `stdbuf` (coreutils; macOS
// has its own) so workerd's GC lines arrive as they happen. Environment: MEASURE_MEMORY_CASES (a regular expression over
// the notes' names), MEASURE_MEMORY_PORT (the first port, 9910), MEASURE_MEMORY_NEEDS=0 (skip the bisection, and the
// verdict with it), MEASURE_MEMORY_V8_FLAGS (extra V8 flags for the traced run) and MEASURE_MEMORY_DUMP (a file for the
// traced run's GC log).
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { bundle } from './measure-converter.mjs';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const OUT = join(REPO, '.cache/measure');
const NAME = 'docdo-memory';
export const ISOLATE_LIMIT_MB = 128;
// The lean layout (T3.B31b) cut the note at rest to about two fifths and every phase's need by about half; the Lexical
// tree a create or an export builds did not shrink, so the multiples rose from 1.45x and 1.6x.
/** The heap a create (an import) may need, as a multiple of the note at rest. */
export const CREATE_BUDGET = 1.75;
/** The heap an export may need, as a multiple of the note at rest. */
export const EXPORT_BUDGET = 1.95;
const REQUEST_TIMEOUT_MS = 300_000;
/** y-partyserver saves 2 s after the last update; the save compacts the note's rows. */
const SAVE_WAIT_MS = 4_000;
const PHASES = ['create', 'save', 'export'];

const requireFromSync = createRequire(join(REPO, 'packages/sync/package.json'));
const WORKERD = createRequire(requireFromSync.resolve('wrangler'))('workerd').default;

/** The most structs a block of each kind may cost (T3.B31b): a plain paragraph, a list item, a two-cell table row. */
export const STRUCT_BOUNDS = { paragraph: 5, 'list item': 6, 'table row': 16 };

/**
 * The journeys' near-cap notes, as POST /api/docs receives them, whether the budgets hold them (every note of 20,000
 * blocks or more, the table's 5,000 rows holding 10,000 cells, and the 2 MB mixed note), and the kind of block whose
 * struct bound holds them.
 */
async function cases() {
  const notes = await import('../e2e/lib/large-notes.ts');
  return [
    ['j01-large: 40,000 lines', notes.numberedLines(40_000), true, 'paragraph'],
    ['j01-paste-blocks reference: 40,000 short paragraphs', `Before.\n\n${notes.shortParagraphs(40_000)}\n\nAfter.`, true, 'paragraph'],
    ['j01-paste-list reference: 30,000 items', `Before.\n\n${notes.flatList(30_000)}\n\nAfter.`, true, 'list item'],
    ['j01-paste-race reference: 20,000 paragraphs', `Top.\n\nXYHello world here.${notes.raceLines(20_000)}\n\nTail.`, true, 'paragraph'],
    ['j01-paste-table reference: 5,000 rows', `Before.\n\n${notes.table(5_000)}\n\nAfter.`, true, 'table row'],
    ['j01-paste reference: 2 MB of mixed markdown', notes.mixedMarkdown(2_000_000), true, null],
    ['j01-paste reference: 200k of mixed markdown', notes.mixedMarkdown(200_000), false, null],
    ['cal-par-36k', notes.numberedLines(36_000), true, 'paragraph'],
    ['cal-list-33k', notes.flatList(33_334), true, 'list item'],
    ['cal-table-12k5', notes.table(12_500), true, 'table row'],
    ['cal-table-11k', notes.table(11_000), true, 'table row'],
    ['cal-mixed-1m', notes.mixedMarkdown(1_020_000), true, null],
  ];
}

/** workerd's config: the bundled measurement Worker, its SQLite-backed DocDO on disk, one HTTP socket. */
function config(port, flags, storage) {
  const list = (items) => items.map((item) => JSON.stringify(item)).join(', ');
  return `using Workerd = import "/workerd/workerd.capnp";

const config :Workerd.Config = (
  services = [
    (name = "main", worker = .measured),
    (name = "disk", disk = (path = ${JSON.stringify(storage)}, writable = true)),
  ],
  sockets = [(name = "http", address = "127.0.0.1:${port}", http = (), service = "main")],
  v8Flags = [${list(flags)}],
);

const measured :Workerd.Worker = (
  modules = [(name = "worker.js", esModule = embed "worker.js")],
  compatibilityDate = "2025-09-02",
  compatibilityFlags = ["nodejs_compat"],
  durableObjectNamespaces = [(className = "MeasuredDocDO", uniqueKey = "measured-docdo", enableSql = true)],
  durableObjectStorage = (localDisk = "disk"),
  bindings = [(name = "DocDO", durableObjectNamespace = (className = "MeasuredDocDO"))],
);
`;
}

const GC_LINE = /(Scavenge|Minor Mark-Compact|Mark-Compact(?: \(reduce\))?|Mark-Sweep)\S*\s+([\d.]+) \(([\d.]+)\) -> ([\d.]+) \(([\d.]+)\) MB/;

/** Each GC line of a `--trace-gc` log: its kind, heap in use before and after (MB), and whether gc() asked for it. */
export function gcEvents(log) {
  const events = [];
  for (const line of log.split('\n')) {
    const match = GC_LINE.exec(line);
    if (!match) continue;
    events.push({ kind: match[1], before: Number(match[2]), after: Number(match[4]), testing: /\btesting\b/.test(line) });
  }
  return events;
}

/** A phase's figures from its GC events: the highest heap before a GC, and the highest left after a full one. */
export function phaseFigures(events) {
  const full = events.filter((event) => event.kind !== 'Scavenge' && event.kind !== 'Minor Mark-Compact');
  return {
    highMb: events.reduce((high, event) => Math.max(high, event.before), 0),
    liveMb: full.reduce((high, event) => Math.max(high, event.after), 0),
    restMb: full.length ? full[full.length - 1].after : null,
  };
}

async function waitForServer(origin, child, logs) {
  const deadline = Date.now() + 60_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`workerd exited before it served\n${logs.value.slice(-2_000)}`);
    try {
      const response = await fetch(`${origin}/ping`, { signal: AbortSignal.timeout(2_000) });
      if (response.ok) return;
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) throw new Error(`workerd did not serve in 60 s\n${logs.value.slice(-2_000)}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** Refuses a port something else listens on, so a ping is never answered by another process's server. */
async function assertFree(port) {
  await new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', (error) => reject(new Error(`port ${port} is taken (${error.code}); set MEASURE_MEMORY_PORT`)));
    server.listen(port, '127.0.0.1', () => server.close(resolve));
  });
}

/** A workerd serving the measurement Worker on `port`, its DocDOs stored in `storage` (a fresh directory by default). */
async function startWorkerd(port, flags, storage = null) {
  await assertFree(port);
  const dir = join(OUT, NAME);
  if (!storage) {
    storage = join(OUT, 'state', `memory-${port}`);
    rmSync(storage, { recursive: true, force: true });
    mkdirSync(storage, { recursive: true });
  }
  const file = join(dir, `workerd-${port}.capnp`);
  writeFileSync(file, config(port, flags, storage));
  // Line-buffered, so each GC line is in the log when the request that caused it answers.
  const stdbuf = spawnSync('stdbuf', ['-oL', '-eL', 'true']).status === 0;
  const [command, args] = stdbuf ? ['stdbuf', ['-oL', '-eL', WORKERD, 'serve', '--experimental', file]] : [WORKERD, ['serve', '--experimental', file]];
  const child = spawn(command, args, { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  const logs = { value: '' };
  child.stdout.on('data', (chunk) => {
    logs.value += chunk;
  });
  child.stderr.on('data', (chunk) => {
    logs.value += chunk;
  });
  const origin = `http://127.0.0.1:${port}`;
  await waitForServer(origin, child, logs);
  return { child, logs, origin };
}

async function stopWorkerd(child) {
  if (child.exitCode !== null) return;
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    child.kill('SIGKILL');
  }
  await Promise.race([new Promise((resolve) => child.once('exit', resolve)), new Promise((resolve) => setTimeout(resolve, 5_000))]);
}

async function call(origin, path, init) {
  const response = await fetch(`${origin}${path}`, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  const body = await response.text();
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status} ${body.slice(0, 200)}`);
  return body;
}

/** Waits until the log holds `count` gc() collections, so a phase's lines are all in before the next starts. */
async function settle(server, count) {
  const deadline = Date.now() + 10_000;
  while (gcEvents(server.logs.value).filter((event) => event.testing).length < count) {
    if (Date.now() > deadline) throw new Error(`the GC trace stopped at ${gcEvents(server.logs.value).filter((event) => event.testing).length} of ${count} gc() lines`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return server.logs.value.length;
}

/**
 * One note in a fresh workerd, phase by phase. Returns each phase's figures and the base heap, or where it failed:
 * under a heap cap, V8 aborts the isolate's process once a phase cannot fit.
 */
async function measureNote(markdown, port, flags, { trace = false, wake = false } = {}) {
  const server = await startWorkerd(port, ['--expose-gc', '--trace-gc', ...flags]);
  const doc = `memory-${port}`;
  const result = { phases: {} };
  let phase = 'start';
  try {
    let gcs = 0;
    // With `trace`, the DocDO collects garbage twice at each server write's and export's phase, named in order.
    const traced = async () => (trace ? JSON.parse(await call(server.origin, `/phases?on=1&doc=${doc}`)) : []);
    const collect = async () => {
      await call(server.origin, '/gc');
      gcs += 2;
      return settle(server, gcs);
    };
    await traced();
    let mark = await collect();
    result.baseMb = phaseFigures(gcEvents(server.logs.value)).restMb;
    const steps = {
      create: () => call(server.origin, `/create?lean&doc=${doc}`, { method: 'POST', body: markdown }),
      save: () => new Promise((resolve) => setTimeout(resolve, SAVE_WAIT_MS)),
      export: () => call(server.origin, `/export?lean&doc=${doc}`),
    };
    for (phase of PHASES) {
      await steps[phase]();
      const labels = await traced();
      gcs += 2 * labels.length;
      const end = await collect();
      const events = gcEvents(server.logs.value.slice(mark, end));
      const testing = events.filter((event) => event.testing);
      result.phases[phase] = { ...phaseFigures(events), marks: labels.map((label, i) => ({ label, mb: testing[2 * i + 1]?.after ?? null })) };
      mark = end;
    }
    if (process.env.MEASURE_MEMORY_DUMP && trace) writeFileSync(process.env.MEASURE_MEMORY_DUMP, server.logs.value);
    phase = 'state';
    result.stateBytes = JSON.parse(await call(server.origin, `/state-bytes?doc=${doc}`)).stateBytes;
    if (!trace) result.blocks = JSON.parse(await call(server.origin, `/structs?doc=${doc}`));
    if (trace) {
      // A plain Y.Doc of the note's state, held beside it: what the note's Yjs structures alone take.
      const rest = async () => {
        const end = await collect();
        const figures = phaseFigures(gcEvents(server.logs.value.slice(mark, end)));
        mark = end;
        return figures.restMb;
      };
      result.structs = JSON.parse(await call(server.origin, `/hold-copy?on=1&doc=${doc}`)).structs;
      const held = await rest();
      await call(server.origin, `/hold-copy?on=0&doc=${doc}`);
      result.copyMb = held - (await rest());
    }
  } catch (error) {
    const fatal = /Fatal[^\n]*|out of memory[^\n]*/i.exec(server.logs.value)?.[0];
    result.failed = { phase, message: fatal ?? String(error.message).split('\n')[0] };
    result.logs = server.logs.value.slice(-3_000);
  } finally {
    await stopWorkerd(server.child);
  }
  if (wake && !result.failed) {
    // A fresh workerd on the same storage: the DocDO wakes and loads the saved note, as after an eviction.
    phase = 'wake';
    const again = await startWorkerd(port, ['--expose-gc', '--trace-gc', ...flags], join(OUT, 'state', `memory-${port}`));
    try {
      await call(again.origin, '/gc');
      const start = await settle(again, 2);
      await call(again.origin, `/wake?doc=${doc}`);
      await call(again.origin, '/gc');
      const end = await settle(again, 4);
      result.phases.wake = phaseFigures(gcEvents(again.logs.value.slice(start, end)));
    } catch (error) {
      result.failed = { phase, message: String(error.message).split('\n')[0] };
      result.logs = again.logs.value.slice(-3_000);
    } finally {
      await stopWorkerd(again.child);
    }
  }
  return result;
}

/** The bisection's resolution, in MB of `--max-heap-size`. */
const NEED_STEP_MB = 2;
const NEED_CEILING_MB = 1024;
const NEED_DOC = 'needs';

/**
 * The smallest heap cap (MB, to NEED_STEP_MB) under which `fits(cap)` holds, searching from `low` (halved until it
 * fails) and `high` (doubled until it holds). Null past NEED_CEILING_MB.
 */
export async function smallestCap(fits, low, high) {
  low = Math.max(1, Math.floor(low));
  high = Math.max(low + NEED_STEP_MB, Math.ceil(high));
  while (await fits(low)) {
    if (low <= NEED_STEP_MB) return low;
    high = low;
    low = Math.floor(low / 2);
  }
  while (!(await fits(high))) {
    if (high >= NEED_CEILING_MB) return null;
    low = high;
    high = Math.min(NEED_CEILING_MB, high * 2);
  }
  while (high - low > NEED_STEP_MB) {
    const mid = Math.round((low + high) / 2);
    if (await fits(mid)) high = mid;
    else low = mid;
  }
  return high;
}

/** How many fresh runs in a row a cap must fit. */
export const NEED_RUNS = 3;

/**
 * smallestCap, then confirmed: V8's verdict near the limit varies from run to run (its give-up heuristics are timed),
 * so the cap found must fit NEED_RUNS runs of NEED_RUNS (the bisection's own probe is the first), or the next one up
 * is tried from scratch. Null past NEED_CEILING_MB.
 */
export async function reliableCap(fits, low, high) {
  let cap = await smallestCap(fits, low, high);
  let fitted = 1;
  while (cap !== null) {
    let ok = true;
    for (; ok && fitted < NEED_RUNS; fitted += 1) ok = await fits(cap);
    if (ok) return cap;
    cap += NEED_STEP_MB;
    fitted = 0;
    if (cap > NEED_CEILING_MB) return null;
  }
  return null;
}

/** Runs `request` against a workerd capped at `cap` MB; whether it answered (V8 aborts the process past the cap). */
const OUT_OF_HEAP = /heap limit|out of memory/i;

/** The signals a process aborting on its heap dies by. */
const CRASH_SIGNALS = new Set(['SIGABRT', 'SIGTRAP', 'SIGILL', 'SIGSEGV', 'SIGBUS']);

async function fitsUnder(cap, port, storage, request) {
  let server;
  try {
    server = await startWorkerd(port, [`--max-heap-size=${cap}`], storage);
  } catch (error) {
    // Too small a heap for the Worker itself (it may die before its heap message reaches the log); anything else is
    // not an answer.
    if (OUT_OF_HEAP.test(error.message) || /exited before it served/.test(error.message)) return false;
    throw error;
  }
  try {
    await request(server.origin);
    return server.child.exitCode === null;
  } catch (error) {
    // Only V8 giving up on the heap counts as not fitting: it aborts the process, so wait for the exit and its message.
    const exited = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(server.child.exitCode !== null || server.child.signalCode !== null), 10_000);
      server.child.once('close', () => {
        clearTimeout(timer);
        resolve(true);
      });
    });
    if (exited && OUT_OF_HEAP.test(server.logs.value)) return false;
    // V8 near its cap sometimes dies by a signal before its fatal message reaches the log; a crash that is not the cap
    // recurs at every cap, so the search runs up to its ceiling and the need reads unknown.
    const { exitCode, signalCode } = server.child;
    if (exited && (CRASH_SIGNALS.has(signalCode) || exitCode >= 128)) {
      console.error(`measure-memory:   under ${cap} MB workerd died (${signalCode ?? `exit ${exitCode}`}) with no heap message; counted as not fitting`);
      return false;
    }
    throw new Error(`under ${cap} MB the request failed without running out of heap (exit ${exitCode}, signal ${signalCode}): ${error.message}\n${server.logs.value.slice(-1_000)}`, { cause: error });
  } finally {
    await stopWorkerd(server.child);
  }
}

/**
 * The heap each phase needs (the smallest `--max-heap-size` it completes under, in MB), bisected in fresh workerds:
 * the create from empty storage; the wake (a DocDO loading the saved note) and the export (wake, then export) from a
 * copy of the storage an uncapped workerd left once the note was created and saved. `guess` gives each search's
 * starting bounds.
 */
async function measureNeeds(markdown, port, guess) {
  const storage = (name) => join(OUT, 'state', `needs-${port}-${name}`);
  const fresh = (name) => {
    rmSync(storage(name), { recursive: true, force: true });
    mkdirSync(storage(name), { recursive: true });
    return storage(name);
  };
  const create = (origin) => call(origin, `/create?lean&doc=${NEED_DOC}`, { method: 'POST', body: markdown });
  // The note, created and saved, for the wake and export searches to copy.
  const saved = fresh('saved');
  const writer = await startWorkerd(port, [], saved);
  try {
    await create(writer.origin);
    await new Promise((resolve) => setTimeout(resolve, SAVE_WAIT_MS));
  } finally {
    await stopWorkerd(writer.child);
  }
  const fromSaved = () => {
    const copy = fresh('probe');
    cpSync(saved, copy, { recursive: true });
    return copy;
  };
  // Each probe is logged, so a run cut short still shows how far each search got.
  const logged = (phase, fits) => async (cap) => {
    const started = Date.now();
    const ok = await fits(cap);
    console.error(`measure-memory:   ${phase} under ${cap} MB: ${ok ? 'fits' : 'fails'} (${((Date.now() - started) / 1000).toFixed(1)} s)`);
    return ok;
  };
  const needs = {};
  needs.create = await reliableCap(logged('create', (cap) => fitsUnder(cap, port, fresh('probe'), create)), guess.low, guess.create);
  needs.wake = await reliableCap(logged('wake', (cap) => fitsUnder(cap, port, fromSaved(), (origin) => call(origin, `/wake?doc=${NEED_DOC}`))), guess.low, guess.wake);
  needs.export = await reliableCap(logged('export', (cap) => fitsUnder(cap, port, fromSaved(), (origin) => call(origin, `/export?lean&doc=${NEED_DOC}`))), guess.low, guess.export);
  rmSync(storage('saved'), { recursive: true, force: true });
  rmSync(storage('probe'), { recursive: true, force: true });
  return needs;
}

/** A phase's need as a multiple of the note at rest, or null when either is unknown. */
export const ratio = (need, rest) => (typeof need === 'number' && typeof rest === 'number' && rest > 0 ? need / rest : null);

/**
 * Every way the measured notes miss a budget (empty when they meet them). The note at rest is the untraced run's: the
 * traced run's gc() calls inside a phase keep that phase's garbage from later gc() calls.
 */
export function memoryProblems(notes) {
  const problems = [];
  for (const n of notes) {
    for (const [run, result] of [['untraced', n.plain], ['traced', n.measured]]) {
      if (result?.failed) problems.push(`${n.name}: the ${run} run failed (${result.failed.phase}: ${result.failed.message})`);
    }
    const bound = n.block ? STRUCT_BOUNDS[n.block] : undefined;
    if (bound !== undefined) {
      const median = n.plain?.blocks?.median;
      if (typeof median !== 'number') problems.push(`${n.name}: its structs per block are unknown`);
      else if (median > bound) problems.push(`${n.name}: a ${n.block} costs ${median} structs, over ${bound}`);
    }
    if (!n.budget || !n.needs) continue;
    const rest = n.plain?.phases?.save?.restMb;
    for (const [phase, budget] of [['create', CREATE_BUDGET], ['export', EXPORT_BUDGET]]) {
      const times = ratio(n.needs[phase], rest);
      if (times === null) problems.push(`${n.name}: the ${phase}'s need is unknown (${n.needs[phase]} MB, at rest ${rest} MB)`);
      else if (times > budget) problems.push(`${n.name}: the ${phase} needs ${n.needs[phase]} MB, ${times.toFixed(2)}x the note at rest (${rest} MB), over ${budget}x`);
    }
  }
  return problems;
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  await bundle(NAME, join(REPO, 'packages/sync/measure/doc-worker.ts'));
  const notes = [];
  let port = Number(process.env.MEASURE_MEMORY_PORT ?? 9910);
  // MEASURE_MEMORY_CASES (a regular expression) measures only the notes it matches.
  const only = process.env.MEASURE_MEMORY_CASES ? new RegExp(process.env.MEASURE_MEMORY_CASES) : null;
  // MEASURE_MEMORY_NEEDS=0 skips the per-phase heap-cap bisection.
  const bisect = process.env.MEASURE_MEMORY_NEEDS !== '0';
  for (const [name, markdown, budget, block] of (await cases()).filter(([name]) => !only || only.test(name))) {
    // Untraced first: its figures (the note at rest among them) bound the bisection's searches.
    const plain = await measureNote(markdown, port, [], { wake: true });
    const measured = await measureNote(markdown, port + 1, (process.env.MEASURE_MEMORY_V8_FLAGS ?? '').split(' ').filter(Boolean), { trace: true });
    const rest = plain.phases.save?.restMb ?? measured.phases.save?.restMb ?? 8;
    const high = (phase) => Math.max(plain.phases[phase]?.highMb ?? 0, measured.phases[phase]?.liveMb ?? 0, rest) + 8;
    // Every phase so far has needed more than 1.2x the note at rest, which bounds each search from below.
    const needs = bisect ? await measureNeeds(markdown, port + 2, { low: rest * 1.15, create: high('create'), wake: rest * 1.4, export: high('export') }) : null;
    port += 3;
    notes.push({ name, budget, block, markdownBytes: Buffer.byteLength(markdown), measured, plain, needs });
    const at = (run, phase) => `${run.phases[phase]?.highMb ?? '?'}/${run.phases[phase]?.liveMb ?? '?'}`;
    console.error(`measure-memory: ${name} done: at rest ${rest} MB; untraced high/live create ${at(plain, 'create')}, export ${at(plain, 'export')}, wake ${at(plain, 'wake')}; needs ${JSON.stringify(needs)}`);
  }
  const mb = (value) => (typeof value === 'number' ? `${value.toFixed(1)} MB` : '?');
  const figures = (phase) => (phase ? `${mb(phase.highMb)} / ${mb(phase.liveMb)}` : '');
  const times = (need, rest, limit) => {
    const value = ratio(need, rest);
    if (value === null) return '?';
    const verdict = limit === null ? '' : value <= limit ? `, within ${limit}x` : `, OVER ${limit}x`;
    return `${need} MB (${value.toFixed(2)}x${verdict})`;
  };
  const perBlock = ({ block, plain: p }) => {
    const b = p.blocks;
    if (!b) return '?';
    const bound = block ? STRUCT_BOUNDS[block] : undefined;
    const verdict = bound === undefined ? '' : b.median <= bound ? `, within ${bound}` : `, OVER ${bound}`;
    return `${b.median} (mean ${b.mean.toFixed(2)} of ${b.blocks} blocks${verdict})`;
  };
  const lines = [
    '### DocDO memory in workerd (T3.B31a)',
    '',
    `Isolate JS heap from V8's GC trace, untraced run: per phase, the highest in use before a GC / the highest left after a full GC. The isolate limit is ${ISOLATE_LIMIT_MB} MB. Array buffers (the stored state) are outside these figures.`,
    '',
    'Structs per block: the median block\'s Yjs structs (a list\'s blocks are its items, a table\'s its rows), held to its kind\'s bound (T3.B31b).',
    '',
    '| Note | Markdown | State | Structs per block | Base | Create | Save | Export | At rest | Wake | Woken at rest |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...notes.map((n) => {
      const { name, markdownBytes, measured: m, plain: p } = n;
      return `| ${name} | ${mb(markdownBytes / 2 ** 20)} | ${m.stateBytes ? mb(m.stateBytes / 2 ** 20) : '?'} | ${perBlock(n)} | ${mb(p.baseMb)} | ${figures(p.phases.create)} | ${figures(p.phases.save)} | ${figures(p.phases.export)} | ${mb(p.phases.save?.restMb)} | ${figures(p.phases.wake)} | ${mb(p.phases.wake?.restMb)} |`;
    }),
  ];
  if (bisect) {
    lines.push(
      '',
      `Heap each phase needs: the smallest \`--max-heap-size\` (to ${NEED_STEP_MB} MB) it completes under in ${NEED_RUNS} of ${NEED_RUNS} fresh workerds, and that as a multiple of the note at rest (the untraced run's heap after the save's full GC, base included). Wake: a DocDO loading the saved note; export: a wake, then the export (what the search feed and a download run). Budgets, for notes of 20,000 blocks or more and the 2 MB mixed note: create at most ${CREATE_BUDGET}x, export at most ${EXPORT_BUDGET}x.`,
      '',
      '| Note | At rest | Create needs | Wake needs | Export needs |',
      '| --- | --- | --- | --- | --- |',
      ...notes.map(({ name, budget, plain: p, needs: n }) => {
        const rest = p.phases.save?.restMb;
        return `| ${name} | ${mb(rest)} | ${times(n?.create, rest, budget ? CREATE_BUDGET : null)} | ${times(n?.wake, rest, null)} | ${times(n?.export, rest, budget ? EXPORT_BUDGET : null)} |`;
      }),
    );
  }
  const report = lines.join('\n');
  console.log(report);
  const bare = (run) => (run ? { ...run, logs: undefined } : run);
  writeFileSync(join(OUT, 'memory.json'), `${JSON.stringify(notes.map((n) => ({ ...n, measured: bare(n.measured), plain: bare(n.plain) })), null, 2)}\n`);
  for (const n of notes) {
    if (n.measured.failed) console.error(`${n.name} (traced):\n${n.measured.logs}`);
    if (n.plain.failed) console.error(`${n.name} (untraced):\n${n.plain.logs}`);
  }
  const traces = notes.map(({ name, measured: m }) => [
    `- ${name}: a plain Y.Doc of the note ${mb(m.copyMb)} (${m.structs} structs, ${Math.round((m.copyMb * 2 ** 20) / m.structs)} B each);`,
    PHASES.flatMap((phase) => (m.phases[phase]?.marks ?? []).map(({ label, mb: at }) => `${label} ${mb(at)}`)).join(', '),
  ].join(' '));
  const details = ['', 'Traced run: heap after a full GC at each phase of the server write and the export:', '', ...traces].join('\n');
  console.log(details);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${report}\n${details}\n`);
  const problems = memoryProblems(notes);
  if (problems.length > 0) {
    console.error(`measure-memory: ${problems.join('; ')}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`measure-memory: ${error.stack ?? error.message}`);
    process.exitCode = 1;
  });
}
