// The viewer acceptance server on 127.0.0.1: /viewer/ is the built bundle (packages/viewer/dist), /fixture/ the
// host page, and /svc/ the media the fixture's assetUrl service hands out, with HTTP Range support as a host's
// video URLs need. Every /svc/ request is recorded with its Range header and status. The bundle's HTML frame document
// is served with the policy a host gives it (FRAME_POLICY), and a path in `slow` streams at about 5 KB/s, so a player
// that seeks ahead of the download has to ask for a byte range.
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { packageCaching, type CacheMode, type Served } from '../lib/package-cache.ts';

export const VIEWER_DIST = fileURLToPath(new URL('../../packages/viewer/dist', import.meta.url));
export const FIXTURE_DIR = fileURLToPath(new URL('./fixture', import.meta.url));

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.md': 'text/markdown; charset=utf-8',
  '.png': 'image/png',
  '.webm': 'video/webm',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

const ROOTS: Record<string, string> = {
  '/viewer/': VIEWER_DIST,
  '/fixture/': FIXTURE_DIR,
  '/svc/': FIXTURE_DIR,
};

export interface MediaRequest {
  path: string;
  range: string | null;
  status: number;
}

export interface ViewerServer {
  url: string;
  media: MediaRequest[];
  /** /svc/ paths streamed slowly. */
  slow: Set<string>;
  /** Every response from /viewer/, with its status and body size (T3.12). */
  served: Served[];
  /** How /viewer/ is cached: `no-store` (the default) or as a host should (lib/package-cache.ts). */
  cache: CacheMode;
  close: () => Promise<void>;
}

/** What a host serves the viewer's frame document with: sandboxed, scripts and styles inline, no network. */
export const FRAME_POLICY = "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:";
const FRAME_FILE = 'moss-viewer-frame.html';

/** Pipes `start..end` of `file` in 512-byte steps, one every 100 ms. */
function trickle(file: string, start: number, end: number, response: ServerResponse) {
  const stream = createReadStream(file, { start, end, highWaterMark: 512 });
  stream.on('data', (chunk) => {
    stream.pause();
    response.write(chunk);
    setTimeout(() => stream.resume(), 100);
  });
  stream.on('end', () => response.end());
  response.on('close', () => stream.destroy());
}

export async function serveViewer(): Promise<ViewerServer> {
  const media: MediaRequest[] = [];
  const slow = new Set<string>();
  const served: Served[] = [];
  const settings: { cache: CacheMode } = { cache: 'no-store' };
  const server: Server = createServer((request, response) => {
    const pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://viewer').pathname);
    const prefix = Object.keys(ROOTS).find((root) => pathname.startsWith(root));
    const root = prefix ? resolve(ROOTS[prefix]) : null;
    let file = root && prefix ? normalize(join(root, pathname.slice(prefix.length))) : '';
    if (!root || (file !== root && !file.startsWith(root + sep))) {
      response.writeHead(404).end();
      return;
    }
    if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
    const record = (status: number) => {
      if (prefix === '/svc/') media.push({ path: pathname, range: request.headers.range ?? null, status });
    };
    if (!existsSync(file)) {
      record(404);
      response.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
      return;
    }
    const size = statSync(file).size;
    const headers: Record<string, string> = { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store', 'accept-ranges': 'bytes' };
    if (prefix === '/viewer/') {
      const caching = packageCaching(settings.cache, pathname.slice(prefix.length), file, request);
      Object.assign(headers, caching.headers);
      served.push({ path: pathname, status: caching.status, bytes: caching.status === 304 ? 0 : size });
      if (caching.status === 304) {
        response.writeHead(304, headers).end();
        return;
      }
    }
    if (prefix === '/viewer/' && pathname === `/viewer/${FRAME_FILE}`) headers['content-security-policy'] = FRAME_POLICY;
    const send = (start: number, end: number) =>
      slow.has(pathname) ? trickle(file, start, end, response) : createReadStream(file, { start, end }).pipe(response);
    const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.range ?? '');
    if (prefix === '/svc/' && range) {
      const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
      const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
      if (start > end || start >= size) {
        record(416);
        response.writeHead(416, { 'content-range': `bytes */${size}` }).end();
        return;
      }
      record(206);
      response.writeHead(206, { ...headers, 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': String(end - start + 1) });
      send(start, end);
      return;
    }
    record(200);
    response.writeHead(200, { ...headers, 'content-length': String(size) });
    if (size > 0) send(0, size - 1);
    else response.end();
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    media,
    slow,
    served,
    get cache() {
      return settings.cache;
    },
    set cache(mode: CacheMode) {
      settings.cache = mode;
    },
    close: () =>
      new Promise((done) => {
        server.closeAllConnections();
        server.close(() => done());
      }),
  };
}
