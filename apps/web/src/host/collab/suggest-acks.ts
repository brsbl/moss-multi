// Suggest-frame coverage (docs/design/suggestions.md §2): the DocDO answers every suggest request with exactly one
// `suggest-ack`, `suggest-leased` or `suggest-refused`, in order, so a request is settled by the next reply. A request
// still in flight when its socket drops gets no reply; it stays unsettled until the fork takes it to resend.
import type { SuggestReply, SuggestRequest } from '@moss-multi/protocol/suggest';

export class SuggestLedger {
  #inFlight: SuggestRequest[] = [];
  #unsent: SuggestRequest[] = [];

  /** Some suggest request has no reply yet, so `data-sync-unacked` stays 1. */
  get unacked(): boolean {
    return this.#inFlight.length + this.#unsent.length > 0;
  }

  sent(request: SuggestRequest): void {
    this.#inFlight.push(request);
  }

  /** A request made with no open socket. */
  held(request: SuggestRequest): void {
    this.#unsent.push(request);
  }

  /** The reply to the oldest request in flight, which it settles. */
  replied(): SuggestRequest | undefined {
    return this.#inFlight.shift();
  }

  /** The socket dropped: nothing in flight will be answered. */
  dropped(): void {
    this.#unsent = [...this.#inFlight.splice(0), ...this.#unsent];
  }

  /** What never got a reply, oldest first, for the fork to resend after resuming its leases. */
  takeUnsent(): SuggestRequest[] {
    return this.#unsent.splice(0);
  }
}

export const isSuggestReply = (event: { t: string }): event is SuggestReply =>
  event.t === 'suggest-ack' || event.t === 'suggest-leased' || event.t === 'suggest-refused';
