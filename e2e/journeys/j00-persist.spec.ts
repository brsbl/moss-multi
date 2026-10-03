// j00-persist (T0.8; the browser half of SP3): "+ Note" binds moss's real editor to the note's DocDO. The body takes
// no focus and no input before it is live, text with spaces, punctuation and "é" survives a reload byte for byte, and
// one doc socket carries the note through a metadata refresh and a pane rerender with no editor remount, and holds
// for 60 s.
import type { Locator } from '@playwright/test';
import type { Actor, Actors } from '../lib/actors.ts';
import {
  APP_STATE_ATTR, BODY_BINDING_ATTR, DOC_ID_ATTR, DOC_STATE_ATTR, EDITOR_GENERATION_ATTR, EDITOR_PANE_ATTR,
  LEXICAL_EDITOR_SELECTOR, NAMES, SIDEBAR_ROW_ATTR, SYNC_UNACKED_ATTR, paneSelector,
} from '../lib/contract.ts';
import { remountSince } from '../lib/detectors.js';
import type { SocketEntry } from '../lib/telemetry.ts';
import { expect, test, ui } from '../lib/test.ts';

const BIND_TIMEOUT = 15_000;
const ACK_TIMEOUT = 10_000;
const TEXT = 'Kept after reload, café & “curly” quotes, two  spaces!';
const LATER = 'Still bound after a minute';

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

/** A signed-in actor on a ready shell, with the closed-body recorder installed before the first document. */
async function openShell(actors: Actors, label: string): Promise<Actor> {
  const actor = await actors.session(await actors.principal(label));
  await actor.context.addInitScript(recordClosedBodies, { body: BODY_BINDING_ATTR, lexical: LEXICAL_EDITOR_SELECTOR });
  await actor.goto('/');
  await actor.page.locator(`html[${APP_STATE_ATTR}="ready"]`).waitFor({ state: 'attached', timeout: 30_000 });
  return actor;
}

/** "+ Note", then the new pane's doc id; the pane binds on its own. */
async function newNote(actor: Actor): Promise<string> {
  await actor.page.getByRole(ui.NEW_NOTE.role, { name: ui.NEW_NOTE.name }).click();
  const pane = actor.page.locator(`[${EDITOR_PANE_ATTR}]`);
  await expect(pane, 'the new note opens in one editor pane').toHaveCount(1, { timeout: BIND_TIMEOUT });
  const docId = await pane.getAttribute(DOC_ID_ATTR);
  if (!docId) throw new Error(`${actor.label}: the pane has no ${DOC_ID_ATTR}`);
  return docId;
}

/** The pane is live with its body bound. */
async function waitBodyLive(actor: Actor, docId: string): Promise<void> {
  await expect(actor.page.locator(paneSelector(docId)), `${actor.label}: the pane goes live`).toHaveAttribute(DOC_STATE_ATTR, 'live', { timeout: BIND_TIMEOUT });
  await expect(ui.body(actor, docId), `${actor.label}: the body binds`).toHaveAttribute(BODY_BINDING_ATTR, 'live', { timeout: BIND_TIMEOUT });
}

/** The server acknowledged every local write. */
async function waitAcked(actor: Actor, docId: string): Promise<void> {
  await expect(ui.pane(actor, docId), `${actor.label}: the DocDO acks every keystroke`).toHaveAttribute(SYNC_UNACKED_ATTR, '0', { timeout: ACK_TIMEOUT });
}

/** This document's doc sockets for the note. */
const socketsFor = (actor: Actor, docId: string): SocketEntry[] =>
  actor.telemetry.sockets.filter((socket) => socket.docId === docId && socket.epoch === actor.telemetry.epoch);

async function expectOneOpenSocket(actor: Actor, docId: string, when: string): Promise<void> {
  const sockets = socketsFor(actor, docId);
  expect(sockets.map((s) => ({ closed: s.closedAt !== null, error: s.error })), `${when}: exactly one doc socket, still open`).toEqual([{ closed: false, error: null }]);
}

/** Invariant 4's check, now: the body root is the element observed earlier, at the same generation. */
async function expectNoRemount(actor: Actor, docId: string, when: string): Promise<void> {
  const observed = actor.observations.get(docId);
  if (!observed) throw new Error(`${actor.label}: ${docId} is not observed`);
  expect(await actor.page.evaluate(remountSince, { names: NAMES, docId, ...observed }), `${when}: no editor remount`).toEqual([]);
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

  const docId = await newNote(ada);
  await waitBodyLive(ada, docId);
  const closed = await closedRecord(ada);
  expect(closed?.roots, 'the recorder saw the body root').toBeGreaterThan(0);
  expect(closed?.problems, 'nothing in the body took focus or input before it was live').toEqual([]);
  await expect(ui.body(ada, docId), '"+ Note" leaves the caret in the bound body').toBeFocused();
  await expect(ui.body(ada, docId).locator('p'), 'the DocDO seeded one empty paragraph').toHaveCount(1);
  await ada.observeEditor(docId);

  await ui.typeBody(ada, docId, TEXT);
  await waitAcked(ada, docId);
  expect(await ui.fieldText(ada, docId, 'body')).toBe(TEXT);

  await pinFromSidebar(ada, docId);
  await expectNoRemount(ada, docId, 'after a metadata refresh');
  await toggleNotesPanel(ada);
  await expectNoRemount(ada, docId, 'after a pane rerender');
  await expectOneOpenSocket(ada, docId, 'through the metadata refresh and the rerender');

  await expect(row(ben, docId), "Ada's note is not in Ben's sidebar").toHaveCount(0);

  ada.observations.clear();
  await ada.page.reload();
  await waitBodyLive(ada, docId);
  expect(await ui.fieldText(ada, docId, 'body'), 'the reloaded body holds the typed bytes').toBe(TEXT);
  expect((await closedRecord(ada))?.problems, 'nothing in the reloaded body took focus or input before it was live').toEqual([]);
  await expectOneOpenSocket(ada, docId, 'after the reload');
  await actors.checkpoint('after-reload');
});

test('j00-persist: one doc socket holds a bound note for 60 s with no remount @slow @p:col-6', async ({ actors }) => {
  test.setTimeout(180_000);
  const ada = await openShell(actors, 'ada');
  await openShell(actors, 'ben');
  await actors.requireDistinct(2);

  const docId = await newNote(ada);
  await waitBodyLive(ada, docId);
  await ada.observeEditor(docId);
  const generation = await ui.body(ada, docId).getAttribute(EDITOR_GENERATION_ATTR);
  expect(generation, 'the body root carries its editor generation').toMatch(/^\d+$/);

  await ada.page.waitForTimeout(60_000);
  await expectOneOpenSocket(ada, docId, 'after 60 s');
  await expectNoRemount(ada, docId, 'after 60 s');

  await ui.typeBody(ada, docId, LATER);
  await waitAcked(ada, docId);
  await expectOneOpenSocket(ada, docId, 'after typing on the held socket');
});
