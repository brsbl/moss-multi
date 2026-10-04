#!/usr/bin/env node
// SP2 (ARCHITECTURE §22): bundles the converter into a Worker the way wrangler does (its own esbuild), runs it
// under `wrangler dev --local`, and reports upload size, cold start, import/export CPU of the scale note up to
// 2 MB, the 2 MB import into a bound Y.Doc, memory growth and the Y.Doc state-to-markdown ratio over the family
// corpus. Prints a markdown table (and appends it to $GITHUB_STEP_SUMMARY). Exits non-zero when the converter
// fails to load or convert in workerd, including a note that imports to fewer blocks than its copies hold, and
// when an import up to 2 MB takes more than IMPORT_BUDGET_MS of workerd CPU. It also renames a doc's title back and
// forth between worst-case caller texts (packages/sync/measure/title-cases.ts), the DocDO's REST rename path, and
// exits non-zero when a rename lands inexactly or averages more than TITLE_WRITE_BUDGET_MS of workerd CPU.
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

async function bundle(name, entry) {
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
    JSON.stringify({ name: `converter-measure-${name}`, main: 'worker.js', compatibility_date: '2025-09-02', compatibility_flags: ['nodejs_compat'], no_bundle: true }),
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
      const { blocks } = JSON.parse(imported.body);
      if (blocks !== units * unitBlocks) throw new Error(`${blocks} top-level blocks, expected ${units} × ${unitBlocks}`);
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

// Renames the title A → B → A … per case, after one untimed write of A; CPU is averaged over the timed renames.
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
        results.push({ name, chars: [a.length, b.length], cpuMs: mean('cpuMs'), wallMs: mean('wallMs') });
      } catch (error) {
        results.push({ name, chars: [a.length, b.length], failed: String(error.message).split('\n')[0] });
      }
    }
  } finally {
    await stop(server.child);
  }
  return results;
}

async function main() {
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(join(OUT, 'baseline'), { recursive: true });
  writeFileSync(join(OUT, 'baseline.ts'), "export default { fetch: () => new Response('ok') };\n");
  const sizes = {
    baseline: await bundle('baseline', join(OUT, 'baseline.ts')),
    converter: await bundle('converter', join(REPO, 'packages/sync/measure/worker.ts')),
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
        : `| Title rename, ${t.name} (${t.chars.join(' ↔ ')} chars): workerd CPU per request, mean of ${TITLE_WRITES} | ${t.cpuMs} ms${t.cpuMs > TITLE_WRITE_BUDGET_MS ? `, over the ${TITLE_WRITE_BUDGET_MS} ms budget` : ''} (wall ${t.wallMs} ms) |`,
    ),
    `| State-to-markdown ratio r, worst family | ${worst.ratio.toFixed(2)} (${worst.name}) |`,
    '',
    '| Fixture | Markdown B | Y.Doc state B | Ratio |',
    '| --- | --- | --- | --- |',
    ...ratios.map((r) => `| ${r.name} | ${r.markdownBytes} | ${r.stateBytes} | ${r.ratio.toFixed(2)} |`),
    '',
    `The scale note repeats one ${kb(unitBytes)} unit of the family corpus (packages/sync/src/converter/fixtures/scale.json lists what it leaves out). CPU (10 ms ticks) and RSS come from /proc for the workerd children of \`wrangler dev --local\`, which enforces no CPU limit; RSS growth stands in for isolate heap, which workerd does not report.`,
  ];
  const report = lines.join('\n');
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
  const badTitles = titles.filter((t) => t.failed || t.cpuMs > TITLE_WRITE_BUDGET_MS);
  if (badTitles.length > 0) {
    const detail = badTitles.map((t) => (t.failed ? `${t.name}: ${t.failed}` : `${t.name} in ${t.cpuMs} ms`)).join(', ');
    console.error(`measure-converter: title rename failed or over the ${TITLE_WRITE_BUDGET_MS} ms workerd CPU budget: ${detail}`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(`measure-converter: ${error.stack ?? error.message}`);
  process.exitCode = 1;
});
