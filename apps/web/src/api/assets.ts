// Assets (A§16): moss's media set, folder-scoped, with the bytes content-addressed in R2 (`asset-blobs/sha256/<hash>`)
// behind `content_objects` refcounts and `asset_versions`.
//   POST /api/docs/:id/assets?filename=     raw body into the doc's folder; editor and above on the doc
//   POST /api/folders/:id/assets?filename=  raw body into the folder; editor and above on the folder
//   POST /api/docs/:id/assets/copy          {sourceNoteId, sourceRelativePath}: moss's cross-note paste
//   GET|HEAD /api/docs/:id/assets/:file     any reader of the doc, a share link included
// Markdown keeps moss's `assets/<file>`, resolved in the doc's folder, so a note's media follows it into any copy in
// that folder; a copy made elsewhere carries what its markdown references (copyReferencedAssets).
import { and, eq, inArray } from 'drizzle-orm';
import { MEDIA_CAP_BYTES, mediaFilename, mediaTypeOf, suffixedFilename, ASSET_DIR } from '@moss-multi/protocol/media';
import { roleAtLeast } from '@moss-multi/protocol/roles';
import type { AuthEnv } from '../auth/auth.ts';
import { resolvePrincipal, shareTokenOf } from '../auth/principal.ts';
import { createDb, type Db } from '../db/client.ts';
import { assets, assetVersions } from '../db/schema.ts';
import type { AppEnv } from '../env.ts';
import { json } from '../worker/route.ts';
import { resolveDocAccess, resolveFolderAccess } from './access.ts';
import { NO_STORE, notFound, readJsonObject } from './respond.ts';

export type AssetsEnv = AuthEnv & Pick<AppEnv, 'ASSETS'>;

export const ASSET_ROUTE = /^\/api\/(?:docs|folders)\/[^/]+\/assets(?:\/.*)?$/;
const DOC_UPLOAD = /^\/api\/docs\/([^/]+)\/assets$/;
const FOLDER_UPLOAD = /^\/api\/folders\/([^/]+)\/assets$/;
const COPY = /^\/api\/docs\/([^/]+)\/assets\/copy$/;
const FILE = /^\/api\/docs\/([^/]+)\/assets\/([^/]+)$/;

const CURRENT_CACHE = 'private, max-age=0, stale-while-revalidate=86400';
const VERSION_CACHE = 'private, max-age=31536000, immutable';
/** An uploaded name is tried with -2, -3, … this many times before the upload gives up. */
const NAME_ATTEMPTS = 50;

const blobKey = (hash: string) => `asset-blobs/sha256/${hash}`;
const refuse = (status: number, error: string, message: string) => json({ error, message }, status, NO_STORE);
const tooLarge = (kind: 'image' | 'video') =>
  refuse(413, 'too-large', `${kind === 'image' ? 'Images' : 'Videos'} can be at most ${MEDIA_CAP_BYTES[kind] / (1024 * 1024)} MB.`);
const unsupported = () =>
  refuse(415, 'unsupported-media', 'Only images (png, jpg, gif, webp, svg) and video (mp4, webm, mov) can be uploaded.');

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** The filename a `?filename=` or `assets/<file>` path names, decoded and folded to a stored name. */
const storedName = (raw: string): string | null => mediaFilename(raw.replace(/^\.?\/?(?:assets\/)?/, ''));

interface Current { id: string; filename: string; contentHash: string; versionId: string }

/** The folder's asset under `filename` and its current version's bytes, if any. */
async function currentAsset(db: Db, folderId: string, filename: string): Promise<(Current & { contentType: string; size: number; etag: string }) | null> {
  const [row] = await db
    .select({ id: assets.id, filename: assets.filename, contentType: assets.contentType, versionId: assetVersions.id,
      contentHash: assetVersions.contentHash, size: assetVersions.size, etag: assetVersions.etag })
    .from(assets)
    .innerJoin(assetVersions, eq(assetVersions.id, assets.currentVersionId))
    .where(and(eq(assets.folderId, folderId), eq(assets.filename, filename)))
    .limit(1);
  return row ?? null;
}

const isUnique = (error: unknown) => /UNIQUE/i.test(`${error} ${(error as { cause?: unknown })?.cause ?? ''}`);

/**
 * Names `hash`'s bytes `filename` in `folderId`: the asset already holding them under that name or a suffixed one, else a
 * new asset at the first free name. One D1 batch per attempt, so a concurrent upload that takes the name retries.
 */
async function placeAsset(env: AssetsEnv, folderId: string, filename: string, blob: { hash: string; size: number; contentType: string }, createdBy: string) {
  const db = createDb(env.DB);
  const type = mediaTypeOf(filename);
  if (!type) throw new Error(`not media: ${filename}`);
  for (let attempt = 1; attempt <= NAME_ATTEMPTS; attempt += 1) {
    const name = attempt === 1 ? filename : suffixedFilename(filename, attempt);
    const existing = await currentAsset(db, folderId, name);
    if (existing?.contentHash === blob.hash) return { id: existing.id, filename: name, versionId: existing.versionId, size: blob.size };
    if (existing) continue;
    const id = crypto.randomUUID();
    const versionId = crypto.randomUUID();
    const now = Date.now();
    try {
      await env.DB.batch([
        env.DB.prepare('INSERT INTO content_objects (hash, size, refcount) VALUES (?1, ?2, 1) ON CONFLICT(hash) DO UPDATE SET refcount = refcount + 1')
          .bind(blob.hash, blob.size),
        env.DB.prepare('INSERT INTO assets (id, folder_id, filename, kind, content_type, size, current_version_id, created_by, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, ?7, ?8)')
          .bind(id, folderId, name, type.kind, blob.contentType, blob.size, createdBy, now),
        env.DB.prepare('INSERT INTO asset_versions (id, asset_id, content_hash, size, etag, created_by, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)')
          .bind(versionId, id, blob.hash, blob.size, `"${blob.hash}"`, createdBy, now),
        env.DB.prepare('UPDATE assets SET current_version_id = ?1 WHERE id = ?2').bind(versionId, id),
      ]);
      return { id, filename: name, versionId, size: blob.size };
    } catch (error) {
      if (!isUnique(error)) throw error;
    }
  }
  return null;
}

const placed = (asset: { id: string; filename: string; versionId: string; size: number }) =>
  json({ relativePath: `${ASSET_DIR}${asset.filename}`, filename: asset.filename,
    asset: { id: asset.id, versionId: asset.versionId, size: asset.size } }, 201, NO_STORE);

/** The raw body into `folderId`, after the caller's right to write there was checked. */
async function store(request: Request, env: AssetsEnv, folderId: string, createdBy: string): Promise<Response> {
  const raw = new URL(request.url).searchParams.get('filename') ?? '';
  const filename = storedName(raw);
  const type = filename ? mediaTypeOf(filename) : null;
  if (!filename || !type) return unsupported();
  const declared = (request.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  if (declared && declared !== 'application/octet-stream' && declared !== type.contentType) return unsupported();
  const cap = MEDIA_CAP_BYTES[type.kind];
  if (Number(request.headers.get('content-length') ?? 0) > cap) return tooLarge(type.kind);
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength === 0) return refuse(400, 'empty', 'The file is empty.');
  if (bytes.byteLength > cap) return tooLarge(type.kind);
  const hash = await sha256Hex(bytes);
  // Bytes before rows: a blob no row names is harmless, a row naming no blob is a broken image.
  if (!(await env.ASSETS.head(blobKey(hash)))) {
    await env.ASSETS.put(blobKey(hash), bytes, { httpMetadata: { contentType: type.contentType } });
  }
  const asset = await placeAsset(env, folderId, filename, { hash, size: bytes.byteLength, contentType: type.contentType }, createdBy);
  return asset ? placed(asset) : refuse(409, 'name-taken', 'Too many files share that name here. Rename the file and try again.');
}

async function uploadToDoc(request: Request, env: AssetsEnv, docId: string): Promise<Response> {
  const principal = await resolvePrincipal(request, env);
  if (!principal) return notFound();
  const access = await resolveDocAccess(createDb(env.DB), principal, docId, shareTokenOf(request));
  if (!access || access.deleted) return notFound();
  if (!roleAtLeast(access.role, 'editor')) return refuse(403, 'forbidden', 'You can view this note but not add media to it.');
  return store(request, env, access.folderId, principal.id);
}

async function uploadToFolder(request: Request, env: AssetsEnv, folderId: string): Promise<Response> {
  const principal = await resolvePrincipal(request, env);
  if (!principal) return notFound();
  const folder = await resolveFolderAccess(createDb(env.DB), principal, folderId);
  if (!folder || folder.deleted) return notFound();
  if (!roleAtLeast(folder.role, 'editor')) return refuse(403, 'forbidden', 'You can view this folder but not add media to it.');
  return store(request, env, folderId, principal.id);
}

/** moss's copyFromNoteAsset: the source's file, named in the target's folder (the same asset when they share one). */
async function copyFromNote(request: Request, env: AssetsEnv, docId: string): Promise<Response> {
  const principal = await resolvePrincipal(request, env);
  if (!principal) return notFound();
  const db = createDb(env.DB);
  const body = await readJsonObject(request);
  const sourceId = typeof body?.sourceNoteId === 'string' ? body.sourceNoteId : '';
  const filename = typeof body?.sourceRelativePath === 'string' ? storedName(body.sourceRelativePath) : null;
  if (!sourceId || !filename) return refuse(400, 'bad-request', 'Name the note and the file to copy.');
  const token = shareTokenOf(request);
  const [target, source] = await Promise.all([resolveDocAccess(db, principal, docId, token), resolveDocAccess(db, principal, sourceId, token)]);
  if (!target || target.deleted || !source || source.deleted) return notFound();
  if (!roleAtLeast(target.role, 'editor')) return refuse(403, 'forbidden', 'You can view this note but not add media to it.');
  const found = await currentAsset(db, source.folderId, filename);
  if (!found) return notFound();
  const asset = await placeAsset(env, target.folderId, filename, { hash: found.contentHash, size: found.size, contentType: found.contentType }, principal.id);
  return asset ? placed(asset) : refuse(409, 'name-taken', 'Too many files share that name here. Rename the file and try again.');
}

/** `bytes=a-b`, `bytes=a-` or `bytes=-n` against `size`; null when absent or not one range, 'unsatisfiable' past the end. */
export function parseRange(header: string | null, size: number): { offset: number; length: number } | 'unsatisfiable' | null {
  const match = header ? /^bytes=(\d*)-(\d*)$/.exec(header.trim()) : null;
  if (!match || (match[1] === '' && match[2] === '')) return null;
  if (match[1] === '') {
    const suffix = Math.min(Number(match[2]), size);
    return suffix === 0 ? 'unsatisfiable' : { offset: size - suffix, length: suffix };
  }
  const start = Number(match[1]);
  const end = match[2] === '' ? size - 1 : Math.min(Number(match[2]), size - 1);
  if (start >= size || end < start) return 'unsatisfiable';
  return { offset: start, length: end - start + 1 };
}

async function serve(request: Request, env: AssetsEnv, docId: string, rawName: string): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') return json({ error: 'method-not-allowed' }, 405, { allow: 'GET, HEAD' });
  const principal = await resolvePrincipal(request, env);
  if (!principal) return notFound();
  const db = createDb(env.DB);
  const access = await resolveDocAccess(db, principal, docId, shareTokenOf(request));
  if (!access || access.deleted) return notFound();
  let filename: string | null = null;
  try {
    filename = storedName(decodeURIComponent(rawName));
  } catch {
    return notFound();
  }
  const current = filename ? await currentAsset(db, access.folderId, filename) : null;
  if (!current) return notFound();
  const versionId = new URL(request.url).searchParams.get('version');
  let version = { hash: current.contentHash, size: current.size, etag: current.etag };
  if (versionId) {
    const [row] = await db.select({ hash: assetVersions.contentHash, size: assetVersions.size, etag: assetVersions.etag })
      .from(assetVersions).where(and(eq(assetVersions.id, versionId), eq(assetVersions.assetId, current.id))).limit(1);
    if (!row) return notFound();
    version = row;
  }
  const headers = new Headers({
    'content-type': current.contentType,
    'cache-control': versionId ? VERSION_CACHE : CURRENT_CACHE,
    etag: version.etag,
    'accept-ranges': 'bytes',
    'x-content-type-options': 'nosniff',
  });
  // An SVG opened as a page runs nothing and reaches nothing (A§18 user HTML).
  if (current.contentType === 'image/svg+xml') headers.set('content-security-policy', 'sandbox');
  if (request.headers.get('if-none-match') === version.etag) return new Response(null, { status: 304, headers });
  const range = parseRange(request.headers.get('range'), version.size);
  if (range === 'unsatisfiable') {
    headers.set('content-range', `bytes */${version.size}`);
    return new Response(null, { status: 416, headers });
  }
  if (range) headers.set('content-range', `bytes ${range.offset}-${range.offset + range.length - 1}/${version.size}`);
  headers.set('content-length', String(range ? range.length : version.size));
  const status = range ? 206 : 200;
  if (request.method === 'HEAD') return new Response(null, { status, headers });
  const object = await env.ASSETS.get(blobKey(version.hash), range ? { range } : undefined);
  if (!object) return notFound();
  return new Response(object.body, { status, headers });
}

/**
 * A duplicate made outside the source's folder (A§16 "a copied note carries its media"): every source-folder asset
 * the markdown references is named in the target folder too. A name the target already gives other bytes is left
 * as it is, since the copy's markdown cannot be rewritten here.
 */
export async function copyReferencedAssets(env: AssetsEnv, fromFolderId: string, toFolderId: string, markdown: string, createdBy: string): Promise<void> {
  if (fromFolderId === toFolderId) return;
  const names = new Set<string>();
  for (const match of markdown.matchAll(/(?:^|[(<"'\s])\.?\/?assets\/([^)\s>"'?#]+)/g)) {
    try {
      const name = storedName(decodeURIComponent(match[1]));
      if (name) names.add(name);
    } catch {
      // a malformed escape names no file
    }
  }
  if (names.size === 0) return;
  const db = createDb(env.DB);
  const rows = await db.select({ filename: assets.filename }).from(assets)
    .where(and(eq(assets.folderId, fromFolderId), inArray(assets.filename, [...names])));
  for (const { filename } of rows) {
    const found = await currentAsset(db, fromFolderId, filename);
    const there = await currentAsset(db, toFolderId, filename);
    if (!found || there) continue;
    await placeAsset(env, toFolderId, filename, { hash: found.contentHash, size: found.size, contentType: found.contentType }, createdBy);
  }
}

export async function handleAssets(request: Request, env: AssetsEnv): Promise<Response> {
  const { pathname } = new URL(request.url);
  const post = (run: () => Promise<Response>) =>
    request.method === 'POST' ? run() : Promise.resolve(json({ error: 'method-not-allowed' }, 405, { allow: 'POST' }));
  const copy = COPY.exec(pathname);
  if (copy) return post(() => copyFromNote(request, env, copy[1]));
  const doc = DOC_UPLOAD.exec(pathname);
  if (doc) return post(() => uploadToDoc(request, env, doc[1]));
  const folder = FOLDER_UPLOAD.exec(pathname);
  if (folder) return post(() => uploadToFolder(request, env, folder[1]));
  const file = FILE.exec(pathname);
  if (file) return serve(request, env, file[1], file[2]);
  return notFound();
}
