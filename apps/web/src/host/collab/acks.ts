// Ack coverage (A§5.1 Acks, A§10.6): this client's writes are on the server once an ack's state vector covers their
// structs and the deletes acked since they were made cover their deletes. A delete never moves a state vector, so a
// state vector alone would settle a delete the server has not seen.
import { base64ToBytes, type ServerEvent } from '@moss-multi/protocol/sync';
import * as Y from 'yjs';

type DeleteSet = ReturnType<typeof Y.createDeleteSet>;
export type Ack = Extract<ServerEvent, { t: 'ack' }>;

export class AckLedger {
  #pending: Uint8Array[] = [];
  #acked: DeleteSet[] = [];

  /** Some local write is not yet covered by an ack. */
  get unacked(): boolean {
    return this.#pending.length > 0;
  }

  /** A local write, as the doc emitted it. */
  wrote(update: Uint8Array): void {
    this.#pending.push(update);
  }

  /** Replay only unacknowledged writes if a channel recovers without reconnecting. */
  pendingUpdate(): Uint8Array | null {
    return this.#pending.length ? Y.mergeUpdates(this.#pending) : null;
  }

  /** Reads an ack; true when it settles every pending write. */
  acked(ack: Ack): boolean {
    if (this.#pending.length === 0) return true;
    if (ack.ds) this.#acked.push(Y.decodeSnapshot(base64ToBytes(ack.ds)).ds);
    const covered = Y.createSnapshot(Y.mergeDeleteSets(this.#acked), Y.decodeStateVector(base64ToBytes(ack.sv)));
    if (!Y.snapshotContainsUpdate(covered, Y.mergeUpdates(this.#pending))) return false;
    this.#pending = [];
    this.#acked = [];
    return true;
  }
}
