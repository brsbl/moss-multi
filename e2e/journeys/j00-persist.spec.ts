// j00-persist (T0.8; the browser half of SP3): "+ Note" binds moss's real editor to the note's DocDO. The body takes
// no focus and no input before it is live, text with spaces, punctuation and "é" survives a reload byte for byte, and
// one doc socket carries the note through a metadata refresh and a pane rerender with no editor remount, and holds
// for 60 s. Split view never shows one note in both panes, so the tab never asks for a second session (A§10.1).
// Copy markdown and Note stats read the body as it is now, after local and remote edits. Keys typed while "+ Note" is
// still opening are refused visibly; edits typed while the socket is down outlive a note switch; the link popover's
// highlight never enters the doc; and a pasted or dropped image the server refuses is refused visibly, never dropped
// silently (T3.1). The title binds in j02 (T1.4).
import type { Locator, Page, Route } from '@playwright/test';
import type { Actor, Actors } from '../lib/actors.ts';
import {
  APP_STATE_ATTR, BODY_BINDING_ATTR, DOC_ID_ATTR, EDITOR_GENERATION_ATTR, EDITOR_PANE_ATTR, INPUT_REFUSAL_ATTR,
  LEXICAL_EDITOR_SELECTOR, SIDEBAR_ROW_ATTR, SYNC_UNACKED_ATTR,
} from '../lib/contract.ts';
import { cookieHeader, openDocClient } from '../lib/doc-client.ts';
import { signIn } from '../lib/principals.ts';
import { expect, test, ui } from '../lib/test.ts';

const BIND_TIMEOUT = 15_000;
const ACK_TIMEOUT = 10_000;
const TEXT = 'Kept after reload, café & “curly” quotes, two  spaces!';
const LATER = 'Still bound after a minute';
const SPLIT_TEXT = 'Seen in one pane at a time';

interface ClosedRecord { problems: string[]; roots: number }

/**
 * Init script: from the first paint, every moment a body root that is not live is editable, focusable or focused.
 * A root counts from the moment Lexical renders it, before the binding attribute arrives.
 */
function recordClosedBodies({ body, lexical }: { body: string; lexical: string }): void {
  const record: ClosedRecord = { problems: [], roots: 0 };
  (window as unknown as { __mossClosed: ClosedRecord }).__mossClosed = record;
  const seen = new WeakSet<Element>();
  const check = (why: string) => {
    for (const root of document.querySelectorAll(`${lexical}[contenteditable], [${body}]`)) {
      if (!seen.has(root)) {
        seen.add(root);
        record.roots += 1;
      }
      const state = root.getAttribute(body);
      if (state === 'live') continue;
      const where = `${why}: a body root with ${body}=${state ?? '(none)'}`;
      if (root.getAttribute('contenteditable') === 'true' || (root as HTMLElement).isContentEditable) record.problems.push(`${where} is editable`);
      if (root.hasAttribute('tabindex')) record.problems.push(`${where} has a tabindex`);
      if (document.activeElement && root.contains(document.activeElement)) record.problems.push(`${where} holds focus`);
    }
  };
  new MutationObserver(() => check('mutation')).observe(document, { subtree: true, childList: true, attributes: true });
  document.addEventListener('focusin', () => check('focusin'), true);
  document.addEventListener('beforeinput', () => check('beforeinput'), true);
}

const closedRecord = (actor: Actor) =>
  actor.page.evaluate(() => (window as unknown as { __mossClosed?: ClosedRecord }).__mossClosed ?? null);

/**
 * The recorder's negative control: two roots that are open before they are live, one per selector it watches (a
 * Lexical root with no binding attribute yet, and an unbound one), each editable, focusable and focused for a tick.
 * Returns what the recorder flagged for them.
 */
const recorderFlagsOpenRoots = (actor: Actor): Promise<string[]> =>
  actor.page.evaluate(async ({ body }) => {
    const record = (window as unknown as { __mossClosed: ClosedRecord }).__mossClosed;
    const from = record.problems.length;
    const tick = () => new Promise((done) => setTimeout(done, 0));
    for (const attr of [['data-lexical-editor', 'true'], [body, 'unbound']]) {
      const root = document.createElement('div');
      root.setAttribute(attr[0], attr[1]);
      root.contentEditable = 'true';
      root.tabIndex = 0;
      document.body.append(root);
      root.focus();
      await tick();
      root.remove();
      await tick();
    }
    return record.problems.slice(from);
  }, { body: BODY_BINDING_ATTR });

/** Init script: the page's clipboard writes, recorded (WebKit cannot read the clipboard back). */
function recordCopies(): void {
  const copies: string[] = [];
  (window as unknown as { __mossCopies: string[] }).__mossCopies = copies;
  const writeText = async (text: string) => {
    copies.push(text);
  };
  if (navigator.clipboard) Object.defineProperty(navigator.clipboard, 'writeText', { value: writeText, configurable: true });
  else Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
}

const copies = (actor: Actor): Promise<string[]> =>
  actor.page.evaluate(() => (window as unknown as { __mossCopies?: string[] }).__mossCopies ?? []);

/** More actions → Copy markdown, then the text it wrote to the clipboard. */
async function copyMarkdown(actor: Actor): Promise<string> {
  const before = (await copies(actor)).length;
  await actor.page.getByRole('button', { name: 'More actions', exact: true }).click();
  await actor.page.getByRole('menuitem', { name: 'Copy markdown', exact: true }).click();
  await expect(actor.page.getByRole('menu')).toBeHidden();
  await expect.poll(async () => (await copies(actor)).length, { message: `${actor.label}: Copy markdown writes the clipboard` }).toBe(before + 1);
  return (await copies(actor))[before] ?? '';
}

/** More actions → Note stats, then the word count it shows. */
async function statsWords(actor: Actor): Promise<string> {
  await actor.page.getByRole('button', { name: 'More actions', exact: true }).click();
  await actor.page.getByRole('menuitem', { name: 'Note stats', exact: true }).click();
  const dialog = actor.page.getByRole('dialog', { name: 'Note stats' });
  await expect(dialog, `${actor.label}: Note stats opens`).toBeVisible();
  const words = (await dialog.getByText('Words', { exact: true }).locator('xpath=following-sibling::span[1]').textContent()) ?? '';
  await actor.page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  return words.trim();
}

/** A signed-in actor on a ready shell, with the closed-body recorder and any `scripts` installed before the first document. */
async function openShell(actors: Actors, label: string, ...scripts: (() => void)[]): Promise<Actor> {
  const actor = await actors.session(await actors.principal(label));
  await actor.context.addInitScript(recordClosedBodies, { body: BODY_BINDING_ATTR, lexical: LEXICAL_EDITOR_SELECTOR });
  for (const script of scripts) await actor.context.addInitScript(script);
  await actor.goto('/');
  await actor.page.locator(`html[${APP_STATE_ATTR}="ready"]`).waitFor({ state: 'attached', timeout: 30_000 });
  return actor;
}

async function expectOneOpenSocket(actor: Actor, docId: string, when: string): Promise<void> {
  const sockets = ui.socketsFor(actor, docId);
  expect(sockets.map((s) => ({ closed: s.closedAt !== null, error: s.error })), `${when}: exactly one doc socket, still open`).toEqual([{ closed: false, error: null }]);
}

const row = (actor: Actor, docId: string): Locator => actor.page.locator(`[${SIDEBAR_ROW_ATTR}][${DOC_ID_ATTR}="${docId}"]`);

/** Pins the note from its sidebar row: a metadata change to the open note that moss refreshes everywhere it shows. */
async function pinFromSidebar(actor: Actor, docId: string): Promise<void> {
  await row(actor, docId).click({ button: 'right' });
  await actor.page.getByRole('menuitem', { name: 'Pin', exact: true }).click();
  await expect(actor.page.getByRole('menu')).toBeHidden();
  await row(actor, docId).click({ button: 'right' });
  await expect(actor.page.getByRole('menuitem', { name: 'Unpin', exact: true }), 'the note is pinned').toBeVisible();
  await actor.page.keyboard.press('Escape');
  await expect(actor.page.getByRole('menu')).toBeHidden();
}

/** Opens the note in the split (right) pane from its sidebar row, as moss's notes list does. */
async function openInSplit(actor: Actor, docId: string): Promise<void> {
  await row(actor, docId).click({ button: 'right' });
  await actor.page.getByRole('menuitem', { name: 'Open in Split Tab', exact: true }).click();
  await expect(actor.page.getByRole('menu')).toBeHidden();
  await ui.waitBodyLive(actor, docId);
}

/** Focuses the pane showing `paneDocId` by clicking its body, then opens `docId` from the sidebar into that pane. */
async function openFromSidebarIn(actor: Actor, paneDocId: string, docId: string): Promise<void> {
  await ui.body(actor, paneDocId).click();
  await row(actor, docId).click();
  await expect(ui.pane(actor, paneDocId), `${actor.label}: the focused pane leaves its note`).toHaveCount(0, { timeout: BIND_TIMEOUT });
  await ui.waitBodyLive(actor, docId);
}

/** Moss's app shell is still mounted: an error that escapes the editor unmounts it ("Something went wrong!"). */
async function expectAppUp(actor: Actor, when: string): Promise<void> {
  await expect(actor.page.locator('[data-moss-app-shell]'), `${when}: moss's app is still up`).toHaveCount(1);
}

/** Hides the notes panel and brings it back: two rerenders of the open pane with changed props. */
async function toggleNotesPanel(actor: Actor): Promise<void> {
  await actor.page.getByRole('button', { name: 'Hide notes panel' }).click();
  await actor.page.getByRole('button', { name: 'Show notes panel' }).click();
  await expect(actor.page.getByRole('button', { name: 'Create new note' })).toBeVisible();
}

test('j00-persist: "+ Note" binds the editor; typed text survives a reload byte for byte on one socket @p:col-6 @p:tech-1 @p:R2 @evidence', async ({ actors }) => {
  const ada = await openShell(actors, 'ada');
  const ben = await openShell(actors, 'ben');
  await actors.requireDistinct(2);
  const flagged = await recorderFlagsOpenRoots(ben);
  for (const problem of ['is editable', 'has a tabindex', 'holds focus']) {
    for (const root of ['=(none)', '=unbound']) {
      expect(flagged.filter((p) => p.includes(root) && p.endsWith(problem)), `the control: the recorder flags a root with ${BODY_BINDING_ATTR}${root} that ${problem}`).not.toEqual([]);
    }
  }

  const docId = await ui.newNote(ada, { onlyPane: true });
  await ui.waitBodyLive(ada, docId);
  const closed = await closedRecord(ada);
  expect(closed?.roots, 'the recorder saw the body root').toBeGreaterThan(0);
  expect(closed?.problems, 'nothing in the body took focus or input before it was live').toEqual([]);
  await expect(ui.title(ada, docId), '"+ Note" leaves the caret in the bound title (R2)').toBeFocused();
  await expect(ui.body(ada, docId).locator('p'), 'the DocDO seeded one empty paragraph').toHaveCount(1);
  await ada.observeEditor(docId);

  await ui.typeBody(ada, docId, TEXT);
  await ui.waitAcked(ada, docId);
  expect(await ui.fieldText(ada, docId, 'body')).toBe(TEXT);

  await pinFromSidebar(ada, docId);
  await ui.expectNoRemount(ada, docId, 'after a metadata refresh');
  await toggleNotesPanel(ada);
  await ui.expectNoRemount(ada, docId, 'after a pane rerender');
  await expectOneOpenSocket(ada, docId, 'through the metadata refresh and the rerender');

  await expect(row(ben, docId), "Ada's note is not in Ben's sidebar").toHaveCount(0);

  ada.observations.clear();
  await ada.page.reload();
  await ui.waitBodyLive(ada, docId);
  expect(await ui.fieldText(ada, docId, 'body'), 'the reloaded body holds the typed bytes').toBe(TEXT);
  expect((await closedRecord(ada))?.problems, 'nothing in the reloaded body took focus or input before it was live').toEqual([]);
  await expectOneOpenSocket(ada, docId, 'after the reload');
  await actors.checkpoint('after-reload');
});

const FIRST = 'Copied on first use';
const SECOND = ' then edited here';
const REMOTE = ' and a peer wrote this';

test('j00-persist: Copy markdown and Note stats read the bound body as it is now, after local and remote edits @p:tech-1', async ({ actors, stack }) => {
  const ada = await openShell(actors, 'ada', recordCopies);
  await openShell(actors, 'ben');
  await actors.requireDistinct(2);

  const docId = await ui.newNote(ada, { onlyPane: true });
  await ui.waitBodyLive(ada, docId);
  await ui.typeBody(ada, docId, FIRST);
  await ui.waitAcked(ada, docId);
  expect(await copyMarkdown(ada), 'the first copy holds the body').toContain(FIRST);

  await ui.typeBody(ada, docId, SECOND);
  await ui.waitAcked(ada, docId);
  expect.soft(await copyMarkdown(ada), 'a copy after an edit holds the edit').toContain(`${FIRST}${SECOND}`);

  // A peer's edit arrives through the binding, not the keyboard. The writer is Ada's own protocol client.
  if (!ada.principal) throw new Error('ada has no principal');
  const writer = await openDocClient(stack.baseUrl, docId, cookieHeader(await signIn(stack.baseUrl, ada.principal)));
  try {
    await writer.synced;
    writer.type(REMOTE);
    await writer.acked();
  } finally {
    writer.close();
  }
  const all = `${FIRST}${SECOND}${REMOTE}`;
  await expect.poll(() => ui.fieldText(ada, docId, 'body'), { message: "the peer's edit reaches the pane", timeout: BIND_TIMEOUT }).toBe(all);
  expect.soft(await copyMarkdown(ada), "a copy after a peer's edit holds it").toContain(all);
  expect.soft(await statsWords(ada), 'Note stats counts the words in the body').toBe(String(all.split(/\s+/).filter(Boolean).length));
});

test('j00-persist: one doc socket holds a bound note for 60 s with no remount @slow @p:col-6', async ({ actors }) => {
  test.setTimeout(180_000);
  const ada = await openShell(actors, 'ada');
  await openShell(actors, 'ben');
  await actors.requireDistinct(2);

  const docId = await ui.newNote(ada, { onlyPane: true });
  await ui.waitBodyLive(ada, docId);
  await ada.observeEditor(docId);
  const generation = await ui.body(ada, docId).getAttribute(EDITOR_GENERATION_ATTR);
  expect(generation, 'the body root carries its editor generation').toMatch(/^\d+$/);

  await ada.page.waitForTimeout(60_000);
  await expectOneOpenSocket(ada, docId, 'after 60 s');
  await ui.expectNoRemount(ada, docId, 'after 60 s');

  await ui.typeBody(ada, docId, LATER);
  await ui.waitAcked(ada, docId);
  await expectOneOpenSocket(ada, docId, 'after typing on the held socket');
});

test('j00-persist: split navigation never shows one note in both panes, and the note stays live on one socket @p:col-6', async ({ actors }) => {
  const ada = await openShell(actors, 'ada');
  await openShell(actors, 'ben');
  await actors.requireDistinct(2);

  const a = await ui.newNote(ada, { onlyPane: true });
  await ui.waitBodyLive(ada, a);
  const b = await ui.newNote(ada, { onlyPane: true });
  await ui.waitBodyLive(ada, b);
  await ui.typeBody(ada, b, SPLIT_TEXT);
  await ui.waitAcked(ada, b);
  const c = await ui.newNote(ada, { onlyPane: true });
  await ui.waitBodyLive(ada, c);
  // Each note switch closes the pane's socket before the next opens: B binds in three panes over the leg, A in two.
  ada.expectReconnects(2, b);
  ada.expectReconnects(1, a);

  // Left C, right B. The right pane moves to A, so its history is B, A; then the left pane moves to B.
  await openInSplit(ada, b);
  await openFromSidebarIn(ada, b, a);
  await openFromSidebarIn(ada, c, b);
  await expectAppUp(ada, 'with B left and A right');
  expect([...(await ui.paneIds(ada))].sort(), 'B and A, each in one pane').toEqual([a, b].sort());

  // The right pane's back leads to B, which the left pane shows. Moss's rule closes the split instead.
  await ui.pane(ada, a).getByRole('button', { name: 'Go back' }).click();
  await expect(ui.pane(ada, a), 'the split closes rather than show B twice').toHaveCount(0, { timeout: BIND_TIMEOUT });
  await expectAppUp(ada, "after the split's back reached the left pane's note");
  expect(await ui.paneIds(ada), 'one pane, showing B').toEqual([b]);
  await ui.waitBodyLive(ada, b);
  expect(await ui.fieldText(ada, b, 'body'), 'B still shows its text').toBe(SPLIT_TEXT);
  expect(ui.socketsFor(ada, b).filter((socket) => socket.closedAt === null), 'B holds one open doc socket').toHaveLength(1);
});

const refusal = (page: Page): Locator => page.locator(`[${INPUT_REFUSAL_ATTR}]`);

test('j00-persist: keys typed while "+ Note" is still opening are refused visibly, never swallowed, and make no second note @p:R2', async ({ actors }) => {
  const ada = await openShell(actors, 'ada');
  await openShell(actors, 'ben');
  await actors.requireDistinct(2);

  await expect(ada.page.locator(`[${EDITOR_PANE_ATTR}]`), 'the first note starts on an empty canvas').toHaveCount(0);
  // The create request is held, so the keys land between the click and the bind on every run.
  let creates = 0;
  let release: () => void = () => undefined;
  const held = new Promise<void>((done) => {
    release = done;
  });
  await ada.page.route('**/api/docs', async (route: Route) => {
    if (route.request().method() !== 'POST') return route.continue();
    creates += 1;
    await held;
    await route.continue();
  });

  const before = await ui.paneIds(ada);
  const rows = await ada.page.locator(`[${SIDEBAR_ROW_ATTR}]`).count();
  const trigger = ada.page.getByRole(ui.NEW_NOTE.role, { name: ui.NEW_NOTE.name });
  await trigger.click();
  await expect.poll(() => creates, { message: '"+ Note" asks for one note' }).toBe(1);
  await expect(trigger, 'the trigger lets go of focus, so Space or Enter cannot press it again').not.toBeFocused();
  // Printable keys, Space and Enter while the note is still opening.
  await ada.page.keyboard.type('Quick ');
  await ada.page.keyboard.press('Enter');
  await expect(refusal(ada.page), 'the refused keys are announced').toContainText('Opening note');
  await expect(refusal(ada.page), 'the announcement is visible on the empty canvas').toBeVisible();
  expect(creates, 'Space and Enter create no second note').toBe(1);

  release();
  const fresh = async () => (await ui.paneIds(ada)).filter((id) => id !== '' && !before.includes(id));
  await expect.poll(fresh, { message: 'the new note opens', timeout: BIND_TIMEOUT }).toHaveLength(1);
  const [docId] = await fresh();
  if (!docId) throw new Error('no new pane');
  await ui.waitBodyLive(ada, docId);
  await expect(ui.title(ada, docId), 'the bound title takes focus (R2)').toBeFocused();
  const after = 'brown fox';
  await ada.page.keyboard.type(after);
  ada.typed({ docId, field: 'title', text: after, ordered: true });
  await ui.waitAcked(ada, docId);
  expect(await ui.fieldText(ada, docId, 'title'), 'keys after the bind land; refused keys never reach the doc').toBe(after);
  expect(await ui.fieldText(ada, docId, 'body'), 'the body holds none of them').toBe('');
  expect(creates, 'one note was created').toBe(1);
  await expect(ada.page.locator(`[${SIDEBAR_ROW_ATTR}]`), 'one new row').toHaveCount(rows + 1);
});

const ONLINE = 'Typed while online';
const OFFLINE = ' and kept through an outage';

test('j00-persist: edits typed while the doc socket is down outlive a switch to another note and reach the server @p:col-6', async ({ actors }) => {
  const ada = await actors.session(await actors.principal('ada'), { severable: true });
  await ada.goto('/');
  await ada.page.locator(`html[${APP_STATE_ATTR}="ready"]`).waitFor({ state: 'attached', timeout: 30_000 });
  await openShell(actors, 'ben');
  await actors.requireDistinct(2);
  const sever = ada.sever;
  if (!sever) throw new Error('ada is not severable');

  const b = await ui.newNote(ada, { onlyPane: true });
  await ui.waitBodyLive(ada, b);
  const a = await ui.newNote(ada, { onlyPane: true });
  await ui.waitBodyLive(ada, a);
  await ui.typeBody(ada, a, ONLINE);
  await ui.waitAcked(ada, a);

  // The socket drops, and the client reconnects into a sever that delivers nothing until restore.
  sever.reset();
  await ui.typeBody(ada, a, OFFLINE);
  await expect(ui.pane(ada, a), 'the offline edit is unacked').toHaveAttribute(SYNC_UNACKED_ATTR, '1');
  // A: the first socket, the reconnect into the sever, then the reopen. B: its first, then one held until restore.
  ada.expectReconnects(2, a);
  ada.expectReconnects(1, b);

  await row(ada, b).click();
  await expect(ui.pane(ada, a), 'A leaves the pane').toHaveCount(0, { timeout: BIND_TIMEOUT });
  sever.restore();
  await ui.waitBodyLive(ada, b);
  // The edits reach the DocDO before A's last socket closes.
  await expect
    .poll(() => ui.socketsFor(ada, a).every((socket) => socket.closedAt !== null), { message: "A's session lets go once its edits are acked", timeout: 20_000 })
    .toBe(true);

  await row(ada, a).click();
  await ui.waitBodyLive(ada, a);
  expect(await ui.fieldText(ada, a, 'body'), 'A reopens with the text typed offline').toBe(`${ONLINE}${OFFLINE}`);
  await ada.page.reload();
  await ui.waitBodyLive(ada, a);
  expect(await ui.fieldText(ada, a, 'body'), 'and the server kept it').toBe(`${ONLINE}${OFFLINE}`);
});

const ACKED = 'Acked before the drop';
const LOST_ACK = ' whose ack was lost';

test('j00-persist: an edit whose ack is lost with its socket is acked after the reconnect, so the note still reopens after a switch @p:col-6 @p:R10', async ({ actors }) => {
  const ada = await actors.session(await actors.principal('ada'), { severable: true });
  await ada.goto('/');
  await ada.page.locator(`html[${APP_STATE_ATTR}="ready"]`).waitFor({ state: 'attached', timeout: 30_000 });
  await openShell(actors, 'ben');
  await actors.requireDistinct(2);
  const sever = ada.sever;
  if (!sever) throw new Error('ada is not severable');

  const b = await ui.newNote(ada, { onlyPane: true });
  await ui.waitBodyLive(ada, b);
  const a = await ui.newNote(ada, { onlyPane: true });
  await ui.waitBodyLive(ada, a);
  await ui.typeBody(ada, a, ACKED);
  await ui.waitAcked(ada, a);

  // The DocDO takes the edit (one input, one update), and its ack is lost as the socket drops.
  sever.loseAcks();
  await ada.page.keyboard.insertText(LOST_ACK);
  ada.typed({ docId: a, field: 'body', text: LOST_ACK, ordered: true });
  await expect.poll(() => sever.census().acksLost, { message: 'the DocDO acked the edit, and the ack was lost', timeout: ACK_TIMEOUT }).toBeGreaterThan(0);
  await expect(ui.pane(ada, a), 'the edit is still unacked').toHaveAttribute(SYNC_UNACKED_ATTR, '1');
  sever.reset();
  sever.restore();
  // A: the first socket, the reconnect, then the reopen. B: its first, then the reopen.
  ada.expectReconnects(2, a);
  ada.expectReconnects(1, b);
  await expect(ui.pane(ada, a), "the reconnect's ack covers the edit the server already held").toHaveAttribute(SYNC_UNACKED_ATTR, '0', { timeout: ACK_TIMEOUT });

  await row(ada, b).click();
  await expect(ui.pane(ada, a), 'A leaves the pane').toHaveCount(0, { timeout: BIND_TIMEOUT });
  await ui.waitBodyLive(ada, b);
  await row(ada, a).click();
  await ui.waitBodyLive(ada, a);
  expect(await ui.fieldText(ada, a, 'body'), 'A reopens with every edit').toBe(`${ACKED}${LOST_ACK}`);
});

const LINKED = 'alpha bravo charlie';

test("j00-persist: the link popover's highlight is paint, never a doc write: a reload leaves no mark @p:tech-1", async ({ actors }) => {
  const ada = await openShell(actors, 'ada');
  await openShell(actors, 'ben');
  await actors.requireDistinct(2);
  const docId = await ui.newNote(ada, { onlyPane: true });
  await ui.waitBodyLive(ada, docId);
  await ui.typeBody(ada, docId, LINKED);
  await ui.waitAcked(ada, docId);

  for (let i = 0; i < 'charlie'.length; i += 1) await ada.page.keyboard.press('Shift+ArrowLeft');
  await ada.page.getByRole('button', { name: 'Add link' }).click();
  await expect(ada.page.getByPlaceholder('Paste or type a URL...'), 'the link popover opens').toBeVisible();
  await expect
    .poll(
      () => ada.page.evaluate(() => (CSS as unknown as { highlights?: { has: (name: string) => boolean } }).highlights?.has('link-selection') ?? null),
      { message: 'the selected text is painted as a CSS highlight while the popover holds focus' },
    )
    .toBe(true);
  const marks = () => ui.body(ada, docId).locator('[style*="--link-selection"]').count();
  expect(await marks(), 'no style mark in the body').toBe(0);
  await expect(ui.pane(ada, docId), 'the popover writes nothing to the doc').toHaveAttribute(SYNC_UNACKED_ATTR, '0');

  // Leaving with the popover still open (a reload) must leave the doc as it was.
  await ada.page.reload();
  await ui.waitBodyLive(ada, docId);
  expect(await marks(), 'no mark after reload').toBe(0);
  expect(await ui.fieldText(ada, docId, 'body')).toBe(LINKED);
});

/** A 1x1 PNG, as a screenshot paste or a Finder drop carries one. */
const PNG = [
  137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 31, 21, 196, 137, 0, 0, 0,
  13, 73, 68, 65, 84, 120, 156, 99, 248, 15, 4, 0, 9, 251, 3, 253, 167, 98, 133, 112, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130,
];

test('j00-persist: a pasted image or video, or a dropped image, that the server refuses is refused visibly, and the body is unchanged @p:tech-7', async ({ actors }) => {
  const ada = await openShell(actors, 'ada');
  await openShell(actors, 'ben');
  await actors.requireDistinct(2);
  const docId = await ui.newNote(ada, { onlyPane: true });
  await ui.waitBodyLive(ada, docId);
  const text = 'An image would go here';
  await ui.typeBody(ada, docId, text);
  await ui.waitAcked(ada, docId);
  // The server refuses every upload with its own sentence (an over-cap file, say).
  const REFUSED = 'That file is larger than this note accepts.';
  const uploads = /\/api\/docs\/[^/]+\/assets$/;
  ada.expectHttp(413, uploads);
  await ada.page.route((url) => uploads.test(url.pathname), (route) =>
    route.fulfill({ status: 413, contentType: 'application/json', body: JSON.stringify({ error: 'too-large', message: REFUSED }) }));

  // A screenshot paste, then a copied video file (a browser File has no Electron `path`).
  for (const file of [{ name: 'screenshot.png', type: 'image/png' }, { name: 'clip.mp4', type: 'video/mp4' }]) {
    const pasted = await ui.body(ada, docId).evaluate((root, { bytes, name, type }) => {
      const data = new DataTransfer();
      data.items.add(new File([new Uint8Array(bytes)], name, { type }));
      const event = new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true });
      root.dispatchEvent(event);
      return event.defaultPrevented;
    }, { bytes: PNG, ...file });
    expect(pasted, `the editor takes the pasted ${file.type}`).toBe(true);
    await expect(refusal(ada.page), `a pasted ${file.type} is refused visibly`).toContainText(REFUSED);
    await expect(refusal(ada.page), 'the notice clears on its own').toHaveText('', { timeout: 10_000 });
  }

  const box = await ui.body(ada, docId).boundingBox();
  if (!box) throw new Error('the body has no box');
  const dropped = await ui.body(ada, docId).evaluate((root, { bytes, x, y }) => {
    const data = new DataTransfer();
    data.items.add(new File([new Uint8Array(bytes)], 'photo.png', { type: 'image/png' }));
    const init = { dataTransfer: data, clientX: x, clientY: y, bubbles: true, cancelable: true };
    root.dispatchEvent(new DragEvent('dragenter', init));
    root.dispatchEvent(new DragEvent('dragover', init));
    const event = new DragEvent('drop', init);
    root.dispatchEvent(event);
    return event.defaultPrevented;
  }, { bytes: PNG, x: box.x + 20, y: box.y + box.height / 2 });
  expect(dropped, 'the editor takes the dropped image').toBe(true);
  // The paste's notice has cleared, so this one is the drop's own.
  await expect(refusal(ada.page), 'a dropped image is refused visibly').toContainText(REFUSED);

  await ui.waitAcked(ada, docId);
  expect(await ui.body(ada, docId).locator('img, video, [data-lexical-decorator]').count(), 'no media node lands').toBe(0);
  expect(await ui.fieldText(ada, docId, 'body'), 'the body is unchanged').toBe(text);
});
