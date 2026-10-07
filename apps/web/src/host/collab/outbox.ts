// T3.S6: what a doc socket sends. A client frame over 1 MiB never reaches the DocDO (workerd closes the socket and the
// reconnect resends it whole), a socket with over 2 MiB waiting there closes 1013, and one sending more than
// WRITE_RATE writes in its window closes 4420. So a sync update over PIECE_BYTES (a large paste, its redo, a
// reconnect's backlog) goes out as pieces (`splitUpdate`), and writes leave in order with at most WINDOW_BYTES and
// WINDOW_FRAMES sent since the last ack; updates waiting behind the window merge into one frame. Step 1s and
// awareness never wait. A piece an ack already covers is dropped (a reconnect queues the backlog twice: the unacked
// writes and the provider's step 2).
import { encodeSyncFrame } from '@moss-multi/protocol/sync';
import { splitUpdate } from '@moss-multi/sync/update-pieces';
import * as Y from 'yjs';

export const PIECE_BYTES = 256 * 1024;
const WINDOW_BYTES = 512 * 1024;
/** Writes in flight: acks come about every 250 ms, so a burst of small batches stays well under WRITE_RATE. */
const WINDOW_FRAMES = 8;
/** Without an ack for this long, the window reopens (an inert frame earns none). */
const STALL_MS = 10_000;

export type Frame = Uint8Array | string;

interface Queued {
  frame: Frame;
  /** A piece of a split update: the clocks it ends at, and whether it carries the update's deletes. */
  ends?: Map<number, number>;
  deletes?: boolean;
  /** Sync updates waiting together, sent merged as one frame. */
  updates?: Uint8Array[];
  bytes: number;
}

export interface OutboxOptions {
  pieceBytes?: number;
  windowBytes?: number;
  windowFrames?: number;
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

const SYNC_UPDATE = 2;

export class Outbox {
  readonly #queue: Queued[] = [];
  readonly #acked = new Map<number, number>();
  #inFlight = 0;
  #inFlightFrames = 0;
  /** When the server last acked this socket's writes. */
  #lastAck = -Infinity;
  #stall: ReturnType<typeof setTimeout> | undefined;
  readonly #pieceBytes: number;
  readonly #windowBytes: number;
  readonly #windowFrames: number;
  readonly #stallMs: number;

  constructor(private readonly raw: (frame: Frame) => void, options: OutboxOptions = {}) {
    this.#pieceBytes = options.pieceBytes ?? PIECE_BYTES;
    this.#windowBytes = options.windowBytes ?? WINDOW_BYTES;
    this.#windowFrames = options.windowFrames ?? WINDOW_FRAMES;
    this.#stallMs = options.stallMs ?? STALL_MS;
  }

  /**
   * Writes are waiting to go out, or are out on a socket the server is acking: the heartbeat then need not resend
   * them. Writes out on a socket that has earned no ack for STALL_MS (one that reconnected into a dead network) are
   * not, so the resync sends them again.
   */
  get busy(): boolean {
    return this.#queue.length > 0 || (this.#inFlight > 0 && Date.now() - this.#lastAck < this.#stallMs);
  }

  send(frame: Frame): void {
    if (passes(frame)) {
      this.raw(frame);
      return;
    }
    const write = typeof frame === 'string' ? null : syncWrite(frame);
    if (write && frame.length > this.#pieceBytes) {
      for (const piece of splitUpdate(write.update, this.#pieceBytes)) {
        this.#queue.push({ frame: encodeSyncFrame(write.step, piece.update), ends: piece.ends, deletes: piece.deletes, bytes: piece.update.byteLength });
      }
    } else if (write?.step === SYNC_UPDATE) {
      const last = this.#queue.at(-1);
      if (last?.updates && last.bytes + write.update.byteLength <= this.#pieceBytes) {
        last.updates.push(write.update);
        last.bytes += write.update.byteLength;
      } else {
        this.#queue.push({ frame, updates: [write.update], bytes: write.update.byteLength });
      }
    } else {
      this.#queue.push({ frame, bytes: sizeOf(frame) });
    }
    this.#pump();
  }

  /** The server acked this socket's writes up to `sv`: the window reopens. */
  acked(sv: Map<number, number>): void {
    this.#lastAck = Date.now();
    for (const [client, clock] of sv) if ((this.#acked.get(client) ?? 0) < clock) this.#acked.set(client, clock);
    this.#reopen();
  }

  /** The socket closed: what is queued goes with it, and the reconnect's step 2 resends whatever is unacked. */
  close(): void {
    clearTimeout(this.#stall);
    this.#stall = undefined;
    this.#queue.length = 0;
  }

  #reopen(): void {
    clearTimeout(this.#stall);
    this.#stall = undefined;
    this.#inFlight = 0;
    this.#inFlightFrames = 0;
    this.#pump();
  }

  #covered(ends: Map<number, number>): boolean {
    for (const [client, clock] of ends) if ((this.#acked.get(client) ?? 0) < clock) return false;
    return true;
  }

  #pump(): void {
    while (this.#queue.length > 0) {
      const next = this.#queue[0];
      if (next.ends && !next.deletes && this.#covered(next.ends)) {
        this.#queue.shift();
        continue;
      }
      if (this.#inFlight > 0 && (this.#inFlight + next.bytes > this.#windowBytes || this.#inFlightFrames >= this.#windowFrames)) break;
      this.#queue.shift();
      const frame = next.updates && next.updates.length > 1 ? encodeSyncFrame(SYNC_UPDATE, Y.mergeUpdates(next.updates)) : next.frame;
      this.#inFlight += sizeOf(frame);
      this.#inFlightFrames += 1;
      this.raw(frame);
    }
    if (this.#inFlight > 0 && this.#stall === undefined) this.#stall = setTimeout(() => this.#reopen(), this.#stallMs);
  }
}
