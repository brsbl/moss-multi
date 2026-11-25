// The suggest-drop journeys' probe (j16-suggest-drop-*): a person typing a suggestion loses the connection and gets it
// back. Each leg records what the DocDO refused and why, every close code of the person's doc sockets, whether the
// 60 s suggestion cooldown (close 4429) started, and the exact text afterwards in the server's working export, in the
// person's window and in the owner's, before and after a reload. The record is printed as `SUGDROP` lines and
// attached as suggest-drop-<leg>.json before the fixture's invariants run.
import type { Page, TestInfo } from '@playwright/test';
import type { Actor, Actors } from './actors.ts';
import {
  APP_STATE_ATTR, BODY_BINDING_ATTR, CONNECTION_BANNER_ATTR, DOC_SOCKET_PATH, DOC_STATE_ATTR, EDIT_MODE_ATTR, SUGGEST_REFUSED_ATTR, SUGGEST_SENT_ATTR,
  SUGGEST_UNSAVED_ATTR, SYNC_UNACKED_ATTR, TERMINAL_REASON_ATTR, paneSelector,
} from './contract.ts';
import { grantDoc } from './grants.ts';
import { suggestFrame, type Sever, type TapEvent } from './sever.ts';
import { BIND_TIMEOUT, BOOT_TIMEOUT, content, frames, openIn } from './suggest.ts';
import { expect, ui } from './test.ts';
import { occurrences } from './text.ts';

export type Role = 'editor' | 'suggester';
export type LineKey = 'one' | 'two' | 'three';

/**
 * How the DocDO learns of a drop. `unseen`: the page's socket closes (1012) and the DocDO still holds its end open,
 * as after a dead route (the sever's default reset: its proxy cannot close the server's end with 1012, a code a
 * browser may not send). `seen`: both ends close (3012), so the DocDO expires that connection's leases at once.
 */
export type Drop = 'unseen' | 'seen';
export const DROPS: Drop[] = ['unseen', 'seen'];
export const SEEN_CLOSE = 3012;
export const ROLES: Role[] = ['editor', 'suggester'];
export const START: Record<LineKey, string> = { one: 'Draft line one.', two: 'Draft line two.', three: 'Draft line three.' };
export const NOTE = [START.one, START.two, START.three].join('\n\n');
export const COOLDOWN_CLOSE = 4429;
/** Close codes no leg should hear: the cooldown, a refused write, a revoked role, a silent socket, the write rate. */
export const BAD_CLOSES = [4429, 4409, 4403, 4408, 4420];
export const KEY_DELAY = 30;

const ATTRS = {
  mode: EDIT_MODE_ATTR, doc: DOC_STATE_ATTR, terminal: TERMINAL_REASON_ATTR, unacked: SYNC_UNACKED_ATTR, sent: SUGGEST_SENT_ATTR,
  refused: SUGGEST_REFUSED_ATTR, binding: BODY_BINDING_ATTR, banner: CONNECTION_BANNER_ATTR, unsaved: SUGGEST_UNSAVED_ATTR,
};

export interface Shown {
  pane: boolean;
  mode: string | null;
  doc: string | null;
  terminal: string | null;
  unacked: string | null;
  sent: string | null;
  refused: string | null;
  binding: string | null;
  focused: boolean;
  visible: boolean;
  lines: string[];
  banners: string[];
  unsaved: string[];
  screen: string;
  error?: string;
}

interface WireEvent extends Partial<TapEvent> { ms: number; conn: number; kind: 'open' | 'out' | 'in' | 'close' }

export const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));
export const firstLine = (error: unknown) => String(error instanceof Error ? error.message : error).split('\n')[0].slice(0, 300);
export const draftLines = (lines: string[]) => lines.filter((line) => line.startsWith('Draft line'));
export const exportLines = (markdown: string) => draftLines(markdown.split('\n').map((line) => line.replace(/\u00a0/g, ' ').trimEnd()));

export async function until<T>(read: () => Promise<T> | T, done: (value: T) => boolean, timeoutMs: number, everyMs = 250): Promise<{ value: T; ok: boolean; ms: number }> {
  const start = Date.now();
  for (;;) {
    const value = await read();
    if (done(value)) return { value, ok: true, ms: Date.now() - start };
    if (Date.now() - start >= timeoutMs) return { value, ok: false, ms: Date.now() - start };
    await pause(everyMs);
  }
}

/** In the page: what the doc's pane shows now. */
function readPane({ selector, attrs }: { selector: string; attrs: Record<string, string> }): Shown {
  const flat = (text: string | null | undefined) => (text ?? '').replace(/\u00a0/g, ' ');
  const squash = (text: string | null | undefined) => flat(text).replace(/\s+/g, ' ').trim();
  const banners = [...document.querySelectorAll(`[${attrs.banner}]`)].map((el) => `${el.getAttribute(attrs.banner)}: ${squash(el.textContent)}`);
  const unsaved = [...document.querySelectorAll(`[${attrs.unsaved}]`)].map((el) => squash(el.textContent).slice(0, 300));
  const pane = document.querySelector(selector);
  const body = pane ? pane.querySelector(`[${attrs.binding}]`) : null;
  const style = body ? getComputedStyle(body) : null;
  return {
    pane: !!pane,
    mode: pane ? pane.getAttribute(attrs.mode) : null,
    doc: pane ? pane.getAttribute(attrs.doc) : null,
    terminal: pane ? pane.getAttribute(attrs.terminal) : null,
    unacked: pane ? pane.getAttribute(attrs.unacked) : null,
    sent: pane ? pane.getAttribute(attrs.sent) : null,
    refused: pane ? pane.getAttribute(attrs.refused) : null,
    binding: body ? body.getAttribute(attrs.binding) : null,
    focused: !!body && body.contains(document.activeElement),
    visible: !!body && !!style && body.getClientRects().length > 0 && style.visibility !== 'hidden' && Number(style.opacity) > 0,
    lines: body ? [...body.children].map((el) => flat(el.textContent)) : [],
    banners,
    unsaved,
    // What is on screen instead, when the pane shows no note text.
    screen: body && body.children.length > 0 ? '' : squash(((pane ?? document.body) as HTMLElement | null)?.innerText).slice(0, 300),
  };
}

export const paneOf = (page: Page, docId: string): Promise<Shown> =>
  page.evaluate(readPane, { selector: paneSelector(docId), attrs: ATTRS }).catch((error: unknown) => ({
    pane: false, mode: null, doc: null, terminal: null, unacked: null, sent: null, refused: null, binding: null, focused: false, visible: false,
    lines: [], banners: [], unsaved: [], screen: '', error: firstLine(error),
  }));

/** The caret at the end of the block holding `text`, as a click after its last character would put it. */
export async function caretEnd(actor: Actor, docId: string, text: string): Promise<void> {
  await ui.body(actor, docId).evaluate((root, text) => {
    (root as HTMLElement).focus();
    const block = [...root.children].find((el) => (el.textContent ?? '').includes(text));
    if (!block) throw new Error(`no block holding "${text}"`);
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
    let last: Node | null = null;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) last = node;
    if (!last) throw new Error(`no text in the block holding "${text}"`);
    const range = document.createRange();
    range.setStart(last, (last.textContent ?? '').length);
    range.collapse(true);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
  }, text);
  // Lexical reads the selection on selectionchange.
  await frames(actor);
}

/** An editor's Suggest changes, in the note's More actions (T9.30), as j16-suggest starts it. */
async function suggestChanges(actor: Actor, docId: string): Promise<void> {
  await (await ui.openNoteMenu(actor, docId)).getByRole('menuitem', { name: 'Suggest changes', exact: true }).click();
}

/** The resume a fork sent on a socket opened after `since`, with the DocDO's reply to it once it has one of `fates`. */
export function resumeReply(log: TapEvent[], since: number, fates: string[]): { request: TapEvent; reply: TapEvent } | null {
  for (const [at, request] of log.entries()) {
    if (request.kind !== 'out' || request.t !== 'suggest-lease' || !request.resume || request.at < since || request.fate !== 'crossed') continue;
    const reply = log.slice(at + 1).find((event) => event.kind === 'in' && event.conn === request.conn && (event.t === 'suggest-leased' || event.t === 'suggest-refused'));
    if (reply && fates.includes(reply.fate ?? '')) return { request, reply };
  }
  return null;
}

/** Each lease request with its reply, and every refusal, per socket in order (the DocDO answers each frame once). */
function exchanges(log: TapEvent[], t0: number) {
  const waiting = new Map<number, TapEvent[]>();
  const out: { ms: number; conn: number; asked: string; resume: number | null; fork: string | null; sent: string; reply: string; reason: string | null; record: string | null; leases: string[] | null; heard: string }[] = [];
  const counts = new Map<number, { ops: number; acks: number }>();
  for (const event of log) {
    if (event.kind === 'out' && (event.fate === 'crossed' || event.fate === 'released' || event.fate === 'late')) {
      waiting.set(event.conn, [...(waiting.get(event.conn) ?? []), event]);
      if (event.t === 'suggest-ops') counts.set(event.conn, { ops: (counts.get(event.conn)?.ops ?? 0) + 1, acks: counts.get(event.conn)?.acks ?? 0 });
    }
    if (event.kind !== 'in' || event.t === 'write-refused') continue;
    const request = waiting.get(event.conn)?.shift();
    if (event.t === 'suggest-ack') counts.set(event.conn, { ops: counts.get(event.conn)?.ops ?? 0, acks: (counts.get(event.conn)?.acks ?? 0) + 1 });
    if (event.t === 'suggest-ack' && request?.t !== 'suggest-lease') continue;
    out.push({
      ms: event.at - t0, conn: event.conn, asked: request?.t ?? '?', resume: request?.resume ? request.resume.length : null, fork: request?.fork ?? null,
      sent: request?.fate ?? '?', reply: event.t ?? '?', reason: event.reason ?? null, record: event.record ?? null, leases: event.leases ?? null, heard: event.fate ?? '?',
    });
  }
  return { replies: out, frames: [...counts].map(([conn, count]) => ({ conn, ...count })) };
}

export class Probe {
  readonly t0 = Date.now();
  readonly id: string;
  readonly steps: { ms: number; step: string; detail?: unknown }[] = [];
  readonly checkpoints: Record<string, unknown>[] = [];
  readonly dialogs: { ms: number; window: string; type: string }[] = [];
  readonly wires = new Map<string, WireEvent[]>();
  readonly windows: Actor[] = [];
  /** What each paragraph must read once everything typed has landed. */
  readonly lines: Record<LineKey, string> = { ...START };
  readonly tokens: string[] = [];
  lockedOutAt: number | null = null;
  /** Leave-site dialogs are dismissed (the page stays) rather than accepted. */
  dismissDialogs = false;

  constructor(
    readonly actors: Actors, readonly testInfo: TestInfo, readonly leg: string, readonly role: Role,
    readonly ada: Actor, readonly ben: Actor, readonly docId: string, readonly before: string, readonly drop: Drop,
  ) {
    this.id = `${leg}/${role}/${drop}/${testInfo.project.name}/r${testInfo.repeatEachIndex}`;
  }

  get sever(): Sever {
    if (!this.ben.sever) throw new Error('the person must be severable');
    return this.ben.sever;
  }

  ms(at = Date.now()): number {
    return at - this.t0;
  }

  get want(): string[] {
    return [this.lines.one, this.lines.two, this.lines.three];
  }

  note(step: string, detail?: unknown): void {
    this.steps.push({ ms: this.ms(), step, ...(detail === undefined ? {} : { detail }) });
    console.log(`SUGDROP step ${this.id} +${this.ms()} ${step}${detail === undefined ? '' : ` ${JSON.stringify(detail)}`}`);
  }

  /** Runs a step whose failure is itself the observation: it is recorded and the leg goes on. */
  async attempt<T>(step: string, run: () => Promise<T>): Promise<T | null> {
    try {
      return await run();
    } catch (error) {
      this.note(`FAILED: ${step}`, firstLine(error));
      return null;
    }
  }

  /** Records the window's dialogs (and accepts them) and, where the window's sockets are real, their suggest frames. */
  watch(actor: Actor): void {
    this.windows.push(actor);
    this.listen(actor.page, actor.label);
    if (actor.sever) return;
    const sink: WireEvent[] = [];
    this.wires.set(actor.label, sink);
    let opened = 0;
    actor.page.on('websocket', (socket) => {
      const path = new URL(socket.url()).pathname;
      if (!path.startsWith(DOC_SOCKET_PATH) || decodeURIComponent(path.slice(DOC_SOCKET_PATH.length).split('/')[0]) !== this.docId) return;
      const conn = opened;
      opened += 1;
      sink.push({ ms: this.ms(), conn, kind: 'open' });
      const frame = (kind: 'out' | 'in') => (data: { payload: string | Buffer }) => {
        const tapped = suggestFrame(data.payload);
        if (tapped) sink.push({ ...tapped, ms: this.ms(), conn, kind });
      };
      socket.on('framesent', frame('out'));
      socket.on('framereceived', frame('in'));
      socket.on('close', () => sink.push({ ms: this.ms(), conn, kind: 'close' }));
    });
  }

  listen(page: Page, label: string): void {
    page.on('dialog', (dialog) => {
      this.dialogs.push({ ms: this.ms(), window: label, type: dialog.type() });
      void (this.dismissDialogs ? dialog.dismiss() : dialog.accept()).catch(() => undefined);
    });
  }

  pane(actor: Actor): Promise<Shown> {
    return paneOf(actor.page, this.docId);
  }

  async brief(actor: Actor): Promise<Record<string, unknown>> {
    const shown = await this.pane(actor);
    return {
      window: actor.label, mode: shown.mode, doc: shown.doc, terminal: shown.terminal, binding: shown.binding, unacked: shown.unacked, sent: shown.sent,
      refused: shown.refused, focused: shown.focused, visible: shown.visible, banners: shown.banners, unsaved: shown.unsaved, lines: draftLines(shown.lines),
      ...(shown.pane ? {} : { noPane: true }), ...(shown.screen ? { screen: shown.screen } : {}), ...(shown.error ? { error: shown.error } : {}),
    };
  }

  /** Every routed window's tap: the person's first window, and any other opened severable. */
  routed(): { window: string; log: TapEvent[] }[] {
    return this.windows.filter((actor) => actor.sever).map((actor) => ({ window: actor.label, log: actor.sever!.log() }));
  }

  /** Every `suggest-refused` reply any of the person's windows heard, as `reason (window)`. */
  refusals(): string[] {
    return [
      ...this.routed().flatMap(({ window, log }) => log.filter((event) => event.kind === 'in' && event.t === 'suggest-refused').map((event) => `${event.reason} (${window})`)),
      ...[...this.wires].flatMap(([window, events]) => events.filter((event) => event.kind === 'in' && event.t === 'suggest-refused').map((event) => `${event.reason} (${window})`)),
    ];
  }

  /** Whether the DocDO has closed one of the first window's sockets 4429. */
  cooled(): boolean {
    return this.sever.log().some((event) => event.kind === 'close' && event.code === COOLDOWN_CLOSE);
  }

  /**
   * Takes what the window shows as what was typed: a key pressed after the note went read-only never appeared, so
   * the checks that follow ask for every character the person saw accepted.
   */
  async adopt(actor: Actor, when: string): Promise<void> {
    const shown = draftLines((await this.pane(actor)).lines);
    const before = { ...this.lines };
    for (const key of Object.keys(START) as LineKey[]) {
      const line = shown.find((text) => text.startsWith(START[key]));
      if (line !== undefined) this.lines[key] = line;
    }
    this.note(`on screen ${when}`, { window: actor.label, shown, was: before });
  }

  /** Opens the note in `actor`'s window (unless it is already loading there) and waits for Suggest to go live. */
  async enterSuggest(actor: Actor, { load = true } = {}): Promise<void> {
    const { docId } = this;
    if (load) await actor.goto(`/d/${docId}`);
    await actor.page.locator(`html[${APP_STATE_ATTR}="ready"]`).waitFor({ state: 'attached', timeout: BOOT_TIMEOUT });
    const pane = ui.pane(actor, docId);
    const body = ui.body(actor, docId);
    if (this.role === 'editor') {
      // An editor's window opens in Edit; Suggest is theirs to turn on, in More actions.
      await expect(pane, `${actor.label}: opens in Edit`).toHaveAttribute(EDIT_MODE_ATTR, 'edit', { timeout: BIND_TIMEOUT });
      await expect(body, `${actor.label}: Edit is live`).toHaveAttribute(BODY_BINDING_ATTR, 'live', { timeout: BIND_TIMEOUT });
      await suggestChanges(actor, docId);
    }
    await expect(pane, `${actor.label}: in Suggest`).toHaveAttribute(EDIT_MODE_ATTR, 'suggest', { timeout: BIND_TIMEOUT });
    await expect(body, `${actor.label}: Suggest is live`).toHaveAttribute(BODY_BINDING_ATTR, 'live', { timeout: BIND_TIMEOUT });
    this.note(`${actor.label} in Suggest`);
  }

  /** Another window of the same person: its own context and session. */
  async second(label: string, { severable = false } = {}): Promise<Actor> {
    const actor = await this.actors.session(this.ben.principal!, { label, severable });
    actor.expectReconnects(40);
    this.watch(actor);
    return actor;
  }

  /** An editor's window on the note, in Edit: it asks the DocDO for no lease. */
  async openEdit(actor: Actor): Promise<void> {
    const { docId } = this;
    await actor.goto(`/d/${docId}`);
    await actor.page.locator(`html[${APP_STATE_ATTR}="ready"]`).waitFor({ state: 'attached', timeout: BOOT_TIMEOUT });
    await expect(ui.pane(actor, docId), `${actor.label}: opens in Edit`).toHaveAttribute(EDIT_MODE_ATTR, 'edit', { timeout: BIND_TIMEOUT });
    await expect(ui.body(actor, docId), `${actor.label}: Edit is live`).toHaveAttribute(BODY_BINDING_ATTR, 'live', { timeout: BIND_TIMEOUT });
    this.note(`${actor.label} in Edit`);
  }

  /** Suggest changes, from More actions; returns once it is chosen, not once Suggest is live. */
  async suggestOn(actor: Actor): Promise<void> {
    await suggestChanges(actor, this.docId);
    this.note(`${actor.label} chose Suggest changes`);
  }

  /**
   * The person's second window asks for its leases: opened on the note (a suggester's window opens in Suggest), or
   * switched to Suggest (an editor's, already open in Edit). Waits until the DocDO closes the first window 4429 or the
   * second is live in Suggest, at most `ms`.
   */
  async secondAsks(second: Actor, ms: number): Promise<TapEvent | null> {
    const { docId } = this;
    if (this.role === 'editor') await this.attempt('the second window turns Suggest on', () => this.suggestOn(second));
    else await this.attempt('the second window opens the note', () => second.goto(`/d/${docId}`));
    const cooled = () => this.sever.log().find((event) => event.kind === 'close' && event.code === COOLDOWN_CLOSE) ?? null;
    const found = await until(async () => {
      const shown = await this.pane(second);
      return { closed: cooled(), live: shown.mode === 'suggest' && shown.binding === 'live' };
    }, (value) => value.closed !== null || value.live, ms, 100);
    const closed = found.value.closed;
    if (closed && this.lockedOutAt === null) this.lockedOutAt = closed.at;
    this.note(closed ? 'the DocDO closed the first window 4429' : found.value.live ? 'the second window is live in Suggest; no 4429' : `neither a 4429 nor a live second window within ${ms} ms`,
      { afterMs: found.ms, ...(closed ? { conn: closed.conn, reason: closed.closeReason } : {}), second: await this.brief(second), sockets: this.closesOf(second) });
    return closed;
  }

  /** Puts the owner's window in Review when a suggestion is open; says where it is otherwise. */
  async ownerReview(): Promise<string> {
    const { ada, docId } = this;
    const pane = ui.pane(ada, docId);
    if ((await pane.getAttribute(EDIT_MODE_ATTR, { timeout: 5_000 }).catch(() => null)) === 'review') return 'review';
    try {
      await ada.page.getByRole('button', { name: 'Review suggestions', exact: true }).first().click({ timeout: 4_000 });
      await expect(pane).toHaveAttribute(EDIT_MODE_ATTR, 'review', { timeout: BIND_TIMEOUT });
      await expect(ui.body(ada, docId)).toHaveAttribute(BODY_BINDING_ATTR, 'readonly', { timeout: BIND_TIMEOUT });
      return 'review';
    } catch (error) {
      return `not in Review: ${firstLine(error)}`;
    }
  }

  async type(actor: Actor, token: string, line: LineKey = 'one', { counted = true } = {}): Promise<void> {
    await actor.page.keyboard.type(` ${token}`, { delay: KEY_DELAY });
    if (counted) {
      this.lines[line] += ` ${token}`;
      this.tokens.push(token);
    }
    this.note(`typed "${token}"`, { window: actor.label, line, counted });
  }

  async settle(actor: Actor, what: string, timeoutMs = 20_000): Promise<boolean> {
    const acked = await until(() => this.pane(actor), (shown) => shown.unacked === '0', timeoutMs, 100);
    this.note(`${what}: ${acked.ok ? 'acknowledged' : `still unacknowledged after ${timeoutMs} ms`}`, { window: actor.label, ms: acked.ms, refused: acked.value.refused, terminal: acked.value.terminal });
    return acked.ok;
  }

  /** The socket closes on both ends and stays down; frames held on it are lost with it. */
  cut(): number {
    this.sever.reset(this.closeCode);
    this.sever.dropHeld();
    const at = Date.now();
    this.note('cut', { drop: this.drop, code: this.closeCode });
    return at;
  }

  get closeCode(): number {
    return this.drop === 'seen' ? SEEN_CLOSE : 1012;
  }

  /** The network is back: the silent socket the page opened while down closes, so its next one reaches the server. */
  up({ loseReplies = false } = {}): void {
    this.sever.reset();
    if (loseReplies) this.sever.loseSuggestReplies();
    this.sever.restore();
    this.note('restored', { loseReplies });
  }

  async resumed(since: number, fate: 'crossed' | 'lost' = 'crossed', timeoutMs = 25_000): Promise<{ request: TapEvent; reply: TapEvent } | null> {
    const found = await until(() => resumeReply(this.sever.log(), since, [fate]), (value) => value !== null, timeoutMs, 100);
    const pair = found.value;
    this.note(pair ? `the resume was answered (${fate})` : `no resume answered (${fate}) within ${timeoutMs} ms`, pair
      ? { conn: pair.reply.conn, afterMs: pair.reply.at - since, named: pair.request.resume?.length, reply: pair.reply.t, reason: pair.reply.reason, leases: pair.reply.leases }
      : undefined);
    return pair;
  }

  /** Waits up to `ms` for the DocDO to close one of the person's routed sockets 4429. */
  async cooldownWithin(ms: number): Promise<TapEvent | null> {
    const found = await until(() => this.sever.log().find((event) => event.kind === 'close' && event.code === COOLDOWN_CLOSE) ?? null, (value) => value !== null, ms, 100);
    if (found.value && this.lockedOutAt === null) this.lockedOutAt = found.value.at;
    this.note(found.value ? 'the DocDO closed the socket 4429' : `no 4429 within ${ms} ms`, found.value ? { conn: found.value.conn, reason: found.value.closeReason, afterMs: found.ms } : undefined);
    return found.value;
  }

  closesOf(actor: Actor): { opened: number; closed: number | null; close: string | null; epoch: number }[] {
    return actor.telemetry.sockets.filter((socket) => socket.docId === this.docId)
      .map((socket) => ({ opened: this.ms(socket.openedAt), closed: socket.closedAt === null ? null : this.ms(socket.closedAt), close: socket.close, epoch: socket.epoch }));
  }

  /**
   * Records, then asserts softly: the server's working export, the note itself, the owner's window and each of the
   * person's windows hold every typed token once; nothing was refused; no socket heard a refusing close.
   */
  async checkpoint(name: string, { waitMs = 8_000, review = true, windows = 'lines' as 'lines' | 'tokens' } = {}): Promise<void> {
    const { ada, ben, docId } = this;
    const want = this.want;
    const same = (lines: string[]) => JSON.stringify(lines) === JSON.stringify(want);
    // `tokens`: a window paints struck text, so it is read for every typed token once rather than for the export's lines.
    const shows = (lines: string[]) => (windows === 'lines' ? same(draftLines(lines)) : this.tokens.every((token) => occurrences(lines.join('\n'), token) === 1));
    const acked = await until(() => this.pane(ben), (shown) => shown.unacked === '0' || shown.terminal !== null, waitMs ? 20_000 : 0, 100);
    const working = await until(() => content(ada, docId, 'working').catch((error: unknown) => `ERROR ${firstLine(error)}`), (text) => same(exportLines(text)), waitMs, 500);
    const mode = review ? await this.ownerReview() : 'not asked';
    const owner = await until(() => this.pane(ada), (shown) => shows(shown.lines), waitMs, 500);
    const person = await until(() => this.pane(ben), (shown) => shows(shown.lines), waitMs, 500);
    const others = [];
    for (const actor of this.windows.filter((window) => window !== ben && !window.page.isClosed())) others.push({ window: actor.label, ...(await this.brief(actor)), sockets: this.closesOf(actor) });
    const note = await content(ada, docId).catch((error: unknown) => `ERROR ${firstLine(error)}`);
    const routed = this.routed();
    const closes = routed.flatMap(({ window, log }) => log.filter((event) => event.kind === 'close')
      .map((event) => ({ window, ms: this.ms(event.at), conn: event.conn, side: event.side, code: event.code, reason: event.closeReason, ...(event.fate ? { fate: event.fate } : {}) })));
    const exchanged = routed.map(({ window, log }) => ({ window, ...exchanges(log, this.t0) }));
    const replies = exchanged.flatMap(({ window, replies: list }) => list.map((reply) => ({ window, ...reply })));
    const counts = exchanged.flatMap(({ window, frames: list }) => list.map((count) => ({ window, ...count })));
    const refusals = replies.filter((reply) => reply.reply === 'suggest-refused');
    const wireRefusals = [...this.wires].flatMap(([window, events]) => events.filter((event) => event.kind === 'in' && event.t === 'suggest-refused').map((event) => ({ window, ms: event.ms, conn: event.conn, reason: event.reason, record: event.record ?? null })));
    const wireCloses = this.windows.filter((window) => !window.sever).flatMap((window) => this.closesOf(window).map((socket) => ({ window: window.label, ...socket })));
    const record = {
      checkpoint: name, ms: this.ms(), want,
      settled: { unacked: acked.value.unacked, terminal: acked.value.terminal, waitedMs: acked.ms },
      working: { lines: exportLines(working.value), same: working.ok, tokens: Object.fromEntries(this.tokens.map((token) => [token, occurrences(working.value, token)])) },
      note: note === this.before ? 'unchanged' : note,
      owner: { mode, at: owner.value.mode, lines: draftLines(owner.value.lines), same: owner.ok },
      person: { ...(await this.brief(ben)), same: person.ok },
      others,
      refusals, wireRefusals,
      leases: replies.filter((reply) => reply.asked === 'suggest-lease'),
      frames: counts,
      closes, wireCloses,
      dialogs: this.dialogs,
    };
    this.checkpoints.push(record);
    console.log(`SUGDROP checkpoint ${this.id} ${JSON.stringify(record)}`);

    expect.soft(exportLines(working.value), `${name}: the server's working export holds every typed character once`).toEqual(want);
    for (const token of this.tokens) expect.soft(occurrences(working.value, token), `${name}: "${token}" is in the working export once`).toBe(1);
    expect.soft(note, `${name}: no suggestion wrote the note`).toBe(this.before);
    if (windows === 'lines') {
      if (mode === 'review') expect.soft(draftLines(owner.value.lines), `${name}: the owner's Review window shows every typed character once`).toEqual(want);
      expect.soft(draftLines(person.value.lines), `${name}: the person's window shows every typed character once`).toEqual(want);
    } else {
      if (mode === 'review') expect.soft(owner.ok, `${name}: the owner's Review window shows every typed token once`).toBe(true);
      expect.soft(person.ok, `${name}: the person's window shows every typed token once`).toBe(true);
    }
    expect.soft(refusals, `${name}: the DocDO refused nothing`).toEqual([]);
    expect.soft(wireRefusals, `${name}: the DocDO refused nothing in the person's other windows`).toEqual([]);
    expect.soft(person.value.refused ?? '0', `${name}: the pane counts no refusal`).toBe('0');
    expect.soft(person.value.unsaved, `${name}: no unsaved-text card`).toEqual([]);
    expect.soft(closes.filter((close) => BAD_CLOSES.includes(close.code ?? 0)), `${name}: no refusing close on the person's sockets`).toEqual([]);
    expect.soft(wireCloses.filter((socket) => BAD_CLOSES.some((code) => (socket.close ?? '').includes(String(code)))), `${name}: no refusing close in the person's other windows`).toEqual([]);
  }

  /**
   * After a 4429: what the window shows, that a key changes nothing, a Retry inside the 60 s, whether anything
   * reconnects by itself once the 60 s have passed, and the Retry after them.
   */
  async lockout(actor: Actor = this.ben): Promise<void> {
    const { docId, sever } = this;
    if (this.lockedOutAt === null) {
      this.note('no 4429 was recorded: nothing to wait out');
      return;
    }
    const closedAt = this.lockedOutAt;
    const retry = ui.pane(actor, docId).getByRole('button', { name: 'Retry', exact: true }).first();
    const terminal = await until(() => this.pane(actor), (shown) => shown.terminal === 'conn-limit', 10_000, 100);
    this.note('locked out: what the window shows', { ...(await this.brief(actor)), terminalAfterMs: terminal.ok ? Date.now() - closedAt : null, retryVisible: await retry.isVisible().catch(() => false) });
    const shownBefore = (await this.pane(actor)).lines.join('\n');
    await actor.page.keyboard.type('Q', { delay: KEY_DELAY }).catch(() => undefined);
    await pause(300);
    this.note('a key while locked out', { changedTheNote: (await this.pane(actor)).lines.join('\n') !== shownBefore });

    // Nothing is held any more: the frames in flight were lost with the socket.
    sever.dropHeld();
    const cooldowns = () => sever.log().filter((event) => event.kind === 'close' && event.code === COOLDOWN_CLOSE).length;
    const opens = () => sever.log().filter((event) => event.kind === 'open').length;
    await this.attempt('Retry inside the 60 s', async () => {
      const [closedBefore, opensBefore] = [cooldowns(), opens()];
      await retry.click({ timeout: 5_000 });
      const again = await until(cooldowns, (count) => count > closedBefore, 10_000, 100);
      await pause(500);
      this.note('Retry inside the 60 s', { atMs: Date.now() - closedAt, socketsOpened: opens() - opensBefore, closed4429Again: again.ok, ...(await this.brief(actor)) });
    });

    const left = closedAt + 61_000 - Date.now();
    if (left > 0) await pause(left);
    const opensAt61 = opens();
    await pause(5_000);
    this.note('61 s after the close, then 5 s more', { socketsOpenedByThemselves: opens() - opensAt61, ...(await this.brief(actor)) });
    await this.attempt('Retry after the 60 s', async () => {
      await retry.click({ timeout: 5_000 });
      const live = await until(() => this.pane(actor), (shown) => shown.terminal === null && shown.binding === 'live', 25_000, 100);
      this.note('Retry after the 60 s', { live: live.ok, typingBlockedMs: Date.now() - closedAt, ...(await this.brief(actor)) });
    });
    await this.settle(actor, 'after the Retry');
  }

  /** The card offering back text that was not saved: its words, and the text it holds once Show text is pressed. */
  async card(actor: Actor, when: string): Promise<void> {
    await this.attempt(`reading the unsaved-text card ${when}`, async () => {
      const card = actor.page.locator(`[${SUGGEST_UNSAVED_ATTR}]`).first();
      if (!(await card.isVisible().catch(() => false))) {
        this.note(`no unsaved-text card ${when}`);
        return;
      }
      const says = (await card.innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 260);
      const show = actor.page.getByRole('button', { name: 'Show text', exact: true }).first();
      const offered = await show.isVisible().catch(() => false);
      if (offered) await show.click({ timeout: 3_000 });
      await pause(400);
      // The text is shown in a block of its own, which the notice may draw beside the card rather than inside it.
      const holds = await actor.page.locator('pre').allInnerTexts().catch(() => [] as string[]);
      const around = await card.evaluate((el) => (el.parentElement?.innerText ?? '').replace(/\s+/g, ' ').slice(0, 400)).catch(() => '');
      const hide = await actor.page.getByRole('button', { name: 'Hide text', exact: true }).count().catch(() => 0);
      this.note(`the unsaved-text card ${when}`, { says, showTextOffered: offered, hideTextShown: hide, holds, around });
    });
  }

  /** Reloads the window, accepting any leave-site dialog, and (unless `live` is false) waits for Suggest again. */
  async reload(actor: Actor, { live = true } = {}): Promise<void> {
    const asked = this.dialogs.length;
    this.note(`reloading ${actor.label}`, await this.brief(actor));
    await actor.page.reload().catch((error: unknown) => this.note('the reload threw', firstLine(error)));
    if (live) await this.attempt(`${actor.label}: Suggest again after the reload`, () => this.enterSuggest(actor, { load: false }));
    else await actor.page.locator(`html[${APP_STATE_ATTR}="ready"]`).waitFor({ state: 'attached', timeout: BOOT_TIMEOUT }).catch(() => undefined);
    this.note(`reloaded ${actor.label}`, { dialogs: this.dialogs.slice(asked).map((dialog) => dialog.type), ...(await this.brief(actor)) });
  }

  /** The owner's window, loaded afresh: what a new load of the note shows them. */
  async reloadOwner(): Promise<void> {
    const { ada, docId } = this;
    await this.attempt('the owner reloads', async () => {
      await ada.page.reload();
      await ada.page.locator(`html[${APP_STATE_ATTR}="ready"]`).waitFor({ state: 'attached', timeout: BOOT_TIMEOUT });
      await expect(ui.body(ada, docId)).toHaveAttribute(BODY_BINDING_ATTR, /live|readonly/, { timeout: BIND_TIMEOUT });
    });
  }

  async finish(): Promise<void> {
    const routed = this.routed();
    for (const { window, log } of routed) {
      for (const event of log) {
        if ((event.kind === 'out' && event.t === 'suggest-ops' && event.fate === 'crossed') || (event.kind === 'in' && event.t === 'suggest-ack' && event.fate === 'crossed')) continue;
        const { at, ...rest } = event;
        console.log(`SUGDROP tap ${this.id} ${window} +${this.ms(at)} ${JSON.stringify(rest)}`);
      }
    }
    for (const [window, events] of this.wires) {
      for (const event of events) {
        if (event.t === 'suggest-ops' || event.t === 'suggest-ack') continue;
        console.log(`SUGDROP wire ${this.id} ${window} ${JSON.stringify(event)}`);
      }
    }
    for (const actor of this.windows) console.log(`SUGDROP sockets ${this.id} ${actor.label} ${JSON.stringify(this.closesOf(actor))}`);
    const refusals = [
      ...routed.flatMap(({ window, log }) => exchanges(log, this.t0).replies.filter((reply) => reply.reply === 'suggest-refused')
        .map((reply) => `${reply.reason} (${window}, asked ${reply.asked}${reply.resume === null ? '' : ' resume'}${reply.sent === 'late' ? ', late' : ''}, conn ${reply.conn})`)),
      ...[...this.wires].flatMap(([window, events]) => events.filter((event) => event.kind === 'in' && event.t === 'suggest-refused').map((event) => `${event.reason} (${window}, conn ${event.conn})`)),
    ];
    // Closes the server made and the sever's own cuts; a page closing its own socket (a remount, a reload) is left out.
    const codes = [
      ...routed.flatMap(({ window, log }) => log.filter((event) => event.kind === 'close' && event.side !== 'page').map((event) => `${window}: ${event.code ?? 'no code'} ${event.closeReason ?? ''}${event.fate ? ` (${event.fate})` : ''}`.trim())),
      ...this.windows.filter((window) => !window.sever).flatMap((window) => this.closesOf(window).map((socket) => `${window.label}: ${socket.close ?? 'open'}`)),
    ];
    console.log(`SUGDROP summary ${this.id} ${JSON.stringify({ lockedOut: this.lockedOutAt !== null, refusals, closes: codes, want: this.want, dialogs: this.dialogs })}`);
    await this.testInfo.attach(`suggest-drop-${this.leg}-${this.role}.json`, {
      body: JSON.stringify({
        id: this.id, leg: this.leg, role: this.role, docId: this.docId, before: this.before, want: this.want, tokens: this.tokens, lockedOutAtMs: this.lockedOutAt === null ? null : this.ms(this.lockedOutAt),
        steps: this.steps, checkpoints: this.checkpoints, dialogs: this.dialogs,
        taps: Object.fromEntries(routed.map(({ window, log }) => [window, log.map(({ at, ...rest }) => ({ ms: this.ms(at), ...rest }))])), wires: Object.fromEntries(this.wires),
        sockets: Object.fromEntries(this.windows.map((actor) => [actor.label, this.closesOf(actor)])),
      }, null, 1),
      contentType: 'application/json',
    }).catch(() => undefined);
  }

  /** Runs the leg; the record is attached whatever happens, before the fixture's invariants. */
  async run(body: () => Promise<void>): Promise<void> {
    try {
      await body();
    } catch (error) {
      this.note('THE LEG THREW', firstLine(error));
      throw error;
    } finally {
      await this.finish().catch(() => undefined);
    }
  }
}

/** Ada's three-paragraph note, shared with Ben at `role`; Ben's window is severable and Ada's has the note open. */
export async function begin(actors: Actors, testInfo: TestInfo, leg: string, role: Role, drop: Drop = 'unseen'): Promise<Probe> {
  const ada = await actors.open(await actors.principal('ada'));
  const response = await ada.context.request.post('/api/docs', { headers: { origin: new URL(ada.page.url()).origin }, data: { markdown: NOTE } });
  expect(response.status()).toBe(201);
  const docId = ((await response.json()) as { doc: { id: string } }).doc.id;
  const benPrincipal = await actors.principal('ben');
  await grantDoc(ada, docId, benPrincipal, role);
  const ben = await actors.session(benPrincipal, { severable: true });
  const before = await content(ada, docId);
  // Every leg cuts, reloads and switches modes: each is a declared reopening of the doc socket.
  ada.expectReconnects(40);
  ben.expectReconnects(60);
  await openIn(ada, docId, 'edit');
  const probe = new Probe(actors, testInfo, leg, role, ada, ben, docId, before, drop);
  probe.watch(ben);
  probe.listen(ada.page, 'ada');
  probe.note('note shared', { role, before });
  return probe;
}

/**
 * One token per phase at the end of paragraph one: acknowledged; stored with its reply lost; sent but never
 * delivered; then the cut, and one typed while down. Returns when the cut was made.
 */
export async function typeAcrossCut(probe: Probe): Promise<number> {
  const { ada, ben, docId, sever } = probe;
  await caretEnd(ben, docId, START.one);
  await probe.type(ben, 'Aa1');
  await probe.settle(ben, 'Aa1');
  probe.note('the owner', { mode: await probe.ownerReview() });
  sever.loseSuggestReplies();
  await probe.type(ben, 'Bb2');
  const stored = await until(() => content(ada, docId, 'working'), (text) => text.includes('Bb2'), 15_000, 200);
  probe.note('Bb2 on the server, its replies lost', { stored: stored.ok, ms: stored.ms });
  sever.hold(docId);
  await probe.type(ben, 'Cc3');
  await pause(400);
  probe.note('Cc3 sent, held in flight', { held: sever.census().held });
  const cutAt = probe.cut();
  await probe.type(ben, 'Dd4');
  await pause(300);
  probe.note('Dd4 typed while down', await probe.brief(ben));
  return cutAt;
}

/**
 * A fresh page of the person's own session, as a second tab or a fresh-load comparison is: the same cookies in a
 * context of its own, so the first window's socket census stays its own. Records its suggest refusals.
 */
export async function freshPage(probe: Probe): Promise<{ page: Page; refused: string[]; close: () => Promise<void> }> {
  const browser = probe.ben.context.browser();
  if (!browser) throw new Error('no browser for a fresh page');
  const context = await browser.newContext();
  await context.addCookies(await probe.ben.context.cookies());
  const page = await context.newPage();
  probe.listen(page, 'ben-fresh');
  const refused: string[] = [];
  page.on('websocket', (socket) => {
    socket.on('framereceived', (data) => {
      const frame = suggestFrame(data.payload);
      if (frame?.t === 'suggest-refused') refused.push(String(frame.reason));
    });
  });
  return { page, refused, close: () => context.close() };
}
