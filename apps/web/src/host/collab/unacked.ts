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
