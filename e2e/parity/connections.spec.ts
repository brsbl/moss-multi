// The parity specs take `test` from @playwright/test itself, so nothing in e2e/lib/test.ts runs in this project. The
// config stops Node's agents pooling sockets in every worker (infra.ts: ownConnections); this is the check that a
// project outside the journey fixtures has it too. Without it a setup POST here was written to a pooled socket as the
// Worker closed it, 5 s after its last answer: "socket hang up" (runs 45740883463 and 44288299954).
import { createServer, type AddressInfo, type Socket } from 'node:net';
import { expect, request, test } from '@playwright/test';

test('each Node-side request in the parity project goes out on a connection of its own', async ({ browser }) => {
  // Answers as the local Worker does: no `Connection: close` in the answer, whatever the request asked, and the
  // socket left open for the client to reuse.
  let connections = 0;
  let requests = 0;
  const open = new Set<Socket>();
  const server = createServer((socket) => {
    connections += 1;
    open.add(socket);
    let buffered = '';
    socket.on('data', (chunk) => {
      buffered += chunk.toString('latin1');
      for (;;) {
        const end = buffered.indexOf('\r\n\r\n');
        if (end < 0) return;
        const length = Number(/\r\ncontent-length:\s*(\d+)/i.exec(buffered.slice(0, end))?.[1] ?? 0);
        if (buffered.length < end + 4 + length) return;
        buffered = buffered.slice(end + 4 + length);
        requests += 1;
        socket.write('HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 2\r\n\r\nok');
      }
    });
    socket.on('error', () => {});
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  const api = await request.newContext();
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await api.get(url);
    await api.post(url, { data: { a: 1 } });
    await context.request.get(url);
    // The form the parity specs use for their setup requests.
    await page.request.post(url, { data: { a: 1 } });
    expect(requests, 'every request was answered').toBe(4);
    expect(connections, 'no request reuses a pooled connection').toBe(4);
  } finally {
    await api.dispose();
    await context.close();
    for (const socket of open) socket.destroy();
    server.close();
  }
});
