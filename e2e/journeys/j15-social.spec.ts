// j15-social (T4.4; docs/design/comments.md §12): the social half of comments. Reactions toggle per person, an
// @mention and a reply reach the bell, edit and delete are the author's alone (a raw delete by anyone else is 403), and
// deleting a root that has replies keeps the thread anchored under the promoted oldest reply.
import type { LexicalEditor } from 'lexical';
import type { Locator } from '@playwright/test';
import type { Actor, Actors } from '../lib/actors.ts';
import { BODY_BINDING_ATTR, DOC_STATE_ATTR, paneSelector } from '../lib/contract.ts';
import { grantDoc, type GrantRole } from '../lib/grants.ts';
import type { Principal } from '../lib/principals.ts';
import { expect, test, ui } from '../lib/test.ts';

const SEED = 'The quick brown fox jumps over the lazy dog.\n\nA second line for the peer.';
const BIND_TIMEOUT = 15_000;
const PEER_TIMEOUT = 10_000;
const COMMENT_KEY = 'ControlOrMeta+Shift+A';
const SUBMIT = 'ControlOrMeta+Enter';

interface Note { id: string; ada: Actor; adaPrincipal: Principal }

async function sharedNote(actors: Actors, baseUrl: string): Promise<Note> {
  const adaPrincipal = await actors.principal('ada');
  const ada = await actors.session(adaPrincipal);
  const created = await ada.context.request.post('/api/docs', { headers: { origin: baseUrl }, data: { markdown: SEED } });
  expect(created.status()).toBe(201);
  const { doc: { id } } = await created.json() as { doc: { id: string } };
  await ada.goto(`/d/${id}`);
  await ui.waitLive(ada, id);
  await ada.observeEditor(id);
  return { id, ada, adaPrincipal };
}

/** A second person on the note at `role`, granted as declared setup (the promise here is comments, not sharing). */
async function peer(actors: Actors, note: Note, label: string, role: GrantRole): Promise<{ actor: Actor; principal: Principal }> {
  const principal = await actors.principal(label);
  await grantDoc(note.ada, note.id, principal, role);
  const actor = await actors.open(principal, { path: `/d/${note.id}` });
  await expect(actor.page.locator(paneSelector(note.id)), `${label}: the pane goes live`).toHaveAttribute(DOC_STATE_ATTR, 'live', { timeout: BIND_TIMEOUT });
  await expect(ui.body(actor, note.id)).toHaveAttribute(BODY_BINDING_ATTR, role === 'editor' ? 'live' : 'readonly', { timeout: BIND_TIMEOUT });
  await actor.observeEditor(note.id);
  return { actor, principal };
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

/** Cmd+Shift+A over the current selection, then the composer: type, submit. */
async function comment(actor: Actor, text: string): Promise<void> {
  await actor.page.keyboard.press(COMMENT_KEY);
  const composer = actor.page.getByRole('dialog', { name: 'Add comment' });
  await expect(composer, `${actor.label}: Cmd+Shift+A opens the composer`).toBeVisible();
  await actor.page.keyboard.type(text);
  await actor.page.keyboard.press(SUBMIT);
  await expect(composer).toBeHidden();
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

const gutter = (actor: Actor) => actor.page.locator('[data-comment-gutter-id]');
const thread = (actor: Actor) => actor.page.locator('.moss-comment-popover');
const message = (actor: Actor, text: string) => thread(actor).locator('[data-comment-message]').filter({ hasText: text });
const bell = (actor: Actor, docId: string): Locator => ui.pane(actor, docId).getByRole('button', { name: /^Notifications/ });

/** Opens the thread through its gutter icon, once the peer's comment has painted. */
async function openThread(actor: Actor, id: string, text: string): Promise<void> {
  await expect.poll(() => painted(actor, id), { message: `${actor.label}: the comment paints`, timeout: PEER_TIMEOUT }).not.toEqual([]);
  await gutter(actor).first().click();
  await expect(thread(actor).getByText(text), `${actor.label}: the thread opens`).toBeVisible();
}

/** Writes a reply in the open thread's composer; `mention` picks that person from the @ menu first. */
async function reply(actor: Actor, text: string, mention?: string): Promise<void> {
  const composer = thread(actor).locator('[data-comment-reply-composer] [contenteditable="true"]');
  await expect(composer, 'the reply composer autofocuses').toBeFocused();
  if (mention) {
    await actor.page.keyboard.type(`@${mention.slice(0, 3)}`);
    const option = actor.page.locator('button[data-index]').filter({ hasText: mention });
    await expect(option, `${actor.label}: the @ menu offers ${mention}`).toBeVisible({ timeout: PEER_TIMEOUT });
    await option.click();
    await expect(composer.locator('[data-mention-type="person"]'), 'the mention becomes a pill').toHaveCount(1);
  }
  await actor.page.keyboard.type(text);
  await actor.page.keyboard.press(SUBMIT);
  await expect(thread(actor).getByText(text), 'the reply joins the thread').toBeVisible();
}

test('j15-social: reactions toggle per principal, live for both people @p:mean-1 @evidence', async ({ actors, stack }) => {
  const note = await sharedNote(actors, stack.baseUrl);
  const { ada, id } = note;
  const { actor: ben } = await peer(actors, note, 'ben', 'commenter');
  await actors.requireDistinct(2);
  await select(ada, id, 'quick brown');
  await comment(ada, 'React to me');
  await openThread(ben, id, 'React to me');
  await openThread(ada, id, 'React to me');

  await message(ben, 'React to me').getByRole('button', { name: /^Comment actions for / }).click();
  await ben.page.getByRole('menuitem', { name: 'React with 👍' }).click();
  for (const actor of [ada, ben]) {
    await expect(message(actor, 'React to me').getByRole('button', { name: '👍 1' }), `${actor.label}: one thumbs-up shows`).toBeVisible({ timeout: PEER_TIMEOUT });
  }
  await expect(message(ben, 'React to me').getByRole('button', { name: '👍 1' }), "Ben's own reaction is pressed for him").toHaveAttribute('aria-pressed', 'true');
  await expect(message(ada, 'React to me').getByRole('button', { name: '👍 1' }), 'and not for Ada').toHaveAttribute('aria-pressed', 'false');

  await message(ada, 'React to me').getByRole('button', { name: '👍 1' }).click();
  for (const actor of [ada, ben]) {
    await expect(message(actor, 'React to me').getByRole('button', { name: '👍 2' }), `${actor.label}: Ada adds hers`).toBeVisible({ timeout: PEER_TIMEOUT });
  }
  await actors.checkpoint('reactions');
  await message(ben, 'React to me').getByRole('button', { name: '👍 2' }).click();
  for (const actor of [ada, ben]) {
    await expect(message(actor, 'React to me').getByRole('button', { name: '👍 1' }), `${actor.label}: Ben's toggle removes only his`).toBeVisible({ timeout: PEER_TIMEOUT });
  }
  await expect(message(ada, 'React to me').getByRole('button', { name: '👍 1' }), "Ada's stays hers").toHaveAttribute('aria-pressed', 'true');
  await expect(message(ben, 'React to me').getByRole('button', { name: '👍 1' })).toHaveAttribute('aria-pressed', 'false');
});

test("j15-social: an @mention reaches B's bell, and a reply reaches the root author's bell @p:ppl-3 @p:mean-1 @evidence", async ({ actors, stack }) => {
  const note = await sharedNote(actors, stack.baseUrl);
  const { ada, id, adaPrincipal } = note;
  const { actor: ben, principal: benPrincipal } = await peer(actors, note, 'ben', 'commenter');
  await expect(bell(ben, id), 'Ben has nothing unread').toHaveAccessibleName('Notifications');
  // Ben accepting Ada's invite told her so; she reads that first.
  await expect(bell(ada, id)).toHaveAccessibleName('Notifications, 1 unread', { timeout: PEER_TIMEOUT });
  await bell(ada, id).click();
  await ada.page.getByRole('button', { name: 'Mark all read' }).click();
  await ada.page.keyboard.press('Escape');
  await expect(bell(ada, id), 'Ada has nothing unread').toHaveAccessibleName('Notifications');

  await select(ada, id, 'quick brown');
  await comment(ada, 'Thoughts?');
  await openThread(ada, id, 'Thoughts?');
  await reply(ada, 'can you check this', benPrincipal.name);
  await expect(message(ada, 'can you check this').locator('[data-mention-type="person"], [data-comment-person-mention]'), 'the mention shows as a person').toHaveCount(1);

  await expect(bell(ben, id), 'the mention is pushed to Ben').toHaveAccessibleName('Notifications, 1 unread', { timeout: PEER_TIMEOUT });
  await bell(ben, id).click();
  await expect(ben.page.getByRole('menuitem').filter({ hasText: `${adaPrincipal.name} mentioned you` }), 'the notice says who mentioned him').toBeVisible();
  await ben.page.keyboard.press('Escape');
  await expect(bell(ada, id), 'Ada is not notified of her own reply').toHaveAccessibleName('Notifications');

  await openThread(ben, id, 'Thoughts?');
  await reply(ben, 'Checked, looks fine');
  await expect(bell(ada, id), "Ben's reply reaches Ada, the thread's author").toHaveAccessibleName('Notifications, 1 unread', { timeout: PEER_TIMEOUT });
  await bell(ada, id).click();
  await expect(ada.page.getByRole('menuitem').filter({ hasText: `${benPrincipal.name} replied to your comment` })).toBeVisible();
  await actors.checkpoint('bell');
});

test('j15-social: a non-author sees no Edit or Delete, and a raw delete or edit gets 403 @p:mean-1', async ({ actors, stack }) => {
  const note = await sharedNote(actors, stack.baseUrl);
  const { ada, id } = note;
  const { actor: ben } = await peer(actors, note, 'ben', 'editor');
  await select(ada, id, 'quick brown');
  await comment(ada, 'Only Ada may change this');
  await openThread(ben, id, 'Only Ada may change this');

  await expect(thread(ben).getByRole('button', { name: 'Delete thread' }), "Ben cannot delete Ada's thread").toHaveCount(0);
  await message(ben, 'Only Ada may change this').getByRole('button', { name: /^Comment actions for / }).click();
  await expect(ben.page.getByRole('menuitem', { name: /^Edit / }), 'no Edit for a non-author').toHaveCount(0);
  await expect(ben.page.getByRole('menuitem', { name: /^Delete / }), 'no Delete for a non-author').toHaveCount(0);
  await ben.page.keyboard.press('Escape');
  await expect(ben.page.getByRole('menu'), 'Escape closes the actions menu').toHaveCount(0);
  await expect(thread(ben).getByText('Only Ada may change this'), 'and leaves the thread open').toBeVisible();

  const commentId = await gutter(ben).first().getAttribute('data-comment-gutter-id');
  expect(commentId).toBeTruthy();
  const deleted = await ben.context.request.delete(`/api/docs/${id}/comments/${commentId}`, { headers: { origin: stack.baseUrl } });
  expect(deleted.status(), "a raw delete of Ada's comment by Ben").toBe(403);
  const thread403 = await ben.context.request.delete(`/api/docs/${id}/comments/${commentId}?scope=thread`, { headers: { origin: stack.baseUrl } });
  expect(thread403.status(), 'and of her thread').toBe(403);
  const edited = await ben.context.request.patch(`/api/docs/${id}/comments/${commentId}`, { headers: { origin: stack.baseUrl }, data: { text: 'Ben was here' } });
  expect(edited.status(), 'a raw edit').toBe(403);
  await ben.page.waitForTimeout(500);
  await expect(thread(ben).getByText('Only Ada may change this'), 'the comment is untouched').toBeVisible();

  // The author has both, and her edit reaches the peer.
  await openThread(ada, id, 'Only Ada may change this');
  await expect(thread(ada).getByRole('button', { name: 'Delete thread' }), 'the author can delete her thread').toBeVisible();
  await message(ada, 'Only Ada may change this').getByRole('button', { name: /^Comment actions for / }).click();
  await ada.page.getByRole('menuitem', { name: /^Edit / }).click();
  const editor = thread(ada).locator('[data-comment-edit-composer] [contenteditable="true"]');
  await expect(editor).toBeFocused();
  await ada.page.keyboard.press('ControlOrMeta+a');
  await ada.page.keyboard.type('Ada changed this');
  await ada.page.keyboard.press(SUBMIT);
  await expect(thread(ben).getByText('Ada changed this'), "the author's edit reaches the peer").toBeVisible({ timeout: PEER_TIMEOUT });
});

test('j15-social: deleting a root with replies keeps the thread anchored under the promoted reply @p:mean-1', async ({ actors, stack }) => {
  const note = await sharedNote(actors, stack.baseUrl);
  const { ada, id } = note;
  const { actor: ben } = await peer(actors, note, 'ben', 'commenter');
  await select(ada, id, 'lazy dog');
  await comment(ada, 'The first word');
  await openThread(ben, id, 'The first word');
  await reply(ben, 'The oldest reply');
  await reply(ben, 'A later reply');
  await openThread(ada, id, 'The first word');
  await expect(thread(ada).getByText('A later reply')).toBeVisible({ timeout: PEER_TIMEOUT });

  await message(ada, 'The first word').getByRole('button', { name: /^Comment actions for / }).click();
  await ada.page.getByRole('menuitem', { name: /^Delete / }).click();
  await ada.page.getByRole('button', { name: 'Delete', exact: true }).click();
  for (const actor of [ada, ben]) {
    await expect(thread(actor).getByText('The first word'), `${actor.label}: the root is gone`).toHaveCount(0, { timeout: PEER_TIMEOUT });
  }
  await ada.page.keyboard.press('Escape');
  await ben.page.keyboard.press('Escape');

  for (const actor of [ada, ben]) {
    await expect.poll(() => painted(actor, id), { message: `${actor.label}: the thread still paints its text`, timeout: PEER_TIMEOUT }).toEqual(['lazy dog']);
    await expect(gutter(actor), `${actor.label}: one thread remains`).toHaveCount(1);
  }
  // A declared reload: the promoted thread is the server's, not a local leftover.
  ben.observations.clear();
  await ben.page.reload();
  await expect(ui.pane(ben, id)).toHaveAttribute(DOC_STATE_ATTR, 'live', { timeout: BIND_TIMEOUT });
  await ben.observeEditor(id);
  await openThread(ben, id, 'The oldest reply');
  const messages = thread(ben).locator('[data-comment-message]');
  await expect(messages, 'the promoted reply leads, the later reply follows').toHaveCount(2);
  await expect(messages.nth(0)).toContainText('The oldest reply');
  await expect(messages.nth(1)).toContainText('A later reply');
});
