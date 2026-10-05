// The client frame discipline (docs/design/comments.md §6). On a reconnect, before answering the DocDO's sync step 1,
// and on a resync while writes are unacked, the session replays its unacknowledged local updates as separate frames:
// only runs of insert-only or of delete-only updates are merged (groupPending), so the DocDO never receives a
// deletion merged with another update's inserts, which would make a delete-and-retype read as an undo (ruling 18).
// Frames are paced, and updates made meanwhile wait behind them, so the DocDO receives every update in order.
import { groupPending } from '@moss-multi/core/group-pending';

/** At most 40 replay frames a second, below the DocDO's write rate of 300 frames per 5 s. */
export const REPLAY_FRAMES_PER_SECOND = 40;
const GAP_MS = 1000 / REPLAY_FRAMES_PER_SECOND;

export class Replay {
  #queue: Uint8Array[] = [];
  #held: Uint8Array[] = [];
  #done: (() => void) | null = null;
  #timer: ReturnType<typeof setTimeout> | null = null;

  /** `send` returns false when the socket can no longer take a frame, which ends the replay. */
  constructor(private readonly send: (frame: Uint8Array) => boolean) {}

  get active(): boolean {
    return this.#timer !== null;
  }

  /**
   * Replays `updates` (each one local transaction's update, in order) as grouped frames, one per GAP_MS, then calls
   * `done` one gap after the last. A replay already running is replaced.
   */
  start(updates: readonly Uint8Array[], done?: () => void): void {
    this.cancel();
    this.#queue = groupPending(updates);
    this.#done = done ?? null;
    this.#step();
  }

  /** A local update made during a replay: it is sent after the replay's frames, grouped the same way. */
  hold(update: Uint8Array): void {
    this.#held.push(update);
  }

  cancel(): void {
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
    this.#queue = [];
    this.#held = [];
    this.#done = null;
  }

  readonly #step = (): void => {
    if (this.#queue.length === 0 && this.#held.length > 0) {
      this.#queue = groupPending(this.#held);
      this.#held = [];
    }
    const frame = this.#queue.shift();
    if (!frame) {
      const done = this.#done;
      this.#timer = null;
      this.#done = null;
      done?.();
      return;
    }
    if (!this.send(frame)) {
      this.cancel();
      return;
    }
    this.#timer = setTimeout(this.#step, GAP_MS);
  };
}

/** A lib0 decoder positioned after a sync message's leading type. */
interface Decoder {
  arr: Uint8Array;
  pos: number;
}

function varUint(decoder: Decoder): number {
  let value = 0;
  for (let scale = 1; ; scale *= 128) {
    if (decoder.pos >= decoder.arr.length) throw new RangeError('truncated sync message');
    const byte = decoder.arr[decoder.pos++];
    value += (byte & 0x7f) * scale;
    if (byte < 0x80) return value;
  }
}

/** The state vector of a sync step 1, consumed from `decoder`; any other sync message leaves it unread (null). */
export function readStep1(decoder: Decoder): Uint8Array | null {
  const at = decoder.pos;
  if (varUint(decoder) !== 0) {
    decoder.pos = at;
    return null;
  }
  const length = varUint(decoder);
  const sv = decoder.arr.subarray(decoder.pos, decoder.pos + length);
  decoder.pos += length;
  return sv;
}
