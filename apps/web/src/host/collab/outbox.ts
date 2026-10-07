// T3.S6: what a doc socket sends. A client frame over 1 MiB never reaches the DocDO (workerd closes the socket and the
// reconnect resends it whole), and a socket with over 2 MiB waiting there closes 1013. So a sync update over
// PIECE_BYTES (a large paste, its redo, a reconnect's backlog) goes out as pieces (`splitUpdate`), and writes leave in
// order with at most WINDOW_BYTES sent and not yet covered by an ack: an ack frees only the frames it covers, so a
// server slower than the client never has more than a window waiting. Without any ack for STALL_MS, up to
// BUDGET_BYTES may be unacked, still under the inbox. Step 1s and awareness never wait. A piece an ack already covers
// is dropped (a reconnect queues the backlog twice: the unacked writes and the provider's step 2).
import { encodeSyncFrame } from '@moss-multi/protocol/sync';
import { splitUpdate } from '@moss-multi/sync/update-pieces';
import * as Y from 'yjs';

export const PIECE_BYTES = 256 * 1024;
const WINDOW_BYTES = 512 * 1024;
/** Without an ack for this long, the window widens to the budget (a viewer's inert frame earns none). */
const STALL_MS = 10_000;
/** The most ever unacked: below the 2 MiB a socket may have waiting at the DocDO, with room for awareness. */
const BUDGET_BYTES = 1536 * 1024;

export type Frame = Uint8Array | string;

interface Queued {
  frame: Frame;
  /** A write's clocks it ends at, and whether it carries deletes; none for a frame that is not a sync write. */
  ends?: Map<number, number>;
  deletes?: boolean;
}

/** A frame sent and not yet covered by an ack. */
interface Sent {
  bytes: number;
  ends?: Map<number, number>;
}

export interface OutboxOptions {
  pieceBytes?: number;
  windowBytes?: number;
  budgetBytes?: number;
  stallMs?: number;
}

/** `[0, step, varUint8Array]`: the step and the update of a sync step 2 or update frame, else null. */
function syncWrite(frame: Uint8Array): { step: number; update: Uint8Array } | null {
  if (frame[0] !== 0 || (frame[1] !== 1 && frame[1] !== 2)) return null;
  let length = 0;
  let at = 2;
  for (let shift = 0; at < frame.length; shift += 7) {
    const byte = frame[at++];
    length += (byte & 0x7f) * 2 ** shift;
    if (byte < 0x80) break;
  }
  return { step: frame[1], update: frame.subarray(at, at + length) };
}

/** Frames that never wait: custom strings, sync step 1 and awareness; none of them writes. */
const passes = (frame: Frame): boolean => typeof frame === 'string' || (frame[0] === 0 && frame[1] === 0) || frame[0] === 1 || frame[0] === 3;

const sizeOf = (frame: Frame): number => (typeof frame === 'string' ? frame.length : frame.byteLength);

/** Per client, the clock just past an update's structs, and whether it deletes; null for bytes Yjs cannot read. */
function endsOf(update: Uint8Array): { ends: Map<number, number>; deletes: boolean } | null {
  try {
    const { structs, ds } = Y.decodeUpdate(update);
    const ends = new Map<number, number>();
    for (const struct of structs) {
      const end = struct.id.clock + struct.length;
      if ((ends.get(struct.id.client) ?? 0) < end) ends.set(struct.id.client, end);
    }
    return { ends, deletes: ds.clients.size > 0 };
  } catch {
    return null;
  }
}

export class Outbox {
  readonly #queue: Queued[] = [];
  readonly #acked = new Map<number, number>();
  readonly #sent: Sent[] = [];
  #sentBytes = 0;
  /** No ack has covered anything for stallMs: up to the budget may be unacked. */
  #stalled = false;
  #stall: ReturnType<typeof setTimeout> | undefined;
  readonly #pieceBytes: number;
  readonly #windowBytes: number;
  readonly #budgetBytes: number;
  readonly #stallMs: number;

  constructor(private readonly raw: (frame: Frame) => void, options: OutboxOptions = {}) {
    this.#pieceBytes = options.pieceBytes ?? PIECE_BYTES;
    this.#windowBytes = options.windowBytes ?? WINDOW_BYTES;
    this.#budgetBytes = Math.max(this.#windowBytes, options.budgetBytes ?? BUDGET_BYTES);
    this.#stallMs = options.stallMs ?? STALL_MS;
  }

  /** Writes are waiting to go out. */
  get busy(): boolean {
    return this.#queue.length > 0;
  }

  send(frame: Frame): void {
    if (passes(frame)) {
      this.raw(frame);
      return;
    }
    const write = typeof frame === 'string' ? null : syncWrite(frame);
    if (write && write.update.byteLength > this.#pieceBytes) {
      for (const piece of splitUpdate(write.update, this.#pieceBytes)) {
        this.#queue.push({ frame: encodeSyncFrame(write.step, piece.update), ends: piece.ends, deletes: piece.deletes });
      }
    } else {
      const meta = write ? endsOf(write.update) : null;
      this.#queue.push(meta ? { frame, ...meta } : { frame });
    }
    this.#pump();
  }

  /** The server acked this socket's writes up to `sv`: the frames that covers leave the window. */
  acked(sv: Map<number, number>): void {
    for (const [client, clock] of sv) if ((this.#acked.get(client) ?? 0) < clock) this.#acked.set(client, clock);
    // A frame with no clocks of its own (deletes only, or not a sync write) counts as covered by the next ack.
    const before = this.#sent.length;
    for (let i = this.#sent.length - 1; i >= 0; i -= 1) {
      const sent = this.#sent[i];
      if (sent.ends && !this.#covered(sent.ends)) continue;
      this.#sentBytes -= sent.bytes;
      this.#sent.splice(i, 1);
    }
    if (this.#sent.length < before) {
      clearTimeout(this.#stall);
      this.#stall = undefined;
      this.#stalled = false;
    }
    this.#pump();
  }

  /** The socket closed: what is queued goes with it, and the reconnect's step 2 resends whatever is unacked. */
  close(): void {
    clearTimeout(this.#stall);
    this.#stall = undefined;
    this.#queue.length = 0;
    this.#sent.length = 0;
    this.#sentBytes = 0;
  }

  #covered(ends: Map<number, number>): boolean {
    for (const [client, clock] of ends) if ((this.#acked.get(client) ?? 0) < clock) return false;
    return true;
  }

  #pump(): void {
    const limit = this.#stalled ? this.#budgetBytes : this.#windowBytes;
    while (this.#queue.length > 0) {
      const next = this.#queue[0];
      if (next.ends && !next.deletes && next.ends.size > 0 && this.#covered(next.ends)) {
        this.#queue.shift();
        continue;
      }
      const bytes = sizeOf(next.frame);
      if (this.#sentBytes > 0 && this.#sentBytes + bytes > limit) break;
      this.#queue.shift();
      this.#sent.push({ bytes, ends: next.ends && next.ends.size > 0 ? next.ends : undefined });
      this.#sentBytes += bytes;
      this.raw(next.frame);
    }
    if (this.#sent.length > 0 && this.#stall === undefined) {
      this.#stall = setTimeout(() => {
        this.#stall = undefined;
        this.#stalled = true;
        this.#pump();
      }, this.#stallMs);
    }
  }
}
