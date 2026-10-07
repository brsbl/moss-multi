// j01-paste helpers: pasting into a shared note through a real clipboard event and reading what the server and each
// screen then hold. The notes and the reference imports are created through POST /api/docs as declared setup.
import type { LexicalEditor } from 'lexical';
import type { Actor, Actors } from './actors.ts';
import { grantDoc } from './grants.ts';
import type { Stack } from './stack.ts';
import { expect, ui } from './test.ts';

/** Past the undo capture window (1 s), so the next edit is its own step. */
export const NEW_STEP_MS = 1_500;
export const UNDO = 'ControlOrMeta+z';
export const REDO = 'ControlOrMeta+Shift+z';

export async function importNote(actor: Actor, stack: Stack, title: string, markdown?: string): Promise<string> {
  const response = await actor.context.request.post('/api/docs', {
    headers: { origin: stack.baseUrl },
    data: markdown === undefined ? { title } : { title, markdown },
    timeout: 120_000,
  });
  expect(response.status(), `declared setup: ${title} is imported`).toBe(201);
  return ((await response.json()) as { doc: { id: string } }).doc.id;
}

export async function exported(actor: Actor, docId: string): Promise<string> {
  const response = await actor.context.request.get(`/api/docs/${docId}/content`, { timeout: 120_000 });
  expect(response.status()).toBe(200);
  return response.text();
}

/** What the server's import makes of `markdown`, through a throwaway note. */
export async function normalized(actor: Actor, stack: Stack, markdown: string): Promise<string> {
  return exported(actor, await importNote(actor, stack, 'Reference', markdown));
}

/** Length and hash of the body's text as Lexical holds it. */
export const fingerprint = (actor: Actor, docId: string) =>
  ui.body(actor, docId).evaluate((element) => {
    const editor = (element as HTMLElement & { __lexicalEditor: LexicalEditor }).__lexicalEditor;
    const text = editor.getEditorState().read(() => editor.getEditorState()._nodeMap.get('root')!.getTextContent());
    let sum = 0;
    for (let i = 0; i < text.length; i += 1) sum = (sum * 31 + text.charCodeAt(i)) >>> 0;
    return { length: text.length, sum };
  });

/** A real clipboard paste of plain text, as from a text editor (no text/markdown or HTML flavor). */
export async function pastePlain(actor: Actor, docId: string, text: string): Promise<void> {
  await ui.body(actor, docId).evaluate((element, value) => {
    const data = new DataTransfer();
    data.setData('text/plain', value);
    element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }));
  }, text);
}

export async function setup(actors: Actors, stack: Stack, markdown?: string, { elsewhere = false } = {}) {
  const ada = await actors.session(await actors.principal('ada'));
  const docId = await importNote(ada, stack, 'Paste target', markdown);
  const otherId = elsewhere ? await importNote(ada, stack, 'Elsewhere', 'Another note.') : '';
  const principal = await actors.principal('ben');
  await grantDoc(ada, docId, principal);
  await ada.goto(`/d/${docId}`);
  const ben = await actors.open(principal, { path: `/d/${docId}` });
  for (const actor of [ada, ben]) {
    await ui.waitLive(actor, docId);
    await actor.observeEditor(docId);
  }
  return { ada, ben, docId, otherId };
}

/**
 * Pastes `pasted` at the caret, then checks: the export is `whole`; Ben's body equals Ada's; typing lands after the
 * paste (`typed`); one undo removes the typing and the next the whole paste (`before`), for both.
 */
export async function pasteAndCheck(
  { ada, ben, docId }: { ada: Actor; ben: Actor; docId: string },
  pasted: string,
  want: { whole: string; typed: string },
  timeout: number,
): Promise<void> {
  await ui.waitAcked(ada, docId, timeout);
  const before = await exported(ada, docId);
  const empty = await fingerprint(ada, docId);
  await ada.page.waitForTimeout(NEW_STEP_MS);

  await pastePlain(ada, docId, pasted);
  await ui.waitAcked(ada, docId, timeout);
  await expect.poll(() => exported(ada, docId), { message: 'every pasted character lands in the doc', timeout }).toBe(want.whole);
  const pastedPrint = await fingerprint(ada, docId);
  await expect.poll(() => fingerprint(ben, docId), { message: 'the collaborator sees the whole paste', timeout }).toEqual(pastedPrint);

  await ada.page.waitForTimeout(NEW_STEP_MS);
  await ada.page.keyboard.type('Z');
  await ui.waitAcked(ada, docId, timeout);
  await expect.poll(() => exported(ada, docId), { message: 'the caret ends after the paste', timeout }).toBe(want.typed);

  await ada.page.waitForTimeout(NEW_STEP_MS);
  await ada.page.keyboard.press(UNDO);
  await ui.waitAcked(ada, docId, timeout);
  await expect.poll(() => exported(ada, docId), { message: 'the first undo removes only the typing', timeout }).toBe(want.whole);
  await ada.page.keyboard.press(UNDO);
  await ui.waitAcked(ada, docId, timeout);
  await expect.poll(() => exported(ada, docId), { message: 'one more undo removes the whole paste', timeout }).toBe(before);
  await expect.poll(() => fingerprint(ben, docId), { message: 'the collaborator sees the paste undone', timeout }).toEqual(empty);

  await ada.page.keyboard.press(REDO);
  await ui.waitAcked(ada, docId, timeout);
  await expect.poll(() => exported(ada, docId), { message: 'one redo brings the whole paste back to the server', timeout }).toBe(want.whole);
  await expect.poll(() => fingerprint(ben, docId), { message: 'the collaborator sees the paste redone', timeout }).toEqual(pastedPrint);
}
