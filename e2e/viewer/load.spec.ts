// T3.12 viewer load timing: the built viewer's script bytes, and for a small plain note, a typical note (a table and a
// code block) and j14's every-family note, cold and warm, when the bundle evaluated, when the note painted and when
// the viewer was ready, recorded per engine in test-results/load/*.json. The viewer ships as one script (1.x hosts
// may load moss-viewer.js on its own), so its numbers are recorded here rather than held to the editor's budgets.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { expect, test, type Page } from '@playwright/test';
import { VIEWER_DIST, serveViewer, type ViewerServer } from './server.ts';
import { coldAndWarm, collect, loadNotes, report, warmMarks, type LoadNote, type LoadRun } from '../lib/load-timing.ts';

const DEMO = readFileSync(new URL('../fixtures/demo-note.md', import.meta.url), 'utf8');
const NOTES = loadNotes(DEMO);
const CONTEXT = { viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2, locale: 'en-US', timezoneId: 'UTC', colorScheme: 'light' as const };
const kb = (bytes: number) => `${(bytes / 1024).toFixed(1)} KB`;

let server: ViewerServer;

test.beforeAll(async () => {
  server = await serveViewer();
});

test.afterAll(async () => {
  await server?.close();
});

async function loadOnce(page: Page, note: LoadNote): Promise<LoadRun> {
  const consoleErrors: string[] = [];
  const onConsole = (message: { type(): string; text(): string }) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  };
  page.on('console', onConsole);
  await page.addInitScript((value) => {
    (window as unknown as { __load: unknown }).__load = value;
  }, { markdown: note.markdown, probe: note.probe, noteId: `load-${note.key}` });
  const served = server.served.length;
  await page.goto(`${server.url}/fixture/load.html`);
  const run = await collect(page, 'loadResult');
  run.served = server.served.slice(served);
  run.errors.push(...consoleErrors);
  page.off('console', onConsole);
  return run;
}

test('viewer load timing: script bytes and cold and warm runs for the plain, typical and every-family notes', async ({ browser, browserName }, testInfo) => {
  test.setTimeout(300_000);
  const scripts = readdirSync(VIEWER_DIST, { recursive: true })
    .map(String)
    .filter((file) => file.endsWith('.js'));
  const sizes = Object.fromEntries(scripts.map((file) => [file, { bytes: readFileSync(join(VIEWER_DIST, file)).length, gzip: gzipSync(readFileSync(join(VIEWER_DIST, file)), { level: 9 }).length }]));
  server.cache = 'host';
  const results: Record<string, { cold: LoadRun; warm: LoadRun[]; warmMarks: Record<string, number> }> = {};
  const table = [`viewer load, ${browserName}:`, ...Object.entries(sizes).map(([file, size]) => `  ${file}: ${kb(size.bytes)}, ${kb(size.gzip)} gzip`)];
  try {
    for (const note of NOTES) {
      const { cold, warm } = await coldAndWarm(browser, (page) => loadOnce(page, note), CONTEXT);
      const marks = warmMarks(warm);
      results[note.key] = { cold, warm, warmMarks: marks };
      for (const [label, m, run] of [[`${note.key} cold`, cold.marks, cold], [`${note.key} warm`, marks, warm[warm.length - 1]]] as const) {
        table.push(`${label.padEnd(14)} imported ${String(Math.round(m.imported)).padStart(5)}  paint ${String(Math.round(m.paint)).padStart(5)}  ready ${String(Math.round(m.ready)).padStart(5)}  fetched ${kb((run.served ?? []).reduce((total, entry) => total + entry.bytes, 0))}`);
      }
    }
  } finally {
    server.cache = 'no-store';
  }
  report(testInfo, `viewer-load-${browserName}.json`, { sizes, results }, table);
  for (const [key, { cold, warm }] of Object.entries(results)) {
    for (const run of [cold, ...warm]) {
      expect(run.errors, `${key}: no errors`).toEqual([]);
      expect(Number.isFinite(run.marks.paint), `${key}: the note painted`).toBe(true);
    }
  }
});
