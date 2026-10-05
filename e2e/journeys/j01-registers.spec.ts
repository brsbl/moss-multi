// j01-registers (T1.F4; docs/design/registers.md): a code block's field writes only what its user typed, against the
// payload as it is now. A peer joining mid-draft never costs the drafter a character; a field stays open while a peer
// moves its block, closes with a notice when a peer removes it, and stays read-only until its text has arrived. The
// formula popover does the same for its formula.
import type { Locator } from '@playwright/test';
import type { LexicalEditor } from 'lexical';
import type { Actor, Actors } from '../lib/actors.ts';
import { SYNC_UNACKED_ATTR } from '../lib/contract.ts';
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
    // A double-click opens the editor whatever the preview shows (its error overlay covers the Edit button); the
    // bottom corner is clear of the header and the overlay's Retry button.
    open: async (actor, id) => {
      const viewport = ui.body(actor, id).locator('[data-moss-html-preview-viewport]');
      const box = await viewport.boundingBox();
      if (!box) throw new Error('the HTML preview has no box');
      await viewport.dblclick({ position: { x: 8, y: box.height - 8 } });
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
