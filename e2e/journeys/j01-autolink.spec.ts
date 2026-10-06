// j01-autolink (T3.S5): moss's AutoLinkPlugin matchers run on a paragraph's whole text on every load and every
// keystroke. Opening a note whose body is one long word, and typing at the end of that word, must cost time linear in
// its length: doubling the word from 25k to 50k to 100k characters at most triples the longest main-thread stall
// (moss's regexes made it quadratic, about 4.5 s a keystroke at 50k). Ordinary auto-linking is unchanged: the same
// URLs, schemeless URLs and emails become the same links.
//
// The notes are imported through POST /api/docs as declared setup.
import type { Actor } from '../lib/actors.ts';
import { APP_STATE_ATTR, NAMES, SIDEBAR_ROW_ATTR } from '../lib/contract.ts';
import { expect, test, ui } from '../lib/test.ts';

const SOLO = 'one person opens and types in their own notes; nothing here is shared';
const SIZES = [25_000, 50_000, 100_000];
const KEYS = 5;
/** Stalls under this many ms are noise (a frame, a GC) whatever the ratio. */
const SLACK_MS = 250;

/** The longest main-thread stall since the last reset, sampled every 5 ms from document start. */
function installStallMonitor(): void {
  const stall = { max: 0, last: performance.now() };
  (window as unknown as { __stall: typeof stall }).__stall = stall;
  setInterval(() => {
    const now = performance.now();
    stall.max = Math.max(stall.max, now - stall.last);
    stall.last = now;
  }, 5);
}

const resetStall = (actor: Actor) =>
  actor.page.evaluate(() => {
    const stall = (window as unknown as { __stall: { max: number; last: number } }).__stall;
    stall.max = 0;
    stall.last = performance.now();
  });

/** The longest stall since the reset, once the monitor has run again after it. */
async function readStall(actor: Actor): Promise<number> {
  await actor.page.waitForTimeout(100);
  return Math.round(await actor.page.evaluate(() => (window as unknown as { __stall: { max: number } }).__stall.max));
}

const bodyLength = (actor: Actor, docId: string) => ui.body(actor, docId).evaluate((el) => el.textContent?.length ?? 0);

async function importNote(actor: Actor, baseUrl: string, title: string, markdown: string): Promise<string> {
  const response = await actor.context.request.post('/api/docs', { headers: { origin: baseUrl }, data: { title, markdown } });
  expect(response.status(), 'declared setup: the note is imported').toBe(201);
  return ((await response.json()) as { doc: { id: string } }).doc.id;
}

function expectLinear(what: string, sizes: number[], ms: number[]): void {
  const last = ms.length - 1;
  if (last < 1) return;
  expect(
    ms[last],
    `${what}: ${sizes[last - 1]} chars stalled ${ms[last - 1]} ms, ${sizes[last]} chars ${ms[last]} ms (linear at most triples)`,
  ).toBeLessThanOrEqual(3 * ms[last - 1] + SLACK_MS);
}

const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

test('j01-autolink: a note holding one long word opens, and takes keystrokes at the word’s end, in time linear in its length', async ({ actors, stack, measure }) => {
  test.setTimeout(240_000);
  actors.solo(SOLO);
  const actor = await actors.session(await actors.principal('ada'));
  await actor.context.addInitScript(installStallMonitor);
  const ids: string[] = [];
  for (const n of SIZES) ids.push(await importNote(actor, stack.baseUrl, `Long word ${n}`, 'a'.repeat(n)));
  await actor.goto('/');
  await actor.page.locator(`html[${APP_STATE_ATTR}="ready"]`).waitFor({ state: 'attached', timeout: 30_000 });
  const loads: number[] = [];
  const keys: number[] = [];
  for (const [i, n] of SIZES.entries()) {
    const docId = ids[i];
    // Open from the notes list, so the stall is the note's, not the app's boot.
    await resetStall(actor);
    await actor.page.locator(`[${SIDEBAR_ROW_ATTR}][${NAMES.docId}="${docId}"]`).click();
    await ui.waitLive(actor, docId);
    await expect.poll(() => bodyLength(actor, docId), { message: `the ${n}-char word renders`, timeout: 60_000 }).toBe(n);
    loads.push(await readStall(actor));
    measure.record({ name: `open a ${n}-char word: longest stall`, ms: loads[i], budgetMs: null });
    expectLinear('opening the note', SIZES, loads);

    await ui.body(actor, docId).click();
    await actor.page.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowDown' : 'Control+End');
    const stalls: number[] = [];
    for (let k = 1; k <= KEYS; k += 1) {
      await resetStall(actor);
      await actor.page.keyboard.press('b');
      await expect.poll(() => bodyLength(actor, docId), { message: 'the keystroke lands at the word’s end', timeout: 60_000 }).toBe(n + k);
      stalls.push(await readStall(actor));
    }
    actor.typed({ docId, field: 'body', text: 'b'.repeat(KEYS), ordered: true });
    keys.push(median(stalls));
    measure.record({ name: `type at the end of a ${n}-char word: median longest stall`, ms: keys[i], budgetMs: null });
    expectLinear('typing at the word’s end', SIZES, keys);
    await ui.waitAcked(actor, docId, 30_000);
  }
});

test('j01-autolink: ordinary URLs, schemeless URLs and emails still become the same links', async ({ actors, stack }) => {
  actors.solo(SOLO);
  const actor = await actors.session(await actors.principal('ada'));
  const docId = await importNote(actor, stack.baseUrl, 'Links', 'Start');
  await actor.goto(`/d/${docId}`);
  await ui.waitLive(actor, docId);
  await actor.observeEditor(docId);
  await ui.typeBody(
    actor,
    docId,
    ' Admin at http://192.168.1.20/admin and the picture example.com/cat.png or the archive https://example.com/report.zip, mail ada@example.invalid or "Ada L"@example.invalid; www.example.com and example.org/docs too. ',
  );
  // Public pages become moss's web pills, not links; everything else the matchers find is a link.
  await expect
    .poll(() => ui.body(actor, docId).locator('a[href]').evaluateAll((links) => links.map((a) => [a.textContent, a.getAttribute('href')])), {
      message: 'the typed URLs and emails are links',
    })
    .toEqual([
      ['http://192.168.1.20/admin', 'http://192.168.1.20/admin'],
      ['example.com/cat.png', 'https://example.com/cat.png'],
      ['https://example.com/report.zip', 'https://example.com/report.zip'],
      ['ada@example.invalid', 'mailto:ada@example.invalid'],
      ['"Ada L"@example.invalid', 'mailto:"Ada L"@example.invalid'],
    ]);
  await ui.waitAcked(actor, docId);
});
