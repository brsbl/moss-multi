// j15-comments-drafts (T4.B3; docs/design/comments.md §4, §12): what a comment composer keeps, and block comments. A
// commenter comments on code, chart, canvas and image blocks from their headers; a viewer, a revoked commenter and a
// trashed note are offered none. A composer keeps what the server did not take: a lost or refused write stays to retry,
// a revision is sent as written, overlapping submits each land, a reply that fails comes back to its thread's open
// reply box on its own, a failed edit resubmitted unchanged is sent again, a revert saved over an edit in flight
// lands last, and a block composer's retry stays on its block.
import { readFileSync } from 'node:fs';
import type { Locator } from '@playwright/test';
import type { LexicalEditor } from 'lexical';
import * as Y from 'yjs';
import { fromBase64 } from '../../packages/core/src/tree-anchor.ts';
import type { Actor, Actors } from '../lib/actors.ts';
import { BODY_BINDING_ATTR, DOC_STATE_ATTR, TERMINAL_REASON_ATTR, paneSelector } from '../lib/contract.ts';
import { openDocClient } from '../lib/doc-client.ts';
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

const bodyText = (actor: Actor, id: string) => ui.fieldText(actor, id, 'body');

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

const gutter = (actor: Actor) => actor.page.locator('[data-comment-gutter-id]');
const thread = (actor: Actor) => actor.page.locator('.moss-comment-popover');

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

/** Makes `actor`'s comment POSTs on `id` answer a declared 408 while `on` is set; they never reach the server. */
async function failableCommentPosts(actor: Actor, id: string): Promise<{ on: boolean }> {
  const path = `/api/docs/${id}/comments`;
  const state = { on: false };
  actor.expectHttp(408, path);
  await actor.page.route((url) => url.pathname === path, (route) => route.request().method() === 'POST' && state.on
    ? route.fulfill({ status: 408, contentType: 'application/json', body: JSON.stringify({ error: 'timeout' }) })
    : route.fallback());
  return state;
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
    // The read-only body is aria-disabled, so the click is forced, as a person's click lands regardless.
    await button.click({ force: true });
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

  // A failed block comment keeps its block. The owner (editable body) comments on text, then on the code block; the
  // block comment fails and its retry from the same composer still lands on the code block.
  const adaFails = await failableCommentPosts(ada, id);
  await select(ada, id, 'comment on');
  await comment(ada, 'Ada on the words');
  const [, code] = (await blocksByType(ada, id))[0]!;
  await code.scrollIntoViewIfNeeded();
  await code.hover();
  adaFails.on = true;
  await blockCommentButton(code).click();
  const adaComposer = ada.page.getByRole('dialog', { name: 'Add comment' });
  await expect(adaComposer.getByRole('textbox').first()).toBeFocused();
  await ada.page.keyboard.type('Ada on the code');
  await ada.page.keyboard.press(SUBMIT);
  await expect(ada.page.getByText(/couldn't be saved/).first(), 'the failure is announced').toBeVisible({ timeout: PEER_TIMEOUT });
  await expect(adaComposer.getByRole('textbox').first(), 'the failed block comment stays in the composer').toHaveText('Ada on the code');
  adaFails.on = false;
  await ada.page.keyboard.press(SUBMIT);
  await expect(adaComposer, 'the retry is taken').toBeHidden({ timeout: PEER_TIMEOUT });
  await expect.poll(() => storedAnchors(stack.baseUrl, id, cookie, ['Ada on the code', 'Ada on the words']), {
    message: "the owner's retried block comment is stored on the code block", timeout: PEER_TIMEOUT,
  }).toEqual([{ text: 'Ada on the code', kind: 'block', type: 'code-block' }, { text: 'Ada on the words', kind: 'text', type: null }]);

  // A commenter's failed block comment is kept as the block's draft when the composer closes, and reopening the
  // composer there offers the text again.
  const caraFails = await failableCommentPosts(cara, id);
  const [, chart] = (await blocksByType(cara, id))[1]!;
  await chart.scrollIntoViewIfNeeded();
  await chart.hover();
  caraFails.on = true;
  await blockCommentButton(chart).click({ force: true });
  const caraComposer = cara.page.getByRole('dialog', { name: 'Add comment' });
  await expect(caraComposer.getByRole('textbox').first()).toBeFocused();
  await cara.page.keyboard.type('Cara again on the chart');
  await cara.page.keyboard.press(SUBMIT);
  await expect(cara.page.getByText(/couldn't be saved/).first(), 'the failure is announced').toBeVisible({ timeout: PEER_TIMEOUT });
  await cara.page.keyboard.press('Escape');
  await expect(caraComposer).toBeHidden();
  caraFails.on = false;
  await chart.hover();
  await blockCommentButton(chart).click({ force: true });
  await expect(caraComposer.getByRole('textbox').first(), "reopening the block's composer offers the failed draft").toHaveText('Cara again on the chart');
  await caraComposer.getByRole('textbox').first().focus();
  await cara.page.keyboard.press(SUBMIT);
  await expect(caraComposer).toBeHidden({ timeout: PEER_TIMEOUT });
  await expect.poll(() => storedAnchors(stack.baseUrl, id, cookie, ['Cara again on the chart']), {
    message: "the commenter's draft is stored once, on the chart", timeout: PEER_TIMEOUT,
  }).toEqual([{ text: 'Cara again on the chart', kind: 'block', type: 'chart' }]);

  for (const [type, block] of await blocksByType(vic, id)) {
    await block.scrollIntoViewIfNeeded();
    await block.hover();
    await expect(blockCommentButton(block), `${type}: a viewer gets no block comment`).toHaveCount(0);
  }

  const { actor: dan, principal: danPrincipal } = await peer(actors, note, 'dan', 'commenter');
  const [, firstBlock] = (await blocksByType(dan, id))[0]!;
  await firstBlock.scrollIntoViewIfNeeded();
  await firstBlock.hover();
  await expect(blockCommentButton(firstBlock), 'a commenter is offered Add comment until access ends').toHaveCount(1);
  dan.expectHttp(404, /\/api\/docs\/[^/]+\/access/);
  const removed = await ada.context.request.delete(`/api/docs/${id}/members`, { headers: { origin: stack.baseUrl }, data: { principalId: danPrincipal.id } });
  expect(removed.ok(), 'the owner removes the commenter').toBe(true);
  await expect(ui.pane(dan, id), 'the note ends for the removed commenter in place').toHaveAttribute(TERMINAL_REASON_ATTR, 'revoked', { timeout: PEER_TIMEOUT });
  for (const [type, block] of await blocksByType(dan, id)) {
    await block.scrollIntoViewIfNeeded();
    await block.hover();
    await expect(blockCommentButton(block), `${type}: a revoked commenter gets no block comment`).toHaveCount(0);
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

/** The comment texts the server stores for the doc, sorted. */
async function storedTexts(baseUrl: string, docId: string, cookie: string): Promise<string[]> {
  const client = await openDocClient(baseUrl, docId, cookie);
  try {
    await client.synced;
    const out: string[] = [];
    for (const [key, value] of client.doc.getMap('comments')) {
      const text = (value as { text?: string } | null)?.text;
      if (key.startsWith('c:') && text) out.push(text);
    }
    return out.sort();
  } finally {
    client.close();
  }
}

test("j15-comments: a commenter's composers keep what the server did not take; a revision and overlapping submits each land once @p:mean-1 @p:ppl-2", async ({ actors, stack }) => {
  const note = await sharedNote(actors, stack.baseUrl);
  const { ada, id } = note;
  const { actor: cara } = await peer(actors, note, 'cara', 'commenter');
  const cookie = (await ada.context.cookies()).map((c) => `${c.name}=${c.value}`).join('; ');
  const stored = (message: string) => expect.poll(() => storedTexts(stack.baseUrl, id, cookie), { message, timeout: PEER_TIMEOUT });

  // Cara's create and reply POSTs: `lose` lets the server take the write and loses its answer, `fail` never sends it
  // (both answer a declared 408 timeout), `hold` keeps the next one waiting until the test releases it.
  let mode: 'pass' | 'lose' | 'fail' | 'hold' = 'pass';
  const sent: string[] = [];
  const held: (() => void)[] = [];
  const createPath = `/api/docs/${id}/comments`;
  cara.expectHttp(408, createPath);
  const timedOut = { status: 408, contentType: 'application/json', body: JSON.stringify({ error: 'timeout' }) };
  await cara.page.route((url) => url.pathname === createPath, async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    sent.push((route.request().postDataJSON() as { text: string }).text);
    const now = mode;
    if (now === 'hold') {
      mode = 'pass';
      await new Promise<void>((resolve) => held.push(resolve));
    }
    if (now === 'lose') {
      await route.fetch();
      return route.fulfill(timedOut);
    }
    if (now === 'fail') return route.fulfill(timedOut);
    return route.fallback();
  });
  const composer = cara.page.getByRole('dialog', { name: 'Add comment' });
  const composerBox = composer.getByRole('textbox').first();
  const replyBox = thread(cara).locator('[data-comment-reply-composer] [contenteditable="true"]');

  // A lost answer keeps the composer's text; Cara revises it, and the revision is what is stored.
  mode = 'lose';
  await selectDom(cara, id, 'lazy dog');
  await cara.page.keyboard.press(COMMENT_KEY);
  await expect(composerBox).toBeFocused();
  await cara.page.keyboard.type('Version one');
  await cara.page.keyboard.press(SUBMIT);
  await expect.poll(() => sent, { message: 'the first write went out' }).toEqual(['Version one']);
  await stored('the server took the write whose answer was lost').toEqual(['Version one']);
  await expect(composerBox, 'the composer keeps the text the server never answered for').toHaveText('Version one');
  mode = 'pass';
  await cara.page.keyboard.press('ControlOrMeta+a');
  await cara.page.keyboard.type('Version two');
  await cara.page.keyboard.press(SUBMIT);
  await expect(composer, 'the revision is taken and the composer closes').toBeHidden({ timeout: PEER_TIMEOUT });
  await stored('the lost write landed once, and the revision with its own text').toEqual(['Version one', 'Version two']);

  // Text typed while a submit is in flight is not cleared by that submit's answer.
  mode = 'hold';
  await selectDom(cara, id, 'quick brown');
  await cara.page.keyboard.press(COMMENT_KEY);
  await expect(composerBox).toBeFocused();
  await cara.page.keyboard.type('Held root');
  await cara.page.keyboard.press(SUBMIT);
  await expect.poll(() => held.length, { message: 'the root POST is held' }).toBe(1);
  await cara.page.keyboard.type(' plus more');
  held.shift()!();
  await stored('the held root lands').toEqual(['Held root', 'Version one', 'Version two']);
  await expect(composerBox, 'the newer text stays in the open composer').toHaveText('Held root plus more');
  await cara.page.keyboard.press(SUBMIT);
  await expect(composer).toBeHidden({ timeout: PEER_TIMEOUT });
  await stored('the newer text lands as its own comment').toEqual(['Held root', 'Held root plus more', 'Version one', 'Version two']);

  // A second reply sent while the first is still in flight is its own reply.
  await gutter(cara).first().click();
  await expect(replyBox, 'the reply composer autofocuses').toBeFocused();
  mode = 'hold';
  await cara.page.keyboard.type('Slow reply A');
  await cara.page.keyboard.press(SUBMIT);
  await expect.poll(() => held.length, { message: 'the first reply is held' }).toBe(1);
  await cara.page.keyboard.type('Quick reply B');
  await cara.page.keyboard.press(SUBMIT);
  await expect.poll(() => sent.slice(-2), { message: 'the second reply is sent too' }).toEqual(['Slow reply A', 'Quick reply B']);
  held.shift()!();
  await stored('both replies land').toEqual(['Held root', 'Held root plus more', 'Quick reply B', 'Slow reply A', 'Version one', 'Version two']);

  // A reply that never reached the server comes back to the box, and is offered again after the thread closes.
  mode = 'fail';
  await expect(replyBox).toBeFocused();
  await cara.page.keyboard.type('Lost reply');
  await cara.page.keyboard.press(SUBMIT);
  await expect(replyBox, 'the failed reply comes back to the box').toHaveText('Lost reply', { timeout: PEER_TIMEOUT });
  await cara.page.keyboard.press('Escape');
  await expect(thread(cara)).toBeHidden();
  mode = 'pass';
  await gutter(cara).first().click();
  await expect(replyBox, 'reopening the thread offers the failed reply again').toHaveText('Lost reply');
  await replyBox.click();
  await cara.page.keyboard.press(SUBMIT);
  await stored('the retried reply lands once')
    .toEqual(['Held root', 'Held root plus more', 'Lost reply', 'Quick reply B', 'Slow reply A', 'Version one', 'Version two']);

  // Two replies whose failures arrive in the same tick both come back to the box, and resubmitting it keeps both.
  await cara.page.evaluate((path) => {
    const w = window as unknown as { fetch: typeof fetch; holdReplies: boolean; heldReplies: (() => void)[] };
    const real = w.fetch.bind(window);
    w.holdReplies = true;
    w.heldReplies = [];
    w.fetch = (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input), location.href);
      if (!w.holdReplies || url.pathname !== path || init?.method !== 'POST') return real(input, init);
      return new Promise<Response>((resolve) => w.heldReplies.push(() =>
        resolve(new Response(JSON.stringify({ error: 'timeout' }), { status: 408, headers: { 'content-type': 'application/json' } }))));
    };
  }, createPath);
  const heldCount = () => cara.page.evaluate(() => (window as unknown as { heldReplies: unknown[] }).heldReplies.length);
  await expect(replyBox).toBeFocused();
  await cara.page.keyboard.type('Twin reply A');
  await cara.page.keyboard.press(SUBMIT);
  await expect.poll(heldCount, { message: 'the first reply is held' }).toBe(1);
  await cara.page.keyboard.type('Twin reply B');
  await cara.page.keyboard.press(SUBMIT);
  await expect.poll(heldCount, { message: 'the second reply is held' }).toBe(2);
  await cara.page.evaluate(() => {
    const w = window as unknown as { holdReplies: boolean; heldReplies: (() => void)[] };
    w.holdReplies = false;
    for (const release of w.heldReplies.splice(0)) release();
  });
  await expect(replyBox, 'the first failed reply is back').toContainText('Twin reply A', { timeout: PEER_TIMEOUT });
  await expect(replyBox, 'and so is the second').toContainText('Twin reply B');
  await replyBox.click();
  await cara.page.keyboard.press(SUBMIT);
  await expect.poll(async () => (await storedTexts(stack.baseUrl, id, cookie)).filter((text) => text.includes('Twin reply')), {
    message: "the resubmit stores both failed replies' text", timeout: PEER_TIMEOUT,
  }).toEqual([expect.stringMatching(/Twin reply A[\s\S]*Twin reply B/)]);
});

/**
 * Ada alone on a note with a code block, with a comment 'Original' on "quick brown", and a switch on her comment
 * writes per method: `fail` answers a declared 408 without reaching the server, `hold` waits for the test.
 */
async function heldWrites(actors: Actors, baseUrl: string) {
  actors.solo("one author's composers against her own held and failed writes; the stored records are read by a protocol client");
  const adaPrincipal = await actors.principal('ada');
  const ada = await actors.session(adaPrincipal);
  const seed = `${SEED}\n\n\`\`\`js\nconst answer = 42;\n\`\`\``;
  const created = await ada.context.request.post('/api/docs', { headers: { origin: baseUrl }, data: { markdown: seed } });
  expect(created.status()).toBe(201);
  const { doc: { id } } = await created.json() as { doc: { id: string } };
  await ada.goto(`/d/${id}`);
  await ui.waitLive(ada, id);
  await ada.observeEditor(id);
  const cookie = (await ada.context.cookies()).map((c) => `${c.name}=${c.value}`).join('; ');
  const stored = (message: string) => expect.poll(() => storedTexts(baseUrl, id, cookie), { message, timeout: PEER_TIMEOUT });
  const prefix = `/api/docs/${id}/comments`;
  const modes: Record<string, 'pass' | 'fail' | 'hold'> = { POST: 'pass', PATCH: 'pass' };
  const held: ((outcome: 'pass' | 'fail') => void)[] = [];
  ada.expectHttp(408, new RegExp(`^${prefix}(/[^/]+)?$`));
  const timedOut = { status: 408, contentType: 'application/json', body: JSON.stringify({ error: 'timeout' }) };
  await ada.page.route((url) => url.pathname === prefix || url.pathname.startsWith(`${prefix}/`), async (route) => {
    const method = route.request().method();
    let mode = modes[method] ?? 'pass';
    if (mode === 'hold') {
      modes[method] = 'pass';
      mode = await new Promise<'pass' | 'fail'>((resolve) => held.push(resolve));
    }
    return mode === 'fail' ? route.fulfill(timedOut) : route.fallback();
  });
  await select(ada, id, 'quick brown');
  await comment(ada, 'Original');
  await stored('the comment lands').toEqual(['Original']);
  return { ada, id, cookie, stored, modes, held };
}

test('j15-comments: a revert to the stored text, saved while the edit before it is in flight, is what lands @p:mean-1', async ({ actors, stack }) => {
  const { ada, stored, modes, held } = await heldWrites(actors, stack.baseUrl);
  const editBox = thread(ada).locator('[data-comment-edit-composer] [contenteditable="true"]');
  await gutter(ada).first().click();
  await thread(ada).locator('[data-comment-message]').filter({ hasText: 'Original' }).getByRole('button', { name: /^Comment actions for / }).click();
  await ada.page.getByRole('menuitem', { name: /^Edit / }).click();
  await expect(editBox).toBeFocused();
  modes.PATCH = 'hold';
  await ada.page.keyboard.press('ControlOrMeta+a');
  await ada.page.keyboard.type('Changed');
  await ada.page.keyboard.press(SUBMIT);
  await expect.poll(() => held.length, { message: 'the first save is held' }).toBe(1);
  await expect(editBox, 'edit mode stays open while the save is in flight').toBeFocused();
  await ada.page.keyboard.press('ControlOrMeta+a');
  await ada.page.keyboard.type('Original');
  await ada.page.keyboard.press(SUBMIT);
  held.shift()!('pass');
  await expect(editBox, 'edit mode closes once the last save is taken').toBeHidden({ timeout: PEER_TIMEOUT });
  await stored('the revert lands after the edit before it').toEqual(['Original']);
});

test('j15-comments: a failed edit resubmitted unchanged is sent again, and edit mode stays open until it lands @p:mean-1', async ({ actors, stack }) => {
  const { ada, stored, modes } = await heldWrites(actors, stack.baseUrl);
  const editBox = thread(ada).locator('[data-comment-edit-composer] [contenteditable="true"]');
  await gutter(ada).first().click();
  await thread(ada).locator('[data-comment-message]').filter({ hasText: 'Original' }).getByRole('button', { name: /^Comment actions for / }).click();
  await ada.page.getByRole('menuitem', { name: /^Edit / }).click();
  await expect(editBox).toBeFocused();
  modes.PATCH = 'fail';
  await ada.page.keyboard.press('ControlOrMeta+a');
  await ada.page.keyboard.type('Changed');
  await ada.page.keyboard.press(SUBMIT);
  await expect(ada.page.getByText(/couldn't be edited/).first(), 'the failure is announced').toBeVisible({ timeout: PEER_TIMEOUT });
  await expect(editBox, 'the failed edit stays open with its text').toHaveText('Changed');
  modes.PATCH = 'pass';
  await editBox.click();
  await ada.page.keyboard.press(SUBMIT);
  await expect(editBox, 'the unchanged retry is taken and edit mode closes').toBeHidden({ timeout: PEER_TIMEOUT });
  await stored('the retried edit lands').toEqual(['Changed']);
});

/** A reply's paragraphs, sorted: each failed reply the box took back is one. */
const paragraphs = (text: string) => text.split(/\s*\n\s*/).filter(Boolean).sort();

test("j15-comments: each failed reply comes back to the box on its own, even when its text is inside another's or the box's @p:mean-1", async ({ actors, stack }) => {
  const { ada, id, cookie, stored, modes, held } = await heldWrites(actors, stack.baseUrl);
  const replyBox = thread(ada).locator('[data-comment-reply-composer] [contenteditable="true"]');
  await gutter(ada).first().click();
  await expect(replyBox).toBeFocused();
  for (const [index, text] of ['not ready', 'ready', 'Thanks'].entries()) {
    modes.POST = 'hold';
    await ada.page.keyboard.type(text);
    await ada.page.keyboard.press(SUBMIT);
    await expect.poll(() => held.length, { message: `the reply "${text}" is held` }).toBe(index + 1);
  }
  await ada.page.keyboard.type('Thanks again for this');
  for (const release of held.splice(0)) release('fail');
  const all = ['Thanks', 'Thanks again for this', 'not ready', 'ready'];
  await expect.poll(async () => paragraphs(await replyBox.innerText()), { message: 'every failed reply is back beside what was typed', timeout: PEER_TIMEOUT })
    .toEqual(all);
  await replyBox.click();
  await ada.page.keyboard.press(SUBMIT);
  await stored('the resubmit lands as one reply').toHaveLength(2);
  const reply = (await storedTexts(stack.baseUrl, id, cookie)).find((text) => text !== 'Original') ?? '';
  expect(paragraphs(reply), 'it holds each failed reply once').toEqual(all);
  await ada.page.keyboard.press('Escape');
  await expect(thread(ada)).toBeHidden();
  await gutter(ada).first().click();
  await expect(replyBox).toBeFocused();
  await expect(replyBox, 'no failed reply is left to offer').toHaveText('');
});

test('j15-comments: a reply that fails after its thread was closed and reopened comes back to the reply box @p:mean-1', async ({ actors, stack }) => {
  const { ada, stored, modes, held } = await heldWrites(actors, stack.baseUrl);
  const replyBox = thread(ada).locator('[data-comment-reply-composer] [contenteditable="true"]');
  await gutter(ada).first().click();
  await expect(replyBox).toBeFocused();
  modes.POST = 'hold';
  await ada.page.keyboard.type('Slow reply');
  await ada.page.keyboard.press(SUBMIT);
  await expect.poll(() => held.length, { message: 'the reply is held' }).toBe(1);
  await ada.page.keyboard.press('Escape');
  await expect(thread(ada)).toBeHidden();
  await gutter(ada).first().click();
  await expect(replyBox).toBeFocused();
  held.shift()!('fail');
  await expect(replyBox, 'the reply that failed after the thread reopened comes back').toHaveText('Slow reply', { timeout: PEER_TIMEOUT });
  await ada.page.keyboard.press(SUBMIT);
  await stored('the reply is sent from the box once').toEqual(['Original', 'Slow reply']);
});

test('j15-comments: Cmd+Shift+A on a selected code block opens a block composer whose retry stays on the block @p:mean-1', async ({ actors, stack }) => {
  const { ada, id, cookie, modes } = await heldWrites(actors, stack.baseUrl);
  const key = await ui.body(ada, id).evaluate((element) => {
    const editor = (element as HTMLElement & { __lexicalEditor: LexicalEditor }).__lexicalEditor;
    return [...editor.getEditorState()._nodeMap.values()].find((node) => node.getType() === 'code-block')?.getKey() ?? '';
  });
  expect(key, 'the note renders a code block').not.toBe('');
  const code = ui.body(ada, id).locator(`[data-block-decorator-key="${key}"]`).first();
  await code.scrollIntoViewIfNeeded();
  // A click beside the code (its line numbers) selects the block itself; the code's own textarea keeps Cmd+A.
  await code.locator('.moss-codeblock-gutter').first().click();
  modes.POST = 'fail';
  await ada.page.keyboard.press(COMMENT_KEY);
  const composer = ada.page.getByRole('dialog', { name: 'Add comment' });
  await expect(composer.getByRole('textbox').first()).toBeFocused();
  await ada.page.keyboard.type('On the code');
  await ada.page.keyboard.press(SUBMIT);
  await expect(ada.page.getByText(/couldn't be saved/).first(), 'the failure is announced').toBeVisible({ timeout: PEER_TIMEOUT });
  await expect(composer.getByRole('textbox').first(), 'the failed comment stays in the composer').toHaveText('On the code');
  modes.POST = 'pass';
  await ada.page.keyboard.press(SUBMIT);
  await expect(composer, 'the retry is taken').toBeHidden({ timeout: PEER_TIMEOUT });
  await expect.poll(() => storedAnchors(stack.baseUrl, id, cookie, ['On the code']), {
    message: 'the retried comment is stored on the code block', timeout: PEER_TIMEOUT,
  }).toEqual([{ text: 'On the code', kind: 'block', type: 'code-block' }]);
});
