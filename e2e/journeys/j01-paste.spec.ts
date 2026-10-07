// j01-paste (T3.S6): a large markdown paste lands whole. Moss's plain-text paste split anything from 40,000 characters
// (or 800 lines) into chunks and dropped every chunk after the first, because the selection it inserted at was gone by
// the second. Pasting 40k, 200k and 2 MB of mixed markdown, into an empty note and between two paragraphs, must land
// every character (the doc's export equals the server's import of the same text, moss's normalization), leave the
// caret after the paste, make one undo step, and reach a collaborator in full.
//
// The notes and the reference imports are created through POST /api/docs as declared setup.
import type { LexicalEditor } from 'lexical';
import type { Actor, Actors } from '../lib/actors.ts';
import { grantDoc } from '../lib/grants.ts';
import type { Stack } from '../lib/stack.ts';
import { expect, test, ui } from '../lib/test.ts';

/** Past the undo capture window (1 s), so the next edit is its own step. */
const NEW_STEP_MS = 1_500;
const UNDO = 'ControlOrMeta+z';
const LAST = 'Last line of the paste.';

/** Mixed markdown of at least `size` characters: headings, inline formatting, lists, checklists, quotes, tables, code. */
function mixedMarkdown(size: number): string {
  const parts = ['Pasted start.'];
  let length = parts[0].length;
  for (let i = 0; length < size; i += 1) {
    const section = [
      `## Section ${i}`,
      `Paragraph ${i} has **bold ${i}**, *italic ${i}*, \`code ${i}\`, ~~struck ${i}~~ and a [link ${i}](https://example.invalid/page/${i}).`,
      `- item ${i} one\n- item ${i} two with **weight**\n  - nested item ${i}`,
      `1. first ${i}\n2. second ${i}`,
      `- [ ] open task ${i}\n- [x] done task ${i}`,
      `> quoted ${i} with *emphasis*`,
      `| Name ${i} | Value ${i} |\n| --- | --- |\n| row ${i} | ${i * 7} |`,
      ...(i % 10 === 0 ? [`\`\`\`js\nconst value${i} = ${i};\nconsole.log(value${i});\n\`\`\``] : []),
    ].join('\n\n');
    parts.push(section);
    length += section.length + 2;
  }
  parts.push(LAST);
  return parts.join('\n\n');
}

async function importNote(actor: Actor, stack: Stack, title: string, markdown?: string): Promise<string> {
  const response = await actor.context.request.post('/api/docs', {
    headers: { origin: stack.baseUrl },
    data: markdown === undefined ? { title } : { title, markdown },
    timeout: 120_000,
  });
  expect(response.status(), `declared setup: ${title} is imported`).toBe(201);
  return ((await response.json()) as { doc: { id: string } }).doc.id;
}

async function exported(actor: Actor, docId: string): Promise<string> {
  const response = await actor.context.request.get(`/api/docs/${docId}/content`, { timeout: 120_000 });
  expect(response.status()).toBe(200);
  return response.text();
}

/** What the server's import makes of `markdown`, through a throwaway note. */
async function normalized(actor: Actor, stack: Stack, markdown: string): Promise<string> {
  return exported(actor, await importNote(actor, stack, 'Reference', markdown));
}

/** Length and hash of the body's text as Lexical holds it. */
const fingerprint = (actor: Actor, docId: string) =>
  ui.body(actor, docId).evaluate((element) => {
    const editor = (element as HTMLElement & { __lexicalEditor: LexicalEditor }).__lexicalEditor;
    const text = editor.getEditorState().read(() => editor.getEditorState()._nodeMap.get('root')!.getTextContent());
    let sum = 0;
    for (let i = 0; i < text.length; i += 1) sum = (sum * 31 + text.charCodeAt(i)) >>> 0;
    return { length: text.length, sum };
  });

/** A real clipboard paste of plain text, as from a text editor (no text/markdown or HTML flavor). */
async function pastePlain(actor: Actor, docId: string, text: string): Promise<void> {
  await ui.body(actor, docId).evaluate((element, value) => {
    const data = new DataTransfer();
    data.setData('text/plain', value);
    element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }));
  }, text);
}

async function setup(actors: Actors, stack: Stack, markdown?: string) {
  const ada = await actors.session(await actors.principal('ada'));
  const docId = await importNote(ada, stack, 'Paste target', markdown);
  const principal = await actors.principal('ben');
  await grantDoc(ada, docId, principal);
  await ada.goto(`/d/${docId}`);
  const ben = await actors.open(principal, { path: `/d/${docId}` });
  for (const actor of [ada, ben]) {
    await ui.waitLive(actor, docId);
    await actor.observeEditor(docId);
  }
  return { ada, ben, docId };
}

/**
 * Pastes `pasted` at the caret, then checks: the export is `whole`; Ben's body equals Ada's; typing lands after the
 * paste (`typed`); one undo removes the typing and the next the whole paste (`before`), for both.
 */
async function pasteAndCheck(
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
}

const SIZES: [string, number, number][] = [
  ['40k', 40_000, 120_000],
  ['200k', 200_000, 180_000],
  ['2 MB', 2_000_000, 480_000],
];

for (const [label, size, timeout] of SIZES) {
  test(`j01-paste: ${label} of mixed markdown pasted into an empty note lands whole, caret after it, one undo step, on both screens @p:col-1 @p:col-3`, async ({ actors, stack }) => {
    test.setTimeout(timeout * 3);
    const markdown = mixedMarkdown(size);
    const { ada, ben, docId } = await setup(actors, stack);
    const want = { whole: await normalized(ada, stack, markdown), typed: await normalized(ada, stack, `${markdown}Z`) };
    expect(want.whole.length, 'the reference export holds the paste').toBeGreaterThan(size * 0.8);
    await ui.body(ada, docId).click();
    await pasteAndCheck({ ada, ben, docId }, markdown, want, timeout);
  });
}

test('j01-paste: 200k of mixed markdown pasted between two paragraphs lands whole, caret after it, one undo step @p:col-1 @p:col-3', async ({ actors, stack }) => {
  test.setTimeout(540_000);
  const markdown = mixedMarkdown(200_000);
  const { ada, ben, docId } = await setup(actors, stack, 'Before.\n\nAfter.');
  const want = {
    whole: await normalized(ada, stack, `Before.\n\n${markdown}\n\nAfter.`),
    typed: await normalized(ada, stack, `Before.\n\n${markdown}Z\n\nAfter.`),
  };
  await ui.body(ada, docId).locator('p').filter({ hasText: /^Before\.$/ }).click();
  await ada.page.keyboard.press('End');
  await ada.page.keyboard.press('Enter');
  await pasteAndCheck({ ada, ben, docId }, markdown, want, 180_000);
});
