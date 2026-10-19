// A note's media (A§16): the `assets/<file>` its markdown references travel with it through the doc's asset routes,
// beside the note file as moss keeps them. The server binds a name in a doc to one set of bytes for good, so a file is
// uploaded under a name the doc does not hold yet, downloaded when it is missing here, and neither side is ever
// overwritten: a name the server stores under another name (another note's file holds it in the folder) moves the
// note's reference to that name, and a local file that differs from the doc's bytes for its name is reported.
// Uploads fail closed (T7.S9): a file goes up only for a reference this machine's user added (in the note's body, under a
// name no text from the server for the doc ever referenced, or in the file as it was adopted) to a file no other note
// in the folder holds or references.
import { type Dirent, lstatSync, readdirSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import { ASSET_DIR, MEDIA_CAP_BYTES, mediaTypeOf } from '@moss-multi/protocol/media';
import type { Api } from './api.ts';
import { CliError } from './errors.ts';
import { parseMoss } from './moss-format.ts';
import type { SyncResult } from './sync.ts';
import {
  confined, isWorkspace, type MediaState, mediaRefs, readConfined, readMediaRecord, readMeta, refNames, servedNames, sha256Hex, trackedMetas, writeConfined,
  writeMediaRecord,
} from './workspace.ts';

export { type MediaRef, mediaRefs, refNames } from './workspace.ts';

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
  /** With a scope, whether another note may be read to see which media it references; one that may not counts as referencing all. */
  reads?: (rel: string) => boolean;
  /** The volume folds case, so names that differ only in case are one file. */
  folds?: boolean;
  /**
   * The references this machine's user added, the only ones that may upload: for a note being adopted, those in the file
   * body as it was read for the create; by default those in the note's body under a name no text from the server for
   * the doc ever referenced (none when that is unknown).
   */
  introduced?: Set<string>;
}

export interface MediaStep {
  results: SyncResult[];
  /** Files the server stored under another name; the note file now references the new names. */
  renames: Map<string, string>;
  /** The references that could upload (by `nameKey`), so a step after a pull does not count the pulled ones as this user's. */
  introduced: Set<string>;
}

/** A media name or folder as the volume compares it: one Unicode form, and one case where the volume folds case. */
const nameKey = (folds: boolean | undefined) => (name: string) => (folds ? name.normalize('NFC').toLowerCase() : name.normalize('NFC'));

/** The body of a moss note, without its frontmatter, title line or markers; the whole text of any other note. */
export const noteBody = (text: string, moss: boolean): string => (moss ? parseMoss(text.replace(/\r\n?/g, '\n')).clean : text);

/**
 * The references in the note's `text` that this machine's user added: those its body holds under a name no text from
 * the server for the doc ever referenced (DocMeta.served). None when that is unknown.
 */
function localRefs(root: string, docId: string, text: string, key: (name: string) => string): Set<string> {
  const meta = readMeta(root, docId);
  const served = meta ? servedNames(root, meta) : null;
  if (!meta || served === null) return new Set();
  const known = new Set([...served].map(key));
  return new Set([...refNames(noteBody(text, meta.mode === 'moss'))].map(key).filter((name) => !known.has(name)));
}

/**
 * Why a file in the assets/ beside the note `file` may be another note's, by name: another tracked doc in that folder
 * holds it in its media record, or another note there references it. A note that cannot be read counts as referencing
 * every name, and so does a folder that cannot be listed. Read once per media step.
 */
function folderOwners(ctx: MediaContext, docId: string, file: string): (name: string) => string | null {
  const { root } = ctx;
  const key = nameKey(ctx.folds);
  const folder = dirname(file);
  const owners = new Map<string, string>();
  let every: string | null = null;
  if (isWorkspace(root)) {
    for (const meta of trackedMetas(root)) {
      if (meta.docId === docId || key(dirname(meta.file)) !== key(folder)) continue;
      for (const held of Object.keys(readMediaRecord(root, meta.docId))) if (!owners.has(key(held))) owners.set(key(held), `${meta.file} also uses it`);
    }
  }
  let entries: Dirent[] = [];
  try {
    entries = readdirSync(join(root, folder), { withFileTypes: true });
  } catch {
    every = `the notes in ${folder === '.' ? 'its folder' : folder} cannot be listed, so another may use it`;
  }
  for (const entry of entries) {
    const rel = join(folder, entry.name);
    if (entry.name === basename(file) || extname(entry.name).toLowerCase() !== '.md') continue;
    const unread = `${rel} cannot be read, so it may use it`;
    if (!entry.isFile() || ctx.denies?.(rel) || (ctx.reads && !ctx.reads(rel))) {
      every ??= unread;
      continue;
    }
    try {
      for (const name of refNames(readConfined(root, rel).toString('utf8'))) if (!owners.has(key(name))) owners.set(key(name), `${rel} also uses it`);
    } catch {
      every ??= unread;
    }
  }
  return (name) => every ?? owners.get(key(name)) ?? null;
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
  const note = confined(root, file);
  const dir = join(dirname(note), ASSET_DIR);
  const seen = new Set<string>();
  const key = nameKey(ctx.folds);
  const introduced = ctx.introduced ? new Set([...ctx.introduced].map(key)) : tracked ? localRefs(root, docId, text, key) : new Set<string>();
  let owners: ((name: string) => string | null) | undefined;

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
        if (!introduced.has(key(name))) {
          failed(`${rel} was not uploaded: the reference to it came from the server or was synced before, so it is only downloaded. Save the file under a new name and reference that to upload it`);
          continue;
        }
        owners ??= folderOwners(ctx, docId, note);
        const owner = owners(name);
        if (owner !== null) {
          failed(`${rel} was not uploaded: ${owner}, and a file in a shared assets folder goes up only for the one note that uses it. Give this note its own copy under a new name`);
          continue;
        }
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
        introduced.add(key(stored));
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
  return { results, renames, introduced };
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
