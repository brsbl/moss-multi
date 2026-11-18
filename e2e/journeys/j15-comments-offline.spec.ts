// j15-comments-offline (T4.2; docs/design/comments.md §6, restart ruling 18): edits made while the socket is down reach
// the DocDO under the client frame discipline, so the server sees a deletion apart from the typing around it. Typing
// inside a commented passage, deleting it and reconnecting detaches the comment, and Cmd+Z brings it back; deleting it
// and retyping the same words offline leaves it detached. The anchor record is read from the DocDO by a protocol
// client.
import type { LexicalEditor } from 'lexical';
import type { Actor, Actors } from '../lib/actors.ts';
import { SYNC_UNACKED_ATTR } from '../lib/contract.ts';
import { openDocClient } from '../lib/doc-client.ts';
import { expect, test, ui } from '../lib/test.ts';

const SEED = 'The %%m:c1:start%%quick brown%%m:c1:end%% fox jumps over the lazy dog.\n\nA second line.';
const SIDECAR = { c1: { text: 'on quick brown', createdAt: 1_700_000_000, updatedAt: 1_700_000_000, source: 'user' } };
/** Past the undo capture window (1 s), so the next edit is its own step. */
const NEW_STEP_MS = 1_500;
const RECOVER_TIMEOUT = 20_000;
const UNDO = 'ControlOrMeta+z';

interface AnchorRecord {
  status: 'anchored' | 'orphaned';
  quote: string;
}

async function commentedNote(actors: Actors, baseUrl: string) {
  actors.solo('one window edits offline; the DocDO\'s anchor record is read by a protocol client with the same session');
  const ada = await actors.session(await actors.principal('ada'), { severable: true });
  const result = await ada.context.request.post('/api/docs', { headers: { origin: baseUrl }, data: { markdown: SEED, comments: SIDECAR } });
  expect(result.status()).toBe(201);
  const { doc: { id } } = await result.json() as { doc: { id: string } };
  await ada.goto(`/d/${id}`);
  await ui.waitLive(ada, id);
  await ada.observeEditor(id);
  const cookie = (await ada.context.cookies()).map((c) => `${c.name}=${c.value}`).join('; ');
  const anchor = async (): Promise<AnchorRecord | undefined> => {
    const client = await openDocClient(baseUrl, id, cookie);
    try {
      await client.synced;
      return client.doc.getMap('comments').get('a:c1') as AnchorRecord | undefined;
    } finally {
      client.close();
    }
  };
  await expect.poll(async () => (await anchor())?.status, { message: 'the import anchored c1' }).toBe('anchored');
  await ui.body(ada, id).locator('p').filter({ hasText: /^The quick/ }).click();
  return { ada, id, anchor };
}

/** Selects `needle` in the body (or puts the caret `caret` characters into it), through the editor. */
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

/** The body as Lexical holds it. */
const bodyText = (actor: Actor, id: string) => ui.body(actor, id).evaluate((element) => {
  const editor = (element as HTMLElement & { __lexicalEditor: LexicalEditor }).__lexicalEditor;
  return editor.getEditorState().read(() => editor.getEditorState()._nodeMap.get('root')!.getTextContent());
});

test('j15-comments-offline: type inside a comment and delete it offline, reconnect, undo: it reattaches @p:R18 @p:tech-3', async ({ actors, stack }) => {
  const { ada, id, anchor } = await commentedNote(actors, stack.baseUrl);
  if (!ada.sever) throw new Error('not severable');
  ada.expectReconnects(3, id);
  ada.sever.reset();
  await select(ada, id, 'brown', 2);
  await ada.page.keyboard.type('X');
  await expect(ui.pane(ada, id)).toHaveAttribute(SYNC_UNACKED_ATTR, '1');
  await ada.page.waitForTimeout(NEW_STEP_MS);
  await select(ada, id, 'quick brXown');
  await ada.page.keyboard.press('Backspace');
  await expect.poll(() => bodyText(ada, id)).toContain('The  fox jumps');
  ada.sever.restore();
  await expect(ui.pane(ada, id), 'the offline edits are on the server').toHaveAttribute(SYNC_UNACKED_ATTR, '0', { timeout: RECOVER_TIMEOUT });
  await expect.poll(async () => (await anchor())?.status, { message: 'deleting its text detached it' }).toBe('orphaned');

  await ada.page.keyboard.press(UNDO);
  await expect.poll(() => bodyText(ada, id)).toContain('The quick brXown fox jumps');
  await expect(ui.pane(ada, id)).toHaveAttribute(SYNC_UNACKED_ATTR, '0', { timeout: RECOVER_TIMEOUT });
  await expect.poll(async () => (await anchor())?.status, { message: 'the undo reattached it' }).toBe('anchored');
  expect((await anchor())?.quote, 'on the passage as it was deleted, with the letter typed into it').toBe('quick brXown');
});

test('j15-comments-offline: delete a comment\'s text and retype it identically offline; it stays detached @p:R18 @p:tech-3', async ({ actors, stack }) => {
  const { ada, id, anchor } = await commentedNote(actors, stack.baseUrl);
  if (!ada.sever) throw new Error('not severable');
  ada.expectReconnects(3, id);
  ada.sever.reset();
  await select(ada, id, 'quick brown');
  await ada.page.keyboard.press('Backspace');
  await expect.poll(() => bodyText(ada, id)).toContain('The  fox jumps');
  await ada.page.keyboard.type('quick brown');
  await expect.poll(() => bodyText(ada, id)).toContain('The quick brown fox jumps');
  ada.sever.restore();
  await expect(ui.pane(ada, id), 'the offline edits are on the server').toHaveAttribute(SYNC_UNACKED_ATTR, '0', { timeout: RECOVER_TIMEOUT });
  const record = await anchor();
  expect(record?.status, 'retyping the same words is not an undo').toBe('orphaned');
  expect(record?.quote).toBe('quick brown');
});
