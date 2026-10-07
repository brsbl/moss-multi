// j01-paste helpers: pasting into a shared note through a real clipboard event and reading what the server and each
// screen then hold. The notes and the reference imports are created through POST /api/docs as declared setup.
import type { LexicalEditor } from 'lexical';
import { CLIENT_FRAME_MAX_BYTES } from '../../packages/protocol/src/limits.ts';
import type { Actor, Actors } from './actors.ts';
import { DOC_SOCKET_PATH } from './contract.ts';
import { grantDoc } from './grants.ts';
import type { Stack } from './stack.ts';
import { expect, ui } from './test.ts';

/** Past the undo capture window (1 s), so the next edit is its own step. */
export const NEW_STEP_MS = 1_500;
/**
 * The longest a large paste may hold the tab at a time (T3.S6). 2 s is the local target. On CI runners the bound is
 * 5 s per the M3 coordinator ruling: run 37642539162 measured one 2.5-3.0 s stall per paste leg there (one of our
 * batches, 620-1900 ms, plus a separate ~2 s long task between batches that is not ours; profiling it is a follow-up).
 */
export const MAX_STALL_MS = process.env.CI ? 5_000 : 2_000;
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

/**
 * A real clipboard paste of plain text, as from a text editor (no text/markdown or HTML flavor). Resolves with the
 * milliseconds from the paste to the next painted frame: how long the tab was busy with it.
 */
export async function pastePlain(actor: Actor, docId: string, text: string): Promise<number> {
  return ui.body(actor, docId).evaluate((element, value) => {
    const data = new DataTransfer();
    data.setData('text/plain', value);
    const started = performance.now();
    element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }));
    return new Promise<number>((done) => requestAnimationFrame(() => setTimeout(() => done(performance.now() - started), 0)));
  }, text);
}

/** What Ada's doc sockets do on the wire: the largest frame sent, how many sockets opened, and how each closed. */
export interface Wire {
  largestFrame: number;
  opened: number;
  closes: string[];
}

const CLOSE_LOG = 'qa-doc-socket-close';

/** Watches the doc sockets `actor`'s page opens from now on; call before the page loads the app. */
async function watchWire(actor: Actor): Promise<Wire> {
  const wire: Wire = { largestFrame: 0, opened: 0, closes: [] };
  actor.page.on('websocket', (socket) => {
    if (!new URL(socket.url()).pathname.startsWith(DOC_SOCKET_PATH)) return;
    wire.opened += 1;
    socket.on('framesent', ({ payload }) => {
      wire.largestFrame = Math.max(wire.largestFrame, typeof payload === 'string' ? Buffer.byteLength(payload) : payload.byteLength);
    });
  });
  actor.page.on('console', (message) => {
    if (message.text().startsWith(CLOSE_LOG)) wire.closes.push(message.text().slice(CLOSE_LOG.length + 1));
  });
  // Each doc socket's close code and reason, so a reopen names its cause.
  await actor.page.addInitScript(({ path, log }) => {
    const Native = window.WebSocket;
    window.WebSocket = class extends Native {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        if (!String(url).includes(path)) return;
        Native.prototype.addEventListener.call(this, 'close', (event: Event) => {
          const { code, reason } = event as CloseEvent;
          console.log(`${log} ${code} ${reason} at ${Math.round(performance.now())} ms`);
        });
      }
    };
  }, { path: DOC_SOCKET_PATH, log: CLOSE_LOG });
  return wire;
}

/** Every frame Ada sent fit the client frame cap, and her doc socket never closed (a 1013 reconnects). */
export function expectWire(wire: Wire): void {
  expect(wire.largestFrame, 'no frame the client sends exceeds the frame cap').toBeLessThanOrEqual(CLIENT_FRAME_MAX_BYTES);
  expect(wire.opened, `the doc socket never closed and reopened (closes: ${wire.closes.join('; ') || 'none seen'})`).toBe(1);
}

/** Starts measuring the longest the page's main thread is held: the gap between 25 ms ticks, less the 25 ms. */
export async function watchStalls(actor: Actor): Promise<void> {
  await actor.page.evaluate(() => {
    const probe = window as unknown as { __stall: number; __stallAt: number; __stallStart: number; __stallTimer?: ReturnType<typeof setInterval> };
    clearInterval(probe.__stallTimer);
    probe.__stall = 0;
    probe.__stallAt = 0;
    const start = performance.now();
    probe.__stallStart = start;
    const tasks = window as unknown as { __longTasks?: PerformanceEntry[]; __longTaskObserver?: PerformanceObserver };
    tasks.__longTasks = [];
    tasks.__longTaskObserver?.disconnect();
    try {
      tasks.__longTaskObserver = new PerformanceObserver((list) => tasks.__longTasks!.push(...list.getEntries()));
      tasks.__longTaskObserver.observe({ type: 'longtask' });
    } catch {
      // WebKit has no long task timing
    }
    let last = start;
    probe.__stallTimer = setInterval(() => {
      const now = performance.now();
      if (now - last - 25 > probe.__stall) {
        probe.__stall = now - last - 25;
        probe.__stallAt = last - start;
      }
      last = now;
    }, 25);
  });
}

/**
 * The longest stall since watchStalls, in ms, when it began (ms from the start), and the paste's batches (User Timing
 * measures `moss-paste-*`) that overlap it; measuring stops.
 */
export const longestStall = (actor: Actor): Promise<{ ms: number; at: number; during: string }> =>
  actor.page.evaluate(() => {
    const probe = window as unknown as { __stall: number; __stallAt: number; __stallStart: number; __stallTimer?: ReturnType<typeof setInterval> };
    clearInterval(probe.__stallTimer);
    const from = probe.__stallStart + probe.__stallAt;
    const to = from + probe.__stall + 25;
    const during = performance.getEntriesByType('measure')
      .filter((entry) => entry.name.startsWith('moss-paste-') && entry.startTime < to && entry.startTime + entry.duration > from)
      .map((entry) => `${entry.name} ${Math.round(entry.duration)} ms ${JSON.stringify((entry as PerformanceMeasure).detail)}`)
      .join(', ');
    const tasks = window as unknown as { __longTasks?: PerformanceEntry[]; __longTaskObserver?: PerformanceObserver };
    tasks.__longTaskObserver?.disconnect();
    const long = (tasks.__longTasks ?? [])
      .filter((entry) => entry.startTime < to && entry.startTime + entry.duration > from)
      .map((entry) => `a ${Math.round(entry.duration)} ms long task`)
      .join(', ');
    return { ms: Math.round(probe.__stall), at: Math.round(probe.__stallAt), during: [during || 'no paste batch', long || 'no long task'].join('; ') };
  });

/** The paste's batches so far (User Timing `moss-paste-batch`): units/work/layout/time before, in ms, in order. */
export const batchReport = (actor: Actor): Promise<string> =>
  actor.page.evaluate(() => {
    const batches = performance.getEntriesByType('measure').filter((entry) => entry.name === 'moss-paste-batch');
    const first = batches[0]?.startTime ?? 0;
    return `${batches.length}: ${batches.map((entry) => `${Math.round(entry.startTime - first)}:${Object.values((entry as PerformanceMeasure).detail as Record<string, number>).join('/')}`).join(' ')}`;
  });

export async function setup(actors: Actors, stack: Stack, markdown?: string, { elsewhere = false } = {}) {
  const ada = await actors.session(await actors.principal('ada'));
  const docId = await importNote(ada, stack, 'Paste target', markdown);
  const otherId = elsewhere ? await importNote(ada, stack, 'Elsewhere', 'Another note.') : '';
  const principal = await actors.principal('ben');
  await grantDoc(ada, docId, principal);
  const wire = await watchWire(ada);
  await ada.goto(`/d/${docId}`);
  const ben = await actors.open(principal, { path: `/d/${docId}` });
  for (const actor of [ada, ben]) {
    await ui.waitLive(actor, docId);
    await actor.observeEditor(docId);
  }
  return { ada, ben, docId, otherId, wire };
}

/**
 * Pastes `pasted` at the caret, then checks: the export is `whole`; Ben's body equals Ada's; typing lands after the
 * paste (`typed`); one undo removes the typing and the next the whole paste (`before`), for both. With `maxStallMs`,
 * the main thread is never held longer than that while the paste lands; with `wire`, no frame passes the frame cap
 * and the doc socket never closes, through the paste, its undo and its redo.
 */
export async function pasteAndCheck(
  { ada, ben, docId, wire }: { ada: Actor; ben: Actor; docId: string; wire?: Wire },
  pasted: string,
  want: { whole: string; typed: string },
  timeout: number,
  { maxBusyMs = Infinity, maxStallMs = Infinity }: { maxBusyMs?: number; maxStallMs?: number } = {},
): Promise<number> {
  await ui.waitAcked(ada, docId, timeout);
  const before = await exported(ada, docId);
  const empty = await fingerprint(ada, docId);
  await ada.page.waitForTimeout(NEW_STEP_MS);

  await watchStalls(ada);
  const busyMs = await pastePlain(ada, docId, pasted);
  expect(busyMs, 'the paste keeps the tab responsive').toBeLessThan(maxBusyMs);
  try {
    await ui.waitAcked(ada, docId, timeout);
  } finally {
    console.log(`paste batches: ${await batchReport(ada)}`);
  }
  await expect.poll(() => exported(ada, docId), { message: 'every pasted character lands in the doc', timeout }).toBe(want.whole);
  const stall = await longestStall(ada);
  expect(stall.ms, `the tab is never held longer than ${maxStallMs} ms at a time while the paste lands (the longest began ${stall.at} ms after the paste, during: ${stall.during}; socket closes: ${wire?.closes.join(', ') || 'none seen'})`).toBeLessThanOrEqual(maxStallMs);
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
  if (wire) expectWire(wire);
  return busyMs;
}
