// j02-title (T1.4): the title and the frontmatter are shared state in the doc (A§10.4). A rename reaches every other
// client's title, sidebar row and breadcrumb within 5 s with no keystroke there and no remount; renames from two
// people reach a third in order with nothing stale flashing back; concurrent renames merge, and a title someone is
// typing in is never clobbered; emptying a title and typing it again keeps its filename (an empty title never
// projects); the title takes no focus or input before it binds and takes focus once it does; "+ Note" then typing at
// once makes one note and every key lands or is refused visibly; Rename focuses the bound title; a bare Backspace
// never navigates; and two people adding different properties at once both keep theirs, across a reload.
// Grants to the second and third principals are declared setup through the members API (BUILDPLAN conventions).
import { randomBytes } from 'node:crypto';
import type { Locator, Route } from '@playwright/test';
import type { Actor, Actors } from '../lib/actors.ts';
import {
  APP_STATE_ATTR, DOC_ID_ATTR, DOC_STATE_ATTR, EDITOR_PANE_ATTR, INPUT_REFUSAL_ATTR, NAMES, SIDEBAR_ROW_ATTR,
  SYNC_UNACKED_ATTR, TITLE_BINDING_ATTR, TOP_BAR_ATTR,
} from '../lib/contract.ts';
import { remountSince } from '../lib/detectors.js';
import { grantDoc } from '../lib/grants.ts';
import { expect, test, ui } from '../lib/test.ts';

const BIND_TIMEOUT = 15_000;
const ACK_TIMEOUT = 10_000;
/** PRODUCT (Collaboration): a rename reaches the other person's title, sidebar row and breadcrumb within ~5 s. */
const RENAME_MS = 5_000;
/** The DocDO projects a title at most every 750 ms (A§5.1); this is well past it. */
const PROJECTION_SETTLED_MS = 2_500;
const UNTITLED = 'Untitled';

const token = () => randomBytes(2).toString('hex');

async function openShell(actors: Actors, label: string, { severable = false } = {}): Promise<Actor> {
  const actor = await actors.session(await actors.principal(label), { severable });
  await actor.goto('/');
  await actor.page.locator(`html[${APP_STATE_ATTR}="ready"]`).waitFor({ state: 'attached', timeout: 30_000 });
  return actor;
}

/** Opens the doc by its URL (declared setup: discovery is j01's) and waits for it to bind. */
async function openDoc(actor: Actor, docId: string): Promise<void> {
  actor.observations.clear();
  await actor.goto(`/d/${docId}`);
  await actor.page.locator(`html[${APP_STATE_ATTR}="ready"]`).waitFor({ state: 'attached', timeout: 30_000 });
  await ui.waitLive(actor, docId);
  await actor.observeEditor(docId);
}

const principalOf = (actor: Actor) => {
  if (!actor.principal) throw new Error(`${actor.label} has no principal`);
  return actor.principal;
};

const row = (actor: Actor, docId: string): Locator => actor.page.locator(`[${SIDEBAR_ROW_ATTR}][${DOC_ID_ATTR}="${docId}"]`);
/** The title moss shows in the row (its `title` attribute holds the whole name, untruncated). */
const rowTitle = async (actor: Actor, docId: string): Promise<string | null> =>
  row(actor, docId).locator('span[title]').first().getAttribute('title', { timeout: 1_000 }).catch(() => null);
/** The note's name in the pane's top bar: moss's breadcrumb for a note at the vault root. */
const crumbText = async (actor: Actor, docId: string): Promise<string> =>
  ((await ui.pane(actor, docId).locator(`[${TOP_BAR_ATTR}]`).textContent()) ?? '').trim();

async function expectNoRemount(actor: Actor, docId: string, when: string): Promise<void> {
  const observed = actor.observations.get(docId);
  if (!observed) throw new Error(`${actor.label}: ${docId} is not observed`);
  expect(await actor.page.evaluate(remountSince, { names: NAMES, docId, ...observed }), `${actor.label} ${when}: no editor remount`).toEqual([]);
}

async function waitAcked(actor: Actor, docId: string): Promise<void> {
  await expect(ui.pane(actor, docId), `${actor.label}: the DocDO acks every write`).toHaveAttribute(SYNC_UNACKED_ATTR, '0', { timeout: ACK_TIMEOUT });
}

/** The doc's D1 projection as the vault listing reports it. */
async function listed(actor: Actor, docId: string): Promise<{ title: string; filename: string } | null> {
  const origin = new URL(actor.page.url()).origin;
  const response = await actor.context.request.get(`${origin}/api/workspace`, { timeout: 15_000 });
  if (!response.ok()) throw new Error(`${actor.label}: GET /api/workspace ${response.status()}`);
  const body = (await response.json()) as { docs: { id: string; title: string; filename?: string }[] };
  const doc = body.docs.find((d) => d.id === docId);
  return doc ? { title: doc.title, filename: doc.filename ?? '' } : null;
}

/** Selects the whole title and deletes it, as a person clearing the field does. */
async function clearTitle(actor: Actor, docId: string): Promise<void> {
  await ui.title(actor, docId).click();
  await actor.page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
  await actor.page.keyboard.press('Backspace');
  await expect.poll(() => ui.fieldText(actor, docId, 'title'), { message: `${actor.label}: the title is empty` }).toBe('');
}

/** Starts clocks now and polls each named observation until it holds, recording every latency against `budgetMs`. */
async function untilAll(
  measure: { record(l: { name: string; ms: number; budgetMs: number | null }): void },
  checks: Record<string, () => Promise<boolean>>,
  budgetMs: number,
  timeoutMs = 15_000,
): Promise<void> {
  const start = performance.now();
  const pending = new Map(Object.entries(checks));
  while (pending.size > 0) {
    for (const [name, check] of pending) {
      if (await check()) {
        pending.delete(name);
        measure.record({ name, ms: Math.round(performance.now() - start), budgetMs });
      }
    }
    if (pending.size === 0) break;
    if (performance.now() - start > timeoutMs) throw new Error(`not observed within ${timeoutMs} ms: ${[...pending.keys()].join(', ')}`);
    await new Promise((done) => setTimeout(done, 25));
  }
}

test('j02-title: a rename reaches the other person\'s title, sidebar row and breadcrumb within 5 s, with no keystroke or remount there @p:col-5 @p:tech-2 @evidence', async ({ actors, measure }) => {
  const ada = await openShell(actors, 'ada');
  const ben = await openShell(actors, 'ben');
  await actors.requireDistinct(2);
  const docId = await ui.createNote(ada);
  await grantDoc(ada, docId, principalOf(ben));
  await openDoc(ben, docId);
  await expect(row(ben, docId), "the note Ben opened is in Ben's sidebar").toHaveCount(1);

  const name = `Quarterly plan ${token()}`;
  await ui.typeTitle(ada, docId, name);
  await untilAll(measure, {
    'rename to peer title': async () => (await ui.fieldText(ben, docId, 'title')) === name,
    'rename to peer sidebar row': async () => (await rowTitle(ben, docId)) === name,
    'rename to peer breadcrumb': async () => (await crumbText(ben, docId)).includes(name),
  }, RENAME_MS);
  await expect(ui.title(ben, docId), 'nothing moved focus into Ben\'s title').not.toBeFocused();
  expect(await rowTitle(ada, docId), "Ada's own row follows her title").toBe(name);
  await waitAcked(ada, docId);
  await expectNoRemount(ada, docId, 'after renaming');
  await expectNoRemount(ben, docId, 'after a peer renamed');
  await actors.checkpoint('renamed');
});

interface TitleLog { title: string[]; row: string[]; crumb: string[] }

/** Records every distinct value the doc's title, sidebar row and top-bar name show, from now on. */
const startTitleLog = (actor: Actor, docId: string) =>
  actor.page.evaluate(({ docId, pane, title, row: rowAttr, docIdAttr, topBar }) => {
    const log: TitleLog = { title: [], row: [], crumb: [] };
    (window as unknown as { __mossTitleLog: TitleLog }).__mossTitleLog = log;
    const read = () => {
      const paneEl = document.querySelector(`[${pane}][${docIdAttr}="${docId}"]`);
      const values = {
        title: paneEl?.querySelector(`[${title}]`)?.textContent ?? null,
        row: document.querySelector(`[${rowAttr}][${docIdAttr}="${docId}"] span[title]`)?.getAttribute('title') ?? null,
        crumb: paneEl?.querySelector(`[${topBar}]`)?.textContent?.trim() ?? null,
      };
      for (const key of ['title', 'row', 'crumb'] as const) {
        const value = values[key];
        const list = log[key];
        if (value !== null && list[list.length - 1] !== value) list.push(value);
      }
    };
    read();
    new MutationObserver(read).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
  }, { docId, pane: EDITOR_PANE_ATTR, title: TITLE_BINDING_ATTR, row: SIDEBAR_ROW_ATTR, docIdAttr: DOC_ID_ATTR, topBar: TOP_BAR_ATTR });

const titleLog = (actor: Actor) => actor.page.evaluate(() => (window as unknown as { __mossTitleLog: TitleLog }).__mossTitleLog);

/**
 * Every rename in the leg appends, so each value a surface shows must extend the one before it; a placeholder
 * ("Untitled", or nothing) may show only before the first name.
 */
function nonMonotonic(values: string[]): string[] {
  const problems: string[] = [];
  let previous: string | null = null;
  for (const raw of values) {
    // contenteditable represents a trailing typed space as NBSP until the next character.
    const value = raw.replace(/\u00a0/g, ' ');
    const placeholder = value === '' || value === UNTITLED;
    if (placeholder) {
      if (previous !== null) problems.push(`"${value}" flashed back after "${previous}"`);
      continue;
    }
    if (previous !== null && !value.startsWith(previous)) problems.push(`"${value}" after "${previous}" is not a continuation`);
    previous = value;
  }
  return problems;
}

/** Pins the note from its sidebar row: a metadata change moss refreshes everywhere the note shows. */
async function pinFromSidebar(actor: Actor, docId: string): Promise<void> {
  await row(actor, docId).click({ button: 'right' });
  await actor.page.getByRole('menuitem', { name: 'Pin', exact: true }).click();
  await expect(actor.page.getByRole('menu')).toBeHidden();
}

test('j02-title: renames from Ada and then Ben reach Cy in order, with no stale name flashing back @p:col-5', async ({ actors }) => {
  const ada = await openShell(actors, 'ada');
  const ben = await openShell(actors, 'ben');
  const cy = await openShell(actors, 'cy');
  await actors.requireDistinct(3);
  const docId = await ui.createNote(ada);
  await grantDoc(ada, docId, principalOf(ben));
  await grantDoc(ada, docId, principalOf(cy));
  await openDoc(ben, docId);
  await openDoc(cy, docId);
  await startTitleLog(cy, docId);

  const tok = token();
  const first = `Alpha ${tok}`;
  await ui.typeTitle(ada, docId, first);
  await expect.poll(() => ui.fieldText(cy, docId, 'title'), { message: "Ada's name reaches Cy", timeout: RENAME_MS }).toBe(first);
  await expect.poll(() => ui.fieldText(ben, docId, 'title'), { message: "Ada's name reaches Ben", timeout: RENAME_MS }).toBe(first);
  // A metadata refresh in Cy's tab mid-sequence must not bring back an older name.
  await pinFromSidebar(cy, docId);

  const second = ` beta ${tok}`;
  await ui.typeTitle(ben, docId, second);
  const final = `${first}${second}`;
  await expect.poll(() => ui.fieldText(cy, docId, 'title'), { message: "Ben's rename reaches Cy", timeout: RENAME_MS }).toBe(final);
  await expect.poll(() => rowTitle(cy, docId), { message: "Cy's row shows the final name", timeout: RENAME_MS }).toBe(final);
  await expect.poll(() => crumbText(cy, docId), { message: "Cy's breadcrumb shows the final name", timeout: RENAME_MS }).toContain(final);
  await expect.poll(() => ui.fieldText(ada, docId, 'title'), { message: "Ben's rename reaches Ada", timeout: RENAME_MS }).toBe(final);

  const log = await titleLog(cy);
  expect(log.title.at(-1)).toBe(final);
  expect(nonMonotonic(log.title), `Cy's title went ${JSON.stringify(log.title)}`).toEqual([]);
  expect(nonMonotonic(log.row), `Cy's sidebar row went ${JSON.stringify(log.row)}`).toEqual([]);
  expect(nonMonotonic(log.crumb), `Cy's breadcrumb went ${JSON.stringify(log.crumb)}`).toEqual([]);
  for (const actor of [ada, ben, cy]) await expectNoRemount(actor, docId, 'after two renames');
});

/** The caret's offset in the field, or null when the selection is elsewhere. */
const caretIn = (field: Locator) =>
  field.evaluate((el) => {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || !el.contains(selection.anchorNode)) return null;
    const range = document.createRange();
    range.setStart(el, 0);
    range.setEnd(selection.anchorNode as Node, selection.anchorOffset);
    return range.toString().length;
  });

test('j02-title: concurrent renames merge character by character, and a title someone is typing in is never clobbered @p:col-5', async ({ actors }) => {
  const ada = await openShell(actors, 'ada');
  const ben = await openShell(actors, 'ben');
  await actors.requireDistinct(2);
  const docId = await ui.createNote(ada);
  const tok = token();
  const base = `Roadmap ${tok}`;
  await ui.typeTitle(ada, docId, base);
  await grantDoc(ada, docId, principalOf(ben));
  await openDoc(ben, docId);
  await expect.poll(() => ui.fieldText(ben, docId, 'title'), { timeout: RENAME_MS }).toBe(base);

  // Ada types at the end while Ben types at the start, interleaved key by key.
  await ui.title(ada, docId).click();
  await ada.page.keyboard.press('End');
  await ui.title(ben, docId).click();
  await ben.page.keyboard.press('Home');
  const north = ` north ${tok}`;
  const south = `south ${tok} `;
  await Promise.all([ada.page.keyboard.type(north, { delay: 40 }), ben.page.keyboard.type(south, { delay: 40 })]);
  ada.typed({ docId, field: 'title', text: north, ordered: true });
  ben.typed({ docId, field: 'title', text: south, ordered: false });

  const merged = `${south}${base}${north}`;
  await expect.poll(() => ui.fieldText(ada, docId, 'title'), { message: 'both renames merge on Ada', timeout: RENAME_MS }).toBe(merged);
  await expect.poll(() => ui.fieldText(ben, docId, 'title'), { message: 'both renames merge on Ben', timeout: RENAME_MS }).toBe(merged);
  await expect(ui.title(ben, docId), "Ben's title keeps focus through Ada's edits").toBeFocused();
  expect(await caretIn(ui.title(ben, docId)), "Ben's caret stays right after what Ben typed").toBe(south.length);
  expect(await caretIn(ui.title(ada, docId)), "Ada's caret stays at the end").toBe(merged.length);
  await expectNoRemount(ada, docId, 'after concurrent renames');
  await expectNoRemount(ben, docId, 'after concurrent renames');
});

test('j02-title: emptying a title and typing it again keeps the filename; an empty title never projects @p:note-1 @p:R3', async ({ actors }) => {
  const ada = await openShell(actors, 'ada');
  const ben = await openShell(actors, 'ben');
  await actors.requireDistinct(2);
  const docId = await ui.createNote(ada);
  const tok = token();
  // Typed without recording: the field is cleared below, and only the final name is the doc's (invariant 7).
  await ada.page.keyboard.type(`Filename keeper ${tok}`);
  const filename = `filename-keeper-${tok}.md`;
  await expect.poll(() => listed(ada, docId), { message: 'the DocDO projects the title and its filename', timeout: RENAME_MS })
    .toEqual({ title: `Filename keeper ${tok}`, filename });
  await grantDoc(ada, docId, principalOf(ben));
  await openDoc(ben, docId);

  await clearTitle(ada, docId);
  await waitAcked(ada, docId);
  await expect.poll(() => ui.fieldText(ben, docId, 'title'), { message: 'the empty title reaches Ben', timeout: RENAME_MS }).toBe('');
  await expect.poll(() => rowTitle(ada, docId), { message: 'an empty title shows as Untitled' }).toBe(UNTITLED);
  await ada.page.waitForTimeout(PROJECTION_SETTLED_MS);
  expect(await listed(ada, docId), 'an empty title never projects: the D1 title and filename keep their values')
    .toEqual({ title: `Filename keeper ${tok}`, filename });

  // The same name with one capital: the projection runs (the title column changes) and keeps the filename.
  const again = `Filename Keeper ${tok}`;
  await ui.typeTitle(ada, docId, again);
  await expect.poll(() => listed(ada, docId), { message: 'the retyped title projects', timeout: RENAME_MS }).toEqual({ title: again, filename });
  await expect.poll(() => ui.fieldText(ben, docId, 'title'), { timeout: RENAME_MS }).toBe(again);
});

/** Init script: every moment a title that is not live is editable, focusable or focused. */
function recordClosedTitles({ title }: { title: string }): void {
  const record: { problems: string[]; titles: number } = { problems: [], titles: 0 };
  (window as unknown as { __mossClosedTitles: typeof record }).__mossClosedTitles = record;
  const seen = new WeakSet<Element>();
  const check = (why: string) => {
    for (const field of document.querySelectorAll(`[${title}]`)) {
      if (!seen.has(field)) {
        seen.add(field);
        record.titles += 1;
      }
      const state = field.getAttribute(title);
      if (state === 'live') continue;
      const where = `${why}: a title with ${title}=${state}`;
      if ((field as HTMLElement).isContentEditable) record.problems.push(`${where} is editable`);
      if (field.hasAttribute('tabindex')) record.problems.push(`${where} has a tabindex`);
      if (document.activeElement && field.contains(document.activeElement)) record.problems.push(`${where} holds focus`);
    }
  };
  new MutationObserver(() => check('mutation')).observe(document, { subtree: true, childList: true, attributes: true });
  document.addEventListener('focusin', () => check('focusin'), true);
  document.addEventListener('beforeinput', () => check('beforeinput'), true);
}

const closedTitles = (actor: Actor) =>
  actor.page.evaluate(() => (window as unknown as { __mossClosedTitles?: { problems: string[]; titles: number } }).__mossClosedTitles ?? null);

const refusal = (actor: Actor): Locator => actor.page.locator(`[${INPUT_REFUSAL_ATTR}]`);

/** The doc ids of the open editor panes. */
const paneIds = (actor: Actor): Promise<string[]> =>
  actor.page.locator(`[${EDITOR_PANE_ATTR}]`).evaluateAll((panes, attr) => panes.map((p) => p.getAttribute(attr) ?? ''), DOC_ID_ATTR);

async function newPane(actor: Actor, before: string[]): Promise<string> {
  const fresh = async () => (await paneIds(actor)).filter((id) => id !== '' && !before.includes(id));
  await expect.poll(fresh, { message: `${actor.label}: the new note opens in a pane`, timeout: BIND_TIMEOUT }).toHaveLength(1);
  const [docId] = await fresh();
  return docId ?? '';
}

test('j02-title: the title takes no focus and no input before data-title-binding=live, and takes focus once it is @p:R2 @p:note-6 @p:col-6', async ({ actors }) => {
  const ada = await actors.session(await actors.principal('ada'), { severable: true });
  await ada.context.addInitScript(recordClosedTitles, { title: TITLE_BINDING_ATTR });
  await ada.goto('/');
  await ada.page.locator(`html[${APP_STATE_ATTR}="ready"]`).waitFor({ state: 'attached', timeout: 30_000 });
  await openShell(actors, 'ben');
  await actors.requireDistinct(2);
  const sever = ada.sever;
  if (!sever) throw new Error('ada is not severable');

  // The recorder's control: a title that is open before it is live is flagged.
  const flagged = await ada.page.evaluate(async (attr) => {
    const record = (window as unknown as { __mossClosedTitles: { problems: string[] } }).__mossClosedTitles;
    const from = record.problems.length;
    const field = document.createElement('div');
    field.setAttribute(attr, 'unbound');
    field.contentEditable = 'true';
    field.tabIndex = 0;
    document.body.append(field);
    field.focus();
    await new Promise((done) => setTimeout(done, 0));
    field.remove();
    await new Promise((done) => setTimeout(done, 0));
    return record.problems.slice(from);
  }, TITLE_BINDING_ATTR);
  for (const problem of ['is editable', 'has a tabindex', 'holds focus']) {
    expect(flagged.some((p) => p.endsWith(problem)), `the control: the recorder flags a title that ${problem}`).toBe(true);
  }

  await ada.page.evaluate(() => {
    (window as unknown as { __mossClosedTitles: { problems: string[] } }).__mossClosedTitles.problems.length = 0;
  });

  // The doc socket goes nowhere, so the new note cannot bind until the sever lifts.
  sever.blackhole();
  const before = await paneIds(ada);
  await ada.page.getByRole(ui.NEW_NOTE.role, { name: ui.NEW_NOTE.name }).click();
  const docId = await newPane(ada, before);
  const title = ui.title(ada, docId);
  await expect(title, 'the title is closed while the doc binds').toHaveAttribute(TITLE_BINDING_ATTR, 'unbound');
  await expect(ui.pane(ada, docId)).not.toHaveAttribute(DOC_STATE_ATTR, 'live');
  const box = await title.boundingBox();
  if (!box) throw new Error('the title has no box');
  // The mouse directly: Playwright's click refuses an aria-disabled element.
  await ada.page.mouse.click(box.x + 20, box.y + box.height / 2);
  await expect(title, 'a click gives the closed title no focus').not.toBeFocused();
  await ada.page.keyboard.type('early');
  await expect(refusal(ada), 'keys typed before the bind are refused visibly').toContainText('Opening note');
  expect(await ui.fieldText(ada, docId, 'title'), 'nothing typed before the bind lands').toBe('');

  sever.restore();
  await ui.waitLive(ada, docId);
  await expect(title, 'the bound title takes focus (R2)').toBeFocused({ timeout: BIND_TIMEOUT });
  const name = `Bound at last ${token()}`;
  await ada.page.keyboard.type(name);
  ada.typed({ docId, field: 'title', text: name, ordered: true });
  await waitAcked(ada, docId);
  expect(await ui.fieldText(ada, docId, 'title')).toBe(name);
  const closed = await closedTitles(ada);
  expect(closed?.titles, 'the recorder saw the title').toBeGreaterThan(0);
  expect(closed?.problems, 'no title took focus or input before it was live').toEqual([]);
  await actors.checkpoint('title-live');
});

interface KeyEntry { key: string; prevented: boolean; intoLiveTitle: boolean; notice: string }

/** Init script: each keydown, whether something consumed it, whether it reached a live title, and the notice then. */
function recordKeys({ title, refusalAttr }: { title: string; refusalAttr: string }): void {
  const log: KeyEntry[] = [];
  (window as unknown as { __mossKeys: KeyEntry[] }).__mossKeys = log;
  window.addEventListener(
    'keydown',
    (event) => {
      const target = event.target;
      setTimeout(() => {
        log.push({
          key: event.key,
          prevented: event.defaultPrevented,
          intoLiveTitle: target instanceof Element && target.closest(`[${title}="live"]`) !== null,
          notice: document.querySelector(`[${refusalAttr}]`)?.textContent?.trim() ?? '',
        });
      }, 0);
    },
    true,
  );
}

test('j02-title: on a warm stack, "+ Note" then "hello world" typed at once makes one note, and every key lands in its title or is refused visibly @p:note-6 @p:R2', async ({ actors }) => {
  const ada = await actors.session(await actors.principal('ada'));
  await ada.context.addInitScript(recordKeys, { title: TITLE_BINDING_ATTR, refusalAttr: INPUT_REFUSAL_ATTR });
  await ada.goto('/');
  await ada.page.locator(`html[${APP_STATE_ATTR}="ready"]`).waitFor({ state: 'attached', timeout: 30_000 });
  await openShell(actors, 'ben');
  await actors.requireDistinct(2);
  // Warm: one note already created and bound in this tab.
  await ui.createNote(ada);

  let creates = 0;
  await ada.page.route('**/api/docs', async (route: Route) => {
    if (route.request().method() === 'POST') creates += 1;
    await route.continue();
  });
  const rows = await ada.page.locator(`[${SIDEBAR_ROW_ATTR}]`).count();
  const before = await paneIds(ada);
  await ada.page.evaluate(() => {
    (window as unknown as { __mossKeys: KeyEntry[] }).__mossKeys.length = 0;
  });
  await ada.page.getByRole(ui.NEW_NOTE.role, { name: ui.NEW_NOTE.name }).click();
  const typed = 'hello world';
  await ada.page.keyboard.type(typed);

  const docId = await newPane(ada, before);
  await ui.waitLive(ada, docId);
  await expect(ui.title(ada, docId)).toBeFocused({ timeout: BIND_TIMEOUT });
  await expect.poll(async () => (await ada.page.evaluate(() => (window as unknown as { __mossKeys: KeyEntry[] }).__mossKeys)).length).toBe(typed.length);
  const keys = await ada.page.evaluate(() => (window as unknown as { __mossKeys: KeyEntry[] }).__mossKeys);
  for (const [i, entry] of keys.entries()) {
    const landed = entry.intoLiveTitle && !entry.prevented;
    const refused = entry.prevented && !entry.intoLiveTitle && entry.notice.includes('Opening note');
    expect(landed || refused, `key ${i} "${entry.key}" either lands in the title or is refused visibly: ${JSON.stringify(entry)}`).toBe(true);
  }
  const landed = keys.filter((entry) => entry.intoLiveTitle && !entry.prevented).map((entry) => entry.key).join('');
  expect(typed.endsWith(landed), `the keys that landed are the tail of what was typed ("${landed}")`).toBe(true);
  if (landed) ada.typed({ docId, field: 'title', text: landed, ordered: true });
  await expect.poll(() => ui.fieldText(ada, docId, 'title'), { message: 'the title holds exactly the keys that landed' }).toBe(landed);
  expect(creates, 'Space created no second note').toBe(1);
  await expect(ada.page.locator(`[${SIDEBAR_ROW_ATTR}]`), 'one new row').toHaveCount(rows + 1);
});

test('j02-title: Rename in a row menu focuses the bound title, and the name typed after it lands @p:R2 @p:col-5', async ({ actors }) => {
  const ada = await openShell(actors, 'ada');
  await openShell(actors, 'ben');
  await actors.requireDistinct(2);
  const first = await ui.createNote(ada);
  const second = await ui.createNote(ada);

  // From the other note: Rename opens the note and focuses its title once it binds.
  await row(ada, first).click({ button: 'right' });
  await ada.page.getByRole('menuitem', { name: 'Rename', exact: true }).click();
  await expect(ui.pane(ada, second)).toHaveCount(0, { timeout: BIND_TIMEOUT });
  await ui.waitLive(ada, first);
  ada.expectReconnects(1, first);
  await ada.declareRemount(first);
  await expect(ui.title(ada, first), 'Rename focuses the bound title').toBeFocused({ timeout: BIND_TIMEOUT });
  const name = `Renamed ${token()}`;
  await ada.page.keyboard.type(name);
  ada.typed({ docId: first, field: 'title', text: name, ordered: true });
  await expect.poll(() => rowTitle(ada, first), { message: 'the row takes the new name' }).toBe(name);
  await waitAcked(ada, first);
  await expect.poll(() => listed(ada, first).then((doc) => doc?.title), { message: 'the DocDO projects it', timeout: RENAME_MS }).toBe(name);
});

test('j02-title: a bare Backspace with nothing focused keeps the URL, while the doc binds and once it is live @p:note-6 @macos', async ({ actors }) => {
  const ada = await openShell(actors, 'ada', { severable: true });
  await openShell(actors, 'ben');
  await actors.requireDistinct(2);
  const sever = ada.sever;
  if (!sever) throw new Error('ada is not severable');
  const docId = await ui.createNote(ada);

  ada.observations.clear();
  // A second document load, so history has an entry to go back to; the doc stays binding behind the sever.
  sever.blackhole();
  await ada.goto(`/d/${docId}`);
  await ada.page.locator(`html[${APP_STATE_ATTR}="ready"]`).waitFor({ state: 'attached', timeout: 30_000 });
  await expect(ui.pane(ada, docId)).toHaveAttribute(DOC_STATE_ATTR, 'binding', { timeout: BIND_TIMEOUT });
  const binding = await ui.bareBackspaceNavigates(ada);
  expect(binding.navigated, `while the doc binds, Backspace moved to ${binding.to}`).toBe(false);

  sever.restore();
  await ui.waitLive(ada, docId);
  const live = await ui.bareBackspaceNavigates(ada);
  expect(live.navigated, `on a live doc, Backspace moved to ${live.to}`).toBe(false);
  expect(new URL(ada.page.url()).pathname).toBe(`/d/${docId}`);
});

const PROPERTIES = (actor: Actor): Locator => actor.page.locator('[data-actions-panel-wrapper]');

/** Opens the actions panel's Properties tab, and the add-field row, up to its value field. */
async function addPropertyUpToValue(actor: Actor, key: string, value: string): Promise<Locator> {
  await actor.page.getByRole('button', { name: 'Show actions panel', exact: true }).click();
  await PROPERTIES(actor).getByRole('tab', { name: 'Properties', exact: true }).click();
  const panel = PROPERTIES(actor);
  const empty = panel.getByText('No properties yet', { exact: true });
  if (await empty.isVisible()) await panel.getByRole('button', { name: 'Add field' }).click();
  await panel.locator('section[aria-label="Frontmatter properties"]').getByRole('button', { name: 'Add field', exact: true }).click();
  await panel.getByRole('textbox', { name: 'New field name' }).fill(key);
  await panel.getByRole('textbox', { name: 'New field name' }).press('Enter');
  const field = panel.getByRole('textbox', { name: 'New field value' });
  await field.fill(value);
  return field;
}

async function openProperties(actor: Actor): Promise<Locator> {
  await actor.page.getByRole('button', { name: 'Show actions panel', exact: true }).click();
  await PROPERTIES(actor).getByRole('tab', { name: 'Properties', exact: true }).click();
  return PROPERTIES(actor).locator('section[aria-label="Frontmatter properties"]');
}

test('j02-title: two people add different properties at once, both keep theirs, and the header shows both after a reload @p:tech-2', async ({ actors }) => {
  const ada = await openShell(actors, 'ada');
  const ben = await openShell(actors, 'ben');
  await actors.requireDistinct(2);
  const docId = await ui.createNote(ada);
  await grantDoc(ada, docId, principalOf(ben));
  await openDoc(ben, docId);

  const tok = token();
  const adaValue = `ada-${tok}`;
  const benValue = `friday-${tok}`;
  const adaField = await addPropertyUpToValue(ada, 'reviewer', adaValue);
  const benField = await addPropertyUpToValue(ben, 'deadline', benValue);
  await Promise.all([adaField.press('Enter'), benField.press('Enter')]);

  for (const actor of [ada, ben]) {
    const header = PROPERTIES(actor).locator('section[aria-label="Frontmatter properties"]');
    await expect(header.getByRole('textbox', { name: 'reviewer', exact: true }), `${actor.label} sees Ada's property`).toHaveValue(adaValue, { timeout: RENAME_MS });
    await expect(header.getByRole('textbox', { name: 'deadline', exact: true }), `${actor.label} sees Ben's property`).toHaveValue(benValue, { timeout: RENAME_MS });
  }
  await waitAcked(ada, docId);
  await waitAcked(ben, docId);

  for (const actor of [ada, ben]) {
    actor.observations.clear();
    await actor.page.reload();
    await ui.waitLive(actor, docId);
    const header = await openProperties(actor);
    await expect(header.getByRole('textbox', { name: 'reviewer', exact: true }), `${actor.label}: after reload`).toHaveValue(adaValue);
    await expect(header.getByRole('textbox', { name: 'deadline', exact: true }), `${actor.label}: after reload`).toHaveValue(benValue);
  }
});
