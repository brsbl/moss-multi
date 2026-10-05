// Assets (A§16): moss's media set, with the bytes content-addressed in R2 (`asset-blobs/sha256/<hash>`) behind
// `content_objects` refcounts and `asset_versions`.
//   POST /api/docs/:id/assets?filename=     raw body into the doc; editor and above on the doc
//   POST /api/docs/:id/assets/copy          {sourceNoteId, sourceRelativePath}: moss's cross-note paste
//   POST /api/docs/:id/assets/from-url      {url, filename?}: a pasted remote image, fetched through the SSRF guard
//   GET|HEAD /api/docs/:id/assets/:file     any reader of the doc, a share link included
// A doc's media are its own record (`doc_media`): each `assets/<file>` it uses, bound to the exact bytes an upload into
// it, a copy from a doc the copier reads, or a duplicate placed there. A read resolves only through that record, never
// by filename in the doc's folder, so writing a name into the note reaches nothing, and a move changes nothing. An
// upload also names its version in the folder's `assets/` namespace, collision-safe, for export and sync.
import { and, eq } from 'drizzle-orm';
import { MEDIA_CAP_BYTES, isDesktopDerived, mediaFilename, mediaTypeOf, suffixedFilename, ASSET_DIR } from '@moss-multi/protocol/media';
import { roleAtLeast } from '@moss-multi/protocol/roles';
import type { AuthEnv } from '../auth/auth.ts';
import { resolvePrincipal, shareTokenOf } from '../auth/principal.ts';
import { createDb, type Db } from '../db/client.ts';
import { assets, assetVersions, docMedia } from '../db/schema.ts';
import type { AppEnv } from '../env.ts';
import { json } from '../worker/route.ts';
import { resolveDocAccess } from './access.ts';
import { readCapped, remoteFetch, REMOTE_TIMEOUT_MS, takeFetchToken } from './remote.ts';
import { NO_STORE, notFound, readJsonObject } from './respond.ts';
import { assertPublicUrl, safeFetch, SsrfBlockedError } from './ssrf.ts';
import { ownerOfTrashed } from './trash.ts';

export type AssetsEnv = AuthEnv & Pick<AppEnv, 'ASSETS' | 'DocDO'> & Partial<Pick<AppEnv, 'PrincipalDO'>>;

export const ASSET_ROUTE = /^\/api\/docs\/[^/]+\/assets(?:\/.*)?$/;
const UPLOAD = /^\/api\/docs\/([^/]+)\/assets$/;
const COPY = /^\/api\/docs\/([^/]+)\/assets\/copy$/;
const FROM_URL = /^\/api\/docs\/([^/]+)\/assets\/from-url$/;
const FILE = /^\/api\/docs\/([^/]+)\/assets\/([^/]+)$/;

const CURRENT_CACHE = 'private, max-age=0, stale-while-revalidate=86400';
const VERSION_CACHE = 'private, max-age=31536000, immutable';
/** An uploaded name is tried with -2, -3, … this many times before the upload gives up. */
const NAME_ATTEMPTS = 50;

const blobKey = (hash: string) => `asset-blobs/sha256/${hash}`;
const etagOf = (hash: string) => `"${hash}"`;
const refuse = (status: number, error: string, message: string) => json({ error, message }, status, NO_STORE);
const tooLarge = (kind: 'image' | 'video') =>
  refuse(413, 'too-large', `${kind === 'image' ? 'Images' : 'Videos'} can be at most ${MEDIA_CAP_BYTES[kind] / (1024 * 1024)} MB.`);
const unsupported = () =>
  refuse(415, 'unsupported-media', 'Only images (png, jpg, gif, webp, svg) and video (mp4, webm, mov) can be uploaded.');
const nameTaken = () => refuse(409, 'name-taken', 'Too many files share that name here. Rename the file and try again.');

async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** The filename a `?filename=` or `assets/<file>` path names, decoded and folded to a stored name. */
const storedName = (raw: string): string | null => mediaFilename(raw.replace(/^\.?\/?(?:assets\/)?/, ''));

/** Immutable bytes: what a doc's record binds a path to. */
interface Bytes { contentHash: string; contentType: string; size: number; versionId: string | null }
type Placed = Bytes & { filename: string; assetId: string | null };

/** The bytes `docId`'s record binds `filename` to, if any. */
async function mediaOf(db: Db, docId: string, filename: string): Promise<Placed | null> {
  const [row] = await db
    .select({ filename: docMedia.filename, contentHash: docMedia.contentHash, contentType: docMedia.contentType, size: docMedia.size,
      versionId: docMedia.versionId, assetId: assetVersions.assetId })
    .from(docMedia)
    .leftJoin(assetVersions, eq(assetVersions.id, docMedia.versionId))
    .where(and(eq(docMedia.docId, docId), eq(docMedia.filename, filename)))
    .limit(1);
  return row ?? null;
}

/** The folder's asset named `filename` and its current version's bytes, if any. */
async function folderAsset(db: Db, folderId: string, filename: string): Promise<{ id: string; versionId: string; contentHash: string } | null> {
  const [row] = await db
    .select({ id: assets.id, versionId: assetVersions.id, contentHash: assetVersions.contentHash })
    .from(assets)
    .innerJoin(assetVersions, eq(assetVersions.id, assets.currentVersionId))
    .where(and(eq(assets.folderId, folderId), eq(assets.filename, filename)))
    .limit(1);
  return row ?? null;
}

const isUnique = (error: unknown) => /UNIQUE|PRIMARY KEY/i.test(`${error} ${(error as { cause?: unknown })?.cause ?? ''}`);

const bindStatement = (env: AuthEnv, docId: string, filename: string, bytes: Bytes, createdBy: string) =>
  env.DB.prepare('INSERT INTO doc_media (doc_id, filename, version_id, content_hash, content_type, size, created_by, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)')
    .bind(docId, filename, bytes.versionId, bytes.contentHash, bytes.contentType, bytes.size, createdBy, Date.now());

/**
 * Binds `bytes` in `docId`'s record under `filename`, or the first `-n` name free there: a name already bound to the
 * same bytes is reused, never rebound. `plan(name)` may refuse a name or add statements to the binding's batch, which
 * fails as a whole when a concurrent writer took the name; the name is then checked again.
 */
async function bind(env: AuthEnv, docId: string, filename: string, bytes: Bytes, createdBy: string,
  plan: (name: string) => Promise<{ bytes: Bytes; statements: D1PreparedStatement[] } | 'taken'>): Promise<Placed | null> {
  const db = createDb(env.DB);
  let attempt = 1;
  for (let tries = 0; attempt <= NAME_ATTEMPTS && tries < NAME_ATTEMPTS * 2; tries += 1) {
    const name = attempt === 1 ? filename : suffixedFilename(filename, attempt);
    const own = await mediaOf(db, docId, name);
    if (own?.contentHash === bytes.contentHash) return own;
    const planned = own ? 'taken' : await plan(name);
    if (planned === 'taken') {
      attempt += 1;
      continue;
    }
    try {
      await env.DB.batch([...planned.statements, bindStatement(env, docId, name, planned.bytes, createdBy)]);
      return (await mediaOf(db, docId, name)) ?? { ...planned.bytes, filename: name, assetId: null };
    } catch (error) {
      if (!isUnique(error)) throw error;
    }
  }
  return null;
}

const placed = (media: Placed) =>
  json({ relativePath: `${ASSET_DIR}${media.filename}`, filename: media.filename,
    asset: { id: media.assetId, versionId: media.versionId, size: media.size } }, 201, NO_STORE);

type MediaType = NonNullable<ReturnType<typeof mediaTypeOf>>;

/** The stored name and type an upload named `raw` takes, or null when it is not moss media. */
function uploadTarget(raw: string): { filename: string; type: MediaType } | null {
  const named = storedName(raw);
  // The web never loads a name moss desktop reserves for its derived thumbnails.
  const filename = named && isDesktopDerived(named) ? mediaFilename(`upload-${named}`) : named;
  const type = filename ? mediaTypeOf(filename) : null;
  return filename && type ? { filename, type } : null;
}

/** The raw body into `docId`, after the caller's right to edit it was checked. */
async function store(request: Request, env: AssetsEnv, docId: string, folderId: string, createdBy: string): Promise<Response> {
  const target = uploadTarget(new URL(request.url).searchParams.get('filename') ?? '');
  if (!target) return unsupported();
  const declared = (request.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  if (declared && declared !== 'application/octet-stream' && declared !== target.type.contentType) return unsupported();
  if (Number(request.headers.get('content-length') ?? 0) > MEDIA_CAP_BYTES[target.type.kind]) return tooLarge(target.type.kind);
  return storeBytes(env, docId, folderId, createdBy, target.filename, target.type, new Uint8Array(await request.arrayBuffer()));
}

/** `bytes` into `docId` under `filename`, or the first `-n` name free there. */
async function storeBytes(env: AssetsEnv, docId: string, folderId: string, createdBy: string, filename: string, type: MediaType,
  bytes: Uint8Array<ArrayBuffer>): Promise<Response> {
  const cap = MEDIA_CAP_BYTES[type.kind];
  if (bytes.byteLength === 0) return refuse(400, 'empty', 'The file is empty.');
  if (bytes.byteLength > cap) return tooLarge(type.kind);
  const hash = await sha256Hex(bytes);
  // Bytes before rows: a blob no row names is harmless, a row naming no blob is a broken image.
  if (!(await env.ASSETS.head(blobKey(hash)))) {
    await env.ASSETS.put(blobKey(hash), bytes, { httpMetadata: { contentType: type.contentType } });
  }
  const db = createDb(env.DB);
  const blob: Bytes = { contentHash: hash, contentType: type.contentType, size: bytes.byteLength, versionId: null };
  // The name is free in the doc's record and in its folder's namespace, or holds these same bytes there.
  const media = await bind(env, docId, filename, blob, createdBy, async (name) => {
    const existing = await folderAsset(db, folderId, name);
    if (existing) return existing.contentHash === hash ? { bytes: { ...blob, versionId: existing.versionId }, statements: [] } : 'taken';
    const id = crypto.randomUUID();
    const versionId = crypto.randomUUID();
    const now = Date.now();
    return {
      bytes: { ...blob, versionId },
      statements: [
        env.DB.prepare('INSERT INTO content_objects (hash, size, refcount) VALUES (?1, ?2, 1) ON CONFLICT(hash) DO UPDATE SET refcount = refcount + 1')
          .bind(hash, blob.size),
        env.DB.prepare('INSERT INTO assets (id, folder_id, filename, kind, content_type, size, current_version_id, created_by, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, ?7, ?8)')
          .bind(id, folderId, name, type.kind, blob.contentType, blob.size, createdBy, now),
        env.DB.prepare('INSERT INTO asset_versions (id, asset_id, content_hash, size, etag, created_by, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)')
          .bind(versionId, id, hash, blob.size, etagOf(hash), createdBy, now),
        env.DB.prepare('UPDATE assets SET current_version_id = ?1 WHERE id = ?2').bind(versionId, id),
      ],
    };
  });
  return media ? placed(media) : nameTaken();
}

async function upload(request: Request, env: AssetsEnv, docId: string): Promise<Response> {
  const principal = await resolvePrincipal(request, env);
  if (!principal) return notFound();
  const access = await resolveDocAccess(createDb(env.DB), principal, docId, shareTokenOf(request));
  if (!access || access.deleted) return notFound();
  if (!roleAtLeast(access.role, 'editor')) return refuse(403, 'forbidden', 'You can view this note but not add media to it.');
  return store(request, env, docId, access.folderId, principal.id);
}

/** moss's copyFromNoteAsset: the bytes the source's record binds the path to, bound in the target's record. */
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
  const found = await mediaOf(db, sourceId, filename);
  if (!found) return notFound();
  const media = await bind(env, docId, filename, found, principal.id, async () => ({ bytes: found, statements: [] }));
  return media ? placed(media) : nameTaken();
}

/**
 * moss's images.persistUrl: a pasted remote image, fetched through the SSRF guard (A§18) and stored as the note's
 * own media, named from the hint or the URL with the extension its served type gives.
 */
async function fromUrl(request: Request, env: AssetsEnv, docId: string): Promise<Response> {
  const principal = await resolvePrincipal(request, env);
  if (!principal) return notFound();
  const access = await resolveDocAccess(createDb(env.DB), principal, docId, shareTokenOf(request));
  if (!access || access.deleted) return notFound();
  if (!roleAtLeast(access.role, 'editor')) return refuse(403, 'forbidden', 'You can view this note but not add media to it.');
  const body = await readJsonObject(request);
  const raw = typeof body?.url === 'string' ? body.url : '';
  if (!raw) return refuse(400, 'bad-request', 'Name the image to save.');
  const blocked = () => refuse(422, 'blocked-url', 'That address can’t be saved.');
  try {
    assertPublicUrl(raw);
  } catch {
    return blocked();
  }
  const throttled = await takeFetchToken(env, principal);
  if (throttled) return throttled;
  const failed = () => refuse(502, 'fetch-failed', 'The image couldn’t be downloaded.');
  let fetched: { response: Response; url: string };
  try {
    fetched = await safeFetch(raw, remoteFetch(), { headers: { accept: 'image/*' }, signal: AbortSignal.timeout(REMOTE_TIMEOUT_MS) });
  } catch (error) {
    return error instanceof SsrfBlockedError ? blocked() : failed();
  }
  const { response } = fetched;
  if (!response.ok) {
    await response.body?.cancel();
    return failed();
  }
  const served = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  const [extension] = Object.entries(MEDIA_TYPES).find(([, type]) => type.kind === 'image' && type.contentType === served) ?? [];
  if (!extension) {
    await response.body?.cancel();
    return unsupported();
  }
  const bytes = await readCapped(response, MEDIA_CAP_BYTES.image);
  if (!bytes) return tooLarge('image');
  const segment = new URL(fetched.url).pathname.split('/').pop() ?? '';
  let hint = typeof body?.filename === 'string' && body.filename.trim() ? body.filename : segment;
  try {
    hint = hint === segment ? decodeURIComponent(segment) : hint;
  } catch {
    // a malformed escape stays as it is and folds like any other character
  }
  const stem = hint.replace(/\.[^./\\]*$/, '') || 'image';
  const target = uploadTarget(`${stem}.${extension}`);
  if (!target) return unsupported();
  return storeBytes(env, docId, access.folderId, principal.id, target.filename, target.type, bytes);
}

/** A duplicate's media (A§16): the source's whole record, bound to the same bytes under the same names. */
export async function copyMedia(d1: D1Database, fromDocId: string, toDocId: string): Promise<void> {
  await d1.prepare(`INSERT INTO doc_media (doc_id, filename, version_id, content_hash, content_type, size, created_by, created_at)
    SELECT ?1, filename, version_id, content_hash, content_type, size, created_by, created_at FROM doc_media WHERE doc_id = ?2`)
    .bind(toDocId, fromDocId).run();
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
  // A trashed note's media show only in its owner's Trash view, through the one owner read path (A§8).
  if (!access || (access.deleted && !(await ownerOfTrashed(db, principal, docId)))) return notFound();
  let filename: string | null;
  try {
    filename = storedName(decodeURIComponent(rawName));
  } catch {
    return notFound();
  }
  const media = filename ? await mediaOf(db, docId, filename) : null;
  if (!media) return notFound();
  // The record names one immutable version; `?version=` pins it in the cache.
  const versionId = new URL(request.url).searchParams.get('version');
  if (versionId && versionId !== media.versionId) return notFound();
  const etag = etagOf(media.contentHash);
  const headers = new Headers({
    'content-type': media.contentType,
    'cache-control': versionId ? VERSION_CACHE : CURRENT_CACHE,
    etag,
    'accept-ranges': 'bytes',
    'x-content-type-options': 'nosniff',
  });
  // An SVG opened as a page runs nothing and reaches nothing (A§18 user HTML).
  if (media.contentType === 'image/svg+xml') headers.set('content-security-policy', 'sandbox');
  if (request.headers.get('if-none-match') === etag) return new Response(null, { status: 304, headers });
  const range = parseRange(request.headers.get('range'), media.size);
  if (range === 'unsatisfiable') {
    headers.set('content-range', `bytes */${media.size}`);
    return new Response(null, { status: 416, headers });
  }
  if (range) headers.set('content-range', `bytes ${range.offset}-${range.offset + range.length - 1}/${media.size}`);
  headers.set('content-length', String(range ? range.length : media.size));
  const status = range ? 206 : 200;
  if (request.method === 'HEAD') return new Response(null, { status, headers });
  const object = await env.ASSETS.get(blobKey(media.contentHash), range ? { range } : undefined);
  if (!object) return notFound();
  return new Response(object.body, { status, headers });
}

export async function handleAssets(request: Request, env: AssetsEnv): Promise<Response> {
  const { pathname } = new URL(request.url);
  const post = (run: () => Promise<Response>) =>
    request.method === 'POST' ? run() : Promise.resolve(json({ error: 'method-not-allowed' }, 405, { allow: 'POST' }));
  const copy = COPY.exec(pathname);
  if (copy) return post(() => copyFromNote(request, env, copy[1]));
  const remote = FROM_URL.exec(pathname);
  if (remote) return post(() => fromUrl(request, env, remote[1]));
  const doc = UPLOAD.exec(pathname);
  if (doc) return post(() => upload(request, env, doc[1]));
  const file = FILE.exec(pathname);
  if (file) return serve(request, env, file[1], file[2]);
  return notFound();
}
