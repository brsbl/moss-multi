// The client protocol (registers.md rule 10, A§4.1, A§10.5): the version of the wire a browser bundle speaks, carried
// on every doc socket and REST request, so a server change an older bundle cannot follow refuses that bundle instead
// of letting it write. The file-backed viewer and editor packages hold no socket and are unaffected.

/**
 * The protocol this bundle speaks. Bump it with any client/server change an older bundle cannot follow, and raise
 * MIN_CLIENT_PROTOCOL with it when older bundles must stop writing. 1: decorator payload docs (A§10.10).
 */
export const CLIENT_PROTOCOL = 1;

/** The oldest protocol the server admits. A doc socket without one is 0: a bundle from before payload docs. */
export const MIN_CLIENT_PROTOCOL = 1;

/** On the doc socket's URL; a browser cannot set headers on a WebSocket. */
export const PROTOCOL_PARAM = 'protocol';

/** On REST requests. A request without it (the CLI, an agent, curl) is not a bundle and is not refused. */
export const PROTOCOL_HEADER = 'x-moss-client-protocol';

/** The REST refusal's status and body error; the doc socket closes CLOSE.outdated (4426). */
export const OUTDATED_STATUS = 426;
export const OUTDATED_ERROR = 'client-outdated';

/** A protocol value as sent, or 0 when it is missing or malformed. */
export function protocolOf(value: string | null | undefined): number {
  return value && /^\d{1,6}$/.test(value) ? Number(value) : 0;
}

export const isOutdated = (protocol: number): boolean => protocol < MIN_CLIENT_PROTOCOL;
