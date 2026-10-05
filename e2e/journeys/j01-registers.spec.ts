// j01-registers (T1.F4; docs/design/registers.md): a code block's field writes only what its user typed, against the
// payload as it is now. A peer joining mid-draft never costs the drafter a character; a field stays open while a peer
// moves its block, closes with a notice when a peer removes it, and stays read-only until its text has arrived.
import type { LexicalEditor } from 'lexical';
import type { Actor, Actors } from '../lib/actors.ts';
import { SYNC_UNACKED_ATTR } from '../lib/contract.ts';
import { expect, test, ui } from '../lib/test.ts';

const PEER_TIMEOUT = 10_000;

async function note(actors: Actors, baseUrl: string, markdown: string) {
  const ada = await actors.session(await actors.principal('ada'));
  const result = await ada.context.request.post('/api/docs', { headers: { origin: baseUrl }, data: { title: 'Registers', markdown } });
  expect(result.status()).toBe(201);
  const { doc: { id } } = await result.json() as { doc: { id: string } };
  const ben = await actors.principal('ben');
  expect((await ada.context.request.post(`/api/docs/${id}/members`, { headers: { origin: baseUrl }, data: { email: ben.email, role: 'editor' } })).status()).toBe(201);
  await ada.goto(`/d/${id}`);
  await ui.waitLive(ada, id); await ada.observeEditor(id);
  return { ada, ben, id };
}

async function join(actor: Actor, id: string) {
  await actor.goto(`/d/${id}`);
  await ui.waitLive(actor, id); await actor.observeEditor(id);
}

const field = (actor: Actor, id: string) => ui.body(actor, id).getByPlaceholder('Enter code...');
const openBlock = (actor: Actor, id: string) => ui.body(actor, id).locator('.moss-codeblock-pre').click();

/** Every code block's text as the editor holds it. */
const codes = (actor: Actor, id: string) => ui.body(actor, id).evaluate(element => {
  const editor = (element as HTMLElement & { __lexicalEditor: LexicalEditor }).__lexicalEditor;
  return editor.read(() => [...editor.getEditorState()._nodeMap.values()]
    .filter(n => n.getType() === 'code-block' && n.isAttached()).map(n => (n as unknown as { getCode(): string }).getCode()));
});

/** The body's top-level block types, in order. */
const blocks = (actor: Actor, id: string) => ui.body(actor, id).evaluate(element => {
  const editor = (element as HTMLElement & { __lexicalEditor: LexicalEditor }).__lexicalEditor;
  return editor.read(() => (editor.getEditorState()._nodeMap.get('root') as unknown as { getChildren(): { getType(): string }[] }).getChildren().map(n => n.getType()));
});

/** A peer's structural edit, through the editor: moves the code block (or the paragraph above it) to the end, or removes it. */
const restructure = (actor: Actor, id: string, change: 'move-block' | 'move-above' | 'remove') => ui.body(actor, id).evaluate((element, change) => {
  const editor = (element as HTMLElement & { __lexicalEditor: LexicalEditor }).__lexicalEditor;
  editor.update(() => {
    const children = (editor.getEditorState()._nodeMap.get('root') as unknown as { getLatest(): { getChildren(): { getType(): string; remove(): void; insertAfter(n: unknown): void }[] } }).getLatest().getChildren();
    const code = children.find(n => n.getType() === 'code-block')!;
    if (change === 'remove') code.remove();
    else children[children.length - 1].insertAfter(change === 'move-block' ? code : children[0]);
  }, { discrete: true });
}, change);

async function settled(actors: Actor[], id: string) {
  for (const actor of actors) await expect(ui.pane(actor, id), `${actor.label}: the DocDO acks every edit`).toHaveAttribute(SYNC_UNACKED_ATTR, '0', { timeout: PEER_TIMEOUT });
}

for (const stackState of ['warm', 'cold'] as const) {
  for (const ben of ['opens', 'types'] as const) {
    test(`j01 registers: Ada drafts a new code block, Ben joins mid-draft and ${ben === 'opens' ? 'opens it' : 'types into it'} (${stackState} stack); Ada's code survives both reloads @p:col-1`, async ({ actors, stack }) => {
      const { ada, ben: principal, id } = await note(actors, stack.baseUrl, 'Intro line.');
      await ui.body(ada, id).locator('p').filter({ hasText: /^Intro line/ }).click();
      await ada.page.keyboard.press('End');
      await ada.page.keyboard.press('Enter');
      await ada.page.keyboard.type('```');
      await ada.page.keyboard.press('Space');
      await expect(field(ada, id), 'the fence opens a focused code field').toBeFocused();
      await ada.page.keyboard.type('const ada = 1;\ndraft();', { delay: 20 });
      if (stackState === 'cold') {
        ada.expectReconnects(1, id);
        await stack.resetDoc(id);
      }
      const joiner = await actors.session(principal);
      await join(joiner, id);
      await openBlock(joiner, id);
      await expect(field(joiner, id), 'Ben sees the draft so far').toHaveValue('const ada = 1;\ndraft();', { timeout: PEER_TIMEOUT });
      const typing = [ada.page.keyboard.type('\nlater();', { delay: 40 })];
      if (ben === 'types') {
        await field(joiner, id).evaluate(input => (input as HTMLTextAreaElement).setSelectionRange(0, 0));
        typing.push(joiner.page.keyboard.type('// ben\n', { delay: 40 }));
      }
      await Promise.all(typing);
      const want = `${ben === 'types' ? '// ben\n' : ''}const ada = 1;\ndraft();\nlater();`;
      for (const actor of [ada, joiner]) await expect(field(actor, id), `${actor.label}'s field converges`).toHaveValue(want, { timeout: PEER_TIMEOUT });
      await ada.page.keyboard.press('ControlOrMeta+Enter');
      await joiner.page.keyboard.press('Escape');
      await expect(field(ada, id)).toHaveCount(0);
      await settled([ada, joiner], id);
      for (const actor of [ada, joiner]) {
        await actor.page.reload();
        await ui.waitLive(actor, id); await actor.declareRemount(id);
        await expect.poll(() => codes(actor, id), { message: `${actor.label}: Ada's code survives the reload`, timeout: PEER_TIMEOUT }).toEqual([want]);
      }
    });
  }
}

for (const change of ['move-block', 'move-above'] as const) {
  test(`j01 registers: Ben's open code field stays open, focused and typing while Ada ${change === 'move-block' ? 'moves the block' : 'moves the paragraph above it'} @p:col-1`, async ({ actors, stack }) => {
    const { ada, ben: principal, id } = await note(actors, stack.baseUrl, 'First para.\n\n```js\nseed\n```\n\nLast para.');
    const ben = await actors.session(principal);
    await join(ben, id);
    await openBlock(ben, id);
    await ben.page.keyboard.type('B1');
    await expect.poll(() => codes(ada, id), { timeout: PEER_TIMEOUT }).toEqual(['seedB1']);
    await restructure(ada, id, change);
    await expect.poll(() => blocks(ben, id), { message: 'Ben receives the move', timeout: PEER_TIMEOUT })
      .toEqual(change === 'move-block' ? ['paragraph', 'paragraph', 'code-block'] : ['code-block', 'paragraph', 'paragraph']);
    await expect(field(ben, id), 'the field follows its block').toBeFocused();
    await expect(field(ben, id)).toHaveValue('seedB1');
    await ben.page.keyboard.type('B2');
    for (const actor of [ada, ben]) await expect.poll(() => codes(actor, id), { message: `${actor.label}: no keystroke is lost`, timeout: PEER_TIMEOUT }).toEqual(['seedB1B2']);
  });
}

test('j01 registers: when Ada removes the block Ben is editing, his field closes with a notice @p:col-1', async ({ actors, stack }) => {
  const { ada, ben: principal, id } = await note(actors, stack.baseUrl, 'First para.\n\n```js\nseed\n```\n\nLast para.');
  const ben = await actors.session(principal);
  await join(ben, id);
  await openBlock(ben, id);
  await expect(field(ben, id)).toBeFocused();
  await restructure(ada, id, 'remove');
  await expect(field(ben, id), 'the field closes').toHaveCount(0, { timeout: PEER_TIMEOUT });
  await expect(ben.page.locator('[data-input-refusal]'), 'a visible notice says why').toContainText('removed');
});

test('j01 registers: a code field is read-only until its text arrives, then takes typing @p:col-1', async ({ actors, stack }) => {
  const { ada, ben: principal, id } = await note(actors, stack.baseUrl, 'Intro.\n\n```js\nseed\n```');
  const ben = await actors.session(principal, { severable: true });
  ben.sever!.holdPayloads();
  await join(ben, id);
  await openBlock(ben, id);
  await expect(field(ben, id), 'no text yet: the field cannot be typed into').toHaveJSProperty('readOnly', true);
  await ben.page.keyboard.type('early');
  await expect(field(ben, id)).not.toHaveValue(/early/);
  ben.sever!.releasePayloads();
  await expect(field(ben, id), 'the text arrives').toHaveValue('seed', { timeout: PEER_TIMEOUT });
  await expect(field(ben, id)).toHaveJSProperty('readOnly', false);
  await field(ben, id).focus();
  await field(ben, id).evaluate(input => (input as HTMLTextAreaElement).setSelectionRange(4, 4));
  await ben.page.keyboard.type('!');
  for (const actor of [ada, ben]) await expect.poll(() => codes(actor, id), { timeout: PEER_TIMEOUT }).toEqual(['seed!']);
});
