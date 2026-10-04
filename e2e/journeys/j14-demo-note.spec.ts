// j14-demo-note (M3; R8, note-2): Ada builds the demo note in a test account through the UI, pasting most families
// and inserting the block families again through slash commands; Ben, an editor by declared setup, sees every
// family render, live and after reload. Then both edit one chart and one canvas while Ben's socket is cut, and
// neither loses a key or a stroke (A§10.10). Media (image, video, embeds) is j11's.
import { readFileSync } from 'node:fs';
import type { LexicalEditor } from 'lexical';
import type { Locator, Page } from '@playwright/test';
import type { Actor } from '../lib/actors.ts';
import { grantDoc } from '../lib/grants.ts';
import { renderedBody } from '../lib/import-parity.ts';
import { expect, test, ui } from '../lib/test.ts';

const DEMO = readFileSync(new URL('../fixtures/demo-note.md', import.meta.url), 'utf8');
const PEER_TIMEOUT = 15_000;

/** Every family, as the selector its rendered form carries inside the body, and how many the built note has. */
const FAMILIES: { family: string; selector: string; pasted: number; slash?: string }[] = [
  { family: 'heading 1', selector: 'h1', pasted: 1 },
  { family: 'heading 2', selector: 'h2', pasted: 1 },
  { family: 'heading 3', selector: 'h3', pasted: 1 },
  { family: 'heading 4', selector: 'h4', pasted: 1 },
  { family: 'bulleted list', selector: 'ul.list-disc', pasted: 2 },
  { family: 'numbered list', selector: 'ol', pasted: 1 },
  { family: 'checklist item', selector: 'li[role="checkbox"]', pasted: 2 },
  { family: 'bold', selector: 'strong', pasted: 2 },
  { family: 'italic', selector: 'em', pasted: 1 },
  { family: 'inline code', selector: 'code', pasted: 1 },
  { family: 'link', selector: 'a[href]', pasted: 1 },
  { family: 'formula', selector: '[data-formula-node-key]', pasted: 2 },
  { family: 'wiki link', selector: '[data-file-link-node-key]', pasted: 1 },
  { family: 'embed pill', selector: '[data-embed-pill-node-key]', pasted: 1 },
  { family: 'color code', selector: '[data-color-node-key]', pasted: 1 },
  { family: 'quote', selector: 'blockquote', pasted: 1, slash: 'Quote' },
  { family: 'table', selector: 'table.moss-table', pasted: 1, slash: 'Table' },
  { family: 'callout', selector: '.moss-callout', pasted: 1, slash: 'Callout' },
  { family: 'tabs', selector: '.moss-tab-group', pasted: 1, slash: 'Tabs' },
  { family: 'code block', selector: '.moss-codeblock-pre', pasted: 1, slash: 'Code' },
  { family: 'chart', selector: '[aria-label="Insert paragraph before chart"]', pasted: 1, slash: 'Bar Chart' },
  { family: 'canvas', selector: '[aria-label="Insert paragraph before canvas"]', pasted: 1, slash: 'Canvas' },
  { family: 'HTML block', selector: '[data-moss-html-preview-viewport]', pasted: 1, slash: 'HTML' },
  { family: 'divider', selector: 'hr', pasted: 1, slash: 'Divider' },
];

const counts = (actor: Actor, id: string) => ui.body(actor, id).evaluate((root, families) =>
  Object.fromEntries(families.map(({ family, selector }) => [family, root.querySelectorAll(selector).length])), FAMILIES);
/** The families rendered fewer times than the note holds them (another node may share a selector, never fewer). */
const missing = async (actor: Actor, id: string, expected: Record<string, number>) => {
  const seen = await counts(actor, id);
  return Object.entries(expected).filter(([family, n]) => (seen[family] ?? 0) < n).map(([family, n]) => `${family}: ${seen[family]} of ${n}`);
};

async function paste(actor: Actor, id: string, markdown: string): Promise<void> {
  await ui.body(actor, id).evaluate((element, text) => {
    const clipboardData = new DataTransfer();
    clipboardData.setData('text/plain', text);
    clipboardData.setData('text/markdown', text);
    element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData }));
  }, markdown);
}

/** Replaces a marker paragraph with a slash command's block, as a person typing "/" on an empty line does. */
async function slash(actor: Actor, id: string, marker: string, option: string): Promise<void> {
  const page = actor.page;
  const line = ui.body(actor, id).locator('p').filter({ hasText: new RegExp(`^${marker}$`) });
  const text = line.locator('[data-lexical-text]');
  // A block that took focus (a code block's editor) gives up the caret on the first click, so click until the caret
  // sits at the end of the marker line.
  await expect(async () => {
    const box = await text.boundingBox();
    if (!box) throw new Error(`${marker} is not laid out`);
    await text.click({ position: { x: box.width - 1, y: box.height / 2 } });
    expect(await page.evaluate(() => { const s = window.getSelection(); return `${s?.anchorNode?.textContent}@${s?.anchorOffset}`; })).toBe(`${marker}@${marker.length}`);
    // Keys act on Lexical's selection, which follows the DOM's on selectionchange; wait until it has.
    expect(await ui.body(actor, id).evaluate((element) => {
      const editor = (element as HTMLElement & { __lexicalEditor: LexicalEditor }).__lexicalEditor;
      const state = editor.getEditorState();
      const anchor = (state._selection as { anchor?: { key: string; offset: number; type: string } } | null)?.anchor;
      return state.read(() => {
        const node = anchor && state._nodeMap.get(anchor.key) as unknown as { getTextContent(): string; getChildrenSize?(): number } | undefined;
        if (!anchor || !node) return 'no selection';
        const end = anchor.type === 'element' ? node.getChildrenSize?.() : node.getTextContent().length;
        return `${node.getTextContent()}@${anchor.offset === end ? 'end' : anchor.offset}`;
      });
    })).toBe(`${marker}@end`);
  }).toPass({ timeout: 10_000 });
  // Character by character: Home and Shift+Home move differently across platforms and engines.
  for (let i = 0; i < marker.length; i += 1) await page.keyboard.press('Backspace');
  await expect(line, 'the marker line is empty').toHaveCount(0);
  const query = `/${option.toLowerCase().split(' ')[0]}`;
  await page.keyboard.type(query);
  await page.locator('button[data-index]').filter({ hasText: new RegExp(`^${option}`) }).first().click();
  await expect(ui.body(actor, id).locator('p').filter({ hasText: query }), `${option} replaces its line`).toHaveCount(0);
}

const markerOf = (family: string) => `slash-${family.replace(/\W+/g, '-')}`;

test('j14 demo note: Ada builds every family through paste and slash commands, and Ben sees each one live and after reload @p:note-2 @p:R8 @evidence', async ({ actors }) => {
  const ada = await actors.open(await actors.principal('ada'));
  const benPrincipal = await actors.principal('ben');
  const id = await ui.createNote(ada);
  await ui.typeTitle(ada, id, 'Demo note j14', { enter: true });
  await expect(ui.body(ada, id), 'Enter moves from the title to the body').toBeFocused();
  const slashed = FAMILIES.filter(f => f.slash);
  await paste(ada, id, `${DEMO}\n${slashed.map(f => markerOf(f.family)).join('\n\n')}\n`);
  for (const { family, slash: option } of slashed) await slash(ada, id, markerOf(family), option!);
  await ada.page.keyboard.press('Escape');
  await expect(ui.pane(ada, id)).toHaveAttribute('data-sync-unacked', '0', { timeout: PEER_TIMEOUT });

  const expected = Object.fromEntries(FAMILIES.map(f => [f.family, f.pasted + (f.slash ? 1 : 0)]));
  await expect.poll(() => missing(ada, id, expected), { message: 'Ada built every family' }).toEqual([]);

  await grantDoc(ada, id, benPrincipal, 'editor');
  const ben = await actors.open(benPrincipal, { path: `/d/${id}` });
  await ui.waitLive(ben, id);
  await actors.requireDistinct(2);
  await expect.poll(() => missing(ben, id, expected), { message: 'Ben sees every family Ada built', timeout: PEER_TIMEOUT }).toEqual([]);
  expect(await counts(ben, id), 'Ben renders what Ada renders').toEqual(await counts(ada, id));
  for (const actor of [ada, ben]) {
    await expect(ui.body(actor, id).locator('[data-node-view-error]'), `${actor.label}: no block falls back to its error placeholder`).toHaveCount(0);
  }
  expect((await renderedBody(ben, id)).decorators, 'the same decorators on both sides').toEqual((await renderedBody(ada, id)).decorators);
  await actors.checkpoint('demo-note');
  await ben.page.getByRole('button', { name: 'Settings', exact: true }).click();
  await ben.page.getByRole('radiogroup', { name: 'Theme' }).getByRole('radio', { name: 'Dark', exact: true }).click();
  await expect(ben.page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await ben.page.keyboard.press('Escape');
  await expect(ben.page.getByRole('radiogroup', { name: 'Theme' })).toBeHidden();
  await expect(ui.body(ben, id).locator('[data-node-view-error]'), 'dark: no block falls back to its error placeholder').toHaveCount(0);
  await actors.checkpoint('demo-note-dark');

  await ben.page.reload();
  await ui.waitLive(ben, id);
  await ben.declareRemount(id);
  await expect.poll(() => missing(ben, id, expected), { message: 'every family survives a reload', timeout: PEER_TIMEOUT }).toEqual([]);
});

const SETUP = [
  '```moss-chart\n{"type":"bar","title":"Concurrent","data":[{"label":"Mon","value":3},{"label":"Tue","value":5}]}\n```',
  '```moss-canvas\n[moss:grid:v2]\n#\n```',
].join('\n\n');

/** The chart's and the canvas's payloads as the editor holds them. */
const payloads = (actor: Actor, id: string) => ui.body(actor, id).evaluate((element) => {
  const editor = (element as HTMLElement & { __lexicalEditor: LexicalEditor }).__lexicalEditor;
  return editor.getEditorState().read(() => {
    const nodes = [...editor.getEditorState()._nodeMap.values()] as unknown as { getType(): string; getConfig(): { type: string; options?: { palette?: string }; data: { value: number }[] }; getGrid(): boolean[] }[];
    const chart = nodes.find(node => node.getType() === 'chart')!.getConfig();
    const grid = nodes.find(node => node.getType() === 'sketch')!.getGrid();
    return { type: chart.type, palette: chart.options?.palette ?? null, values: chart.data.map(point => point.value), cells: grid.flatMap((on, index) => (on ? [index] : [])) };
  });
});

/** Ink at one cell of the canvas as drawn (outside drawing mode only ink paints). */
const inkAt = (canvas: Locator, col: number, row: number) => canvas.evaluate((element, [c, r]) => {
  const surface = element as HTMLCanvasElement;
  const x = Math.floor(((c + 0.5) / 120) * surface.width);
  const y = Math.floor(((r + 0.5) / 60) * surface.height);
  return (surface.getContext('2d')!.getImageData(x, y, 1, 1).data[3] ?? 0) > 0;
}, [col, row]);

async function stroke(page: Page, canvas: Locator, row: number, from: number, to: number): Promise<void> {
  const box = await canvas.boundingBox();
  if (!box) throw new Error('the canvas is not on screen');
  const cell = box.width / 120;
  const y = box.y + (row + 0.5) * cell;
  await page.mouse.move(box.x + (from + 0.5) * cell, y);
  await page.mouse.down();
  await page.mouse.move(box.x + (to + 0.5) * cell, y, { steps: 8 });
  await page.mouse.up();
}

const chartBlock = (actor: Actor, id: string) =>
  ui.body(actor, id).locator('[data-block-decorator-key]').filter({ has: actor.page.locator('[aria-label="Insert paragraph before chart"]') });

async function pick(actor: Actor, id: string, trigger: string, item: string): Promise<void> {
  const chart = chartBlock(actor, id);
  await chart.hover();
  await chart.getByRole('button', { name: trigger, exact: true }).click();
  await actor.page.getByRole('menuitem', { name: item, exact: true }).click();
}

/** Opens the chart's JSON editor; the returned save changes one data point's value in that open draft. */
async function openJson(actor: Actor, id: string): Promise<(point: number, value: number) => Promise<void>> {
  const chart = chartBlock(actor, id);
  await chart.hover();
  await chart.getByRole('button', { name: 'Edit', exact: true }).click();
  const draft = chart.locator('textarea');
  await expect(draft).toBeVisible();
  return async (point, value) => {
    const config = JSON.parse(await draft.inputValue()) as { data: { value: number }[] };
    config.data[point].value = value;
    await draft.fill(JSON.stringify(config, null, 2));
    await chart.getByRole('button', { name: 'Done', exact: true }).click();
    await expect(draft).toHaveCount(0);
  };
}

test('j14 demo note: concurrent chart and canvas edits keep both authors live and after reload @p:col-1 @p:note-2 @evidence', async ({ actors, stack }) => {
  const ada = await actors.session(await actors.principal('ada'));
  const created = await ada.context.request.post('/api/docs', { headers: { origin: stack.baseUrl }, data: { title: 'Concurrent blocks', markdown: SETUP } });
  expect(created.status()).toBe(201);
  const { doc: { id } } = await created.json() as { doc: { id: string } };
  await ada.goto(`/d/${id}`);
  await ui.waitLive(ada, id);
  const benPrincipal = await actors.principal('ben');
  await grantDoc(ada, id, benPrincipal, 'editor');
  const ben = await actors.open(benPrincipal, { path: `/d/${id}`, severable: true });
  await ui.waitLive(ben, id);
  const canvas = (actor: Actor) => ui.body(actor, id).locator('canvas');
  for (const actor of [ada, ben]) {
    await ui.body(actor, id).getByRole('button', { name: 'Draw', exact: true }).click();
    await expect(canvas(actor)).toBeVisible();
  }
  if (!ben.sever) throw new Error('Ben must be severable');
  ben.sever.blackhole();
  try {
    await stroke(ada.page, canvas(ada), 10, 10, 30);
    await stroke(ben.page, canvas(ben), 40, 70, 90);
    await pick(ada, id, 'Bar', 'Line');
    await pick(ben, id, 'Classic', 'Accessible');
    // Both JSON drafts are open before either saves, and each changes a different data point.
    const adaSaves = await openJson(ada, id);
    const benSaves = await openJson(ben, id);
    await adaSaves(0, 30);
    await benSaves(1, 50);
    expect(ben.sever.census().dropped.out, "the cut withheld Ben's writes").toBeGreaterThan(0);
  } finally {
    ben.expectReconnects(1, id);
    ben.sever.reset();
    ben.sever.restore();
  }
  const both = (cells: number[]) => [10, 20, 30].every(col => cells.includes(10 * 120 + col)) && [70, 80, 90].every(col => cells.includes(40 * 120 + col));
  for (const actor of [ada, ben]) {
    await expect.poll(async () => {
      const state = await payloads(actor, id);
      return { type: state.type, palette: state.palette, values: state.values, strokes: both(state.cells) };
    }, { message: `${actor.label}: both chart keys, both data points and both strokes`, timeout: PEER_TIMEOUT }).toEqual({ type: 'line', palette: 'accessible', values: [30, 50], strokes: true });
  }
  for (const actor of [ada, ben]) {
    await ui.body(actor, id).locator('button:has(svg.lucide-check)').click();
    for (const [col, row] of [[20, 10], [80, 40]]) {
      await expect.poll(() => inkAt(canvas(actor), col, row), { message: `${actor.label}: the canvas paints the stroke at ${col},${row}` }).toBe(true);
    }
  }
  await actors.checkpoint('concurrent-blocks');
  for (const actor of [ada, ben]) await expect(ui.pane(actor, id)).toHaveAttribute('data-sync-unacked', '0', { timeout: PEER_TIMEOUT });
  await ben.page.reload();
  await ui.waitLive(ben, id);
  await ben.declareRemount(id);
  await expect.poll(async () => {
    const state = await payloads(ben, id);
    return { type: state.type, palette: state.palette, values: state.values, strokes: both(state.cells) };
  }, { message: 'both authors survive a reload', timeout: PEER_TIMEOUT }).toEqual({ type: 'line', palette: 'accessible', values: [30, 50], strokes: true });
});
