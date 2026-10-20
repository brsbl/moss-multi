// The provider the vendored plugin binds in Suggest and Review (docs/design/suggestions.md §5): sync status and
// awareness come from the body's provider; `sync` fires when the bound doc (F or C) is filled, after the binding
// attaches, so the plugin reconciles it like a first sync.
import type YProvider from 'y-partyserver/provider';

type Listener = (...args: never[]) => void;

export class ShimProvider {
  readonly #sync = new Set<Listener>();
  #connected = false;
  #onConnect: () => void;

  constructor(readonly real: YProvider, onConnect: () => void) {
    this.#onConnect = onConnect;
  }

  get awareness(): YProvider['awareness'] {
    return this.real.awareness;
  }

  /** The plugin connects after its binding observes the doc: the doc may be filled from now on. */
  connect(): Promise<void> | void {
    const result = this.real.connect();
    if (!this.#connected) {
      this.#connected = true;
      this.#onConnect();
    }
    return result;
  }

  disconnect(): void {
    this.real.disconnect();
  }

  get connected(): boolean {
    return this.#connected;
  }

  on(type: string, listener: Listener): void {
    if (type === 'sync') this.#sync.add(listener);
    else if (type !== 'reload') (this.real.on as (type: string, listener: Listener) => void)(type, listener);
  }

  off(type: string, listener: Listener): void {
    if (type === 'sync') this.#sync.delete(listener);
    else if (type !== 'reload') (this.real.off as (type: string, listener: Listener) => void)(type, listener);
  }

  /** The bound doc is filled. */
  synced(): void {
    for (const listener of [...this.#sync]) (listener as (synced: boolean) => void)(true);
  }
}
