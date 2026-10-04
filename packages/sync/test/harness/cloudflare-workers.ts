// `cloudflare:workers` for the Node DO harness: the base class partyserver's Server extends, and its global env.
export class DurableObject<Env = unknown> {
  constructor(
    readonly ctx: unknown,
    readonly env: Env,
  ) {}
}

export const env: Record<string, unknown> = {};

/** Work that outlives a response; the Node stand-in lets it run and swallows its failure. */
export function waitUntil(promise: Promise<unknown>): void {
  promise.catch(() => undefined);
}
