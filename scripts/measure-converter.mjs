#!/usr/bin/env node
// SP2 (ARCHITECTURE §22): bundles the converter into a Worker the way wrangler does (its own esbuild), runs it
// under `wrangler dev --local`, and reports upload size, cold start, 2 MB import/export CPU, peak memory and
// the Y.Doc state-to-markdown ratio over the family corpus. Prints a markdown table (and appends it to
// $GITHUB_STEP_SUMMARY). Exits non-zero only when the converter fails to load or convert in workerd.
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

const vendor = join(REPO, 'vendor/moss/packages');
const ALIASES = [
  [/^@moss\/shared$/, `${vendor}/shared/src/index.ts`],
  [/^@moss\/shared\//, `${vendor}/shared/src/`],
  [/^@\//, `${vendor}/shared/src/`],
  [/^@moss-desktop\//, `${vendor}/desktop/src/`],
];

// Moss's aliases as an esbuild plugin (wrangler's own `alias` matches whole specifiers only).
const aliasPlugin = {
  name: 'moss-aliases',
  setup(build) {
    build.onResolve({ filter: /^@(moss\/shared|moss-desktop\/|\/)/ }, async (args) => {
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
  const response = await fetch(`${server.origin}${path}`, init);
  const body = await response.text();
  const wallMs = performance.now() - started;
  clearInterval(sampler);
  const after = workerdStats(server.child.pid);
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status} ${body}\n${server.logs.value}`);
  return { wallMs, cpuMs: after.cpuMs - before.cpuMs, rssBeforeKb: before.rssKb, peakRssKb: Math.max(peakRssKb, after.rssKb), body };
}

const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const round = (value) => Math.round(value * 10) / 10;

function corpus() {
  return readdirSync(FIXTURES)
    .filter((file) => file.endsWith('.md') && !readdirSync(FIXTURES).includes(file.replace(/\.md$/, '.comments.json')))
    .sort()
    .map((file) => [file.replace(/\.md$/, ''), readFileSync(join(FIXTURES, file), 'utf8')]);
}

// The family corpus repeated to `bytes`.
function corpusOfSize(fixtures, bytes) {
  const joined = fixtures.map(([, text]) => text).join('\n\n');
  let doc = '';
  while (Buffer.byteLength(doc) < bytes) doc += `${joined}\n\n`;
  return doc;
}

// Import and export one document in a fresh worker, so a crash at one size leaves the others measurable.
async function measureSize(markdown, port) {
  const server = await startWorker('converter', port);
  const runs = { import: [], export: [] };
  try {
    for (let run = 0; run < CONVERSION_RUNS; run += 1) {
      runs.import.push(await timedRequest(server, '/import', { method: 'POST', body: markdown }));
      runs.export.push(await timedRequest(server, '/export'));
    }
    return {
      importCpuMs: round(median(runs.import.map((s) => s.cpuMs))),
      importWallMs: round(median(runs.import.map((s) => s.wallMs))),
      exportCpuMs: round(median(runs.export.map((s) => s.cpuMs))),
      exportWallMs: round(median(runs.export.map((s) => s.wallMs))),
      peakMb: round(Math.max(...runs.import.map((s) => s.peakRssKb - s.rssBeforeKb)) / 1024),
    };
  } catch (error) {
    const log = server.logs.value.split('\n').filter(Boolean).slice(-6).join(' / ');
    return { failed: `${String(error.message).split('\n')[0]}${log ? ` (wrangler: ${log})` : ''}` };
  } finally {
    await stop(server.child);
  }
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
  const conversions = [];
  for (const bytes of [64 * 1024, 512 * 1024, 1024 * 1024, 2 * 1024 * 1024]) {
    const markdown = corpusOfSize(fixtures, bytes);
    conversions.push({ bytes: Buffer.byteLength(markdown), ...(await measureSize(markdown, port)) });
    port += 1;
  }

  const ratios = [];
  const server = await startWorker('converter', port);
  try {
    for (const [name, text] of [...fixtures, ['512 KB corpus', corpusOfSize(fixtures, 512 * 1024)]]) {
      const { body } = await timedRequest(server, '/state', { method: 'POST', body: text });
      const { markdownBytes, stateBytes } = JSON.parse(body);
      ratios.push({ name, markdownBytes, stateBytes, ratio: stateBytes / markdownBytes });
    }
  } finally {
    await stop(server.child);
  }

  const coldOf = (name, key) => round(median(cold[name].map((sample) => sample[key])));
  const families = ratios.filter((r) => !r.name.includes('corpus'));
  const worst = families.reduce((a, b) => (b.ratio > a.ratio ? b : a));
  const kb = (bytes) => `${Math.round(bytes / 1024)} KB`;
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
        ? `| ${kb(c.bytes)} import | FAILED: ${c.failed} |`
        : `| ${kb(c.bytes)} import / export: workerd CPU, median of ${CONVERSION_RUNS} | ${c.importCpuMs} ms / ${c.exportCpuMs} ms (wall ${c.importWallMs} / ${c.exportWallMs} ms); peak RSS growth ${c.peakMb} MB |`,
    ),
    `| State-to-markdown ratio r, worst family | ${worst.ratio.toFixed(2)} (${worst.name}) |`,
    '',
    '| Fixture | Markdown B | Y.Doc state B | Ratio |',
    '| --- | --- | --- | --- |',
    ...ratios.map((r) => `| ${r.name} | ${r.markdownBytes} | ${r.stateBytes} | ${r.ratio.toFixed(2)} |`),
    '',
    'CPU (10 ms ticks) and RSS come from /proc for the workerd children of `wrangler dev --local` on this runner.',
  ];
  const report = lines.join('\n');
  console.log(report);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${report}\n`);
}

main().catch((error) => {
  console.error(`measure-converter: ${error.stack ?? error.message}`);
  process.exitCode = 1;
});
