// j17-history (T6.3; A§14): the History view. History in the note's top bar turns the editor pane into glyphdown's
// history page built from moss's DS: the version list with its badges, View (a read-only editor) and Diff vs
// current, Restore through moss's ConfirmationDialog, and VersionHistoryEmptyState with a first named checkpoint.
// A restore while a peer types keeps the peer's insert and a comment's anchor; a failed fetch says so.
import { readFileSync } from 'node:fs';
import type { Locator } from '@playwright/test';
import type { LexicalEditor } from 'lexical';
import type { Actor, Actors } from '../lib/actors.ts';
import {
  BODY_BINDING_ATTR, DOC_STATE_ATTR, HISTORY_BUTTON_ATTR, HISTORY_VIEW_ATTR, LEXICAL_EDITOR_SELECTOR, paneSelector, VERSION_CONTENT_ATTR,
  VERSION_ID_ATTR, VERSION_ROW_ATTR, VERSION_TITLE_ATTR,
} from '../lib/contract.ts';
import { grantDoc } from '../lib/grants.ts';
import { expect, test, ui } from '../lib/test.ts';

const SEED = 'The quick brown fox jumps over the lazy dog.\n\nA second line for the peer.';
const BIND_TIMEOUT = 15_000;
const PEER_TIMEOUT = 10_000;
const COMMENT_KEY = 'ControlOrMeta+Shift+A';
const SUBMIT = 'ControlOrMeta+Enter';
const IMAGE = 'pattern.png';
const IMAGE_MD = `![A test card](assets/${IMAGE})`;

interface Version { id: string; kind: string; name: string | null; createdAt: number; title: string }

async function createNote(actor: Actor, baseUrl: string, title = 'History note', image = false): Promise<string> {
  // The image leads, so the body still ends in text a peer types after.
  const markdown = image ? `${IMAGE_MD}\n\n${SEED}` : SEED;
  const created = await actor.context.request.post('/api/docs', { headers: { origin: baseUrl }, data: { markdown, title } });
  expect(created.status()).toBe(201);
  const id = ((await created.json()) as { doc: { id: string } }).doc.id;
  if (image) {
    // Declared setup: the note's uploaded image, through the asset API, before anyone opens the note.
    const uploaded = await actor.context.request.post(`/api/docs/${id}/assets?filename=${IMAGE}`, {
      headers: { origin: baseUrl, 'content-type': 'image/png' }, data: readFileSync(new URL(`../fixtures/media/${IMAGE}`, import.meta.url)),
    });
    expect(uploaded.status(), 'the image is uploaded').toBe(201);
  }
  return id;
}

/** Ada's note, open and live, with Ben on it at editor (granted as declared setup). */
async function sharedNote(actors: Actors, baseUrl: string, { title, severable = false, image = false }: { title?: string; severable?: boolean; image?: boolean } = {}) {
  const adaPrincipal = await actors.principal('ada');
  const ada = await actors.session(adaPrincipal);
  const id = await createNote(ada, baseUrl, title, image);
  await ada.goto(`/d/${id}`);
  await ui.waitLive(ada, id);
  await ada.observeEditor(id);
  const benPrincipal = await actors.principal('ben');
  await grantDoc(ada, id, benPrincipal, 'editor');
  const ben = await actors.open(benPrincipal, { path: `/d/${id}`, severable });
  await expect(ben.page.locator(paneSelector(id))).toHaveAttribute(DOC_STATE_ATTR, 'live', { timeout: BIND_TIMEOUT });
  await expect(ui.body(ben, id)).toHaveAttribute(BODY_BINDING_ATTR, 'live', { timeout: BIND_TIMEOUT });
  await ben.observeEditor(id);
  await actors.requireDistinct(2);
  return { id, ada, ben, adaPrincipal };
}

const historyButton = (actor: Actor, id: string): Locator => ui.pane(actor, id).locator(`[${HISTORY_BUTTON_ATTR}]`);
const historyView = (actor: Actor, id: string): Locator => ui.pane(actor, id).locator(`[${HISTORY_VIEW_ATTR}]`);
const rows = (actor: Actor, id: string): Locator => historyView(actor, id).locator(`[${VERSION_ROW_ATTR}]`);
const content = (actor: Actor, id: string): Locator => historyView(actor, id).locator(`[${VERSION_CONTENT_ATTR}]`);

/** History from the top bar: the pane shows the view, settled past loading. */
async function openHistory(actor: Actor, id: string): Promise<Locator> {
  await historyButton(actor, id).click();
  const view = historyView(actor, id);
  await expect(view, `${actor.label}: History opens in the editor pane`).toBeVisible();
  await expect(view, `${actor.label}: the versions load`).not.toHaveAttribute(HISTORY_VIEW_ATTR, 'loading', { timeout: BIND_TIMEOUT });
  return view;
}

async function closeHistory(actor: Actor, id: string): Promise<void> {
  await historyView(actor, id).getByRole('button', { name: 'Back to note', exact: true }).click();
  await expect(historyView(actor, id)).toHaveCount(0);
  await expect(ui.body(actor, id), `${actor.label}: the note is back`).toBeVisible();
}

/** Saves a named version from the open view, the empty state's or the list's. */
async function saveNamed(actor: Actor, id: string, name: string): Promise<void> {
  const view = historyView(actor, id);
  await view.getByRole('textbox', { name: 'Version name', exact: true }).fill(name);
  await view.getByRole('button', { name: 'Save version', exact: true }).click();
  await expect(rows(actor, id).filter({ hasText: name }), `${actor.label}: "${name}" is listed`).toHaveCount(1, { timeout: BIND_TIMEOUT });
}

const row = (actor: Actor, id: string, text: string): Locator => rows(actor, id).filter({ hasText: text });

async function listed(actor: Actor, id: string): Promise<Version[]> {
  const response = await actor.context.request.get(`/api/docs/${id}/versions`);
  expect(response.status()).toBe(200);
  return ((await response.json()) as { versions: Version[] }).versions;
}

/** Selects `needle` in an editable body through the editor. */
async function select(actor: Actor, id: string, needle: string): Promise<void> {
  await ui.body(actor, id).evaluate((element, needle) => {
    const editor = (element as HTMLElement & { __lexicalEditor: LexicalEditor }).__lexicalEditor;
    editor.update(() => {
      const node = [...editor.getEditorState()._nodeMap.values()].find((n) => n.getType() === 'text' && n.getTextContent().includes(needle));
      if (!node) throw new Error(`no text node holds "${needle}"`);
      const at = node.getTextContent().indexOf(needle);
      (node as unknown as { select(a: number, b: number): void }).select(at, at + needle.length);
    }, { discrete: true });
  }, needle);
}

/** Puts the caret at the end of the block holding `needle`. */
async function caretAfter(actor: Actor, id: string, needle: string): Promise<void> {
  await ui.body(actor, id).evaluate((element, needle) => {
    const editor = (element as HTMLElement & { __lexicalEditor: LexicalEditor }).__lexicalEditor;
    editor.update(() => {
      const node = [...editor.getEditorState()._nodeMap.values()].find((n) => n.getType() === 'text' && n.getTextContent().includes(needle));
      if (!node) throw new Error(`no text node holds "${needle}"`);
      const end = node.getTextContent().length;
      (node as unknown as { select(a: number, b: number): void }).select(end, end);
    }, { discrete: true });
  }, needle);
}

/** The text each comment highlight paints in this actor's body. */
const painted = (actor: Actor, id: string) => ui.body(actor, id).evaluate((root) => {
  const out: string[] = [];
  CSS.highlights.forEach((highlight, name) => {
    if (!/^moss-comment-\d+$/.test(name)) return;
    highlight.forEach((range) => {
      if (!range.collapsed && root.contains(range.startContainer)) out.push((range as Range).toString());
    });
  });
  return out.sort();
});

async function comment(actor: Actor, text: string): Promise<void> {
  await actor.page.keyboard.press(COMMENT_KEY);
  const composer = actor.page.getByRole('dialog', { name: 'Add comment' });
  await expect(composer, `${actor.label}: Cmd+Shift+A opens the composer`).toBeVisible();
  await actor.page.keyboard.type(text);
  await actor.page.keyboard.press(SUBMIT);
  await expect(composer).toBeHidden();
}

const bodyText = (actor: Actor, id: string) => ui.fieldText(actor, id, 'body');

test('j17-history: an auto version is written within seconds of the last socket closing, and History lists it @p:mean-3', async ({ actors, stack }) => {
  const { id, ada, ben, adaPrincipal } = await sharedNote(actors, stack.baseUrl);
  await ui.typeBody(ben, id, ' Ben edits before leaving.');
  await ui.waitAcked(ben, id);
  await expect.poll(() => bodyText(ada, id), { timeout: PEER_TIMEOUT }).toContain('Ben edits before leaving.');
  const before = (await listed(ada, id)).length;

  // Every actor leaves the doc: the DocDO's last socket closes.
  await ben.page.close();
  await ada.page.close();
  const closedAt = Date.now();
  let auto: Version | undefined;
  await expect.poll(async () => {
    const versions = await listed(ada, id);
    auto = versions.find((version) => version.kind === 'auto');
    return versions.length > before && auto !== undefined;
  }, { message: 'an auto version is written once the last socket closes', timeout: 5_000, intervals: [250] }).toBe(true);
  expect(Date.now() - closedAt, 'within a few seconds of the last socket closing').toBeLessThan(5_000);
  expect(auto!.createdAt, 'written after the close, not before').toBeGreaterThanOrEqual(closedAt - 2_000);

  // Ada comes back: History lists it with its badge, and its content holds Ben's edit.
  const again = await actors.open(adaPrincipal, { path: `/d/${id}`, label: 'ada-again' });
  await ui.waitLive(again, id);
  await openHistory(again, id);
  const autoRow = historyView(again, id).locator(`[${VERSION_ROW_ATTR}][${VERSION_ID_ATTR}="${auto!.id}"]`);
  await expect(autoRow, 'the auto version is listed').toHaveCount(1);
  await expect(autoRow).toHaveAttribute(VERSION_ROW_ATTR, 'auto');
  await expect(autoRow, 'with its Auto badge').toContainText('Auto');
  await autoRow.click();
  await historyView(again, id).getByRole('button', { name: 'View', exact: true }).click();
  await expect(content(again, id), 'the version holds the last edit').toContainText('Ben edits before leaving.');
  await closeHistory(again, id);
});

test('j17-history: a first named checkpoint from the empty state and one from the list; View is read-only, Diff shows the peer\'s change, both with the full title @p:mean-3 @evidence', async ({ actors, stack }) => {
  const longTitle = `${'A long title that keeps going '.repeat(8)}to its very last words`;
  expect(longTitle.length, 'the title is past the 200 characters a version lists with').toBeGreaterThan(220);
  const { id, ada, ben } = await sharedNote(actors, stack.baseUrl, { title: longTitle, image: true });

  const view = await openHistory(ada, id);
  await expect(view, 'no version yet: the empty state').toHaveAttribute(HISTORY_VIEW_ATTR, 'empty');
  await expect(view.getByText('No checkpoints', { exact: true }), "moss's VersionHistoryEmptyState").toBeVisible();
  await actors.checkpoint('history-empty');
  await saveNamed(ada, id, 'First checkpoint');
  await expect(view).toHaveAttribute(HISTORY_VIEW_ATTR, 'ready');
  await expect(row(ada, id, 'First checkpoint')).toHaveAttribute(VERSION_ROW_ATTR, 'named');
  await expect(row(ada, id, 'First checkpoint'), 'with its Named badge').toContainText('Named');

  // Ben changes the note while Ada looks at the version.
  await ui.typeBody(ben, id, ' Ben was here.');
  await ui.waitAcked(ben, id);

  await row(ada, id, 'First checkpoint').click();
  await view.getByRole('button', { name: 'Diff vs current', exact: true }).click();
  const diff = content(ada, id);
  await expect(diff).toHaveAttribute(VERSION_CONTENT_ATTR, 'diff');
  await expect(diff.locator('ins').filter({ hasText: 'Ben was here.' }), "Diff vs current shows Ben's change as added since").toHaveCount(1, { timeout: PEER_TIMEOUT });
  await expect(diff.locator(`[${VERSION_TITLE_ATTR}]`), 'Diff shows the whole title').toHaveText(longTitle);
  await actors.checkpoint('history-diff');

  await view.getByRole('button', { name: 'View', exact: true }).click();
  const shown = content(ada, id);
  await expect(shown).toHaveAttribute(VERSION_CONTENT_ATTR, 'view');
  await expect(shown.locator(`[${VERSION_TITLE_ATTR}]`), 'View shows the whole title').toHaveText(longTitle);
  // moss's editor wrapper carries the Lexical attribute too; the root is the one with contenteditable.
  const editor = shown.locator(`${LEXICAL_EDITOR_SELECTOR}[contenteditable]`);
  await expect(editor, 'View renders the version in a read-only editor').toHaveAttribute('contenteditable', 'false');
  await expect(editor).toContainText('The quick brown fox jumps over the lazy dog.');
  await expect(editor, 'as it was: without Ben\'s later change').not.toContainText('Ben was here.');
  // The version's uploaded image loads from the note's own asset route.
  const image = shown.locator(`img[src*="/assets/${IMAGE}"]`);
  await expect(image, 'View renders the version\'s uploaded image').toHaveCount(1);
  await expect(image, 'from the note\'s asset route').toHaveAttribute('src', new RegExp(`/api/docs/${id}/assets/${IMAGE}`));
  await image.scrollIntoViewIfNeeded();
  await expect.poll(() => image.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0), {
    message: 'the image decodes', timeout: PEER_TIMEOUT,
  }).toBe(true);
  await editor.click();
  await ada.page.keyboard.type('nope');
  await expect(editor, 'typing changes nothing').not.toContainText('nope');
  await actors.checkpoint('history-view');

  // A second named version from the non-empty list.
  await saveNamed(ada, id, 'Second checkpoint');
  await expect(rows(ada, id).filter({ hasText: 'checkpoint' }), 'both named versions, newest first').toHaveText([/Second checkpoint/, /First checkpoint/]);
  await closeHistory(ada, id);
  expect(await bodyText(ada, id), 'the live note was never touched by the view').toContain('Ben was here.');
  expect(await bodyText(ada, id)).not.toContain('nope');
});

test('j17-history: a restore while the peer types keeps the peer\'s insert and the comment\'s anchor @p:mean-3 @evidence', async ({ actors, stack }) => {
  const { id, ada, ben } = await sharedNote(actors, stack.baseUrl, { severable: true });
  await select(ada, id, 'quick brown');
  await comment(ada, 'Keep me through a restore');
  for (const actor of [ada, ben]) await expect.poll(() => painted(actor, id), { message: `${actor.label}: the comment paints`, timeout: PEER_TIMEOUT }).toEqual(['quick brown']);

  await openHistory(ada, id);
  await saveNamed(ada, id, 'Before the change');
  await closeHistory(ada, id);

  // Ada changes the second line after the version; the restore takes it back out.
  await ui.typeBody(ada, id, ' Ada added this.');
  const adaLine = actors.typed.findIndex((entry) => entry.text === ' Ada added this.');
  actors.typed.splice(adaLine, 1);
  await ui.waitAcked(ada, id);
  await expect.poll(() => bodyText(ben, id), { timeout: PEER_TIMEOUT }).toContain('Ada added this.');

  // Ben types in the first line while Ada restores: his frames are in flight until after the restore lands.
  const sever = ben.sever;
  if (!sever) throw new Error('ben is not severable');
  ben.expectReconnects(2, id);
  sever.hold(id);
  await caretAfter(ben, id, 'lazy dog.');
  await ben.page.keyboard.type(' Ben keeps this.');
  ben.typed({ docId: id, field: 'body', text: ' Ben keeps this.', ordered: false });
  await expect(ui.body(ben, id), 'Ben sees his own words').toContainText('Ben keeps this.');
  const serverHas = await ada.context.request.get(`/api/docs/${id}/content`);
  expect(serverHas.status()).toBe(200);
  expect(await serverHas.text(), "Ben's words are still in flight: the server does not have them before the restore").not.toContain('Ben keeps this.');

  const view = await openHistory(ada, id);
  await row(ada, id, 'Before the change').click();
  await view.getByRole('button', { name: 'Restore', exact: true }).click();
  const dialog = ada.page.locator('[data-remote-web-surface-blocking-dialog]');
  await expect(dialog, "Restore asks through moss's ConfirmationDialog").toBeVisible();
  await actors.checkpoint('history-restore-confirm');
  await dialog.getByRole('button', { name: 'Restore', exact: true }).click();
  await expect(historyView(ada, id), 'the restored note is shown').toHaveCount(0, { timeout: BIND_TIMEOUT });
  await expect.poll(() => bodyText(ada, id), { message: "the restore takes out Ada's later change", timeout: PEER_TIMEOUT }).not.toContain('Ada added this.');

  sever.deliverHeld();
  for (const actor of [ada, ben]) {
    await expect.poll(() => bodyText(actor, id), { message: `${actor.label}: Ben's insert survives the restore`, timeout: PEER_TIMEOUT })
      .toContain('The quick brown fox jumps over the lazy dog. Ben keeps this.');
    await expect.poll(() => bodyText(actor, id), { timeout: PEER_TIMEOUT }).not.toContain('Ada added this.');
    await expect.poll(() => painted(actor, id), { message: `${actor.label}: the comment keeps its anchor`, timeout: PEER_TIMEOUT }).toEqual(['quick brown']);
  }
  await ui.waitAcked(ben, id);
  await actors.checkpoint('history-restored');

  // The restore is in the history: its restore point and the auto version after it.
  await openHistory(ada, id);
  const point = historyView(ada, id).locator(`[${VERSION_ROW_ATTR}="restore-point"]`);
  await expect(point, 'the restore point is listed').toHaveCount(1);
  await expect(point, 'with its Restore point badge').toContainText('Restore point');
  await closeHistory(ada, id);
});

test('j17-history: a versions fetch that fails shows an error, never "No checkpoints"; a version left mid-load still loads @p:mean-3', async ({ actors, stack }) => {
  const { id, ada } = await sharedNote(actors, stack.baseUrl);
  const versionsPath = `/api/docs/${id}/versions`;
  ada.expectHttp(429, versionsPath);
  const isVersions = (url: URL) => url.pathname === versionsPath;
  await ada.page.route(isVersions, (route) =>
    route.fulfill({ status: 429, contentType: 'application/json', body: JSON.stringify({ error: 'rate-limited' }) }));
  await historyButton(ada, id).click();
  const view = historyView(ada, id);
  await expect(view, 'the failed fetch is an error state').toHaveAttribute(HISTORY_VIEW_ATTR, 'error', { timeout: BIND_TIMEOUT });
  await expect(view.getByRole('alert'), 'said in words').toContainText('could not be loaded');
  await expect(view.getByText('No checkpoints'), 'never the empty state').toHaveCount(0);
  await expect(view.getByRole('button', { name: 'Save version', exact: true }), 'nothing offers a first checkpoint over an unknown list').toHaveCount(0);

  await ada.page.unroute(isVersions);
  await view.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(view, 'a retry loads the real list').toHaveAttribute(HISTORY_VIEW_ATTR, 'empty', { timeout: BIND_TIMEOUT });
  await expect(view.getByText('No checkpoints', { exact: true })).toBeVisible();

  // Moving between versions while one is still loading never leaves it stuck loading.
  await saveNamed(ada, id, 'Version one');
  await saveNamed(ada, id, 'Version two');
  // Opened afresh, only the newest version is loaded.
  await closeHistory(ada, id);
  const fresh = await openHistory(ada, id);
  await expect(row(ada, id, 'Version two')).toHaveAttribute('aria-pressed', 'true');
  await expect(content(ada, id)).toBeVisible({ timeout: BIND_TIMEOUT });
  const oneVersion = new RegExp(`^${versionsPath}/[^/]+$`);
  const isOneVersion = (url: URL) => oneVersion.test(url.pathname);
  await ada.page.route(isOneVersion, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    await route.continue().catch(() => undefined);
  });
  await row(ada, id, 'Version one').click();
  await row(ada, id, 'Version two').click();
  await row(ada, id, 'Version one').click();
  await expect(row(ada, id, 'Version one')).toHaveAttribute('aria-pressed', 'true');
  await expect(content(ada, id), 'the version comes back loaded, never stuck loading').toContainText('The quick brown fox', { timeout: BIND_TIMEOUT });
  await expect(fresh.getByText('Loading version…')).toHaveCount(0);
  await ada.page.unroute(isOneVersion);
  await closeHistory(ada, id);
});
