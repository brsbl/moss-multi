// The test D1 handle keeps a batch's statements until the batch settles. Miniflare's proxy client sends each
// statement's address and then holds no reference to the statement; once the garbage collector finalizes it, the client
// tells the proxy server to free the address, and a batch still in flight then fails inside Miniflare
// (proxy.worker.ts, `assert(heapValue !== undefined)`) before D1 runs anything. Production has no such proxy.
import v8 from 'node:v8';
import vm from 'node:vm';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { migratedD1, type TestD1 } from './d1.ts';

// `gc` for this file's process only: the flag exposes it to contexts made from here on.
v8.setFlagsFromString('--expose-gc');
const gc: () => void = vm.runInNewContext('gc');

let d1: TestD1;
beforeAll(async () => {
  d1 = await migratedD1();
}, 60_000);
afterAll(() => d1?.dispose());

// A plain function, so nothing of its frame outlives the call: only the handle can keep the statement.
function start(db: D1Database): { pending: Promise<unknown>; statement: WeakRef<object> } {
  const list = [db.prepare('SELECT ?1 AS one').bind(1)];
  return { statement: new WeakRef(list[0] as unknown as object), pending: db.batch(list) };
}

it('keeps the statements of a batch in flight from the garbage collector', async () => {
  // Miniflare makes the first call of a proxied method synchronously; from the second on, `batch` is in flight.
  await d1.db.batch([d1.db.prepare('SELECT 1')]);
  await d1.db.batch([d1.db.prepare('SELECT 1')]);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    let settled = false;
    const { pending, statement } = start(d1.db);
    const done = pending.then(() => { settled = true; }, () => { settled = true; });
    // One turn of the event loop: the WeakRef's own hold on the statement ends with the job that made it.
    await new Promise<void>((resolve) => setImmediate(resolve));
    gc();
    const inFlight = !settled;
    const collected = statement.deref() === undefined;
    await done;
    if (!inFlight) continue; // The batch was answered within that turn: try again.
    expect(collected, 'a statement of a batch in flight was garbage collected').toBe(false);
    expect(await pending).toMatchObject([{ results: [{ one: 1 }] }]);
    return;
  }
  throw new Error('no batch stayed in flight across one turn of the event loop');
}, 60_000);
