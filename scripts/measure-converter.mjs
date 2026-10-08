#!/usr/bin/env node
// SP2 (ARCHITECTURE §22): bundles the converter into a Worker the way wrangler does (its own esbuild), runs it
// under `wrangler dev --local`, and reports upload size, cold start, import/export CPU of the scale note up to
// 2 MB, the 2 MB import into a bound Y.Doc, memory growth and the Y.Doc state-to-markdown ratio over the family
// corpus. Prints a markdown table (and appends it to $GITHUB_STEP_SUMMARY). Exits non-zero when the converter
// fails to load or convert in workerd, including a note that imports to fewer blocks than its copies hold, and
// when an import up to 2 MB takes more than IMPORT_BUDGET_MS of workerd CPU. It also renames a doc's title back and
// forth between worst-case caller texts (packages/sync/measure/title-cases.ts), the DocDO's REST rename path, and
// exits non-zero when a rename lands inexactly or averages more than TITLE_WRITE_BUDGET_MS of workerd CPU, or any
// single rename exceeds it by more than one /proc tick. Last, it runs the real DocDO (packages/sync/measure/doc-worker.ts)
// and sends many tiny payload frames over thousands of ids (T1.F2), exiting non-zero past the stated per-frame CPU,
// memory, held-doc and scaling budgets, and feeds the real SearchDO bodies of unclosed openers, exiting non-zero past
// the per-request CPU and linear-scaling budgets. The converter also imports and exports notes of unclosed openers
// (packages/sync/measure/converter-cases.ts) as single lines from 1 KB to 2 MB, exiting non-zero past LINE_BUDGET_MS.
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createConnection } from 'node:net';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const OUT = join(REPO, '.cache/measure');
const FIXTURES = join(REPO, 'packages/sync/src/converter/fixtures');
const requireFromSync = createRequire(join(REPO, 'packages/sync/package.json'));
const WRANGLER = join(dirname(requireFromSync.resolve('wrangler/package.json')), 'bin/wrangler.js');
const esbuild = createRequire(requireFromSync.resolve('wrangler'))('esbuild');
const COLD_RUNS = 3;
const CONVERSION_RUNS = 3;
const SCALE_SIZES = [64 * 1024, 256 * 1024, 1024 * 1024, 2 * 1024 * 1024];
// A Worker or Durable Object request's default CPU limit (`limits.cpu_ms` raises it).
const CPU_LIMIT_MS = 30_000;
// T0.6b: a whole-document import at PRODUCT's 2 MB/doc limit stays well inside CPU_LIMIT_MS.
const IMPORT_BUDGET_MS = 5_000;
// A REST rename diffs two caller-supplied texts; one request may spend at most this much workerd CPU on it.
const TITLE_WRITE_BUDGET_MS = 20;
const TITLE_WRITES = 6;
// /proc reports CPU in 10 ms ticks, so a single request's reading may sit one tick above its real cost.
const TICK_MS = 10;

const vendor = join(REPO, 'vendor/moss/packages');
const ALIASES = [
  [/^@moss\/shared$/, `${vendor}/shared/src/index.ts`],
  [/^@moss\/shared\//, `${vendor}/shared/src/`],
  [/^@\//, `${vendor}/shared/src/`],
  [/^@moss-desktop\//, `${vendor}/desktop/src/`],
  [/^@moss-multi\/host\//, `${REPO}/apps/web/src/host/`],
];

// Moss's aliases as an esbuild plugin (wrangler's own `alias` matches whole specifiers only).
const aliasPlugin = {
  name: 'moss-aliases',
  setup(build) {
    build.onResolve({ filter: /^@(moss\/shared|moss-desktop\/|moss-multi\/host\/|\/)/ }, async (args) => {
      for (const [pattern, target] of ALIASES) {
        if (!pattern.test(args.path)) continue;
        const path = args.path.replace(pattern, target);
        const result = await build.resolve(path.startsWith('/') ? path : `./${path}`, { resolveDir: args.resolveDir, kind: args.kind });
        return result.errors.length ? { errors: result.errors } : { path: result.path };
      }
      return undefined;
    });
  },
};

async function bundle(name, entry, config = {}) {
  const outfile = join(OUT, name, 'worker.js');
  await esbuild.build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'browser',
    conditions: ['workerd', 'worker', 'browser'],
    target: 'es2022',
    minify: true,
    external: ['node:*', 'cloudflare:*'],
    define: { 'process.env.NODE_ENV': '"production"' },
    plugins: [aliasPlugin],
    logLevel: 'error',
  });
  writeFileSync(
    join(OUT, name, 'wrangler.jsonc'),
    JSON.stringify({ name: `converter-measure-${name}`, main: 'worker.js', compatibility_date: '2025-09-02', compatibility_flags: ['nodejs_compat'], no_bundle: true, ...config }),
  );
  const bytes = readFileSync(outfile);
  return { rawBytes: bytes.byteLength, gzipBytes: gzipSync(bytes, { level: 9 }).byteLength };
}

function waitForPort(port, child, logs) {
  const deadline = performance.now() + 60_000;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      if (child.exitCode !== null) return reject(new Error(`wrangler exited before port ${port} opened\n${logs.value}`));
      const socket = createConnection({ host: '127.0.0.1', port });
      socket.once('connect', () => {
        socket.destroy();
        resolve();
      });
      socket.once('error', () => {
        socket.destroy();
        if (performance.now() > deadline) reject(new Error(`timed out waiting for port ${port}\n${logs.value}`));
        else setTimeout(attempt, 50);
      });
    };
    attempt();
  });
}

async function startWorker(name, port) {
  const started = performance.now();
  const child = spawn(
    process.execPath,
    [WRANGLER, 'dev', '--local', '--ip', '127.0.0.1', '--port', String(port), '--inspector-port', String(port + 1000), '--config', join(OUT, name, 'wrangler.jsonc'), '--log-level', 'warn', '--persist-to', join(OUT, 'state', String(port))],
    { cwd: join(OUT, name), env: { ...process.env, NO_COLOR: '1', WRANGLER_SEND_METRICS: 'false' }, stdio: ['ignore', 'pipe', 'pipe'], detached: true },
  );
  const logs = { value: '' };
  const collect = (chunk) => {
    logs.value = `${logs.value}${chunk}`.slice(-32_000);
  };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  await waitForPort(port, child, logs);
  return { child, logs, origin: `http://127.0.0.1:${port}`, startupMs: performance.now() - started };
}

async function stop(child) {
  if (child.exitCode !== null) return;
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    child.kill('SIGTERM');
  }
  await Promise.race([new Promise((resolve) => child.once('exit', resolve)), new Promise((resolve) => setTimeout(resolve, 5_000))]);
  if (child.exitCode === null) {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      child.kill('SIGKILL');
    }
  }
}

// Every process with its parent, CPU (ms) and resident memory (KB): /proc on Linux (10 ms ticks), ps elsewhere.
function processes() {
  if (existsSync('/proc/self/stat')) {
    const rows = [];
    for (const entry of readdirSync('/proc')) {
      if (!/^\d+$/.test(entry)) continue;
      try {
        const stat = readFileSync(`/proc/${entry}/stat`, 'utf8');
        const close = stat.lastIndexOf(')');
        const fields = stat.slice(close + 2).split(' ');
        const command = stat.slice(stat.indexOf('(') + 1, close);
        rows.push({ pid: Number(entry), ppid: Number(fields[1]), cpuMs: (Number(fields[11]) + Number(fields[12])) * 10, rssKb: Number(fields[21]) * 4, command });
      } catch {
        // the process exited while being read
      }
    }
    return rows;
  }
  const result = spawnSync('ps', ['-ax', '-o', 'pid=,ppid=,rss=,time=,command='], { encoding: 'utf8' });
  return result.stdout
    .split('\n')
    .map((line) => line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/))
    .filter(Boolean)
    .map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), rssKb: Number(m[3]), cpuMs: parsePsTime(m[4]), command: m[5] }));
}

function parsePsTime(value) {
  const [main, fraction = '0'] = value.split('.');
  const seconds = main.split(/[:-]/).map(Number).reduce((total, part) => total * 60 + part, 0);
  return seconds * 1000 + Number(`0.${fraction}`) * 1000;
}

// CPU and memory of the workerd processes under one wrangler process.
function workerdStats(rootPid) {
  const rows = processes();
  const family = new Set([rootPid]);
  for (let changed = true; changed; ) {
    changed = false;
    for (const row of rows) {
      if (family.has(row.ppid) && !family.has(row.pid)) {
        family.add(row.pid);
        changed = true;
      }
    }
  }
  const workers = rows.filter((row) => family.has(row.pid) && /workerd/.test(row.command));
  return { cpuMs: workers.reduce((sum, row) => sum + row.cpuMs, 0), rssKb: workers.reduce((sum, row) => sum + row.rssKb, 0) };
}

async function timedRequest(server, path, init) {
  const before = workerdStats(server.child.pid);
  let peakRssKb = before.rssKb;
  const sampler = setInterval(() => {
    peakRssKb = Math.max(peakRssKb, workerdStats(server.child.pid).rssKb);
  }, 20);
  const started = performance.now();
  let response;
  let body;
  try {
    response = await fetch(`${server.origin}${path}`, init);
    body = await response.text();
  } catch (error) {
    throw new Error(`${path}: ${error.message} (${error.cause?.message ?? 'no cause'})\n${server.logs.value}`, { cause: error });
  } finally {
    // A live interval would keep the process from exiting after a failure.
    clearInterval(sampler);
  }
  const wallMs = performance.now() - started;
  const after = workerdStats(server.child.pid);
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status} ${body}\n${server.logs.value}`);
  return { wallMs, cpuMs: after.cpuMs - before.cpuMs, rssBeforeKb: before.rssKb, peakRssKb: Math.max(peakRssKb, after.rssKb), body };
}

const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const round = (value) => Math.round(value * 10) / 10;

// The family corpus: every fixture without a comments sidecar, by name, as [name, markdown].
function corpus() {
  const files = readdirSync(FIXTURES);
  return files
    .filter((file) => file.endsWith('.md') && !files.includes(file.replace(/\.md$/, '.comments.json')))
    .map((file) => [file.replace(/\.md$/, ''), readFileSync(join(FIXTURES, file), 'utf8')])
    .sort(([a], [b]) => (a < b ? -1 : 1));
}

// The scale note, as packages/sync/src/converter/fixtures.ts builds it: the corpus minus fixtures/scale.json's
// exclusions, joined into one unit, repeated `units` times.
function scaleUnit(fixtures) {
  const excluded = JSON.parse(readFileSync(join(FIXTURES, 'scale.json'), 'utf8'));
  return fixtures.filter(([name]) => !(name in excluded)).map(([, text]) => text).join('\n\n');
}
const scaleNote = (unit, units) => Array.from({ length: units }, () => unit).join('\n\n');

// Import and export one note in a fresh worker, so a crash at one size leaves the others measurable. The note
// must import to `units` times the unit's top-level blocks: fewer means one copy swallowed others. With `bound`,
// the note is also imported into a Y.Doc through a headless binding, as the DocDO's serverWrite does.
async function measureSize(unit, units, port, bound) {
  const server = await startWorker('converter', port);
  const runs = { import: [], export: [] };
  const markdown = scaleNote(unit, units);
  try {
    const unitBlocks = JSON.parse((await timedRequest(server, '/import', { method: 'POST', body: unit })).body).blocks;
    for (let run = 0; run < CONVERSION_RUNS; run += 1) {
      const imported = await timedRequest(server, '/import', { method: 'POST', body: markdown });
      const { blocks, cut } = JSON.parse(imported.body);
      if (blocks !== units * unitBlocks) throw new Error(`${blocks} top-level blocks, expected ${units} × ${unitBlocks}`);
      if (cut > 0) throw new Error(`${cut} lines cut at the work budget, which must never cut ordinary content`);
      runs.import.push({ ...imported, blocks });
      runs.export.push(await timedRequest(server, '/export'));
    }
    const state = bound ? await timedRequest(server, '/state', { method: 'POST', body: markdown }) : null;
    return {
      blocks: runs.import[0].blocks,
      importCpuMs: round(median(runs.import.map((s) => s.cpuMs))),
      importWallMs: round(median(runs.import.map((s) => s.wallMs))),
      exportCpuMs: round(median(runs.export.map((s) => s.cpuMs))),
      exportWallMs: round(median(runs.export.map((s) => s.wallMs))),
      peakMb: round(Math.max(...runs.import.map((s) => s.peakRssKb - s.rssBeforeKb)) / 1024),
      ...(state && {
        boundCpuMs: round(state.cpuMs),
        boundPeakMb: round((state.peakRssKb - state.rssBeforeKb) / 1024),
        stateBytes: JSON.parse(state.body).stateBytes,
      }),
    };
  } catch (error) {
    const log = server.logs.value.split('\n').filter(Boolean).slice(-6).join(' / ');
    return { failed: `${String(error.message).split('\n')[0]}${log ? ` (wrangler: ${log})` : ''}` };
  } finally {
    await stop(server.child);
  }
}

// Renames the title A → B → A … per case, after one untimed write of A; the mean is held to the budget and each rename to the budget plus one tick.
async function measureTitleWrites(port) {
  const { TITLE_CASES } = await import('../packages/sync/measure/title-cases.ts');
  const server = await startWorker('converter', port);
  const results = [];
  try {
    for (const [name, [a, b]] of Object.entries(TITLE_CASES)) {
      try {
        await timedRequest(server, '/title', { method: 'POST', body: a });
        const runs = [];
        for (let run = 0; run < TITLE_WRITES; run += 1) runs.push(await timedRequest(server, '/title', { method: 'POST', body: run % 2 ? a : b }));
        const mean = (key) => round(runs.reduce((sum, r) => sum + r[key], 0) / runs.length);
        results.push({ name, chars: [a.length, b.length], cpuMs: mean('cpuMs'), maxCpuMs: Math.max(...runs.map((r) => r.cpuMs)), wallMs: mean('wallMs') });
      } catch (error) {
        results.push({ name, chars: [a.length, b.length], failed: String(error.message).split('\n')[0] });
      }
    }
  } finally {
    await stop(server.child);
  }
  return results;
}

// T1.F2 bounded work (A§10.10): many tiny payload frames over thousands of ids, sent over real sockets to the real
// DocDO in workerd. Each id is touched once per round by one of PAYLOAD_SOCKETS editors, under the write rate, and a
// round ends when every frame is acked. Per-frame CPU in the large note must stay within PAYLOAD_SCALING of the small
// note's, so frame and ack work cannot grow with the payloads the note holds.
const PAYLOAD_SOCKETS = 12;
const PAYLOAD_ROUNDS = 2;
const PAYLOAD_NOTES = { small: 300, large: 3_000 };
// Mean workerd CPU per payload frame (parse, gates, load, apply, persist, fan-out to the other sockets, ack).
const PAYLOAD_FRAME_BUDGET_MS = 3;
// workerd RSS growth over the frame rounds; payload docs held in memory are bounded (PAYLOAD_DOCS_HELD).
const PAYLOAD_RSS_BUDGET_MB = 64;
const PAYLOAD_SCALING = 3;
const PAYLOAD_DOCS_HELD = 256;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function payloadSocket(server, docId, principal, prefix) {
  const ws = new WebSocket(`${server.origin.replace(/^http/, 'ws')}/parties/doc-d-o/${docId}?_pk=${principal}&principal=${principal}`);
  ws.binaryType = 'arraybuffer';
  const socket = { ws, acked: new Set(), wrote: new Set(), foreign: 0, widestAck: 0, closed: null };
  ws.addEventListener('message', (event) => {
    if (typeof event.data !== 'string' || !event.data.startsWith(prefix)) return;
    const message = JSON.parse(event.data.slice(prefix.length));
    if (message.t !== 'ack') return;
    const ids = Object.keys(message.p ?? {});
    socket.widestAck = Math.max(socket.widestAck, ids.length);
    for (const id of ids) {
      if (!socket.wrote.has(id)) socket.foreign += 1;
      socket.acked.add(id);
    }
  });
  ws.addEventListener('close', (event) => {
    socket.closed = `${event.code} ${event.reason}`;
  });
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error(`socket ${principal} failed to open\n${server.logs.value}`)), { once: true });
  });
  return socket;
}

async function measurePayloadNote(server, blocks, Y, protocol) {
  const docId = `payloads-${blocks}`;
  const markdown = Array.from({ length: blocks }, (_, i) => `\`\`\`\nblock ${i}\n\`\`\``).join('\n\n');
  const created = await fetch(`${server.origin}/create?doc=${docId}`, { method: 'POST', body: markdown });
  if (!created.ok) throw new Error(`create: HTTP ${created.status} ${await created.text()}\n${server.logs.value}`);
  const { ids } = await created.json();
  if (ids.length !== blocks) throw new Error(`the note names ${ids.length} payloads, expected ${blocks}`);
  const sockets = [];
  for (let k = 0; k < PAYLOAD_SOCKETS; k += 1) sockets.push(await payloadSocket(server, docId, `measure-${blocks}-${k}`, protocol.CUSTOM_PREFIX));
  const tiny = () => {
    const doc = new Y.Doc();
    doc.getText('payload').insert(0, 'x');
    const update = Y.encodeStateAsUpdate(doc);
    doc.destroy();
    return update;
  };
  const per = Math.ceil(ids.length / PAYLOAD_SOCKETS);
  const mine = (k) => ids.slice(k * per, (k + 1) * per);
  const before = workerdStats(server.child.pid);
  let peakRssKb = before.rssKb;
  const sampler = setInterval(() => {
    peakRssKb = Math.max(peakRssKb, workerdStats(server.child.pid).rssKb);
  }, 20);
  let cpuMs = 0;
  let frames = 0;
  try {
    for (let pass = 0; pass < PAYLOAD_ROUNDS; pass += 1) {
      // The write rate counts frames per socket per window: wait it out between rounds.
      if (pass > 0) await sleep(5_200);
      const start = workerdStats(server.child.pid).cpuMs;
      sockets.forEach((socket, k) => {
        socket.acked.clear();
        for (const id of mine(k)) {
          socket.wrote.add(id);
          socket.ws.send(protocol.encodePayloadFrame(id, protocol.PAYLOAD_UPDATE, tiny()));
          frames += 1;
        }
      });
      const deadline = performance.now() + 120_000;
      while (sockets.some((socket, k) => socket.acked.size < mine(k).length)) {
        const closed = sockets.find((socket) => socket.closed);
        if (closed) throw new Error(`a socket closed: ${closed.closed}\n${server.logs.value}`);
        if (performance.now() > deadline) throw new Error(`round ${pass}: frames unacked after 120 s\n${server.logs.value}`);
        await sleep(50);
      }
      cpuMs += workerdStats(server.child.pid).cpuMs - start;
    }
  } finally {
    clearInterval(sampler);
    for (const socket of sockets) socket.ws.close();
  }
  const work = await (await fetch(`${server.origin}/work?doc=${docId}`)).json();
  return {
    blocks,
    frames,
    frameCpuMs: Math.round((cpuMs / frames) * 100) / 100,
    rssMb: round((peakRssKb - before.rssKb) / 1024),
    held: work.held,
    widestAck: Math.max(...sockets.map((socket) => socket.widestAck)),
    foreign: sockets.reduce((sum, socket) => sum + socket.foreign, 0),
  };
}

async function measurePayloadFrames(port) {
  const Y = requireFromSync('yjs');
  const protocol = await import('../packages/protocol/src/sync.ts');
  const server = await startWorker('docdo', port);
  try {
    const notes = [];
    for (const blocks of Object.values(PAYLOAD_NOTES)) notes.push(await measurePayloadNote(server, blocks, Y, protocol));
    return { notes };
  } catch (error) {
    return { failed: String(error.message).split('\n').slice(0, 8).join(' / ') };
  } finally {
    await stop(server.child);
  }
}

// The search index (A§5.3): one global SearchDO indexes every doc and snippets every hit, so a body full of openers
// with no closer (packages/sync/measure/search-cases.ts) must cost it linear work. Each case runs in a fresh worker; a
// request past SEARCH_TIMEOUT_MS fails the case. The larger run must cost at most SEARCH_SCALING times the smaller.
const SEARCH_SIZES = [200_000, 400_000];
const SEARCH_RUNS = 3;
// Workerd CPU per request (index, search with its snippet, headings) at every size.
const SEARCH_BUDGET_MS = 100;
const SEARCH_SCALING = 3;
const SEARCH_TIMEOUT_MS = 10_000;
// 10 ms CPU ticks: scaling compares against no less than this.
const SEARCH_FLOOR_MS = 20;

async function measureSearchCase(name, opener, port, searchBody) {
  const server = await startWorker('search', port);
  const request = (path, body) => timedRequest(server, path, { method: 'POST', body, signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS) });
  const sizes = [];
  try {
    await request('/index?doc=warm', 'quokka [[Warm Up]] <b>warm</b>');
    await request('/search?doc=warm&q=quokka');
    for (const chars of SEARCH_SIZES) {
      const body = searchBody(opener, chars);
      const doc = `case-${chars}`;
      const runs = { index: [], search: [], headings: [] };
      for (let run = 0; run < SEARCH_RUNS; run += 1) {
        runs.index.push((await request(`/index?doc=${doc}`, body)).cpuMs);
        runs.search.push((await request(`/search?doc=${doc}&q=quokka`)).cpuMs);
        runs.headings.push((await request('/headings', `# ${body}`)).cpuMs);
      }
      sizes.push({ chars, indexCpuMs: median(runs.index), searchCpuMs: median(runs.search), headingsCpuMs: median(runs.headings) });
    }
    return { name, sizes };
  } catch (error) {
    const reason = error.name === 'TimeoutError' || error.cause?.name === 'TimeoutError' ? `a request ran past ${SEARCH_TIMEOUT_MS / 1000} s` : String(error.message).split('\n')[0];
    return { name, sizes, failed: reason };
  } finally {
    await stop(server.child);
  }
}

async function measureSearch(port) {
  const { SEARCH_CASES, searchBody } = await import('../packages/sync/measure/search-cases.ts');
  const results = [];
  for (const [name, opener] of Object.entries(SEARCH_CASES)) {
    results.push(await measureSearchCase(name, opener, port, searchBody));
    port += 1;
  }
  return results;
}

// Every converter case (converter-cases.ts) as one line at each size from 1 KB to PRODUCT's 2 MB cap, doubling, in a
// warmed worker, then between the last size that converts and the first kept literal (NEAR_CUT_FLOOR when 1 KB is
// already kept literal), halving the gap NEAR_CUT_STEPS times, so the size just under the cut is measured too: no
// single line, of any size, may cost more than LINE_BUDGET_MS of workerd CPU to import or to export. Then whole notes
// of 2 MB, each one line of the case repeated (a 256 B line, a 4 KB line, the line just under the cut, however short,
// and the line of the swept sizes that costs most per byte): none may cost more than IMPORT_BUDGET_MS to import or to
// export, with no case or line size left out. A line or note over its budget is measured ADVERSARIAL_RUNS times and
// judged by the median; a request past ADVERSARIAL_TIMEOUT_MS fails the case.
const ADVERSARIAL_SIZES = Array.from({ length: 12 }, (_, i) => 1024 << i);
const NEAR_CUT_STEPS = 7;
const NEAR_CUT_FLOOR = 64;
const NOTE_BYTES = 2 * 1024 * 1024;
const NOTE_LINE_BYTES = [256, 4 * 1024];
const LINE_BUDGET_MS = 250;
const ADVERSARIAL_RUNS = 3;
const ADVERSARIAL_TIMEOUT_MS = 20_000;
const ADVERSARIAL_OPS = ['importCpuMs', 'exportCpuMs'];
// 10 ms CPU ticks and noise: scaling compares against no less than this.
const ADVERSARIAL_FLOOR_MS = 100;
const ADVERSARIAL_SCALING = 3;
const WARM_ROUNDS = 3;

// Runs every code path a few times first, so no case is charged the JIT's first compilations.
async function warm(server, bodies) {
  for (let round = 0; round < WARM_ROUNDS; round += 1) {
    for (const body of bodies) {
      await timedRequest(server, '/import', { method: 'POST', body });
      await timedRequest(server, '/export');
    }
  }
}

const failure = (error) =>
  error.name === 'TimeoutError' || error.cause?.name === 'TimeoutError' ? `a request ran past ${ADVERSARIAL_TIMEOUT_MS / 1000} s` : String(error.message).split('\n')[0];

/** A note of `line` repeated as paragraphs to `bytes`. */
const noteOf = (line, bytes) => Array.from({ length: Math.max(1, Math.floor(bytes / (line.length + 2))) }, () => line).join('\n\n');

async function measureAdversarial(port) {
  const { CONVERTER_CASES, ORDINARY_NOTES, converterBody } = await import('../packages/sync/measure/converter-cases.ts');
  const warmBodies = [
    ORDINARY_NOTES['a paragraph of 1,000 sentences of italic, bold, code and strikethrough'](),
    ...Object.values(CONVERTER_CASES).map((c) => converterBody(c, 8 * 1024)),
  ];
  const results = [];
  let server = null;
  try {
    for (const [name, c] of Object.entries(CONVERTER_CASES)) {
      if (!server) {
        server = await startWorker('converter', port);
        port += 1;
        await warm(server, warmBodies);
      }
      const live = server;
      const request = (path, body) => timedRequest(live, path, { method: body === undefined ? 'GET' : 'POST', body, signal: AbortSignal.timeout(ADVERSARIAL_TIMEOUT_MS) });
      const measure = async (bytes) => {
        const body = converterBody(c, bytes);
        const runs = [];
        // A first run clearly within the budget, or clearly over it, needs no second look.
        do {
          const imported = await request('/import', body);
          const exported = await request('/export');
          const { cut, work } = JSON.parse(imported.body);
          runs.push({ importCpuMs: imported.cpuMs, exportCpuMs: exported.cpuMs, cut, work });
        } while (runs.length < ADVERSARIAL_RUNS && ADVERSARIAL_OPS.some((op) => runs[0][op] > LINE_BUDGET_MS && runs[0][op] < 4 * LINE_BUDGET_MS));
        const size = {
          bytes: body.length,
          runs: runs.length,
          importCpuMs: median(runs.map((r) => r.importCpuMs)),
          exportCpuMs: median(runs.map((r) => r.exportCpuMs)),
          cut: runs[0].cut,
          work: runs[0].work,
        };
        sizes.push(size);
        return size;
      };
      const sizes = [];
      const notes = [];
      let nearCut = null;
      try {
        const swept = [];
        for (const bytes of ADVERSARIAL_SIZES) swept.push(await measure(bytes));
        const first = swept.findIndex((size) => size.cut > 0);
        const floor = first === 0 ? await measure(NEAR_CUT_FLOOR) : null;
        if (first > 0 || (floor && floor.cut === 0)) {
          let [low, high] = [first > 0 ? swept[first - 1] : floor, swept[first]];
          for (let step = 0; step < NEAR_CUT_STEPS; step += 1) {
            const mid = await measure(Math.round((low.bytes + high.bytes) / 2));
            if (mid.cut > 0) high = mid;
            else low = mid;
          }
          nearCut = low;
        }
        const perByte = (size) => size.importCpuMs / size.bytes;
        const worst = swept.reduce((a, b) => (perByte(b) > perByte(a) ? b : a));
        const lineSizes = [...new Set([...NOTE_LINE_BYTES, ...(nearCut ? [nearCut.bytes] : []), worst.bytes])].filter((bytes) => bytes < NOTE_BYTES);
        for (const lineBytes of lineSizes) {
          const note = noteOf(converterBody(c, lineBytes), NOTE_BYTES);
          const runs = [];
          do {
            const imported = await request('/import', note);
            const exported = await request('/export');
            const { cut, work } = JSON.parse(imported.body);
            runs.push({ importCpuMs: imported.cpuMs, exportCpuMs: exported.cpuMs, cut, work });
          } while (runs.length < ADVERSARIAL_RUNS && ADVERSARIAL_OPS.some((op) => runs[0][op] > IMPORT_BUDGET_MS && runs[0][op] < 4 * IMPORT_BUDGET_MS));
          notes.push({
            lineBytes,
            bytes: note.length,
            runs: runs.length,
            importCpuMs: median(runs.map((r) => r.importCpuMs)),
            exportCpuMs: median(runs.map((r) => r.exportCpuMs)),
            cut: runs[0].cut,
            work: runs[0].work,
          });
        }
        sizes.sort((a, b) => a.bytes - b.bytes);
        results.push({ name, sizes, nearCut, notes });
      } catch (error) {
        sizes.sort((a, b) => a.bytes - b.bytes);
        results.push({ name, sizes, nearCut, notes, failed: failure(error) });
        await stop(live.child);
        server = null;
      }
    }
  } finally {
    if (server) await stop(server.child);
  }
  return results;
}

// Ordinary notes (converter-cases.ts), in one warmed worker, each imported in full (no line cut at the work budget)
// and within IMPORT_BUDGET_MS (a run over it is measured ADVERSARIAL_RUNS times and judged by the median): the
// single-paragraph ORDINARY_NOTES, and at 1 MB and 2 MB the LARGE_ORDINARY_NOTES (several times the scale note's
// matches per byte) and NEAR_BUDGET_NOTES (many lines each just under the per-line caps, all of which convert), which
// are also held to linear growth from 1 MB to 2 MB.
const LARGE_ORDINARY_SIZES = [1024 * 1024, 2 * 1024 * 1024];
const LARGE_ORDINARY_CEILING_MS = IMPORT_BUDGET_MS;

async function measureOrdinary(port) {
  const { LARGE_ORDINARY_NOTES, NEAR_BUDGET_NOTES, ORDINARY_NOTES } = await import('../packages/sync/measure/converter-cases.ts');
  const server = await startWorker('converter', port);
  const runs = [
    ...Object.entries(ORDINARY_NOTES).map(([name, body]) => ({ name, body, ceiling: IMPORT_BUDGET_MS })),
    ...Object.entries({ ...LARGE_ORDINARY_NOTES, ...NEAR_BUDGET_NOTES }).flatMap(([name, body]) =>
      LARGE_ORDINARY_SIZES.map((bytes) => ({ name: `${name} (at ${bytes / 1024} KB)`, body: () => body(bytes), ceiling: LARGE_ORDINARY_CEILING_MS, family: name })),
    ),
  ];
  const results = [];
  try {
    await warm(server, Object.values(ORDINARY_NOTES).map((body) => body()));
    for (const { name, body, ceiling, family } of runs) {
      try {
        const markdown = body();
        // A run over the ceiling is measured ADVERSARIAL_RUNS times and judged by the median, as the adversarial lines are.
        const samples = [];
        let cut = 0;
        let work = 0;
        do {
          const imported = await timedRequest(server, '/import', { method: 'POST', body: markdown, signal: AbortSignal.timeout(ADVERSARIAL_TIMEOUT_MS) });
          const exported = await timedRequest(server, '/export', { signal: AbortSignal.timeout(ADVERSARIAL_TIMEOUT_MS) });
          samples.push({ importCpuMs: imported.cpuMs, exportCpuMs: exported.cpuMs });
          ({ cut, work } = JSON.parse(imported.body));
        } while (samples.length < ADVERSARIAL_RUNS && ADVERSARIAL_OPS.some((op) => samples[0][op] > ceiling));
        results.push({
          name,
          ceiling,
          family,
          importCpuMs: median(samples.map((r) => r.importCpuMs)),
          exportCpuMs: median(samples.map((r) => r.exportCpuMs)),
          runs: samples.length,
          cut,
          work,
        });
      } catch (error) {
        results.push({ name, ceiling, family, failed: String(error.message).split('\n')[0] });
      }
    }
  } finally {
    await stop(server.child);
  }
  return results;
}

function ordinaryProblems(results) {
  const problems = results.flatMap((r) => {
    if (r.failed) return [`${r.name}: ${r.failed}`];
    return [
      ...(r.cut > 0 ? [`${r.name}: ${r.cut} lines cut at the work budget`] : []),
      ...(r.importCpuMs > r.ceiling ? [`${r.name}: import ${r.importCpuMs} ms`] : []),
      ...(r.exportCpuMs > r.ceiling ? [`${r.name}: export ${r.exportCpuMs} ms`] : []),
    ];
  });
  const families = new Set(results.filter((r) => r.family).map((r) => r.family));
  for (const family of families) {
    const [small, large] = results.filter((r) => r.family === family);
    if (small.failed || large.failed) continue;
    if (large.importCpuMs > ADVERSARIAL_SCALING * Math.max(small.importCpuMs, ADVERSARIAL_FLOOR_MS)) {
      problems.push(`${family}: import grew from ${small.importCpuMs} ms to ${large.importCpuMs} ms`);
    }
  }
  return problems;
}

// Notes of one short line repeated (converter-cases.ts MULTILINE_CASES), each in a fresh worker at its sizes (by default
// MULTILINE_SIZES): the larger may cost at most ADVERSARIAL_SCALING times the smaller (no work per line that grows with
// the lines before it) and IMPORT_BUDGET_MS to import or export, a size over it measured ADVERSARIAL_RUNS times and
// judged by the median; a request past ADVERSARIAL_TIMEOUT_MS fails the case.
const MULTILINE_SIZES = [128 * 1024, 256 * 1024];

async function measureMultiline(port) {
  const { MULTILINE_CASES, multilineBody } = await import('../packages/sync/measure/converter-cases.ts');
  const results = [];
  for (const [name, c] of Object.entries(MULTILINE_CASES)) {
    const server = await startWorker('converter', port);
    port += 1;
    const sizes = [];
    try {
      await warm(server, [multilineBody(c, 8 * 1024)]);
      for (const bytes of c.sizes ?? MULTILINE_SIZES) {
        const body = multilineBody(c, bytes);
        const signal = () => AbortSignal.timeout(ADVERSARIAL_TIMEOUT_MS);
        const runs = [];
        do {
          const imported = await timedRequest(server, '/import', { method: 'POST', body, signal: signal() });
          const exported = await timedRequest(server, '/export', { signal: signal() });
          runs.push({ importCpuMs: imported.cpuMs, exportCpuMs: exported.cpuMs });
        } while (runs.length < ADVERSARIAL_RUNS && ADVERSARIAL_OPS.some((op) => runs[0][op] > IMPORT_BUDGET_MS && runs[0][op] < 4 * IMPORT_BUDGET_MS));
        sizes.push({ bytes: body.length, importCpuMs: median(runs.map((r) => r.importCpuMs)), exportCpuMs: median(runs.map((r) => r.exportCpuMs)) });
      }
      results.push({ name, sizes });
    } catch (error) {
      results.push({ name, sizes, failed: failure(error) });
    } finally {
      await stop(server.child);
    }
  }
  return results;
}

function multilineProblems(results) {
  const problems = [];
  for (const r of results) {
    if (r.failed) {
      problems.push(`${r.name}: ${r.failed}`);
      continue;
    }
    for (const size of r.sizes) {
      for (const op of ADVERSARIAL_OPS) if (size[op] > IMPORT_BUDGET_MS) problems.push(`${r.name}, ${size.bytes} B: ${op} ${size[op]} ms`);
    }
    const [small, large] = r.sizes;
    for (const op of ADVERSARIAL_OPS) {
      if (large[op] > ADVERSARIAL_SCALING * Math.max(small[op], ADVERSARIAL_FLOOR_MS)) problems.push(`${r.name}: ${op} grew from ${small[op]} ms to ${large[op]} ms`);
    }
  }
  return problems;
}

// One line of numeric-entity tabs (`x ` then `&#9;` N times), which Lexical's unescape decodes to tabs after the inline
// pass, at each of ENTITY_TAB_COUNTS in one warmed worker: each import and export within LINE_BUDGET_MS (a run over it
// measured ADVERSARIAL_RUNS times and judged by the median), and each doubling at most ADVERSARIAL_SCALING times the last.
const ENTITY_TAB_COUNTS = [5_000, 10_000, 20_000, 40_000];

async function measureEntityTabs(port) {
  const server = await startWorker('converter', port);
  const sizes = [];
  try {
    const body = (n) => `x ${'&#9;'.repeat(n)}`;
    await warm(server, [body(1_000)]);
    for (const tabs of ENTITY_TAB_COUNTS) {
      const runs = [];
      do {
        const imported = await timedRequest(server, '/import', { method: 'POST', body: body(tabs), signal: AbortSignal.timeout(ADVERSARIAL_TIMEOUT_MS) });
        const exported = await timedRequest(server, '/export', { signal: AbortSignal.timeout(ADVERSARIAL_TIMEOUT_MS) });
        runs.push({ importCpuMs: imported.cpuMs, exportCpuMs: exported.cpuMs, cut: JSON.parse(imported.body).cut });
      } while (runs.length < ADVERSARIAL_RUNS && ADVERSARIAL_OPS.some((op) => runs[0][op] > LINE_BUDGET_MS && runs[0][op] < 4 * LINE_BUDGET_MS));
      sizes.push({ tabs, importCpuMs: median(runs.map((r) => r.importCpuMs)), exportCpuMs: median(runs.map((r) => r.exportCpuMs)), cut: runs[0].cut });
    }
    return { sizes };
  } catch (error) {
    return { sizes, failed: failure(error) };
  } finally {
    await stop(server.child);
  }
}

function entityTabProblems(result) {
  const problems = result.failed ? [`entity tabs: ${result.failed}`] : [];
  result.sizes.forEach((size, i) => {
    for (const op of ADVERSARIAL_OPS) {
      if (size[op] > LINE_BUDGET_MS) problems.push(`entity tabs × ${size.tabs}: ${op} ${size[op]} ms over the ${LINE_BUDGET_MS} ms line budget`);
      const last = result.sizes[i - 1];
      if (last && size[op] > ADVERSARIAL_SCALING * Math.max(last[op], ADVERSARIAL_FLOOR_MS)) problems.push(`entity tabs: ${op} grew from ${last[op]} ms at ${last.tabs} to ${size[op]} ms at ${size.tabs}`);
    }
  });
  return problems;
}

/** Every way the adversarial lines and notes miss the stated budgets (empty when they meet them). */
function adversarialBudgetProblems(results) {
  const problems = [];
  for (const r of results) {
    if (r.failed) problems.push(`${r.name}: ${r.failed}`);
    for (const size of r.sizes) {
      for (const op of ADVERSARIAL_OPS) {
        if (size[op] > LINE_BUDGET_MS) problems.push(`${r.name}, ${size.bytes} B: ${op} ${size[op]} ms over the ${LINE_BUDGET_MS} ms line budget`);
      }
    }
    for (const note of r.notes) {
      for (const op of ADVERSARIAL_OPS) {
        if (note[op] > IMPORT_BUDGET_MS) problems.push(`${r.name}, a 2 MB note of ${note.lineBytes} B lines: ${op} ${note[op]} ms over the ${IMPORT_BUDGET_MS} ms note budget`);
      }
    }
  }
  return problems;
}

const SEARCH_OPS = ['indexCpuMs', 'searchCpuMs', 'headingsCpuMs'];

/** Every way the search runs miss the stated budget (empty when they meet it). */
function searchBudgetProblems(results) {
  const problems = [];
  for (const r of results) {
    if (r.failed) {
      problems.push(`${r.name}: ${r.failed}`);
      continue;
    }
    for (const size of r.sizes) {
      for (const op of SEARCH_OPS) if (size[op] > SEARCH_BUDGET_MS) problems.push(`${r.name}, ${size.chars} chars: ${op} ${size[op]} ms`);
    }
    const [small, large] = r.sizes;
    for (const op of SEARCH_OPS) {
      if (large[op] > SEARCH_SCALING * Math.max(small[op], SEARCH_FLOOR_MS)) problems.push(`${r.name}: ${op} grew from ${small[op]} ms to ${large[op]} ms`);
    }
  }
  return problems;
}

const overTitleBudget = (t) => t.cpuMs > TITLE_WRITE_BUDGET_MS || t.maxCpuMs > TITLE_WRITE_BUDGET_MS + TICK_MS;

async function main() {
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(join(OUT, 'baseline'), { recursive: true });
  writeFileSync(join(OUT, 'baseline.ts'), "export default { fetch: () => new Response('ok') };\n");
  const sizes = {
    baseline: await bundle('baseline', join(OUT, 'baseline.ts')),
    converter: await bundle('converter', join(REPO, 'packages/sync/measure/worker.ts')),
    docdo: await bundle('docdo', join(REPO, 'packages/sync/measure/doc-worker.ts'), {
      durable_objects: { bindings: [{ name: 'DocDO', class_name: 'MeasuredDocDO' }] },
      migrations: [{ tag: 'v1', new_sqlite_classes: ['MeasuredDocDO'] }],
    }),
    search: await bundle('search', join(REPO, 'packages/sync/measure/search-worker.ts'), {
      durable_objects: { bindings: [{ name: 'SearchDO', class_name: 'SearchDO' }] },
      migrations: [{ tag: 'v1', new_sqlite_classes: ['SearchDO'] }],
    }),
  };

  let port = 9410;
  const cold = { baseline: [], converter: [] };
  for (let run = 0; run < COLD_RUNS; run += 1) {
    for (const name of ['baseline', 'converter']) {
      const server = await startWorker(name, port);
      port += 1;
      try {
        const first = await timedRequest(server, '/ping');
        const second = await timedRequest(server, '/ping');
        cold[name].push({ startupMs: server.startupMs, firstMs: first.wallMs, firstCpuMs: first.cpuMs, warmMs: second.wallMs });
      } finally {
        await stop(server.child);
      }
    }
  }

  const fixtures = corpus();
  const unit = scaleUnit(fixtures);
  const unitBytes = Buffer.byteLength(unit);
  const unitsFor = (bytes) => Math.ceil(bytes / unitBytes);
  const conversions = [];
  for (const target of SCALE_SIZES) {
    const units = unitsFor(target);
    const bound = target === SCALE_SIZES.at(-1);
    conversions.push({ bytes: Buffer.byteLength(scaleNote(unit, units)), units, ...(await measureSize(unit, units, port, bound)) });
    port += 1;
  }

  const ratios = [];
  const server = await startWorker('converter', port);
  try {
    for (const [name, text] of [...fixtures, ['scale note, 256 KB', scaleNote(unit, unitsFor(256 * 1024))]]) {
      const { body } = await timedRequest(server, '/state', { method: 'POST', body: text });
      const { markdownBytes, stateBytes } = JSON.parse(body);
      ratios.push({ name, markdownBytes, stateBytes, ratio: stateBytes / markdownBytes });
    }
  } finally {
    await stop(server.child);
  }

  const titles = await measureTitleWrites(port + 1);
  const payloads = await measurePayloadFrames(port + 2);
  const searches = await measureSearch(port + 3);
  const adversarial = await measureAdversarial(port + 100);
  const ordinary = await measureOrdinary(port + 99);
  const multiline = await measureMultiline(port + 200);
  const entityTabs = await measureEntityTabs(port + 300);

  const coldOf = (name, key) => round(median(cold[name].map((sample) => sample[key])));
  const families = ratios.filter((r) => !r.name.startsWith('scale note'));
  const worst = families.reduce((a, b) => (b.ratio > a.ratio ? b : a));
  const kb = (bytes) => `${Math.round(bytes / 1024)} KB`;
  const seconds = (ms) => `${round(ms / 1000)} s`;
  const budget = (ms) =>
    ms > CPU_LIMIT_MS ? `, over the ${seconds(CPU_LIMIT_MS)} default CPU limit` : ms > IMPORT_BUDGET_MS ? `, over the ${seconds(IMPORT_BUDGET_MS)} import budget` : '';
  const mb = (bytes) => `${round(bytes / 1024 / 1024)} MB`;
  const lines = [
    '### Converter in workerd (SP2)',
    '',
    '| Measure | Value |',
    '| --- | --- |',
    `| Worker upload size, converter only (minified) | ${kb(sizes.converter.rawBytes)} raw, ${kb(sizes.converter.gzipBytes)} gzip (empty Worker ${sizes.baseline.gzipBytes} B gzip) |`,
    `| Cold start: \`wrangler dev\` start to listening, median of ${COLD_RUNS} | ${coldOf('converter', 'startupMs')} ms (empty Worker ${coldOf('baseline', 'startupMs')} ms) |`,
    `| Cold start: first request wall / workerd CPU, median | ${coldOf('converter', 'firstMs')} ms / ${coldOf('converter', 'firstCpuMs')} ms (empty Worker ${coldOf('baseline', 'firstMs')} ms / ${coldOf('baseline', 'firstCpuMs')} ms) |`,
    `| Warm request wall, median | ${coldOf('converter', 'warmMs')} ms |`,
    ...conversions.map((c) =>
      c.failed
        ? `| ${kb(c.bytes)} scale note (${c.units} units) | FAILED: ${c.failed} |`
        : `| ${kb(c.bytes)} scale note (${c.units} units, ${c.blocks} blocks) import / export: workerd CPU, median of ${CONVERSION_RUNS} | ${c.importCpuMs} ms / ${c.exportCpuMs} ms${budget(c.importCpuMs)} (wall ${c.importWallMs} / ${c.exportWallMs} ms); RSS growth during import ${c.peakMb} MB |`,
    ),
    ...conversions
      .filter((c) => c.boundCpuMs !== undefined)
      .map(
        (c) =>
          `| ${kb(c.bytes)} scale note imported into a bound Y.Doc (the DocDO's serverWrite path): workerd CPU, one run | ${c.boundCpuMs} ms; Y.Doc state ${mb(c.stateBytes)}; RSS growth ${c.boundPeakMb} MB |`,
      ),
    ...titles.map((t) =>
      t.failed
        ? `| Title rename, ${t.name} | FAILED: ${t.failed} |`
        : `| Title rename, ${t.name} (${t.chars.join(' ↔ ')} chars): workerd CPU per request, mean (max) of ${TITLE_WRITES} | ${t.cpuMs} (${t.maxCpuMs}) ms${overTitleBudget(t) ? `, over the ${TITLE_WRITE_BUDGET_MS} ms budget` : ''} (wall ${t.wallMs} ms) |`,
    ),
    ...(payloads.failed
      ? [`| Payload frames (T1.F2) | FAILED: ${payloads.failed} |`]
      : payloads.notes.map(
          (n) =>
            `| ${n.frames} tiny payload frames over ${n.blocks} ids, ${PAYLOAD_SOCKETS} editors, ${PAYLOAD_ROUNDS} rounds: workerd CPU per frame, mean | ${n.frameCpuMs} ms (budget ${PAYLOAD_FRAME_BUDGET_MS} ms); RSS growth ${n.rssMb} MB (budget ${PAYLOAD_RSS_BUDGET_MB} MB); payload docs held ${n.held} (at most ${PAYLOAD_DOCS_HELD}); widest ack ${n.widestAck} ids, ${n.foreign} not the socket's own |`,
        )),
    ...searches.flatMap((r) => [
      ...r.sizes.map(
        (size) =>
          `| Search, ${r.name} × ${size.chars} chars: workerd CPU per request (index / search and snippet / headings), median of ${SEARCH_RUNS} | ${size.indexCpuMs} / ${size.searchCpuMs} / ${size.headingsCpuMs} ms (budget ${SEARCH_BUDGET_MS} ms) |`,
      ),
      ...(r.failed ? [`| Search, ${r.name} | FAILED: ${r.failed} |`] : []),
    ]),
    ...adversarial.flatMap((r) => {
      const worst = (op) => r.sizes.reduce((a, b) => (b[op] > a[op] ? b : a), r.sizes[0] ?? { [op]: 0, bytes: 0 });
      const [importWorst, exportWorst] = ADVERSARIAL_OPS.map(worst);
      const literalFrom = r.sizes.find((size) => size.cut > 0);
      const measured = r.sizes.length > 0 ? `${kb(r.sizes[0].bytes)} to ${kb(r.sizes.at(-1).bytes)}` : 'no size';
      const notes = [
        `line budget ${LINE_BUDGET_MS} ms`,
        ...(r.nearCut ? [`${r.nearCut.importCpuMs} / ${r.nearCut.exportCpuMs} ms at ${r.nearCut.bytes} B, the largest converted`] : []),
        ...(literalFrom ? [`kept literal from ${literalFrom.bytes} B`] : []),
        ...(r.failed ? [`FAILED: ${r.failed}`] : []),
      ];
      return [
        `| Adversarial line, ${r.name}, ${measured}: worst workerd CPU (import / export) | ${importWorst.importCpuMs} ms at ${kb(importWorst.bytes)} / ${exportWorst.exportCpuMs} ms at ${kb(exportWorst.bytes)} (${notes.join('; ')}) |`,
        ...r.notes.map(
          (note) =>
            `| Adversarial note, ${r.name}, 2 MB of ${note.lineBytes} B lines: workerd CPU (import / export)${note.runs > 1 ? `, median of ${note.runs}` : ''} | ${note.importCpuMs} / ${note.exportCpuMs} ms (note budget ${IMPORT_BUDGET_MS} ms${note.cut ? `; ${note.cut} lines kept literal` : ''}; work ${Math.round(note.work / 1e6)}M) |`,
        ),
      ];
    }),
    ...ordinary.map((r) =>
      r.failed
        ? `| Ordinary note, ${r.name} | FAILED: ${r.failed} |`
        : `| Ordinary note, ${r.name}: workerd CPU (import / export), ${r.runs > 1 ? `median of ${r.runs}` : 'one run'} | ${r.importCpuMs} / ${r.exportCpuMs} ms (${r.family ? 'ceiling' : 'budget'} ${r.ceiling} ms; work ${Math.round(r.work / 1e6)}M)${r.cut ? `; ${r.cut} lines cut at the work budget` : ''} |`,
    ),
    ...multiline.map((r) =>
      r.failed
        ? `| Lines repeated, ${r.name} | FAILED: ${r.failed}${r.sizes.length ? ` (${r.sizes.map((size) => `${kb(size.bytes)} ${size.importCpuMs} / ${size.exportCpuMs} ms`).join(', ')})` : ''} |`
        : `| Lines repeated, ${r.name}: workerd CPU (import / export) | ${r.sizes.map((size) => `${kb(size.bytes)} ${size.importCpuMs} / ${size.exportCpuMs} ms`).join(', ')} (growth at most ${ADVERSARIAL_SCALING}x) |`,
    ),
    `| Entity tabs, one line of \`&#9;\` × ${ENTITY_TAB_COUNTS.join(' / ')}: workerd CPU (import / export) | ${entityTabs.sizes.map((size) => `${size.importCpuMs} / ${size.exportCpuMs} ms${size.cut ? ' (kept literal)' : ''}`).join(', ')}${entityTabs.failed ? `; FAILED: ${entityTabs.failed}` : ''} (line budget ${LINE_BUDGET_MS} ms, growth at most ${ADVERSARIAL_SCALING}x a doubling) |`,
    `| State-to-markdown ratio r, worst family | ${worst.ratio.toFixed(2)} (${worst.name}) |`,
    '',
    '| Fixture | Markdown B | Y.Doc state B | Ratio |',
    '| --- | --- | --- | --- |',
    ...ratios.map((r) => `| ${r.name} | ${r.markdownBytes} | ${r.stateBytes} | ${r.ratio.toFixed(2)} |`),
    '',
    `The scale note repeats one ${kb(unitBytes)} unit of the family corpus (packages/sync/src/converter/fixtures/scale.json lists what it leaves out). CPU (10 ms ticks) and RSS come from /proc for the workerd children of \`wrangler dev --local\`, which enforces no CPU limit; RSS growth stands in for isolate heap, which workerd does not report.`,
  ];
  const report = lines.join('\n');
  // Every swept size, for calibrating the budgets: import / export ms, lines kept literal, and the work charged.
  for (const r of adversarial) {
    console.log(`sizes, ${r.name}: ${r.sizes.map((size) => `${size.bytes} ${size.importCpuMs}/${size.exportCpuMs}${size.cut ? ' cut' : ''} w${Math.round(size.work / 1e6)}M`).join('; ')}`);
  }
  console.log(report);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${report}\n`);
  const failed = conversions.filter((c) => c.failed);
  if (failed.length > 0) {
    console.error(`measure-converter: ${failed.length} conversion(s) failed in workerd`);
    process.exitCode = 1;
  }
  const slow = conversions.filter((c) => !c.failed && c.importCpuMs > IMPORT_BUDGET_MS);
  if (slow.length > 0) {
    const sizes = slow.map((c) => `${kb(c.bytes)} in ${seconds(c.importCpuMs)}`).join(', ');
    console.error(`measure-converter: import over the ${seconds(IMPORT_BUDGET_MS)} workerd CPU budget: ${sizes}`);
    process.exitCode = 1;
  }
  const badTitles = titles.filter((t) => t.failed || overTitleBudget(t));
  if (badTitles.length > 0) {
    const detail = badTitles.map((t) => (t.failed ? `${t.name}: ${t.failed}` : `${t.name} at ${t.cpuMs} ms mean, ${t.maxCpuMs} ms max`)).join(', ');
    console.error(`measure-converter: title rename failed or over the ${TITLE_WRITE_BUDGET_MS} ms workerd CPU budget: ${detail}`);
    process.exitCode = 1;
  }
  const searchProblems = searchBudgetProblems(searches);
  if (searchProblems.length > 0) {
    console.error(`measure-converter: search over budget in workerd: ${searchProblems.join('; ')}`);
    process.exitCode = 1;
  }
  const ordinaryFailures = ordinaryProblems(ordinary);
  if (ordinaryFailures.length > 0) {
    console.error(`measure-converter: ordinary notes cut or over budget in workerd: ${ordinaryFailures.join('; ')}`);
    process.exitCode = 1;
  }
  const adversarialProblems = adversarialBudgetProblems(adversarial);
  if (adversarialProblems.length > 0) {
    console.error(`measure-converter: adversarial lines over budget in workerd: ${adversarialProblems.join('; ')}`);
    process.exitCode = 1;
  }
  const repeatedLineProblems = multilineProblems(multiline);
  if (repeatedLineProblems.length > 0) {
    console.error(`measure-converter: notes of repeated lines over budget or growing faster than linearly in workerd: ${repeatedLineProblems.join('; ')}`);
    process.exitCode = 1;
  }
  const tabProblems = entityTabProblems(entityTabs);
  if (tabProblems.length > 0) {
    console.error(`measure-converter: entity-tab lines over budget or growing faster than linearly in workerd: ${tabProblems.join('; ')}`);
    process.exitCode = 1;
  }
  const payloadProblems = payloads.failed ? [payloads.failed] : payloadBudgetProblems(payloads.notes);
  if (payloadProblems.length > 0) {
    console.error(`measure-converter: payload frames over budget in workerd: ${payloadProblems.join('; ')}`);
    process.exitCode = 1;
  }
}

/** Every way the payload-frame runs miss the stated budget (empty when they meet it). */
function payloadBudgetProblems(notes) {
  const problems = [];
  for (const n of notes) {
    if (n.frameCpuMs > PAYLOAD_FRAME_BUDGET_MS) problems.push(`${n.blocks} ids: ${n.frameCpuMs} ms of CPU per frame`);
    if (n.rssMb > PAYLOAD_RSS_BUDGET_MB) problems.push(`${n.blocks} ids: RSS grew ${n.rssMb} MB`);
    if (n.held > PAYLOAD_DOCS_HELD) problems.push(`${n.blocks} ids: ${n.held} payload docs held`);
    if (n.foreign > 0) problems.push(`${n.blocks} ids: acks named ${n.foreign} ids the socket did not write`);
  }
  const [small, large] = notes;
  // 10 ms CPU ticks: compare at no finer than 0.05 ms per frame.
  if (large.frameCpuMs > PAYLOAD_SCALING * Math.max(small.frameCpuMs, 0.05)) {
    problems.push(`per-frame CPU grew from ${small.frameCpuMs} ms (${small.blocks} ids) to ${large.frameCpuMs} ms (${large.blocks} ids)`);
  }
  return problems;
}

main().catch((error) => {
  console.error(`measure-converter: ${error.stack ?? error.message}`);
  process.exitCode = 1;
});
