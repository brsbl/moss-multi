#!/usr/bin/env node
// DocDO memory in workerd (T3.B31). A Cloudflare isolate may use 128 MB, and a create past it fails with
// `exceededMemory`; the local stack enforces no limit. Each near-cap note the j01 journeys import through POST /api/docs
// (e2e/lib/large-notes.ts) is created through the real DocDO (packages/sync/measure/doc-worker.ts) in a fresh workerd
// that runs with V8's `--trace-gc` and `--expose-gc`, in phases: the create, its debounced save, an export (what the
// search feed and a download read), each followed by a full GC. Every GC line gives the heap before and after it, so a
// phase's figures are its highest heap in use before a GC (garbage included) and its highest heap left after a full
// GC. The verdict comes from a second workerd whose V8 heap is capped at PEAK_BUDGET_MB (`--max-heap-size`): V8 then
// collects as hard as it can before giving up, so every phase must finish under the cap, and the note at rest (after
// the export) must hold under REST_BUDGET_MB. Prints a markdown table (and appends it to $GITHUB_STEP_SUMMARY), writes
// the figures to .cache/measure/memory.json, and exits non-zero when a note misses either budget. Linux needs
// `stdbuf` (coreutils) so workerd's GC lines arrive as they happen.
// MEM.lean: each note is measured under both stored layouts of the @lexical/yjs patch in the same run, `v1` (the
// layout before LEAN_LAYOUT, the baseline) and `lean`, each also under a heap capped at the isolate's 128 MB; the
// budgets judge the lean layout. MEASURE_MEMORY_PORT moves the first workerd port (9910).
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { bundle } from './measure-converter.mjs';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const OUT = join(REPO, '.cache/measure');
const NAME = 'docdo-memory';
export const ISOLATE_LIMIT_MB = 128;
/** The isolate's heap at its peak in any phase, so a socket's frames and a second doc still fit under the limit. */
export const PEAK_BUDGET_MB = 96;
/** The isolate's heap holding the note at rest. */
export const REST_BUDGET_MB = 48;
const REQUEST_TIMEOUT_MS = 300_000;
/** y-partyserver saves 2 s after the last update; the save compacts the note's rows. */
const SAVE_WAIT_MS = 4_000;
const PHASES = ['create', 'save', 'export'];
/** The stored layouts measured, baseline first; the budgets judge the last. */
export const LAYOUTS = ['v1', 'lean'];

const requireFromSync = createRequire(join(REPO, 'packages/sync/package.json'));
const WORKERD = createRequire(requireFromSync.resolve('wrangler'))('workerd').default;

/** The journeys' near-cap notes, as POST /api/docs receives them. */
async function cases() {
  const notes = await import('../e2e/lib/large-notes.ts');
  return [
    ['j01-large: 40,000 lines', notes.numberedLines(40_000)],
    ['j01-paste-blocks reference: 40,000 short paragraphs', `Before.\n\n${notes.shortParagraphs(40_000)}\n\nAfter.`],
    ['j01-paste-list reference: 30,000 items', `Before.\n\n${notes.flatList(30_000)}\n\nAfter.`],
    ['j01-paste-race reference: 20,000 paragraphs', `Top.\n\nXYHello world here.${notes.raceLines(20_000)}\n\nTail.`],
    ['j01-paste-table reference: 5,000 rows', `Before.\n\n${notes.table(5_000)}\n\nAfter.`],
    ['j01-paste reference: 2 MB of mixed markdown', notes.mixedMarkdown(2_000_000)],
    ['j01-paste reference: 200k of mixed markdown', notes.mixedMarkdown(200_000)],
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

async function startWorkerd(port, flags) {
  const dir = join(OUT, NAME);
  const storage = join(OUT, 'state', `memory-${port}`);
  rmSync(storage, { recursive: true, force: true });
  mkdirSync(storage, { recursive: true });
  const file = join(dir, `workerd-${port}.capnp`);
  writeFileSync(file, config(port, flags, storage));
  // Line-buffered, so each GC line is in the log when the request that caused it answers.
  const stdbuf = spawnSync('stdbuf', ['-oL', 'true']).status === 0;
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
async function measureNote(markdown, port, flags, { trace = false, layout = 'lean' } = {}) {
  const server = await startWorkerd(port, ['--expose-gc', '--trace-gc', ...flags]);
  const doc = `memory-${port}`;
  const result = { phases: {} };
  let phase = 'start';
  try {
    result.layout = JSON.parse(await call(server.origin, `/layout?name=${layout}&doc=${doc}`)).layout;
    if (result.layout !== layout) throw new Error(`the DocDO runs layout ${result.layout}, not ${layout}`);
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
    phase = 'state';
    result.stateBytes = JSON.parse(await call(server.origin, `/state-bytes?doc=${doc}`)).stateBytes;
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
      await call(server.origin, `/hold-copy?on=1&intern&doc=${doc}`);
      const interned = await rest();
      await call(server.origin, `/hold-copy?on=0&doc=${doc}`);
      result.internedCopyMb = interned - (await rest());
    }
  } catch (error) {
    const fatal = /Fatal[^\n]*|out of memory[^\n]*/i.exec(server.logs.value)?.[0];
    result.failed = { phase, message: fatal ?? String(error.message).split('\n')[0] };
    result.logs = server.logs.value.slice(-3_000);
  } finally {
    await stopWorkerd(server.child);
  }
  return result;
}

/** Every way the measured notes miss a budget (empty when they meet both). */
export function memoryProblems(notes) {
  const problems = [];
  for (const n of notes) {
    if (n.measured.failed) problems.push(`${n.name}: not measured (${n.measured.failed.phase}: ${n.measured.failed.message})`);
    if (n.capped.failed) problems.push(`${n.name}: the ${n.capped.failed.phase} does not fit a ${PEAK_BUDGET_MB} MB heap (${n.capped.failed.message})`);
    const rest = n.measured.phases?.export?.restMb;
    if (typeof rest === 'number' && rest > REST_BUDGET_MB) problems.push(`${n.name}: the note at rest holds ${rest} MB, over ${REST_BUDGET_MB} MB`);
  }
  return problems;
}

/** A run's highest heap left after a full GC over every phase (the traced phase marks included). */
export const peakLive = (measured) => Math.max(0, ...PHASES.map((phase) => measured.phases?.[phase]?.liveMb ?? 0));
/** A run's highest heap in use before a GC over every phase, garbage included. */
export const peakInUse = (measured) => Math.max(0, ...PHASES.map((phase) => measured.phases?.[phase]?.highMb ?? 0));

async function main() {
  mkdirSync(OUT, { recursive: true });
  await bundle(NAME, join(REPO, 'packages/sync/measure/doc-worker.ts'));
  const notes = [];
  let port = Number(process.env.MEASURE_MEMORY_PORT ?? 9910);
  for (const [name, markdown] of await cases()) {
    for (const layout of LAYOUTS) {
      const measured = await measureNote(markdown, port, [], { trace: true, layout });
      const capped = await measureNote(markdown, port + 1, [`--max-heap-size=${PEAK_BUDGET_MB}`], { layout });
      const isolate = await measureNote(markdown, port + 2, [`--max-heap-size=${ISOLATE_LIMIT_MB}`], { layout });
      port += 3;
      notes.push({ name, layout, markdownBytes: Buffer.byteLength(markdown), lines: markdown.split('\n').filter((line) => line.trim() !== '').length, measured, capped, isolate });
      console.error(`measure-memory: ${name} (${layout}) done`);
    }
  }
  const mb = (value) => (typeof value === 'number' ? `${value.toFixed(1)} MB` : '?');
  const figures = (phase) => (phase ? `${mb(phase.highMb)} / ${mb(phase.liveMb)}` : '');
  const fits = (run) => (run.failed ? `FAILED in ${run.failed.phase}` : 'yes');
  const lines = [
    '### DocDO memory in workerd (T3.B31, MEM.lean)',
    '',
    `Isolate JS heap from V8's GC trace: per phase, the highest in use before a GC / the highest left after a full GC. Budget: every phase fits a ${PEAK_BUDGET_MB} MB heap cap (V8 collecting as hard as it can), and the note at rest holds under ${REST_BUDGET_MB} MB; the isolate limit is ${ISOLATE_LIMIT_MB} MB. Array buffers (the stored state) are outside these figures. Layout v1 is the stored layout before MEM.lean (the baseline), lean the prototype; the budgets judge lean.`,
    '',
    `| Note | Layout | Markdown | State | Base | Create | Save | Export | At rest | Peak live | Under ${PEAK_BUDGET_MB} MB | Under ${ISOLATE_LIMIT_MB} MB |`,
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...notes.map(({ name, layout, markdownBytes, measured: m, capped: c, isolate: i }) => `| ${name} | ${layout} | ${mb(markdownBytes / 2 ** 20)} | ${m.stateBytes ? mb(m.stateBytes / 2 ** 20) : '?'} | ${mb(m.baseMb)} | ${figures(m.phases.create)} | ${figures(m.phases.save)} | ${figures(m.phases.export)} | ${mb(m.phases.export?.restMb)} | ${mb(peakLive(m))} | ${fits(c)} | ${fits(i)} |`),
  ];
  const pairs = [...new Set(notes.map((n) => n.name))].map((name) => LAYOUTS.map((layout) => notes.find((n) => n.name === name && n.layout === layout)));
  const ratio = (before, after) => (typeof before === 'number' && typeof after === 'number' && after > 0 ? `${(before / after).toFixed(2)}x` : '?');
  const pair = (a, b) => `${mb(a)} / ${mb(b)} (${ratio(a, b)})`;
  const perLine = (n) => (n.measured.structs ? (n.measured.structs / n.lines).toFixed(2) : '?');
  const state = (n) => (n.measured.stateBytes ? mb(n.measured.stateBytes / 2 ** 20) : '?');
  const comparison = [
    '',
    "Lean against v1, same run. Structs: a plain Y.Doc of the note's state; per line: structs over the markdown's non-empty lines (a paragraph, a list item or a table row each).",
    '',
    '| Note | Structs v1 / lean | Per line v1 / lean | State v1 / lean | Plain Y.Doc v1 / lean | At rest v1 / lean | Peak live v1 / lean | Peak in use v1 / lean |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
    ...pairs.map(([v1, lean]) => `| ${v1.name} | ${v1.measured.structs} / ${lean.measured.structs} (${ratio(v1.measured.structs, lean.measured.structs)}) | ${perLine(v1)} / ${perLine(lean)} | ${state(v1)} / ${state(lean)} | ${pair(v1.measured.copyMb, lean.measured.copyMb)} | ${pair(v1.measured.phases.export?.restMb, lean.measured.phases.export?.restMb)} | ${pair(peakLive(v1.measured), peakLive(lean.measured))} | ${pair(peakInUse(v1.measured), peakInUse(lean.measured))} |`),
  ];
  const report = [...lines, ...comparison].join('\n');
  console.log(report);
  const strip = (run) => ({ ...run, logs: undefined });
  writeFileSync(join(OUT, 'memory.json'), `${JSON.stringify(notes.map((n) => ({ ...n, measured: strip(n.measured), capped: strip(n.capped), isolate: strip(n.isolate) })), null, 2)}\n`);
  for (const n of notes) {
    if (n.measured.failed) console.error(`${n.name} ${n.layout} (measured):\n${n.measured.logs}`);
    if (n.capped.failed) console.error(`${n.name} ${n.layout} (capped):\n${n.capped.logs?.slice(-1_000)}`);
  }
  const traces = notes.map(({ name, layout, measured: m }) => [
    `- ${name} (${layout}): a plain Y.Doc of the note ${mb(m.copyMb)} (${m.structs} structs, ${Math.round((m.copyMb * 2 ** 20) / m.structs)} B each; keys interned ${mb(m.internedCopyMb)});`,
    PHASES.flatMap((phase) => (m.phases[phase]?.marks ?? []).map(({ label, mb: at }) => `${label} ${mb(at)}`)).join(', '),
  ].join(' '));
  const details = ['', 'Heap after a full GC at each phase of the server write and the export:', '', ...traces].join('\n');
  console.log(details);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${report}\n${details}\n`);
  const problems = memoryProblems(notes.filter((n) => n.layout === LAYOUTS[LAYOUTS.length - 1]));
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
