// The strike census in the real app (M5 Slop Cop P1, T5.S1): every block kind on each side of a boundary, every edge
// key and every strike position, then the undo and redo of the key. Struck text is upper case and nothing else is, so
// a note's capitals are what the suggester struck and its lower case letters (with the digits of code) are what must
// stay. Each leg writes its combinations into one note, a section apart, and the owner reviews and accepts them all.
import type { Locator } from '@playwright/test';
import type { Actor } from './actors.ts';
import {
  SUGGEST_REFUSED_ATTR, SUGGESTION_CARD_ATTR, SUGGESTION_ROW_ATTR, SUGGESTION_STATUS_ATTR, SUGGESTIONS_BUTTON_ATTR, SUGGESTIONS_PANEL_ATTR,
  SYNC_UNACKED_ATTR,
} from './contract.ts';
import { grantDoc } from './grants.ts';
import { BIND_TIMEOUT, content, frames, mod, openIn } from './suggest.ts';
import { expect, test, ui } from './test.ts';

type Actors = Parameters<Parameters<typeof test>[2]>[0]['actors'];

export type Kind =
  | 'paragraph' | 'heading' | 'leading heading' | 'list item' | 'nested list item' | 'quote' | 'code block' | 'table'
  | 'decorator' | 'empty paragraph' | 'line break';
/** The kind is the block before the boundary, or the block after it. */
export type Side = 'before' | 'after';
type Key = 'Backspace at the start' | 'Delete at the end' | 'Delete after a line break';
const KEYS: Key[] = ['Backspace at the start', 'Delete at the end', 'Delete after a line break'];
/**
 * start: the next block's first character; end: each block's last; span: across the boundary; whole: the next block;
 * apart: the next block's first and last, live text between them.
 */
type Where = 'start' | 'end' | 'span' | 'whole' | 'apart';
const WHERES: Where[] = ['start', 'end', 'span', 'whole', 'apart'];
const TEXTLESS = new Set<Kind>(['code block', 'decorator', 'empty paragraph']);

interface Combo {
  key: Key;
  where: Where;
  /** The section's own lower case tag, so its texts are unique in the note. */
  tag: string;
  /** The paragraph before the section. */
  gap: string;
  a: string | null;
  b: string | null;
  aKind: Kind | null;
  bKind: Kind;
}

function blockOf(kind: Kind, text: string | null, role: 'a' | 'b', tag: string): string {
  switch (kind) {
    case 'paragraph': return text!;
    case 'heading':
    case 'leading heading': return `## ${text}`;
    case 'list item': return `- ${text}`;
    case 'nested list item': return `- outer ${tag}\n    - ${text}`;
    case 'quote': return `> ${text}`;
    case 'table': return role === 'a' ? `| cell ${tag} | row ${tag} |\n| --- | --- |\n| more ${tag} | ${text} |` : `| ${text} | cell ${tag} |\n| --- | --- |\n| more ${tag} | row ${tag} |`;
    case 'code block': return '```\n123\n```';
    case 'decorator': return '---';
    case 'line break': return role === 'a' ? `first ${tag}\n${text}` : `${text}\nsecond ${tag}`;
    case 'empty paragraph': return '';
  }
}

const caretless = (kind: Kind | null) => kind === 'code block' || kind === 'decorator';

/** The combinations of a leg that apply, each with its texts. */
function combosOf(kind: Kind, side: Side, keys: readonly Key[] = KEYS): Combo[] {
  const combos: Combo[] = [];
  let n = 0;
  for (const key of keys) {
    for (const where of WHERES) {
      const tag = `q${String.fromCharCode(97 + Math.floor(n / 26))}${String.fromCharCode(97 + (n % 26))}`;
      const leading = kind === 'leading heading' && side === 'after';
      const aKind: Kind | null = side === 'before' ? kind : leading ? null : 'paragraph';
      const bKind: Kind = side === 'after' ? kind : 'paragraph';
      const a = aKind && !TEXTLESS.has(aKind) ? `alpha ${tag}${where === 'end' || where === 'span' ? 'Z' : ''}` : null;
      const b = TEXTLESS.has(bKind) ? null : { start: `Zbeta ${tag}`, span: `Zbeta ${tag}`, end: `beta ${tag}Z`, whole: `ZQ${tag.toUpperCase()}`, apart: `Zbeta ${tag}Z` }[where];
      if (key === 'Backspace at the start' && caretless(bKind)) continue;
      if (key !== 'Backspace at the start' && (aKind === null || caretless(aKind))) continue;
      if ((where === 'start' || where === 'whole' || where === 'apart') && !b) continue;
      // A text selection cannot cross into or out of a table cell (Lexical makes it a table selection).
      if (where === 'span' && (!a || !b || aKind === 'table' || bKind === 'table')) continue;
      if (where === 'end' && !a && !b) continue;
      combos.push({ key, where, tag, gap: `gap ${tag} keep.`, a, b, aKind, bKind });
      n += 1;
    }
  }
  return combos;
}

/** The section of a combination: its gap paragraph (none when its block leads the note), then its blocks. */
function sectionOf(combo: Combo, leading: boolean): string[] {
  const blocks = leading ? [] : [combo.gap];
  if (combo.bKind === 'nested list item') {
    blocks.push(`- ${combo.a}\n    - ${combo.b}`);
    return blocks;
  }
  if (combo.aKind && combo.aKind !== 'empty paragraph') blocks.push(blockOf(combo.aKind, combo.a, 'a', combo.tag));
  if (combo.bKind !== 'empty paragraph') blocks.push(blockOf(combo.bKind, combo.b, 'b', combo.tag));
  return blocks;
}

/** The viewport point of the boundary at `offset` in the body text holding `text`. */
async function pointOf(actor: Actor, docId: string, text: string, offset: number): Promise<{ x: number; y: number }> {
  return ui.body(actor, docId).evaluate((root, { text, offset }) => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
      const at = node.data.indexOf(text);
      if (at < 0) continue;
      const range = document.createRange();
      const i = at + offset;
      // The character before the boundary, or after it at the text's start: its edge is the boundary.
      range.setStart(node, i > 0 ? i - 1 : i);
      range.setEnd(node, i > 0 ? i : i + 1);
      const rect = range.getBoundingClientRect();
      // Just inside that character, so the click lands on this side of a block edge.
      return { x: i > 0 ? rect.right - 1 : rect.left + 1, y: rect.top + rect.height / 2 };
    }
    throw new Error(`no body text "${text}"`);
  }, { text, offset });
}

/**
 * The caret at `offset` in the body text holding `text`, or a selection from there to `focus` in the one holding
 * `to`: clicked (and shift-clicked) as a user would, then set exactly in the DOM.
 */
async function select(actor: Actor, docId: string, text: string, offset: number, to = text, focus = offset): Promise<void> {
  const { page } = actor;
  const from = await pointOf(actor, docId, text, offset);
  await page.mouse.click(from.x, from.y);
  if (to !== text || focus !== offset) {
    const end = await pointOf(actor, docId, to, focus);
    await page.keyboard.down('Shift');
    await page.mouse.click(end.x, end.y);
    await page.keyboard.up('Shift');
  }
  await ui.body(actor, docId).evaluate((root, { text, offset, to, focus }) => {
    const find = (wanted: string): [Text, number] => {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
        const at = node.data.indexOf(wanted);
        if (at >= 0) return [node, at];
      }
      throw new Error(`no body text "${wanted}"`);
    };
    const [start, startAt] = find(text);
    const [end, endAt] = find(to);
    const selection = window.getSelection()!;
    if (selection.anchorNode === start && selection.anchorOffset === startAt + offset && selection.focusNode === end && selection.focusOffset === endAt + focus) return;
    selection.setBaseAndExtent(start, startAt + offset, end, endAt + focus);
  }, { text, offset, to, focus });
  await frames(actor);
  await page.waitForTimeout(50);
}

async function press(actor: Actor, key: string): Promise<void> {
  await actor.page.keyboard.press(key);
  await frames(actor);
}

/**
 * The body's editable text (decorators' own chrome left out): its capitals that `::highlight(suggest-delete)` does
 * not cover, and its lower case letters and digits.
 */
async function readBody(actor: Actor, docId: string, tags: readonly string[] | null = null): Promise<{ unpainted: string[]; kept: string }> {
  return ui.body(actor, docId).evaluate((root, tags) => {
    const ranges = [...((CSS as unknown as { highlights?: Map<string, Set<Range>> }).highlights?.get('suggest-delete') ?? [])];
    const unpainted: string[] = [];
    let kept = '';
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) => (node.parentElement?.closest('[contenteditable="false"]') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
    });
    for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
      const { data } = node;
      for (let i = 0; i < data.length; i += 1) {
        if (/[a-z0-9]/.test(data[i])) kept += data[i];
        if (!/[A-Z]/.test(data[i])) continue;
        // Only the sections played so far: the rest of the note is not struck yet.
        if (tags && !tags.some((tag) => data.includes(tag) || data.includes(tag.toUpperCase()))) continue;
        const text = node;
        if (!ranges.some((range) => range.comparePoint(text, i) === 0 && range.comparePoint(text, i + 1) === 0)) unpainted.push(`${data[i]} in "${data}"`);
      }
    }
    return { unpainted, kept };
  }, tags);
}

const kept = (text: string) => text.replace(/[^a-z0-9]/g, '');
/** Whether every character of `want` stays in `text`, in order: an export may add markup for the author's own breaks. */
const keeps = (text: string, want: string): boolean => {
  let at = 0;
  for (const char of text) if (at < want.length && char === want[at]) at += 1;
  return at === want.length;
};
const capitals = (text: string) => text.replace(/[^A-Z]/g, '');

async function noteFor(ada: Actor, ben: { principal: Parameters<typeof grantDoc>[2] }, markdown: string): Promise<string> {
  const response = await ada.context.request.post('/api/docs', { headers: { origin: new URL(ada.page.url()).origin }, data: { markdown } });
  expect(response.status()).toBe(201);
  const docId = ((await response.json()) as { doc: { id: string } }).doc.id;
  await grantDoc(ada, docId, ben.principal, 'suggester');
  return docId;
}

/** One combination in Ben's Suggest pane: the strikes, the key, its undo and its redo, F checked after each. */
async function play(ben: Actor, docId: string, combo: Combo, baseline: string, played: readonly string[]): Promise<void> {
  const label = `${combo.bKind === combo.aKind ? combo.aKind : `${combo.aKind ?? 'nothing'} | ${combo.bKind}`}, ${combo.key}, strike ${combo.where}`;
  // F once it has settled: the same reading twice, 200 ms apart.
  const settled = async () => {
    let last = JSON.stringify(await readBody(ben, docId, played));
    for (let tries = 0; tries < 25; tries += 1) {
      await ben.page.waitForTimeout(200);
      const next = JSON.stringify(await readBody(ben, docId, played));
      if (next === last) break;
      last = next;
    }
    return JSON.parse(last) as Awaited<ReturnType<typeof readBody>>;
  };
  // After an undo the struck capitals may be live again: undo takes back the strike when the key changed nothing.
  const look = async (when: string, struck = true) => {
    const body = await settled();
    if (struck) expect(body.unpainted, `${label}, ${when}: every capital F shows paints struck`).toEqual([]);
    expect(body.kept, `${label}, ${when}: F keeps every unstruck character`).toBe(baseline);
  };
  const { a, b } = combo;
  if (combo.where === 'start') {
    await select(ben, docId, b!, 1);
    await press(ben, 'Backspace');
  } else if (combo.where === 'whole') {
    // From its end to the line's start, as a keyboard user selects a block's text.
    await select(ben, docId, b!, b!.length);
    await press(ben, 'Shift+Home');
    await press(ben, 'Backspace');
  } else if (combo.where === 'apart') {
    await select(ben, docId, b!, 1);
    await press(ben, 'Backspace');
    await select(ben, docId, b!, b!.length);
    await press(ben, 'Backspace');
  } else if (combo.where === 'span') {
    await select(ben, docId, a!, a!.length - 1, b!, 1);
    await press(ben, 'Backspace');
  } else {
    for (const text of [a, b]) {
      if (!text) continue;
      await select(ben, docId, text, text.length);
      await press(ben, 'Backspace');
    }
  }
  await look('after the strikes');
  // An empty block is made just before the key: after the gap (the block before) or after `a` (the block after).
  if (combo.aKind === 'empty paragraph') {
    await select(ben, docId, combo.gap, combo.gap.length);
    await press(ben, 'Enter');
  } else if (combo.bKind === 'empty paragraph') {
    await select(ben, docId, a!, a!.length);
    await press(ben, 'Enter');
  }
  if (combo.key === 'Backspace at the start') {
    if (b) await select(ben, docId, b, 0);
    await press(ben, 'Backspace');
  } else {
    if (a) await select(ben, docId, a, a.length);
    if (combo.key === 'Delete after a line break') await press(ben, 'Shift+Enter');
    await press(ben, 'Delete');
  }
  await look(`after ${combo.key}`);
  await press(ben, `${mod}+z`);
  await look(`after undo of ${combo.key}`, false);
  await press(ben, `${mod}+Shift+z`);
  await look(`after redo of ${combo.key}`);
  // Backspace after a table or a block decorator selects that block, and a later key would act on it: Arrow Down
  // leaves it, as a user does.
  if (combo.key === 'Backspace at the start' && (combo.aKind === 'table' || caretless(combo.aKind))) await press(ben, 'ArrowDown');
}

/** The owner's review: Edit-mode paint, the working export, every card, then accept of each. */
async function review(ada: Actor, ben: Actor, docId: string, original: string, label: string): Promise<void> {
  await expect(ui.pane(ben, docId), `${label}: acknowledged`).toHaveAttribute(SYNC_UNACKED_ATTR, '0', { timeout: BIND_TIMEOUT });
  await expect(ui.pane(ben, docId), `${label}: never refused`).toHaveAttribute(SUGGEST_REFUSED_ATTR, '0');
  // The author leaves, so accepting his records never touches his socket.
  await ben.goto('/');
  await expect(ada.page.locator(`[${SUGGESTIONS_BUTTON_ATTR}]`)).toHaveAttribute('aria-label', /(?<!\d)0*[1-9]\d* open/, { timeout: BIND_TIMEOUT });
  await expect.poll(async () => (await readBody(ada, docId)).unpainted, { message: `${label}: Edit mode paints every struck capital`, timeout: BIND_TIMEOUT }).toEqual([]);
  const previews = await ui.pane(ada, docId).locator('[data-suggest-preview]').allTextContents();
  expect(capitals(previews.join(' ')), `${label}: no Edit-mode insert mark previews a struck capital (${previews.join(' | ')})`).toBe('');
  const working = await content(ada, docId, 'working');
  expect(capitals(working), `${label}: the working export leaves every struck capital out`).toBe('');
  expect(keeps(kept(working), kept(original)), `${label}: the working export keeps every unstruck character (${working})`).toBe(true);

  const panel = ada.page.locator(`[${SUGGESTIONS_PANEL_ATTR}]`);
  const open: Locator = panel.locator(`[${SUGGESTION_CARD_ATTR}][${SUGGESTION_STATUS_ATTR}="open"]`);
  if (!(await panel.isVisible())) await ada.page.locator(`[${SUGGESTIONS_BUTTON_ATTR}]`).click();
  await expect(panel).toBeVisible();
  await expect.poll(() => open.count(), { message: `${label}: open cards`, timeout: BIND_TIMEOUT }).toBeGreaterThan(0);
  for (let guard = 0; guard < 40 && (await open.count()) > 0; guard += 1) {
    const card = open.first();
    const accept = card.getByRole('button', { name: 'Accept' });
    const more = card.getByRole('button', { name: /^Show all/ });
    await expect.poll(async () => (await more.count()) > 0 || (await accept.isEnabled()), { message: `${label}: a card loads`, timeout: BIND_TIMEOUT }).toBe(true);
    if ((await more.count()) > 0) await more.click();
    await expect(accept, `${label}: the card can be accepted (${await card.innerText()})`).toBeEnabled({ timeout: BIND_TIMEOUT });
    const inserted = await card.locator(`[${SUGGESTION_ROW_ATTR}="insert"] > span.min-w-0 > span:first-child`).allInnerTexts();
    expect(capitals(inserted.join(' ')), `${label}: the card adds no struck capital (${inserted.join(' | ')})`).toBe('');
    const before = await open.count();
    await accept.click();
    // A card's preview is fetched when its record changes, so accepting another record can leave it stale: the
    // accept answers `changed` (409), the card fetches again and Accept is pressed again.
    const deadline = Date.now() + BIND_TIMEOUT;
    let again = 0;
    while ((await open.count()) >= before) {
      const text = await card.innerText().catch(() => '');
      if (text.includes('It changed while you reviewed it') && again < 3 && (await accept.isEnabled().catch(() => false))) {
        again += 1;
        ada.expectHttp(409, /\/suggestions\/[^/]+\/accept$/);
        await accept.click();
      }
      if (Date.now() > deadline) throw new Error(`${label}: the accept did not land: ${text}`);
      await ada.page.waitForTimeout(250);
    }
  }
  await expect.poll(async () => capitals(await content(ada, docId)), { message: `${label}: accept leaves every struck capital out`, timeout: BIND_TIMEOUT }).toBe('');
  const accepted = await content(ada, docId);
  expect(keeps(kept(accepted), kept(original)), `${label}: accept keeps every unstruck character (${accepted})`).toBe(true);
}

/** One leg: every combination of `kind` on `side` of the boundary, in one note (one note each when its block leads). */
export async function censusLeg(actors: Actors, kind: Kind, side: Side): Promise<void> {
  const leading = kind === 'leading heading';
  const combos = combosOf(kind, side, leading && side === 'after' ? ['Backspace at the start'] : KEYS);
  expect(combos.length, 'combinations').toBeGreaterThan(0);
  const adaPrincipal = await actors.principal('ada');
  const ada = await actors.open(adaPrincipal);
  const benPrincipal = await actors.principal('ben');
  const ben = await actors.session(benPrincipal);
  // A block that leads its note gets a note of its own per combination; every other leg shares one.
  const notes = leading ? combos.map((combo) => [combo]) : [combos];
  for (const group of notes) {
    const blocks = group.flatMap((combo) => sectionOf(combo, leading));
    const markdown = `${[...blocks, 'closing keep.'].join('\n\n')}\n`;
    const docId = await noteFor(ada, { principal: benPrincipal }, markdown);
    const original = await content(ada, docId);
    await openIn(ben, docId, 'suggest');
    await openIn(ada, docId, 'edit');
    if (group === notes[0]) await actors.requireDistinct(2);
    const baseline = (await readBody(ben, docId)).kept;
    expect(baseline, 'the note shows its text').not.toBe('');
    const played: string[] = [];
    for (const combo of group) {
      played.push(combo.tag);
      await play(ben, docId, combo, baseline, played);
    }
    await review(ada, ben, docId, original, `${kind} ${side} the boundary`);
  }
}
