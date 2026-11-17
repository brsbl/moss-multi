// How much one Cmd+Z takes back (T9.13). Each scenario starts with the caret at the end of a note holding the one
// paragraph "Start.", plays its keys at a person's pace (no pause near a second), then presses Cmd+Z `presses` times
// and records the body after each. Shared by the j01-undo leg and the probe against pristine moss
// (e2e/parity/undo-steps.spec.ts); MOSS_UNDO_STEPS is what moss at the pin does, so both assert the same steps.
import type { Locator, Page } from '@playwright/test';

export type UndoAction = { type: string } | { key: string } | { paste: string } | { menu: string };

export interface UndoScenario {
  name: string;
  actions: UndoAction[];
  presses: number;
}

/** The body once typed, then after each Cmd+Z: one string per block, `tag|text`, bold text in `**`. */
export interface UndoSteps {
  typed: string[];
  undone: string[][];
}

export const START_MARKDOWN = 'Start.';
/** A person's typing: about 15 characters a second, a short beat between actions. */
const KEY_DELAY_MS = 60;
const BEAT_MS = 150;

export const UNDO_SCENARIOS: UndoScenario[] = [
  { name: 'three paragraphs', presses: 7, actions: [{ key: 'Enter' }, { type: 'One two.' }, { key: 'Enter' }, { type: 'Three four.' }, { key: 'Enter' }, { type: 'Five six.' }] },
  { name: 'typing then deleting then typing', presses: 4, actions: [{ key: 'Enter' }, { type: 'abcdef' }, { key: 'Backspace' }, { key: 'Backspace' }, { key: 'Backspace' }, { type: 'xyz' }] },
  { name: 'a markdown shortcut', presses: 5, actions: [{ key: 'Enter' }, { type: '## Heading' }] },
  { name: 'a slash insert', presses: 5, actions: [{ key: 'Enter' }, { type: '/quote' }, { menu: 'Quote' }, { type: 'Quoted' }] },
  { name: 'a paste', presses: 5, actions: [{ key: 'Enter' }, { type: 'abc' }, { paste: 'pasted words' }, { type: ' def' }] },
  {
    name: 'Cmd+B',
    presses: 5,
    actions: [{ key: 'Enter' }, { type: 'Bold me' }, { key: 'Shift+ArrowLeft' }, { key: 'Shift+ArrowLeft' }, { key: 'ControlOrMeta+b' }, { key: 'ArrowRight' }, { type: ' after' }],
  },
];

const s = 'paragraph|Start.';
/** What pristine moss at the pin takes back per Cmd+Z, by scenario. */
export const MOSS_UNDO_STEPS: Record<string, UndoSteps> = {
  'three paragraphs': {
    typed: [s, 'paragraph|One two.', 'paragraph|Three four.', 'paragraph|Five six.'],
    undone: [
      [s, 'paragraph|One two.', 'paragraph|Three four.', 'paragraph|'],
      [s, 'paragraph|One two.', 'paragraph|Three four.'],
      [s, 'paragraph|One two.', 'paragraph|'],
      [s, 'paragraph|One two.'],
      [s, 'paragraph|'],
      [s],
      [s],
    ],
  },
  'typing then deleting then typing': {
    typed: [s, 'paragraph|abcxyz'],
    undone: [[s, 'paragraph|abc'], [s, 'paragraph|abcdef'], [s, 'paragraph|'], [s]],
  },
  'a markdown shortcut': {
    typed: [s, 'h2|Heading'],
    undone: [[s, 'h2|'], [s, 'paragraph|## '], [s, 'paragraph|'], [s], [s]],
  },
  'a slash insert': {
    typed: [s, 'quote|Quoted'],
    undone: [[s, 'quote|'], [s, 'paragraph|/quote'], [s, 'paragraph|'], [s], [s]],
  },
  'a paste': {
    typed: [s, 'paragraph|abcpasted words def'],
    undone: [[s, 'paragraph|abcpasted words'], [s, 'paragraph|abc'], [s, 'paragraph|'], [s], [s]],
  },
  'Cmd+B': {
    typed: [s, 'paragraph|Bold **me** after'],
    undone: [[s, 'paragraph|Bold **me**'], [s, 'paragraph|Bold me'], [s, 'paragraph|'], [s], [s]],
  },
};

const frames = (page: Page) => page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));

/** The editor's blocks as `tag|text`, read from its state (headings by tag, other blocks by type). */
export const blocksOf = (root: Locator): Promise<string[]> => root.evaluate((element) => {
  type Serialized = { type: string; tag?: string; text?: string; format?: number; children?: Serialized[] };
  const host = element as HTMLElement & { __lexicalEditor?: { getEditorState(): { toJSON(): { root: Serialized } } } };
  const editor = host.__lexicalEditor ?? (element.querySelector('[contenteditable]') as typeof host | null)?.__lexicalEditor;
  if (!editor) throw new Error('no Lexical editor on the root');
  const show = (node: Serialized): string => {
    if (node.type === 'text') return (node.format ?? 0) & 1 ? `**${node.text ?? ''}**` : (node.text ?? '');
    if (node.type === 'linebreak') return '\n';
    return (node.children ?? []).map(show).join('');
  };
  return (editor.getEditorState().toJSON().root.children ?? []).map((block) => `${block.type === 'heading' ? block.tag : block.type}|${show(block)}`);
});

/** Puts the caret at the end of the note's first paragraph ("Start."). */
async function caretAtStartEnd(page: Page, root: Locator): Promise<void> {
  const first = root.locator('p').first();
  await first.scrollIntoViewIfNeeded();
  const box = await first.boundingBox();
  if (!box) throw new Error('the first paragraph is not visible');
  await page.mouse.click(box.x + box.width - 4, box.y + box.height / 2);
  // Lexical reads the first selectionchange after a pointerdown as the click's own (see arrow-below.ts).
  await page.evaluate(() => new Promise((done) => {
    document.addEventListener('selectionchange', () => setTimeout(done, 50), { once: true });
    setTimeout(done, 500);
  }));
  await page.keyboard.press('End');
  await frames(page);
}

async function play(page: Page, root: Locator, action: UndoAction): Promise<void> {
  if ('type' in action) await page.keyboard.type(action.type, { delay: KEY_DELAY_MS });
  else if ('key' in action) await page.keyboard.press(action.key);
  else if ('paste' in action) {
    await root.evaluate((element, text) => {
      const target = element.isContentEditable ? element : (element.querySelector('[contenteditable]') ?? element);
      const clipboardData = new DataTransfer();
      clipboardData.setData('text/plain', text);
      target.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData }));
    }, action.paste);
  } else {
    await page.locator('button[data-index]').filter({ hasText: new RegExp(`^${action.menu}`) }).first().waitFor({ timeout: 5_000 });
    await page.keyboard.press('Enter');
  }
  await frames(page);
  await page.waitForTimeout(BEAT_MS);
}

/** Plays `scenario` on the note in `root` (holding only "Start."), then presses Cmd+Z, recording the body each time. */
export async function undoSteps(page: Page, root: Locator, scenario: UndoScenario): Promise<UndoSteps> {
  await caretAtStartEnd(page, root);
  for (const action of scenario.actions) await play(page, root, action);
  const typed = await blocksOf(root);
  const undone: string[][] = [];
  for (let i = 0; i < scenario.presses; i++) {
    await page.keyboard.press('ControlOrMeta+z');
    await frames(page);
    await page.waitForTimeout(50);
    undone.push(await blocksOf(root));
  }
  return { typed, undone };
}
