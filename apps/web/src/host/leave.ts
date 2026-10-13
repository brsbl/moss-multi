// The page's leave (METHOD: WebKit logs a fetch cancelled by a navigation as an access-control page error): every
// client request that can be in flight across a reload carries the leave's signal through its body. A read is held
// while the page leaves and sent again if it stays; a change is sent at most once, and one the leave cut off settles
// as `LeaveCancelled` once the page stays, so its caller reads the state again instead of sending it twice.

/** `signal` aborts as the page starts to leave; `stayed` resolves if the page is still running afterwards. */
export interface Leave { signal: AbortSignal; stayed: Promise<void> }

/** A change the page's leave cut off: it may or may not have landed, so the caller reconciles rather than retries. */
export class LeaveCancelled extends Error {
  constructor() {
    super('moss-multi: the request was cut off as the page left');
    this.name = 'LeaveCancelled';
  }
}

export const isLeaveCancelled = (error: unknown): error is LeaveCancelled => error instanceof LeaveCancelled;

/** A page still running this long after `beforeunload` stayed: its navigation was cancelled (a prompt, a download). */
const STAYED_MS = 5_000;

let leaving: (() => Leave) | null = null;

/** Aborts on `beforeunload`, before WebKit stops the page's loads for the navigation. The leave ends, releasing the
 * held reads, when the page is still here after STAYED_MS or comes back from the back-forward cache. Once per page. */
export function installLeaving(): () => Leave {
  if (leaving) return leaving;
  const arm = () => {
    let end = () => undefined as void;
    const stayed = new Promise<void>((resolve) => { end = resolve; });
    return { controller: new AbortController(), stayed, end };
  };
  let current = arm();
  const stay = () => {
    if (!current.controller.signal.aborted) return;
    const left = current;
    current = arm();
    left.end();
  };
  window.addEventListener('beforeunload', () => {
    current.controller.abort();
    setTimeout(stay, STAYED_MS);
  });
  window.addEventListener('pageshow', (event) => { if (event.persisted) stay(); });
  leaving = () => ({ signal: current.controller.signal, stayed: current.stayed });
  return leaving;
}

/** The page's current leave, or none before `installLeaving` (unit tests, the server). */
export const currentLeave = (): Leave | undefined => leaving?.();

/** Tests: the leave every request without its own `leaving` reads. */
export function setLeaving(next: (() => Leave) | null): void {
  leaving = next;
}

export interface LeaveOptions {
  /** The leave to follow; the page's by default. */
  leaving?: () => Leave | undefined;
  /** Bounds each attempt, its body included; past it the attempt fails (and is not held). */
  timeoutMs?: number;
}

type Send = (signal: AbortSignal | undefined) => Promise<Response>;

/** AbortSignal.any, where the browser has it (Safari 17.4). */
function anySignal(signals: AbortSignal[]): AbortSignal {
  const native = (AbortSignal as { any?: (all: AbortSignal[]) => AbortSignal }).any;
  if (native) return native.call(AbortSignal, signals);
  const controller = new AbortController();
  for (const signal of signals) {
    if (signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
  }
  return controller.signal;
}

/** One attempt: the leave's signal and the deadline's, combined, from the request through `read`. */
async function attempt<T>(send: Send, read: (response: Response) => Promise<T>, leave: Leave | undefined, timeoutMs?: number): Promise<T> {
  const deadline = timeoutMs === undefined ? null : new AbortController();
  const timer = deadline ? setTimeout(() => deadline.abort(new DOMException('The request timed out.', 'TimeoutError')), timeoutMs) : undefined;
  const signals = [leave?.signal, deadline?.signal].filter((signal): signal is AbortSignal => signal !== undefined);
  const signal = signals.length > 1 ? anySignal(signals) : signals[0];
  try {
    const work = (async () => read(await send(signal)))();
    if (!signal) return await work;
    // A fetcher or body that ignores the signal still ends the attempt.
    let off = () => undefined as void;
    const aborted = new Promise<never>((_resolve, reject) => {
      const abort = () => reject(signal.reason ?? new DOMException('The request was aborted.', 'AbortError'));
      if (signal.aborted) abort();
      signal.addEventListener('abort', abort, { once: true });
      off = () => signal.removeEventListener('abort', abort);
    });
    void work.catch(() => undefined);
    try {
      return await Promise.race([work, aborted]);
    } finally {
      off();
    }
  } finally {
    clearTimeout(timer);
  }
}

/** A read: held while the page leaves, and sent again if it stays. */
export async function heldRead<T>(send: Send, read: (response: Response) => Promise<T>, { leaving: follow = currentLeave, timeoutMs }: LeaveOptions = {}): Promise<T> {
  for (;;) {
    const leave = follow();
    if (leave?.signal.aborted) {
      await leave.stayed;
      continue;
    }
    try {
      return await attempt(send, read, leave, timeoutMs);
    } catch (error) {
      if (!leave?.signal.aborted) throw error;
      await leave.stayed;
    }
  }
}

/** A change: sent at most once. One the leave cut off rejects with `LeaveCancelled` once the page stays. */
export async function leaveAwareSend<T>(send: Send, read: (response: Response) => Promise<T>, { leaving: follow = currentLeave, timeoutMs }: LeaveOptions = {}): Promise<T> {
  let leave = follow();
  if (leave?.signal.aborted) {
    // Not sent yet: it goes once the page stays.
    await leave.stayed;
    leave = follow();
  }
  try {
    return await attempt(send, read, leave, timeoutMs);
  } catch (error) {
    if (!leave?.signal.aborted) throw error;
    await leave.stayed;
    throw new LeaveCancelled();
  }
}
