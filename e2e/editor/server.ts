// The editor acceptance server on 127.0.0.1: /editor/ is the built bundle (packages/editor/dist), /src/ the
// package sources (the fixture host, packages/editor/src/testing/memory-host.js, and the host helpers it imports),
// /media/ e2e's media fixtures, and /fixture/ the host page. The page is served under the editor's own CSP
// (EDITOR_CSP, what editor.json `csp` requires), so any violation shows up in the run. The moss-html frame
// document is served with editor.json's `htmlFrame.policy`, as a host must. A second server, the collector, records
// every request and WebSocket upgrade that reaches it, and a UDP socket every STUN packet, for the frame's
// network-isolation probes. The page's frame-src also lists the collector, standing in for the `https:` a real host
// allows there for web embeds, so only the frame itself can stop a block from navigating to it.
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { createSocket } from 'node:dgram';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const EDITOR_DIST = fileURLToPath(new URL('../../packages/editor/dist', import.meta.url));
const ROOTS: Record<string, string> = {
  '/editor/': EDITOR_DIST,
  '/src/': fileURLToPath(new URL('../../packages/editor/src', import.meta.url)),
  '/media/': fileURLToPath(new URL('../fixtures/media', import.meta.url)),
  '/fixture/': fileURLToPath(new URL('./fixture', import.meta.url)),
};

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.webm': 'video/webm',
  '.mp4': 'video/mp4',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

/** The policy a bb plugin frame gives the editor (docs/design/editor-embed.md §9), with this server as every origin. */
export const EDITOR_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self'",
  "img-src 'self' data: blob: https:",
  "media-src 'self' data: blob:",
  "frame-src data: https: 'self'",
  "connect-src 'none'",
  "worker-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');
export const FRAME_FILE = 'moss-html-frame.html';

/** The policy the built editor.json tells a host to serve the moss-html frame document with. */
export function framePolicy(): string {
  return (JSON.parse(readFileSync(`${EDITOR_DIST}/editor.json`, 'utf8')) as { htmlFrame: { policy: string } }).htmlFrame.policy;
}

export interface EditorServer {
  url: string;
  requests: string[];
  /**
   * Another origin; every request or upgrade that reaches it is recorded as `<method> <path>`, and every packet
   * to its UDP port (`stun`, a STUN server URL) as `UDP <bytes>`.
   */
  collector: { url: string; stun: string; hits: string[] };
  close: () => Promise<void>;
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const closing = (server: Server) =>
  new Promise<void>((done) => {
    server.closeAllConnections();
    server.close(() => done());
  });

export async function serveEditor(): Promise<EditorServer> {
  const requests: string[] = [];
  let pageCsp = EDITOR_CSP;
  const server: Server = createServer((request, response) => {
    const pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://editor').pathname);
    requests.push(pathname);
    const prefix = Object.keys(ROOTS).find((root) => pathname.startsWith(root));
    const root = prefix ? resolve(ROOTS[prefix]) : null;
    let file = root && prefix ? normalize(join(root, pathname.slice(prefix.length))) : '';
    if (!root || (file !== root && !file.startsWith(root + sep))) {
      response.writeHead(404).end();
      return;
    }
    if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
    if (!existsSync(file)) {
      response.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
      return;
    }
    const headers: Record<string, string> = {
      'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    };
    if (prefix === '/fixture/' && extname(file) === '.html') headers['content-security-policy'] = pageCsp;
    if (pathname === `/editor/${FRAME_FILE}`) headers['content-security-policy'] = framePolicy();
    response.writeHead(200, { ...headers, 'content-length': String(statSync(file).size) });
    createReadStream(file).pipe(response);
  });
  const hits: string[] = [];
  const collector: Server = createServer((request, response) => {
    hits.push(`${request.method} ${request.url}`);
    response.writeHead(204, { 'access-control-allow-origin': '*' }).end();
  });
  collector.on('upgrade', (request, socket) => {
    hits.push(`UPGRADE ${request.url}`);
    socket.destroy();
  });
  const udp = createSocket('udp4');
  udp.on('message', (message) => hits.push(`UDP ${message.length}`));
  await new Promise<void>((done) => udp.bind(0, '127.0.0.1', done));
  const url = await listen(server);
  const collectorUrl = await listen(collector);
  pageCsp = EDITOR_CSP.replace("frame-src data: https: 'self'", `frame-src data: https: 'self' ${collectorUrl}`);
  return {
    url,
    requests,
    collector: { url: collectorUrl, stun: `stun:127.0.0.1:${udp.address().port}`, hits },
    close: async () => {
      await Promise.all([closing(server), closing(collector), new Promise<void>((done) => udp.close(() => done()))]);
    },
  };
}
