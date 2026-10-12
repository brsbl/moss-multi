// j01-large (T3.B13, backlog B346): typing in a note of 40,000 lines, one paragraph each, stays responsive. Two costs
// grew with the note: @lexical/yjs visited every block per keystroke to find the one that changed
// (patches/@lexical__yjs@0.48.0.patch), and Chromium measured all the text above the caret on every keystroke to sync
// the selection with the platform, about 100 ms at the middle line. The journey opens that note and a 400-line
// control, types into the middle of each, and records the long tasks and each keystroke's input-to-paint (Event
// Timing and Long Tasks, Chromium only); both must stay within budgets calibrated on CI runners. Scrolling up and
// down, caret movement to the note's start and the peer stay correct.
//
// The notes are created through POST /api/docs as declared setup.
import type { Actor } from '../lib/actors.ts';
import { grantDoc } from '../lib/grants.ts';
import { expect, test, ui } from '../lib/test.ts';

const LINES = 40_000;
const CONTROL_LINES = 400;
const TYPED = 'abcdefghijklmnopqrst';
/**
 * Calibrated on CI runners (T3.B13): before blocks above the viewport stopped painting, the large note's median
 * keystroke painted in 152-232 ms (runs 38301848192, 38301850762, 38311128561) and long tasks held the main thread for
 * about 150-250 ms per key; the control's keystrokes painted in 16-48 ms.
 */
const INPUT_TO_PAINT_MS = 80;
/** Long-task time per keystroke while typing, and the longest one. */
const BUSY_PER_KEY_MS = 50;
const LONGEST_TASK_MS = 200;
const CONTROL_INPUT_TO_PAINT_MS = 64;

const lines = (count: number) => Array.from({ length: count }, (_, i) => `Line ${i} of the note.`).join('\n\n');

// Playwright's trace snapshots the whole DOM on every action: 40,000 paragraphs per keystroke, which is not the editor's
// cost.
test.use({ trace: 'off' });

async function create(actor: Actor, baseUrl: string, title: string, markdown: string): Promise<string> {
  const response = await actor.context.request.post('/api/docs', { headers: { origin: baseUrl }, data: { title, markdown }, timeout: 120_000 });
  expect(response.status(), `declared setup: ${title} is imported`).toBe(201);
  return ((await response.json()) as { doc: { id: string } }).doc.id;
}

/** Puts the caret after `Line <line>` and types TYPED a key at a time; returns the keystrokes' timings. */
async function typeTimed(actor: Actor, id: string, line: number) {
  const body = ui.body(actor, id);
  await body.evaluate((root, line) => {
    const block = root.children[line] as HTMLElement;
    block.scrollIntoView({ block: 'center' });
    const text = document.createTreeWalker(block, NodeFilter.SHOW_TEXT).nextNode()!;
    const range = document.createRange();
    range.setStart(text, `Line ${line}`.length);
    range.collapse(true);
    root.focus();
    document.getSelection()!.removeAllRanges();
    document.getSelection()!.addRange(range);
  }, line);
  await actor.page.waitForTimeout(1_000);
  await actor.page.evaluate(() => {
    const probe = window as unknown as { __b13: { longTasks: number[]; keys: number[] }; __b13Observers?: PerformanceObserver[] };
    probe.__b13Observers?.forEach((observer) => observer.disconnect());
    probe.__b13 = { longTasks: [], keys: [] };
    const tasks = new PerformanceObserver((list) => { for (const entry of list.getEntries()) probe.__b13.longTasks.push(entry.duration); });
    tasks.observe({ type: 'longtask' });
    const events = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) if (entry.name === 'keydown') probe.__b13.keys.push(entry.duration);
    });
    events.observe({ type: 'event', durationThreshold: 16 } as PerformanceObserverInit);
    probe.__b13Observers = [tasks, events];
  });
  // Each keystroke waits for the one before it to paint and settle, so a slow keystroke is measured alone rather than
  // batched with the keys queued behind it.
  for (const key of TYPED) {
    await actor.page.keyboard.type(key);
    await actor.page.evaluate(() => new Promise((done) => requestAnimationFrame(() => setTimeout(done, 0))));
    await actor.page.waitForTimeout(250);
  }
  await actor.page.waitForTimeout(1_000);
  const { longTasks, keys } = await actor.page.evaluate(() => (window as unknown as { __b13: { longTasks: number[]; keys: number[] } }).__b13);
  // Event Timing reports only events of 16 ms or more; a keystroke it left out painted within 16 ms.
  const durations = [...keys, ...Array(Math.max(0, TYPED.length - keys.length)).fill(16)].sort((a, b) => a - b);
  return {
    inputToPaint: durations[Math.floor(durations.length / 2)],
    busyPerKey: Math.round(longTasks.reduce((sum, ms) => sum + ms, 0) / TYPED.length),
    longest: Math.round(Math.max(0, ...longTasks)),
  };
}

test('j01-large: typing in the middle of a 40,000-line note stays within budget of a small note; scrolling, the caret and the peer stay correct @p:col-1 @p:tech-8', async ({ actors, stack, browserName }, testInfo) => {
  test.setTimeout(600_000);
  const ada = await actors.session(await actors.principal('ada'));
  const large = await create(ada, stack.baseUrl, 'Large', lines(LINES));
  const control = await create(ada, stack.baseUrl, 'Control', lines(CONTROL_LINES));
  const benPrincipal = await actors.principal('ben');
  await grantDoc(ada, large, benPrincipal);

  await ada.goto(`/d/${control}`);
  await ui.waitBodyLive(ada, control, 120_000);
  const small = await typeTimed(ada, control, CONTROL_LINES / 2);

  await ada.goto(`/d/${large}`);
  await ui.waitBodyLive(ada, large, 120_000);
  await ada.observeEditor(large);
  const ben = await actors.open(benPrincipal, { path: `/d/${large}` });
  await ui.waitBodyLive(ben, large, 120_000);
  await expect.poll(() => ui.body(ada, large).evaluate((root) => root.children.length), { timeout: 60_000 }).toBe(LINES);
  const big = await typeTimed(ada, large, LINES / 2);

  const measured = { control: small, large: big };
  testInfo.annotations.push({ type: 'large-note timing', description: JSON.stringify(measured) });

  // Correct: the typed text is in the middle line, here, on the peer and on the server.
  const middle = `Line ${LINES / 2}${TYPED} of the note.`;
  for (const actor of [ada, ben]) {
    await expect.poll(() => ui.body(actor, large).evaluate((root, line) => root.children[line]?.textContent, LINES / 2), { message: `${actor.label}: the typed text lands in the middle line`, timeout: 60_000 }).toBe(middle);
  }
  // The caret moves on to the next line and types there.
  await ada.page.keyboard.press('ArrowDown');
  await ada.page.keyboard.type('!');
  await expect.poll(() => ui.body(ben, large).evaluate((root, line) => root.children[line]?.textContent ?? '', LINES / 2 + 1), { timeout: 60_000 }).toContain('!');
  // Scrolling reaches the last line, and back up the first, which render.
  await ui.body(ada, large).evaluate((root) => root.lastElementChild!.scrollIntoView({ block: 'end' }));
  await expect(ui.body(ada, large).locator('p').filter({ hasText: `Line ${LINES - 1} of the note.` })).toBeInViewport();
  await expect(ui.body(ada, large).locator('p').filter({ hasText: `Line ${LINES - 1} of the note.` })).toBeVisible();
  await ui.body(ada, large).evaluate((root) => root.firstElementChild!.scrollIntoView({ block: 'start' }));
  await expect(ui.body(ada, large).locator('p').filter({ hasText: /^Line 0 of the note\.$/ })).toBeVisible();
  // From the middle, the caret reaches the note's start and types there.
  await ui.body(ada, large).evaluate((root, line) => (root.children[line] as HTMLElement).scrollIntoView({ block: 'center' }), LINES / 2);
  await ui.body(ada, large).locator('p').filter({ hasText: new RegExp(`^Line ${LINES / 2 + 2} of`) }).click();
  await ada.page.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowUp' : 'Control+Home');
  await ada.page.keyboard.type('^');
  await expect.poll(() => ui.body(ben, large).evaluate((root) => root.firstElementChild?.textContent ?? ''), { timeout: 60_000 }).toBe('^Line 0 of the note.');
  await expect(ui.body(ada, large).locator('p').filter({ hasText: /^\^Line 0 of the note\.$/ })).toBeInViewport();
  await ui.waitAcked(ada, large, 120_000);
  const exported = await (await ada.context.request.get(`/api/docs/${large}/content`, { timeout: 120_000 })).text();
  expect(exported).toContain(middle);
  expect(exported).toContain('^Line 0 of the note.');

  if (browserName !== 'chromium') return; // The budget is calibrated in Chromium; WebKit reports no long tasks.
  expect(small.inputToPaint, `the control's input-to-paint (${JSON.stringify(measured)})`).toBeLessThanOrEqual(CONTROL_INPUT_TO_PAINT_MS);
  expect(big.inputToPaint, `the large note's input-to-paint (${JSON.stringify(measured)})`).toBeLessThanOrEqual(INPUT_TO_PAINT_MS);
  expect(big.busyPerKey, `the large note's long-task time per keystroke (${JSON.stringify(measured)})`).toBeLessThanOrEqual(BUSY_PER_KEY_MS);
  expect(big.longest, `the large note's longest task while typing (${JSON.stringify(measured)})`).toBeLessThanOrEqual(LONGEST_TASK_MS);
});
