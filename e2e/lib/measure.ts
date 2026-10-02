// Phase clocks (S-test §3.3; L§4.19 C-04): a clock starts only after the input dispatch has returned, and every
// latency lands in the report as a `latency` annotation.
import type { TestInfo } from '@playwright/test';

export interface Latency { name: string; ms: number; budgetMs: number | null }

export interface UntilOptions {
  /** Fails the leg when the observed latency exceeds it. */
  budgetMs?: number;
  /** Gives up (and fails) after this long. */
  timeoutMs?: number;
  intervalMs?: number;
}

export class Measure {
  readonly results: Latency[] = [];

  constructor(private readonly testInfo: TestInfo) {}

  /**
   * Starts a clock now and polls `observed` until it holds. Call it after `keyboard.type()` or the click returns,
   * so dispatch time is never billed to the product.
   */
  async until(name: string, observed: () => boolean | Promise<boolean>, options: UntilOptions = {}): Promise<number> {
    const { budgetMs, timeoutMs = 30_000, intervalMs = 25 } = options;
    const start = performance.now();
    for (;;) {
      if (await observed()) break;
      if (performance.now() - start > timeoutMs) throw new Error(`${name}: not observed within ${timeoutMs} ms`);
      await new Promise((done) => setTimeout(done, intervalMs));
    }
    const ms = Math.round(performance.now() - start);
    this.record({ name, ms, budgetMs: budgetMs ?? null });
    return ms;
  }

  record(latency: Latency): void {
    this.results.push(latency);
    this.testInfo.annotations.push({ type: 'latency', description: JSON.stringify(latency) });
    const problem = budgetProblem(latency);
    if (problem) throw new Error(problem);
  }
}

/** The over-budget message for a latency, or null within budget. */
export function budgetProblem({ name, ms, budgetMs }: Latency): string | null {
  return budgetMs !== null && ms > budgetMs ? `${name}: ${ms} ms is over its ${budgetMs} ms budget` : null;
}

export interface LatencySample { project: string; name: string; ms: number; budgetMs: number | null }

export interface LatencyRow { name: string; project: string; n: number; p50: number; p95: number; max: number; budgetMs: number | null; headroom: number | null }

/** T0.9b tests first: not implemented yet. */
export function percentile(values: number[], p: number): number | null {
  void values;
  void p;
  return null;
}

/** T0.9b tests first: not implemented yet. */
export function latencyRows(samples: LatencySample[]): LatencyRow[] {
  void samples;
  return [];
}
