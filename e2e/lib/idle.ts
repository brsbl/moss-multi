import type { Actor } from './actors.ts';
import { DOC_SOCKET_PATH } from './contract.ts';

/** Headless visibility is simulated in both engines; the socket and product timers remain real. */
export async function visibility(actor: Actor, hidden: boolean): Promise<void> {
  await actor.page.evaluate((value) => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => value });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => value ? 'hidden' : 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
  }, hidden);
}

/** Read-only frame census: client IDs and clocks in y-protocols awareness updates. */
export function awarenessFrames(actor: Actor) {
  const sent = new Map<number, number>();
  const received = new Map<number, number>();
  const record = (payload: string | Buffer, target: Map<number, number>) => {
    if (typeof payload === 'string') return;
    let offset = 0;
    const uint = () => {
      let result = 0;
      let factor = 1;
      for (let count = 0; count < 8 && offset < payload.length; count++) {
        const byte = payload[offset++];
        result += (byte & 127) * factor;
        if (byte < 128) return result;
        factor *= 128;
      }
      throw new Error('invalid awareness frame');
    };
    if (uint() !== 1) return;
    uint(); // length-prefixed awareness payload
    const count = uint();
    for (let i = 0; i < count; i++) {
      const id = uint();
      const clock = uint();
      const length = uint();
      const state = JSON.parse(payload.subarray(offset, offset + length).toString()) as unknown;
      offset += length;
      if (state !== null) target.set(id, clock);
      else target.delete(id);
    }
  };
  actor.page.on('websocket', (socket) => {
    if (!new URL(socket.url()).pathname.startsWith(DOC_SOCKET_PATH)) return;
    socket.on('framesent', ({ payload }) => record(payload, sent));
    socket.on('framereceived', ({ payload }) => record(payload, received));
  });
  return { sent, received };
}
