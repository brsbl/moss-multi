// Crafted Yjs updates: what a client that does not run Yjs's encoder could send.
import * as encoding from 'lib0/encoding';

/** `update` (a v1 update that deletes nothing) with `ranges` as its delete set, encoded as given, unsorted and unmerged. */
export function withDeletes(update: Uint8Array, ranges: [client: number, clock: number, len: number][]): Uint8Array {
  // A v1 update ends with its delete set; one that deletes nothing ends with a zero count of clients.
  if (update[update.length - 1] !== 0) throw new Error('the update already deletes');
  const encoder = encoding.createEncoder();
  encoding.writeUint8Array(encoder, update.subarray(0, update.length - 1));
  const clients = new Map<number, [number, number][]>();
  for (const [client, clock, len] of ranges) clients.set(client, [...(clients.get(client) ?? []), [clock, len]]);
  encoding.writeVarUint(encoder, clients.size);
  for (const [client, list] of clients) {
    encoding.writeVarUint(encoder, client);
    encoding.writeVarUint(encoder, list.length);
    for (const [clock, len] of list) {
      encoding.writeVarUint(encoder, clock);
      encoding.writeVarUint(encoder, len);
    }
  }
  return encoding.toUint8Array(encoder);
}
