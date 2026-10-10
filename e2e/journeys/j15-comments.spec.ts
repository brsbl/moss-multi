// j15-comments (T4.3; docs/design/comments.md §6, §11, §12): moss's comment UI on a shared note. A person selects text
// and presses Cmd+Shift+A, writes the comment, and keeps typing; the highlight is CSS Custom Highlight paint derived
// from the server's anchor record, so the peer sees it, bold across it never blinks it, and delete then Cmd+Z brings
// it back. Threads open from the gutter, take replies and resolve; a commenter comments without editing; a detached
// thread is listed with its quote. No marker reaches the DOM. A commenter also comments on blocks (code, chart, canvas,
// image) from their headers; a viewer and a trashed note are offered none.
import { readFileSync } from 'node:fs';
import type { Locator } from '@playwright/test';
import type { LexicalEditor } from 'lexical';
import * as Y from 'yjs';
import { fromBase64 } from '../../packages/core/src/tree-anchor.ts';
import type { Actor, Actors } from '../lib/actors.ts';
import { BODY_BINDING_ATTR, DOC_STATE_ATTR, SYNC_UNACKED_ATTR, paneSelector } from '../lib/contract.ts';
import { openDocClient } from '../lib/doc-client.ts';
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

/**
 * Selects `needle` the way a drag does: a DOM range over the rendered text, which a read-only body also allows. The
 * needle may cross text nodes inside one block (a bold in the middle of it).
 */
async function selectDom(actor: Actor, id: string, needle: string): Promise<void> {
  await ui.body(actor, id).evaluate((root, needle) => {
    for (const block of root.children) {
      const nodes: { node: Text; start: number }[] = [];
      let text = '';
      const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        nodes.push({ node: node as Text, start: text.length });
        text += node.textContent ?? '';
      }
      const at = text.indexOf(needle);
      if (at < 0) continue;
      const point = (offset: number, end: boolean): [Text, number] => {
        const hit = nodes.find(({ node, start }) => (end ? offset > start && offset <= start + node.length : offset >= start && offset < start + node.length))!;
        return [hit.node, offset - hit.start];
      };
      const range = document.createRange();
      range.setStart(...point(at, false));
      range.setEnd(...point(at + needle.length, true));
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      return;
    }
    throw new Error(`no rendered block holds "${needle}"`);
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

/** Samples the live comment highlights every animation frame, logging each frame that misses `text`. */
async function startBlinkSampler(actor: Actor, text: string): Promise<void> {
  await actor.page.evaluate((text) => {
    const state = { frames: 0, blinks: [] as string[][], stop: false };
    (window as unknown as { blinkSampler: typeof state }).blinkSampler = state;
    const tick = () => {
      if (state.stop) return;
      const texts: string[] = [];
      CSS.highlights.forEach((highlight, name) => {
        if (/^moss-comment-\d+$/.test(name)) highlight.forEach((range) => texts.push((range as Range).toString()));
      });
      state.frames += 1;
      if (!texts.includes(text)) state.blinks.push(texts);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, text);
}

async function stopBlinkSampler(actor: Actor): Promise<{ frames: number; blinks: string[][] }> {
  return actor.page.evaluate(() => {
    const state = (window as unknown as { blinkSampler: { frames: number; blinks: string[][]; stop: boolean } }).blinkSampler;
    state.stop = true;
    return { frames: state.frames, blinks: state.blinks };
  });
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

test('j15-comments: typing straight after Cmd+Enter keeps the commented words and their highlight @p:mean-1 @p:tech-3', async ({ actors, stack }) => {
  const note = await sharedNote(actors, stack.baseUrl);
  const { ada, id } = note;
  const { actor: ben } = await peer(actors, note, 'ben', 'editor');
  await select(ada, id, 'quick brown');
  await comment(ada, 'Then I keep typing');
  // No click and no caret key: the body takes focus back and the next keystrokes land wherever the caret is.
  await expect.poll(() => ui.body(ada, id).evaluate((root) => root.contains(document.activeElement)), { message: 'the body takes focus back' }).toBe(true);
  await ada.page.keyboard.type(' and more');
  ada.typed({ docId: id, field: 'body', text: ' and more', ordered: false });
  await waitAcked(ada, id);
  await expect.poll(() => bodyText(ada, id), { message: 'the typing lands after the commented words, replacing nothing' }).toContain('The quick brown and more fox jumps');
  await expect.poll(() => bodyText(ben, id), { timeout: PEER_TIMEOUT }).toContain('The quick brown and more fox jumps');
  await expectPainted(ada, id, 'quick brown', 'the comment keeps its words');
  await expectPainted(ben, id, 'quick brown', 'the peer still paints it');
  // A declared reload: the remount detector restarts on the fresh page.
  ben.observations.clear();
  await ben.page.reload();
  await expect(ui.pane(ben, id)).toHaveAttribute(DOC_STATE_ATTR, 'live', { timeout: BIND_TIMEOUT });
  await ben.observeEditor(id);
  await expectPainted(ben, id, 'quick brown', 'a fresh load paints it too');
  expect(await painted(ben, id), 'and on nothing else').toEqual(['quick brown']);
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

  // Every animation frame from here on, on both sides: a frame whose live highlights miss the comment's text is a
  // blink, whether or not a paint pass ran in it (a Lexical rewrite collapses a kept Range before any repaint).
  for (const actor of [ada, ben]) await startBlinkSampler(actor, 'quick brown');
  await select(ada, id, 'brown fox');
  await ada.page.keyboard.press('ControlOrMeta+b');
  await expect(ui.body(ada, id).locator('strong, b, .font-bold, [class*="bold"]').filter({ hasText: 'brown fox' }).first(), 'the words are bold').toBeVisible();
  await expect(ui.body(ben, id).locator('strong, b, .font-bold, [class*="bold"]').filter({ hasText: 'brown fox' }).first(), 'the peer sees the bold').toBeVisible({ timeout: PEER_TIMEOUT });
  await waitAcked(ada, id);
  await ada.page.waitForTimeout(1_000);
  for (const actor of [ada, ben]) {
    const { frames, blinks } = await stopBlinkSampler(actor);
    expect(frames, `${actor.label}: frames were sampled through the bold`).toBeGreaterThan(10);
    expect(blinks, `${actor.label}: no frame lost the highlight`).toEqual([]);
  }
  expect(await painted(ada, id)).toContain('quick brown');
  await expectPainted(ben, id, 'quick brown', 'the peer keeps the highlight across the bold');
});

test("j15-comments: bold across the comment's end, then delete its text: it detaches everywhere, and Cmd+Z restores it @p:mean-1 @p:R18", async ({ actors, stack }) => {
  const note = await sharedNote(actors, stack.baseUrl);
  const { ada, id } = note;
  const { actor: ben } = await peer(actors, note, 'ben', 'editor');
  await select(ada, id, 'quick brown');
  await comment(ada, 'Bold me, then delete me');
  await expectPainted(ben, id, 'quick brown', 'the peer paints it');
  await waitAcked(ada, id);

  await select(ada, id, 'brown fox');
  await ada.page.keyboard.press('ControlOrMeta+b');
  await expect(ui.body(ada, id).locator('strong, b, .font-bold, [class*="bold"]').filter({ hasText: 'brown fox' }).first(), 'the words are bold').toBeVisible();
  await waitAcked(ada, id);
  await expectPainted(ada, id, 'quick brown', 'the bold keeps the comment on its words');
  await ada.page.waitForTimeout(1_500);

  await selectDom(ada, id, 'quick brown');
  await ada.page.keyboard.press('Backspace');
  await expect.poll(() => bodyText(ada, id)).toContain('The  fox jumps');
  await waitAcked(ada, id);
  await expect.poll(() => painted(ada, id), { message: 'deleting its text leaves nothing painted' }).toEqual([]);
  await expect.poll(() => painted(ben, id), { message: 'for the peer too', timeout: PEER_TIMEOUT }).toEqual([]);
  // A declared reload: the remount detector restarts on the fresh page.
  ben.observations.clear();
  await ben.page.reload();
  await expect(ui.pane(ben, id)).toHaveAttribute(DOC_STATE_ATTR, 'live', { timeout: BIND_TIMEOUT });
  await ben.observeEditor(id);
  await expect.poll(() => bodyText(ben, id)).toContain('The  fox jumps');
  await ben.page.waitForTimeout(500);
  expect(await painted(ben, id), 'a fresh load paints nothing either: the server detached it').toEqual([]);
  await ui.pane(ben, id).getByRole('button', { name: /^Comments/ }).click();
  await expect(ben.page.getByRole('button', { name: /Bold me, then delete me/ }), 'the list marks it detached').toContainText(/detached/i);
  await ben.page.keyboard.press('Escape');

  await ada.page.keyboard.press(UNDO);
  await expect.poll(() => bodyText(ada, id)).toContain('The quick brown fox');
  await expectPainted(ada, id, 'quick brown', 'Cmd+Z restores the highlight on its words');
  await expectPainted(ben, id, 'quick brown', 'the peer sees it restored');
  expect(await painted(ada, id), 'and on nothing else').toEqual(['quick brown']);
});

test('j15-comments: trashing the note while a peer has its thread open leaves no comment control live @p:mean-1 @p:note-5', async ({ actors, stack }) => {
  const note = await sharedNote(actors, stack.baseUrl);
  const { ada, id } = note;
  const { actor: ben } = await peer(actors, note, 'ben', 'editor');
  await select(ada, id, 'quick brown');
  await comment(ada, 'Still here?');
  await expectPainted(ben, id, 'quick brown', 'the peer paints it');

  await gutter(ben).first().click();
  const reply = thread(ben).locator('[data-comment-reply-composer] [contenteditable="true"]');
  await expect(reply, 'the reply composer autofocuses').toBeFocused();
  await ben.page.keyboard.type('Half a reply');
  const posts: string[] = [];
  ben.page.on('request', (request) => {
    if (request.method() === 'POST' && /\/comments(\/|$)/.test(new URL(request.url()).pathname)) posts.push(request.url());
  });

  const trashed = await ada.context.request.delete(`/api/docs/${id}`, { headers: { origin: stack.baseUrl } });
  expect(trashed.status()).toBe(200);
  await expect(ui.pane(ben, id), 'the note goes terminal in place').toHaveAttribute(DOC_STATE_ATTR, 'terminal', { timeout: PEER_TIMEOUT });
  await expect(thread(ben).getByText('Still here?'), 'the thread stays readable').toBeVisible();
  await expect(thread(ben).locator('[contenteditable="true"]'), 'no reply composer is left editable').toHaveCount(0);
  await expect(thread(ben).getByRole('button', { name: /^(Resolve|Reopen) thread$/ }), 'resolve is withdrawn').toHaveCount(0);
  await ben.page.keyboard.type(' and more');
  await ben.page.keyboard.press(SUBMIT);
  await ben.page.keyboard.press('Escape');

  // A selection in the terminal body offers no way to comment.
  await selectDom(ben, id, 'lazy dog');
  await ben.page.keyboard.press(COMMENT_KEY);
  await expect(ben.page.locator('[data-floating-selection-toolbar] [aria-label="Add comment"]'), 'no comment bar is offered').toHaveCount(0);
  await expect(ben.page.getByRole('dialog', { name: 'Add comment' }), 'no composer opens').toHaveCount(0);
  await ben.page.waitForTimeout(500);
  expect(posts, 'nothing tried to write a comment after the trash').toEqual([]);
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
  await expect(thread(ben).getByRole('button', { name: 'Delete thread' }), 'nor to delete her thread').toHaveCount(0);
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

const BLOCK_TYPES = ['code-block', 'chart', 'sketch', 'image'] as const;
const BLOCKS_SEED = [
  'Blocks to comment on.',
  '```js\nconst answer = 42;\n```',
  '```moss-chart\n{"type":"bar","title":"Concurrent","data":[{"label":"Mon","value":3},{"label":"Tue","value":5}]}\n```',
  '```moss-canvas\n[moss:grid:v2]\n#\n```',
  '![A test card](assets/pattern.png)',
].join('\n\n');

/** Each commentable block's wrapper in this actor's body, by node type. */
async function blocksByType(actor: Actor, id: string): Promise<[string, Locator][]> {
  const keys = await ui.body(actor, id).evaluate((element, types) => {
    const editor = (element as HTMLElement & { __lexicalEditor: LexicalEditor }).__lexicalEditor;
    const nodes = [...editor.getEditorState()._nodeMap.values()];
    return types.map((type) => [type, nodes.find((node) => node.getType() === type)?.getKey() ?? ''] as const);
  }, [...BLOCK_TYPES]);
  return keys.map(([type, key]) => {
    expect(key, `${actor.label}: the note renders a ${type}`).not.toBe('');
    return [type, ui.body(actor, id).locator(`[data-block-decorator-key="${key}"]`).first()];
  });
}

const blockCommentButton = (block: Locator) => block.locator('button:has([class*="lucide-sticky-note"])');

/** The comments whose text is in `texts`, as the server stores them: each anchor's kind and the node type it names. */
async function storedAnchors(baseUrl: string, docId: string, cookie: string, texts: string[]): Promise<{ text: string; kind: unknown; type: unknown }[]> {
  const client = await openDocClient(baseUrl, docId, cookie);
  try {
    await client.synced;
    const comments = client.doc.getMap('comments');
    const out: { text: string; kind: unknown; type: unknown }[] = [];
    for (const [key, value] of comments) {
      const text = (value as { text?: string } | null)?.text;
      if (!key.startsWith('c:') || !text || !texts.includes(text)) continue;
      const anchor = comments.get(`a:${key.slice(2)}`) as { kind: string; start: string } | undefined;
      const position = anchor ? Y.decodeRelativePosition(fromBase64(anchor.start)).item : null;
      const item = position ? Y.getItem(client.doc.store, position) : null;
      const type = item instanceof Y.Item && item.content instanceof Y.ContentType ? (item.content.type as Y.XmlElement).getAttribute('__type') : null;
      out.push({ text, kind: anchor?.kind, type });
    }
    return out.sort((a, b) => a.text.localeCompare(b.text));
  } finally {
    client.close();
  }
}

test('j15-comments: a commenter comments on code, chart, canvas and image blocks; a viewer and a trashed note offer no block composer @p:mean-1 @p:ppl-2', async ({ actors, stack }) => {
  const adaPrincipal = await actors.principal('ada');
  const ada = await actors.session(adaPrincipal);
  const created = await ada.context.request.post('/api/docs', { headers: { origin: stack.baseUrl }, data: { markdown: BLOCKS_SEED } });
  expect(created.status()).toBe(201);
  const { doc: { id } } = await created.json() as { doc: { id: string } };
  const uploaded = await ada.context.request.post(`/api/docs/${id}/assets?filename=pattern.png`, {
    headers: { origin: stack.baseUrl, 'content-type': 'image/png' }, data: readFileSync(new URL('../fixtures/media/pattern.png', import.meta.url)),
  });
  expect(uploaded.status(), 'the image is uploaded').toBe(201);
  await ada.goto(`/d/${id}`);
  await ui.waitLive(ada, id);
  await ada.observeEditor(id);
  const note: Note = { id, ada, adaPrincipal };
  const { actor: cara } = await peer(actors, note, 'cara', 'commenter');
  const { actor: vic } = await peer(actors, note, 'vic', 'viewer');
  const before = await bodyText(ada, id);

  const texts: string[] = [];
  for (const [type, block] of await blocksByType(cara, id)) {
    await block.scrollIntoViewIfNeeded();
    await block.hover();
    const button = blockCommentButton(block);
    await expect(button, `${type}: the commenter is offered Add comment`).toHaveCount(1);
    await expect(block.getByRole('button', { name: /^(Edit|Draw|Delete|Fullscreen)$/ }), `${type}: but no body edit`).toHaveCount(0);
    await button.click();
    const composer = cara.page.getByRole('dialog', { name: 'Add comment' });
    await expect(composer, `${type}: the block composer opens`).toBeVisible();
    await expect(composer.getByRole('textbox').first()).toBeFocused();
    const text = `On the ${type}`;
    await cara.page.keyboard.type(text);
    await cara.page.keyboard.press(SUBMIT);
    await expect(composer, `${type}: the comment is sent`).toBeHidden({ timeout: PEER_TIMEOUT });
    texts.push(text);
  }
  const cookie = (await ada.context.cookies()).map((c) => `${c.name}=${c.value}`).join('; ');
  await expect.poll(() => storedAnchors(stack.baseUrl, id, cookie, texts), { message: 'each comment is stored as a block anchor on its node', timeout: PEER_TIMEOUT })
    .toEqual(BLOCK_TYPES.map((type) => ({ text: `On the ${type}`, kind: 'block', type })).sort((a, b) => a.text.localeCompare(b.text)));
  await expect(gutter(ada), 'the owner sees a thread on each block').toHaveCount(BLOCK_TYPES.length, { timeout: PEER_TIMEOUT });
  expect(await bodyText(ada, id), 'the body is unchanged').toBe(before);

  for (const [type, block] of await blocksByType(vic, id)) {
    await block.scrollIntoViewIfNeeded();
    await block.hover();
    await expect(blockCommentButton(block), `${type}: a viewer gets no block comment`).toHaveCount(0);
  }

  const trashed = await ada.context.request.delete(`/api/docs/${id}`, { headers: { origin: stack.baseUrl } });
  expect(trashed.status()).toBe(200);
  await expect(ui.pane(cara, id), 'the note goes terminal in place').toHaveAttribute(DOC_STATE_ATTR, 'terminal', { timeout: PEER_TIMEOUT });
  for (const [type, block] of await blocksByType(cara, id)) {
    await block.scrollIntoViewIfNeeded();
    await block.hover();
    await expect(blockCommentButton(block), `${type}: a trashed note offers no block comment`).toHaveCount(0);
  }
  await expect(cara.page.getByRole('dialog', { name: 'Add comment' }), 'no composer is open').toHaveCount(0);
});
