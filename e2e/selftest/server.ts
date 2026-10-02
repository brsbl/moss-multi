// Static fixture server for the selftest projects: each /<name>.html is base.html with faults/<name>.html
// spliced in, /api/version answers like the Worker, and /parties/doc-d-o/* is a WebSocket echo.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { join } from 'node:path';

const FIXTURES = join(import.meta.dirname, 'fixtures');
export const FIXTURE_VERSION = { commit: 'selftest', bundleHash: 'bundle0', clientHash: 'client0' };

export interface FixtureServer {
  url: string;
  sockets: () => number;
  close: () => Promise<void>;
}

function page(name: string): string | null {
  if (!/^[a-z0-9-]+$/.test(name)) return null;
  const base = readFileSync(join(FIXTURES, 'base.html'), 'utf8');
  if (name === 'clean') return base;
  try {
    return base.replace('<!--fault-->', readFileSync(join(FIXTURES, 'faults', `${name}.html`), 'utf8'));
  } catch {
    return null;
  }
}

// Minimal RFC 6455 server side: masked client frames in, unmasked frames out; text echo, ping, close.
function frame(opcode: number, payload: Buffer): Buffer {
  const head = payload.length < 126 ? Buffer.from([0x80 | opcode, payload.length]) : Buffer.from([0x80 | opcode, 126, payload.length >> 8, payload.length & 255]);
  return Buffer.concat([head, payload]);
}

function echo(socket: Socket) {
  let buffer = Buffer.alloc(0);
  socket.on('data', (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 2) {
      const opcode = buffer[0] & 0x0f;
      let length = buffer[1] & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (buffer.length < 4) return;
        length = buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        socket.destroy();
        return;
      }
      if (buffer.length < offset + 4 + length) return;
      const mask = buffer.subarray(offset, offset + 4);
      const payload = Buffer.from(buffer.subarray(offset + 4, offset + 4 + length));
      for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4];
      buffer = buffer.subarray(offset + 4 + length);
      if (opcode === 0x1 || opcode === 0x2) socket.write(frame(opcode, payload));
      else if (opcode === 0x9) socket.write(frame(0xa, payload));
      else if (opcode === 0x8) {
        socket.end(frame(0x8, payload.subarray(0, 2)));
        return;
      }
    }
  });
}

export async function startFixtureServer(): Promise<FixtureServer> {
  const open = new Set<Socket>();
  const server = createServer((req, res) => {
    const { pathname } = new URL(req.url ?? '/', 'http://fixture');
    if (pathname === '/api/version') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(FIXTURE_VERSION));
      return;
    }
    const html = /^\/([a-z0-9-]+)\.html$/.exec(pathname);
    const body = html ? page(html[1]) : null;
    if (body === null) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(body);
  });
  server.on('upgrade', (req: IncomingMessage, socket: Socket) => {
    const key = req.headers['sec-websocket-key'];
    if (!req.url?.startsWith('/parties/doc-d-o/') || typeof key !== 'string') {
      socket.destroy();
      return;
    }
    const accept = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    open.add(socket);
    socket.on('close', () => open.delete(socket));
    socket.on('error', () => open.delete(socket));
    echo(socket);
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    sockets: () => open.size,
    close: () =>
      new Promise((done) => {
        for (const socket of open) socket.destroy();
        server.close(() => done());
        server.closeAllConnections();
      }),
  };
}
