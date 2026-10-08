// `sync` and `watch` (A§17; PRODUCT ruling 9): glyphdown's tracked-file classification, plus its mirror rules. A
// tracked file is pulled, pushed (the server three-way merges) or both; an untracked `.md` becomes a doc titled
// from its stem and the file takes the doc's filename; a server filename change renames the local file; a local
// delete never reaches the server (the file is pulled again); failed hunks wait in `<file>.rej`. A moss vault note
// goes through the moss interchange path (A§12) and its file stays in moss form. `watch` runs the same pass on debounced filesystem
// events and an idle tick, over REST only.
import { watch as watchFs, type Dirent, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, extname, join, relative } from 'node:path';
import type { PushRequest, PushResponse } from '@moss-multi/protocol/push';
import type { Api, DocRow } from './api.ts';
import { CliError, EXIT } from './errors.ts';
import { hasMarkers, parseMoss, remapMarkers, renderMoss } from './moss-format.ts';
import {
  confined, type DocMeta, isAllowedName, isWorkspace, localName, readBase, readConfined, recordBase, recordPull, recordSynced,
  renameInside, sameFile, sha256Hex, trackedMetas, writeConfined, writeMeta,
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
  /** The text of each failed hunk: the file keeps it, and so does the output. */
  hunks?: string[];
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
/** Directories that are someone else's: installed packages, and another repository or workspace nested inside. */
const isForeign = (path: string, name: string): boolean =>
  name === 'node_modules' || ['.git', '.moss-multi'].some((marker) => {
    try {
      lstatSync(join(path, marker));
      return true;
    } catch {
      return false;
    }
  });

/**
 * Every regular `.md` file below `root`, relative to it: no hidden entries, no links, no names moss refuses, nothing
 * inside node_modules or a nested repository or workspace.
 */
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
      if (entry.isDirectory() && depth < 8 && !isForeign(path, entry.name)) walk(path, depth + 1);
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

/** The file's hash when it was last synced. */
const syncedHash = (meta: DocMeta): string => meta.localHash ?? meta.baseHash;

/**
 * Moves the local file when the server renamed the doc's file since the last sync. The new server name is recorded
 * only once the file has moved, so a move blocked by another file is tried again on the next pass. A moss note keeps
 * moss's own file name.
 */
function followServerName(ctx: SyncContext, meta: DocMeta, row: DocRow | undefined, metas: DocMeta[]): { meta: DocMeta; result?: SyncResult } {
  if (!row || row.filename.startsWith('pending-') || meta.mode === 'moss') return { meta };
  if (meta.filename === undefined) {
    // Tracked by `pull` or `add`: the server name is learnt now, and only a later change renames the file.
    const next = { ...meta, filename: row.filename };
    writeMeta(ctx.root, next);
    return { meta: next };
  }
  if (meta.filename === row.filename) return { meta };
  const to = join(dirname(meta.file), localName(row.filename, row.title));
  if (to === meta.file) {
    const next = { ...meta, filename: row.filename };
    writeMeta(ctx.root, next);
    return { meta: next };
  }
  // A deleted file comes back under its old name first, and moves on the next pass.
  if (!exists(ctx.root, meta.file)) return { meta };
  // A name another tracked doc owns is not taken even when that file is deleted here: it comes back on that doc's pass.
  const owned = metas.some((other) => other.docId !== meta.docId && sameFile(other.file, to, ctx.folds));
  if (owned || !renameInside(ctx.root, meta.file, to, ctx.folds)) {
    return { meta, result: { docId: meta.docId, file: meta.file, action: 'failed', message: `the server renamed it to ${to}, but that name is taken here; left as it is until the name is free` } };
  }
  const next = { ...meta, file: to, filename: row.filename };
  writeMeta(ctx.root, next);
  return { meta: next, result: { docId: meta.docId, file: to, from: meta.file, action: 'renamed' } };
}

/** Keeps failed hunks beside the file in `<file>.rej`, after any kept before. */
function setAside(root: string, file: string, hunks: string[]): string {
  const rej = `${file}.rej`;
  let before = '';
  try {
    before = decode(readConfined(root, rej));
  } catch {
    // None yet.
  }
  const stamp = `--- not applied to the doc, ${new Date().toISOString()}\n`;
  writeConfined(root, rej, Buffer.from(`${before}${stamp}${hunks.map((hunk) => `${hunk.replace(/\n*$/, '')}\n`).join('')}`));
  return rej;
}

/** A push's failed hunks: the file has taken the merged doc, and the rejected text waits in `<file>.rej`. */
function rejected(id: { docId: string; file: string }, hunks: string[], rej: string): SyncResult {
  return { ...id, action: 'merged', failedHunks: hunks.length, hunks, message: `${hunks.length} hunk(s) did not apply: the file now holds the doc's text, and your rejected lines are in ${rej}` };
}

/** glyphdown's reconcileTracked: one GET, then pull, push, merge or nothing. */
async function reconcile(ctx: SyncContext, meta: DocMeta, row: DocRow | undefined): Promise<SyncResult> {
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
    if (meta.mode === 'moss') {
      const title = row?.title.trim() || meta.title || '';
      recordSynced(root, meta.docId, meta.file, Buffer.from(renderMoss(decode(remote), title, [])), remote, null, folds, { title });
    } else recordPull(root, meta.docId, meta.file, remote, null, folds);
    return { ...id, action: 'repulled', message: 'deleted here, so pulled again; delete the doc on the web to remove it' };
  }
  const local = readConfined(root, meta.file);
  if (meta.mode === 'moss') return reconcileMoss(ctx, meta, row, remote, local);
  const localHash = sha256Hex(local);
  const localChanged = localHash !== syncedHash(meta);
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
  const action: SyncAction = remoteHash === meta.baseHash ? 'pushed' : 'merged';
  // As glyphdown does, the file and base converge on the doc so web edits keep arriving; rejected text is kept first.
  const rej = response.failedHunks.length ? setAside(root, meta.file, response.failedHunks) : undefined;
  try {
    recordPull(root, meta.docId, meta.file, merged, localHash, folds);
  } catch (error) {
    if (!(error instanceof CliError)) throw error;
    // Edited again during the push: the file and its base stay, so the next pass three-way merges the newer text.
    return { ...id, action, ...(response.failedHunks.length ? { failedHunks: response.failedHunks.length, hunks: response.failedHunks } : {}), message: 'edited during the push, so the file was left as it is; the newer edits go on the next pass' };
  }
  if (rej) return rejected(id, response.failedHunks, rej);
  return { ...id, action };
}

/**
 * A moss note (A§12 moss interchange): the server holds its clean body, the file keeps moss's form. A changed title
 * line renames the doc and a web rename rewrites it; the markers ride along with the text through every write.
 */
async function reconcileMoss(ctx: SyncContext, meta: DocMeta, row: DocRow | undefined, remote: Uint8Array, local: Uint8Array): Promise<SyncResult> {
  const { root, client, folds } = ctx;
  const id = { docId: meta.docId, file: meta.file };
  const localHash = sha256Hex(local);
  const remoteHash = sha256Hex(remote);
  const note = parseMoss(toLf(decode(local)));
  const localChanged = localHash !== syncedHash(meta);
  let title = row?.title.trim() || meta.title || '';
  let message: string | undefined;
  // A title line edited here renames the doc; one the web renamed is rewritten below.
  if (localChanged && note.title && note.title !== meta.title && note.title !== title) {
    title = (await client.rename(meta.docId, note.title)).title;
    message = `renamed the doc to "${title}"`;
  }
  const done = (action: SyncAction, extra: Partial<SyncResult> = {}): SyncResult => ({ ...id, action, ...(message ? { message } : {}), ...extra });
  /** The file becomes the doc's `text` in moss form, with the file's markers carried onto it. */
  const write = (text: Uint8Array) => {
    const rendered = renderMoss(decode(text), title, remapMarkers(note.markers, note.clean, decode(text)));
    recordSynced(root, meta.docId, meta.file, Buffer.from(rendered), text, localHash, folds, { title });
  };
  if (!localChanged || sha256Hex(note.clean) === meta.baseHash) {
    // Nothing to push: the body here is the base.
    if (remoteHash === meta.baseHash && title === meta.title) {
      if (localChanged) recordBase(root, meta.docId, meta.file, remote, folds, { title, localHash });
      return done(message ? 'pushed' : 'up-to-date');
    }
    write(remote);
    return done('pulled');
  }
  const response = await pushWithBase(client, root, meta, {
    newText: note.clean,
    baseHash: meta.baseHash,
    ...(ctx.force ? { force: true } : {}),
  });
  if (!response.ok) return refused(meta, response);
  if (response.mode === 'suggest') return done('suggested', { message: `landed as suggestion ${response.suggestionId}; the file keeps your text` });
  const merged = await client.content(meta.docId);
  const action: SyncAction = remoteHash === meta.baseHash ? 'pushed' : 'merged';
  const rej = response.failedHunks.length ? setAside(root, meta.file, response.failedHunks) : undefined;
  try {
    write(merged);
  } catch (error) {
    if (!(error instanceof CliError)) throw error;
    return done(action, { ...(response.failedHunks.length ? { failedHunks: response.failedHunks.length, hunks: response.failedHunks } : {}), message: 'edited during the push, so the file was left as it is; the newer edits go on the next pass' });
  }
  if (rej) return rejected(id, response.failedHunks, rej);
  return done(action);
}

/** Whether `rel` is a moss note: moss's `<Title>/<Title>.md` layout, or a body with moss comment markers. */
const isMossNote = (rel: string, text: string): boolean => {
  const dir = dirname(rel);
  return (dir !== '.' && basename(dir) === basename(rel, extname(rel))) || hasMarkers(text);
};

/** moss's comments.json beside a note, if there is one. */
export function readSidecar(root: string, rel: string): Record<string, unknown> | undefined {
  const sidecar = join(dirname(confined(root, rel)), 'comments.json');
  if (!exists(root, sidecar)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(decode(readConfined(root, sidecar)));
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError(1, `${sidecar} is not JSON`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new CliError(1, `${sidecar} is not moss's comments map`);
  return parsed as Record<string, unknown>;
}

type CreatedDoc = Awaited<ReturnType<Api['create']>>;

export interface AdoptOptions {
  /** The doc's title; the file stem when absent. */
  title?: string;
  folderId?: string;
  /** Import as a moss note; sync decides from the file when absent. */
  moss?: boolean;
  /** Ask the server to treat a leading line that is the title as the title line (`add --title`). */
  titleLine?: boolean;
  /** Keep the file's name instead of taking the doc's filename (`add`). */
  keepName?: boolean;
}

/**
 * An untracked file becomes a tracked doc. A plain file is titled from its stem, its body imported as it is (an H1 is
 * content), and the file takes the doc's filename and text. A moss note goes through the moss interchange path: its
 * title line names the doc, its comments.json comes too, and the file is left in moss form.
 */
export async function adopt(ctx: Pick<SyncContext, 'root' | 'client' | 'folds'>, rel: string, options: AdoptOptions = {}): Promise<{ result: SyncResult; doc: CreatedDoc }> {
  const { root, client, folds } = ctx;
  const bytes = readConfined(root, rel);
  const text = toLf(decode(bytes));
  const stem = basename(rel, extname(rel));
  const folder = options.folderId ? { folderId: options.folderId } : {};
  if (options.moss ?? isMossNote(rel, text)) {
    const comments = readSidecar(root, rel);
    let doc = await client.create({ ...(options.title !== undefined ? { title: options.title } : {}), markdown: text, titleLine: true, ...(comments ? { comments } : {}), ...folder });
    // A moss note with no title line takes its file's stem.
    if (!doc.title.trim()) doc = { ...doc, ...(await client.rename(doc.id, stem)) };
    // Tracked at once, the file as it is: the next pass pulls or pushes against the doc's body.
    recordBase(root, doc.id, rel, await client.content(doc.id), folds, { mode: 'moss', title: doc.title, localHash: sha256Hex(bytes) });
    return { result: { docId: doc.id, file: rel, action: 'created' }, doc };
  }
  const doc = await client.create({ title: options.title ?? stem, markdown: text, ...(options.titleLine ? { titleLine: true } : {}), ...folder });
  const to = options.keepName ? rel : join(dirname(rel), localName(doc.filename, doc.title));
  const moved = to !== rel && renameInside(root, rel, to, folds);
  const file = moved ? to : rel;
  // A blocked move records no server name it matches, so a later pass tries the move again.
  const filename = options.keepName ? {} : { filename: moved || to === rel ? doc.filename : '' };
  // Tracked at once, so nothing failing below can turn this file into a second doc.
  recordBase(root, doc.id, file, bytes, folds, filename);
  const merged = await client.content(doc.id);
  try {
    recordPull(root, doc.id, file, merged, sha256Hex(bytes), folds);
  } catch (error) {
    // Edited during the create: the file and the base it was created from stay, and the next pass merges the edit.
    if (!(error instanceof CliError)) throw error;
  }
  return { result: { docId: doc.id, file, ...(file !== rel ? { from: rel } : {}), action: 'created' }, doc };
}

/**
 * Follows files renamed here: a tracked file that is gone while one untracked file holds exactly what it last held.
 * When several gone files held the same text, or several untracked files hold it, which became which is unknowable,
 * so those docs and files are held back and reported rather than guessed.
 */
function followLocalRenames(root: string, metas: DocMeta[], untracked: string[], results: SyncResult[]): { held: Set<string>; heldFiles: Set<string> } {
  const held = new Set<string>();
  const heldFiles = new Set<string>();
  const missing = metas.filter((meta) => !exists(root, meta.file));
  if (missing.length === 0) return { held, heldFiles };
  const hashes = new Map(untracked.map((rel) => [rel, sha256Hex(readFileSync(join(root, confined(root, rel))))]));
  for (const meta of missing) {
    const want = syncedHash(meta);
    const candidates = untracked.filter((rel) => hashes.get(rel) === want);
    if (candidates.length === 0) continue;
    const rivals = missing.filter((other) => syncedHash(other) === want);
    if (candidates.length === 1 && rivals.length === 1) {
      writeMeta(root, { ...meta, file: candidates[0]! });
      untracked.splice(untracked.indexOf(candidates[0]!), 1);
      results.push({ docId: meta.docId, file: candidates[0]!, from: meta.file, action: 'renamed' });
      continue;
    }
    held.add(meta.docId);
    for (const rel of candidates) heldFiles.add(rel);
    results.push({
      docId: meta.docId, file: meta.file, action: 'failed',
      message: `${meta.file} is gone and ${candidates.join(', ')} hold${candidates.length === 1 ? 's' : ''} the same text as ${rivals.length > 1 ? 'other tracked files did' : 'it did'}, so sync cannot tell which file is this doc; rename it back, or \`moss-multi pull\` the doc`,
    });
  }
  return { held, heldFiles };
}

/** One sync pass over the workspace at `ctx.root`, which must already hold a state directory. */
export async function syncOnce(ctx: SyncContext): Promise<SyncResult[]> {
  const { root, client, folds } = ctx;
  if (!isWorkspace(root)) throw new CliError(1, `${root} is not a moss-multi workspace`);
  const rows = new Map((await client.listDocs()).map((row) => [row.id, row]));
  const results: SyncResult[] = [];
  let metas = trackedMetas(root);

  const files = markdownFiles(root);
  const untracked = files.filter((rel) => !metas.some((meta) => sameFile(meta.file, rel, folds)));
  const { held, heldFiles } = followLocalRenames(root, metas, untracked, results);
  metas = trackedMetas(root);

  for (const tracked of metas) {
    if (held.has(tracked.docId)) continue;
    try {
      const row = rows.get(tracked.docId);
      const { meta, result } = followServerName(ctx, tracked, row, trackedMetas(root));
      if (result) results.push(result);
      results.push(await reconcile(ctx, meta, row));
    } catch (error) {
      if (error instanceof RateLimited) throw error;
      results.push({ docId: tracked.docId, file: tracked.file, action: 'failed', message: failure(error) });
    }
  }
  for (const rel of untracked) {
    if (heldFiles.has(rel)) continue;
    try {
      results.push((await adopt(ctx, rel)).result);
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
  const hunks = (result.hunks ?? []).map((hunk) => `\nfailed hunk:\n${hunk}`).join('');
  return `${result.action} ${name}${result.message ? `: ${result.message}` : ''}${hunks}`;
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
  /** Sleeps `ms`; a filesystem event ends it early unless the server asked us to wait. */
  const pause = (ms: number, wakeable: boolean) => new Promise<void>((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      wake = null;
      resolve();
    }
    if (wakeable) wake = done;
    void stopped.then(done);
  });

  out(`watching ${ctx.root} (syncing on changes and every ${options.intervalMs / 1000} s; Ctrl+C stops)`);
  try {
    while (!signal.aborted) {
      const seen = changes;
      let limitedMs = 0;
      try {
        for (const result of await syncOnce(ctx)) {
          if (result.action === 'failed' || result.action === 'skipped-degenerate' || result.failedHunks) err(describe(result));
          else if (result.action !== 'up-to-date') out(describe(result));
        }
      } catch (error) {
        if (error instanceof RateLimited) limitedMs = error.retryAfterSec * 1000;
        err(`sync failed: ${failure(error)}`);
      }
      if (signal.aborted) break;
      if (limitedMs > 0) await pause(limitedMs, false);
      else if (changes === seen) await pause(options.intervalMs, true);
    }
  } finally {
    clearTimeout(debounce);
    watcher?.close();
  }
}
