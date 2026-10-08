// The moss-multi command surface (A§17). `runCli` returns the exit code: 0 clean, 1 other, 2 failed hunks,
// 3 degenerate. Output that is content (`cat`) is written as raw bytes; everything else is one line per record.
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import type { PushRequest, PushResponse } from '@moss-multi/protocol/push';
import { TRASH_COPY, TRASHED_ACTION } from '@moss-multi/protocol/retention';
import { createApi, type Api } from './api.ts';
import { clearCredentials, configPath, deviceLogin, normalizeServer, resolveConfig, writeConfig } from './config.ts';
import { resolveDocId } from './docref.ts';
import { CliError, EXIT } from './errors.ts';
import { confined, findRoot, localName, metaForFile, readBase, readMeta, recordPull, sha256Hex } from './workspace.ts';

export interface ProgramDeps {
  env?: Record<string, string | undefined>;
  cwd?: () => string;
  fetchImpl?: typeof fetch;
  /** Raw stdout: content is written as given, lines carry their own newline. */
  stdout?: (chunk: Uint8Array | string) => void;
  stderr?: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
  openUrl?: (url: string) => void;
}

export const AGENT_KEY_PREFIX = 'mm_sk_';
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
  add <file.md> [--title <t>] [--folder <id>] [--json]
                                               create a doc from a local file; prints its id
  url <doc>                                    the doc's web address
  mv <doc> <new title>                         rename a doc
  rm <doc> [--json]                            move a doc to Trash
  pull <doc> [file] [--force]                  write the doc to a file and track it here
  push <file> [--suggest] [--force]            merge your edits to a pulled file into the doc
  history <doc> [--json]                       the doc's versions
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

/** CRLF becomes LF at the boundary (A§17). */
const toLf = (text: string) => text.replace(/\r\n?/g, '\n');
const decoder = new TextDecoder('utf-8', { fatal: false });

export async function runCli(args: string[], deps: ProgramDeps = {}): Promise<number> {
  const env = deps.env ?? process.env;
  const cwd = deps.cwd ?? (() => process.cwd());
  const fetchImpl = deps.fetchImpl ?? fetch;
  const stdout = deps.stdout ?? ((chunk) => process.stdout.write(chunk));
  const stderr = deps.stderr ?? ((line) => process.stderr.write(`${line}\n`));
  const line = (text: string) => stdout(`${text}\n`);
  const json = (data: unknown) => line(JSON.stringify(data, null, 2));

  const server = (override?: string): string => {
    const url = override ? normalizeServer(override) : resolveConfig(env).serverUrl;
    if (!url) throw new CliError(1, 'no server: set MOSS_MULTI_SERVER or run `moss-multi login --server <url>`');
    if (!/^https?:\/\//i.test(url)) throw new CliError(1, `not a server URL: ${url}`);
    return url;
  };
  const api = (): Api => {
    const config = resolveConfig(env);
    return createApi({ serverUrl: server(), token: config.apiKey ?? config.sessionToken, fetchImpl });
  };
  const docUrl = (client: Api, id: string) => `${client.serverUrl}/d/${encodeURIComponent(id)}`;

  const commands: Record<string, (rest: string[]) => Promise<number | void>> = {
    async login(rest) {
      const parsed = parseArgs(rest, [], ['key', 'server']);
      arity(parsed, 0, 0, 'login [--key <mm_sk_...>] [--server <url>]');
      const serverUrl = server(value(parsed, 'server'));
      const key = value(parsed, 'key');
      if (key !== undefined) {
        if (!key.startsWith(AGENT_KEY_PREFIX)) throw new CliError(1, `an agent key starts with ${AGENT_KEY_PREFIX}; mint one in Settings → Agents`);
        const me = await createApi({ serverUrl, token: key, fetchImpl }).me();
        writeConfig(env, { serverUrl, apiKey: key });
        line(`signed in as agent ${me.name}; key saved to ${configPath(env)}`);
        return;
      }
      const token = await deviceLogin(serverUrl, { fetchImpl, out: line, ...(deps.sleep ? { sleep: deps.sleep } : {}), ...(deps.openUrl ? { openUrl: deps.openUrl } : {}) });
      const me = await createApi({ serverUrl, token, fetchImpl }).me();
      writeConfig(env, { serverUrl, sessionToken: token });
      line(`signed in as ${me.email ?? me.name}; session saved to ${configPath(env)}`);
    },

    async logout(rest) {
      arity(parseArgs(rest, [], []), 0, 0, 'logout');
      const { hadCredentials, sessionToken } = clearCredentials(env);
      const serverUrl = resolveConfig(env).serverUrl;
      if (sessionToken && serverUrl) {
        // Best effort: the stored session is forgotten either way.
        await createApi({ serverUrl, token: sessionToken, fetchImpl }).signOut().catch(() => undefined);
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
      const doc = await client.create({ title, ...(folderId ? { folderId } : {}) });
      if (parsed.flags.has('json')) return json({ ...doc, url: docUrl(client, doc.id) });
      line(doc.id);
    },

    async add(rest) {
      const parsed = parseArgs(rest, ['json'], ['title', 'folder']);
      const [file] = arity(parsed, 1, 1, 'add <file.md> [--title <t>] [--folder <id>] [--json]');
      const path = resolve(cwd(), file);
      if (!existsSync(path)) throw new CliError(1, `no such file: ${file}`);
      const markdown = toLf(decoder.decode(readFileSync(path)));
      const title = value(parsed, 'title') ?? basename(path, extname(path));
      const client = api();
      const folderId = value(parsed, 'folder');
      const doc = await client.create({ title, markdown, ...(folderId ? { folderId } : {}) });
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
      let rel: string;
      if (fileArg !== undefined) rel = confined(root, resolve(cwd(), fileArg));
      else if (tracked) rel = tracked.file;
      else {
        const row = (await client.listDocs()).find((doc) => doc.id === id);
        rel = confined(root, resolve(cwd(), row ? localName(row.filename, row.title) : `${id}.md`));
      }
      const target = join(root, rel);
      if (existsSync(target) && !parsed.flags.has('force')) {
        const owner = metaForFile(root, target);
        if (owner && owner.docId !== id) throw new CliError(1, `${rel} tracks another doc (${owner.docId}); pull into another file or use --force`);
        if (!owner) throw new CliError(1, `${rel} exists and is not tracked; pull into another file or use --force`);
        if (sha256Hex(readFileSync(target)) !== owner.baseHash) throw new CliError(1, `${rel} has local edits; push them first or use --force`);
      }
      const bytes = await client.content(id);
      recordPull(root, id, rel, bytes);
      line(`pulled ${rel} (${bytes.byteLength} bytes)`);
    },

    async push(rest) {
      const parsed = parseArgs(rest, ['suggest', 'force'], []);
      const [fileArg] = arity(parsed, 1, 1, 'push <file> [--suggest] [--force]');
      const path = resolve(cwd(), fileArg);
      if (!existsSync(path)) throw new CliError(1, `no such file: ${fileArg}`);
      const root = findRoot(dirname(path));
      const meta = root ? metaForFile(root, path) : null;
      if (!root || !meta) throw new CliError(1, `${fileArg} is not tracked here: \`moss-multi pull <doc> ${fileArg}\` first`);
      const local = readFileSync(path);
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
        throw new CliError(1, `push refused: ${response.reason}`);
      }
      if (response.mode === 'suggest') {
        line(`suggested ${meta.file} (suggestion ${response.suggestionId})`);
        return;
      }
      if (response.failedHunks.length > 0) {
        for (const hunk of response.failedHunks) stderr(`failed hunk:\n${hunk}`);
        throw new CliError(EXIT.failedHunks, `push partly applied: ${response.failedHunks.length} hunk(s) failed; pull again and re-apply them`);
      }
      // The merged doc becomes the file and the new base.
      const merged = await client.content(meta.docId);
      recordPull(root, meta.docId, meta.file, merged);
      line(`pushed ${meta.file}: ${response.applied} change(s) applied`);
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
    return EXIT.ok;
  } catch (error) {
    if (error instanceof CliError) {
      stderr(`moss-multi: ${error.message}`);
      return error.exitCode;
    }
    stderr(`moss-multi: ${error instanceof Error ? error.message : String(error)}`);
    return EXIT.other;
  }
}

