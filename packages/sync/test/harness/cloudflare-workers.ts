// `cloudflare:workers` for the Node DO harness: the base class partyserver's Server extends, and its global env.
export class DurableObject<Env = unknown> {
  constructor(
    readonly ctx: unknown,
    readonly env: Env,
  ) {}
}

export const env: Record<string, unknown> = {};
