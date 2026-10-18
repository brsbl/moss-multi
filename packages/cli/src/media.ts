// A note's media (A§16): the `assets/<file>` its markdown references travel with it through the doc's asset routes,
// beside the note file as moss keeps them. The server binds a name in a doc to one set of bytes for good, so a file is
// uploaded under a name the doc does not hold yet, downloaded when it is missing here, and neither side is ever
// overwritten: a name the server stores under another name (another note's file holds it in the folder) moves the
// note's reference to that name, and a local file that differs from the doc's bytes for its name is reported.
import { lstatSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ASSET_DIR, MEDIA_CAP_BYTES, mediaFilename, mediaTypeOf } from '@moss-multi/protocol/media';
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
  /** The name is percent-encoded in the text. */
  encoded: boolean;
}

/**
 * Every `](assets/<file>)` reference to a moss media file in `text` (also `./assets/…` and `<assets/…>`), in order,
 * outside fenced and inline code. The destination runs to its balanced closing parenthesis on the line, as moss reads
 * it, so a name may hold spaces and parentheses.
 */
export function mediaRefs(text: string): MediaRef[] {
  const refs: MediaRef[] = [];
  const code = codeRanges(text);
  for (let at = text.indexOf(']('); at >= 0; at = text.indexOf('](', at + 2)) {
    if (code.some(([from, to]) => at >= from && at < to)) continue;
    let close = -1;
    for (let depth = 1, j = at + 2; j < text.length && text[j] !== '\n'; j += 1) {
      if (text[j] === '\\') j += 1;
      else if (text[j] === '(') depth += 1;
      else if (text[j] === ')' && --depth === 0) {
        close = j;
        break;
      }
    }
    if (close < 0) continue;
    let start = at + 2;
    let end = close;
    while (start < end && /\s/.test(text[start]!)) start += 1;
    while (end > start && /\s/.test(text[end - 1]!)) end -= 1;
    if (text[start] === '<') {
      const gt = text.indexOf('>', start);
      if (gt < 0 || gt > end) continue;
      start += 1;
      end = gt;
    } else {
      const title = /\s+(?:"[^"]*"|'[^']*')$/.exec(text.slice(start, end));
      if (title) end -= title[0].length;
    }
    if (text.startsWith('./', start)) start += 2;
    if (!text.startsWith(ASSET_DIR, start)) continue;
    start += ASSET_DIR.length;
    const raw = text.slice(start, end);
    let name = raw;
    try {
      name = decodeURIComponent(raw);
    } catch {
      // A stray % stays as it is.
    }
    if (mediaTypeOf(name) && isAllowedName(name)) refs.push({ start, end, name, encoded: name !== raw });
  }
  return refs;
}

/** The spans of fenced code blocks and of inline code spans (within a line) in `text`. */
function codeRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  let offset = 0;
  let fence: number | null = null;
  for (const line of text.split('\n')) {
    const end = offset + line.length;
    const fenced = /^\s*(?:```|~~~)/.test(line);
    if (fence !== null) {
      if (fenced) {
        ranges.push([fence, end]);
        fence = null;
      }
    } else if (fenced) fence = offset;
    else {
      const ticks = /`+/g;
      for (let open = ticks.exec(line); open; open = ticks.exec(line)) {
        const closing = new RegExp(`(?<!\`)\`{${open[0].length}}(?!\`)`, 'g');
        closing.lastIndex = open.index + open[0].length;
        const shut = closing.exec(line);
        if (!shut) continue;
        ranges.push([offset + open.index, offset + shut.index + shut[0].length]);
        ticks.lastIndex = shut.index + shut[0].length;
      }
    }
    offset = end + 1;
  }
  if (fence !== null) ranges.push([fence, text.length]);
  return ranges;
}

/** `text` with each reference to a renamed file pointing at its new name. */
export function rewriteRefs(text: string, renames: Map<string, string>): string {
  let out = '';
  let last = 0;
  for (const ref of mediaRefs(text)) {
    const to = renames.get(ref.name);
    if (to === undefined) continue;
    out += text.slice(last, ref.start) + (ref.encoded ? encodeURI(to) : to);
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
  /** Names that failed earlier in this pass: left alone, so a failure is tried and reported once. */
  failedNames?: Set<string>;
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
    if (seen.has(name) || ctx.failedNames?.has(name)) continue;
    seen.add(name);
    const rel = join(dir, name);
    const failed = (message: string) => {
      ctx.failedNames?.add(name);
      results.push({ docId, file: rel, action: 'failed', message });
    };
    try {
      const local = localFile(root, rel);
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
        if (remote !== null && remote !== hash) {
          failed(`${rel} is not the file the doc holds under that name, and a name on the server keeps its file; it was left as it is here and there. Save it under a new name to upload it`);
          continue;
        }
        // A matching record on the server is no proof its bytes are stored (a failed store keeps the record), so a file
        // not recorded here as sent is sent: the same bytes bind the same name again, and the server stores them if missing.
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
        if (mediaFilename(stored) !== stored || mediaTypeOf(stored)?.kind !== type.kind) {
          failed(`the server answered the upload of ${name} with ${JSON.stringify(stored)}, which is not a media file name, so the note still references ${name}`);
          continue;
        }
        // The server folded the name, or another file holds it there: the note follows the name these bytes got.
        const copy = join(dir, stored);
        const there = localFile(root, copy);
        if (there && sha256Hex(readConfined(root, copy)) !== hash) {
          failed(`uploaded as ${stored}, but ${copy} here holds another file, so the note still references ${name}`);
          continue;
        }
        if (!there) writeConfined(root, copy, bytes, null);
        const copied = localFile(root, copy)!;
        record[stored] = { hash, size: copied.size, mtimeMs: copied.mtimeMs };
        renames.set(name, stored);
        results.push({ docId, file: rel, action: 'uploaded', message: mediaFilename(name) === stored
          ? `the server stores ${name} as ${stored}, so the note now references ${copy}`
          : `the server already holds another ${name} here, so it is ${stored} there and the note now references ${copy}` });
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
