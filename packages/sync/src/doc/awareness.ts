// DocDO awareness: validated socket-owned identities and grant-only recipients, including after hibernation.
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import { applyAwarenessUpdate, encodeAwarenessUpdate, removeAwarenessStates, type Awareness } from 'y-protocols/awareness';
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

const identityVerdicts = new WeakMap<object, { fields: unknown[]; valid: boolean }>();
function validIdentity(connection: Connection, identity: Attachment, user: Record<string, unknown>, name: unknown): boolean {
  const fields = [identity.principalId, identity.name, identity.kind, user.principalId, user.name, user.isAgent, name];
  const cached = identityVerdicts.get(connection);
  if (cached && fields.every((field, index) => field === cached.fields[index])) return cached.valid;
  const valid = user.principalId === identity.principalId && user.name === identity.name && user.isAgent === (identity.kind === 'agent') && name === identity.name;
  identityVerdicts.set(connection, { fields, valid });
  return valid;
}

function clientId(connection: Connection): number | undefined {
  return (connection.state as { presenceClientId?: number } | null)?.presenceClientId;
}
export function awarenessFrame(awareness: Awareness, ids: number[]): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, 1);
  encoding.writeVarUint8Array(encoder, encodeAwarenessUpdate(awareness, ids));
  return encoding.toUint8Array(encoder);
}
export function sendPresence(connections: Iterable<Connection>, frame: Uint8Array): void {
  for (const connection of connections) {
    if (!attachmentOf(connection)?.presenceAllowed) continue;
    try { connection.send(frame); } catch { /* A closing peer must not interrupt delivery to the others. */ }
  }
}
/** One awareness id per socket, persisted across hibernation; malformed or forged frames have no effect. */
export function receivePresence(awareness: Awareness, connection: Connection, message: ArrayBuffer | ArrayBufferView, connections: Connection[]): void {
  const identity = attachmentOf(connection);
  if (!identity?.presenceAllowed) return;
  try {
    const bytes = message instanceof ArrayBuffer ? new Uint8Array(message) : new Uint8Array(message.buffer, message.byteOffset, message.byteLength);
    const outer = decoding.createDecoder(bytes);
    if (decoding.readVarUint(outer) !== 1) return;
    const payload = decoding.readVarUint8Array(outer);
    if (decoding.hasContent(outer)) return;
    const decoder = decoding.createDecoder(payload);
    if (decoding.readVarUint(decoder) !== 1) return;
    const id = decoding.readVarUint(decoder);
    decoding.readVarUint(decoder);
    const state = JSON.parse(decoding.readVarString(decoder));
    if (decoding.hasContent(decoder)) return;
    const owned = clientId(connection);
    if (owned !== undefined && owned !== id) return;
    if (owned === undefined && connections.some(peer => peer.id !== connection.id && clientId(peer) === id)) return;
    if (state !== null) {
      const user = state.user;
      if (!user || !validIdentity(connection, identity, user, state.name) || state.color !== user.color || typeof user.color !== 'string' || user.color.length > 100 || typeof user.colorSettled !== 'boolean') return;
    } else if (owned !== id) return;
    if (owned === undefined) (connection as unknown as Connection<State>).setState(previous => ({ ...previous, presenceClientId: id }));
    applyAwarenessUpdate(awareness, payload, connection);
    sendPresence(connections, awarenessFrame(awareness, [id]));
  } catch {
    // Invalid awareness is dropped without touching the document or closing the editing socket.
  }
}
export function leavePresence(awareness: Awareness, connection: Connection, connections: Iterable<Connection>): void {
  const id = clientId(connection);
  if (id === undefined) return;
  removeAwarenessStates(awareness, [id], connection);
  sendPresence(connections, awarenessFrame(awareness, [id]));
}
