// The browser steps of scripts/demo.mjs (T8.5p). Like prelude.js, qa.mjs inlines this file without its `export`
// keywords after the prelude, so each step runs in the stack's bb Browser Automation session with the prelude's
// actors. Every step reads what the note already holds first and does only what is missing, so a re-run converges
// instead of duplicating. The planners at the top are pure; scripts/demo.test.mjs tests them in Node.
/* global P, DOM, MOD, actor, visit, shot */

/** The demo folder (top level of the vault) and, per title, the oldest note of that title inside it. */
export function planNotes(workspace, folderName, titles) {
  const folder = (workspace.folders ?? []).find((f) => f.name === folderName && f.path === `Notes/${folderName}`) ?? null;
  const ids = {};
  for (const title of titles) {
    const inside = folder ? (workspace.docs ?? []).filter((d) => d.title === title && d.folderPath === folder.path) : [];
    inside.sort((a, b) => a.createdAt - b.createdAt);
    ids[title] = inside[0]?.id ?? null;
  }
  return { folderId: folder?.id ?? null, ids };
}

/** Every node family the every-node note holds, as the selector its rendered form carries inside the body. */
export const EVERY_NODE_FAMILIES = [
  { family: 'heading 1', selector: 'h1' },
  { family: 'heading 2', selector: 'h2' },
  { family: 'heading 3', selector: 'h3' },
  { family: 'heading 4', selector: 'h4' },
  { family: 'bulleted list', selector: 'ul.list-disc' },
  { family: 'nested list', selector: 'li > ul, li > ol' },
  { family: 'numbered list', selector: 'ol' },
  { family: 'checklist item', selector: 'li[role="checkbox"]' },
  { family: 'bold', selector: 'strong' },
  { family: 'italic', selector: 'em' },
  { family: 'inline code', selector: 'code' },
  { family: 'link', selector: 'a[href]' },
  { family: 'formula', selector: '[data-formula-node-key]' },
  { family: 'wiki link', selector: '[data-file-link-node-key]' },
  { family: 'embed pill', selector: '[data-embed-pill-node-key]' },
  { family: 'color code', selector: '[data-color-node-key]' },
  { family: 'quote', selector: 'blockquote' },
  { family: 'table', selector: 'table.moss-table' },
  { family: 'callout', selector: '.moss-callout' },
  { family: 'tabs', selector: '.moss-tab-group' },
  { family: 'code block', selector: '.moss-codeblock-pre' },
  { family: 'chart', selector: '[aria-label="Insert paragraph before chart"]' },
  { family: 'canvas', selector: '[aria-label="Insert paragraph before canvas"]' },
  { family: 'HTML block', selector: '[data-moss-html-preview-viewport]' },
  { family: 'divider', selector: 'hr' },
  { family: 'web embed', selector: '[data-web-embed-node]' },
  { family: 'image', selector: 'img[src*="/assets/"]' },
  { family: 'video', selector: '[data-video-node-kind="local"]' },
];

/** The families a body census lacks, and any block drawn as its error placeholder. */
export function familyProblems(census, families = EVERY_NODE_FAMILIES) {
  const problems = families.filter(({ family }) => !census[family]).map(({ family }) => `no ${family}`);
  if (census.errors) problems.push(`${census.errors} blocks show their error placeholder`);
  return problems;
}

/** Where two body censuses differ, as "family: want, got". */
export function censusDiff(want, got) {
  return [...new Set([...Object.keys(want), ...Object.keys(got)])]
    .filter((key) => (want[key] ?? 0) !== (got[key] ?? 0))
    .sort()
    .map((key) => `${key}: ${want[key] ?? 0}, got ${got[key] ?? 0}`);
}

/** The markdown's top-level blocks: split at blank lines outside ``` fences and ::: containers. */
export function markdownBlocks(markdown) {
  const blocks = [];
  let current = [];
  let fence = null;
  for (const line of markdown.split('\n')) {
    if (fence) {
      current.push(line);
      if (line.trim() === fence) fence = null;
      continue;
    }
    const open = /^(```|:::)/.exec(line);
    if (open) fence = open[1];
    if (!open && line.trim() === '') {
      if (current.length) blocks.push(current.join('\n'));
      current = [];
      continue;
    }
    current.push(line);
  }
  if (current.length) blocks.push(current.join('\n'));
  return blocks;
}

/** The first half of the markdown's blocks: what an interrupted paste leaves. */
export function partialMarkdown(markdown) {
  const blocks = markdownBlocks(markdown);
  return blocks.slice(0, Math.ceil(blocks.length / 2)).join('\n\n');
}

export const mediaKind = (file) => (file.type.startsWith('video/') ? 'video' : 'image');

/**
 * What a note still needs, from its body as read: the whole paste when the body lacks its last line (after clearing
 * a partial paste, unless the note has comments, suggestions or named versions, which only a finished note gets),
 * then each media file of a kind the body holds fewer of than the note wants.
 */
export function notePlan(body, { media = [], later = false } = {}) {
  const paste = !body.done;
  if (paste && !body.empty && later) {
    throw new Error('the note lacks its last line but has comments, suggestions or versions: it was edited after it was built, so the demo leaves it alone');
  }
  const have = paste ? { image: 0, video: 0 } : { image: body.images, video: body.videos };
  const missing = media.filter((file) => {
    const kind = mediaKind(file);
    if (have[kind] > 0) {
      have[kind] -= 1;
      return false;
    }
    return true;
  });
  return { clear: paste && !body.empty, paste, media: missing };
}

/**
 * What keeps a built demo from holding exactly one of each thing it makes: [] when it does. A suggestion is one edit
 * that the server may keep as several records (a replacement is a deletion and an insertion), so each author needs
 * at least one pending; a rerun must leave the tallies as they were (`seenDiff`).
 */
export function demoProblems(seen, want) {
  const problems = [];
  const once = (what, n) => {
    if (n !== 1) problems.push(`${what}: ${n ?? 0}, not 1`);
  };
  for (const title of want.titles) once(`note "${title}"`, seen.titles[title]);
  for (const text of want.comments) once(`comment "${text}"`, seen.comments[text]);
  for (const r of want.reactions) once(`${r.emoji} on "${r.on}"`, seen.reactions[`${r.emoji} ${r.on}`]);
  for (const name of want.pending) if (!seen.pending[name]) problems.push(`pending suggestion by ${name}: none`);
  for (const name of want.versions) once(`version "${name}"`, seen.versions[name]);
  once('view link to the folder', seen.viewLinks);
  for (const kind of ['image', 'video']) once(`${kind} in "${want.mediaNote}"`, seen.families[kind]);
  problems.push(...familyProblems(seen.families).map((p) => `"${want.mediaNote}": ${p}`));
  return problems;
}

/** Where two `verify` readings differ, tally by tally: a rerun that duplicated or dropped anything shows here. */
export function seenDiff(before, after) {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].sort().flatMap((key) => {
    const [a, b] = [before[key], after[key]];
    if (typeof a === 'object' || typeof b === 'object') return censusDiff(a ?? {}, b ?? {}).map((d) => `${key} ${d}`);
    return a === b ? [] : [`${key}: ${a}, got ${b}`];
  });
}

/** The wanted threads' roots the note lacks, and the replies it lacks under roots it has. */
export function commentGaps(listing, wanted) {
  const roots = [];
  const replies = [];
  for (const thread of wanted) {
    const root = listing.find((c) => c.parentId === null && c.text.trim() === thread.text);
    if (!root) {
      roots.push({ by: thread.by, quote: thread.quote, text: thread.text });
      continue;
    }
    for (const reply of thread.replies ?? []) {
      if (!listing.some((c) => c.parentId === root.id && c.text.trim() === reply.text)) {
        replies.push({ by: reply.by, root: thread.text, rootId: root.id, text: reply.text });
      }
    }
  }
  return { roots, replies };
}

export const hasVersion = (versions, name) => versions.some((v) => v.name === name);

const CLOSED = new Set(['accepted', 'rejected', 'withdrawn']);
export const pendingBy = (suggestions, authorName) => suggestions.some((s) => s.author?.name === authorName && !CLOSED.has(s.status));

/**
 * What keeps a frame of Ada's window from being the signature, as `inspectSignature` reads it: [] when the note is
 * live and bound, and the sentence, both halves of Ben's suggestion, his labelled caret and rich blocks are in view.
 */
export function signatureProblems(frame, { name, sentence, find, replace }) {
  const problems = [];
  if (frame.docState !== 'live') problems.push(`the note is ${frame.docState ?? 'missing'}, not live`);
  if (frame.connection !== 'online') problems.push(`the connection is ${frame.connection ?? 'missing'}`);
  if (!frame.binding) problems.push('the body is not bound');
  for (const words of [sentence, find, replace]) if (!frame.text.includes(words)) problems.push(`the sentence's "${words}" is not in view`);
  if (!frame.caretLabels.some((label) => label.includes(name))) problems.push(`${name}'s caret label is not in view`);
  if (frame.richBlocks < 2) problems.push(`${frame.richBlocks} rich blocks in view, not 2`);
  return problems;
}

/**
 * A shot that shows what `problems` wants: the frame is checked before and after the capture, and an attempt whose
 * preparation fails or whose frame is wrong either time is retaken. Fails with the last problems.
 */
export async function verifiedShot({ attempts = 3, prepare, inspect, problems, capture }) {
  let last = [];
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await prepare(attempt);
    } catch (error) {
      last = [error.message];
      continue;
    }
    last = problems(await inspect());
    if (last.length) continue;
    const path = await capture();
    last = problems(await inspect());
    if (!last.length) return path;
  }
  throw new Error(`no clean frame in ${attempts} tries: ${last.join('; ')}`);
}

/** What keeps the suggestions panel from showing `expected` open cards with their changes: [] when it does. */
export function panelProblems(cards, expected) {
  const problems = [];
  if (cards.length !== expected) problems.push(`${cards.length} of ${expected} cards`);
  cards.forEach((card, i) => {
    if (card.loading) problems.push(`card ${i + 1} is loading`);
    else if (card.failed) problems.push(`card ${i + 1}: ${card.failed}`);
    else if (!card.rows) problems.push(`card ${i + 1} shows no change`);
  });
  return problems;
}

/** Ids of suggestions made, dropped or updated between two listings. */
export function changedSuggestions(before, after) {
  const key = (s) => `${s.status}:${s.createdAt}:${s.updatedAt}`;
  const was = new Map(before.map((s) => [s.id, key(s)]));
  const now = new Map(after.map((s) => [s.id, key(s)]));
  return [...new Set([...was.keys(), ...now.keys()])].filter((id) => was.get(id) !== now.get(id)).sort();
}

// ---------- page helpers (named apart from the prelude's) ----------

const pause = (ms) => new Promise((done) => setTimeout(done, ms));

async function until(what, check, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    let failure = null;
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      failure = error;
    }
    if (Date.now() > deadline) throw new Error(`timed out: ${what}${failure ? ` (${failure.message})` : ''}`);
    await pause(200);
  }
}

// Puppeteer's `aria/` query: its `::-p-aria()` form loses its argument under `visible: true` in this build.
const aria = (role, name) => `aria/${name}[role="${role}"]`;

/** The prelude's actor, with a 15 s default wait for every selector. */
async function person(label, options) {
  // Auth allows 10 sign-ins a minute per address; a refused sign-in waits out the window once.
  const page = await actor(label, options).catch(async (error) => {
    if (!/: 429$/.test(error.message)) throw error;
    await pause(61_000);
    return actor(label, options);
  });
  page.setDefaultTimeout(15_000);
  return page;
}

/** The open dialog named `name` (by aria-label or aria-labelledby). */
async function dialogNamed(page, name, timeout = 15_000) {
  const handle = await page.waitForFunction((name) => [...document.querySelectorAll('[role="dialog"]')].find((d) => {
    const by = d.getAttribute('aria-labelledby');
    const label = d.getAttribute('aria-label') ?? (by ? by.split(' ').map((id) => document.getElementById(id)?.textContent ?? '').join(' ') : '');
    return label.trim() === name && d.getBoundingClientRect().width > 0;
  }) ?? null, { timeout }, name);
  return handle.asElement();
}

async function press(scope, role, name, timeout = 15_000) {
  const element = await scope.waitForSelector(aria(role, name), { visible: true, timeout });
  await element.click();
  return element;
}

async function chord(page, ...keys) {
  for (const key of keys) await page.keyboard.down(key);
  for (const key of [...keys].reverse()) await page.keyboard.up(key);
}

/** A same-origin request from the page, with its session. */
async function call(page, path, { method = 'GET', body } = {}) {
  return page.evaluate(async ({ path, method, body }) => {
    const response = await fetch(path, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    const text = await response.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      // not JSON
    }
    return { status: response.status, json };
  }, { path, method, body });
}

async function read(page, path) {
  const answer = await call(page, path);
  if (answer.status !== 200) throw new Error(`GET ${path}: ${answer.status}`);
  return answer.json;
}

const paneOf = (id) => `[${DOM.EDITOR_PANE_ATTR}][${DOM.DOC_ID_ATTR}="${id}"]`;
const bodyOf = (id) => `${paneOf(id)} [${DOM.BODY_BINDING_ATTR}]`;
const titleOf = (id) => `${paneOf(id)} [${DOM.TITLE_BINDING_ATTR}]`;
const folderRowOf = (name) => `[aria-label^=${JSON.stringify(`${name} folder, `)}]`;

const paneIds = (page) => page.$$eval(`[${DOM.EDITOR_PANE_ATTR}]`, (panes, attr) => panes.map((p) => p.getAttribute(attr) ?? ''), DOM.DOC_ID_ATTR);

/** Opens the note and waits for its body to bind (`live`, or `readonly`). */
/**
 * Opens the note, waits for its body to bind, and puts the pane in `mode`: an owner toggles between `edit` and
 * `review` with "Review suggestions"; a suggester is locked in `suggest`.
 */
async function openNote(page, id, mode = 'edit') {
  if (!new URL(page.url()).pathname.endsWith(`/d/${id}`)) await visit(page, `/d/${id}`);
  const pane = `${paneOf(id)}[${DOM.DOC_STATE_ATTR}="live"]`;
  await page.waitForSelector(`${pane} [${DOM.BODY_BINDING_ATTR}="live"], ${pane} [${DOM.BODY_BINDING_ATTR}="readonly"]`, { timeout: 20_000 });
  const current = () => page.$eval(paneOf(id), (el, attr) => el.getAttribute(attr), DOM.EDIT_MODE_ATTR);
  if (mode !== 'suggest' && (await current()) !== mode) await press(page, 'button', 'Review suggestions');
  await until(`the note is in ${mode} mode`, async () => (await current()) === mode);
  await page.waitForSelector(`${pane} [${DOM.BODY_BINDING_ATTR}="${mode === 'review' ? 'readonly' : 'live'}"]`, { timeout: 20_000 });
}

async function settle(page, id) {
  await page.waitForSelector(`${paneOf(id)}[${DOM.SYNC_UNACKED_ATTR}="0"]`, { timeout: 20_000 });
}

const frames = (page) => page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));

/** A DOM selection over `text` in the body (or the caret `offset` characters into it); Lexical follows it. */
async function selectRendered(page, id, text, offset = 0, length = text.length) {
  await page.$eval(bodyOf(id), (root, { text, offset, length }) => {
    root.focus();
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const at = (node.textContent ?? '').indexOf(text);
      if (at < 0) continue;
      const range = document.createRange();
      range.setStart(node, at + offset);
      range.setEnd(node, at + offset + length);
      document.getSelection().removeAllRanges();
      document.getSelection().addRange(range);
      return;
    }
    throw new Error(`no body text "${text}"`);
  }, { text, offset, length });
  await frames(page);
}

/** Selects `needle` through the editor itself, as the comment journeys do. */
async function selectInEditor(page, id, needle) {
  await page.$eval(bodyOf(id), (element, needle) => {
    element.focus();
    const editor = element.__lexicalEditor;
    editor.update(() => {
      const node = [...editor.getEditorState()._nodeMap.values()].find((n) => n.getType() === 'text' && n.getTextContent().includes(needle));
      if (!node) throw new Error(`no text node holds "${needle}"`);
      const at = node.getTextContent().indexOf(needle);
      node.select(at, at + needle.length);
    }, { discrete: true });
  }, needle);
  await frames(page);
}

/** A clipboard paste of markdown into the body, as a person pasting a copied note does. */
async function pasteMarkdown(page, id, markdown) {
  await page.$eval(bodyOf(id), (element, text) => {
    const clipboardData = new DataTransfer();
    clipboardData.setData('text/plain', text);
    clipboardData.setData('text/markdown', text);
    element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData }));
  }, markdown);
}

/** A clipboard paste of one file at the caret, as a copied file arrives. */
async function pasteFile(page, id, file) {
  return page.$eval(bodyOf(id), (element, file) => {
    const data = new DataTransfer();
    data.items.add(new File([Uint8Array.from(atob(file.base64), (c) => c.charCodeAt(0))], file.name, { type: file.type }));
    const event = new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true });
    element.dispatchEvent(event);
    return event.defaultPrevented;
  }, file);
}

const count = (page, selector) => page.$$eval(selector, (all) => all.length);

/** How many of each node family the body renders, and how many blocks show their error placeholder. */
const census = (page, id) => page.$eval(bodyOf(id), (root, families) => ({
  ...Object.fromEntries(families.map(({ family, selector }) => [family, root.querySelectorAll(selector).length])),
  errors: root.querySelectorAll('[data-node-view-error]').length,
}), EVERY_NODE_FAMILIES);

/** Waits until the body renders every family, then returns its census; fails naming what is missing. */
async function everyFamily(page, id, when) {
  let last = {};
  await until(`every node family renders ${when}`, async () => familyProblems((last = await census(page, id))).length === 0, 30_000)
    .catch((error) => { throw new Error(`${error.message}: ${familyProblems(last).join(', ')}`); });
  return last;
}

/** The body as the note step reads it: empty, holding its last line, and its uploaded images and videos. */
const bodyState = (page, id, doneText) => page.$eval(bodyOf(id), (root, { doneText, families }) => ({
  empty: (root.textContent ?? '').trim() === '' && !root.querySelector('[data-lexical-decorator="true"]'),
  done: (root.textContent ?? '').includes(doneText),
  images: root.querySelectorAll(families.find((f) => f.family === 'image').selector).length,
  videos: root.querySelectorAll(families.find((f) => f.family === 'video').selector).length,
}), { doneText, families: EVERY_NODE_FAMILIES });

const mediaSelector = (id, file) => `${bodyOf(id)} ${EVERY_NODE_FAMILIES.find((f) => f.family === mediaKind(file)).selector}`;

/** Selects the whole body and deletes it with the keyboard, as a person clearing a botched paste does. */
async function clearBody(page, id) {
  await page.$eval(bodyOf(id), (root) => root.focus());
  await chord(page, MOD, 'KeyA');
  await page.keyboard.press('Backspace');
  await until('the body is empty', () => page.$eval(bodyOf(id), (root) => (root.textContent ?? '').trim() === '' && !root.querySelector('[data-lexical-decorator="true"]')));
}

/** Scrolls the block holding `text` (or matching `selector`) to the middle of the editor. */
async function center(page, id, { text, selector }) {
  await page.$eval(bodyOf(id), (root, { text, selector }) => {
    const target = selector ? root.querySelector(selector) : [...root.querySelectorAll('p, li, td, h1, h2, h3')].find((el) => el.textContent.includes(text));
    if (!target) throw new Error(`nothing to scroll to: ${text ?? selector}`);
    target.scrollIntoView({ block: 'center' });
  }, { text: text ?? null, selector: selector ?? null });
  await pause(400);
}

/** Ada's window as the signature needs it: note state, connection, binding, and what is inside the editor's view. */
function inspectSignature(page, docId) {
  return page.evaluate(({ docId, DOM }) => {
    const pane = document.querySelector(`[${DOM.EDITOR_PANE_ATTR}][${DOM.DOC_ID_ATTR}="${docId}"]`);
    const body = pane?.querySelector(`[${DOM.BODY_BINDING_ATTR}]`);
    const canvas = pane?.querySelector(`[${DOM.EDITOR_CANVAS_ATTR}]`) ?? pane;
    const view = canvas?.getBoundingClientRect();
    const inView = (el) => {
      const r = el.getBoundingClientRect();
      return view && r.width > 0 && r.height > 0 && r.bottom > view.top && r.top < view.bottom && r.top < innerHeight && r.bottom > 0;
    };
    const blocks = body ? [...body.children].filter(inView) : [];
    const rich = blocks.filter((el) => el.matches('table, [data-lexical-decorator="true"]') || el.querySelector('table'));
    const labels = [...document.querySelectorAll(`[${DOM.REMOTE_CARET_ATTR}]`)].flatMap((c) => {
      const label = c.querySelector('[data-cursor-label]');
      return label && getComputedStyle(label).display !== 'none' && getComputedStyle(label).visibility !== 'hidden' && inView(label) ? [label.textContent] : [];
    });
    return {
      docState: pane?.getAttribute(DOM.DOC_STATE_ATTR) ?? null,
      connection: (pane?.querySelector(`[${DOM.CONNECTION_ATTR}]`) ?? document.querySelector(`[${DOM.CONNECTION_ATTR}]`))?.getAttribute(DOM.CONNECTION_ATTR) ?? null,
      binding: body?.getAttribute(DOM.BODY_BINDING_ATTR) || null,
      text: blocks.map((el) => el.textContent).join('\n'),
      caretLabels: labels,
      richBlocks: rich.length,
    };
  }, { docId, DOM });
}

async function calm(page) {
  await page.keyboard.press('Escape');
  await page.evaluate(() => document.activeElement?.blur?.());
  await page.mouse.move(2, 2);
  await pause(300);
}

// ---------- the thread popover ----------

const POPOVER = '.moss-comment-popover';

/** Opens the thread whose root says `rootText`, from its gutter icon. */
async function openThread(page, rootId, rootText) {
  await page.keyboard.press('Escape');
  const direct = await page.$(`[data-comment-gutter-id="${rootId}"]`);
  const gutters = direct ? [direct] : await page.$$('[data-comment-gutter-id]');
  for (const gutter of gutters) {
    await gutter.evaluate((el) => el.scrollIntoView({ block: 'center' }));
    await gutter.click();
    const shown = await until('a thread opens', () => page.$(POPOVER), 5_000).catch(() => null);
    if (shown && (await shown.evaluate((el, text) => el.textContent.includes(text), rootText))) return shown;
    await page.keyboard.press('Escape');
  }
  throw new Error(`no gutter opens the thread "${rootText}"`);
}

const messageIn = (popover, text) => popover.evaluateHandle((el, text) =>
  [...el.querySelectorAll('[data-comment-message]')].find((m) => m.textContent.includes(text)) ?? null, text);

// ---------- steps ----------

export const STEPS = {
  /** Ada's demo folder, made from the sidebar's Folder actions when it is missing. */
  async folder({ folderName }) {
    const page = await person('ada');
    await visit(page, '/');
    const planned = planNotes(await read(page, '/api/workspace'), folderName, []);
    if (planned.folderId) return { folderId: planned.folderId, created: false };
    await press(page, 'button', 'Folder actions');
    await press(page, 'menuitem', 'New Folder');
    const input = await page.waitForSelector('input[placeholder="Folder name..."]', { visible: true });
    await input.type(folderName);
    await page.keyboard.press('Enter');
    const folderId = await until('the folder is listed', async () => planNotes(await read(page, '/api/workspace'), folderName, []).folderId);
    return { folderId, created: true };
  },

  /**
   * One note in the folder: "+ Note" with the folder active, the title, Enter, a markdown paste, then media pasted at
   * the end. A note of that title already there is read first and only what it lacks is finished: the paste when its
   * body lacks `doneText` (a partial paste is cleared first), then each missing media file. `stopAfter` ('title',
   * 'paste' with half the blocks, or 'media' after the first file) stops early, as an interrupted run does.
   */
  async note({ folderName, title, markdown, doneText, media = [], mediaAfter = null, stopAfter = null }) {
    const page = await person('ada');
    await visit(page, '/');
    const planned = planNotes(await read(page, '/api/workspace'), folderName, [title]);
    if (!planned.folderId) throw new Error(`no folder ${folderName}; run the folder step first`);
    let id = planned.ids[title];
    const created = !id;
    const changed = [];
    if (created) {
      // A new note lands in the active folder: pick it in the sidebar first.
      const row = await page.waitForSelector(folderRowOf(folderName), { visible: true });
      await row.click();
      await pause(300);
      const before = await paneIds(page);
      await press(page, 'button', 'Create new note');
      id = await until('the new note opens', async () => (await paneIds(page)).find((x) => x && !before.includes(x)));
      await page.waitForSelector(`${paneOf(id)}[${DOM.DOC_STATE_ATTR}="live"] [${DOM.TITLE_BINDING_ATTR}="live"]`, { timeout: 20_000 });
      await until('the title takes focus', () => page.$eval(titleOf(id), (el) => el.contains(document.activeElement)));
      await page.keyboard.type(title);
      await page.keyboard.press('Enter');
      await until('Enter moves to the body', () => page.$eval(bodyOf(id), (el) => el.contains(document.activeElement)));
      await until('the title is listed', async () => planNotes(await read(page, '/api/workspace'), folderName, [title]).ids[title] === id, 20_000);
      changed.push('title');
      if (stopAfter === 'title') return { id, created, changed, stopped: stopAfter };
    } else {
      await openNote(page, id);
    }
    const body = await bodyState(page, id, doneText);
    let later = false;
    if (!body.done && !body.empty) {
      const [comments, suggestions, versions] = await Promise.all(['comments', 'suggestions', 'versions'].map((what) => read(page, `/api/docs/${id}/${what}`)));
      later = comments.comments.length > 0 || suggestions.suggestions.length > 0 || versions.versions.some((v) => v.name);
    }
    const plan = notePlan(body, { media, later });
    if (plan.paste) {
      // A new note's caret is in the body after Enter; a reused one is cleared, which also puts the caret there.
      if (!created) await clearBody(page, id);
      await pasteMarkdown(page, id, stopAfter === 'paste' ? partialMarkdown(markdown) : markdown);
      await settle(page, id);
      changed.push(plan.clear ? 'body (a partial paste replaced)' : 'body');
      if (stopAfter === 'paste') return { id, created, changed, stopped: stopAfter };
    }
    for (const [index, file] of plan.media.entries()) {
      const selector = mediaSelector(id, file);
      const had = await count(page, selector);
      await selectRendered(page, id, mediaAfter, mediaAfter.length, 0);
      if (!(await pasteFile(page, id, file))) throw new Error(`the editor took no paste of ${file.name}`);
      await until(`${file.name} renders (${index + 1} of ${plan.media.length})`, async () => (await count(page, selector)) > had, 30_000);
      await settle(page, id);
      changed.push(file.name);
      if (stopAfter === 'media') return { id, created, changed, stopped: stopAfter };
    }
    const where = (await read(page, '/api/workspace')).docs.find((d) => d.id === id);
    if (where?.folderPath !== `Notes/${folderName}`) throw new Error(`"${title}" landed in ${where?.folderPath}, not Notes/${folderName}`);
    return { id, created, changed };
  },

  /**
   * Ada's census of a freshly loaded every-node note: how many of each family it renders, read once every family
   * has rendered (or after 30 s) and the counts hold still. The caller judges it.
   */
  async census({ docId }) {
    const page = await person('ada');
    await visit(page, `/d/${docId}`);
    await openNote(page, docId);
    let last = await census(page, docId);
    await until('every node family renders', async () => familyProblems((last = await census(page, docId))).length === 0, 30_000).catch(() => {});
    await until('the census holds still', async () => {
      await pause(500);
      const now = await census(page, docId);
      const same = censusDiff(last, now).length === 0;
      last = now;
      return same;
    });
    return { census: last };
  },

  /** The folder shared with Ben at `access` through its Share dialog, and a view link to it, reused once made. */
  async share({ folderName, email, access, linkAccess }) {
    const page = await person('ada');
    await visit(page, '/');
    const row = await page.waitForSelector(folderRowOf(folderName), { visible: true });
    await row.click({ button: 'right' });
    await press(page, 'menuitem', 'Share…');
    const dialog = await dialogNamed(page, 'Share folder');
    // The dialog loads its people and links after it opens: decide only once both are in, or a rerun shares again
    // and makes a second link.
    await dialog.waitForSelector('ul[aria-label="People with access"]', { visible: true });
    const { folderId } = planNotes(await read(page, '/api/workspace'), folderName, []);
    const role = { 'Can view': 'viewer', 'Can comment': 'commenter', 'Can edit': 'editor' }[linkAccess];
    if ((await read(page, `/api/folders/${folderId}/links`)).links.some((l) => l.role === role)) {
      await dialog.waitForSelector(aria('textbox', `${linkAccess} link`), { visible: true });
    }
    const listed = () => dialog.evaluate((el, email) => [...el.querySelectorAll('li')].some((li) => li.textContent.includes(email)), email);
    let shared = false;
    if (!(await listed())) {
      const field = await dialog.waitForSelector(aria('textbox', 'Email or agent ID'), { visible: true });
      await field.type(email);
      await press(await dialog.waitForSelector(aria('radiogroup', 'Access')), 'radio', access);
      await press(dialog, 'button', 'Share');
      await until(`${email} is listed`, listed);
      shared = true;
    }
    const inviteField = await dialog.$(aria('textbox', `Invite link for ${email}`));
    const invite = inviteField ? await inviteField.evaluate((el) => el.value) : null;
    let linkField = await dialog.$(aria('textbox', `${linkAccess} link`));
    const linkCreated = !linkField;
    if (!linkField) {
      await press(await dialog.waitForSelector(aria('radiogroup', 'Link access')), 'radio', linkAccess);
      await press(dialog, 'button', 'Create link');
      linkField = await dialog.waitForSelector(aria('textbox', `${linkAccess} link`), { visible: true });
    }
    const link = await linkField.evaluate((el) => el.value);
    await page.keyboard.press('Escape');
    return { shared, invite, link, linkCreated };
  },

  /** Ben follows Ada's invite, signed in as the address it was sent to, and lands on the folder. */
  async accept({ invite }) {
    const page = await person('ben');
    await page.goto(invite, { waitUntil: 'domcontentloaded' });
    await until('the invite lands on the folder', () => new URL(page.url()).pathname.startsWith('/f/'), 30_000);
    return { landed: new URL(page.url()).pathname };
  },

  /** `me`'s part of the wanted threads: the roots they start, the replies they write, the reactions they add. */
  async comments({ docId, me, mode, threads }) {
    const page = await person(me);
    await openNote(page, docId, mode);
    const listing = async () => (await read(page, `/api/docs/${docId}/comments`)).comments;
    const gaps = commentGaps(await listing(), threads);
    const done = { roots: 0, replies: 0, reactions: 0 };
    for (const root of gaps.roots.filter((r) => r.by === me)) {
      await selectInEditor(page, docId, root.quote);
      await chord(page, MOD, 'Shift', 'KeyA');
      const composer = await dialogNamed(page, 'Add comment');
      // Keys typed before the composer's editor holds focus are lost, and the comment is saved without its first words.
      const typed = () => composer.evaluate((dialog) => {
        const field = document.activeElement;
        if (!dialog.contains(field) || !(field.isContentEditable || field.tagName === 'TEXTAREA')) return null;
        return (field.value ?? field.textContent ?? '').trim();
      });
      for (let attempt = 1; ; attempt += 1) {
        await until('the composer takes focus', async () => (await typed()) !== null);
        if (await typed()) {
          await chord(page, MOD, 'KeyA');
          await page.keyboard.press('Backspace');
        }
        await page.keyboard.type(root.text);
        const held = await until('the composer holds the whole comment', async () => (await typed()) === root.text, 3_000).catch(() => false);
        if (held) break;
        if (attempt === 3) throw new Error(`the composer holds "${await typed()}", not "${root.text}"`);
        await pause(500);
      }
      await chord(page, MOD, 'Enter');
      await until('the composer closes', async () => !(await composer.isVisible().catch(() => false)));
      await until(`"${root.text}" is saved`, async () => (await listing()).some((c) => c.text.trim() === root.text));
      done.roots += 1;
    }
    for (const reply of commentGaps(await listing(), threads).replies.filter((r) => r.by === me)) {
      const popover = await openThread(page, reply.rootId, reply.root);
      const box = await popover.waitForSelector('[data-comment-reply-composer] [contenteditable="true"]', { visible: true });
      // As with a root: keys typed before the reply box holds focus are lost, so check what it holds and retype.
      const held = () => box.evaluate((el) => el.textContent.trim());
      for (let attempt = 1; ; attempt += 1) {
        await box.click();
        await until('the reply box takes focus', () => box.evaluate((el) => el.contains(document.activeElement)));
        if (await held()) {
          await chord(page, MOD, 'KeyA');
          await page.keyboard.press('Backspace');
        }
        await page.keyboard.type(reply.text);
        const whole = await until('the reply box holds the whole reply', async () => (await held()) === reply.text, 3_000).catch(() => false);
        if (whole) break;
        if (attempt === 3) throw new Error(`the reply box holds "${await held()}", not "${reply.text}"`);
        await pause(500);
      }
      await chord(page, MOD, 'Enter');
      await until(`"${reply.text}" is saved`, async () => (await listing()).some((c) => c.text.trim() === reply.text));
      await page.keyboard.press('Escape');
      done.replies += 1;
    }
    for (const thread of threads) {
      for (const reaction of (thread.reactions ?? []).filter((r) => r.by === me)) {
        const current = await listing();
        const root = current.find((c) => c.parentId === null && c.text.trim() === thread.text);
        // A reaction waits for its message: a later pass adds it once the reply exists.
        if (!root || !current.some((c) => c.text.includes(reaction.on))) continue;
        const popover = await openThread(page, root.id, thread.text);
        const message = await messageIn(popover, reaction.on);
        if (!(await message.evaluate((m) => m !== null))) throw new Error(`no message "${reaction.on}"`);
        const mine = () => message.evaluate((m, emoji) => [...m.querySelectorAll('button[aria-pressed="true"]')].some((b) => (b.getAttribute('aria-label') ?? '').startsWith(`${emoji} `)), reaction.emoji);
        if (!(await mine())) {
          const actions = await message.evaluateHandle((m) => [...m.querySelectorAll('button')].find((b) => (b.getAttribute('aria-label') ?? '').startsWith('Comment actions for ')));
          await actions.click();
          await press(page, 'menuitem', `React with ${reaction.emoji}`);
          await until(`${me}'s ${reaction.emoji} shows`, mine);
          done.reactions += 1;
        }
        await page.keyboard.press('Escape');
      }
    }
    return done;
  },

  /** A named version from History, unless the note already has one by that name. */
  async version({ docId, name }) {
    const page = await person('ada');
    await openNote(page, docId);
    if (hasVersion((await read(page, `/api/docs/${docId}/versions`)).versions, name)) return { created: false };
    await (await page.waitForSelector(`${paneOf(docId)} [${DOM.HISTORY_BUTTON_ATTR}]`, { visible: true })).click();
    const view = `${paneOf(docId)} [${DOM.HISTORY_VIEW_ATTR}]`;
    await until('the versions load', () => page.$eval(view, (el, attr) => el.getAttribute(attr) !== 'loading', DOM.HISTORY_VIEW_ATTR));
    const scope = await page.$(view);
    await (await scope.waitForSelector(aria('textbox', 'Version name'), { visible: true })).type(name);
    await press(scope, 'button', 'Save version');
    await until(`"${name}" is listed`, () => page.$$eval(`${view} [${DOM.VERSION_ROW_ATTR}]`, (rows, name) => rows.some((r) => r.textContent.includes(name)), name));
    await press(scope, 'button', 'Back to note');
    return { created: true };
  },

  /** Ben, a suggester, replaces words in the long sentence; his edit becomes a pending suggestion. */
  async suggest({ docId, find, replace }) {
    const page = await person('ben');
    await openNote(page, docId, 'suggest');
    const listing = async () => (await read(page, `/api/docs/${docId}/suggestions`)).suggestions;
    if (pendingBy(await listing(), P.ben.name)) return { created: false };
    await selectRendered(page, docId, find);
    await page.keyboard.type(replace, { delay: 20 });
    await settle(page, docId);
    await until("Ben's suggestion is pending", async () => pendingBy(await listing(), P.ben.name), 20_000);
    return { created: true };
  },

  /** The open suggestions Ada sees on a note. */
  async suggestions({ docId }) {
    const page = await person('ada');
    return { suggestions: (await read(page, `/api/docs/${docId}/suggestions`)).suggestions };
  },

  /** A fresh key for Ada's agent from Settings → Agents; earlier keys of that name are revoked first. */
  async agentKey({ name }) {
    const page = await person('ada');
    await visit(page, '/');
    await press(page, 'button', 'Settings');
    await page.waitForSelector(aria('textbox', 'Agent name'), { visible: true });
    for (let old = await page.$(aria('button', `Revoke ${name}`)); old; old = await page.$(aria('button', `Revoke ${name}`))) {
      const before = await count(page, 'ul[aria-label="Agents"] li');
      await old.click();
      await press(page, 'button', 'Revoke key');
      await until('the old key is revoked', async () => (await count(page, 'ul[aria-label="Agents"] li')) < before);
    }
    await (await page.waitForSelector(aria('textbox', 'Agent name'), { visible: true })).type(name);
    await press(page, 'button', 'New key');
    const field = await page.waitForSelector(aria('textbox', `API key for ${name}`), { visible: true });
    const key = await field.evaluate((el) => el.value);
    await press(page, 'button', 'Done');
    await page.keyboard.press('Escape');
    return { key };
  },

  /**
   * The signature shot: Ada's window at 2x with Ben's live caret and name label at the end of his suggestion in the
   * long sentence, the rich blocks around it. The frame is checked before and after the capture and retaken if wrong.
   */
  async signature({ docId, sentence, find, replace }) {
    // Ada reviews, so Ben's inserted words show beside the struck ones.
    const ada = await person('ada');
    const ben = await person('ben');
    const listing = async () => (await read(ada, `/api/docs/${docId}/suggestions`)).suggestions;
    const before = await listing();
    const path = await verifiedShot({
      prepare: async (attempt) => {
        // A retry reloads both windows: a frame that went blank is a dropped or rebinding socket.
        if (attempt > 1) await Promise.all([visit(ada, `/d/${docId}`), visit(ben, `/d/${docId}`)]);
        await openNote(ada, docId, 'review');
        await openNote(ben, docId, 'suggest');
        await ada.bringToFront();
        await calm(ada);
        await center(ada, docId, { text: sentence });
        await center(ben, docId, { text: sentence });
        // His caret goes after his inserted words. A no-op update there every 400 ms marks him typing, so his label
        // stays up through the capture without changing the text or his suggestion.
        await selectRendered(ben, docId, replace, replace.length, 0);
        await ben.$eval(bodyOf(docId), (element, needle) => {
          const editor = element.__lexicalEditor;
          const touch = () => editor.update(() => {
            const node = [...editor.getEditorState()._nodeMap.values()].find((n) => n.getType() === 'text' && n.getTextContent().includes(needle));
            if (!node) throw new Error(`no text node holds "${needle}"`);
            node.getWritable();
          }, { discrete: true });
          touch();
          clearInterval(window.mossDemoTyping);
          window.mossDemoTyping = setInterval(touch, 400);
        }, replace);
        await until("Ben's labelled caret shows in Ada's window", async () => (await inspectSignature(ada, docId)).caretLabels.some((l) => l.includes(P.ben.name)), 5_000);
      },
      inspect: () => inspectSignature(ada, docId),
      problems: (frame) => signatureProblems(frame, { name: P.ben.name, sentence, find, replace }),
      capture: () => shot(ada, 'signature'),
    }).finally(() => ben.evaluate(() => clearInterval(window.mossDemoTyping)).catch(() => {}));
    await settle(ben, docId);
    const changed = changedSuggestions(before, await listing());
    if (changed.length) throw new Error(`the signature step changed suggestions ${changed.join(', ')}`);
    return { shot: path };
  },

  /**
   * Ada's view of the every-node note: every family renders, live and after a reload; then shots of its top, its HTML
   * block after a click on its button, and its media.
   */
  async everyNode({ docId, htmlResult }) {
    const page = await person('ada');
    await openNote(page, docId);
    await everyFamily(page, docId, 'live');
    await visit(page, `/d/${docId}`);
    await openNote(page, docId);
    const reloaded = await everyFamily(page, docId, 'after a reload');
    await calm(page);
    await page.$eval(`${paneOf(docId)} [${DOM.EDITOR_CANVAS_ATTR}]`, (el) => el.scrollTo(0, 0)).catch(() => {});
    const shots = [await shot(page, 'every-node-top')];
    // An HTML block shows a static preview until it is clicked; then its frame runs live and takes clicks.
    const viewport = `${bodyOf(docId)} [data-moss-html-preview-viewport]`;
    await center(page, docId, { selector: '[data-moss-html-preview-viewport]' });
    await (await page.waitForSelector(viewport, { visible: true })).click();
    const live = await page.waitForSelector(`${viewport} iframe[title="HTML preview (interactive)"]`, { timeout: 20_000 });
    const frame = await until('the live HTML frame takes its content', async () => {
      const f = await live.contentFrame();
      return f && (await f.$('button')) ? f : null;
    }, 20_000);
    await pause(500);
    await (await frame.waitForSelector('button', { visible: true })).click();
    await until('the HTML block ran its click', () => frame.evaluate((text) => [...document.querySelectorAll('p')].some((p) => p.textContent.includes(text)), htmlResult));
    await pause(300);
    shots.push(await shot(page, 'every-node-html'));
    await center(page, docId, { selector: 'video' });
    shots.push(await shot(page, 'every-node-media'));
    return { shots, census: reloaded };
  },

  /** Ada's launch plan with the suggestions panel open, then with a comment thread open. */
  async review({ docId, rootText }) {
    const page = await person('ada');
    await openNote(page, docId);
    await calm(page);
    await (await page.waitForSelector(`${paneOf(docId)} [${DOM.SUGGESTIONS_BUTTON_ATTR}]`, { visible: true })).click();
    await page.waitForSelector(`[${DOM.SUGGESTION_CARD_ATTR}]`, { visible: true, timeout: 15_000 });
    const open = (await read(page, `/api/docs/${docId}/suggestions`)).suggestions.length;
    const cards = () => page.$$eval(`[${DOM.SUGGESTION_CARD_ATTR}]`, (all, { status, row, closed }) => all
      .filter((c) => !closed.includes(c.getAttribute(status)))
      .map((c) => ({ loading: c.textContent.includes('Loading changes'), failed: c.querySelector('[role="alert"]')?.textContent ?? null, rows: c.querySelectorAll(`[${row}]`).length })),
    { status: DOM.SUGGESTION_STATUS_ATTR, row: DOM.SUGGESTION_ROW_ATTR, closed: [...CLOSED] });
    await until('the open suggestion cards show their changes', async () => panelProblems(await cards(), open).length === 0, 20_000)
      .catch(async (error) => { throw new Error(`${error.message}: ${panelProblems(await cards(), open).join('; ')}`); });
    await pause(300);
    const shots = [await shot(page, 'suggestions')];
    await (await page.waitForSelector(`${paneOf(docId)} [${DOM.SUGGESTIONS_BUTTON_ATTR}]`, { visible: true })).click();
    await calm(page);
    const listing = (await read(page, `/api/docs/${docId}/comments`)).comments;
    const root = listing.find((c) => c.parentId === null && c.text.trim() === rootText);
    await openThread(page, root.id, rootText);
    await pause(400);
    shots.push(await shot(page, 'comments'));
    await page.keyboard.press('Escape');
    return { shots };
  },

  /** Ada's History list with the named versions. */
  async history({ docId }) {
    const page = await person('ada');
    await openNote(page, docId);
    await calm(page);
    await (await page.waitForSelector(`${paneOf(docId)} [${DOM.HISTORY_BUTTON_ATTR}]`, { visible: true })).click();
    const view = `${paneOf(docId)} [${DOM.HISTORY_VIEW_ATTR}]`;
    await until('the versions load', () => page.$eval(view, (el, attr) => el.getAttribute(attr) === 'ready', DOM.HISTORY_VIEW_ATTR));
    await pause(400);
    const path = await shot(page, 'history');
    await press(await page.$(view), 'button', 'Back to note');
    return { shot: path };
  },

  /** A signed-out visitor opens the folder link and lands on the demo folder. */
  async visitor({ link }) {
    const page = await person('visitor', { principal: null, path: new URL(link).pathname + new URL(link).search });
    // The link opens the folder's first note; the shot waits for it to load, not for a fixed pause.
    const pane = `[${DOM.EDITOR_PANE_ATTR}][${DOM.DOC_STATE_ATTR}="live"]`;
    await page.waitForSelector(`${pane} [${DOM.BODY_BINDING_ATTR}="live"], ${pane} [${DOM.BODY_BINDING_ATTR}="readonly"]`, { timeout: 20_000 });
    await calm(page);
    return { shot: await shot(page, 'folder-link') };
  },

  /**
   * What the built demo holds, as Ada reads it: notes per title in the folder, each wanted comment, each reaction's
   * count on its message, pending suggestions per author, named versions, view links to the folder and the every-node
   * note's census. `demoProblems` turns it into the list of what is not there exactly once.
   */
  async verify({ folderName, titles, docId, mediaDocId, threads }) {
    const page = await person('ada');
    await visit(page, '/');
    const workspace = await read(page, '/api/workspace');
    const { folderId } = planNotes(workspace, folderName, []);
    const tally = (items) => items.reduce((all, key) => ({ ...all, [key]: (all[key] ?? 0) + 1 }), {});
    const docs = (workspace.docs ?? []).filter((d) => d.folderPath === `Notes/${folderName}`);
    const listing = (await read(page, `/api/docs/${docId}/comments`)).comments;
    const comments = tally(listing.map((c) => c.text.trim()));
    const suggestions = (await read(page, `/api/docs/${docId}/suggestions`)).suggestions.filter((s) => !CLOSED.has(s.status));
    const versions = (await read(page, `/api/docs/${docId}/versions`)).versions.filter((v) => v.name);
    const links = folderId ? (await read(page, `/api/folders/${folderId}/links`)).links : [];
    await openNote(page, docId);
    const reactions = {};
    for (const thread of threads) {
      const root = listing.find((c) => c.parentId === null && c.text.trim() === thread.text);
      if (!root || !(thread.reactions ?? []).length) continue;
      const popover = await openThread(page, root.id, thread.text);
      for (const reaction of thread.reactions) {
        const message = await messageIn(popover, reaction.on);
        const shown = await message.evaluate((m, emoji) => (m ? [...m.querySelectorAll('[data-comment-reactions] button[aria-pressed]')]
          .map((b) => b.getAttribute('aria-label') ?? '')
          .filter((label) => label.startsWith(`${emoji} `))
          .reduce((sum, label) => sum + Number(label.slice(emoji.length + 1)), 0) : 0), reaction.emoji);
        reactions[`${reaction.emoji} ${reaction.on}`] = shown;
      }
      await page.keyboard.press('Escape');
    }
    const { census: families } = await STEPS.census({ docId: mediaDocId });
    return {
      seen: {
        titles: Object.fromEntries(titles.map((title) => [title, docs.filter((d) => d.title === title).length])),
        comments,
        reactions,
        pending: tally(suggestions.map((s) => s.author?.name)),
        versions: tally(versions.map((v) => v.name)),
        viewLinks: links.filter((l) => l.role === 'viewer').length,
        families,
      },
    };
  },
};
