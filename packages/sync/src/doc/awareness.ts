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

function clientId(connection: Connection): number | undefined {
  return (connection.state as { presenceClientId?: number } | null)?.presenceClientId;
}
function admittedClock(connection: Connection): number {
  return (connection.state as { presenceClock?: number } | null)?.presenceClock ?? -1;
}
function superseded(connection: Connection): boolean {
  return (connection.state as { presenceSuperseded?: boolean } | null)?.presenceSuperseded === true;
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
/**
 * One awareness id per socket, persisted across hibernation; malformed or forged frames have no effect. `reserved` ids
 * belong to the server (an agent shown after its push) and no socket may write them.
 */
export function receivePresence(awareness: Awareness, connection: Connection, message: ArrayBuffer | ArrayBufferView, connections: Connection[], reserved: (id: number) => boolean = () => false): void {
  const identity = attachmentOf(connection);
  if (!identity?.presenceAllowed || superseded(connection)) return;
  try {
    const bytes = message instanceof ArrayBuffer ? new Uint8Array(message) : new Uint8Array(message.buffer, message.byteOffset, message.byteLength);
    const outer = decoding.createDecoder(bytes);
    if (decoding.readVarUint(outer) !== 1) return;
    const payload = decoding.readVarUint8Array(outer);
    if (decoding.hasContent(outer)) return;
    const decoder = decoding.createDecoder(payload);
    if (decoding.readVarUint(decoder) !== 1) return;
    const id = decoding.readVarUint(decoder);
    const clock = decoding.readVarUint(decoder);
    const state = JSON.parse(decoding.readVarString(decoder));
    if (decoding.hasContent(decoder)) return;
    if (reserved(id)) return;
    const owned = clientId(connection);
    if (owned !== undefined && owned !== id) return;
    if (state !== null) {
      const user = state.user;
      if (!user || !(user.principalId === identity.principalId && user.name === identity.name && user.isAgent === (identity.kind === 'agent') && state.name === identity.name) || state.color !== user.color || typeof user.color !== 'string' || user.color.length > 100 || typeof user.colorSettled !== 'boolean') return;
    } else if (owned !== id) return;
    const previousOwners = connections.filter(peer => peer !== connection && !superseded(peer) && clientId(peer) === id);
    if (previousOwners.some(peer => {
      const previous = attachmentOf(peer);
      return previous?.principalId !== identity.principalId || previous.kind !== identity.kind;
    })) return;
    // A replacement socket advances the clock it held; an echo of the state this server relayed does not. A second
    // window of the same person relays the first's frames (y-partyserver rebroadcasts remote changes), and taking
    // those as a reconnect retired the first window's presence and pinned the second to the first's id.
    // The admitted clock lives on the owning socket too, since a DO wake clears awareness.meta.
    const held = Math.max(awareness.meta.get(id)?.clock ?? -1, ...previousOwners.map(peer => admittedClock(peer)));
    if (previousOwners.length > 0 && clock <= held) return;
    // Reconnects retain the Y.Doc clientID, even while the old socket is half-open. Persist retirement so late
    // frames or closes from that socket cannot erase or reclaim the replacement's presence after a DO wake.
    for (const peer of previousOwners) (peer as unknown as Connection<State>).setState(previous => ({ ...previous, presenceSuperseded: true }));
    (connection as unknown as Connection<State>).setState(previous => ({ ...previous, presenceClientId: id, presenceClock: clock }));
    applyAwarenessUpdate(awareness, payload, connection);
    sendPresence(connections, awarenessFrame(awareness, [id]));
  } catch {
    // Invalid awareness is dropped without touching the document or closing the editing socket.
  }
}
export function leavePresence(awareness: Awareness, connection: Connection, connections: Iterable<Connection>): void {
  const id = clientId(connection);
  if (id === undefined || superseded(connection) || !awareness.meta.has(id)) return;
  removeAwarenessStates(awareness, [id], connection);
  sendPresence(connections, awarenessFrame(awareness, [id]));
}
