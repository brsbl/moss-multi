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
// the figures to .cache/measure/memory.json, and exits non-zero when a note misses either budget. `stdbuf` (coreutils
// on Linux) makes workerd's GC lines arrive as they happen.
//
// Where the memory goes (packages/sync/measure/struct-breakdown.ts): for each note, its structs by kind, its map entries
// by node type and key and how many hold their type's default value, the exact structs of one node of each type, and its
// body rebuilt with fewer structs (default-valued entries left out, and further), each held beside the note for its
// heap and hydrated through the unmodified binding to check the editor state is the same. Then, in a fresh workerd,
// SHAPE_BLOCKS synthetic blocks of shapes that each add one struct kind, for the heap per struct of each kind.
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

const requireFromSync = createRequire(join(REPO, 'packages/sync/package.json'));
const WORKERD = createRequire(requireFromSync.resolve('wrangler'))('workerd').default;

/** The journeys' near-cap notes, as POST /api/docs receives them. */
async function cases() {
  const notes = await import('../e2e/lib/large-notes.ts');
  const only = process.env.MEASURE_MEMORY_ONLY;
  return (await allCases(notes)).filter(([name]) => !only || name.includes(only));
}

async function allCases(notes) {
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

/** A request that only reads or replaces what the DocDO holds, so a dropped connection may send it again once. */
const AGAIN = { retries: 1 };

async function call(origin, path, init, { retries = 0 } = {}) {
  for (let attempt = 0; ; attempt += 1) {
    let response;
    try {
      response = await fetch(`${origin}${path}`, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    } catch (error) {
      const cause = error.cause ? ` (${[error.cause.code, error.cause.message].filter(Boolean).join(': ')})` : '';
      if (attempt < retries) {
        console.error(`measure-memory: ${path}: ${error.message}${cause}; sending it again`);
        continue;
      }
      throw new Error(`${path}: ${error.message}${cause}`);
    }
    const body = await response.text();
    if (!response.ok) throw new Error(`${path}: HTTP ${response.status} ${body.slice(0, 200)}`);
    return body;
  }
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
async function measureNote(markdown, port, flags, { trace = false } = {}) {
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
      // Where the structs go: by kind, by owner and key, and one node of each type struct by struct.
      phase = 'breakdown';
      const { breakdown, samples } = JSON.parse(await call(server.origin, `/breakdown?doc=${doc}`, undefined, AGAIN));
      result.breakdown = breakdown;
      result.samples = samples;
      // The body rebuilt with fewer structs, held beside the note: its heap, and whether the binding reads it back as
      // the same editor state.
      const { variants } = JSON.parse(await call(server.origin, '/variants', undefined, AGAIN));
      result.variants = [];
      for (const variant of variants) {
        phase = `variant ${variant}`;
        const held = JSON.parse(await call(server.origin, `/hold-rebuilt?variant=${encodeURIComponent(variant)}&doc=${doc}`, undefined, AGAIN));
        const heldMb = await rest();
        await call(server.origin, `/hold-rebuilt?doc=${doc}`, undefined, AGAIN);
        const mb = heldMb - (await rest());
        // A variant compacted after decoding has its uncompacted variant's encoding, verified on its own row.
        const check = variant.includes(', decoded with')
          ? { same: null, compacted: true }
          : JSON.parse(await call(server.origin, `/verify-rebuilt?variant=${encodeURIComponent(variant)}&doc=${doc}`, undefined, AGAIN));
        result.variants.push({ variant, structs: held.structs, kinds: held.kinds, mb, check });
      }
      await rest();
    }
  } catch (error) {
    const fatal = /Fatal[^\n]*|out of memory[^\n]*/i.exec(server.logs.value)?.[0];
    result.failed = { phase, message: fatal ?? String(error.message).split('\n')[0] };
    result.logs = server.logs.value.slice(-3_000);
    // Without the GC lines, so the failure's own lines are in the tail.
    const quiet = server.logs.value.split('\n').filter((line) => !GC_LINE.test(line)).join('\n');
    result.errors = quiet.slice(-3_000);
  } finally {
    await stopWorkerd(server.child);
  }
  return result;
}

/** How many synthetic blocks of each shape the per-kind measurement holds, and how many times it holds each. */
const SHAPE_BLOCKS = 100_000;
const SHAPE_ROUNDS = 2;
const SHAPE_PROCESSES = 2;

/** One figure per shape from several processes' runs: the median of every round, each process's rounds kept. */
export function mergeShapeRuns(runs) {
  const shapes = [];
  for (const [index, run] of runs.entries()) {
    for (const shape of run.shapes) {
      let merged = shapes.find((entry) => entry.shape === shape.shape);
      if (!merged) {
        merged = { shape: shape.shape, n: shape.n, structs: shape.structs, kinds: shape.kinds, processes: [] };
        shapes.push(merged);
      }
      merged.processes[index] = shape.rounds;
    }
  }
  for (const shape of shapes) shape.mb = median(shape.processes.flat());
  const failed = runs.filter((run) => run.failed).map((run) => run.failed).join('; ');
  return failed ? { shapes, failed } : { shapes };
}

export function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * Heap per struct kind: `n` blocks of each synthetic shape (packages/sync/measure/struct-breakdown.ts SHAPES), encoded
 * and decoded into a fresh Y.Doc held in the DocDO, against the heap after it is released.
 */
async function measureShapes(port, n) {
  const server = await startWorkerd(port, ['--expose-gc', '--trace-gc']);
  const doc = `shapes-${port}`;
  const shapes = [];
  let gcs = 0;
  let mark = 0;
  const rest = async () => {
    await call(server.origin, '/gc');
    gcs += 2;
    const end = await settle(server, gcs);
    const figures = phaseFigures(gcEvents(server.logs.value.slice(mark, end)));
    mark = end;
    return figures.restMb;
  };
  try {
    const { shapes: names } = JSON.parse(await call(server.origin, '/variants', undefined, AGAIN));
    await call(server.origin, `/hold-synthetic?doc=${doc}`, undefined, AGAIN);
    await rest();
    // Every shape SHAPE_ROUNDS times, round-robin; mergeShapeRuns takes the median over every process's rounds.
    for (let round = 0; round < SHAPE_ROUNDS; round += 1) {
      for (const shape of names) {
        const held = JSON.parse(await call(server.origin, `/hold-synthetic?shape=${encodeURIComponent(shape)}&n=${n}&doc=${doc}`, undefined, AGAIN));
        const heldMb = await rest();
        await call(server.origin, `/hold-synthetic?doc=${doc}`, undefined, AGAIN);
        const mb = heldMb - (await rest());
        const entry = shapes.find((s) => s.shape === shape);
        if (entry) entry.rounds.push(mb);
        else shapes.push({ shape, n, structs: held.structs, kinds: held.kinds, rounds: [mb] });
      }
    }
    return { shapes };
  } catch (error) {
    return { shapes, failed: String(error.message).split('\n')[0], logs: server.logs.value.slice(-3_000) };
  } finally {
    await stopWorkerd(server.child);
  }
}

/** Each per-kind figure: what it is, the shape that adds it, and the shape that shape is compared with (null: nothing). */
export const KIND_COSTS = [
  ['a block: ContentType XmlText, empty', 'XmlText', null],
  ['a block entry: ContentAny map entry (`__type`)', 'XmlText + 1 entry', 'XmlText'],
  ["a block entry: ContentAny map entry (each of a paragraph's 7)", 'XmlText + 7 entries', 'XmlText'],
  ['a text: ContentString (about 20 chars)', 'XmlText + string', 'XmlText'],
  ["a text run's map: ContentType Map, empty", 'XmlText + Map', 'XmlText'],
  ["a text run's entry: ContentAny map entry (each of 5)", 'XmlText + Map + 5 entries', 'XmlText + Map'],
  ['a format mark: ContentFormat (each of the 2 around a text)', 'XmlText + formatted string', 'XmlText + string'],
  ['a decorator: ContentType XmlElement, empty', 'XmlElement', null],
  ['a paragraph with one text run, as @lexical/yjs writes it', 'paragraph as written', null],
  ['the same paragraph without its default-valued entries', 'paragraph, defaults left out', null],
  ['exact-size arrays and shared keys: a block entry (`__type`)', 'XmlText + 1 entry, compacted', 'XmlText'],
  ["exact-size arrays and shared keys: a block entry (each of a paragraph's 7)", 'XmlText + 7 entries, compacted', 'XmlText'],
  ["exact-size arrays and shared keys: a text run's entry (each of 5)", 'XmlText + Map + 5 entries, compacted', 'XmlText + Map'],
  ['exact-size arrays and shared keys: a paragraph as written', 'paragraph as written, compacted', null],
  ['exact-size arrays and shared keys: a paragraph without default entries', 'paragraph, defaults left out, compacted', null],
];

/** Bytes of heap per added struct and per block for each KIND_COSTS row, from the measured shapes. */
export function kindCosts(shapes) {
  const byName = new Map(shapes.map((shape) => [shape.shape, shape]));
  return KIND_COSTS.map(([label, shape, base]) => {
    const held = byName.get(shape);
    const against = base === null ? { structs: 0, mb: 0 } : byName.get(base);
    if (!held || !against) return { label, shape, base, missing: true };
    const added = held.structs - against.structs;
    const bytes = (held.mb - against.mb) * 2 ** 20;
    return { label, shape, base, structsPerBlock: added / held.n, perStruct: bytes / added, perBlock: bytes / held.n };
  });
}

const shortName = (name) => name.split(': ').slice(1).join(': ') || name;
const thousands = (value) => (typeof value === 'number' ? value.toLocaleString('en-US') : '?');

/** The breakdown's markdown: structs by kind, entries by key, one node of each type, the rebuilt bodies, per-kind heap. */
export function breakdownReport(notes, measuredShapes) {
  const traced = notes.filter((note) => note.measured.breakdown);
  const out = [];
  const header = (first) => [`| ${first} | ${traced.map((note) => shortName(note.name)).join(' | ')} |`, `| --- |${traced.map(() => ' ---: |').join('')}`];
  const row = (label, cell) => `| ${label} | ${traced.map((note) => cell(note.measured.breakdown)).join(' | ')} |`;
  if (traced.length) {
    const sum = (kind) => traced.reduce((total, note) => total + (note.measured.breakdown.kinds[kind] ?? 0), 0);
    const kinds = [...new Set(traced.flatMap((note) => Object.keys(note.measured.breakdown.kinds)))].sort((a, b) => sum(b) - sum(a));
    out.push('', '#### Structs by kind in the note at rest', '', ...header('Struct kind'));
    out.push(row('**all structs**', (b) => thousands(b.structs)));
    for (const kind of kinds) out.push(row(kind, (b) => thousands(b.kinds[kind] ?? 0)));
    out.push(
      row('deleted items (of the above)', (b) => thousands(b.deletedItems)),
      row('blocks (XmlText and XmlElement embeds)', (b) => thousands(b.totals.blocks)),
      row('text runs (Map embeds other than linebreak)', (b) => thousands(b.totals.textRuns)),
      row('live map entries', (b) => thousands(b.totals.liveEntries)),
      row('&nbsp;&nbsp;of them `__type` keys', (b) => thousands(b.totals.typeKeys)),
      row('&nbsp;&nbsp;of them holding their default value', (b) => thousands(b.totals.defaultEntries)),
      row('structs per block', (b) => (b.structs / Math.max(1, b.totals.blocks)).toFixed(2)),
      row('default-valued entries per block', (b) => (b.totals.defaultEntries / Math.max(1, b.totals.blocks)).toFixed(2)),
    );
    const total = (key) => traced.reduce((sum, note) => sum + (note.measured.breakdown.entries[key]?.count ?? 0), 0);
    const keys = [...new Set(traced.flatMap((note) => Object.keys(note.measured.breakdown.entries)))].sort((a, b) => total(b) - total(a) || a.localeCompare(b));
    out.push('', '#### Live map entries by node type and key: count (of them holding the default)', '', ...header('Node type . key'));
    for (const key of keys) {
      out.push(row(`\`${key}\``, (b) => {
        const entry = b.entries[key];
        return entry ? `${thousands(entry.count)} (${thousands(entry.defaults)})` : '';
      }));
    }
    out.push('', '#### The exact structs of one node of each type', '', 'DEFAULT marks an entry holding the value a fresh node of its type has; @lexical/yjs builds a node from a fresh one and applies only the entries it finds.', '');
    const seen = new Set();
    for (const note of traced) {
      for (const sample of note.measured.samples ?? []) {
        if (seen.has(sample.label)) continue;
        seen.add(sample.label);
        out.push(`- ${sample.label}: ${sample.structs} structs (from ${shortName(note.name)})`, '', '```', ...sample.lines, '```', '');
      }
    }
    out.push(
      '#### The body rebuilt with fewer structs, held beside the note',
      '',
      "Each body is rebuilt from the note's root, encoded and decoded into a fresh Y.Doc as the DocDO holds a note, and held; its heap is the difference after a full GC. Same editor state: the note and the rebuilt body are each hydrated through the unmodified binding into the converter editor, and the editor states' JSON compared.",
      '',
      '| Note | Body | Structs | Structs per block | Heap held | B per struct | Heap vs as written | Same editor state |',
      '| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |',
    );
    for (const note of traced) {
      const written = note.measured.variants?.find((variant) => variant.variant === 'as written');
      const blocks = Math.max(1, note.measured.breakdown.totals.blocks);
      for (const variant of note.measured.variants ?? []) {
        const { check } = variant;
        const same = check.compacted
          ? 'the same encoding as the uncompacted body'
          : check.error
            ? `no: the unmodified binding cannot read it (${check.error})`
            : check.same ? `yes (${thousands(check.chars)} chars of state JSON)` : `no: ${check.difference}`;
        const ratio = written && written.mb > 0 ? `${Math.round((variant.mb / written.mb) * 100)}%` : '?';
        out.push(`| ${shortName(note.name)} | ${variant.variant} | ${thousands(variant.structs)} | ${(variant.structs / blocks).toFixed(2)} | ${variant.mb.toFixed(1)} MB | ${Math.round((variant.mb * 2 ** 20) / variant.structs)} | ${ratio} | ${same.replaceAll('|', '\\|')} |`);
      }
    }
  }
  const { shapes = [], failed } = measuredShapes ?? {};
  out.push('', `#### Heap per struct kind (${thousands(SHAPE_BLOCKS)} synthetic blocks of each shape under the root, encoded and decoded, held ${SHAPE_ROUNDS} times in each of ${SHAPE_PROCESSES} processes)`, '');
  if (failed) out.push(`Not measured: ${failed}`, '');
  out.push(`| Shape | Structs | Heap held (median) | Each round, by process (${SHAPE_PROCESSES} fresh workerd processes) | Struct kinds |`, '| --- | ---: | ---: | ---: | --- |');
  for (const shape of shapes) {
    const rounds = (shape.processes ?? []).map((list) => (list ?? []).map((mb) => mb.toFixed(1)).join(', ')).join('; ');
    out.push(`| ${shape.shape} | ${thousands(shape.structs)} | ${(shape.mb ?? NaN).toFixed(1)} MB | ${rounds} | ${Object.entries(shape.kinds).map(([kind, count]) => `${kind} ${thousands(count)}`).join(', ')} |`);
  }
  out.push('', '| Struct | Shape vs base | Structs added per block | Heap per added struct | Heap per block |', '| --- | --- | ---: | ---: | ---: |');
  for (const cost of kindCosts(shapes)) {
    if (cost.missing) continue;
    out.push(`| ${cost.label} | ${cost.shape} vs ${cost.base ?? 'nothing'} | ${cost.structsPerBlock.toFixed(0)} | ${cost.perStruct.toFixed(0)} B | ${cost.perBlock.toFixed(0)} B |`);
  }
  return out.join('\n');
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

async function main() {
  mkdirSync(OUT, { recursive: true });
  await bundle(NAME, join(REPO, 'packages/sync/measure/doc-worker.ts'));
  const notes = [];
  let port = 9910;
  for (const [name, markdown] of process.env.MEASURE_MEMORY_SHAPES_ONLY ? [] : await cases()) {
    const measured = await measureNote(markdown, port, [], { trace: true });
    const capped = process.env.MEASURE_MEMORY_UNCAPPED_ONLY ? { phases: {} } : await measureNote(markdown, port + 1, [`--max-heap-size=${PEAK_BUDGET_MB}`]);
    port += 2;
    notes.push({ name, markdownBytes: Buffer.byteLength(markdown), measured, capped });
    console.error(`measure-memory: ${name} done`);
  }
  const mb = (value) => (typeof value === 'number' ? `${value.toFixed(1)} MB` : '?');
  const figures = (phase) => (phase ? `${mb(phase.highMb)} / ${mb(phase.liveMb)}` : '');
  const lines = [
    '### DocDO memory in workerd (T3.B31)',
    '',
    `Isolate JS heap from V8's GC trace: per phase, the highest in use before a GC / the highest left after a full GC. Budget: every phase fits a ${PEAK_BUDGET_MB} MB heap cap (V8 collecting as hard as it can), and the note at rest holds under ${REST_BUDGET_MB} MB; the isolate limit is ${ISOLATE_LIMIT_MB} MB. Array buffers (the stored state) are outside these figures.`,
    '',
    '| Note | Markdown | State | Base | Create | Save | Export | At rest | Under the cap |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...notes.map(({ name, markdownBytes, measured: m, capped: c }) => `| ${name} | ${mb(markdownBytes / 2 ** 20)} | ${m.stateBytes ? mb(m.stateBytes / 2 ** 20) : '?'} | ${mb(m.baseMb)} | ${figures(m.phases.create)} | ${figures(m.phases.save)} | ${figures(m.phases.export)} | ${mb(m.phases.export?.restMb)} | ${c.failed ? `FAILED in ${c.failed.phase}` : 'yes'} |`),
  ];
  const report = lines.join('\n');
  console.log(report);
  for (const n of notes) {
    if (n.measured.failed) console.error(`${n.name} (measured):\n${n.measured.logs}\n${n.name} (measured, other than GC lines):\n${n.measured.errors}`);
    if (n.capped.failed) console.error(`${n.name} (capped):\n${n.capped.logs?.slice(-1_000)}`);
  }
  const traces = notes.map(({ name, measured: m }) => [
    `- ${name}: a plain Y.Doc of the note ${mb(m.copyMb)} (${m.structs} structs, ${Math.round((m.copyMb * 2 ** 20) / m.structs)} B each; keys interned ${mb(m.internedCopyMb)});`,
    PHASES.flatMap((phase) => (m.phases[phase]?.marks ?? []).map(({ label, mb: at }) => `${label} ${mb(at)}`)).join(', '),
  ].join(' '));
  const details = ['', 'Heap after a full GC at each phase of the server write and the export:', '', ...traces].join('\n');
  console.log(details);
  // Each process is a fresh isolate: V8 lays the same objects out alike within one, not always across them.
  const processes = [];
  for (let i = 0; i < SHAPE_PROCESSES; i += 1) {
    const run = await measureShapes(port + i, SHAPE_BLOCKS);
    if (run.failed) console.error(`per-kind shapes, process ${i + 1}:\n${run.logs}`);
    processes.push(run);
  }
  const shapes = mergeShapeRuns(processes);
  const structs = breakdownReport(notes, shapes);
  console.log(structs);
  writeFileSync(join(OUT, 'memory.json'), `${JSON.stringify({ notes: notes.map((n) => ({ ...n, measured: { ...n.measured, logs: undefined }, capped: { ...n.capped, logs: undefined } })), shapes }, null, 2)}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${report}\n${details}\n${structs}\n`);
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
