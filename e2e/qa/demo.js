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

/** Scrolls the block holding `text` (or matching `selector`) to the middle of the editor. */
async function center(page, id, { text, selector }) {
  await page.$eval(bodyOf(id), (root, { text, selector }) => {
    const target = selector ? root.querySelector(selector) : [...root.querySelectorAll('p, li, td, h1, h2, h3')].find((el) => el.textContent.includes(text));
    if (!target) throw new Error(`nothing to scroll to: ${text ?? selector}`);
    target.scrollIntoView({ block: 'center' });
  }, { text: text ?? null, selector: selector ?? null });
  await pause(400);
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

  /** One note in the folder: "+ Note" with the folder active, the title, Enter, a markdown paste, then media pasted at the end. */
  async note({ folderName, title, markdown, media = [], mediaAfter = null }) {
    const page = await person('ada');
    await visit(page, '/');
    const planned = planNotes(await read(page, '/api/workspace'), folderName, [title]);
    if (!planned.folderId) throw new Error(`no folder ${folderName}; run the folder step first`);
    if (planned.ids[title]) return { id: planned.ids[title], created: false };
    // A new note lands in the active folder: pick it in the sidebar first.
    const row = await page.waitForSelector(folderRowOf(folderName), { visible: true });
    await row.click();
    await pause(300);
    const before = await paneIds(page);
    await press(page, 'button', 'Create new note');
    const id = await until('the new note opens', async () => (await paneIds(page)).find((x) => x && !before.includes(x)));
    await page.waitForSelector(`${paneOf(id)}[${DOM.DOC_STATE_ATTR}="live"] [${DOM.TITLE_BINDING_ATTR}="live"]`, { timeout: 20_000 });
    await until('the title takes focus', () => page.$eval(titleOf(id), (el) => el.contains(document.activeElement)));
    await page.keyboard.type(title);
    await page.keyboard.press('Enter');
    await until('Enter moves to the body', () => page.$eval(bodyOf(id), (el) => el.contains(document.activeElement)));
    await pasteMarkdown(page, id, markdown);
    await settle(page, id);
    for (const [index, file] of media.entries()) {
      const selector = `${bodyOf(id)} ${file.type.startsWith('video/') ? 'video' : 'img'}`;
      const had = await count(page, selector);
      const text = mediaAfter;
      await selectRendered(page, id, text, text.length, 0);
      if (!(await pasteFile(page, id, file))) throw new Error(`the editor took no paste of ${file.name}`);
      await until(`${file.name} renders (${index + 1} of ${media.length})`, async () => (await count(page, selector)) > had, 30_000);
      await settle(page, id);
    }
    const where = (await read(page, '/api/workspace')).docs.find((d) => d.id === id);
    if (where?.folderPath !== `Notes/${folderName}`) throw new Error(`"${title}" landed in ${where?.folderPath}, not Notes/${folderName}`);
    return { id, created: true };
  },

  /** The folder shared with Ben at `access` through its Share dialog, and a view link to it, reused once made. */
  async share({ folderName, email, access, linkAccess }) {
    const page = await person('ada');
    await visit(page, '/');
    const row = await page.waitForSelector(folderRowOf(folderName), { visible: true });
    await row.click({ button: 'right' });
    await press(page, 'menuitem', 'Share…');
    const dialog = await dialogNamed(page, 'Share folder');
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
    if (!linkField) {
      await press(await dialog.waitForSelector(aria('radiogroup', 'Link access')), 'radio', linkAccess);
      await press(dialog, 'button', 'Create link');
      linkField = await dialog.waitForSelector(aria('textbox', `${linkAccess} link`), { visible: true });
    }
    const link = await linkField.evaluate((el) => el.value);
    await page.keyboard.press('Escape');
    return { shared, invite, link };
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
      await pause(200);
      await page.keyboard.type(root.text);
      await chord(page, MOD, 'Enter');
      await until('the composer closes', async () => !(await composer.isVisible().catch(() => false)));
      await until(`"${root.text}" is saved`, async () => (await listing()).some((c) => c.text.trim() === root.text));
      done.roots += 1;
    }
    for (const reply of commentGaps(await listing(), threads).replies.filter((r) => r.by === me)) {
      const popover = await openThread(page, reply.rootId, reply.root);
      const box = await popover.waitForSelector('[data-comment-reply-composer] [contenteditable="true"]', { visible: true });
      await box.click();
      await page.keyboard.type(reply.text);
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
   * long sentence, the rich blocks around it.
   */
  async signature({ docId, sentence, replace }) {
    // Ada reviews, so Ben's inserted words show beside the struck ones.
    const ada = await person('ada');
    await openNote(ada, docId, 'review');
    const ben = await person('ben');
    await openNote(ben, docId, 'suggest');
    await calm(ada);
    await center(ada, docId, { text: sentence });
    await center(ben, docId, { text: sentence });
    // A keystroke and its undo-by-Backspace at the end of his inserted words: his label shows, his suggestion stays.
    await selectRendered(ben, docId, replace, replace.length, 0);
    await ben.keyboard.type(' ');
    await ben.keyboard.press('Backspace');
    const caret = `[${DOM.REMOTE_CARET_ATTR}]`;
    await until("Ben's labelled caret shows in Ada's window", () => ada.$$eval(caret, (all, name) => all.some((c) => {
      const label = c.querySelector('[data-cursor-label]');
      return label && label.textContent.includes(name) && getComputedStyle(label).visibility !== 'hidden' && label.getBoundingClientRect().width > 0;
    }), P.ben.name), 5_000);
    const path = await shot(ada, 'signature');
    await settle(ben, docId);
    return { shot: path };
  },

  /** Ada's view of the every-node note: its top, its HTML block after a click on its button, and its media. */
  async everyNode({ docId, htmlResult }) {
    const page = await person('ada');
    await openNote(page, docId);
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
    return { shots };
  },

  /** Ada's launch plan with the suggestions panel open, then with a comment thread open. */
  async review({ docId, rootText }) {
    const page = await person('ada');
    await openNote(page, docId);
    await calm(page);
    await (await page.waitForSelector(`${paneOf(docId)} [${DOM.SUGGESTIONS_BUTTON_ATTR}]`, { visible: true })).click();
    await page.waitForSelector(`[${DOM.SUGGESTION_CARD_ATTR}]`, { visible: true, timeout: 15_000 });
    await pause(500);
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
    await pause(800);
    return { shot: await shot(page, 'folder-link') };
  },
};
