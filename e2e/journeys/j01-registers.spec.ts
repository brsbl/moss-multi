// j01-registers (T1.F4; docs/design/registers.md): a code block's field writes only what its user typed, against the
// payload as it is now. A peer joining mid-draft never costs the drafter a character; a field stays open while a peer
// moves its block, closes with a notice when a peer removes it, and stays read-only until its text has arrived. The
// formula popover does the same for its formula.
import type { Locator } from '@playwright/test';
import type { LexicalEditor } from 'lexical';
import type { Actor, Actors } from '../lib/actors.ts';
import { grantDoc } from '../lib/grants.ts';
import { expect, test, ui } from '../lib/test.ts';

const PEER_TIMEOUT = 10_000;

async function note(actors: Actors, baseUrl: string, markdown: string) {
  const ada = await actors.session(await actors.principal('ada'));
  const result = await ada.context.request.post('/api/docs', { headers: { origin: baseUrl }, data: { title: 'Registers', markdown } });
  expect(result.status()).toBe(201);
  const { doc: { id } } = await result.json() as { doc: { id: string } };
  const ben = await actors.principal('ben');
  await grantDoc(ada, id, ben);
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
/** The field takes typing only once its payload has arrived; until then it is read-only by design. */
const writable = (actor: Actor, id: string) => expect(field(actor, id), `${actor.label}: the field is writable`).toHaveJSProperty('readOnly', false, { timeout: PEER_TIMEOUT });

/** Every code block's text as the editor holds it. */
const codes = (actor: Actor, id: string) => payloadTexts(actor, id, 'code-block', 'getCode');

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
  for (const actor of actors) await ui.waitAcked(actor, id, PEER_TIMEOUT);
}

for (const stackState of ['warm', 'cold'] as const) {
  for (const ben of ['opens', 'types'] as const) {
    // local-only: the cold variant resets the DO through the loopback hook.
    test(`j01 registers: Ada drafts a new code block, Ben joins mid-draft and ${ben === 'opens' ? 'opens it' : 'types into it'} (${stackState} stack); Ada's code survives both reloads${stackState === 'cold' ? ' @local-only' : ''} @p:col-1`, async ({ actors, stack }) => {
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
      await writable(joiner, id);
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
      await reloadHolds([ada, joiner], id, actor => codes(actor, id), [want]);
    });
  }
}

for (const change of ['move-block', 'move-above'] as const) {
  test(`j01 registers: Ben's open code field stays open, focused and typing while Ada ${change === 'move-block' ? 'moves the block' : 'moves the paragraph above it'} @p:col-1`, async ({ actors, stack }) => {
    const { ada, ben: principal, id } = await note(actors, stack.baseUrl, 'First para.\n\n```js\nseed\n```\n\nLast para.');
    const ben = await actors.session(principal);
    await join(ben, id);
    await openBlock(ben, id);
    await expect(field(ben, id)).toHaveValue('seed', { timeout: PEER_TIMEOUT });
    await writable(ben, id);
    await expect(field(ben, id)).toBeFocused();
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
  await expect(field(ben, id), 'the field keeps focus through the arrival').toBeFocused();
  await expect.poll(() => field(ben, id).evaluate(input => [(input as HTMLTextAreaElement).selectionStart, (input as HTMLTextAreaElement).selectionEnd]), { message: 'the caret stays at the end of the arrived text' }).toEqual([4, 4]);
  await ben.page.keyboard.type('!');
  for (const actor of [ada, ben]) await expect.poll(() => codes(actor, id), { timeout: PEER_TIMEOUT }).toEqual(['seed!']);
});

const popover = (actor: Actor) => actor.page.getByRole('dialog', { name: /^Edit (formula|variable)$/ });
const formulaInput = (actor: Actor) => popover(actor).getByLabel(/^(Formula expression|Variable value)$/);
const openFormula = (actor: Actor, id: string) => ui.body(actor, id).locator('[data-formula-node-key]').click();

/** Every formula's stored source and result, as the editor holds them. */
const formulas = (actor: Actor, id: string) => ui.body(actor, id).evaluate(element => {
  const editor = (element as HTMLElement & { __lexicalEditor: LexicalEditor }).__lexicalEditor;
  return editor.read(() => [...editor.getEditorState()._nodeMap.values()]
    .filter(n => n.getType() === 'formula' && n.isAttached())
    .map(n => { const f = n as unknown as { getFormula(): string; getResult(): string }; return [f.getFormula(), f.getResult()]; }));
});

/** Every formula's name, as the editor holds it. */
const names = (actor: Actor, id: string) => ui.body(actor, id).evaluate(element => {
  const editor = (element as HTMLElement & { __lexicalEditor: LexicalEditor }).__lexicalEditor;
  return editor.read(() => [...editor.getEditorState()._nodeMap.values()]
    .filter(n => n.getType() === 'formula' && n.isAttached())
    .map(n => (n as unknown as { getName(): string | null }).getName()));
});
const nameInput = (actor: Actor) => popover(actor).getByLabel('Formula name');

/** After every actor reloads, `read` holds `want`, and with `name` given (null included) the formula's name is `name`. */
async function reloadHolds(actors: Actor[], id: string, read: (actor: Actor) => Promise<unknown>, want: unknown, name?: string | null) {
  await settled(actors, id);
  for (const actor of actors) {
    // Off the pill, so its hover card does not open over the reloaded canvas.
    await actor.page.mouse.move(1, 1);
    await actor.page.reload();
    await ui.waitLive(actor, id); await actor.declareRemount(id);
    await expect.poll(() => read(actor), { message: `${actor.label}: the edit survives the reload`, timeout: PEER_TIMEOUT }).toEqual(want);
    if (name !== undefined) await expect.poll(() => names(actor, id), { message: `${actor.label}: the name survives the reload`, timeout: PEER_TIMEOUT }).toEqual([name]);
  }
}

/** The index of the top-level block holding the formula. */
const formulaBlock = (actor: Actor, id: string) => ui.body(actor, id).evaluate(element => {
  const editor = (element as HTMLElement & { __lexicalEditor: LexicalEditor }).__lexicalEditor;
  type Block = { getChildren?(): { getType(): string }[] };
  return editor.read(() => (editor.getEditorState()._nodeMap.get('root') as unknown as { getChildren(): Block[] }).getChildren()
    .findIndex(n => n.getChildren?.().some(c => c.getType() === 'formula')));
});

/** A peer's structural edit, through the editor: moves the paragraph holding the formula to the end, or removes it. */
const restructureFormula = (actor: Actor, id: string, change: 'move' | 'remove') => ui.body(actor, id).evaluate((element, change) => {
  const editor = (element as HTMLElement & { __lexicalEditor: LexicalEditor }).__lexicalEditor;
  editor.update(() => {
    type Block = { getChildren?(): { getType(): string }[]; remove(): void; insertAfter(n: unknown): void };
    const children = (editor.getEditorState()._nodeMap.get('root') as unknown as { getLatest(): { getChildren(): Block[] } }).getLatest().getChildren();
    const holder = children.find(n => n.getChildren?.().some(c => c.getType() === 'formula'))!;
    if (change === 'remove') holder.remove();
    else children[children.length - 1].insertAfter(holder);
  }, { discrete: true });
}, change);

test("j01 registers: Ben's open formula popover stays open, focused and writing while Ada moves its paragraph @p:col-1", async ({ actors, stack }) => {
  const { ada, ben: principal, id } = await note(actors, stack.baseUrl, 'First para.\n\nTotal {{2+3|5}} here.\n\nLast para.');
  const ben = await actors.session(principal);
  await join(ben, id);
  await openFormula(ben, id);
  await expect(formulaInput(ben)).toHaveValue('2+3', { timeout: PEER_TIMEOUT });
  await expect(formulaInput(ben)).toHaveJSProperty('readOnly', false, { timeout: PEER_TIMEOUT });
  await expect(formulaInput(ben)).toBeFocused();
  await formulaInput(ben).press('End');
  await ben.page.keyboard.type('+1');
  await expect.poll(() => formulas(ada, id), { timeout: PEER_TIMEOUT }).toEqual([['2+3+1', '6']]);
  await restructureFormula(ada, id, 'move');
  await expect.poll(() => formulaBlock(ben, id), { message: 'Ben receives the move', timeout: PEER_TIMEOUT }).toBe(2);
  await expect(popover(ben), 'the popover stays open').toBeVisible();
  await expect(formulaInput(ben), 'the popover follows its formula').toHaveJSProperty('readOnly', false);
  await expect(formulaInput(ben)).toBeFocused();
  await expect(formulaInput(ben)).toHaveValue('2+3+1');
  await ben.page.keyboard.type('+2');
  for (const actor of [ada, ben]) await expect.poll(async () => (await formulas(actor, id)).map(([formula]) => formula), { message: `${actor.label}: no keystroke is lost`, timeout: PEER_TIMEOUT }).toEqual(['2+3+1+2']);
});

test('j01 registers: when Ada removes the paragraph holding the formula Ben is editing, his popover closes with a notice @p:col-1', async ({ actors, stack }) => {
  const { ada, ben: principal, id } = await note(actors, stack.baseUrl, 'First para.\n\nTotal {{2+3|5}} here.\n\nLast para.');
  const ben = await actors.session(principal);
  await join(ben, id);
  await openFormula(ben, id);
  await expect(formulaInput(ben)).toBeFocused();
  await restructureFormula(ada, id, 'remove');
  await expect(popover(ben), 'the popover closes').toHaveCount(0, { timeout: PEER_TIMEOUT });
  await expect(ben.page.locator('[data-input-refusal]'), 'a visible notice says why').toContainText('removed');
});

test("j01 registers: Ben's edit to the formula merges into Ada's unfinished draft, keeping her characters and caret, and both converge after reload @p:col-1", async ({ actors, stack }) => {
  const { ada, ben: principal, id } = await note(actors, stack.baseUrl, 'Total {{2+3|5}} here.');
  const ben = await actors.session(principal);
  await join(ben, id);
  const caret = (actor: Actor) => formulaInput(actor).evaluate(input => [(input as HTMLInputElement).selectionStart, (input as HTMLInputElement).selectionEnd]);
  await openFormula(ada, id);
  await expect(formulaInput(ada)).toHaveJSProperty('readOnly', false, { timeout: PEER_TIMEOUT });
  await formulaInput(ada).press('End');
  await ada.page.keyboard.type('*(1+');
  await expect(formulaInput(ada)).toHaveValue('2+3*(1+');
  await openFormula(ben, id);
  await expect(formulaInput(ben), "Ada's unfinished formula is not written").toHaveValue('2+3', { timeout: PEER_TIMEOUT });
  await expect(formulaInput(ben)).toHaveJSProperty('readOnly', false, { timeout: PEER_TIMEOUT });
  await formulaInput(ben).press('Home');
  await ben.page.keyboard.type('1');
  await expect.poll(() => formulas(ada, id), { message: "Ada receives Ben's edit", timeout: PEER_TIMEOUT }).toEqual([['12+3', '15']]);
  await expect(formulaInput(ada), "Ada's field keeps her characters and takes Ben's").toHaveValue('12+3*(1+');
  await expect(formulaInput(ada)).toBeFocused();
  await expect.poll(() => caret(ada), { message: "Ada's caret stays after her text" }).toEqual([8, 8]);
  await ada.page.keyboard.type('1)');
  const want = [['12+3*(1+1)', '18']];
  for (const actor of [ada, ben]) await expect.poll(() => formulas(actor, id), { message: `${actor.label}: neither person's text is lost`, timeout: PEER_TIMEOUT }).toEqual(want);
  await expect(formulaInput(ben)).toHaveValue('12+3*(1+1)');
  await ada.page.keyboard.press('Enter');
  await ben.page.keyboard.press('Escape');
  await expect(popover(ada)).toHaveCount(0);
  await reloadHolds([ada, ben], id, actor => formulas(actor, id), want);
});

/** Ada's unfinished '*2+3', made valid as '1*2+3' by Ben's '1', with the note still holding Ben's '12+3'. */
async function mergedValidDraft(actors: Actors, baseUrl: string) {
  const { ada, ben: principal, id } = await note(actors, baseUrl, 'Total {{2+3|5}} here.');
  const ben = await actors.session(principal);
  await join(ben, id);
  await openFormula(ada, id);
  await expect(formulaInput(ada)).toHaveJSProperty('readOnly', false, { timeout: PEER_TIMEOUT });
  await formulaInput(ada).press('Home');
  await ada.page.keyboard.type('*');
  await expect(formulaInput(ada)).toHaveValue('*2+3');
  await openFormula(ben, id);
  await expect(formulaInput(ben)).toHaveJSProperty('readOnly', false, { timeout: PEER_TIMEOUT });
  await formulaInput(ben).press('Home');
  await ben.page.keyboard.type('1');
  await expect(formulaInput(ada), "Ben's edit makes Ada's draft valid").toHaveValue('1*2+3', { timeout: PEER_TIMEOUT });
  await ben.page.keyboard.press('Escape');
  for (const actor of [ada, ben]) await expect.poll(() => formulas(actor, id), { message: `${actor.label}: the merge writes nothing before Ada acts`, timeout: PEER_TIMEOUT }).toEqual([['12+3', '15']]);
  return { ada, ben, id };
}

// As moss's popover at the pin: Enter and Apply accept a valid draft, an outside click keeps one (moss has written it
// live already), while Escape and Dismiss close on what is stored. Here the one valid draft not yet written is one a
// peer's edit made valid; the merge itself writes nothing until Ada acts.
for (const close of ['Enter', 'Apply', 'an outside click', 'Escape', 'Dismiss'] as const) {
  const writes = close !== 'Escape' && close !== 'Dismiss';
  test(`j01 registers: when Ben's edit makes Ada's unfinished formula valid, ${close} ${writes ? 'writes' : 'discards'} her draft @p:col-1`, async ({ actors, stack }) => {
    const { ada, ben, id } = await mergedValidDraft(actors, stack.baseUrl);
    if (close === 'Enter') await ada.page.keyboard.press('Enter');
    else if (close === 'Apply') await popover(ada).getByRole('button', { name: 'Apply formula changes' }).click();
    else if (close === 'Escape') await ada.page.keyboard.press('Escape');
    else if (close === 'Dismiss') await popover(ada).getByRole('button', { name: 'Dismiss formula editor' }).click();
    else await ui.body(ada, id).locator('[data-lexical-text]').filter({ hasText: 'here.' }).click();
    await expect(popover(ada)).toHaveCount(0);
    const want = writes ? [['1*2+3', '5']] : [['12+3', '15']];
    for (const actor of [ada, ben]) await expect.poll(() => formulas(actor, id), { message: `${actor.label}: ${close} ${writes ? 'writes' : 'discards'} Ada's draft`, timeout: PEER_TIMEOUT }).toEqual(want);
    await reloadHolds([ada, ben], id, actor => formulas(actor, id), want);
  });
}

// The draft is compared with the stored formula, reference tokens included: picking the other `cost` from the typeahead
// leaves the display text as it was, but it is a change, and it is written.
test('j01 registers: picking the other same-named reference from the typeahead is written and survives a reload @p:col-1', async ({ actors, stack }) => {
  const a = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const b = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const { ada, ben: principal, id } = await note(actors, stack.baseUrl, `Total {{2|2}} here.\n\nA {{4|4|id=${a};name=cost}} here.\n\nB {{9|9|id=${b};name=cost}} here.`);
  const ben = await actors.session(principal);
  await join(ben, id);
  const openTotal = (actor: Actor) => ui.body(actor, id).locator('[data-formula-node-key]').first().click();
  const total = async (actor: Actor) => (await formulas(actor, id)).filter(([formula]) => formula !== '4' && formula !== '9');
  const refersTo = (formulaId: string) => new RegExp(`^@\\(cost#[^#)]+#${formulaId}\\)\\+2$`);
  await openTotal(ada);
  await expect(formulaInput(ada)).toHaveValue('2', { timeout: PEER_TIMEOUT });
  await expect(formulaInput(ada)).toHaveJSProperty('readOnly', false, { timeout: PEER_TIMEOUT });
  await formulaInput(ada).press('ControlOrMeta+a');
  await ada.page.keyboard.type('cos');
  await expect(popover(ada).getByRole('option'), 'both formulas named cost are offered').toHaveCount(2);
  await popover(ada).getByRole('option').filter({ hasText: '4' }).click();
  await expect(formulaInput(ada)).toHaveValue('cost');
  await ada.page.keyboard.type('+2');
  await expect.poll(async () => (await total(ada))[0]?.[0] ?? '', { message: 'Ada refers to A', timeout: PEER_TIMEOUT }).toMatch(refersTo(a));
  await ada.page.keyboard.press('Enter');
  await expect(popover(ada)).toHaveCount(0);
  await openTotal(ada);
  await expect(formulaInput(ada)).toHaveValue('cost+2', { timeout: PEER_TIMEOUT });
  await formulaInput(ada).press('Home');
  for (let i = 0; i < 4; i += 1) await formulaInput(ada).press('ArrowRight');
  await formulaInput(ada).press('Backspace');
  await expect(formulaInput(ada)).toHaveValue('cos+2');
  await popover(ada).getByRole('option').filter({ hasText: '9' }).click();
  await expect(formulaInput(ada), 'the display text is back where it started').toHaveValue('cost+2');
  for (const actor of [ada, ben]) {
    await expect.poll(async () => (await total(actor))[0]?.[0] ?? '', { message: `${actor.label}: the pick of B is written`, timeout: PEER_TIMEOUT }).toMatch(refersTo(b));
    await expect.poll(async () => (await total(actor))[0]?.[1] ?? '', { message: `${actor.label}: the result follows B`, timeout: PEER_TIMEOUT }).toBe('11');
  }
  await formulaInput(ada).press('Enter');
  await expect(popover(ada)).toHaveCount(0);
  await reloadHolds([ada, ben], id, async actor => (await total(actor))[0]?.[0] ?? '', expect.stringMatching(refersTo(b)));
});

// Each reference token merges whole: when Ada's unwritten draft retargets A to B and Ben retargets A to C, Ada's field
// keeps both references (Ben's first), never one token spliced from the two.
test('j01 registers: when both people retarget the same reference and one draft is unwritten, each token is kept whole @p:col-1', async ({ actors, stack }) => {
  const [a, b, c] = ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'];
  const { ada, ben: principal, id } = await note(actors, stack.baseUrl, `Total {{2|2}} here.\n\nA {{4|4|id=${a};name=cost}} here.\n\nB {{9|9|id=${b};name=cost}} here.\n\nC {{7|7|id=${c};name=cost}} here.`);
  const ben = await actors.session(principal);
  await join(ben, id);
  const openTotal = (actor: Actor) => ui.body(actor, id).locator('[data-formula-node-key]').first().click();
  const total = async (actor: Actor) => (await formulas(actor, id)).filter(([formula]) => !['4', '9', '7'].includes(formula))[0] ?? ['', ''];
  const refersTo = (formulaId: string) => new RegExp(`^@\\(cost#[^#)]+#${formulaId}\\)\\+2$`);
  /** Replaces the `t` of the leading `cost` and picks the formula whose result is `result` from the typeahead. */
  const retarget = async (actor: Actor, result: string) => {
    await formulaInput(actor).press('Home');
    for (let i = 0; i < 4; i += 1) await formulaInput(actor).press('ArrowRight');
    await formulaInput(actor).press('Backspace');
    await expect(formulaInput(actor)).toHaveValue('cos+2');
    await popover(actor).getByRole('option').filter({ hasText: result }).click();
    await expect(formulaInput(actor)).toHaveValue('cost+2');
  };
  await openTotal(ada);
  await expect(formulaInput(ada)).toHaveJSProperty('readOnly', false, { timeout: PEER_TIMEOUT });
  await formulaInput(ada).press('ControlOrMeta+a');
  await ada.page.keyboard.type('cos');
  await popover(ada).getByRole('option').filter({ hasText: '4' }).click();
  await ada.page.keyboard.type('+2');
  await ada.page.keyboard.press('Enter');
  await expect(popover(ada)).toHaveCount(0);
  for (const actor of [ada, ben]) await expect.poll(async () => (await total(actor))[0], { message: `${actor.label}: the total refers to A`, timeout: PEER_TIMEOUT }).toMatch(refersTo(a));
  await openTotal(ada);
  await expect(popover(ada), "the total's editor opens again").toBeVisible();
  await expect(formulaInput(ada), 'and takes input').toHaveJSProperty('readOnly', false, { timeout: PEER_TIMEOUT });
  await expect(formulaInput(ada)).toHaveValue('cost+2', { timeout: PEER_TIMEOUT });
  // An unfinished name holds Ada's draft unwritten.
  await nameInput(ada).fill('1');
  await retarget(ada, '9');
  await openTotal(ben);
  await expect(formulaInput(ben)).toHaveValue('cost+2', { timeout: PEER_TIMEOUT });
  await expect(formulaInput(ben)).toHaveJSProperty('readOnly', false, { timeout: PEER_TIMEOUT });
  await retarget(ben, '7');
  for (const actor of [ada, ben]) await expect.poll(() => total(actor), { message: `${actor.label}: Ben's pick of C is written`, timeout: PEER_TIMEOUT }).toEqual([expect.stringMatching(refersTo(c)), '9']);
  await ben.page.keyboard.press('Escape');
  await expect(formulaInput(ada), "Ada's field keeps Ben's reference and her own, each whole").toHaveValue('costcost+2', { timeout: PEER_TIMEOUT });
  await formulaInput(ada).press('Home');
  for (let i = 0; i < 4; i += 1) await formulaInput(ada).press('Delete');
  await expect(formulaInput(ada)).toHaveValue('cost+2');
  await nameInput(ada).fill('total');
  for (const actor of [ada, ben]) await expect.poll(() => total(actor), { message: `${actor.label}: the reference Ada kept is her pick of B`, timeout: PEER_TIMEOUT }).toEqual([expect.stringMatching(refersTo(b)), '11']);
  await nameInput(ada).press('Enter');
  await expect(popover(ada)).toHaveCount(0);
  await reloadHolds([ada, ben], id, async actor => (await total(actor))[0], expect.stringMatching(refersTo(b)));
});

test("j01 registers: Ben's rename survives Ada's merge of his formula edit into her unfinished draft @p:col-1", async ({ actors, stack }) => {
  const { ada, ben: principal, id } = await note(actors, stack.baseUrl, 'Total {{2+3|5}} here.');
  const ben = await actors.session(principal);
  await join(ben, id);
  await openFormula(ada, id);
  await expect(formulaInput(ada)).toHaveJSProperty('readOnly', false, { timeout: PEER_TIMEOUT });
  await formulaInput(ada).press('Home');
  await ada.page.keyboard.type('*');
  await expect(formulaInput(ada)).toHaveValue('*2+3');
  await openFormula(ben, id);
  await expect(formulaInput(ben)).toHaveJSProperty('readOnly', false, { timeout: PEER_TIMEOUT });
  await popover(ben).getByLabel('Formula name').fill('total');
  await expect.poll(() => names(ada, id), { message: "Ada receives Ben's rename", timeout: PEER_TIMEOUT }).toEqual(['total']);
  await formulaInput(ben).press('Home');
  await ben.page.keyboard.type('1');
  await expect(formulaInput(ada), "Ben's edit makes Ada's draft valid").toHaveValue('1*2+3', { timeout: PEER_TIMEOUT });
  await expect(popover(ada).getByLabel('Formula name'), "Ada's popover shows Ben's rename").toHaveValue('total');
  for (const actor of [ada, ben]) await expect.poll(() => formulas(actor, id), { message: `${actor.label}: the merge writes nothing before Ada accepts`, timeout: PEER_TIMEOUT }).toEqual([['12+3', '15']]);
  await ben.page.keyboard.press('Escape');
  await ada.page.keyboard.press('Enter');
  await expect(popover(ada)).toHaveCount(0);
  await reloadHolds([ada, ben], id, actor => formulas(actor, id), [['1*2+3', '5']], 'total');
});

// The popover writes only the fields the person changed: a field they left alone takes a peer's change and is never
// written back from what the popover showed.
for (const accept of ['Enter', 'Apply'] as const) {
  test(`j01 registers: Ben's rename after his edit merged into Ada's draft survives Ada accepting it with ${accept} @p:col-1`, async ({ actors, stack }) => {
    const { ada, ben: principal, id } = await note(actors, stack.baseUrl, 'Total {{2+3|5}} here.');
    const ben = await actors.session(principal);
    await join(ben, id);
    await openFormula(ada, id);
    await expect(formulaInput(ada)).toHaveJSProperty('readOnly', false, { timeout: PEER_TIMEOUT });
    await formulaInput(ada).press('Home');
    await ada.page.keyboard.type('*');
    await expect(formulaInput(ada)).toHaveValue('*2+3');
    await openFormula(ben, id);
    await expect(formulaInput(ben)).toHaveJSProperty('readOnly', false, { timeout: PEER_TIMEOUT });
    await formulaInput(ben).press('Home');
    await ben.page.keyboard.type('1');
    await expect(formulaInput(ada), "Ben's edit makes Ada's draft valid").toHaveValue('1*2+3', { timeout: PEER_TIMEOUT });
    await nameInput(ben).fill('total');
    await ben.page.keyboard.press('Escape');
    await expect.poll(() => names(ada, id), { message: "Ada receives Ben's rename", timeout: PEER_TIMEOUT }).toEqual(['total']);
    await expect(nameInput(ada), "Ada's untouched name takes Ben's rename").toHaveValue('total');
    if (accept === 'Enter') await ada.page.keyboard.press('Enter');
    else await popover(ada).getByRole('button', { name: 'Apply formula changes' }).click();
    await expect(popover(ada)).toHaveCount(0);
    for (const actor of [ada, ben]) await expect.poll(() => formulas(actor, id), { message: `${actor.label}: Ada's '*' is written`, timeout: PEER_TIMEOUT }).toEqual([['1*2+3', '5']]);
    for (const actor of [ada, ben]) await expect.poll(() => names(actor, id), { message: `${actor.label}: Ben's rename is kept`, timeout: PEER_TIMEOUT }).toEqual(['total']);
    await reloadHolds([ada, ben], id, actor => formulas(actor, id), [['1*2+3', '5']], 'total');
  });
}

test("j01 registers: Ada edits only the expression while Ben renames the formula; her next keystroke and Enter keep his name @p:col-1", async ({ actors, stack }) => {
  const { ada, ben: principal, id } = await note(actors, stack.baseUrl, 'Total {{2+3|5}} here.');
  const ben = await actors.session(principal);
  await join(ben, id);
  await openFormula(ada, id);
  await expect(formulaInput(ada)).toHaveJSProperty('readOnly', false, { timeout: PEER_TIMEOUT });
  await formulaInput(ada).press('End');
  await ada.page.keyboard.type('+1');
  await expect.poll(() => formulas(ben, id), { message: "Ben receives Ada's edit", timeout: PEER_TIMEOUT }).toEqual([['2+3+1', '6']]);
  await openFormula(ben, id);
  await expect(formulaInput(ben)).toHaveJSProperty('readOnly', false, { timeout: PEER_TIMEOUT });
  await nameInput(ben).fill('total');
  await ben.page.keyboard.press('Escape');
  await expect.poll(() => names(ada, id), { message: "Ada receives Ben's rename", timeout: PEER_TIMEOUT }).toEqual(['total']);
  await expect(nameInput(ada), "Ada's untouched name takes Ben's rename").toHaveValue('total');
  await expect(formulaInput(ada)).toBeFocused();
  await ada.page.keyboard.type('+2');
  for (const actor of [ada, ben]) await expect.poll(() => formulas(actor, id), { message: `${actor.label}: Ada's keystroke is written`, timeout: PEER_TIMEOUT }).toEqual([['2+3+1+2', '8']]);
  for (const actor of [ada, ben]) await expect.poll(() => names(actor, id), { message: `${actor.label}: Ada's keystroke keeps Ben's rename`, timeout: PEER_TIMEOUT }).toEqual(['total']);
  await ada.page.keyboard.press('Enter');
  await expect(popover(ada)).toHaveCount(0);
  await reloadHolds([ada, ben], id, actor => formulas(actor, id), [['2+3+1+2', '8']], 'total');
});

test("j01 registers: Ada renames the formula while Ben edits its expression; both survive her Enter @p:col-1", async ({ actors, stack }) => {
  const { ada, ben: principal, id } = await note(actors, stack.baseUrl, 'Total {{2+3|5}} here.');
  const ben = await actors.session(principal);
  await join(ben, id);
  await openFormula(ada, id);
  await expect(formulaInput(ada)).toHaveJSProperty('readOnly', false, { timeout: PEER_TIMEOUT });
  await openFormula(ben, id);
  await expect(formulaInput(ben)).toHaveJSProperty('readOnly', false, { timeout: PEER_TIMEOUT });
  await nameInput(ada).fill('sum');
  await expect.poll(() => names(ben, id), { message: "Ben receives Ada's rename", timeout: PEER_TIMEOUT }).toEqual(['sum']);
  await formulaInput(ben).press('End');
  await ben.page.keyboard.type('*2');
  await expect(formulaInput(ada), "Ada's untouched expression takes Ben's edit").toHaveValue('2+3*2', { timeout: PEER_TIMEOUT });
  await ben.page.keyboard.press('Escape');
  await expect(nameInput(ada)).toHaveValue('sum');
  await nameInput(ada).press('Enter');
  await expect(popover(ada)).toHaveCount(0);
  for (const actor of [ada, ben]) await expect.poll(() => formulas(actor, id), { message: `${actor.label}: Ben's edit is kept`, timeout: PEER_TIMEOUT }).toEqual([['2+3*2', '8']]);
  await reloadHolds([ada, ben], id, actor => formulas(actor, id), [['2+3*2', '8']], 'sum');
});

// A reference Ben wrote keeps its identity through Ada's merge: her write never re-resolves his token by name, which
// would bind it to this note's own `cost` instead of the other note's.
test("j01 registers: Ben's reference to another note's formula keeps its identity when Ada writes the merged draft @p:col-1", async ({ actors, stack }) => {
  const token = '@(cost#11111111-1111-4111-8111-111111111111#22222222-2222-4222-8222-222222222222)';
  const { ada, ben: principal, id } = await note(actors, stack.baseUrl, 'Total {{2+3|5}} here.\n\nCost {{4|4|id=33333333-3333-4333-8333-333333333333;name=cost}} here.');
  const ben = await actors.session(principal);
  await join(ben, id);
  const openTotal = (actor: Actor) => ui.body(actor, id).locator('[data-formula-node-key]').first().click();
  const sources = async (actor: Actor) => (await formulas(actor, id)).map(([formula]) => formula).sort();
  await openTotal(ada);
  await expect(formulaInput(ada)).toHaveValue('2+3', { timeout: PEER_TIMEOUT });
  await expect(formulaInput(ada)).toHaveJSProperty('readOnly', false, { timeout: PEER_TIMEOUT });
  await formulaInput(ada).press('End');
  await ada.page.keyboard.type('*');
  await openTotal(ben);
  await expect(formulaInput(ben)).toHaveJSProperty('readOnly', false, { timeout: PEER_TIMEOUT });
  await formulaInput(ben).press('Home');
  await ben.page.keyboard.insertText(`${token}+`);
  await expect.poll(() => sources(ada), { message: "Ada receives Ben's reference", timeout: PEER_TIMEOUT }).toEqual(['4', `${token}+2+3`]);
  await ben.page.keyboard.press('Escape');
  await expect(formulaInput(ada), "Ada's field keeps her '*' and shows Ben's reference by name").toHaveValue('cost+2+3*');
  await ada.page.keyboard.type('2');
  const want = ['4', `${token}+2+3*2`];
  for (const actor of [ada, ben]) await expect.poll(() => sources(actor), { message: `${actor.label}: Ben's reference keeps its note and formula`, timeout: PEER_TIMEOUT }).toEqual(want);
  await ada.page.keyboard.press('Enter');
  await expect(popover(ada)).toHaveCount(0);
  await reloadHolds([ada, ben], id, sources, want);
});

// Two references share a name: the merge carries each token's identity through the edit itself, never by matching
// display text, so the one Ada deleted stays deleted and the one she kept is the one written.
test("j01 registers: when two references share a name, Ben's merged edit keeps the one Ada kept, not the one she deleted @p:col-1", async ({ actors, stack }) => {
  const first = '@(cost#11111111-1111-4111-8111-111111111111#22222222-2222-4222-8222-222222222222)';
  const second = '@(cost#44444444-4444-4444-8444-444444444444#55555555-5555-4555-8555-555555555555)';
  const { ada, ben: principal, id } = await note(actors, stack.baseUrl, 'Total {{2+3|5}} here.');
  const ben = await actors.session(principal);
  await join(ben, id);
  const sources = async (actor: Actor) => (await formulas(actor, id)).map(([formula]) => formula);
  await openFormula(ben, id);
  await expect(formulaInput(ben)).toHaveJSProperty('readOnly', false, { timeout: PEER_TIMEOUT });
  await formulaInput(ben).press('Home');
  await ben.page.keyboard.insertText(`${first}+${second}+`);
  await expect.poll(() => sources(ada), { message: "Ada receives Ben's references", timeout: PEER_TIMEOUT }).toEqual([`${first}+${second}+2+3`]);
  await ben.page.keyboard.press('Escape');
  await expect(popover(ben)).toHaveCount(0);
  await openFormula(ada, id);
  await expect(formulaInput(ada)).toHaveValue('cost+cost+2+3', { timeout: PEER_TIMEOUT });
  await expect(formulaInput(ada)).toHaveJSProperty('readOnly', false, { timeout: PEER_TIMEOUT });
  // A draft with a reference token is always a valid expression; an unfinished name holds it unwritten.
  await nameInput(ada).fill('1');
  await formulaInput(ada).press('Home');
  for (let i = 0; i < 5; i += 1) await formulaInput(ada).press('Delete');
  await expect(formulaInput(ada), 'Ada deletes the first reference').toHaveValue('cost+2+3');
  expect(await sources(ben), "Ada's unfinished draft is not written").toEqual([`${first}+${second}+2+3`]);
  await openFormula(ben, id);
  await expect(formulaInput(ben)).toHaveValue('cost+cost+2+3', { timeout: PEER_TIMEOUT });
  await expect(formulaInput(ben)).toHaveJSProperty('readOnly', false, { timeout: PEER_TIMEOUT });
  await formulaInput(ben).press('End');
  await ben.page.keyboard.press('Backspace');
  await ben.page.keyboard.type('4');
  await expect.poll(() => sources(ada), { message: "Ada receives Ben's edit", timeout: PEER_TIMEOUT }).toEqual([`${first}+${second}+2+4`]);
  await ben.page.keyboard.press('Escape');
  await expect(formulaInput(ada), "Ada's field takes Ben's edit and keeps her own").toHaveValue('cost+2+4', { timeout: PEER_TIMEOUT });
  await nameInput(ada).fill('total');
  const want = [`${second}+2+4`];
  for (const actor of [ada, ben]) await expect.poll(() => sources(actor), { message: `${actor.label}: the reference Ada kept is the one written`, timeout: PEER_TIMEOUT }).toEqual(want);
  await nameInput(ada).press('Enter');
  await expect(popover(ada)).toHaveCount(0);
  await reloadHolds([ada, ben], id, sources, want);
});

// Executable results are per viewer (A§10.10): an open popover writes a result only with its person's own expression
// write, never in answer to a peer's update, so two viewers whose results differ never rewrite each other's.
test("j01 registers: a peer's result write draws no write back from Ada's open popover @p:col-1", async ({ actors, stack }) => {
  const { ada, ben: principal, id } = await note(actors, stack.baseUrl, 'Total {{2+3|5}} here.');
  const ben = await actors.session(principal);
  await join(ben, id);
  await openFormula(ada, id);
  await expect(formulaInput(ada)).toHaveJSProperty('readOnly', false, { timeout: PEER_TIMEOUT });
  await formulaInput(ada).press('End');
  await ada.page.keyboard.type('+1');
  for (const actor of [ada, ben]) await expect.poll(() => formulas(actor, id), { message: `${actor.label}: Ada's edit is written`, timeout: PEER_TIMEOUT }).toEqual([['2+3+1', '6']]);
  // Ben's viewer computed another result (its references resolve differently) and wrote it.
  await ui.body(ben, id).evaluate(element => {
    const editor = (element as HTMLElement & { __lexicalEditor: LexicalEditor }).__lexicalEditor;
    editor.update(() => {
      const node = [...editor.getEditorState()._nodeMap.values()].find(n => n.getType() === 'formula') as unknown as { getWritable(): { setResult(result: string): void } };
      node.getWritable().setResult('99');
    }, { discrete: true });
  });
  await settled([ada, ben], id);
  await ada.page.waitForTimeout(1_000);
  await settled([ada, ben], id);
  for (const actor of [ada, ben]) expect(await formulas(actor, id), `${actor.label}: Ada's popover wrote nothing back`).toEqual([['2+3+1', '99']]);
  await expect(formulaInput(ada)).toHaveValue('2+3+1');
});

for (const kind of ['variable', 'formula'] as const) {
  test(`j01 registers: a ${kind} popover opened before its payload arrives is read-only, then edits it as a ${kind} @p:col-1`, async ({ actors, stack }) => {
    const source = kind === 'variable' ? '{{status|pending}}' : '{{2+3|5}}';
    const { ada, ben: principal, id } = await note(actors, stack.baseUrl, `Intro.\n\nSee ${source} here.`);
    const ben = await actors.session(principal, { severable: true });
    // Frames as late as WebKit gives them under load: the popover's focus retry after the payload arrives must not
    // land on a caret the user has placed since (it selected the value, and typing replaced it).
    await ben.context.addInitScript(() => {
      const frames = new Map<number, ReturnType<typeof setTimeout>>();
      let next = 1;
      window.requestAnimationFrame = (callback) => {
        const frame = next++;
        frames.set(frame, setTimeout(() => { frames.delete(frame); callback(performance.now()); }, 500));
        return frame;
      };
      window.cancelAnimationFrame = (frame) => { clearTimeout(frames.get(frame)); frames.delete(frame); };
    });
    ben.sever!.holdPayloads();
    await join(ben, id);
    await openFormula(ben, id);
    await expect(formulaInput(ben), 'no text yet: the popover cannot be typed into').toHaveJSProperty('readOnly', true);
    ben.sever!.releasePayloads();
    await expect(popover(ben), 'the popover takes the arrived kind').toHaveAccessibleName(kind === 'variable' ? 'Edit variable' : 'Edit formula', { timeout: PEER_TIMEOUT });
    const value = kind === 'variable' ? 'pending' : '2+3';
    await expect(formulaInput(ben)).toHaveValue(value);
    await expect(formulaInput(ben)).toHaveJSProperty('readOnly', false);
    await formulaInput(ben).press('End');
    // Every frame requested before this one has run.
    await ben.page.evaluate(() => new Promise((done) => requestAnimationFrame(done)));
    await expect(formulaInput(ben), 'the caret stays where the user put it').toHaveJSProperty('selectionStart', value.length);
    await ben.page.keyboard.type(kind === 'variable' ? ' soon' : '+1');
    const want = kind === 'variable' ? [['status', 'pending soon']] : [['2+3+1', '6']];
    for (const actor of [ada, ben]) await expect.poll(() => formulas(actor, id), { message: `${actor.label}: the edit is written as a ${kind}`, timeout: PEER_TIMEOUT }).toEqual(want);
  });
}

/** One payload-backed block kind: its markdown, how the editor reads its text, and how a user opens its field. */
interface PayloadKind {
  markdown: string; type: string; getter: string; seed: string;
  open(actor: Actor, id: string): Promise<void>;
  input(actor: Actor, id: string): Locator;
}

const PAYLOAD_KINDS: Record<string, PayloadKind> = {
  code: {
    markdown: 'Intro.\n\n```js\nseed\n```', type: 'code-block', getter: 'getCode', seed: 'seed',
    open: openBlock, input: field,
  },
  HTML: {
    markdown: 'Intro.\n\n```moss-html\n<p>seed</p>\n```', type: 'html-block', getter: 'getRawHtml', seed: '<p>seed</p>',
    // The preview is a live sandboxed frame (T3.2) that takes its own clicks, so the header's Edit opens the source.
    open: async (actor, id) => {
      await ui.body(actor, id).locator('[data-moss-html-preview-viewport]').hover();
      await ui.body(actor, id).getByTitle('Edit HTML', { exact: true }).click();
    },
    input: (actor, id) => ui.body(actor, id).locator('textarea.moss-codeblock-textarea'),
  },
  formula: {
    markdown: 'Intro.\n\nTotal {{2+3|5}} here.', type: 'formula', getter: 'getFormula', seed: '2+3',
    open: openFormula, input: (actor) => formulaInput(actor),
  },
};

/** The text of every attached node of `type`, read through `getter`. */
const payloadTexts = (actor: Actor, id: string, type: string, getter: string) => ui.body(actor, id).evaluate((element, [type, getter]) => {
  const editor = (element as HTMLElement & { __lexicalEditor: LexicalEditor }).__lexicalEditor;
  return editor.read(() => [...editor.getEditorState()._nodeMap.values()]
    .filter(n => n.getType() === type && n.isAttached())
    .map(n => (n as unknown as Record<string, () => string>)[getter]()));
}, [type, getter] as const);

for (const [kind, spec] of Object.entries(PAYLOAD_KINDS)) {
  test(`j01 registers: after Ben's doc socket black-holes while Ada types into a ${kind} block, his copy catches up without a reload and his field takes typing @p:col-4`, async ({ actors, stack }) => {
    const { ada, ben: principal, id } = await note(actors, stack.baseUrl, spec.markdown);
    const ben = await actors.session(principal, { severable: true });
    await join(ben, id);
    const texts = (actor: Actor) => payloadTexts(actor, id, spec.type, spec.getter);
    const typeAtEnd = async (actor: Actor, text: string) => {
      await spec.input(actor, id).evaluate(input => { const i = input as HTMLTextAreaElement; i.setSelectionRange(i.value.length, i.value.length); });
      await actor.page.keyboard.type(text);
    };
    await expect.poll(() => texts(ben), { message: 'Ben holds the seed', timeout: PEER_TIMEOUT }).toEqual([spec.seed]);
    await spec.open(ada, id);
    await expect(spec.input(ada, id)).toHaveValue(spec.seed, { timeout: PEER_TIMEOUT });
    await expect(spec.input(ada, id)).toHaveJSProperty('readOnly', false, { timeout: PEER_TIMEOUT });
    await expect(spec.input(ada, id)).toBeFocused();

    // Shorter than the 12 s silence limit, so Ben's socket survives and only the frames are lost.
    ben.sever!.blackhole();
    await typeAtEnd(ada, '+1');
    await settled([ada], id);
    expect(ben.sever!.census().dropped.in, "Ada's edit was lost on Ben's socket").toBeGreaterThan(0);
    ben.sever!.restore();

    await typeAtEnd(ada, '+2');
    await expect.poll(() => texts(ben), { message: 'Ben catches up without a reload', timeout: PEER_TIMEOUT }).toEqual([`${spec.seed}+1+2`]);
    await typeAtEnd(ada, '+3');
    await expect.poll(() => texts(ben), { message: "Ada's later edits keep arriving", timeout: PEER_TIMEOUT }).toEqual([`${spec.seed}+1+2+3`]);

    await spec.open(ben, id);
    await expect(spec.input(ben, id), "Ben's field opens on the caught-up text").toHaveValue(`${spec.seed}+1+2+3`, { timeout: PEER_TIMEOUT });
    await expect(spec.input(ben, id), "Ben's field is writable").toHaveJSProperty('readOnly', false, { timeout: PEER_TIMEOUT });
    await typeAtEnd(ben, '+4');
    for (const actor of [ada, ben]) await expect.poll(() => texts(actor), { message: `${actor.label} converges`, timeout: PEER_TIMEOUT }).toEqual([`${spec.seed}+1+2+3+4`]);
  });
}
