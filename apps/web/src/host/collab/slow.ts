// T3.S6: doc socket work that holds the main thread long enough to matter becomes a User Timing measure
// (`moss-sync-<name>`), so a stall's report can name it. Shorter work records nothing.
const SLOW_MS = 50;

export function timedSync<T>(name: string, run: () => T): T {
  const started = performance.now();
  try {
    return run();
  } finally {
    if (performance.now() - started >= SLOW_MS) performance.measure(`moss-sync-${name}`, { start: started });
  }
}
