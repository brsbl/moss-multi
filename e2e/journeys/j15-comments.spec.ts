// j15-comments (T4.3; docs/design/comments.md §6, §11, §12): moss's comment UI on a shared note. A person selects text
// and presses Cmd+Shift+A, writes the comment, and keeps typing; the highlight is CSS Custom Highlight paint derived
// from the server's anchor record, so the peer sees it, bold across it never blinks it, and delete then Cmd+Z brings
// it back. Threads open from the gutter, take replies and resolve; a commenter comments without editing; a detached
// thread is listed with its quote. No marker reaches the DOM.
import type { LexicalEditor } from 'lexical';
import type { Actor, Actors } from '../lib/actors.ts';
import { BODY_BINDING_ATTR, DOC_STATE_ATTR, SYNC_UNACKED_ATTR, paneSelector } from '../lib/contract.ts';
import { grantDoc, type GrantRole } from '../lib/grants.ts';
import type { Principal } from '../lib/principals.ts';
import { expect, test, ui } from '../lib/test.ts';

const SEED = 'The quick brown fox jumps over the lazy dog.\n\nA second line for the peer.';
const BIND_TIMEOUT = 15_000;
const PEER_TIMEOUT = 10_000;
const ACK_TIMEOUT = 10_000;
const UNDO = 'ControlOrMeta+z';
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

/** Selects `needle` in an editable body through the editor (or puts the caret `caret` characters into it). */
async function select(actor: Actor, id: string, needle: string, caret?: number): Promise<void> {
  await ui.body(actor, id).evaluate((element, { needle, caret }) => {
    const editor = (element as HTMLElement & { __lexicalEditor: LexicalEditor }).__lexicalEditor;
    editor.update(() => {
      const node = [...editor.getEditorState()._nodeMap.values()].find((n) => n.getType() === 'text' && n.getTextContent().includes(needle));
      if (!node) throw new Error(`no text node holds "${needle}"`);
      const at = node.getTextContent().indexOf(needle);
      const [from, to] = caret === undefined ? [at, at + needle.length] : [at + caret, at + caret];
      (node as unknown as { select(a: number, b: number): void }).select(from, to);
    }, { discrete: true });
  }, { needle, caret });
}

/** Selects `needle` the way a drag does: a DOM range over the rendered text, which a read-only body also allows. */
async function selectDom(actor: Actor, id: string, needle: string): Promise<void> {
  await ui.body(actor, id).evaluate((root, needle) => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const at = (node.textContent ?? '').indexOf(needle);
      if (at < 0) continue;
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + needle.length);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      return;
    }
    throw new Error(`no rendered text holds "${needle}"`);
  }, needle);
}

/** The text each comment highlight paints in this actor's body (CSS Custom Highlights, never DOM marks). */
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

const bodyText = (actor: Actor, id: string) => ui.fieldText(actor, id, 'body');

async function waitAcked(actor: Actor, id: string): Promise<void> {
  await expect(ui.pane(actor, id), `${actor.label}: the DocDO acks every edit`).toHaveAttribute(SYNC_UNACKED_ATTR, '0', { timeout: ACK_TIMEOUT });
}

/** Cmd+Shift+A over the current selection, then the composer: type, submit. */
async function comment(actor: Actor, text: string): Promise<void> {
  await actor.page.keyboard.press(COMMENT_KEY);
  const composer = actor.page.getByRole('dialog', { name: 'Add comment' });
  await expect(composer, `${actor.label}: Cmd+Shift+A opens the composer`).toBeVisible();
  await expect(composer.getByRole('textbox').first(), 'the composer takes focus').toBeFocused();
  await actor.page.keyboard.type(text);
  await actor.page.keyboard.press(SUBMIT);
  await expect(composer).toBeHidden();
}

async function expectPainted(actor: Actor, id: string, text: string, message: string): Promise<void> {
  await expect.poll(() => painted(actor, id), { message, timeout: PEER_TIMEOUT }).toContain(text);
}

const gutter = (actor: Actor) => actor.page.locator('[data-comment-gutter-id]');
const thread = (actor: Actor) => actor.page.locator('.moss-comment-popover');

test('j15-comments: A comments, then both type anywhere in both directions; the peer sees the highlight; no marker in the DOM @p:mean-1 @p:tech-3 @evidence', async ({ actors, stack }) => {
  const note = await sharedNote(actors, stack.baseUrl);
  const { ada, id } = note;
  const { actor: ben } = await peer(actors, note, 'ben', 'editor');
  await actors.requireDistinct(2);

  await select(ada, id, 'quick brown');
  await comment(ada, 'Ada on the quick brown');
  await expectPainted(ada, id, 'quick brown', "Ada's comment paints its text");
  await expectPainted(ben, id, 'quick brown', 'the peer sees the highlight');
  await expect(gutter(ada), "Ada's gutter shows the thread").toHaveCount(1);
  await expect(gutter(ben), "Ben's gutter shows the thread").toHaveCount(1);
  await actors.checkpoint('commented');

  // Typing right after commenting: Ada at the end, Ben at the start, then each inside the other's line.
  await ui.typeBody(ada, id, ' Ada types on');
  await ben.page.locator(paneSelector(id)).click();
  await select(ben, id, 'The quick', 0);
  await ben.page.keyboard.type('Ben first ');
  ben.typed({ docId: id, field: 'body', text: 'Ben first ', ordered: false });
  await select(ada, id, 'A second line', 2);
  await ada.page.keyboard.type('Ada-inside ');
  ada.typed({ docId: id, field: 'body', text: 'Ada-inside ', ordered: false });
  await select(ben, id, 'lazy dog', 4);
  await ben.page.keyboard.type(' sleepy');
  ben.typed({ docId: id, field: 'body', text: ' sleepy', ordered: false });
  await waitAcked(ada, id);
  await waitAcked(ben, id);
  await expect.poll(async () => (await bodyText(ben, id)) === (await bodyText(ada, id)), { message: 'both bodies converge', timeout: PEER_TIMEOUT }).toBe(true);
  const text = await bodyText(ada, id);
  for (const typed of [' Ada types on', 'Ben first ', 'Ada-inside ', ' sleepy']) expect(text.split(typed).length - 1, `"${typed}" lands once`).toBe(1);
  expect(await painted(ada, id), 'the comment stays on its own words').toContain('quick brown');
  expect(await painted(ben, id)).toContain('quick brown');

  for (const actor of [ada, ben]) {
    const html = await actor.page.evaluate(() => document.documentElement.outerHTML);
    expect(html.includes('%%m:') || html.includes('%m:'), `${actor.label}: no comment marker in the DOM`).toBe(false);
  }
});

test('j15-comments: two comments in one paragraph both paint, for both people @p:mean-1 @p:tech-3', async ({ actors, stack }) => {
  const note = await sharedNote(actors, stack.baseUrl);
  const { ada, id } = note;
  const { actor: ben } = await peer(actors, note, 'ben', 'editor');
  await select(ada, id, 'quick brown');
  await comment(ada, 'First comment');
  await expectPainted(ada, id, 'quick brown', 'the first comment paints');
  await select(ada, id, 'lazy dog');
  await comment(ada, 'Second comment');
  for (const actor of [ada, ben]) {
    await expect.poll(() => painted(actor, id), { message: `${actor.label}: both comments paint`, timeout: PEER_TIMEOUT }).toEqual(['lazy dog', 'quick brown']);
    await expect(gutter(actor), `${actor.label}: two gutter icons`).toHaveCount(2);
  }
});

test('j15-comments: bold across the commented text keeps the highlight with no blink frame @p:mean-1 @p:tech-3', async ({ actors, stack }) => {
  const note = await sharedNote(actors, stack.baseUrl);
  const { ada, id } = note;
  const { actor: ben } = await peer(actors, note, 'ben', 'editor');
  await select(ada, id, 'quick brown');
  await comment(ada, 'Keep me through bold');
  await expectPainted(ada, id, 'quick brown', 'the comment paints');
  await expectPainted(ben, id, 'quick brown', 'the peer paints it');
  await waitAcked(ada, id);

  // Every paint pass from here on: a pass that misses the comment's text is a blink frame.
  await ada.page.evaluate(() => {
    const log: string[][] = [];
    (window as unknown as { paintLog: string[][] }).paintLog = log;
    window.addEventListener('moss-comment-paint', (event) => log.push([...(event as CustomEvent<{ texts: string[] }>).detail.texts]));
  });
  await select(ada, id, 'brown fox');
  await ada.page.keyboard.press('ControlOrMeta+b');
  await expect(ui.body(ada, id).locator('strong, b, .font-bold, [class*="bold"]').filter({ hasText: 'brown fox' }).first(), 'the words are bold').toBeVisible();
  await waitAcked(ada, id);
  await ada.page.waitForTimeout(1_000);
  const log = await ada.page.evaluate(() => (window as unknown as { paintLog: string[][] }).paintLog);
  expect(log.length, 'the bold repainted the comments').toBeGreaterThan(0);
  expect(log.filter((texts) => !texts.includes('quick brown')), 'no paint pass lost the highlight').toEqual([]);
  expect(await painted(ada, id)).toContain('quick brown');
  await expectPainted(ben, id, 'quick brown', 'the peer keeps the highlight across the bold');
});

test('j15-comments: delete the commented text, then Cmd+Z restores the highlight @p:mean-1 @p:R18', async ({ actors, stack }) => {
  const note = await sharedNote(actors, stack.baseUrl);
  const { ada, id } = note;
  const { actor: ben } = await peer(actors, note, 'ben', 'editor');
  await select(ada, id, 'quick brown');
  await comment(ada, 'Bring me back');
  await expectPainted(ada, id, 'quick brown', 'the comment paints');
  await waitAcked(ada, id);
  await ada.page.waitForTimeout(1_500);

  await select(ada, id, 'quick brown');
  await ada.page.keyboard.press('Backspace');
  await expect.poll(() => bodyText(ada, id)).toContain('The  fox jumps');
  await waitAcked(ada, id);
  await expect.poll(() => painted(ada, id), { message: 'deleting its text removes the highlight' }).toEqual([]);
  await expect.poll(() => painted(ben, id), { message: 'for the peer too', timeout: PEER_TIMEOUT }).toEqual([]);

  await ada.page.keyboard.press(UNDO);
  await expect.poll(() => bodyText(ada, id)).toContain('The quick brown fox');
  await expectPainted(ada, id, 'quick brown', 'Cmd+Z restores the highlight');
  await expectPainted(ben, id, 'quick brown', 'the peer sees it restored');
});

test('j15-comments: a commenter can comment but not edit @p:mean-1 @p:ppl-2', async ({ actors, stack }) => {
  const note = await sharedNote(actors, stack.baseUrl);
  const { ada, id } = note;
  const { actor: cara } = await peer(actors, note, 'cara', 'commenter');
  const before = await bodyText(cara, id);
  const adaBefore = await bodyText(ada, id);
  // The read-only body is aria-disabled, so the click is forced, as a person's click lands regardless.
  await ui.body(cara, id).click({ force: true });
  await cara.page.keyboard.type('zzz');
  expect(await bodyText(cara, id), 'typing does not edit the body').toBe(before);

  await selectDom(cara, id, 'lazy dog');
  await comment(cara, 'Cara can only comment');
  await expectPainted(cara, id, 'lazy dog', "the commenter's comment paints for her");
  await expectPainted(ada, id, 'lazy dog', 'and for the owner');
  expect(await bodyText(ada, id), 'the body is unchanged').toBe(adaBefore);
  await gutter(ada).first().click();
  await expect(thread(ada).getByText('Cara can only comment'), 'the owner reads the thread').toBeVisible();
});

test('j15-comments: the gutter opens the thread; a reply arrives live, attributed; resolve hides it; a detached thread is listed with its quote @p:mean-1 @p:tech-3 @evidence', async ({ actors, stack }) => {
  const note = await sharedNote(actors, stack.baseUrl);
  const { ada, id, adaPrincipal } = note;
  const { actor: ben } = await peer(actors, note, 'ben', 'editor');
  await select(ada, id, 'quick brown');
  await comment(ada, 'What about speed?');
  await expectPainted(ben, id, 'quick brown', 'the peer paints it');

  await gutter(ben).first().click();
  await expect(thread(ben).getByText('What about speed?'), 'the gutter opens the thread').toBeVisible();
  await expect(thread(ben).getByText(adaPrincipal.name), "Ada's comment carries her name").toBeVisible();
  await expect(thread(ben).getByRole('button', { name: 'Delete thread' }), 'delete is not offered yet').toHaveCount(0);
  const reply = thread(ben).locator('[data-comment-reply-composer] [contenteditable="true"]');
  await expect(reply, 'the reply composer autofocuses').toBeFocused();
  await ben.page.keyboard.type('Fast enough');
  await ben.page.keyboard.press(SUBMIT);
  await expect(thread(ben).getByText('Fast enough'), 'the reply joins the thread').toBeVisible();
  await actors.checkpoint('thread');

  await gutter(ada).first().click();
  await expect(thread(ada).getByText('Fast enough'), "Ben's reply reaches Ada").toBeVisible({ timeout: PEER_TIMEOUT });
  await thread(ada).getByRole('button', { name: 'Resolve thread' }).click();
  await expect.poll(() => painted(ben, id), { message: 'a resolved thread leaves the open view', timeout: PEER_TIMEOUT }).toEqual([]);
  await ada.page.keyboard.press('Escape');

  await select(ada, id, 'lazy dog');
  await comment(ada, 'Detach me');
  await expectPainted(ada, id, 'lazy dog', 'the second comment paints');
  await waitAcked(ada, id);
  await ada.page.waitForTimeout(1_500);
  await select(ada, id, 'lazy dog');
  await ada.page.keyboard.press('Backspace');
  await waitAcked(ada, id);
  await expect.poll(() => painted(ada, id), { message: 'its text is gone' }).toEqual([]);
  await ui.pane(ada, id).getByRole('button', { name: /^Comments/ }).click();
  const listed = ada.page.getByRole('button', { name: /Detach me/ });
  await expect(listed, 'the detached thread is listed').toBeVisible();
  await expect(listed, 'with its quote, marked detached').toContainText('lazy dog');
  await expect(listed).toContainText(/detached/i);
  await actors.checkpoint('detached');
});
