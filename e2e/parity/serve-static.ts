// Serves the built Ladle oracle on 127.0.0.1 (S-test §5.1). Locally: node e2e/parity/serve-static.ts <dir> [port]
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json',
};

export interface StaticServer { url: string; close: () => Promise<void> }

export async function serveStatic(dir: string, port = 0): Promise<StaticServer> {
  const root = resolve(dir);
  const server: Server = createServer((request, response) => {
    const pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://oracle').pathname);
    let file = normalize(join(root, pathname));
    if (file !== root && !file.startsWith(root + sep)) {
      response.writeHead(403).end();
      return;
    }
    if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
    if (!existsSync(file)) {
      response.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
      return;
    }
    response.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
    createReadStream(file).pipe(response);
  });
  await new Promise<void>((done) => server.listen(port, '127.0.0.1', done));
  const { port: bound } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${bound}`, close: () => new Promise((done) => server.close(() => done())) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [dir, port = '61007'] = process.argv.slice(2);
  if (!dir) throw new Error('usage: serve-static.ts <dir> [port]');
  console.log((await serveStatic(dir, Number(port))).url);
}
