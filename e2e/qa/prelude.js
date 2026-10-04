// The helpers of scripts/qa.mjs's prelude (S-test §4.4). qa.mjs inlines this file without its `export` keywords
// after the generated STACK, P, DOM, NAMES, D and MOD constants: bb Browser Automation scripts cannot import. They
// run on the stack's host in Chrome for Testing with real Puppeteer pages, one browser context per actor.
/* global browser, saveFile, readFile, STACK, P, DOM, NAMES, D */

const ACTORS_FILE = `qa-actors-${STACK.sessionId}.json`;

function knownActors() {
  try {
    return JSON.parse(readFile(ACTORS_FILE));
  } catch {
    return {};
  }
}

/** 2x at the given CSS size, and focus emulation so typing in one actor never blurs another. Re-applied every run. */
async function prepare(page, width, height) {
  await page.setViewport({ width, height, deviceScaleFactor: 2 });
  const cdp = await page.createCDPSession();
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
}

export async function waitReady(page, timeout = 30_000) {
  await page.waitForFunction((attr) => document.documentElement.getAttribute(attr) === 'ready', { timeout }, DOM.APP_STATE_ATTR);
}

/** The page's SSR meta and client stamp must name the build the stack was started on (invariant 2). */
export async function assertBuild(page) {
  const { meta, client } = await page.evaluate(D.readStamps, { names: NAMES });
  const want = `${STACK.commit}:${STACK.bundleHash}`;
  if (meta !== want || client !== `${STACK.commit}:${STACK.clientHash}`) {
    throw new Error(`${page.url()} serves meta ${meta}, client ${client}; the stack was started on ${want}`);
  }
}

/** Navigates, waits for `html[data-app-state=ready]` and checks the build. */
export async function visit(page, path = '/') {
  await page.goto(new URL(path, STACK.baseUrl).href, { waitUntil: 'domcontentloaded' });
  await waitReady(page);
  await assertBuild(page);
  return page;
}

/** The cookie route: a same-origin sign-in from the page, so the context holds its own fresh session. */
export async function signIn(page, principal) {
  await page.goto(new URL('/api/version', STACK.baseUrl).href);
  const status = await page.evaluate(
    async ({ email, password }) =>
      (await fetch('/api/auth/sign-in/email', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) })).status,
    { email: principal.email, password: principal.password },
  );
  if (status !== 200) throw new Error(`sign-in for ${principal.email}: ${status}`);
}

/**
 * The page of `label` (a principal from principals.json, or `principal: null` for no session) in its own browser
 * context, 1440x1000 CSS px at 2x by default. A later run in the same session re-attaches it by target id; a new
 * one signs in and visits `path`.
 */
export async function actor(label, { principal = P[label], width = 1440, height = 1000, path = '/' } = {}) {
  const known = knownActors();
  if (known[label] && (await browser.listPages()).some((page) => page.id === known[label])) {
    const page = await browser.getPage(known[label]);
    await prepare(page, width, height);
    return page;
  }
  if (principal === undefined) throw new Error(`no principal "${label}": node scripts/stack.mjs principals --run-id ${STACK.runId} --labels ${label}`);
  const anchor = await browser.getPage(`qa-${STACK.runId}`);
  const context = await anchor.browser().createBrowserContext();
  const page = await context.newPage();
  await prepare(page, width, height);
  if (principal) await signIn(page, principal);
  await visit(page, path);
  saveFile(ACTORS_FILE, JSON.stringify({ ...known, [label]: page.target()._targetId }));
  return page;
}

/** Waits until the first element matching `selector` has `attr` equal to `value`. */
export async function waitAttr(page, selector, attr, value, timeout = 10_000) {
  await page.waitForFunction((s, a, v) => document.querySelector(s)?.getAttribute(a) === v, { timeout }, selector, attr, value);
}

/** Clicks the doc's live body, puts the caret at its end and types. */
export async function typeBody(page, docId, text) {
  const body = `[${DOM.EDITOR_PANE_ATTR}][${DOM.DOC_ID_ATTR}="${docId}"] [${DOM.BODY_BINDING_ATTR}="live"]`;
  await page.click(body);
  await page.evaluate((selector) => {
    const root = document.querySelector(selector);
    const range = document.createRange();
    range.selectNodeContents(root);
    range.collapse(false);
    document.getSelection()?.removeAllRanges();
    document.getSelection()?.addRange(range);
  }, `${body} ${DOM.LEXICAL_EDITOR_SELECTOR}, ${body}${DOM.LEXICAL_EDITOR_SELECTOR}`);
  await page.keyboard.type(text, { delay: 15 });
}

/** The body text of the doc's pane, or null when the page shows no such pane. */
export async function bodyText(page, docId) {
  const [first] = await page.evaluate(D.fieldTexts, { names: NAMES, docId });
  return first ? first.body : null;
}

/** A 2x PNG of the viewport in the run's shots/; returns its path. */
export async function shot(page, name) {
  const path = `${STACK.shotsDir}/${Date.now()}-${String(name).replace(/[^\w.-]+/g, '-')}.png`;
  await page.screenshot({ path, type: 'png' });
  return path;
}

/** Runs an e2e detector (e2e/lib/detectors.js) in the page, e.g. `detect(page, 'floatingOverCanvas')`. */
export async function detect(page, which, extra = {}) {
  if (typeof D[which] !== 'function') throw new Error(`no detector "${which}"; there are ${Object.keys(D).join(', ')}`);
  return page.evaluate(D[which], { names: NAMES, ...extra });
}

/** Doc sockets the page opens and closes during `ms` (invariant 3's census), through CDP. */
export async function sockets(page, ms) {
  const cdp = await page.createCDPSession();
  const census = { created: [], closed: 0 };
  const ids = new Set();
  cdp.on('Network.webSocketCreated', ({ requestId, url }) => {
    if (!url.includes(DOM.DOC_SOCKET_PATH)) return;
    ids.add(requestId);
    census.created.push(url);
  });
  cdp.on('Network.webSocketClosed', ({ requestId }) => {
    if (ids.has(requestId)) census.closed += 1;
  });
  await cdp.send('Network.enable');
  await new Promise((done) => setTimeout(done, ms));
  await cdp.detach();
  return census;
}

/** Freezes or thaws the page's timers through Chromium's lifecycle API: a real stand-in for a background tab. */
export async function freeze(page, on) {
  const cdp = await page.createCDPSession();
  await cdp.send('Page.setWebLifecycleState', { state: on ? 'frozen' : 'active' });
}
