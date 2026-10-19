#!/usr/bin/env node
// DocDO memory in workerd (T8.F). Each near-cap note the j01 journeys import through POST /api/docs (e2e/lib/large-notes.ts)
// is created through the real DocDO (packages/sync/measure/doc-worker.ts) in a fresh `wrangler dev --local`, and the
// isolate's JS heap is read over the inspector after a full GC: before the create, after it (the note's Y.Doc as the
// DocDO holds it), with what an export reads held beside it, and with a server write's mirror held instead. A Cloudflare
// isolate may use 128 MB, shared by every Durable Object it holds. A create holds the import's mirror, then the note and
// its export view, so the view must not copy the note: the run fails when an export's view retains more than
// EXPORT_VIEW_SHARE of the note's own heap, or when a note cannot be measured. Prints a markdown table (and appends it
// to $GITHUB_STEP_SUMMARY) and writes the figures to .cache/measure/memory.json.
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { bundle, startWorker, stop } from './measure-converter.mjs';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const OUT = join(REPO, '.cache/measure');
export const ISOLATE_LIMIT_MB = 128;
/** The most an export's view may retain, as a share of the note's own heap. A copy of the note is about 1. */
export const EXPORT_VIEW_SHARE = 0.4;
const REQUEST_TIMEOUT_MS = 180_000;
const MB = 1024 * 1024;

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

/**
 * The worker isolate's inspector, through wrangler's proxy: its JS heap in use after two full GCs. workerd runs a
 * queued `HeapProfiler.collectGarbage` only when the isolate next takes a request, so each GC is followed by pings to
 * `origin` until it answers.
 */
async function inspector(port, origin) {
  const [target] = await (await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(10_000) })).json();
  const ws = new WebSocket(target.webSocketDebuggerUrl, { headers: { origin: 'http://127.0.0.1' } });
  const pending = new Map();
  let next = 1;
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data));
    const waiter = message.id === undefined ? undefined : pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(`${waiter.method}: ${message.error.message}`));
    else waiter.resolve(message.result);
  });
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error('the inspector socket failed to open')), { once: true });
  });
  const send = (method) => new Promise((resolve, reject) => {
    const id = next++;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method}: no answer in 60 s`));
    }, 60_000);
    pending.set(id, { method, resolve: (value) => { clearTimeout(timer); resolve(value); }, reject: (error) => { clearTimeout(timer); reject(error); } });
    ws.send(JSON.stringify({ id, method, params: {} }));
  });
  return {
    async heap() {
      for (let gc = 0; gc < 2; gc += 1) {
        let done = false;
        const collected = send('HeapProfiler.collectGarbage').finally(() => {
          done = true;
        });
        while (!done) {
          await call(origin, '/ping');
          await Promise.race([collected, new Promise((resolve) => setTimeout(resolve, 250))]);
        }
        await collected;
      }
      return (await send('Runtime.getHeapUsage')).usedSize;
    },
    close: () => ws.close(),
  };
}

async function call(origin, path, init) {
  const response = await fetch(`${origin}${path}`, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  const body = await response.text();
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status} ${body.slice(0, 200)}`);
  return body;
}

/** One note in a fresh worker: heap before, with the note, with its export view, and with a mirror (bytes). */
async function measureNote(name, markdown, port) {
  const server = await startWorker('docdo-memory', port);
  let probe;
  try {
    await call(server.origin, '/ping');
    probe = await inspector(port + 1000, server.origin);
    const doc = `memory-${port}`;
    const base = await probe.heap();
    const { stateBytes } = JSON.parse(await call(server.origin, `/create?doc=${doc}`, { method: 'POST', body: markdown }));
    const live = await probe.heap();
    const { structs } = JSON.parse(await call(server.origin, `/structs?doc=${doc}`));
    await call(server.origin, `/hold?doc=${doc}&kind=export`);
    const view = await probe.heap();
    await call(server.origin, `/release?doc=${doc}`);
    await call(server.origin, `/hold?doc=${doc}&kind=mirror`);
    const mirror = await probe.heap();
    await call(server.origin, `/release?doc=${doc}`);
    return { name, markdownBytes: Buffer.byteLength(markdown), stateBytes, structs, baseBytes: base, noteBytes: live - base, viewBytes: view - live, mirrorBytes: mirror - live };
  } catch (error) {
    return { name, markdownBytes: Buffer.byteLength(markdown), failed: `${String(error.message).split('\n')[0]}`, logs: server.logs.value.slice(-2_000) };
  } finally {
    probe?.close();
    await stop(server.child);
  }
}

/** Every way the measured notes miss the bound (empty when they meet it). */
export function memoryProblems(notes) {
  const problems = [];
  for (const n of notes) {
    if (n.failed) problems.push(`${n.name}: not measured (${n.failed})`);
    else if (n.viewBytes > EXPORT_VIEW_SHARE * n.noteBytes) {
      problems.push(`${n.name}: the export view retains ${(n.viewBytes / MB).toFixed(1)} MB, over ${EXPORT_VIEW_SHARE} of the note's ${(n.noteBytes / MB).toFixed(1)} MB`);
    }
  }
  return problems;
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  await bundle('docdo-memory', join(REPO, 'packages/sync/measure/doc-worker.ts'), {
    durable_objects: { bindings: [{ name: 'DocDO', class_name: 'MeasuredDocDO' }] },
    migrations: [{ tag: 'v1', new_sqlite_classes: ['MeasuredDocDO'] }],
  });
  const notes = [];
  let port = 9810;
  for (const [name, markdown] of await cases()) {
    notes.push(await measureNote(name, markdown, port));
    port += 1;
  }
  const mb = (bytes) => (bytes / MB).toFixed(1);
  const lines = [
    '### DocDO memory in workerd (T8.F)',
    '',
    `JS heap in use after a full GC (\`Runtime.getHeapUsage\` over the inspector). An isolate may use ${ISOLATE_LIMIT_MB} MB, shared by every Durable Object it holds; array buffers (the stored state) are outside these figures.`,
    '',
    '| Note | Markdown | State | Structs | Note heap | B/struct | Export view | Mirror | Note + view | Note + mirror |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...notes.map((n) => (n.failed
      ? `| ${n.name} | ${mb(n.markdownBytes)} MB | FAILED: ${n.failed} | | | | | | | |`
      : `| ${n.name} | ${mb(n.markdownBytes)} MB | ${mb(n.stateBytes)} MB | ${n.structs} | ${mb(n.noteBytes)} MB | ${Math.round(n.noteBytes / n.structs)} | ${mb(n.viewBytes)} MB | ${mb(n.mirrorBytes)} MB | ${mb(n.baseBytes + n.noteBytes + n.viewBytes)} MB | ${mb(n.baseBytes + n.noteBytes + n.mirrorBytes)} MB |`)),
    '',
    `"Note + view" and "Note + mirror" include the worker's own heap before the create (${notes.find((n) => !n.failed) ? mb(notes.find((n) => !n.failed).baseBytes) : '?'} MB).`,
  ];
  const report = lines.join('\n');
  console.log(report);
  writeFileSync(join(OUT, 'memory.json'), `${JSON.stringify(notes.map((n) => ({ ...n, logs: undefined })), null, 2)}\n`);
  for (const n of notes.filter((note) => note.failed)) console.error(`${n.name}:\n${n.logs}`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${report}\n`);
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
