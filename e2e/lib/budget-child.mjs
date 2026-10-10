// Preloaded into a child process (the CLI) through NODE_OPTIONS by RequestBudget.childEnv(): each fetch to the Worker
// appends one byte to the budget's sidecar file, which the run's count adds (e2e/lib/budget.ts).
import { appendFileSync } from 'node:fs';

const path = process.env.MOSS_BUDGET_CHILD_PATH;
const origin = process.env.MOSS_BUDGET_ORIGIN;

if (path && origin) {
  const send = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    try {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const target = new URL(url);
      if (target.origin === origin && !target.pathname.startsWith('/assets/')) appendFileSync(path, '.');
    } catch {
      // Not a URL this budget counts.
    }
    return send(input, init);
  };
}
