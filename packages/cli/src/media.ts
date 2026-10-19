// A note's media (A§16): the `assets/<file>` its markdown references travel with it through the doc's asset routes,
// beside the note file as moss keeps them. The server binds a name in a doc to one set of bytes for good, so a file is
// uploaded under a name the doc does not hold yet, downloaded when it is missing here, and neither side is ever
// overwritten: a name the server stores under another name (another note's file holds it in the folder) moves the
// note's reference to that name, and a local file that differs from the doc's bytes for its name is reported.
import { lstatSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ASSET_DIR, MEDIA_CAP_BYTES, mediaTypeOf } from '@moss-multi/protocol/media';
import type { Api } from './api.ts';
import { CliError } from './errors.ts';
import type { SyncResult } from './sync.ts';
import {
  confined, isAllowedName, isWorkspace, type MediaState, readConfined, readMediaRecord, sha256Hex, writeConfined, writeMediaRecord,
} from './workspace.ts';

export interface MediaRef {
  /** The span of the reference's file name in the text. */
  start: number;
  end: number;
  name: string;
}

const NAME_END = new Set([' ', '\t', '\n', '\r', ')', '>', '"', "'"]);

/** Every `](assets/<file>)` (or `](./assets/…`, `](<assets/…`) reference to a moss media file in `text`, in order. */
export function mediaRefs(text: string): MediaRef[] {
  const refs: MediaRef[] = [];
  let at = text.indexOf('](');
  while (at >= 0) {
    let i = at + 2;
    if (text[i] === '<') i += 1;
    if (text.startsWith('./', i)) i += 2;
    let next = at + 2;
    if (text.startsWith(ASSET_DIR, i)) {
      const start = i + ASSET_DIR.length;
      let end = start;
      while (end < text.length && !NAME_END.has(text[end]!)) end += 1;
      next = Math.max(next, end);
      let name = text.slice(start, end);
      try {
        name = decodeURIComponent(name);
      } catch {
        // A stray % stays as it is.
      }
      if (mediaTypeOf(name) && isAllowedName(name)) refs.push({ start, end, name });
    }
    at = text.indexOf('](', next);
  }
  return refs;
}

/** `text` with each reference to a renamed file pointing at its new name. */
export function rewriteRefs(text: string, renames: Map<string, string>): string {
  let out = '';
  let last = 0;
  for (const ref of mediaRefs(text)) {
    const to = renames.get(ref.name);
    if (to === undefined) continue;
    out += text.slice(last, ref.start) + to;
    last = ref.end;
  }
  return out + text.slice(last);
}

export interface MediaContext {
  root: string;
  client: Api;
  /** Stops before any upload once aborted. */
  signal?: AbortSignal;
  /** Download what the doc holds and this folder lacks (pull and sync); upload what it lacks (add, push and sync). */
  download?: boolean;
  upload?: boolean;
  /** A file the workspace's scope denies is neither read nor written. */
  denies?: (rel: string) => boolean;
  /** With a scope, whether the local media file `name` may be read and sent; a file it refuses is only ever downloaded when missing. */
  sends?: (name: string) => boolean;
}

export interface MediaStep {
  results: SyncResult[];
  /** Files the server stored under another name; the note file now references the new names. */
  renames: Map<string, string>;
}

const capMessage = (kind: 'image' | 'video') =>
  `${kind === 'image' ? 'Images' : 'Videos'} can be at most ${MEDIA_CAP_BYTES[kind] / (1024 * 1024)} MB, so it was not uploaded`;

const failure = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * The media step for the note `file` of doc `docId`: each media file its text references, beside it under `assets/`,
 * is uploaded, downloaded or left alone, and recorded in a workspace so an unchanged file costs no request next time.
 * A transfer that fails is a `failed` result; a rate limit throws, so the pass stops.
 */
export async function noteMedia(ctx: MediaContext, docId: string, file: string): Promise<MediaStep> {
  const { root, client } = ctx;
  const results: SyncResult[] = [];
  const renames = new Map<string, string>();
  const original = readConfined(root, file);
  const text = original.toString('utf8');
  const tracked = isWorkspace(root);
  const record = tracked ? readMediaRecord(root, docId) : {};
  const before = JSON.stringify(record);
  const dir = join(dirname(confined(root, file)), ASSET_DIR);
  const seen = new Set<string>();

  for (const { name } of mediaRefs(text)) {
    if (seen.has(name)) continue;
    seen.add(name);
    const rel = join(dir, name);
    if (ctx.denies?.(rel)) continue;
    const failed = (message: string) => results.push({ docId, file: rel, action: 'failed', message });
    try {
      const local = localFile(root, rel);
      // A file the scope does not send is never read; only a missing one may come down.
      if (local && ctx.sends && !ctx.sends(name)) continue;
      const known = record[name];
      if (local && known && known.size === local.size && known.mtimeMs === local.mtimeMs) continue;
      const bytes = local ? readConfined(root, rel) : null;
      const hash = bytes ? sha256Hex(bytes) : null;
      const state = (h: string): MediaState => ({ hash: h, size: local?.size ?? 0, mtimeMs: local?.mtimeMs ?? 0 });
      if (hash && known?.hash === hash) {
        record[name] = state(hash);
        continue;
      }
      if (!bytes && !ctx.download) continue;
      const remote = await client.assetHash(docId, name);
      if (bytes && hash) {
        if (remote === hash) {
          record[name] = state(hash);
          continue;
        }
        if (remote !== null) {
          failed(`${rel} is not the file the doc holds under that name, and a name on the server keeps its file; it was left as it is here and there. Save it under a new name to upload it`);
          continue;
        }
        if (!ctx.upload) continue;
        const type = mediaTypeOf(name)!;
        if (bytes.byteLength > MEDIA_CAP_BYTES[type.kind]) {
          failed(capMessage(type.kind));
          continue;
        }
        if (ctx.signal?.aborted) throw new CliError(1, 'stopped');
        const stored = await client.uploadAsset(docId, name, bytes, type.contentType);
        if (stored === name) {
          record[name] = state(hash);
          results.push({ docId, file: rel, action: 'uploaded' });
          continue;
        }
        // Another file holds the name on the server: the note follows the name these bytes got, beside the file.
        const copy = join(dir, stored);
        if (ctx.denies?.(copy)) {
          failed(`uploaded as ${stored}, but the scope denies ${copy}, so the note still references ${name}`);
          continue;
        }
        const there = localFile(root, copy);
        if (there && sha256Hex(readConfined(root, copy)) !== hash) {
          failed(`uploaded as ${stored}, but ${copy} here holds another file, so the note still references ${name}`);
          continue;
        }
        if (!there) writeConfined(root, copy, bytes, null);
        const copied = localFile(root, copy)!;
        record[stored] = { hash, size: copied.size, mtimeMs: copied.mtimeMs };
        renames.set(name, stored);
        results.push({ docId, file: rel, action: 'uploaded', message: `the server already holds another ${name} here, so it is ${stored} there and the note now references ${copy}` });
        continue;
      }
      if (remote === null || !ctx.download) continue;
      const downloaded = await client.asset(docId, name);
      if (remote && sha256Hex(downloaded) !== remote) {
        failed(`the download of ${name} was incomplete; it is tried again on the next sync`);
        continue;
      }
      writeConfined(root, rel, downloaded, null);
      const written = localFile(root, rel)!;
      record[name] = { hash: sha256Hex(downloaded), size: written.size, mtimeMs: written.mtimeMs };
      results.push({ docId, file: rel, action: 'downloaded' });
    } catch (error) {
      if (ctx.signal?.aborted || (error instanceof CliError && error.status === 429)) {
        if (tracked && JSON.stringify(record) !== before) writeMediaRecord(root, docId, record);
        throw error;
      }
      failed(failure(error));
    }
  }
  if (tracked && JSON.stringify(record) !== before) writeMediaRecord(root, docId, record);
  if (renames.size > 0) {
    try {
      writeConfined(root, file, Buffer.from(rewriteRefs(text, renames)), sha256Hex(original));
    } catch (error) {
      if (!(error instanceof CliError)) throw error;
      // Edited meanwhile: the next pass finds the uploaded bytes bound under the new name and moves the references then.
      results.push({ docId, file, action: 'failed', message: `${file} changed during the upload, so its media references were left as they are; the next sync fixes them` });
      renames.clear();
    }
  }
  return { results, renames };
}

/** The size and mtime of a regular file at `rel`, or null when there is none; a link or a path outside is refused. */
function localFile(root: string, rel: string): { size: number; mtimeMs: number } | null {
  const path = join(root, confined(root, rel));
  try {
    const stats = lstatSync(path);
    if (!stats.isFile()) throw new CliError(1, `${rel} is not a file`);
    return { size: stats.size, mtimeMs: stats.mtimeMs };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}
