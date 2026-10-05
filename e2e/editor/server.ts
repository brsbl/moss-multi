// The editor acceptance server on 127.0.0.1: /editor/ is the built bundle (packages/editor/dist), /src/ the
// package sources (the fixture host, packages/editor/src/testing/memory-host.js, and the host helpers it imports),
// /media/ e2e's media fixtures, and /fixture/ the host page. The page is served under the editor's own CSP
// (EDITOR_CSP, what editor.json `csp` requires), so any violation shows up in the run. The moss-html frame
// document is served with its `sandbox allow-scripts` policy, as a host must.
import { createReadStream, existsSync, statSync } from 'node:fs';
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
  "media-src 'self' blob:",
  "frame-src data: https: 'self'",
  "connect-src 'none'",
  "worker-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');
export const FRAME_FILE = 'moss-html-frame.html';
export const FRAME_POLICY = 'sandbox allow-scripts';

export interface EditorServer {
  url: string;
  requests: string[];
  close: () => Promise<void>;
}

export async function serveEditor(): Promise<EditorServer> {
  const requests: string[] = [];
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
    if (prefix === '/fixture/' && extname(file) === '.html') headers['content-security-policy'] = EDITOR_CSP;
    if (pathname === `/editor/${FRAME_FILE}`) headers['content-security-policy'] = FRAME_POLICY;
    response.writeHead(200, { ...headers, 'content-length': String(statSync(file).size) });
    createReadStream(file).pipe(response);
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise((done) => {
        server.closeAllConnections();
        server.close(() => done());
      }),
  };
}
