import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { describe, expect, it } from 'vitest';
import { JSON_BODY_CAP, closesOnRevoke, createSweep, describeOversized, isLoopback, otherPortOrigin, workerTooLarge } from './sweep.mjs';

describe('otherPortOrigin', () => {
  const cases = [
    ['https://moss.example.invalid', 'https://moss.example.invalid:444'],
    ['https://moss.example.invalid:443/app', 'https://moss.example.invalid:444'],
    ['http://moss.example.invalid', 'http://moss.example.invalid:81'],
    ['http://127.0.0.1:8787', 'http://127.0.0.1:8788'],
    ['http://127.0.0.1:79', 'http://127.0.0.1:81'],
    ['https://moss.example.invalid:65535', 'https://moss.example.invalid:65534'],
  ];
  for (const [base, expected] of cases) {
    it(`${base} -> ${expected}`, () => {
      const other = otherPortOrigin(base);
      expect(other).toBe(expected);
      expect(other).not.toBe(new URL(base).origin);
      expect(new URL(other).port).not.toBe('');
    });
  }
});

describe('isLoopback', () => {
  it('is true only for a stack on this machine', () => {
    expect(isLoopback('http://127.0.0.1:8787')).toBe(true);
    expect(isLoopback('http://localhost:5173/')).toBe(true);
    expect(isLoopback('http://[::1]:8787')).toBe(true);
    expect(isLoopback('https://moss.example.invalid')).toBe(false);
  });
});

describe('workerTooLarge', () => {
  it("passes only the Worker's JSON too-large 413, never an edge or proxy 413", () => {
    expect(workerTooLarge({ status: 413, type: 'text/html; charset=UTF-8', body: '<html><body>413 Request Entity Too Large</body></html>' })).toBe(false);
    expect(workerTooLarge({ status: 413, type: 'application/json', body: '{"error":"over-quota","message":"full"}' })).toBe(false);
    expect(workerTooLarge({ status: 413, type: 'application/json', body: '{"error":"too-large"' })).toBe(false);
    expect(workerTooLarge({ status: 400, type: 'application/json', body: '{"error":"too-large"}' })).toBe(false);
    expect(workerTooLarge({ status: 'no answer' })).toBe(false);
    expect(workerTooLarge({ status: 413, type: 'application/json; charset=UTF-8', body: '{"error":"too-large","message":"The request body is too large."}' })).toBe(true);
  });
});

describe('oversized', () => {
  it('on loopback declares the length and sends no body bytes, so the refusal comes from the header', async () => {
    const seen = [];
    const server = createServer((request, response) => {
      const arrival = { length: request.headers['content-length'], bytes: 0 };
      seen.push(arrival);
      request.on('data', (chunk) => {
        arrival.bytes += chunk.length;
      });
      // Read for a moment before answering, so bytes sent with the request are counted every time.
      setTimeout(() => {
        response.writeHead(413, { 'content-type': 'application/json', connection: 'close' });
        response.end(JSON.stringify({ error: 'too-large', message: 'The request body is too large.' }));
      }, 300);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const sweep = createSweep(`http://127.0.0.1:${server.address().port}`);
      const answer = await sweep.oversized('POST', '/api/unfurl', { 'content-type': 'application/json' }, JSON_BODY_CAP + 1, Buffer.alloc(JSON_BODY_CAP + 1, 0x20));
      expect(seen).toEqual([{ length: String(JSON_BODY_CAP + 1), bytes: 0 }]);
      expect(workerTooLarge(answer), JSON.stringify(answer)).toBe(true);
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  }, 15_000);
});

describe('describeOversized', () => {
  it("names wrangler dev's lost forward and the time, never the body text", () => {
    const lost = describeOversized({ status: 503, type: 'text/plain;charset=UTF-8', body: 'Your worker restarted mid-request. Please try sending the request again.', ms: 5 });
    expect(lost).toBe("503 text/plain;charset=UTF-8 (no JSON error), wrangler dev's proxy lost the forward after 5 ms");
    expect(describeOversized({ status: 503, type: 'text/plain', body: 'secret text', ms: 7 })).toBe('503 text/plain (no JSON error) after 7 ms');
    expect(describeOversized({ status: 413, type: 'application/json', body: '{"error":"too-large"}', ms: 3 })).toBe('413 application/json too-large after 3 ms');
  });
});

// A server frame (unmasked, short) and a client frame's text (masked).
const frame = (opcode, payload) => Buffer.concat([Buffer.from([0x80 | opcode, payload.length]), payload]);
const closeFrame = (code) => {
  const payload = Buffer.alloc(2);
  payload.writeUInt16BE(code);
  return frame(0x8, payload);
};
const SYNC = frame(0x2, Buffer.from([0, 0, 0]));
const PONG = frame(0x1, Buffer.from('pong'));
const clientText = (data) => {
  const length = data[1] & 0x7f;
  const mask = data.subarray(2, 6);
  return Buffer.from(data.subarray(6, 6 + length).map((byte, i) => byte ^ mask[i % 4])).toString();
};

/** A WebSocket endpoint whose admission and answer to the revocation each test scripts; `revoke` fires it. */
async function fakeServer(behave) {
  const server = createServer();
  const sockets = new Set();
  let fire;
  const revoked = new Promise((resolve) => {
    fire = resolve;
  });
  let revokes = 0;
  server.on('upgrade', (request, socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
    const accept = createHash('sha1').update(`${request.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    behave(socket, revoked);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    revoke: async () => {
      revokes += 1;
      fire();
      return { status: 200 };
    },
    revokes: () => revokes,
    close: () => {
      for (const socket of sockets) socket.destroy();
      return new Promise((resolve) => server.close(resolve));
    },
  };
}

async function probe(behave, { ready = 'sync', code = 4403 } = {}) {
  const server = await fakeServer(behave);
  try {
    const result = await closesOnRevoke(server.base, { path: '/parties/doc-d-o/x', ready, code, revoke: server.revoke, admitMs: 1_500, closeMs: 1_500 });
    expect(server.revokes(), 'the revocation always runs').toBe(1);
    expect(result.revoked).toEqual({ status: 200 });
    return result;
  } finally {
    await server.close();
  }
}

describe('closesOnRevoke', () => {
  it('passes a socket admitted first and then closed with the expected code', async () => {
    const result = await probe((socket, revoked) => {
      socket.write(SYNC);
      void revoked.then(() => socket.write(closeFrame(4403)));
    });
    expect(result.ok, result.detail).toBe(true);
  }, 15_000);

  it('passes a workspace socket admitted by its pong and closed 4402', async () => {
    const result = await probe((socket, revoked) => {
      socket.on('data', (data) => {
        if (clientText(data) === 'ping') socket.write(PONG);
      });
      void revoked.then(() => socket.write(closeFrame(4402)));
    }, { ready: 'pong', code: 4402 });
    expect(result.ok, result.detail).toBe(true);
  }, 15_000);

  it('fails a socket whose admission waits until after the revocation, which then refuses it', async () => {
    const result = await probe((socket, revoked) => {
      void revoked.then(() => socket.write(closeFrame(4404)));
    });
    expect(result.ok, result.detail).toBe(false);
  }, 15_000);

  it('fails a socket refused before it was admitted', async () => {
    const result = await probe((socket) => socket.write(closeFrame(4404)));
    expect(result.ok, result.detail).toBe(false);
  }, 15_000);

  it('fails a socket that stays open after the revocation', async () => {
    const result = await probe((socket) => socket.write(SYNC));
    expect(result.ok, result.detail).toBe(false);
  }, 15_000);

  it('fails a socket that is dropped without a close code', async () => {
    const result = await probe((socket, revoked) => {
      socket.write(SYNC);
      void revoked.then(() => socket.destroy());
    });
    expect(result.ok, result.detail).toBe(false);
  }, 15_000);

  it('fails a socket closed with another code', async () => {
    const result = await probe((socket, revoked) => {
      socket.write(SYNC);
      void revoked.then(() => socket.write(closeFrame(4401)));
    });
    expect(result.ok, result.detail).toBe(false);
  }, 15_000);

  it('fails a workspace socket that never answers its ping', async () => {
    const result = await probe((socket, revoked) => {
      void revoked.then(() => socket.write(closeFrame(4402)));
    }, { ready: 'pong', code: 4402 });
    expect(result.ok, result.detail).toBe(false);
  }, 15_000);
});
