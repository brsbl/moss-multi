// The moss-multi command surface (A§17). `runCli` returns the exit code: 0 clean, 1 other, 2 failed hunks,
// 3 degenerate. Output that is content (`cat`) is written as raw bytes; everything else is one line per record.
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';
import type { PushRequest, PushResponse } from '@moss-multi/protocol/push';
import { TRASH_COPY, TRASHED_ACTION } from '@moss-multi/protocol/retention';
import { createApi, type Api } from './api.ts';
import { clearCredentials, configPath, deviceLogin, normalizeServer, resolveConfig, writeConfig } from './config.ts';
import { resolveDocId } from './docref.ts';
import { CliError, EXIT } from './errors.ts';
import { jsonSafe, redact, ttySafe } from './output.ts';
import { adopt, describe, readSidecar, syncExitCode, syncOnce, watchLoop } from './sync.ts';
import { confined, ensureStateDir, findRoot, localName, metaForFile, probeFoldsCase, readBase, readConfined, readMeta, recordPull, sha256Hex } from './workspace.ts';

export interface ProgramDeps {
  env?: Record<string, string | undefined>;
  cwd?: () => string;
  fetchImpl?: typeof fetch;
  /** Raw stdout: content is written as given, lines carry their own newline. */
  stdout?: (chunk: Uint8Array | string) => void;
  stderr?: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
  openUrl?: (url: string) => void;
  /** Whether the volume under a workspace root folds case (APFS and NTFS do by default); probed when absent. */
  foldsCase?: (root: string) => boolean;
  /** Stops `watch`; SIGINT and SIGTERM when absent. */
  signal?: AbortSignal;
}

export const AGENT_KEY_PREFIX = 'mm_sk_';
const LOOPBACK = /^(?:localhost|127(?:\.\d{1,3}){3}|\[::1\])$/i;
const ROLES: Record<string, string> = {
  view: 'viewer', viewer: 'viewer', comment: 'commenter', commenter: 'commenter', suggest: 'suggester', suggester: 'suggester',
  edit: 'editor', editor: 'editor',
};

export const USAGE = `moss-multi: pull, push and manage moss-multi notes from a terminal.

  login [--key <mm_sk_...>] [--server <url>]   sign in (device flow in the browser, or an agent key)
  logout                                       forget the stored credentials
  whoami                                       who the CLI acts as
  list [--json]                                the docs you can open
  vaults [--json]                              your vaults
  cat <doc>                                    the doc's markdown, byte for byte
  new <title> [--folder <id>] [--json]         create an empty doc; prints its id
  add <file.md> [--title <t>] [--folder <id>] [--moss] [--json]
                                               create a doc from a local file; prints its id. With --title, a
                                               first line "# <title>" is the title, not a heading. --moss imports
                                               a moss note: its "# Title" line names it, its comments.json comes
                                               too. In a workspace the file is tracked, as sync would
  url <doc>                                    the doc's web address
  mv <doc> <new title>                         rename a doc
  rm <doc> [--json]                            move a doc to Trash
  pull <doc> [file] [--force]                  write the doc to a file and track it here
  push <file> [--suggest] [--force]            merge your edits to a pulled file into the doc
  init [dir]                                   make a folder a workspace, so sync and watch may use it
  sync [dir] [--force] [--json]                pull and push every tracked file; an untracked .md becomes a
                                               doc; deleting a file here never deletes the doc
  watch [dir] [--interval <s>]                 sync on every change and every 60 s, until Ctrl+C
  history <doc> [--json]                       the doc's versions
  comments <doc> [--json]                      the doc's comment threads
  suggestions <doc> [--json]                   the doc's open suggestions
  snapshot <doc> <name>                        save a named version
  comment <doc> <text> (--quote <text> | --reply <comment id>)
  share <doc> <email | agent id> [--role view|comment|suggest|edit]

<doc> is a doc id, its URL, or the start of its title. Credentials: MOSS_MULTI_API_KEY, MOSS_MULTI_SERVER, or the
config file that \`login\` writes. Exit codes: 0 done, 1 error, 2 a push left failed hunks, 3 a push was refused as degenerate.
`;

interface Parsed {
  positionals: string[];
  flags: Map<string, string | true>;
}

/** `--flag value`, `--flag=value` and boolean `--flag`; `--` ends flags. Unknown flags are errors. */
export function parseArgs(args: string[], booleans: string[], values: string[]): Parsed {
  const positionals: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--') {
      positionals.push(...args.slice(i + 1));
      break;
    }
    if (!arg.startsWith('--') || arg === '-') {
      positionals.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    const name = arg.slice(2, eq < 0 ? undefined : eq);
    if (booleans.includes(name)) {
      if (eq >= 0) throw new CliError(1, `--${name} takes no value`);
      flags.set(name, true);
    } else if (values.includes(name)) {
      const value = eq >= 0 ? arg.slice(eq + 1) : args[++i];
      if (value === undefined) throw new CliError(1, `--${name} needs a value`);
      flags.set(name, value);
    } else {
      throw new CliError(1, `unknown option --${name}`);
    }
  }
  return { positionals, flags };
}

const value = (parsed: Parsed, name: string): string | undefined => {
  const flag = parsed.flags.get(name);
  return typeof flag === 'string' ? flag : undefined;
};

function arity(parsed: Parsed, min: number, max: number, usage: string): string[] {
  if (parsed.positionals.length < min || parsed.positionals.length > max) throw new CliError(1, `usage: moss-multi ${usage}`);
  return parsed.positionals;
}

/** Moss's mention encoding (U+2063 `@person:Name` U+2062 id U+2064) as the `@Name` a person reads. */
const readable = (text: string) => text.replace(/\u2063@person:([^\u2062\u2063\u2064]*)\u2062[^\u2062\u2063\u2064]*\u2064/g, '@$1');

/** CRLF becomes LF at the boundary (A§17). */
const toLf = (text: string) => text.replace(/\r\n?/g, '\n');
const decoder = new TextDecoder('utf-8', { fatal: false });

export async function runCli(args: string[], deps: ProgramDeps = {}): Promise<number> {
  const env = deps.env ?? process.env;
  const cwd = deps.cwd ?? (() => process.cwd());
  const fetchImpl = deps.fetchImpl ?? fetch;
  const foldsCase = deps.foldsCase ?? probeFoldsCase;
  const stdout = deps.stdout ?? ((chunk) => process.stdout.write(chunk));
  const rawStderr = deps.stderr ?? ((line) => process.stderr.write(`${line}\n`));
  // Everything but `cat` and the usage text goes through these: credentials redacted, control characters escaped.
  const secrets = new Set<string>();
  const known = resolveConfig(env);
  for (const secret of [known.apiKey, known.sessionToken]) if (secret) secrets.add(secret);
  const line = (text: string) => stdout(`${ttySafe(redact(text, secrets))}\n`);
  const stderr = (text: string) => rawStderr(ttySafe(redact(text, secrets)));
  const json = (data: unknown) => stdout(`${jsonSafe(redact(JSON.stringify(data, null, 2), secrets))}\n`);

  const server = (override?: string): string => {
    const url = override ? normalizeServer(override) : resolveConfig(env).serverUrl;
    if (!url) throw new CliError(1, 'no server: set MOSS_MULTI_SERVER or run `moss-multi login --server <url>`');
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new CliError(1, `not a server URL: ${url}`);
    }
    // Credentials travel in plaintext over http, so it is allowed only to this machine.
    if (parsed.protocol === 'https:' || (parsed.protocol === 'http:' && LOOPBACK.test(parsed.hostname))) return url;
    throw new CliError(1, `not a server URL: ${url}; use https:// (plain http:// is allowed only for localhost)`);
  };
  const api = (): Api => {
    const config = resolveConfig(env);
    return createApi({ serverUrl: server(), token: config.apiKey ?? config.sessionToken, fetchImpl });
  };
  /** A command that finishes with a code other than 0 sets it here (`sync`); a CliError carries its own. */
  let exitCode: number = EXIT.ok;
  const docUrl = (client: Api, id: string) => `${client.serverUrl}/d/${encodeURIComponent(id)}`;
  /**
   * The workspace for `sync` and `watch`: the one holding `dir` (default the working directory). They never make
   * one: a folder becomes a workspace through `init` or `pull`, so a stray `sync` cannot upload a code repository.
   */
  const workspaceAt = (dir?: string): string => {
    const start = resolve(cwd(), dir ?? '.');
    if (!existsSync(start)) throw new CliError(1, `no such directory: ${dir ?? start}`);
    const root = findRoot(start);
    if (!root) throw new CliError(1, `${dir ?? start} is not in a moss-multi workspace; run \`moss-multi init\` in the folder to sync, or \`moss-multi pull <doc>\` there`);
    return root;
  };

  const commands: Record<string, (rest: string[]) => Promise<number | void>> = {
    async login(rest) {
      const parsed = parseArgs(rest, [], ['key', 'server']);
      arity(parsed, 0, 0, 'login [--key <mm_sk_...>] [--server <url>]');
      const serverUrl = server(value(parsed, 'server'));
      const key = value(parsed, 'key');
      if (key) secrets.add(key);
      if (key !== undefined) {
        if (!key.startsWith(AGENT_KEY_PREFIX)) throw new CliError(1, `an agent key starts with ${AGENT_KEY_PREFIX}; mint one in Settings → Agents`);
        const me = await createApi({ serverUrl, token: key, fetchImpl }).me();
        writeConfig(env, { serverUrl, apiKey: key });
        line(`signed in as agent ${me.name}; key saved to ${configPath(env)}`);
        return;
      }
      const token = await deviceLogin(serverUrl, { fetchImpl, out: line, ...(deps.sleep ? { sleep: deps.sleep } : {}), ...(deps.openUrl ? { openUrl: deps.openUrl } : {}) });
      secrets.add(token);
      const me = await createApi({ serverUrl, token, fetchImpl }).me();
      writeConfig(env, { serverUrl, sessionToken: token });
      line(`signed in as ${me.email ?? me.name}; session saved to ${configPath(env)}`);
    },

    async logout(rest) {
      arity(parseArgs(rest, [], []), 0, 0, 'logout');
      const { hadCredentials, sessionToken } = clearCredentials(env);
      const serverUrl = resolveConfig(env).serverUrl;
      if (sessionToken && serverUrl) {
        // The stored session is forgotten either way; say so if the server did not end it.
        const ended = await createApi({ serverUrl, token: sessionToken, fetchImpl }).signOut().catch(() => false);
        if (!ended) stderr(`the server at ${serverUrl} did not confirm the sign-out; the session ends when it expires`);
      }
      line(hadCredentials ? 'signed out' : 'not signed in');
      if (env.MOSS_MULTI_API_KEY) stderr('MOSS_MULTI_API_KEY is still set in your environment');
    },

    async whoami(rest) {
      arity(parseArgs(rest, [], []), 0, 0, 'whoami');
      const me = await api().me();
      line(me.type === 'agent' ? `agent ${me.name} (${me.id})` : `${me.email ?? me.name} (${me.id})`);
    },

    async list(rest) {
      const parsed = parseArgs(rest, ['json'], []);
      arity(parsed, 0, 0, 'list [--json]');
      const docs = await api().listDocs();
      if (parsed.flags.has('json')) return json(docs);
      for (const doc of docs) line(`${doc.id}  ${doc.title.trim() || 'Untitled'}`);
    },

    async vaults(rest) {
      const parsed = parseArgs(rest, ['json'], []);
      arity(parsed, 0, 0, 'vaults [--json]');
      const vaults = await api().listVaults();
      if (parsed.flags.has('json')) return json(vaults);
      for (const vault of vaults) line(`${vault.id}  ${vault.name}${vault.owned ? '' : ` (${vault.role})`}`);
    },

    async cat(rest) {
      const [ref] = arity(parseArgs(rest, [], []), 1, 1, 'cat <doc>');
      const client = api();
      stdout(await client.content(await resolveDocId(client, ref)));
    },

    async new(rest) {
      const parsed = parseArgs(rest, ['json'], ['folder']);
      const [title] = arity(parsed, 1, 1, 'new <title> [--folder <id>] [--json]');
      const client = api();
      const folderId = value(parsed, 'folder');
      const { doc } = await client.create({ title, ...(folderId ? { folderId } : {}) });
      if (parsed.flags.has('json')) return json({ ...doc, url: docUrl(client, doc.id) });
      line(doc.id);
    },

    async add(rest) {
      const parsed = parseArgs(rest, ['json', 'moss'], ['title', 'folder']);
      const [file] = arity(parsed, 1, 1, 'add <file.md> [--title <t>] [--folder <id>] [--moss] [--json]');
      const path = resolve(cwd(), file);
      const workspace = findRoot(cwd());
      const root = workspace ?? cwd();
      const moss = parsed.flags.has('moss');
      const title = value(parsed, 'title');
      const folderId = value(parsed, 'folder');
      const client = api();
      let doc: { id: string; title: string };
      if (workspace) {
        // In a workspace the file is tracked at once, as sync would, so a later sync makes no second doc.
        const rel = confined(workspace, path);
        if (metaForFile(workspace, rel, foldsCase(workspace))) throw new CliError(1, `${rel} is already tracked here; \`moss-multi sync\` sends its edits`);
        ({ doc } = await adopt({ root: workspace, client, folds: foldsCase(workspace) }, rel, {
          moss, keepName: true, ...(title !== undefined ? { title, titleLine: true } : {}), ...(folderId ? { folderId } : {}),
        }));
      } else {
        const markdown = toLf(decoder.decode(readConfined(root, path)));
        const stem = basename(path, extname(path));
        const comments = moss ? readSidecar(root, path) : undefined;
        // A moss note is named by its "# Title" line; any other file by --title or its stem, and only --title lifts a
        // first line that repeats it.
        ({ doc } = await client.create({
          ...(title !== undefined ? { title } : moss ? {} : { title: stem }), markdown, ...(moss || title !== undefined ? { titleLine: true } : {}),
          ...(comments ? { comments } : {}), ...(folderId ? { folderId } : {}),
        }));
        // A moss note with no title line takes its file's stem.
        if (!doc.title.trim()) doc = { ...doc, ...(await client.rename(doc.id, stem)) };
      }
      if (parsed.flags.has('json')) return json({ ...doc, url: docUrl(client, doc.id) });
      line(doc.id);
    },

    async url(rest) {
      const [ref] = arity(parseArgs(rest, [], []), 1, 1, 'url <doc>');
      const client = api();
      line(docUrl(client, await resolveDocId(client, ref)));
    },

    async mv(rest) {
      const [ref, title] = arity(parseArgs(rest, [], []), 2, 2, 'mv <doc> <new title>');
      const client = api();
      const doc = await client.rename(await resolveDocId(client, ref), title);
      line(`renamed to "${doc.title}"`);
    },

    async rm(rest) {
      const parsed = parseArgs(rest, ['json'], []);
      const [ref] = arity(parsed, 1, 1, 'rm <doc> [--json]');
      const client = api();
      const id = await resolveDocId(client, ref);
      await client.trash(id);
      if (parsed.flags.has('json')) return json({ id, ...TRASHED_ACTION });
      line(TRASH_COPY.cliTrashed);
    },

    async pull(rest) {
      const parsed = parseArgs(rest, ['force'], []);
      const [ref, fileArg] = arity(parsed, 1, 2, 'pull <doc> [file] [--force]');
      const client = api();
      const id = await resolveDocId(client, ref);
      const root = findRoot(cwd()) ?? cwd();
      const tracked = readMeta(root, id);
      if (tracked?.mode === 'moss') throw new CliError(1, `${tracked.file} is a moss note kept in moss format; \`moss-multi sync\` pulls and pushes it`);
      let rel: string;
      if (fileArg !== undefined) rel = confined(root, resolve(cwd(), fileArg));
      else if (tracked) rel = confined(root, tracked.file);
      else {
        const row = (await client.listDocs()).find((doc) => doc.id === id);
        rel = confined(root, resolve(cwd(), row ? localName(row.filename, row.title) : `${id}.md`));
      }
      const target = join(root, rel);
      // What the file must still hold when it is replaced: --force replaces anything, otherwise only the base or nothing.
      let expectHash: string | null | undefined;
      if (parsed.flags.has('force')) expectHash = undefined;
      else if (existsSync(target)) {
        const owner = metaForFile(root, target, foldsCase(root));
        if (owner && owner.docId !== id) throw new CliError(1, `${rel} tracks another doc (${owner.docId}); pull into another file or use --force`);
        if (!owner) throw new CliError(1, `${rel} exists and is not tracked; pull into another file or use --force`);
        if (sha256Hex(readConfined(root, rel)) !== owner.baseHash) throw new CliError(1, `${rel} has local edits; push them first or use --force`);
        expectHash = owner.baseHash;
      } else expectHash = null;
      const bytes = await client.content(id);
      recordPull(root, id, rel, bytes, expectHash, foldsCase(root));
      line(`pulled ${rel} (${bytes.byteLength} bytes)`);
    },

    async push(rest) {
      const parsed = parseArgs(rest, ['suggest', 'force'], []);
      const [fileArg] = arity(parsed, 1, 1, 'push <file> [--suggest] [--force]');
      const path = resolve(cwd(), fileArg);
      if (!existsSync(path)) throw new CliError(1, `no such file: ${fileArg}`);
      const root = findRoot(cwd());
      const meta = root ? metaForFile(root, path, foldsCase(root)) : null;
      if (!root || !meta) throw new CliError(1, `${fileArg} is not tracked here: \`moss-multi pull <doc> ${fileArg}\` first`);
      if (meta.mode === 'moss') throw new CliError(1, `${meta.file} is a moss note kept in moss format; \`moss-multi sync\` pulls and pushes it`);
      const local = readConfined(root, path);
      if (sha256Hex(local) === meta.baseHash) {
        line(`${meta.file}: nothing to push`);
        return;
      }
      const client = api();
      const request: PushRequest = {
        newText: toLf(decoder.decode(local)),
        baseHash: meta.baseHash,
        ...(parsed.flags.has('suggest') ? { suggest: true } : {}),
        ...(parsed.flags.has('force') ? { force: true } : {}),
      };
      let response: PushResponse = await client.push(meta.docId, request);
      if (!response.ok && response.reason === 'base-missing') {
        response = await client.push(meta.docId, { ...request, baseText: decoder.decode(readBase(root, meta.docId)) });
      }
      if (!response.ok) {
        if (response.reason === 'degenerate') {
          throw new CliError(EXIT.degenerate, `push refused: it deletes ${Math.round(response.deletedRatio * 100)}% of the doc; pull again, or push with --force`);
        }
        if (response.reason === 'rate-limited') throw new CliError(1, `push refused: rate limited${response.retryAfterSec ? `; try again in ${response.retryAfterSec} s` : ''}`);
        if (response.reason === 'too-large') throw new CliError(1, 'push refused: too large; a note holds at most 2 MB of markdown');
        if (response.reason === 'push-unverified' || response.reason === 'suggest-refused') throw new CliError(1, `push refused: ${response.message}`);
        if (response.reason === 'forbidden') {
          throw new CliError(1, parsed.flags.has('suggest')
            ? 'push refused: you can\'t suggest changes to this doc (it needs suggest access or more)'
            : 'push refused: you can\'t edit this doc (it needs edit access); with suggest access, push with --suggest');
        }
        throw new CliError(1, `push refused: ${response.reason}`);
      }
      if (response.mode === 'suggest') {
        // The doc is unchanged until someone accepts, so the file and its base stay as they are.
        line(`suggested ${meta.file} (suggestion ${response.suggestionId})`);
        const left = response.failedHunks ?? [];
        for (const hunk of left) stderr(`failed hunk:\n${hunk}`);
        if (left.length > 0) throw new CliError(EXIT.failedHunks, `${left.length} hunk(s) could not be placed and are not in the suggestion`);
        return;
      }
      if (response.failedHunks.length > 0) {
        for (const hunk of response.failedHunks) stderr(`failed hunk:\n${hunk}`);
        throw new CliError(EXIT.failedHunks, `push partly applied: ${response.failedHunks.length} hunk(s) failed; pull again and re-apply them`);
      }
      // The merged doc becomes the file and the new base.
      const merged = await client.content(meta.docId);
      try {
        // The file named, which on a volume that folds case may spell the tracked path differently.
        recordPull(root, meta.docId, confined(root, path), merged, sha256Hex(local), foldsCase(root));
      } catch (error) {
        if (!(error instanceof CliError)) throw error;
        throw new CliError(1, `pushed ${meta.file} (${response.applied} change(s) applied), but it was edited during the push, so it was left as it is; push again to send the newer edits`);
      }
      line(`pushed ${meta.file}: ${response.applied} change(s) applied`);
    },

    async init(rest) {
      const parsed = parseArgs(rest, [], []);
      const [dir] = arity(parsed, 0, 1, 'init [dir]');
      const root = resolve(cwd(), dir ?? '.');
      if (!existsSync(root)) throw new CliError(1, `no such directory: ${dir ?? root}`);
      ensureStateDir(root);
      line(`${root} is a moss-multi workspace: \`moss-multi sync\` turns every .md file in it into a doc`);
    },

    async sync(rest) {
      const parsed = parseArgs(rest, ['force', 'json'], []);
      const [dir] = arity(parsed, 0, 1, 'sync [dir] [--force] [--json]');
      const root = workspaceAt(dir);
      const results = await syncOnce({ root, client: api(), folds: foldsCase(root), force: parsed.flags.has('force') });
      if (parsed.flags.has('json')) json(results);
      else {
        for (const result of results) {
          if (result.action === 'failed' || result.action === 'skipped-degenerate' || result.failedHunks) stderr(describe(result));
          else if (result.action !== 'up-to-date') line(describe(result));
        }
        if (results.every((result) => result.action === 'up-to-date')) line('everything is up to date');
      }
      exitCode = syncExitCode(results);
    },

    async watch(rest) {
      const parsed = parseArgs(rest, [], ['interval']);
      const [dir] = arity(parsed, 0, 1, 'watch [dir] [--interval <seconds>]');
      const seconds = Number(value(parsed, 'interval') ?? 60);
      if (!Number.isFinite(seconds) || seconds <= 0) throw new CliError(1, '--interval is a number of seconds above 0');
      const root = workspaceAt(dir);
      const client = api();
      let signal = deps.signal;
      if (!signal) {
        const controller = new AbortController();
        const stop = () => controller.abort();
        process.once('SIGINT', stop);
        process.once('SIGTERM', stop);
        signal = controller.signal;
      }
      await watchLoop({ root, client, folds: foldsCase(root), force: false }, { intervalMs: seconds * 1000, signal, out: line, err: stderr });
    },

    async history(rest) {
      const parsed = parseArgs(rest, ['json'], []);
      const [ref] = arity(parsed, 1, 1, 'history <doc> [--json]');
      const client = api();
      const versions = await client.versions(await resolveDocId(client, ref));
      if (parsed.flags.has('json')) return json(versions);
      for (const version of versions) line(`${version.id}  ${new Date(version.createdAt).toISOString()}  ${version.kind}${version.name ? `  ${version.name}` : ''}`);
    },

    async snapshot(rest) {
      const [ref, name] = arity(parseArgs(rest, [], []), 2, 2, 'snapshot <doc> <name>');
      const client = api();
      const version = await client.snapshot(await resolveDocId(client, ref), name);
      line(version.id);
    },

    async comments(rest) {
      const parsed = parseArgs(rest, ['json'], []);
      const [ref] = arity(parsed, 1, 1, 'comments <doc> [--json]');
      const client = api();
      const comments = await client.comments(await resolveDocId(client, ref));
      if (parsed.flags.has('json')) return json(comments);
      if (comments.length === 0) return line('no comments');
      for (const comment of comments) {
        const state = [comment.resolved ? 'resolved' : '', comment.status === 'orphaned' ? 'detached' : ''].filter(Boolean).join(', ');
        const head = `${comment.parentId ? '  ↳ ' : ''}${comment.id}  ${comment.author.name}${comment.author.type === 'agent' ? ' (agent)' : ''}`;
        line(`${head}: ${readable(comment.text)}${state ? `  (${state})` : ''}`);
        if (!comment.parentId && comment.quote) line(`    on "${comment.quote}"`);
      }
    },

    async suggestions(rest) {
      const parsed = parseArgs(rest, ['json'], []);
      const [ref] = arity(parsed, 1, 1, 'suggestions <doc> [--json]');
      const client = api();
      const suggestions = await client.suggestions(await resolveDocId(client, ref));
      if (parsed.flags.has('json')) return json(suggestions);
      if (suggestions.length === 0) return line('no open suggestions');
      for (const suggestion of suggestions) {
        line(`${suggestion.id}  ${suggestion.author.name}  ${suggestion.status}  ${new Date(suggestion.createdAt).toISOString()}${suggestion.outdated ? '  (outdated)' : ''}`);
      }
    },

    async comment(rest) {
      const parsed = parseArgs(rest, [], ['quote', 'reply']);
      const usage = 'comment <doc> <text> (--quote <text> | --reply <comment id>)';
      const [ref, text] = arity(parsed, 2, 2, usage);
      const quote = value(parsed, 'quote');
      const reply = value(parsed, 'reply');
      if ((quote === undefined) === (reply === undefined)) throw new CliError(1, `usage: moss-multi ${usage}`);
      const client = api();
      const id = randomBytes(12).toString('base64url');
      const comment = await client.comment(await resolveDocId(client, ref), {
        id, text, ...(quote !== undefined ? { anchor: { quote } } : { parentId: reply }),
      });
      line(comment.id);
    },

    async share(rest) {
      const parsed = parseArgs(rest, [], ['role']);
      const [ref, who] = arity(parsed, 2, 2, 'share <doc> <email | agent id> [--role view|comment|suggest|edit]');
      const role = ROLES[value(parsed, 'role') ?? 'view'];
      if (!role) throw new CliError(1, 'the role is view, comment, suggest or edit');
      const client = api();
      const id = await resolveDocId(client, ref);
      await client.share(id, who.includes('@') ? { email: who, role } : { agentId: who, role });
      line(`shared with ${who} as ${role}`);
    },
  };

  const [command, ...rest] = args;
  try {
    if (!command || command === 'help' || command === '--help' || command === '-h') {
      stdout(USAGE);
      return command ? EXIT.ok : EXIT.other;
    }
    const run = Object.hasOwn(commands, command) ? commands[command] : undefined;
    if (!run) throw new CliError(1, `unknown command "${command}"; run \`moss-multi help\``);
    await run(rest);
    return exitCode;
  } catch (error) {
    if (error instanceof CliError) {
      stderr(`moss-multi: ${error.message}`);
      return error.exitCode;
    }
    stderr(`moss-multi: ${error instanceof Error ? error.message : String(error)}`);
    return EXIT.other;
  }
}

