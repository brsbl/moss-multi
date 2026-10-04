import { Server } from 'partyserver';
import { REST_WRITE_RATE } from '@moss-multi/protocol/limits';
import type { SyncEnv } from './env.ts';

/**
 * A sliding window of grants: `take` grants while fewer than `max` attempts fall in the last `windowMs`. Denied
 * attempts count, so a caller that keeps hammering stays refused. In memory: a wake starts empty (A§5.1).
 */
export class RateWindow {
  #attempts: number[] = [];

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {}

  take(now = Date.now()): boolean {
    const recent = this.#attempts.filter((at) => now - at < this.windowMs);
    recent.push(now);
    // Only the newest `max` matter to the next decision, so a flood never grows the list.
    this.#attempts = recent.slice(-this.max);
    return recent.length <= this.max;
  }
}

// One per principal, named by its id: workspace channel, sign-out registry and the REST write limit (A§5.2).
export class PrincipalDO extends Server<SyncEnv> {
  static options = { hibernate: true };
  readonly #writes = new RateWindow(REST_WRITE_RATE.max, REST_WRITE_RATE.windowMs);

  /** One REST write by this principal (a rename now, a push later); false past REST_WRITE_RATE. */
  takeWriteToken(): boolean {
    return this.#writes.take();
  }
}
