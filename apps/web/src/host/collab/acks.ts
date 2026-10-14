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

interface Write {
  update: Uint8Array;
  /** The clocks it reaches. */
  ends: Map<number, number>;
  /** The pastes landing when it was made (T3.B4): a frame carrying it writes for them. */
  pastes: readonly string[];
  /** Its place among every write of the ledger. */
  seq: number;
  /** A payload write the DocDO's last usage figure may already include (made before it, still unacked). */
  counted?: boolean;
}

interface Pending {
  writes: Write[];
  /** Every delete acked since the writes were made, merged as each ack arrives. */
  acked: DeleteSet | null;
  sv: Map<number, number>;
}

/** Payload `id`'s entry in an ack: an own key holding an object, so an id like `constructor` reads nothing inherited. */
function payloadCoverage(ack: Ack, id: string): PayloadAck | undefined {
  const entry: unknown = ack.p && Object.hasOwn(ack.p, id) ? ack.p[id] : undefined;
  return entry !== null && typeof entry === 'object' && typeof (entry as PayloadAck).sv === 'string' ? (entry as PayloadAck) : undefined;
}

export class AckLedger {
  readonly #pending = new Map<string, Pending>();
  /** Payloads whose writes are set aside (PayloadSync parks them): kept and settled by acks, but not unacked. */
  readonly #parked = new Set<string>();
  #seq = 0;

  /** Some local write is not yet covered by an ack. */
  get unacked(): boolean {
    for (const id of this.#pending.keys()) if (!this.#parked.has(id)) return true;
    return false;
  }

  /** A local write, as the doc emitted it: the note's, or payload `id`'s, made while `pastes` were landing. */
  wrote(update: Uint8Array, id: string = NOTE, pastes: readonly string[] = []): void {
    let pending = this.#pending.get(id);
    if (!pending) this.#pending.set(id, (pending = { writes: [], acked: null, sv: new Map() }));
    pending.writes.push({ update, ends: Y.parseUpdateMeta(update).to, pastes, seq: this.#seq++ });
  }

  /** Where the next write goes: `dropFrom` it forgets that write and every later one. */
  mark(): number {
    return this.#seq;
  }

  /** Forgets every write made since `mark` (a paste refused after it landed, and what followed it). */
  dropFrom(mark: number): void {
    for (const [id, pending] of [...this.#pending]) {
      pending.writes = pending.writes.filter((write) => write.seq < mark);
      if (pending.writes.length === 0) {
        this.#pending.delete(id);
        this.#parked.delete(id);
      }
    }
  }

  /** The pastes whose writes no ack has covered yet: any frame of this doc may still carry them. */
  pendingPastes(): Set<string> {
    const pastes = new Set<string>();
    for (const pending of this.#pending.values()) for (const write of pending.writes) for (const paste of write.pastes) pastes.add(paste);
    return pastes;
  }

  /** Sets payload `id`'s writes aside (true), or counts them as unacked again (false). */
  park(id: string, parked: boolean): void {
    if (parked) this.#parked.add(id);
    else this.#parked.delete(id);
  }

  /** Replay only unacknowledged writes if a channel recovers without reconnecting. */
  pendingUpdate(id: string = NOTE): Uint8Array | null {
    const writes = this.#pending.get(id)?.writes;
    return writes?.length ? Y.mergeUpdates(writes.map((write) => write.update)) : null;
  }

  /**
   * The bytes of the payload writes no ack has covered yet, made since the DocDO's last usage figure: growth that
   * figure does not include. One made before it may have persisted with its ack lost, and is in it (B207).
   */
  pendingPayloadBytes(): number {
    let bytes = 0;
    for (const [id, pending] of this.#pending) {
      if (id !== NOTE) for (const write of pending.writes) if (!write.counted) bytes += write.update.byteLength;
    }
    return bytes;
  }

  /** The DocDO reported its usage: every payload write pending now is counted in it. */
  usageReported(): void {
    for (const [id, pending] of this.#pending) if (id !== NOTE) for (const write of pending.writes) write.counted = true;
  }

  /** The payloads with unacked writes. */
  pendingPayloads(): string[] {
    return [...this.#pending.keys()].filter((id) => id !== NOTE);
  }

  /** Reads an ack; true when it settles every pending write. */
  acked(ack: Ack): boolean {
    for (const [id, pending] of [...this.#pending]) {
      const coverage = id === NOTE ? ack : payloadCoverage(ack, id);
      if (!coverage) continue;
      if (coverage.ds) {
        const ds = Y.decodeSnapshot(base64ToBytes(coverage.ds)).ds;
        pending.acked = pending.acked ? Y.mergeDeleteSets([pending.acked, ds]) : ds;
      }
      for (const [client, clock] of Y.decodeStateVector(base64ToBytes(coverage.sv))) {
        if ((pending.sv.get(client) ?? 0) < clock) pending.sv.set(client, clock);
      }
      // Each write the acks cover settles on its own, so a large paste's batches leave the ledger as they are acked and
      // a resync resends only what is still in flight. Structs past the acked vector settle nothing yet.
      const reached = pending.writes.filter((write) => [...write.ends].every(([client, clock]) => (pending.sv.get(client) ?? 0) >= clock));
      if (reached.length === 0) continue;
      const covered = Y.createSnapshot(pending.acked ?? Y.createDeleteSet(), pending.sv);
      const settled = new Set(reached.filter((write) => Y.snapshotContainsUpdate(covered, write.update)));
      if (settled.size > 0) pending.writes = pending.writes.filter((write) => !settled.has(write));
      if (pending.writes.length === 0) {
        this.#pending.delete(id);
        this.#parked.delete(id);
      }
    }
    return !this.unacked;
  }
}
