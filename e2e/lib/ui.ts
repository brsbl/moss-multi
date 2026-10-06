// UI verbs (S-test §3.3): everything a user does goes through here, located by role, label or a DOM-contract
// attribute, never by position. The reliable typing path is title, then Enter, then body (L§4.20).
import { expect, type Locator } from '@playwright/test';
import type { Actor } from './actors.ts';
import {
  APP_STATE_ATTR, BODY_BINDING_ATTR, DOC_STATE_ATTR, EDITOR_PANE_ATTR, LEXICAL_EDITOR_SELECTOR, NAMES, paneSelector,
  SIDEBAR_ROW_ATTR, SYNC_UNACKED_ATTR, TITLE_BINDING_ATTR,
} from './contract.ts';
import { fieldTexts, remountSince } from './detectors.js';
import type { Principal } from './principals.ts';
import type { SocketEntry } from './telemetry.ts';
import type { Field } from './text.ts';

/** moss's notes-panel button (`NotesListPanel`, aria-label at the pin). */
export const NEW_NOTE = { role: 'button', name: 'Create new note' } as const;

/** The login card (T0.10): one form named for its mode, fields found by their labels. */
export type LoginMode = 'Sign in' | 'Create account';

export const loginForm = (actor: Actor, mode: LoginMode = 'Sign in'): Locator => actor.page.getByRole('form', { name: mode, exact: true });

/** The card is on screen and hydrated: `/login` publishes `data-app-state=ready` once its fields accept input. */
export async function waitForLoginCard(actor: Actor, mode: LoginMode = 'Sign in'): Promise<void> {
  await actor.page.locator(`html[${APP_STATE_ATTR}="ready"]`).waitFor({ state: 'attached', timeout: BIND_TIMEOUT });
  await expect(loginForm(actor, mode), `${actor.label}: the login card shows its ${mode} form`).toBeVisible();
}

/** Signs in through the card; `password` overrides the principal's own (a wrong-password leg). */
export async function signInThroughCard(actor: Actor, principal: Principal, { password = principal.password } = {}): Promise<void> {
  const form = loginForm(actor, 'Sign in');
  await form.getByLabel('Email', { exact: true }).fill(principal.email);
  await form.getByLabel('Password', { exact: true }).fill(password);
  await form.getByRole('button', { name: 'Sign in', exact: true }).click();
}

/** Switches the card to sign-up and creates the principal's account. */
export async function signUpThroughCard(actor: Actor, principal: Principal): Promise<void> {
  await actor.page.getByRole('button', { name: 'Create an account', exact: true }).click();
  const form = loginForm(actor, 'Create account');
  await expect(form).toBeVisible();
  await form.getByLabel('Name', { exact: true }).fill(principal.name);
  await form.getByLabel('Email', { exact: true }).fill(principal.email);
  await form.getByLabel('Password', { exact: true }).fill(principal.password);
  await form.getByRole('button', { name: 'Create account', exact: true }).click();
}

/** Opens moss's Settings; the web build's Account section in it names who is signed in. */
export async function openSettings(actor: Actor): Promise<Locator> {
  await actor.page.getByRole('button', { name: 'Settings', exact: true }).click();
  const dialog = actor.page.getByRole('dialog');
  await expect(dialog, `${actor.label}: Settings opens`).toBeVisible();
  return dialog;
}

/** moss's Settings, then the web build's Account section: Sign out. */
export async function signOutThroughSettings(actor: Actor): Promise<void> {
  await (await openSettings(actor)).getByRole('button', { name: 'Sign out', exact: true }).click();
}

const BIND_TIMEOUT = 15_000;

export const pane = (actor: Actor, docId: string): Locator => actor.page.locator(paneSelector(docId));
export const title = (actor: Actor, docId: string): Locator => pane(actor, docId).locator(`[${TITLE_BINDING_ATTR}]`);
export const body = (actor: Actor, docId: string): Locator => pane(actor, docId).locator(`[${BODY_BINDING_ATTR}]`);

/** Waits until the doc's pane is live with both fields bound. */
export async function waitLive(actor: Actor, docId: string): Promise<void> {
  await actor.page.locator(`${paneSelector(docId)}[${DOC_STATE_ATTR}="live"]`).waitFor({ timeout: BIND_TIMEOUT });
  await pane(actor, docId).locator(`[${TITLE_BINDING_ATTR}="live"]`).waitFor({ timeout: BIND_TIMEOUT });
  await pane(actor, docId).locator(`[${BODY_BINDING_ATTR}="live"]`).waitFor({ timeout: BIND_TIMEOUT });
}

/** The doc ids of the open editor panes, left to right. */
export const paneIds = (actor: Actor): Promise<string[]> =>
  actor.page.locator(`[${EDITOR_PANE_ATTR}]`).evaluateAll((panes, attr) => panes.map((p) => p.getAttribute(attr) ?? ''), NAMES.docId);

/** "+ Note", then the new pane's doc id; the pane binds on its own. With `onlyPane`, it is the one editor pane. */
export async function newNote(actor: Actor, { onlyPane = false } = {}): Promise<string> {
  const before = await paneIds(actor);
  await actor.page.getByRole(NEW_NOTE.role, { name: NEW_NOTE.name }).click();
  const fresh = async () => (await paneIds(actor)).filter((id) => id !== '' && !before.includes(id));
  await expect.poll(fresh, { message: 'the new note opens in an editor pane', timeout: BIND_TIMEOUT }).toHaveLength(1);
  if (onlyPane) await expect(actor.page.locator(`[${EDITOR_PANE_ATTR}]`), 'the new note opens in one editor pane').toHaveCount(1);
  const [docId] = await fresh();
  if (!docId) throw new Error(`${actor.label}: the pane has no ${NAMES.docId}`);
  return docId;
}

/** The pane is live with its body bound. */
export async function waitBodyLive(actor: Actor, docId: string, timeout = BIND_TIMEOUT): Promise<void> {
  await expect(actor.page.locator(paneSelector(docId)), `${actor.label}: the pane goes live`).toHaveAttribute(DOC_STATE_ATTR, 'live', { timeout });
  await expect(body(actor, docId), `${actor.label}: the body binds`).toHaveAttribute(BODY_BINDING_ATTR, 'live', { timeout });
}

/** The pane is live with its body bound `binding`: live, or read-only. */
export async function waitOpen(actor: Actor, docId: string, binding: 'live' | 'readonly'): Promise<void> {
  await expect(actor.page.locator(paneSelector(docId)), `${actor.label}: the pane goes live`).toHaveAttribute(DOC_STATE_ATTR, 'live', { timeout: BIND_TIMEOUT });
  await expect(body(actor, docId), `${actor.label}: the body binds ${binding}`).toHaveAttribute(BODY_BINDING_ATTR, binding, { timeout: BIND_TIMEOUT });
}

/** The server acknowledged every local write. */
export async function waitAcked(actor: Actor, docId: string, timeout = 10_000): Promise<void> {
  await expect(pane(actor, docId), `${actor.label}: the DocDO acks every edit`).toHaveAttribute(SYNC_UNACKED_ATTR, '0', { timeout });
}

/** This document's doc sockets for the note. */
export const socketsFor = (actor: Actor, docId: string): SocketEntry[] =>
  actor.telemetry.sockets.filter((socket) => socket.docId === docId && socket.epoch === actor.telemetry.epoch);

/** Invariant 4's check, now: the body root is the element observed earlier, at the same generation. */
export async function expectNoRemount(actor: Actor, docId: string, when: string): Promise<void> {
  const observed = actor.observations.get(docId);
  if (!observed) throw new Error(`${actor.label}: ${docId} is not observed`);
  expect(await actor.page.evaluate(remountSince, { names: NAMES, docId, ...observed }), `${actor.label} ${when}: no editor remount`).toEqual([]);
}

/**
 * "+ Note": the trigger, then a new pane that binds, then focus in its title (R2). Returns the new doc id and
 * restarts remount observation there (a note switch is a declared remount).
 */
export async function createNote(actor: Actor): Promise<string> {
  const before = new Set(await paneIds(actor));
  await actor.page.getByRole(NEW_NOTE.role, { name: NEW_NOTE.name }).click();
  await actor.page.waitForFunction(
    ({ attr, docIdAttr, known }) =>
      [...document.querySelectorAll(`[${attr}]`)].some((p) => !known.includes(p.getAttribute(docIdAttr) ?? '')),
    { attr: EDITOR_PANE_ATTR, docIdAttr: NAMES.docId, known: [...before] },
    { timeout: BIND_TIMEOUT },
  );
  const docId = (await paneIds(actor)).find((id) => !before.has(id)) ?? '';
  await waitLive(actor, docId);
  await expect(title(actor, docId), 'focus lands in the new title once it is bound').toBeFocused({ timeout: BIND_TIMEOUT });
  await actor.declareRemount(docId);
  return docId;
}

/** The Share dialog's access choices (T1.1); suggester joins in M5. */
export type Access = 'Can view' | 'Can comment' | 'Can edit' | 'Owner';
/** A share link's access (T2.4): never more than edit, and signed-out visitors read at view. */
export type LinkAccess = 'Can view' | 'Can comment' | 'Can edit';

/** Opens Share from the note's top bar and returns the dialog. */
export async function openShare(actor: Actor, docId: string): Promise<Locator> {
  await pane(actor, docId).getByRole('button', { name: 'Share', exact: true }).click();
  const dialog = actor.page.getByRole('dialog', { name: 'Share' });
  await expect(dialog, `${actor.label}: the Share dialog opens`).toBeVisible();
  return dialog;
}

const people = (dialog: Locator): Locator => dialog.getByRole('list', { name: 'People with access' }).getByRole('listitem');

/** A person's row in the open Share dialog's "People with access" list. */
export const accessRow = (dialog: Locator, person: Principal): Locator => people(dialog).filter({ hasText: person.name });

/** A row by email, as the owner sees it: an invite still pending (no email's invite is redeemed until its holder
 * follows it, T2.8) or a member. */
export const inviteRow = (dialog: Locator, email: string): Locator => people(dialog).filter({ hasText: email });

/** The copyable /invite link of a pending invite in the open Share dialog (T2.8), read from its field. */
export async function inviteLink(dialog: Locator, email: string): Promise<string> {
  const field = inviteRow(dialog, email).getByRole('textbox', { name: `Invite link for ${email}`, exact: true });
  await expect(field, `${email}: the pending invite offers its link`).toHaveCount(1);
  const url = await field.inputValue();
  expect(url, 'an /invite link carrying its token').toMatch(/\/invite\/[0-9a-f]{48}$/);
  return url;
}

/** The read-only field holding a live link's URL, and its row. */
export const linkField = (dialog: Locator, access: LinkAccess): Locator => dialog.getByRole('textbox', { name: `${access} link`, exact: true });
export const linkRow = (dialog: Locator, access: LinkAccess): Locator =>
  dialog.getByRole('list', { name: 'Share links' }).getByRole('listitem')
    .filter({ has: dialog.page().getByRole('textbox', { name: `${access} link`, exact: true }) });

/** Creates a link at `access` in the open dialog and returns its URL, read from the dialog (WebKit cannot read the clipboard). */
export async function createLink(dialog: Locator, access: LinkAccess): Promise<string> {
  await dialog.getByRole('radiogroup', { name: 'Link access', exact: true }).getByRole('radio', { name: access, exact: true }).click();
  await dialog.getByRole('button', { name: 'Create link', exact: true }).click();
  const field = linkField(dialog, access);
  await expect(field, `a ${access} link is listed`).toHaveCount(1);
  const url = await field.inputValue();
  expect(url, 'the link carries its token').toMatch(/\?share=[0-9a-f]{48}$/);
  return url;
}

/** A URL's path and query, to open in the app. */
export const pathOf = (url: string): string => {
  const parsed = new URL(url);
  return `${parsed.pathname}${parsed.search}`;
};

/** Adds `email` at `access` in an open Share dialog (note, folder or vault); the dialog stays open. */
export async function shareInDialog(dialog: Locator, email: string, access: Access): Promise<void> {
  await dialog.getByLabel('Email', { exact: true }).fill(email);
  await dialog.getByRole('radiogroup', { name: 'Access', exact: true }).getByRole('radio', { name: access, exact: true }).click();
  await dialog.getByRole('button', { name: 'Share', exact: true }).click();
  await expect(dialog.getByRole('status'), `shared with ${email}`).toHaveText(`Shared with ${email}.`);
}

/** Shares the note with `person` at `access` through the dialog, then waits for their row (by email: it stays a
 * pending invite until they redeem it); the dialog stays open. */
export async function shareWith(actor: Actor, docId: string, person: Principal, access: Access): Promise<Locator> {
  const dialog = await openShare(actor, docId);
  await shareInDialog(dialog, person.email, access);
  await expect(inviteRow(dialog, person.email), `${actor.label}: ${person.label} is listed at "${access}"`).toContainText(access);
  return dialog;
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A folder's row in the notes list (moss's FolderGroup header names it "<name> folder, <n> notes, ..."). */
export const folderRow = (actor: Actor, name: string): Locator =>
  actor.page.getByRole('button', { name: new RegExp(`^${escapeRegExp(name)} folder, `) });

/** Opens a doc from its notes-list row and waits for it to bind. */
export async function openNote(actor: Actor, docId: string): Promise<void> {
  await actor.page.locator(`[${SIDEBAR_ROW_ATTR}][${NAMES.docId}="${docId}"]`).click();
  await waitLive(actor, docId);
  await actor.declareRemount(docId);
}

const toEnd = process.platform === 'darwin' ? 'Meta+ArrowDown' : 'Control+End';

/** Types at the end of the title. With `enter`, presses Enter so focus moves to the body. */
export async function typeTitle(actor: Actor, docId: string, text: string, { enter = false } = {}): Promise<void> {
  const field = title(actor, docId);
  if (!(await field.evaluate((el) => el.contains(document.activeElement)))) await field.click();
  await actor.page.keyboard.press('End');
  await actor.page.keyboard.type(text);
  actor.typed({ docId, field: 'title', text, ordered: true });
  if (enter) await actor.page.keyboard.press('Enter');
}

/** Types at the end of the body. */
export async function typeBody(actor: Actor, docId: string, text: string): Promise<void> {
  await body(actor, docId).click();
  await actor.page.keyboard.press(toEnd);
  await actor.page.keyboard.type(text);
  actor.typed({ docId, field: 'body', text, ordered: true });
}

/** The text one field shows in this actor's pane for the doc. */
export async function fieldText(actor: Actor, docId: string, field: Field): Promise<string> {
  const [first] = await actor.page.evaluate(fieldTexts, { names: NAMES, docId });
  if (!first) throw new Error(`${actor.label}: no pane for ${docId}`);
  return first[field];
}

export const bodyEditor = (actor: Actor, docId: string): Locator => pane(actor, docId).locator(LEXICAL_EDITOR_SELECTOR);

/**
 * The j02 leg (SP15): with no editable focused, a bare Backspace must not navigate. Reports whether it did within
 * `windowMs`; WebKit binds Backspace to history.back() unless the product consumes it.
 */
export async function bareBackspaceNavigates(actor: Actor, windowMs = 1_500): Promise<{ navigated: boolean; from: string; to: string }> {
  const page = actor.page;
  const editable = await page.evaluate(() => {
    (document.activeElement as HTMLElement | null)?.blur();
    const active = document.activeElement as HTMLElement | null;
    return !!active && active !== document.body && (active.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName));
  });
  if (editable) throw new Error(`${actor.label}: an editable still holds focus, so this is not a bare Backspace`);
  const from = page.url();
  await page.keyboard.press('Backspace');
  const navigated = await page.waitForURL((url) => url.href !== from, { timeout: windowMs, waitUntil: 'commit' }).then(
    () => true,
    () => false,
  );
  return { navigated, from, to: page.url() };
}
