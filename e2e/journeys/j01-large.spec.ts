// j01-large (T3.B13, backlog B346): typing in a note of 40,000 lines, one paragraph each. @lexical/yjs synced every
// keystroke by visiting each of the 40,000 blocks to find the one that changed; it now syncs only the blocks an update
// touched (patches/@lexical__yjs@0.48.0.patch). The journey opens that note and a 400-line control, types into the
// middle of each, and measures each keystroke's sync to the note's Y.Doc (the binding's local transaction), its
// input-to-paint (Event Timing) and the long tasks while typing (Chromium only). The sync budget is the before/after
// gate. The rest of a keystroke is Chromium's own editing over one editable of 40,000 blocks: layout and the
// platform's text sync walk the whole editable, wherever the caret is, so the input-to-paint and long-task budgets
// guard against regressions only; making those fast needs viewport-bounded rendering. Scrolling, caret movement to the
// note's start and the peer stay correct.
//
// The notes are created through POST /api/docs as declared setup.
import type { Actor } from '../lib/actors.ts';
import { grantDoc } from '../lib/grants.ts';
import { expect, test, ui } from '../lib/test.ts';

const LINES = 40_000;
const CONTROL_LINES = 400;
const TYPED = 'abcdefghijklmnopqrst';
/**
 * Calibrated on CI runners (T3.B13). Sync time per keystroke with the unpatched binding: 31 ms in Chromium and 92 ms in
 * WebKit (run 38321927817); patched, 6 ms and 11-12 ms (run 38323194734).
 * Input-to-paint: 176-232 ms before the patch and 120-184 ms after (runs 38301848192, 38301850762, 38311128561,
 * 38314448516, 38319353253, 38323194734); long tasks 142-251 ms per key before and 94-185 after, the longest up to 715 ms.
 * The sync budget is per engine.
 */
const SYNC_MS = { chromium: 12, webkit: 36 };
const INPUT_TO_PAINT_MS = 240;
const BUSY_PER_KEY_MS = 260;
const LONGEST_TASK_MS = 1_000;
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

type Probe = { longTasks: number[]; keys: number[]; syncs: number[]; observers?: PerformanceObserver[]; doc?: unknown };

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
  const bound = await body.evaluate((root) => {
    const probe = ((window as unknown as { __b13?: Probe }).__b13 ??= { longTasks: [], keys: [], syncs: [] });
    probe.observers?.forEach((observer) => observer.disconnect());
    probe.longTasks = [];
    probe.keys = [];
    probe.syncs = [];
    const tasks = new PerformanceObserver((list) => { for (const entry of list.getEntries()) probe.longTasks.push(entry.duration); });
    tasks.observe({ type: 'longtask' });
    const events = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) if (entry.name === 'keydown') probe.keys.push(entry.duration);
    });
    events.observe({ type: 'event', durationThreshold: 16 } as PerformanceObserverInit);
    probe.observers = [tasks, events];
    // The binding writes each keystroke to the note's Y.Doc in one local transaction.
    type Doc = { on(event: string, listener: (transaction: { local: boolean }) => void): void };
    const editor = (root as HTMLElement & { __lexicalEditor: Record<symbol, { doc?: Doc; root?: { doc: Doc } } | undefined> }).__lexicalEditor;
    const undo = editor[Symbol.for('@lexical/yjs/UndoManager')];
    const doc = undo?.root?.doc ?? undo?.doc;
    if (!doc) return false;
    if (probe.doc !== doc) {
      probe.doc = doc;
      let start = 0;
      doc.on('beforeTransaction', (transaction) => { if (transaction.local) start = performance.now(); });
      doc.on('afterTransaction', (transaction) => {
        if (transaction.local && start && probe.doc === doc) probe.syncs.push(performance.now() - start);
        start = 0;
      });
    }
    return true;
  });
  expect(bound, 'the editor is bound to the note\'s Y.Doc').toBe(true);
  // Each keystroke waits for the one before it to paint and settle, so a slow keystroke is measured alone rather than
  // batched with the keys queued behind it.
  for (const key of TYPED) {
    await actor.page.keyboard.type(key);
    await actor.page.evaluate(() => new Promise((done) => requestAnimationFrame(() => setTimeout(done, 0))));
    await actor.page.waitForTimeout(250);
  }
  await actor.page.waitForTimeout(1_000);
  const { longTasks, keys, syncs } = await actor.page.evaluate(() => {
    const { longTasks, keys, syncs } = (window as unknown as { __b13: Probe }).__b13;
    return { longTasks, keys, syncs };
  });
  const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;
  // Event Timing reports only events of 16 ms or more; a keystroke it left out painted within 16 ms.
  const durations = [...keys, ...Array(Math.max(0, TYPED.length - keys.length)).fill(16)];
  return {
    syncs: syncs.length,
    syncPerKey: Math.round((syncs.reduce((sum, ms) => sum + ms, 0) / TYPED.length) * 10) / 10,
    inputToPaint: median(durations),
    busyPerKey: Math.round(longTasks.reduce((sum, ms) => sum + ms, 0) / TYPED.length),
    longest: Math.round(Math.max(0, ...longTasks)),
  };
}

test('j01-large: each keystroke in the middle of a 40,000-line note syncs only its block and stays within budget; scrolling, the caret and the peer stay correct @p:col-1 @p:tech-8', async ({ actors, stack, browserName }, testInfo) => {
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

  expect(big.syncs, `every keystroke synced (${JSON.stringify(measured)})`).toBeGreaterThanOrEqual(TYPED.length);
  expect(big.syncPerKey, `the large note's sync per keystroke (${JSON.stringify(measured)})`).toBeLessThanOrEqual(browserName === 'chromium' ? SYNC_MS.chromium : SYNC_MS.webkit);
  if (browserName !== 'chromium') return; // Event Timing and Long Tasks are Chromium's.
  expect(small.inputToPaint, `the control's input-to-paint (${JSON.stringify(measured)})`).toBeLessThanOrEqual(CONTROL_INPUT_TO_PAINT_MS);
  expect(big.inputToPaint, `the large note's input-to-paint (${JSON.stringify(measured)})`).toBeLessThanOrEqual(INPUT_TO_PAINT_MS);
  expect(big.busyPerKey, `the large note's long-task time per keystroke (${JSON.stringify(measured)})`).toBeLessThanOrEqual(BUSY_PER_KEY_MS);
  expect(big.longest, `the large note's longest task while typing (${JSON.stringify(measured)})`).toBeLessThanOrEqual(LONGEST_TASK_MS);
});
