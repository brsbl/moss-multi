// Which doc sessions in this tab hold edits the DocDO has not acked (A§10.6). Dependency-free, so the entry chunk's
// stale-chunk reload can wait on it without loading the collab code.

const holding = new Set<object>();
/** Text this window alone holds that no session owes any more (a closed suggestion's, offered back until dismissed). */
const keeping = new Set<string>();
const waiters = new Set<() => void>();
let leaving = false;

/** A reload or tab close would discard edits only this window holds, so the browser asks first. */
function guardUnload(event: BeforeUnloadEvent): void {
  if (leaving || (holding.size === 0 && keeping.size === 0)) return;
  event.preventDefault();
  event.returnValue = '';
}

/** Listening only while needed: a beforeunload listener keeps a page out of the back-forward cache. */
function listen(): void {
  if (typeof window === 'undefined') return;
  if (holding.size > 0 || keeping.size > 0) window.addEventListener('beforeunload', guardUnload);
  else window.removeEventListener('beforeunload', guardUnload);
}

/** `key` holds text only this window has until it is let go: the browser asks before a reload or close meanwhile. */
export function markKept(key: string, kept: boolean): void {
  if (kept) keeping.add(key);
  else {
    keeping.delete(key);
    released.delete(key);
  }
  listen();
}

/** Kept text the person chose to discard (the sign-out confirm): the leave that follows does not ask about it again. */
const released = new Set<string>();
/** `release`: the person chose to discard what is kept now; otherwise that choice no longer stands. */
export function releaseKept(release: boolean): void {
  released.clear();
  if (release) for (const key of keeping) released.add(key);
}

/**
 * The one decision every leave, reload and sign-out the app starts makes (A§10.6), read when it would go, after its
 * last await: `kept`, text offered back and not dismissed that the person has not chosen to discard (no wait saves
 * it, so the page stays or the person is asked); `unacked`, edits the DocDO has not acked yet; null, nothing is lost.
 */
export function unsavedHere(): 'kept' | 'unacked' | null {
  for (const key of keeping) if (!released.has(key)) return 'kept';
  return holding.size > 0 ? 'unacked' : null;
}

/**
 * navigation.ts's leaves have already waited for acks or asked, so the browser does not ask again. While text is
 * kept that nobody asked about, the browser's guard stays armed and asks instead; returns whether it stood aside.
 */
export function allowUnload(): boolean {
  if (unsavedHere() === 'kept') return false;
  released.clear();
  leaving = true;
  // A page restored from the back-forward cache guards again.
  window.addEventListener('pageshow', () => { leaving = false; }, { once: true });
  return true;
}

export function markUnacked(session: object, unacked: boolean): void {
  if (unacked) holding.add(session);
  else holding.delete(session);
  listen();
  if (holding.size > 0) return;
  for (const done of [...waiters]) done();
  waiters.clear();
}

export const hasUnacked = (): boolean => holding.size > 0;
const openSessions = new Set<object>();
export function markSession(session: object, open: boolean): void {
  if (open) openSessions.add(session);
  else openSessions.delete(session);
}
export const hasDocSessions = (): boolean => openSessions.size > 0;

/** A bounded wait removes its subscription even when the server never answers. */
export function waitForAllAcked(timeoutMs: number): Promise<boolean> {
  if (!hasUnacked()) return Promise.resolve(true);
  return new Promise(resolve => {
    const finish = (acked: boolean) => {
      clearTimeout(timer);
      waiters.delete(done);
      resolve(acked);
    };
    const done = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    waiters.add(done);
  });
}
