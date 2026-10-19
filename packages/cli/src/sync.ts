// `sync` and `watch` (A§17; PRODUCT ruling 9): glyphdown's tracked-file classification, plus its mirror rules. A
// tracked file is pulled, pushed (the server three-way merges) or both; an untracked `.md` becomes a doc titled
// from its stem and the file takes the doc's filename; a server filename change renames the local file; a local
// delete never reaches the server (the file is pulled again); failed hunks wait in `<file>.rej`. A moss vault note
// goes through the moss interchange path (A§12) and its file stays in moss form. A note's `assets/` media go with it
// (media.ts). `watch` runs the same pass on debounced filesystem events and an idle tick, over REST only.
import { watch as watchFs, type Dirent, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, extname, join, relative } from 'node:path';
import { editsOf, mergeBudget, withoutFinalEol } from '@moss-multi/core/merge';
import { ASSET_DIR } from '@moss-multi/protocol/media';
import type { PushRequest, PushResponse } from '@moss-multi/protocol/push';
import type { Api, DocRow } from './api.ts';
import { CliError, EXIT } from './errors.ts';
import { noteMedia, refNames } from './media.ts';
import { fieldSafe } from './output.ts';
import { hasMarkers, parseMoss, remapMarkers, renderMoss } from './moss-format.ts';
import { evaluateScope, noteUnit, readScope, type ScopeView, titleKey } from './scope.ts';
import {
  confined, type DocMeta, isAllowedName, isWorkspace, localName, lockWorkspace, pinRoot, readBase, readConfined, readMeta, readPriors, recordBase, recordPull, recordSynced,
  renameInside, sameFile, scopedNest, sha256Hex, trackedMetas, writeConfined, writeMeta,
} from './workspace.ts';

export type SyncAction =
  | 'up-to-date' | 'pulled' | 'pushed' | 'merged' | 'suggested' | 'repulled' | 'created' | 'renamed' | 'remote-gone'
  | 'skipped-degenerate' | 'failed' | 'uploaded' | 'downloaded' | 'out-of-scope' | 'follow-only';

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
  /** For `out-of-scope`: how many files the workspace's scope left alone (never their names). */
  count?: number;
}

export interface SyncContext {
  root: string;
  client: Api;
  folds: boolean;
  force: boolean;
  /** Stops the pass (`watch` on Ctrl+C): no write starts after it, and every write already confirmed is recorded. */
  signal?: AbortSignal;
  /** The workspace's scope this pass: a path it does not admit is never read, adopted or written. */
  scope?: ScopeView;
  /** The note is in scope only through `follow`: it is pulled, and nothing of it is sent. */
  downloadOnly?: boolean;
}

/** The pass was stopped before a write; what it recorded so far stands. */
class Stopped extends Error {}

/** Called before every write to the server. */
const beforeWrite = (signal: AbortSignal | undefined) => {
  if (signal?.aborted) throw new Stopped('stopped');
};

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

/** A push that resends its base (the recorded one unless `base` is given) when the server's base cache has lost it. */
export async function pushWithBase(client: Api, root: string, meta: DocMeta, request: PushRequest, signal?: AbortSignal, base?: Uint8Array): Promise<PushResponse> {
  beforeWrite(signal);
  const response = await client.push(meta.docId, request);
  if (response.ok || response.reason !== 'base-missing') return response;
  return client.push(meta.docId, { ...request, baseText: decode(base ?? readBase(root, meta.docId)) });
}

/** The characters core/merge's structural diff deletes and inserts to turn `from` into `to`. */
const distance = (from: string, to: string): number =>
  editsOf(withoutFinalEol(from), withoutFinalEol(to), mergeBudget(), false).reduce((sum, edit) => sum + (edit.end - edit.start) + edit.text.length, 0);

/** Lines `to` has more of than `from`, blank ones aside. */
function addedLines(from: string, to: string): Set<string> {
  const count = new Map<string, number>();
  for (const line of from.split('\n')) count.set(line, (count.get(line) ?? 0) + 1);
  const added = new Set<string>();
  for (const line of to.split('\n')) {
    const left = count.get(line) ?? 0;
    if (left > 0) count.set(line, left - 1);
    else if (line.trim()) added.add(line);
  }
  return added;
}

type PushBase =
  | { kind: 'fresh'; hash: string }
  /** `pulled`: the lines sync wrote in since the prior text, which the push must leave on the doc. */
  | { kind: 'stale'; hash: string; bytes: Uint8Array; pulled: Set<string>; refused?: true }
  /** `again`: the save is, or was typed on, one sync already refused. */
  | { kind: 'unsure'; again?: true };

/**
 * The base a changed file's push merges against. Normally the recorded base; but a file saved by an editor that still
 * held a text from before sync wrote over it (moss rewrites an open note from its editor, T7.P2) descends from that
 * prior text, not from the base: the pulled edits are missing and the prior text plus the typing explains it.
 * Pushed against the base, that save would revert the pulled edits; against the prior text only the typing lands.
 * Of the prior texts kept from the last minute's writes, the one nearest the save that explains it wins. When one of
 * them is no longer kept, or two explain the save equally, its ancestor is unknown: `unsure`, and nothing is pushed.
 */
function pushBase(root: string, meta: DocMeta, local: string): PushBase {
  const fresh: PushBase = { kind: 'fresh', hash: meta.baseHash };
  let savedAt: number;
  try {
    savedAt = lstatSync(join(root, confined(root, meta.file))).mtimeMs;
  } catch {
    return fresh;
  }
  const { priors: all, missing } = readPriors(root, meta, savedAt);
  const priors = all.filter((prior) => prior.hash !== meta.baseHash);
  if (!priors.length && !missing) return fresh;
  // A save sync refused, or whose hunks clashed, never reached the doc whole: saved again, it is no revert.
  if (priors.some((prior) => prior.refused && toLf(decode(prior.bytes)) === local)) return { kind: 'unsure', again: true };
  // moss only saves an editor whose body differs from what it loaded, so exactly a prior text is a deliberate revert.
  if (priors.some((prior) => toLf(decode(prior.bytes)) === local)) return fresh;
  if (missing) return { kind: 'unsure' };
  const base = toLf(decode(readBase(root, meta.docId)));
  let best: PushBase = fresh;
  let nearest = distance(base, local);
  let tied = false;
  for (const prior of priors) {
    const priorText = toLf(decode(prior.bytes));
    // An editor holding the prior text never saw the pulled lines: a save holding one of them came after a reload.
    const pulled = addedLines(priorText, base);
    if ([...addedLines(priorText, local)].some((line) => pulled.has(line))) continue;
    const near = distance(priorText, local);
    if (near < nearest) {
      best = { kind: 'stale', hash: prior.hash, bytes: prior.bytes, pulled, ...(prior.refused ? { refused: true as const } : {}) };
      nearest = near;
      tied = false;
    } else if (near === nearest && best.kind === 'stale') tied = true;
  }
  // An editor still holding a refused save descends from it, and pushed against it the rest of it would land too.
  if (best.kind === 'stale' && best.refused) return { kind: 'unsure', again: true };
  return tied ? { kind: 'unsure' } : best;
}

/** Whether the doc still holds every line the pull brought in after the push: only then does the pulled edit stay. */
const keepsPulled = (base: PushBase, doc: Uint8Array): boolean => {
  if (base.kind !== 'stale') return true;
  const lines = new Set(toLf(decode(doc)).split('\n'));
  return [...base.pulled].every((line) => lines.has(line));
};

const STALE = 'saved over a pulled edit by an editor holding the older text: merged against that text, so the pulled edit stays; to remove it, delete it again and save';
const STALE_LOST = 'saved over a pulled edit by an editor holding the older text: merged against that text, but the doc no longer holds every line the pull brought in; check its history';
const UNSURE = 'saved within a minute of a pulled edit, but the text the editor held is not known for certain (no longer kept, or two kept texts fit), so nothing was pushed';
const AGAIN = 'this save repeats, or adds typing to, a save sync could not push whole in the last minute, so nothing was pushed';
const unsureMessage = (base: { again?: true }) => (base.again ? AGAIN : UNSURE);

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
  // A name outside the scope, or one that would change whether the note is sent, is never taken: the file keeps its name.
  const scope = ctx.scope;
  if (to === meta.file || (scope && (!scope.admits(to) || scope.uploads(to) !== scope.uploads(meta.file)))) {
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
  writeConfined(root, rej, Buffer.from(`${before}${stamp}${hunks.map((hunk) => `${hunk.replace(/(?<!\n)\n*$/, '')}\n`).join('')}`));
  return rej;
}

/** A push's failed hunks: the file has taken the merged doc, and the rejected text waits in `<file>.rej`. */
function rejected(id: { docId: string; file: string }, hunks: string[], rej: string): SyncResult {
  return { ...id, action: 'merged', failedHunks: hunks.length, hunks, message: `${hunks.length} hunk(s) did not apply: the file now holds the doc's text, and your rejected lines are in ${rej}` };
}

const CONFIRM = 'reached only through a followed link, so it is pulled but nothing of it is sent; `moss-multi scope confirm` adds it to allow';
/** A note only `follow` reaches, untracked or with edits here: they wait. */
const heldBack = (id: { docId?: string; file: string }): SyncResult => ({ ...id, action: 'follow-only', message: CONFIRM });

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
  if (localChanged && ctx.downloadOnly) return heldBack(id);
  if (!localChanged && remoteHash === meta.baseHash) return { ...id, action: 'up-to-date' };
  if (!localChanged) {
    recordPull(root, meta.docId, meta.file, remote, localHash, folds, { prior: local });
    return { ...id, action: 'pulled' };
  }
  if (localHash === remoteHash) {
    recordBase(root, meta.docId, meta.file, remote, folds);
    return { ...id, action: 'up-to-date' };
  }
  const newText = toLf(decode(local));
  const base = pushBase(root, meta, newText);
  if (base.kind === 'unsure') {
    // Fail closed: the doc keeps its text, and the save waits whole beside the note.
    const rej = setAside(root, meta.file, [newText]);
    try {
      recordPull(root, meta.docId, meta.file, remote, localHash, folds, { prior: local, refused: true });
    } catch (error) {
      if (!(error instanceof CliError)) throw error;
      return { ...id, action: 'failed', failedHunks: 1, message: `${unsureMessage(base)}; your save is in ${rej}, and the file was edited again, so it was left as it is` };
    }
    return { ...id, action: 'failed', failedHunks: 1, message: `${unsureMessage(base)}: the file now holds the doc's text, and your save is in ${rej}` };
  }
  const response = await pushWithBase(client, root, meta, {
    newText,
    baseHash: base.hash,
    ...(ctx.force ? { force: true } : {}),
  }, ctx.signal, base.kind === 'stale' ? base.bytes : undefined);
  if (!response.ok) return refused(meta, response);
  if (response.mode === 'suggest') return { ...id, action: 'suggested', message: `landed as suggestion ${response.suggestionId}; the file keeps your text` };
  const merged = await client.content(meta.docId, true);
  const action: SyncAction = remoteHash === meta.baseHash && base.kind === 'fresh' ? 'pushed' : 'merged';
  // As glyphdown does, the file and base converge on the doc so web edits keep arriving; rejected text is kept first.
  const rej = response.failedHunks.length ? setAside(root, meta.file, response.failedHunks) : undefined;
  try {
    // The file's text is kept as the prior text: an editor that saved it may save it again over the merged file. With
    // hunks that clashed it never reached the doc whole, so it is refused: never a revert target.
    recordPull(root, meta.docId, meta.file, merged, localHash, folds, { prior: local, refused: response.failedHunks.length > 0 });
  } catch (error) {
    if (!(error instanceof CliError)) throw error;
    // Edited again during the push: the file and its base stay, so the next pass three-way merges the newer text.
    return { ...id, action, ...(response.failedHunks.length ? { failedHunks: response.failedHunks.length, hunks: response.failedHunks } : {}), message: 'edited during the push, so the file was left as it is; the newer edits go on the next pass' };
  }
  if (rej) return rejected(id, response.failedHunks, rej);
  if (!keepsPulled(base, merged)) return { ...id, action: 'failed', message: STALE_LOST };
  return { ...id, action, ...(base.kind === 'stale' ? { message: STALE } : {}) };
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
  if (ctx.downloadOnly && (localChanged || meta.title === undefined)) return heldBack(id);
  let title = row?.title.trim() || meta.title || '';
  let message: string | undefined;
  // Adopted with no title, and the rename to the file's stem never finished: finish it.
  if (meta.title === undefined && !title) {
    beforeWrite(ctx.signal);
    title = (await client.rename(meta.docId, basename(meta.file, extname(meta.file)))).title;
    meta = { ...meta, title };
    writeMeta(root, meta);
    message = `named the doc "${title}"`;
  }
  // A title line edited here renames the doc; one the web renamed is rewritten below.
  if (localChanged && note.title && note.title !== meta.title && note.title !== title) {
    beforeWrite(ctx.signal);
    title = (await client.rename(meta.docId, note.title)).title;
    message = `renamed the doc to "${title}"`;
  }
  const done = (action: SyncAction, extra: Partial<SyncResult> = {}): SyncResult => ({ ...id, action, ...(message ? { message } : {}), ...extra });
  /** The file becomes the doc's `text` in moss form, with the file's markers carried onto it; its body is kept as the prior text. */
  const write = (text: Uint8Array, pushed = false, refused = false) => {
    const rendered = renderMoss(decode(text), title, remapMarkers(note.markers, note.clean, decode(text)));
    // A title-only write leaves the body, and so the prior texts an editor may hold, as they were; a push replaced it.
    const prior = !pushed && sha256Hex(text) === meta.baseHash ? {} : { prior: Buffer.from(note.clean), ...(refused ? { refused } : {}) };
    recordSynced(root, meta.docId, meta.file, Buffer.from(rendered), text, localHash, folds, { title, ...prior });
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
  const base = pushBase(root, meta, note.clean);
  const also = (text: string) => (message ? `${message}; ${text}` : text);
  if (base.kind === 'unsure') {
    // Fail closed: the doc keeps its text, and the save waits whole beside the note.
    const rej = setAside(root, meta.file, [toLf(decode(local))]);
    try {
      write(remote, true, true);
    } catch (error) {
      if (!(error instanceof CliError)) throw error;
      return done('failed', { failedHunks: 1, message: also(`${unsureMessage(base)}; your save is in ${rej}, and the file was edited again, so it was left as it is`) });
    }
    return done('failed', { failedHunks: 1, message: also(`${unsureMessage(base)}: the file now holds the doc's text, and your save is in ${rej}`) });
  }
  const response = await pushWithBase(client, root, meta, {
    newText: note.clean,
    baseHash: base.hash,
    ...(ctx.force ? { force: true } : {}),
  }, ctx.signal, base.kind === 'stale' ? base.bytes : undefined);
  if (!response.ok) return refused(meta, response);
  if (response.mode === 'suggest') return done('suggested', { message: `landed as suggestion ${response.suggestionId}; the file keeps your text` });
  const merged = await client.content(meta.docId, true);
  const kept = keepsPulled(base, merged);
  const action: SyncAction = !kept ? 'failed' : remoteHash === meta.baseHash && base.kind === 'fresh' ? 'pushed' : 'merged';
  if (base.kind === 'stale') message = also(kept ? STALE : STALE_LOST);
  const rej = response.failedHunks.length ? setAside(root, meta.file, response.failedHunks) : undefined;
  try {
    // A save whose hunks clashed never reached the doc whole: its body is kept refused, never a revert target.
    write(merged, true, response.failedHunks.length > 0);
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

type CreatedDoc = Awaited<ReturnType<Api['create']>>['doc'];

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
export async function adopt(ctx: Pick<SyncContext, 'root' | 'client' | 'folds' | 'signal' | 'scope'>, rel: string, options: AdoptOptions = {}): Promise<{ result: SyncResult; doc: CreatedDoc; media: SyncResult[] }> {
  const { refs, ...adopted } = await createFrom(ctx, rel, options);
  // The references in the file as it was read for the create are its user's; one an edit brought in after it is not.
  return { ...adopted, media: (await syncMedia({ ...ctx, force: false }, adopted.doc.id, true, refs)).results };
}

/**
 * The note's media step (media.ts) on the file the doc tracks now. With `settle`, a note whose references moved to the
 * names the server gave its files is pushed at once.
 */
async function syncMedia(ctx: SyncContext, docId: string, settle: boolean, introduced?: Set<string>): Promise<{ results: SyncResult[]; introduced?: Set<string> }> {
  const meta = readMeta(ctx.root, docId);
  if (!meta || !exists(ctx.root, meta.file)) return { results: [] };
  const scope = ctx.scope;
  const scoped = scope ? { denies: scope.denies, reads: scope.admits, sends: (name: string) => scope.sendsAsset(meta.file, join(dirname(meta.file), ASSET_DIR, name)) } : {};
  const step = await noteMedia({ root: ctx.root, client: ctx.client, signal: ctx.signal, folds: ctx.folds, upload: !ctx.downloadOnly, download: true, ...scoped, ...(introduced ? { introduced } : {}) }, docId, meta.file);
  if (settle && step.renames.size > 0) step.results.push(await reconcile(ctx, readMeta(ctx.root, docId) ?? meta, undefined));
  return step;
}

async function createFrom(ctx: Pick<SyncContext, 'root' | 'client' | 'folds' | 'signal' | 'scope'>, rel: string, options: AdoptOptions): Promise<{ result: SyncResult; doc: CreatedDoc; refs: Set<string> }> {
  const { root, client, folds } = ctx;
  const bytes = readConfined(root, rel);
  const text = toLf(decode(bytes));
  const refs = refNames(text);
  const stem = basename(rel, extname(rel));
  const folder = options.folderId ? { folderId: options.folderId } : {};
  if (options.moss ?? isMossNote(rel, text)) {
    const comments = ctx.scope?.denies(join(dirname(rel), 'comments.json')) ? undefined : readSidecar(root, rel);
    beforeWrite(ctx.signal);
    const created = await client.create({ ...(options.title !== undefined ? { title: options.title } : {}), markdown: text, titleLine: true, ...(comments ? { comments } : {}), ...folder });
    let doc = created.doc;
    // Tracked at once, the file as it is, against the created revision's body: a later edit on the server reaches the
    // file through the next pass's three-way reconcile, and nothing failing below can make a second doc. With no
    // title yet, the title is left unrecorded so the next pass finishes the rename below.
    const base = created.content !== undefined ? Buffer.from(created.content) : await client.content(doc.id, true);
    const meta = recordBase(root, doc.id, rel, base, folds, { mode: 'moss', ...(doc.title.trim() ? { title: doc.title } : {}), localHash: sha256Hex(bytes) });
    // A moss note with no title line takes its file's stem; stopped, the next pass finishes the rename.
    if (!doc.title.trim() && !ctx.signal?.aborted) {
      doc = { ...doc, ...(await client.rename(doc.id, stem)) };
      writeMeta(root, { ...meta, title: doc.title });
    }
    return { result: { docId: doc.id, file: rel, action: 'created' }, doc, refs };
  }
  beforeWrite(ctx.signal);
  const { doc } = await client.create({ title: options.title ?? stem, markdown: text, ...(options.titleLine ? { titleLine: true } : {}), ...folder });
  // The doc's filename only when the scope still sends a note there, so a renamed file keeps syncing.
  const named = join(dirname(rel), localName(doc.filename, doc.title));
  const keepName = options.keepName || (ctx.scope !== undefined && !ctx.scope.uploads(named));
  const to = keepName ? rel : named;
  const moved = to !== rel && renameInside(root, rel, to, folds);
  const file = moved ? to : rel;
  // A blocked move records no server name it matches, so a later pass tries the move again.
  const filename = keepName ? {} : { filename: moved || to === rel ? doc.filename : '' };
  // Tracked at once, so nothing failing below can turn this file into a second doc.
  recordBase(root, doc.id, file, bytes, folds, filename);
  const merged = await client.content(doc.id, true);
  try {
    recordPull(root, doc.id, file, merged, sha256Hex(bytes), folds);
  } catch (error) {
    // Edited during the create: the file and the base it was created from stay, and the next pass merges the edit.
    if (!(error instanceof CliError)) throw error;
  }
  return { result: { docId: doc.id, file, ...(file !== rel ? { from: rel } : {}), action: 'created' }, doc, refs };
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

/**
 * The workspace's scope evaluated over its files now, or null when it has none (every note is in scope). A scope file
 * that cannot be read is an error, so nothing syncs past it.
 */
export function workspaceScope(root: string, folds: boolean, files = markdownFiles(root)): ScopeView | null {
  const scope = readScope(root);
  if (!scope) return null;
  return evaluateScope(root, scope, { files, tracked: trackedMetas(root), folds });
}

/** One sync pass over the workspace at `ctx.root`, which must already hold a state directory. */
export async function syncOnce(ctx: SyncContext): Promise<SyncResult[]> {
  const { root } = ctx;
  if (!isWorkspace(root)) throw new CliError(1, `${root} is not a moss-multi workspace`);
  if (ctx.signal?.aborted) return [];
  // Held from classification until every file is recorded, so two passes never adopt one file twice.
  let lock: Awaited<ReturnType<typeof lockWorkspace>>;
  try {
    lock = await lockWorkspace(root, undefined, ctx.signal);
  } catch (error) {
    if (ctx.signal?.aborted) return [];
    throw error;
  }
  try {
    return await pass(ctx, lock.touch);
  } finally {
    lock.release();
  }
}

async function pass(ctx: SyncContext, touch: () => void): Promise<SyncResult[]> {
  const { root, client, folds } = ctx;
  /** Stopped: the rest of the pass is dropped, and what it recorded so far stands. */
  const stopped = (error?: unknown) => error instanceof Stopped || Boolean(ctx.signal?.aborted);
  // A scope file that cannot be read stops the pass before any request.
  readScope(root);
  let listed: DocRow[];
  try {
    listed = await client.listDocs();
  } catch (error) {
    if (stopped(error)) return [];
    throw error;
  }
  // The root as pinned when the command chose it: one swapped during the request is refused before it is scanned.
  pinRoot(root);
  const rows = new Map(listed.map((row) => [row.id, row]));
  const results: SyncResult[] = [];
  let metas = trackedMetas(root);

  const all = markdownFiles(root);
  // With a scope, a file outside it is never read, adopted or written, and a tracked one outside it stops syncing.
  const scope = workspaceScope(root, folds, all) ?? undefined;
  ctx = scope ? { ...ctx, scope } : ctx;
  const admitted = (rel: string) => !scope || scope.admits(rel);
  const files = all.filter(admitted);
  const untracked = files.filter((rel) => !metas.some((meta) => sameFile(meta.file, rel, folds)));
  // A tracked note inside a nested workspace with its own scope is that workspace's to sync: it is never read or written here.
  const nested = new Set(metas.filter((meta) => scopedNest(root, meta.file) !== null).map((meta) => meta.docId));
  const { held, heldFiles } = followLocalRenames(root, metas.filter((meta) => !nested.has(meta.docId) && admitted(meta.file)), untracked, results);
  metas = trackedMetas(root);

  for (const tracked of metas) {
    if (held.has(tracked.docId) || nested.has(tracked.docId) || scopedNest(root, tracked.file) !== null || !admitted(tracked.file)) continue;
    if (stopped()) return results;
    touch();
    try {
      const row = rows.get(tracked.docId);
      const noteCtx = scope && !scope.uploads(tracked.file) ? { ...ctx, downloadOnly: true } : ctx;
      const { meta, result } = followServerName(noteCtx, tracked, row, trackedMetas(root));
      if (result) results.push(result);
      // Media first, so a pushed reference finds its file; a doc no longer listed is left to reconcile to report.
      // The references this user added are read before the pull, so the step after it never uploads one the pull brought.
      const before = row ? await syncMedia(noteCtx, meta.docId, false) : undefined;
      if (before) results.push(...before.results);
      const reconciled = await reconcile(noteCtx, meta, row);
      results.push(reconciled);
      if (reconciled.action !== 'remote-gone') {
        const after = await syncMedia(noteCtx, meta.docId, true, before?.introduced ?? new Set());
        // A refusal the step before the pull already reported is not repeated.
        const said = (result: SyncResult) => before?.results.some((first) => first.file === result.file && first.action === result.action && first.message === result.message);
        results.push(...after.results.filter((result) => !said(result)));
      }
    } catch (error) {
      if (stopped(error)) return results;
      if (error instanceof RateLimited) throw error;
      results.push({ docId: tracked.docId, file: tracked.file, action: 'failed', message: failure(error) });
    }
  }
  for (const rel of untracked) {
    if (heldFiles.has(rel)) continue;
    if (scope && !scope.uploads(rel)) {
      results.push(heldBack({ file: rel }));
      continue;
    }
    if (stopped()) return results;
    touch();
    try {
      const adopted = await adopt(ctx, rel);
      results.push(adopted.result, ...adopted.media);
    } catch (error) {
      if (stopped(error)) return results;
      if (error instanceof CliError && error.status === 429) throw new RateLimited(60);
      results.push({ file: rel, action: 'failed', message: failure(error) });
    }
  }
  if (scope) {
    try {
      await fetchReached(ctx, listed, results, touch);
    } catch (error) {
      if (stopped(error)) return results;
      throw error;
    }
  }
  const outside = (scope?.outOfScope ?? 0) + nested.size;
  if (outside > 0) results.push({ file: '', action: 'out-of-scope', count: outside });
  return results;
}

/**
 * Pulls the server docs `follow` reaches that no note here holds (T7.P3), so a replica starts from its scope alone and
 * a note another replica made and linked comes down. A doc is pulled only when exactly one doc it can open goes by the
 * link's title, no doc here tracks it, and nothing is at its path; it is download only unless `allow` covers the path.
 * A pulled note may link on within the scope's depth, so this repeats until nothing new comes down.
 */
async function fetchReached(ctx: SyncContext, rows: DocRow[], results: SyncResult[], touch: () => void): Promise<void> {
  const { root, client, folds } = ctx;
  // One round per hop at most: depth is at most 10.
  for (let round = 0; round <= 10; round += 1) {
    const scope = workspaceScope(root, folds);
    if (!scope?.missing.length) return;
    const tracked = new Set(trackedMetas(root).map((meta) => meta.docId));
    let pulled = 0;
    for (const want of scope.missing) {
      const matches = rows.filter((row) => titleKey(row.title) === titleKey(want.title));
      const row = matches.length === 1 ? matches[0]! : undefined;
      if (!row || scope.deniesTitle(row.title) || tracked.has(row.id) || exists(root, want.path) || scopedNest(root, want.path) !== null) continue;
      if (ctx.signal?.aborted) throw new Stopped('stopped');
      touch();
      tracked.add(row.id);
      try {
        const remote = await client.content(row.id);
        const title = row.title.trim();
        // Written only where nothing is: a file that appears meanwhile is left alone.
        if (noteUnit(want.path) !== want.path) {
          recordSynced(root, row.id, want.path, Buffer.from(renderMoss(decode(remote), title, [])), remote, null, folds, { mode: 'moss', title });
        } else recordPull(root, row.id, want.path, remote, null, folds);
      } catch (error) {
        if (error instanceof CliError && error.status === 429) throw new RateLimited(60);
        if (!(error instanceof CliError)) throw error;
        results.push({ docId: row.id, file: want.path, action: 'failed', message: failure(error) });
        continue;
      }
      pulled += 1;
      const sends = scope.uploads(want.path);
      const why = `${want.from ? `linked from ${want.from}` : 'named in follow'}${sends ? '' : '; download only until `moss-multi scope confirm` adds it'}`;
      results.push({ docId: row.id, file: want.path, action: 'pulled', message: why });
      const view = workspaceScope(root, folds) ?? scope;
      results.push(...(await syncMedia({ ...ctx, scope: view, downloadOnly: !sends }, row.id, false)).results);
    }
    if (pulled === 0) return;
  }
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
  if (result.action === 'out-of-scope') return `${result.count ?? 0} .md file(s) outside the workspace's scope (.moss-multi/scope.json), or inside a nested workspace with its own scope, were left alone`;
  const name = result.from ? `${result.from} → ${result.file}` : result.file;
  const hunks = (result.hunks ?? []).map((hunk) => `\nfailed hunk:\n${hunk}`).join('');
  // The message may quote the server (a title, a refusal): it stays on its line.
  return `${result.action} ${name}${result.message ? `: ${fieldSafe(result.message)}` : ''}${hunks}`;
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

  let heldBefore = new Set<string>();
  out(`watching ${ctx.root} (syncing on changes and every ${options.intervalMs / 1000} s; Ctrl+C stops)`);
  try {
    while (!signal.aborted) {
      const seen = changes;
      let limitedMs = 0;
      try {
        const held = new Set<string>();
        for (const result of await syncOnce({ ...ctx, signal })) {
          if (result.action === 'failed' || result.action === 'skipped-degenerate' || result.failedHunks) err(describe(result));
          else if (result.action === 'follow-only') {
            // Said once, not every pass, until it changes.
            held.add(result.file);
            if (!heldBefore.has(result.file)) out(describe(result));
          } else if (result.action !== 'up-to-date' && result.action !== 'out-of-scope') out(describe(result));
        }
        heldBefore = held;
      } catch (error) {
        if (error instanceof RateLimited) limitedMs = error.retryAfterSec * 1000;
        err(`sync failed: ${fieldSafe(failure(error))}`);
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
