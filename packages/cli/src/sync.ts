// `sync` and `watch` (A§17; PRODUCT ruling 9): glyphdown's tracked-file classification, plus its mirror rules. A
// tracked file is pulled, pushed (the server three-way merges) or both; an untracked `.md` becomes a doc titled
// from its stem and the file takes the doc's filename; a server filename change renames the local file; a local
// delete never reaches the server (the file is pulled again). `watch` runs the same pass on debounced filesystem
// events and an idle tick, over REST only.
import { watch as watchFs, type Dirent, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, extname, join, relative } from 'node:path';
import type { PushRequest, PushResponse } from '@moss-multi/protocol/push';
import type { Api, DocRow } from './api.ts';
import { CliError, EXIT } from './errors.ts';
import {
  confined, type DocMeta, ensureStateDir, isAllowedName, localName, readBase, readConfined, recordBase, recordPull, renameInside,
  sameFile, sha256Hex, trackedMetas, writeMeta,
} from './workspace.ts';

export type SyncAction =
  | 'up-to-date' | 'pulled' | 'pushed' | 'merged' | 'suggested' | 'repulled' | 'created' | 'renamed' | 'remote-gone'
  | 'skipped-degenerate' | 'failed';

export interface SyncResult {
  file: string;
  docId?: string;
  action: SyncAction;
  /** The file's old name, for `renamed` and `created`. */
  from?: string;
  failedHunks?: number;
  message?: string;
}

export interface SyncContext {
  root: string;
  client: Api;
  folds: boolean;
  force: boolean;
}

/** A pass stopped by the server's rate limit; `watch` waits this long before the next one. */
export class RateLimited extends CliError {
  constructor(readonly retryAfterSec: number) {
    super(1, `rate limited: try again in ${retryAfterSec} s`, 429);
  }
}

/** CRLF becomes LF at the boundary (A§17). */
export const toLf = (text: string): string => text.replace(/\r\n?/g, '\n');
const decoder = new TextDecoder('utf-8', { fatal: false });
export const decode = (bytes: Uint8Array): string => decoder.decode(bytes);

/** A push that resends the base when the server's base cache has lost it. */
export async function pushWithBase(client: Api, root: string, meta: DocMeta, request: PushRequest): Promise<PushResponse> {
  const response = await client.push(meta.docId, request);
  if (response.ok || response.reason !== 'base-missing') return response;
  return client.push(meta.docId, { ...request, baseText: decode(readBase(root, meta.docId)) });
}

const isMarkdown = (name: string) => extname(name).toLowerCase() === '.md';

/** Every regular `.md` file below `root`, relative to it: no hidden entries, no links, no names moss refuses. */
function markdownFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith('.') || !isAllowedName(entry.name)) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory() && depth < 8) walk(path, depth + 1);
      else if (entry.isFile() && isMarkdown(entry.name)) out.push(relative(root, path));
    }
  };
  walk(root, 0);
  return out;
}

/** Whether `rel` is a regular file inside the workspace; a link or a path outside it does not count. */
const exists = (root: string, rel: string): boolean => {
  try {
    return lstatSync(join(root, confined(root, rel))).isFile();
  } catch {
    return false;
  }
};

const failure = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** A server refusal of a push, as a result; a rate limit stops the pass. */
function refused(meta: DocMeta, response: Exclude<PushResponse, { ok: true }>): SyncResult {
  const id = { docId: meta.docId, file: meta.file };
  if (response.reason === 'degenerate') {
    return { ...id, action: 'skipped-degenerate', message: `the push deletes ${Math.round(response.deletedRatio * 100)}% of the doc; push it with --force if you mean it` };
  }
  if (response.reason === 'rate-limited') throw new RateLimited(response.retryAfterSec ?? 60);
  if (response.reason === 'push-unverified') return { ...id, action: 'failed', message: response.message };
  return { ...id, action: 'failed', message: `push refused: ${response.reason}` };
}

/** Moves the local file when the server renamed the doc's file since the last sync. */
function followServerName(ctx: SyncContext, meta: DocMeta, row: DocRow | undefined): { meta: DocMeta; result?: SyncResult } {
  if (!row || row.filename.startsWith('pending-')) return { meta };
  if (meta.filename === undefined) {
    // Tracked by `pull`: the server name is learnt now, and only a later change renames the file.
    const next = { ...meta, filename: row.filename };
    writeMeta(ctx.root, next);
    return { meta: next };
  }
  if (meta.filename === row.filename) return { meta };
  const to = join(dirname(meta.file), localName(row.filename, row.title));
  let next: DocMeta = { ...meta, filename: row.filename };
  let result: SyncResult | undefined;
  if (to !== meta.file && exists(ctx.root, meta.file)) {
    if (renameInside(ctx.root, meta.file, to, ctx.folds)) {
      next = { ...next, file: to };
      result = { docId: meta.docId, file: to, from: meta.file, action: 'renamed' };
    } else {
      result = { docId: meta.docId, file: meta.file, action: 'failed', message: `the server renamed it to ${to}, but that name is taken here; left as it is` };
    }
  }
  writeMeta(ctx.root, next);
  return { meta: next, ...(result ? { result } : {}) };
}

/** glyphdown's reconcileTracked: one GET, then pull, push, merge or nothing. */
async function reconcile(ctx: SyncContext, meta: DocMeta): Promise<SyncResult> {
  const { root, client, folds } = ctx;
  const id = { docId: meta.docId, file: meta.file };
  let remote: Uint8Array;
  try {
    remote = await client.content(meta.docId);
  } catch (error) {
    if (error instanceof CliError && error.status === 404) return { ...id, action: 'remote-gone', message: 'the doc is gone or no longer shared with you; the local file is left alone' };
    if (error instanceof CliError && error.status === 429) throw new RateLimited(60);
    throw error;
  }
  const remoteHash = sha256Hex(remote);
  if (!exists(root, meta.file)) {
    // Deletes never propagate: the doc stays and the file comes back.
    recordPull(root, meta.docId, meta.file, remote, null, folds);
    return { ...id, action: 'repulled', message: 'deleted here, so pulled again; delete the doc on the web to remove it' };
  }
  const local = readConfined(root, meta.file);
  const localHash = sha256Hex(local);
  const localChanged = localHash !== meta.baseHash;
  if (!localChanged && remoteHash === meta.baseHash) return { ...id, action: 'up-to-date' };
  if (!localChanged) {
    recordPull(root, meta.docId, meta.file, remote, localHash, folds);
    return { ...id, action: 'pulled' };
  }
  if (localHash === remoteHash) {
    recordBase(root, meta.docId, meta.file, remote, folds);
    return { ...id, action: 'up-to-date' };
  }
  const response = await pushWithBase(client, root, meta, {
    newText: toLf(decode(local)),
    baseHash: meta.baseHash,
    ...(ctx.force ? { force: true } : {}),
  });
  if (!response.ok) return refused(meta, response);
  if (response.mode === 'suggest') return { ...id, action: 'suggested', message: `landed as suggestion ${response.suggestionId}; the file keeps your text` };
  const merged = await client.content(meta.docId);
  const failedHunks = response.failedHunks.length;
  const action: SyncAction = remoteHash === meta.baseHash && failedHunks === 0 ? 'pushed' : 'merged';
  try {
    recordPull(root, meta.docId, meta.file, merged, localHash, folds);
  } catch (error) {
    if (!(error instanceof CliError)) throw error;
    // Edited again during the push: keep the newer text; with the merged base it pushes on the next pass.
    recordBase(root, meta.docId, meta.file, merged, folds);
  }
  return { ...id, action, ...(failedHunks ? { failedHunks, message: `${failedHunks} hunk(s) failed to apply; the file now holds the merged doc` } : {}) };
}

/** An untracked file becomes a doc titled from its stem, and the file takes the doc's filename. */
async function adopt(ctx: SyncContext, rel: string): Promise<SyncResult> {
  const { root, client, folds } = ctx;
  const bytes = readConfined(root, rel);
  const title = basename(rel, extname(rel));
  const doc = await client.create({ title, markdown: toLf(decode(bytes)), titleLine: true });
  const to = join(dirname(rel), localName(doc.filename, doc.title));
  const file = to !== rel && renameInside(root, rel, to, folds) ? to : rel;
  // Tracked at once, so nothing failing below can turn this file into a second doc.
  recordBase(root, doc.id, file, bytes, folds, doc.filename);
  const merged = await client.content(doc.id);
  try {
    recordPull(root, doc.id, file, merged, sha256Hex(bytes), folds, doc.filename);
  } catch (error) {
    if (!(error instanceof CliError)) throw error;
    recordBase(root, doc.id, file, merged, folds, doc.filename);
  }
  return { docId: doc.id, file, ...(file !== rel ? { from: rel } : {}), action: 'created' };
}

/** One sync pass over the workspace at `ctx.root`. */
export async function syncOnce(ctx: SyncContext): Promise<SyncResult[]> {
  const { root, client, folds } = ctx;
  ensureStateDir(root);
  const rows = new Map((await client.listDocs()).map((row) => [row.id, row]));
  const results: SyncResult[] = [];
  let metas = trackedMetas(root);

  // A tracked file that is gone while an untracked file holds its exact base was renamed here: follow it.
  const files = markdownFiles(root);
  const untracked = files.filter((rel) => !metas.some((meta) => sameFile(meta.file, rel, folds)));
  for (const meta of metas) {
    if (exists(root, meta.file)) continue;
    const moved = untracked.find((rel) => sha256Hex(readFileSync(join(root, confined(root, rel)))) === meta.baseHash);
    if (!moved) continue;
    writeMeta(root, { ...meta, file: moved });
    untracked.splice(untracked.indexOf(moved), 1);
    results.push({ docId: meta.docId, file: moved, from: meta.file, action: 'renamed' });
  }
  metas = trackedMetas(root);

  for (const tracked of metas) {
    try {
      const { meta, result } = followServerName(ctx, tracked, rows.get(tracked.docId));
      if (result) results.push(result);
      results.push(await reconcile(ctx, meta));
    } catch (error) {
      if (error instanceof RateLimited) throw error;
      results.push({ docId: tracked.docId, file: tracked.file, action: 'failed', message: failure(error) });
    }
  }
  for (const rel of untracked) {
    try {
      results.push(await adopt(ctx, rel));
    } catch (error) {
      if (error instanceof CliError && error.status === 429) throw new RateLimited(60);
      results.push({ file: rel, action: 'failed', message: failure(error) });
    }
  }
  return results;
}

/** 0 clean, 2 failed hunks, 3 a degenerate push skipped, 1 anything else failed (A§17). */
export function syncExitCode(results: SyncResult[]): number {
  if (results.some((result) => (result.failedHunks ?? 0) > 0)) return EXIT.failedHunks;
  if (results.some((result) => result.action === 'skipped-degenerate')) return EXIT.degenerate;
  if (results.some((result) => result.action === 'failed')) return EXIT.other;
  return EXIT.ok;
}

/** One line per result that did something. */
export function describe(result: SyncResult): string {
  const name = result.from ? `${result.from} → ${result.file}` : result.file;
  return `${result.action} ${name}${result.message ? `: ${result.message}` : ''}`;
}

export interface WatchOptions {
  intervalMs: number;
  signal: AbortSignal;
  out: (line: string) => void;
  err: (line: string) => void;
  debounceMs?: number;
}

/**
 * Runs a pass now, then after every burst of filesystem events (debounced) and every `intervalMs` of quiet, until
 * `signal` aborts. A rate limit waits out its retry-after; a failed pass is reported and retried on the next wake.
 */
export async function watchLoop(ctx: SyncContext, options: WatchOptions): Promise<void> {
  const { signal, out, err } = options;
  const debounceMs = options.debounceMs ?? 300;
  let changes = 0;
  let wake: (() => void) | null = null;
  let debounce: ReturnType<typeof setTimeout> | undefined;
  const poke = () => {
    changes += 1;
    clearTimeout(debounce);
    debounce = setTimeout(() => wake?.(), debounceMs);
  };
  let watcher: ReturnType<typeof watchFs> | null = null;
  try {
    watcher = watchFs(ctx.root, { recursive: true }, (_event, name) => {
      const rel = typeof name === 'string' ? name : '';
      // The state directory and hidden files (our temporary writes among them) are not the user's notes.
      if (rel.split(/[\\/]/).some((part) => part.startsWith('.'))) return;
      poke();
    });
    watcher.on('error', (error) => err(`file watching stopped (${failure(error)}); syncing every ${options.intervalMs / 1000} s`));
  } catch (error) {
    err(`cannot watch ${ctx.root} for changes (${failure(error)}); syncing every ${options.intervalMs / 1000} s`);
  }
  const stopped = new Promise<void>((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener('abort', () => resolve(), { once: true });
  });
  const pause = (ms: number) => new Promise<void>((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      wake = null;
      resolve();
    }
    wake = done;
    void stopped.then(done);
  });

  out(`watching ${ctx.root} (syncing on changes and every ${options.intervalMs / 1000} s; Ctrl+C stops)`);
  try {
    while (!signal.aborted) {
      const seen = changes;
      let waitMs = options.intervalMs;
      try {
        for (const result of await syncOnce(ctx)) {
          if (result.action === 'failed' || result.action === 'skipped-degenerate') err(describe(result));
          else if (result.action !== 'up-to-date') out(describe(result));
        }
      } catch (error) {
        if (error instanceof RateLimited) waitMs = Math.max(waitMs, error.retryAfterSec * 1000);
        err(`sync failed: ${failure(error)}`);
      }
      if (signal.aborted) break;
      if (changes !== seen && waitMs === options.intervalMs) continue;
      await pause(waitMs);
    }
  } finally {
    clearTimeout(debounce);
    watcher?.close();
  }
}
