// Shell parity (A§20, S-test §5): each target is captured from the Ladle oracle (twice, which must agree) and
// from the built Worker, in the same Chromium at 1440x1000 and 2x, and compared. Outputs land in
// test-results/parity/<target>-<theme>/: oracle.png, candidate.png, diff.png, triptych.png, metrics.json.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { PNG } from 'pngjs';
import { APP_STATE_ATTR } from '../lib/contract.ts';
import { InfraBlocked } from '../lib/infra.ts';
import { mintPrincipal, signIn } from '../lib/principals.ts';
import { Stack } from '../lib/stack.ts';
import { compare, type Rect } from './compare.ts';
import { serveStatic, type StaticServer } from './serve-static.ts';
import { CROP, FONT_FACES, STORY_NOW, TARGETS, THEMES, type Target, type Theme } from './targets.ts';

const OUT = join(import.meta.dirname, '../test-results/parity');
const VIEWPORT = { width: 1440, height: 1000 };

interface NoteListing { id: string; title: string; createdAt: number; updatedAt: number }

let oracle: StaticServer;
let stack: Stack;
let stories: Set<string>;
let principals = 0;

test.beforeAll(async () => {
  const dir = process.env.ORACLE_DIR;
  if (!dir) throw new InfraBlocked('ORACLE_DIR is unset; build it with e2e/parity/oracle/build.mjs');
  oracle = await serveStatic(dir);
  stories = new Set(Object.keys((JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8')) as { stories: object }).stories));
  stack = Stack.fromState();
  await stack.assertProvenance();
});

test.afterAll(async () => {
  await oracle?.close();
});

async function newPage(browser: Browser, theme: Theme): Promise<Page> {
  const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 2, colorScheme: theme, reducedMotion: 'reduce' });
  const page = await context.newPage();
  await page.clock.setFixedTime(new Date(STORY_NOW));
  return page;
}

/** The audit both sides pass before capture; a failing oracle audit is BLOCKED, not a product verdict. */
async function audit(page: Page, theme: Theme, side: string): Promise<void> {
  const crop = page.locator(CROP);
  await crop.waitFor({ state: 'visible', timeout: 30_000 });
  const report = await page.evaluate(async (faces) => {
    const missing: string[] = [];
    for (const face of faces) if ((await document.fonts.load(face, 'Aa')).length === 0) missing.push(face);
    await document.fonts.ready;
    return { missing, theme: document.documentElement.dataset.theme ?? null };
  }, FONT_FACES);
  const box = await crop.boundingBox();
  const problems = [
    ...report.missing.map((face) => `font ${face} did not load`),
    ...(report.theme === theme ? [] : [`html[data-theme] is ${report.theme}, expected ${theme}`]),
    ...(box && box.width >= 1400 ? [] : [`${CROP} is ${box?.width ?? 0}px wide, expected at least 1400`]),
  ];
  if (problems.length > 0) {
    const message = `${side} audit: ${problems.join('; ')}`;
    if (side === 'oracle') throw new InfraBlocked(message);
    throw new Error(message);
  }
}

async function capture(page: Page): Promise<Buffer> {
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
  await page.keyboard.press('Escape');
  await page.evaluate(() => {
    (document.activeElement as HTMLElement | null)?.blur();
    window.getSelection()?.removeAllRanges();
  });
  await page.mouse.move(VIEWPORT.width - 2, VIEWPORT.height - 2);
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
  return page.locator(CROP).screenshot({ animations: 'disabled', caret: 'hide', scale: 'device' });
}

async function maskRects(page: Page, selectors: string[]): Promise<Rect[]> {
  const origin = await page.locator(CROP).boundingBox();
  if (!origin || selectors.length === 0) return [];
  const rects = await page.evaluate((list) => list.flatMap((s) => [...document.querySelectorAll(s)].map((el) => el.getBoundingClientRect().toJSON())), selectors);
  return rects.map((r: DOMRect) => ({ x: Math.floor((r.x - origin.x) * 2), y: Math.floor((r.y - origin.y) * 2), width: Math.ceil(r.width * 2), height: Math.ceil(r.height * 2) }));
}

interface OracleCapture { png: Buffer; listing: NoteListing[]; openTitle: string | null }

/** The open note's title field (moss's title is the first textbox in the shell). */
const openTitle = (page: Page) => page.evaluate((crop) => document.querySelector(`${crop} [role="textbox"]`)?.textContent ?? null, CROP);

async function captureOracle(browser: Browser, target: Target, theme: Theme): Promise<OracleCapture> {
  const page = await newPage(browser, theme);
  try {
    await page.goto(`${oracle.url}/?story=${target.story}&mode=preview`);
    await audit(page, theme, 'oracle');
    const listing = await page.evaluate(() =>
      (window as unknown as { electronAPI: { notes: { getAll: () => Promise<NoteListing[]> } } }).electronAPI.notes.getAll(),
    );
    return { png: await capture(page), listing, openTitle: await openTitle(page) };
  } finally {
    await page.context().close();
  }
}

async function captureCandidate(browser: Browser, target: Target, theme: Theme, oracleState: OracleCapture): Promise<{ png: Buffer; masks: Rect[] }> {
  const { listing } = oracleState;
  const page = await newPage(browser, theme);
  try {
    principals += 1;
    const principal = await mintPrincipal(stack.baseUrl, `parity-${process.env.RUN_ID ?? 'local'}-${Date.now().toString(36)}`, target.id, principals);
    await page.context().addCookies(await signIn(stack.baseUrl, principal));
    let path = '/';
    if (target.seed === 'story-listing') {
      if (listing.length === 0) throw new InfraBlocked(`${target.story} listed no notes`);
      // The bridge converts epoch ms to moss's seconds, so the story's seconds go out as ms.
      const docs = listing.map((note) => ({ id: note.id, title: note.title, createdAt: note.createdAt * 1000, updatedAt: note.updatedAt * 1000 }));
      await page.route('**/api/workspace*', (route) => route.fulfill({ json: { vault: { id: 'parity-vault', name: 'Home' }, docs } }));
      path = `/d/${encodeURIComponent(listing[0].id)}`;
    }
    await page.goto(new URL(path, stack.baseUrl).href);
    await page.locator(`html[${APP_STATE_ATTR}="ready"]`).waitFor({ state: 'attached', timeout: 30_000 });
    if (target.seed === 'story-listing' && oracleState.openTitle && oracleState.openTitle !== listing[0].title) {
      // The story hydrates its first note, then moss's startup opens the most recent one; do the same from the
      // sidebar, so back history and the active row match.
      await expect(page.locator('[role="textbox"]').nth(0)).toHaveText(listing[0].title);
      await page.locator(CROP).getByText(oracleState.openTitle, { exact: true }).click();
      await expect(page.locator('[role="textbox"]').nth(0)).toHaveText(oracleState.openTitle);
    }
    await audit(page, theme, 'candidate');
    const masks = await maskRects(page, target.masks);
    return { png: await capture(page), masks };
  } finally {
    await page.context().close();
  }
}

for (const target of TARGETS) {
  for (const theme of THEMES) {
    test(`${target.id} ${theme} meets ${target.floor}% with blobs <= ${target.maxBlob} px²`, async ({ browser }, testInfo) => {
      if (!stories.has(target.story)) throw new InfraBlocked(`the oracle has no story ${target.story}`);
      const first = await captureOracle(browser, target, theme);
      const second = await captureOracle(browser, target, theme);
      const noise = compare(first.png, second.png).metrics;
      if (noise.diffPixels > 0 || noise.sizeDelta.dw || noise.sizeDelta.dh) {
        throw new InfraBlocked(`two oracle captures of ${target.story} differ by ${noise.diffPixels} px`);
      }
      const candidate = await captureCandidate(browser, target, theme, first);
      const { metrics, diff, triptych } = compare(first.png, candidate.png, candidate.masks);

      const dir = join(OUT, `${target.id}-${theme}`);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'oracle.png'), first.png);
      writeFileSync(join(dir, 'candidate.png'), candidate.png);
      writeFileSync(join(dir, 'diff.png'), PNG.sync.write(diff));
      writeFileSync(join(dir, 'triptych.png'), PNG.sync.write(triptych));
      writeFileSync(join(dir, 'metrics.json'), `${JSON.stringify({ target, theme, ...metrics }, null, 2)}\n`);
      testInfo.annotations.push({ type: 'parity', description: JSON.stringify(metrics) });
      if (metrics.diffPct > 0.8 * target.floor && metrics.diffPct <= target.floor) {
        testInfo.annotations.push({ type: 'near-threshold', description: `${metrics.diffPct.toFixed(4)}%: read diff.png and explain` });
      }

      expect(metrics.sizeDelta, 'oracle and candidate crops are the same size').toEqual({ dw: 0, dh: 0 });
      expect(metrics.maskedPct, 'masks cover at most 3% of the crop').toBeLessThanOrEqual(3);
      expect(metrics.diffPct, `${target.id} ${theme} diff %`).toBeLessThanOrEqual(target.floor);
      expect(metrics.maxBlob, `${target.id} ${theme} largest blob (px²)`).toBeLessThanOrEqual(target.maxBlob);
    });
  }
}
