// Ack coverage (A§5.1 Acks, A§10.6): this client's writes are on the server once an ack's state vector covers their
// structs and the deletes acked since they were made cover their deletes. A delete never moves a state vector, so a
// state vector alone would settle a delete the server has not seen. The note and each payload doc (A§10.10) are
// covered separately: an ack names each payload it covers in `p`, with only the clocks its window's frames carried, so
// coverage is the vectors and deletes of every ack since the writes were made, merged.
import { base64ToBytes, type PayloadAck, type ServerEvent } from '@moss-multi/protocol/sync';
import * as Y from 'yjs';

type DeleteSet = ReturnType<typeof Y.createDeleteSet>;
export type Ack = Extract<ServerEvent, { t: 'ack' }>;

/** The note's own writes. */
const NOTE = '';

interface Pending {
  updates: Uint8Array[];
  acked: DeleteSet[];
  sv: Map<number, number>;
}

export class AckLedger {
  readonly #pending = new Map<string, Pending>();

  /** Some local write is not yet covered by an ack. */
  get unacked(): boolean {
    return this.#pending.size > 0;
  }

  /** A local write, as the doc emitted it: the note's, or payload `id`'s. */
  wrote(update: Uint8Array, id: string = NOTE): void {
    let pending = this.#pending.get(id);
    if (!pending) this.#pending.set(id, (pending = { updates: [], acked: [], sv: new Map() }));
    pending.updates.push(update);
  }

  /** Replay only unacknowledged writes if a channel recovers without reconnecting. */
  pendingUpdate(id: string = NOTE): Uint8Array | null {
    const updates = this.#pending.get(id)?.updates;
    return updates?.length ? Y.mergeUpdates(updates) : null;
  }

  /** The payloads with unacked writes. */
  pendingPayloads(): string[] {
    return [...this.#pending.keys()].filter((id) => id !== NOTE);
  }

  /** Reads an ack; true when it settles every pending write. */
  acked(ack: Ack): boolean {
    for (const [id, pending] of [...this.#pending]) {
      const coverage: PayloadAck | undefined = id === NOTE ? ack : ack.p?.[id];
      if (!coverage) continue;
      if (coverage.ds) pending.acked.push(Y.decodeSnapshot(base64ToBytes(coverage.ds)).ds);
      for (const [client, clock] of Y.decodeStateVector(base64ToBytes(coverage.sv))) {
        if ((pending.sv.get(client) ?? 0) < clock) pending.sv.set(client, clock);
      }
      const covered = Y.createSnapshot(Y.mergeDeleteSets(pending.acked), pending.sv);
      if (Y.snapshotContainsUpdate(covered, Y.mergeUpdates(pending.updates))) this.#pending.delete(id);
    }
    return this.#pending.size === 0;
  }
}
