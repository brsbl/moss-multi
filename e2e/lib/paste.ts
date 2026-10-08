// j01-paste helpers: pasting into a shared note through a real clipboard event and reading what the server and each
// screen then hold. The notes and the reference imports are created through POST /api/docs as declared setup.
import type { LexicalEditor } from 'lexical';
import { CLIENT_FRAME_MAX_BYTES } from '../../packages/protocol/src/limits.ts';
import type { Actor, Actors } from './actors.ts';
import { APP_STATE_ATTR, DOC_SOCKET_PATH } from './contract.ts';
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

/**
 * Length and hash of the body's text as Lexical holds it; null while the page is too busy to answer in 10 s (a peer
 * applying a large paste), so a poll asks again.
 */
export const fingerprint = (actor: Actor, docId: string) =>
  ui.body(actor, docId).evaluate((element) => {
    const editor = (element as HTMLElement & { __lexicalEditor: LexicalEditor }).__lexicalEditor;
    const text = editor.getEditorState().read(() => editor.getEditorState()._nodeMap.get('root')!.getTextContent());
    let sum = 0;
    for (let i = 0; i < text.length; i += 1) sum = (sum * 31 + text.charCodeAt(i)) >>> 0;
    return { length: text.length, sum };
  }).catch((error: Error) => {
    if (error.name === 'TimeoutError') return null;
    throw error;
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
  /** The collaborator's doc socket closes, so a reopen of theirs names its cause too. */
  peer?: Wire;
}

const CLOSE_LOG = 'qa-doc-socket-close';
const DIAG_LOG = 'qa-doc-socket-diag';

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
    if (message.text().startsWith(DIAG_LOG)) console.log(`${actor.label}: ${message.text()}`);
  });
  // Each doc socket's close code and reason, so a reopen names its cause.
  await actor.page.addInitScript(({ path, log, diagLog }) => {
    // What the page did in the 20 s before a close it asks for: frames heard and sent, its main thread's gaps and
    // long frames, and the app's slow doc socket work (moss-sync-*, moss-paste-*), so a heartbeat close names its cause.
    const heard: number[][] = [];
    const sent: number[][] = [];
    const gaps: number[][] = [];
    const longFrames: string[] = [];
    let lastTick = performance.now();
    setInterval(() => {
      const now = performance.now();
      if (now - lastTick > 300) gaps.push([Math.round(lastTick), Math.round(now - lastTick)]);
      lastTick = now;
    }, 100);
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries() as unknown as (PerformanceEntry & { scripts: (PerformanceEntry & { invoker: string; sourceFunctionName: string })[] })[]) {
          if (entry.duration < 300) continue;
          const top = [...entry.scripts].sort((a, b) => b.duration - a.duration)[0];
          longFrames.push(`${Math.round(entry.startTime)}+${Math.round(entry.duration)}${top ? ` ${top.invoker} ${Math.round(top.duration)}` : ''}`);
        }
      }).observe({ type: 'long-animation-frame' });
    } catch {
      // only Chromium has long animation frame timing
    }
    const trim = (list: unknown[]) => {
      if (list.length > 400) list.splice(0, list.length - 400);
    };
    const kind = (data: unknown): number[] => {
      if (typeof data === 'string') return [-1, data.length];
      const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : null;
      return bytes ? [bytes[0] * 10 + (bytes[0] === 0 ? bytes[1] : 0), bytes.byteLength] : [-2, 0];
    };
    const report = (now: number): string => {
      const since = now - 20_000;
      const recent = (list: number[][]) => list.filter((row) => row[0] >= since).map((row) => row.join('/')).join(' ');
      const measures = performance.getEntriesByType('measure')
        .filter((entry) => /^moss-/.test(entry.name) && entry.startTime + entry.duration >= since)
        .map((entry) => `${entry.name.slice(5)}@${Math.round(entry.startTime)}+${Math.round(entry.duration)}`).join(' ');
      const frames = longFrames.filter((row) => Number(row.split('+')[0]) >= since).join(' ');
      return `${diagLog} at ${Math.round(now)}; heard (t/type/bytes): ${recent(heard)}; sent: ${recent(sent)}; gaps (t/ms): ${recent(gaps)}; long frames: ${frames}; measures: ${measures}`;
    };
    const Native = window.WebSocket;
    window.WebSocket = class extends Native {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        if (!String(url).includes(path)) return;
        Native.prototype.addEventListener.call(this, 'close', (event: Event) => {
          const { code, reason } = event as CloseEvent;
          console.log(`${log} ${code} ${reason} at ${Math.round(performance.now())} ms`);
        });
        Native.prototype.addEventListener.call(this, 'message', (event: Event) => {
          heard.push([Math.round(performance.now()), ...kind((event as MessageEvent).data)]);
          trim(heard);
        });
      }

      override send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
        if (this.url.includes(path)) {
          sent.push([Math.round(performance.now()), ...kind(data)]);
          trim(sent);
        }
        super.send(data);
      }

      // A close the page asks for, logged with the code it asks for: a 1006 the browser reports may follow it.
      override close(code?: number, reason?: string): void {
        if (this.url.includes(path)) {
          const now = performance.now();
          console.log(`${log} asked ${code ?? '-'} ${reason ?? ''} at ${Math.round(now)} ms`);
          if (code !== 1000) console.log(report(now));
        }
        super.close(code, reason);
      }
    };
  }, { path: DOC_SOCKET_PATH, log: CLOSE_LOG, diagLog: DIAG_LOG });
  return wire;
}

/** Every frame Ada sent fit the client frame cap, and her doc socket never closed (a 1013 reconnects). */
export function expectWire(wire: Wire): void {
  expect(wire.largestFrame, 'no frame the client sends exceeds the frame cap').toBeLessThanOrEqual(CLIENT_FRAME_MAX_BYTES);
  expect(wire.opened, `the doc socket never closed and reopened (closes: ${wire.closes.join('; ') || 'none seen'})`).toBe(1);
  if (wire.peer) expect(wire.peer.closes, "the collaborator's doc socket never closed").toEqual([]);
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
    const frames = window as unknown as { __frames?: PerformanceEntry[]; __frameObserver?: PerformanceObserver };
    frames.__frames = [];
    frames.__frameObserver?.disconnect();
    try {
      frames.__frameObserver = new PerformanceObserver((list) => frames.__frames!.push(...list.getEntries()));
      frames.__frameObserver.observe({ type: 'long-animation-frame' });
    } catch {
      // only Chromium has long animation frame timing
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
 * The longest stall since watchStalls, in ms, when it began (ms from the start), and the paste's batches and slow doc
 * socket work (User Timing measures `moss-paste-*`, `moss-sync-*`) that overlap it; measuring stops.
 */
export const longestStall = (actor: Actor): Promise<{ ms: number; at: number; during: string }> =>
  actor.page.evaluate(() => {
    const probe = window as unknown as { __stall: number; __stallAt: number; __stallStart: number; __stallTimer?: ReturnType<typeof setInterval> };
    clearInterval(probe.__stallTimer);
    const from = probe.__stallStart + probe.__stallAt;
    const to = from + probe.__stall + 25;
    // Measures that overlap the stall, and marks in it or in the second before it.
    const during = [...performance.getEntriesByType('measure'), ...performance.getEntriesByType('mark')]
      .filter((entry) => /^moss-(paste|sync)-/.test(entry.name) && entry.startTime < to && entry.startTime + entry.duration > from - (entry.entryType === 'mark' ? 1_000 : 0))
      .map((entry) => (entry.entryType === 'mark'
        ? `${entry.name} at ${Math.round(entry.startTime - from)} ms`
        : `${entry.name} ${Math.round(entry.duration)} ms${(entry as PerformanceMeasure).detail ? ` ${JSON.stringify((entry as PerformanceMeasure).detail)}` : ''}`))
      .join(', ');
    const tasks = window as unknown as { __longTasks?: PerformanceEntry[]; __longTaskObserver?: PerformanceObserver };
    tasks.__longTaskObserver?.disconnect();
    const long = (tasks.__longTasks ?? [])
      .filter((entry) => entry.startTime < to && entry.startTime + entry.duration > from)
      .map((entry) => `a ${Math.round(entry.duration)} ms long task`)
      .join(', ');
    // Each long animation frame in the stall: its script time, forced layout, then style and layout and the rest of
    // rendering, and its longest scripts.
    type Frame = PerformanceEntry & { renderStart: number; styleAndLayoutStart: number; scripts: (PerformanceEntry & { invoker: string; forcedStyleAndLayoutDuration: number; sourceFunctionName: string; sourceURL: string; sourceCharPosition: number })[] };
    const frames = window as unknown as { __frames?: Frame[]; __frameObserver?: PerformanceObserver };
    frames.__frameObserver?.disconnect();
    const ms = (value: number) => Math.round(value);
    const animation = (frames.__frames ?? [])
      .filter((entry) => entry.startTime < to && entry.startTime + entry.duration > from)
      .map((entry) => {
        const end = entry.startTime + entry.duration;
        const render = entry.renderStart || end;
        const style = entry.styleAndLayoutStart || end;
        const scripts = [...entry.scripts].sort((a, b) => b.duration - a.duration).slice(0, 3)
          .map((script) => `${script.invoker} ${ms(script.duration)} ms (${script.sourceFunctionName || '?'} ${script.sourceURL.split('/').pop()}:${script.sourceCharPosition}), forced layout ${ms(script.forcedStyleAndLayoutDuration)}`);
        return `a ${ms(entry.duration)} ms frame (script ${ms(render - entry.startTime)}, rendering before layout ${ms(style - render)}, style and layout on ${ms(end - style)}; ${scripts.join('; ')})`;
      })
      .join(', ');
    return { ms: Math.round(probe.__stall), at: Math.round(probe.__stallAt), during: [during || 'no paste batch', long || 'no long task', animation || 'no long frame'].join('; ') };
  });

/** The paste's batches so far (User Timing `moss-paste-batch`): units/work/layout/time before, in ms, in order. */
export const batchReport = (actor: Actor): Promise<string> =>
  actor.page.evaluate(() => {
    const batches = performance.getEntriesByType('measure').filter((entry) => entry.name === 'moss-paste-batch');
    const first = batches[0]?.startTime ?? 0;
    return `${batches.length}: ${batches.map((entry) => `${Math.round(entry.startTime - first)}:${Object.values((entry as PerformanceMeasure).detail as Record<string, number>).join('/')}`).join(' ')}`;
  });

/**
 * With `severablePeer`, Ben's doc sockets run through a sever proxy, so a test can hold his edits in flight. `prepare`
 * runs once the note exists, before Ada or Ben open it.
 */
export async function setup(
  actors: Actors, stack: Stack, markdown?: string,
  { elsewhere = false, severablePeer = false, prepare }: { elsewhere?: boolean; severablePeer?: boolean; prepare?: (ada: Actor, docId: string) => Promise<void> } = {},
) {
  const ada = await actors.session(await actors.principal('ada'));
  const docId = await importNote(ada, stack, 'Paste target', markdown);
  const otherId = elsewhere ? await importNote(ada, stack, 'Elsewhere', 'Another note.') : '';
  const principal = await actors.principal('ben');
  await grantDoc(ada, docId, principal);
  await prepare?.(ada, docId);
  const wire = await watchWire(ada);
  await ada.goto(`/d/${docId}`);
  const ben = await actors.session(principal, { severable: severablePeer });
  wire.peer = await watchWire(ben);
  await ben.goto(`/d/${docId}`);
  await ben.page.locator(`html[${APP_STATE_ATTR}="ready"]`).waitFor({ state: 'attached' });
  for (const actor of [ada, ben]) {
    await ui.waitLive(actor, docId);
    await actor.observeEditor(docId);
  }
  return { ada, ben, docId, otherId, wire };
}

/**
 * Pastes `pasted` at the caret, then checks: the export is `whole`; Ben's body equals Ada's; typing lands after the
 * paste (`typed`); one undo removes the typing and the next the whole paste (`before`), for both; one redo brings the
 * paste back and the next the typing. With `maxStallMs`,
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
  // The collaborator's stalls too, for the record: a busy collaborator's page can share a process with Ada's.
  await watchStalls(ben);
  const t0 = Date.now();
  const phase = (label: string) => console.log(`paste phase: ${label} at ${Math.round((Date.now() - t0) / 1000)} s`);
  const busyMs = await pastePlain(ada, docId, pasted);
  expect(busyMs, 'the paste keeps the tab responsive').toBeLessThan(maxBusyMs);
  try {
    await ui.waitAcked(ada, docId, timeout);
  } finally {
    console.log(`paste batches: ${await batchReport(ada)}`);
  }
  phase('acked');
  await expect.poll(() => exported(ada, docId), { message: 'every pasted character lands in the doc', timeout }).toBe(want.whole);
  const stall = await longestStall(ada);
  const peer = await longestStall(ben).catch(() => null);
  if (peer) console.log(`collaborator's longest stall: ${peer.ms} ms, ${peer.at} ms after the paste`);
  console.log(`longest stall: ${stall.ms} ms, ${stall.at} ms after the paste, during: ${stall.during}`);
  expect(stall.ms, `the tab is never held longer than ${maxStallMs} ms at a time while the paste lands (the longest began ${stall.at} ms after the paste, during: ${stall.during}; socket closes: ${wire?.closes.join(', ') || 'none seen'})`).toBeLessThanOrEqual(maxStallMs);
  const pastedPrint = await fingerprint(ada, docId);
  await expect.poll(() => fingerprint(ben, docId), { message: 'the collaborator sees the whole paste', timeout }).toEqual(pastedPrint);
  phase('peer has it');

  await ada.page.waitForTimeout(NEW_STEP_MS);
  await ada.page.keyboard.type('Z');
  await ui.waitAcked(ada, docId, timeout);
  await expect.poll(() => exported(ada, docId), { message: 'the caret ends after the paste', timeout }).toBe(want.typed);
  phase('typed');

  await ada.page.waitForTimeout(NEW_STEP_MS);
  await ada.page.keyboard.press(UNDO);
  await ui.waitAcked(ada, docId, timeout);
  await expect.poll(() => exported(ada, docId), { message: 'the first undo removes only the typing', timeout }).toBe(want.whole);
  await ada.page.keyboard.press(UNDO);
  await ui.waitAcked(ada, docId, timeout);
  await expect.poll(() => exported(ada, docId), { message: 'one more undo removes the whole paste', timeout }).toBe(before);
  await expect.poll(() => fingerprint(ben, docId), { message: 'the collaborator sees the paste undone', timeout }).toEqual(empty);
  phase('undone');

  await ada.page.keyboard.press(REDO);
  await ui.waitAcked(ada, docId, timeout);
  await expect.poll(() => exported(ada, docId), { message: 'one redo brings the whole paste back to the server', timeout }).toBe(want.whole);
  await expect.poll(() => fingerprint(ben, docId), { message: 'the collaborator sees the paste redone', timeout }).toEqual(pastedPrint);
  phase('redone');

  // Redoing the paste keeps the redo chain: the typing undone after it comes back too.
  await ada.page.keyboard.press(REDO);
  await ui.waitAcked(ada, docId, timeout);
  await expect.poll(() => exported(ada, docId), { message: 'the next redo brings the typing back after the paste', timeout }).toBe(want.typed);
  phase('typing redone');
  if (wire) expectWire(wire);
  return busyMs;
}
