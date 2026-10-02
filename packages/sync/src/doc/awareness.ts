// DocDO awareness (A§5.1, A§10.7): the socket attachment that y-partyserver's awareness bookkeeping shares, and the
// awareness size cap. Validating the identity inside awareness states lands with presence (T1.5).
import type { Connection } from 'partyserver';
import { isRole } from '@moss-multi/protocol/roles';
import type { Attachment } from './admission.ts';

type State = Record<string, unknown>;

/**
 * Functional setState only: an object-form call would wipe y-partyserver's `__ypsAwarenessIds` and leave ghost
 * presence after hibernation.
 */
export function attach(connection: Connection, attachment: Attachment): void {
  (connection as unknown as Connection<State>).setState((previous) => ({ ...(previous ?? {}), ...attachment }));
}

export function attachmentOf(connection: Connection): Attachment | null {
  const state = connection.state as Partial<Attachment> | null;
  if (!state || typeof state.principalId !== 'string' || !isRole(state.role)) return null;
  return state as Attachment;
}

/** Awareness frames above the cap are dropped, neither applied nor relayed. */
export const awarenessTooLarge = (bytes: number, maxBytes: number): boolean => bytes > maxBytes;
