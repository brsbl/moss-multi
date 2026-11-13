// Multi-author states shaped against splitAnswer's dependency ordering (T3.B28), written through a real Y.Doc with
// assigned client ids. Yjs encodes higher client ids first, and the ordering visits clients from the lowest.
import * as Y from 'yjs';

/** The highest client id in each shape, so it is visited last. */
export const CHAIN = 1_000_000;

/**
 * `clients` clients in interleaved chains on CHAIN, with `steps` structs of CHAIN's: CHAIN's run alternates with the
 * lowest client (1) and the highest other (`clients`), each struct needing the one before, and every client between
 * builds on CHAIN's last struct. An ordering that wakes every waiter on each struct CHAIN places does steps x clients.
 */
export function interleavedChains(clients: number, steps: number): Uint8Array {
  const doc = new Y.Doc();
  const text = doc.getText('chains');
  doc.transact(() => {
    for (let i = 0; i < steps; i += 1) {
      doc.clientID = CHAIN;
      text.insert(text.length, 'c');
      doc.clientID = i % 2 === 0 ? 1 : clients;
      text.insert(text.length, 'p');
    }
    // CHAIN's last struct is second from the end; every waiter goes right after it.
    const after = text.length - 1;
    for (let client = 2; client < clients; client += 1) {
      doc.clientID = client;
      text.insert(after, 'w');
    }
  });
  const update = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return update;
}

/** `clients` clients, each one struct right after CHAIN's one struct: all of them wait on it at once. */
export function waitersOnOne(clients: number): Uint8Array {
  const doc = new Y.Doc();
  const text = doc.getText('waiters');
  doc.transact(() => {
    doc.clientID = CHAIN;
    text.insert(0, 'c');
    for (let client = 1; client <= clients; client += 1) {
      doc.clientID = client;
      text.insert(1, 'w');
    }
  });
  const update = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return update;
}
