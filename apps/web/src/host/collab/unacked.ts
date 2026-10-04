// Which doc sessions in this tab hold edits the DocDO has not acked (A§10.6). Dependency-free, so the entry chunk's
// stale-chunk reload can wait on it without loading the collab code.

const holding = new Set<object>();
const waiters = new Set<() => void>();

export function markUnacked(session: object, unacked: boolean): void {
  if (unacked) holding.add(session);
  else holding.delete(session);
  if (holding.size > 0) return;
  for (const done of [...waiters]) done();
  waiters.clear();
}

/** Resolves once no session in the tab holds an unacked edit. */
export function whenAllAcked(): Promise<void> {
  if (holding.size === 0) return Promise.resolve();
  return new Promise((done) => waiters.add(done));
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

/** Tests-first stub. */
export function allowUnload(): void {}
