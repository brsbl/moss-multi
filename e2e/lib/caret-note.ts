// The note and helpers of the caret journeys (T9.47): a peer's block change under a waiting caret. The target
// paragraph sits directly above a bullet list, so a bullet made of it joins that list.
import type { LexicalEditor } from 'lexical';
import type { Actor, Actors } from './actors.ts';
import { grantDoc } from './grants.ts';
import { expect, ui } from './test.ts';

export const PEER_TIMEOUT = 10_000;
export const PREVIOUS = 'Previous paragraph stays put.';
export const TARGET = 'Target paragraph where Ben waits.';
export const CARET_NOTE = [
  PREVIOUS,
  '',
  TARGET,
  '',
  '- First item',
  '- Item where Ben waits too',
  '',
  '| Head | More |',
  '| --- | --- |',
  '| Cell where Ben waits | x |',
].join('\n');

/** Ada's note shared with Ben (and anyone in `others`), each open on it and live. */
export async function caretNote(actors: Actors, baseUrl: string, { markdown = CARET_NOTE, severable = false, others = [] as string[] } = {}) {
  const ada = await actors.session(await actors.principal('ada'));
  const created = await ada.context.request.post('/api/docs', { headers: { origin: baseUrl }, data: { title: 'Caret', markdown } });
  expect(created.status(), 'declared setup: Ada has the note').toBe(201);
  const { doc: { id } } = await created.json() as { doc: { id: string } };
  const benPrincipal = await actors.principal('ben');
  await grantDoc(ada, id, benPrincipal);
  const otherPrincipals = [];
  for (const label of others) {
    const principal = await actors.principal(label);
    await grantDoc(ada, id, principal);
    otherPrincipals.push(principal);
  }
  await ada.goto(`/d/${id}`);
  const ben = await actors.open(benPrincipal, { path: `/d/${id}`, severable });
  const rest: Actor[] = [];
  for (const principal of otherPrincipals) rest.push(await actors.open(principal, { path: `/d/${id}` }));
  for (const actor of [ada, ben, ...rest]) { await ui.waitLive(actor, id); await actor.observeEditor(id); }
  return { ada, ben, others: rest, id };
}

/**
 * Selects from `back` characters before the end of the block that reads `text` to `to` characters before it (a caret
 * when `to` is omitted), as a click and arrow keys would, through the DOM selection the editor follows.
 */
export async function park(actor: Actor, id: string, text: string, back: number, to = back, nth = -1) {
  const block = ui.body(actor, id).locator('p, li, h1, h2, h3, h4, blockquote').filter({ hasText: text }).nth(nth);
  await block.click();
  await block.evaluate((element, [from, end]) => {
    const texts: Text[] = [];
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) texts.push(node as Text);
    const total = texts.reduce((sum, node) => sum + node.length, 0);
    const at = (offset: number): [Text, number] => {
      let rest = total - offset;
      for (const node of texts) {
        if (rest <= node.length) return [node, rest];
        rest -= node.length;
      }
      return [texts[texts.length - 1]!, texts[texts.length - 1]!.length];
    };
    const [anchor, anchorOffset] = at(from);
    const [focus, focusOffset] = at(end);
    window.getSelection()?.setBaseAndExtent(anchor, anchorOffset, focus, focusOffset);
  }, [back, to]);
  await expect.poll(() => actor.page.evaluate(() => window.getSelection()?.toString().length ?? -1), { message: `${actor.label}: the selection is set` })
    .toBe(Math.abs(back - to));
  await actor.page.waitForTimeout(150); // the editor reads the DOM selection on selectionchange
}

/** The texts of the body's lines in document order (paragraphs, headings, list items, cell paragraphs), exactly. */
export const lines = (actor: Actor, id: string): Promise<string[]> => ui.body(actor, id).evaluate((element) => {
  const editor = (element as HTMLElement & { __lexicalEditor: LexicalEditor }).__lexicalEditor;
  const state = editor.getEditorState();
  return state.read(() => {
    type Node = { getChildren?: () => Node[]; isInline?: () => boolean; getTextContent(): string };
    const isBlock = (node: Node) => typeof node.getChildren === 'function' && !node.isInline!();
    const out: string[] = [];
    const stack: Node[] = [...(state._nodeMap.get('root') as unknown as Node).getChildren!()].reverse();
    while (stack.length > 0) {
      const node = stack.pop()!;
      if (!isBlock(node)) continue;
      const children = node.getChildren!();
      if (children[0] && isBlock(children[0])) stack.push(...[...children].reverse());
      else out.push(node.getTextContent());
    }
    return out;
  });
});

/** The lines strictly between the line `after` and the line `before` (the end when null). */
export async function between(actor: Actor, id: string, after: string, before: string | null): Promise<string[]> {
  const all = await lines(actor, id);
  const from = all.indexOf(after);
  const to = before === null ? all.length : all.indexOf(before, from + 1);
  return from < 0 || to < 0 ? all : all.slice(from + 1, to);
}

export async function converged(ada: Actor, ben: Actor, id: string) {
  await expect.poll(async () => JSON.stringify(await lines(ada, id)) === JSON.stringify(await lines(ben, id)),
    { message: 'both windows converge', timeout: PEER_TIMEOUT }).toBe(true);
}

/** A toolbar dropdown's item, as a person picks it. */
export async function pick(actor: Actor, name: string, item: string) {
  await actor.page.getByRole('button', { name, exact: true }).click();
  await actor.page.getByRole('menuitem').filter({ hasText: item }).click();
}
