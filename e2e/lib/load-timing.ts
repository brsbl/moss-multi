// Load timing for the editor and viewer bundles (T3.12): the notes, the cold and warm runs and the report. A cold
// run is a fresh browser context (empty HTTP and code caches); a warm run is a further load in the same context, the
// median of WARM_RUNS. Every time is on the page's clock, in ms since navigation start.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Browser, BrowserContext, Page, TestInfo } from '@playwright/test';

export const WARM_RUNS = 3;

const ID = '6a1d2c3b-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
export const meta = (title: string) => ({
  id: ID,
  title,
  createdAt: 1_780_000_000,
  updatedAt: 1_780_000_100,
  stickyTabs: [],
  frontmatterMeta: {},
  folderPath: 'Notes',
  trashedAt: null,
  lastOpenedAt: null,
  contentType: 'medium-text',
});

/** (a) A small plain note. */
export const PLAIN = `# Weekly plan

A short note of plain text, the kind most notes are, with a [link](https://example.com/plan) and some **bold** words.

## Monday

Water the seedlings and check the soil before noon. Order more compost for the raised beds.

- Tomatoes
- Basil
- Peppers

The last line of the note.
`;

/** (b) A typical note: prose, a checklist, a table and a code block. */
export const TYPICAL = `# Release checklist

What ships this week, who owns it, and the script that tags the release. See [the runbook](https://example.com/runbook).

## Owners

| Area | Owner | Status | Due |
| --- | --- | --- | --- |
| Editor | Ana | In review | Mon |
| Viewer | Ben | Done | Tue |
| Sync | Cai | Blocked | Wed |
| Search | Dee | In progress | Thu |
| Docs | Eli | Not started | Fri |

## Steps

- [x] Freeze the branch
- [ ] Run the full lane
- [ ] Publish the artifacts

\`\`\`ts
import { execFileSync } from 'node:child_process';

export function tagRelease(version: string): string {
  const tag = \`editor-v\${version}\`;
  execFileSync('git', ['tag', '-a', tag, '-m', tag]);
  execFileSync('git', ['push', 'origin', tag]);
  return tag;
}

const version = process.argv[2];
if (!/^\\d+\\.\\d+\\.\\d+$/.test(version)) throw new Error('usage: tag <semver>');
console.log(tagRelease(version));
\`\`\`

The last line of the note.
`;

export interface LoadNote {
  key: 'plain' | 'typical' | 'all';
  title: string;
  markdown: string;
  /** Text the body shows once the note has painted. */
  probe: string;
}

export function loadNotes(demo: string): LoadNote[] {
  const all = demo.startsWith('# ') ? demo : `# Every family\n\n${demo}`;
  return [
    { key: 'plain', title: 'Weekly plan', markdown: PLAIN, probe: 'The last line of the note.' },
    { key: 'typical', title: 'Release checklist', markdown: TYPICAL, probe: 'The last line of the note.' },
    { key: 'all', title: all.slice(2, all.indexOf('\n')), markdown: all, probe: 'Closing paragraph.' },
  ];
}

export interface Resource {
  name: string;
  kind: string;
  start: number;
  end: number;
  transfer: number | null;
  encoded: number | null;
}

export interface LoadRun {
  marks: Record<string, number>;
  resources: Resource[];
  bridge: { op: string; start: number; end: number | null }[];
  readyBridgeCalls?: number;
  errors: string[];
  editable: boolean;
  typed?: boolean;
  /** Each block decorator's height when the note first painted, and once everything had loaded. */
  paintBlocks?: { text: string; height: number }[];
  settledBlocks?: { text: string; height: number }[];
  served?: { path: string; status: number; bytes: number }[];
}

/** Waits for the fixture page's result and adds the page's resource timings. */
export async function collect(page: Page, global: string, timeout = 60_000): Promise<LoadRun> {
  await page.waitForFunction((name) => (window as unknown as Record<string, { done?: boolean }>)[name]?.done === true, global, { timeout });
  return page.evaluate((name) => {
    const result = (window as unknown as Record<string, LoadRun>)[name];
    const resources = performance.getEntriesByType('resource').map((entry) => {
      const timing = entry as PerformanceResourceTiming;
      const path = new URL(timing.name).pathname;
      return {
        name: path,
        kind: timing.initiatorType,
        start: Math.round(timing.startTime),
        end: Math.round(timing.responseEnd),
        transfer: typeof timing.transferSize === 'number' ? timing.transferSize : null,
        encoded: typeof timing.encodedBodySize === 'number' ? timing.encodedBodySize : null,
      };
    });
    return { ...JSON.parse(JSON.stringify(result)), resources };
  }, global);
}

export const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)];
};

/** One cold load in a fresh context, then WARM_RUNS loads in that context; `load` drives one page load. */
export async function coldAndWarm(browser: Browser, load: (page: Page) => Promise<LoadRun>, contextOptions: Parameters<Browser['newContext']>[0]) {
  const context: BrowserContext = await browser.newContext(contextOptions);
  try {
    const page = await context.newPage();
    const cold = await load(page);
    const warm: LoadRun[] = [];
    for (let i = 0; i < WARM_RUNS; i += 1) warm.push(await load(page));
    return { cold, warm };
  } finally {
    await context.close();
  }
}

/** The warm runs' median of each mark. */
export function warmMarks(runs: LoadRun[]): Record<string, number> {
  const names = new Set(runs.flatMap((run) => Object.keys(run.marks)));
  return Object.fromEntries([...names].map((name) => [name, Math.round(median(runs.map((run) => run.marks[name] ?? Number.NaN)))]));
}

/** Writes the report next to the run's other results (uploaded by CI) and prints it to the log. */
export function report(testInfo: TestInfo, file: string, data: unknown, table: string[]): void {
  const path = `${testInfo.config.rootDir}/test-results/load/${file}`;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);
  console.log(table.join('\n'));
}
