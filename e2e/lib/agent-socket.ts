// A doc socket presenting an agent key, as a CLI agent's sync would (j08-agents, j18-agents).
import WebSocket from 'ws';
import { chargeSocket } from './budget.ts';
import { DOC_SOCKET_PATH } from './contract.ts';
import { PROTOCOL_QUERY } from './doc-client.ts';

export interface AgentSocket {
  /** The code of the server's close frame once one arrived, else null. */
  closeCode: () => number | null;
  socket: WebSocket;
}

/**
 * Resolves once the upgrade completes. ws emits `close` only when the TCP connection ends, which wrangler dev leaves to
 * ws's 30 s close timeout, so the code is read as soon as the frame is in (ws's `_closeCode`).
 */
export function agentSocket(baseUrl: string, docId: string, key: string): Promise<AgentSocket> {
  const url = `${baseUrl.replace(/^http/, 'ws')}${DOC_SOCKET_PATH}${encodeURIComponent(docId)}?${PROTOCOL_QUERY}`;
  return new Promise((resolve, reject) => {
    chargeSocket(url);
    const socket = new WebSocket(url, { headers: { authorization: `Bearer ${key}` } });
    const closeCode = () => (socket.readyState === WebSocket.OPEN ? null : (socket as unknown as { _closeCode: number })._closeCode);
    const timer = setTimeout(() => reject(new Error(`${url}: no open within 15 s`)), 15_000);
    socket.on('error', () => undefined);
    socket.on('close', (code) => reject(new Error(`${url}: closed ${code} before opening`)));
    socket.on('open', () => {
      clearTimeout(timer);
      // A refused upgrade is accepted and then closed at once (A§4.1): give it a moment to say so.
      setTimeout(() => (closeCode() === null ? resolve({ closeCode, socket }) : reject(new Error(`${url}: closed ${closeCode()} on admission`))), 500);
    });
  });
}
