// The CLI against a fake server (T7.1): raw `cat`, doc references, `url`, `rm` copy and JSON, exit codes, key and
// device sign-in, pull and push state, and the comments and suggestions read commands (T7.3). @p:agt-1
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TRASH_COPY } from '@moss-multi/protocol/retention';
import { parseDocRef } from './docref.ts';
import { runCli, type ProgramDeps } from './program.ts';
import { sha256Hex } from './workspace.ts';

const SERVER = 'http://127.0.0.1:9999';
const KEY = `mm_sk_${'a'.repeat(64)}`;
const ID_A = '11111111-1111-4111-8111-111111111111';
const ID_B = '22222222-2222-4222-8222-222222222222';
const ID_C = '33333333-3333-4333-8333-333333333333';

interface Seen { method: string; host: string; path: string; auth: string | null; origin: string | null; body: unknown }

/** An in-memory moss-multi server: the routes the CLI calls, recording each request. */
function fakeServer() {
  const seen: Seen[] = [];
  const content = new Map<string, Uint8Array>([
    [ID_A, new TextEncoder().encode('# Garden plan\n\nBeans, then peas — é ✓')],
    [ID_B, new TextEncoder().encode('# Garden notes\n\nWater daily.\n')],
    [ID_C, new TextEncoder().encode('# Recipes\n\nSoup.')],
  ]);
  const docs = [
    { id: ID_A, title: 'Garden plan', filename: 'garden-plan.md', folderId: 'f', vaultId: 'v', role: 'owner', updatedAt: 3 },
    { id: ID_B, title: 'Garden notes', filename: 'garden-notes.md', folderId: 'f', vaultId: 'v', role: 'owner', updatedAt: 2 },
    { id: ID_C, title: 'Recipes', filename: 'recipes.md', folderId: 'f', vaultId: 'v', role: 'editor', updatedAt: 1 },
  ];
  const state = {
    token: KEY as string,
    pushes: [] as Record<string, unknown>[],
    pushAnswers: [] as { status: number; body: unknown; headers?: Record<string, string> }[],
    deviceAnswers: [] as { status: number; body: unknown }[],
    /** Runs while a /content request is in flight, before it answers. */
    onContent: null as null | (() => void),
    /** Replaces the device grant's fields. */
    grant: {} as Record<string, unknown>,
    /** Answers this path with a 302 to `to`; a fetch that follows it sends the request there. */
    redirect: null as null | { path: string; to: string },
    /** Answers every authenticated route with this refusal. */
    refuse: null as null | { status: number; body: unknown },
    /** POST /api/docs creates this doc from the body's markdown, as the server would. */
    createNew: null as null | { id: string; filename: string },
    /** What GET .../comments and .../suggestions answer. */
    comments: [] as unknown[],
    suggestions: [] as unknown[],
  };
  const reply = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    new Response(typeof body === 'string' || body instanceof Uint8Array ? body : JSON.stringify(body), { status, headers });
  const fetchImpl = (async (input: string | URL | Request, init: RequestInit = {}) => {
    let url = new URL(String(input));
    const method = init.method ?? 'GET';
    const auth = new Headers(init.headers).get('authorization');
    const body = typeof init.body === 'string' ? JSON.parse(init.body) as unknown : undefined;
    if (state.redirect && url.pathname === state.redirect.path) {
      if (init.redirect === 'manual' || init.redirect === 'error') {
        seen.push({ method, host: url.host, path: url.pathname, auth, origin: new Headers(init.headers).get('origin'), body });
        if (init.redirect === 'error') throw new TypeError('fetch failed: redirect');
        return new Response(null, { status: 302, headers: { location: state.redirect.to } });
      }
      url = new URL(state.redirect.to, url);
    }
    seen.push({ method, host: url.host, path: url.pathname, auth, origin: new Headers(init.headers).get('origin'), body });
    if (url.origin !== SERVER) return reply(200, { docs: [], principal: { type: 'agent', id: 'x', name: 'x' } });
    const path = url.pathname;
    if (path === '/api/auth/device/code') {
      return reply(200, { device_code: 'dev-1', user_code: 'ABCD-EFGH', verification_uri: '/device', verification_uri_complete: '/device?user_code=ABCD-EFGH', expires_in: 900, interval: 5, ...state.grant });
    }
    if (path === '/api/auth/device/token') {
      const next = state.deviceAnswers.shift() ?? { status: 200, body: { access_token: 'session-1' } };
      return reply(next.status, next.body);
    }
    if (path === '/api/auth/sign-out') {
      // The server's auth wrapper refuses an unsafe auth request without an Origin.
      return new Headers(init.headers).get('origin') === url.origin ? reply(200, { success: true }) : reply(403, { code: 'MISSING_OR_NULL_ORIGIN' });
    }
    if (auth !== `Bearer ${state.token}`) return reply(401, { error: 'unauthenticated' });
    if (state.refuse) return reply(state.refuse.status, state.refuse.body);
    if (path === '/api/me') {
      return reply(200, { principal: state.token === KEY ? { type: 'agent', id: 'agent-1', name: 'Scribe' } : { type: 'user', id: 'user-1', name: 'Ada', email: 'ada@example.invalid' } });
    }
    if (path === '/api/docs' && method === 'GET') return reply(200, { docs });
    if (path === '/api/vaults') return reply(200, { vaults: [{ id: 'v', name: 'Home', role: 'owner', owned: true }] });
    if (path === '/api/docs' && method === 'POST' && state.createNew) {
      const { id, filename } = state.createNew;
      const input = body as { title?: string; markdown?: string; titleLine?: boolean };
      // As the server does: markers become anchors, and only with titleLine is a leading "# Title" line the title.
      let title = input.title ?? '';
      let markdown = (input.markdown ?? '').replace(/%%m:[A-Za-z0-9_,\-\s]+?:(?:start|end)%%/g, '');
      const line = input.titleLine ? /^# (.+)\n+/.exec(markdown) : null;
      if (line && (!title || title === line[1])) {
        title = line[1]!;
        markdown = markdown.slice(line[0].length);
      }
      content.set(id, new TextEncoder().encode(markdown));
      docs.push({ id, title, filename, folderId: 'f', vaultId: 'v', role: 'owner', updatedAt: 4 });
      return reply(201, { doc: { id, title, filename, folderId: 'f' }, role: 'owner' });
    }
    if (path === '/api/docs' && method === 'POST') return reply(201, { doc: { id: ID_C, title: (body as { title?: string }).title ?? '', filename: 'x.md', folderId: 'f' }, role: 'owner' });
    const match = /^\/api\/docs\/([^/]+)(?:\/(.+))?$/.exec(path);
    if (!match || !content.has(match[1])) return reply(404, { error: 'not-found' });
    const [, id, sub] = match;
    if (sub === 'content') {
      state.onContent?.();
      return reply(200, content.get(id)!, { 'content-type': 'text/markdown; charset=utf-8' });
    }
    if (!sub && method === 'DELETE') return reply(200, { doc: { id, trashedAt: 1 }, action: 'trashed', restorable: true, retentionDays: 30 });
    if (!sub && method === 'PATCH') {
      const row = docs.find((doc) => doc.id === id);
      if (row) row.title = (body as { title: string }).title;
      return reply(200, { doc: { id, title: (body as { title: string }).title }, role: 'owner' });
    }
    if (sub === 'push') {
      state.pushes.push(body as Record<string, unknown>);
      const next = state.pushAnswers.shift() ?? { status: 200, body: { ok: true, mode: 'edit', applied: 1, failedHunks: [] } };
      // A failed hunk leaves the doc as it was; the fake applies nothing then, nor for a suggestion.
      const answer = next.body as { ok?: boolean; mode?: string; failedHunks?: string[] };
      if (next.status === 200 && answer.ok && answer.mode === 'edit' && !answer.failedHunks?.length) content.set(id, new TextEncoder().encode((body as { newText: string }).newText));
      return reply(next.status, next.body, next.headers);
    }
    if (sub === 'comments' && method === 'GET') return reply(200, { comments: state.comments });
    if (sub === 'suggestions' && method === 'GET') return reply(200, { suggestions: state.suggestions });
    if (sub === 'versions') return reply(200, { versions: [{ id: 'v1', kind: 'named', name: 'First', createdAt: 0, title: 'Garden plan' }] });
    return reply(404, { error: 'not-found' });
  }) as typeof fetch;
  return { fetchImpl, seen, state, content, docs };
}

let dir: string;
let configDir: string;
let server: ReturnType<typeof fakeServer>;
let opened: string[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mm-cli-'));
  configDir = join(dir, 'config');
  server = fakeServer();
  opened = [];
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function cli(args: string[], env: Record<string, string> = { MOSS_MULTI_SERVER: SERVER, MOSS_MULTI_API_KEY: KEY }, extra: Partial<ProgramDeps> = {}) {
  const chunks: Buffer[] = [];
  const errors: string[] = [];
  const code = await runCli(args, {
    ...extra,
    env: { MOSS_MULTI_CONFIG_DIR: configDir, ...env },
    cwd: () => dir,
    fetchImpl: server.fetchImpl,
    stdout: (chunk) => chunks.push(Buffer.from(chunk)),
    stderr: (line) => errors.push(line),
    sleep: async () => undefined,
    openUrl: (url) => opened.push(url),
  });
  const bytes = Buffer.concat(chunks);
  return { code, bytes, out: bytes.toString('utf8'), err: errors.join('\n') };
}

describe('cat', () => {
  it('writes the doc\'s bytes exactly: no trailing LF added, non-ASCII intact', async () => {
    const result = await cli(['cat', ID_A]);
    expect(result.code).toBe(0);
    expect(result.bytes.equals(Buffer.from(server.content.get(ID_A)!))).toBe(true);
    expect(result.out.endsWith('\n')).toBe(false);
  });

  it('keeps a trailing LF the doc has, and adds none', async () => {
    const result = await cli(['cat', ID_B]);
    expect(result.out).toBe('# Garden notes\n\nWater daily.\n');
  });

  it('pulls a 2 MB doc byte for byte', async () => {
    const big = new Uint8Array(2 * 1024 * 1024 - 7).fill(0x61);
    big[big.length - 1] = 0x7a;
    server.content.set(ID_C, big);
    const pulled = await cli(['pull', ID_C, 'big.md']);
    expect(pulled.code).toBe(0);
    expect(Buffer.from(readFileSync(join(dir, 'big.md'))).equals(Buffer.from(big))).toBe(true);
    const cat = await cli(['cat', ID_C]);
    expect(cat.bytes.byteLength).toBe(big.byteLength);
  });
});

describe('doc references', () => {
  it('parses an id, a URL and a title prefix', () => {
    expect(parseDocRef(ID_A)).toEqual({ kind: 'id', id: ID_A });
    expect(parseDocRef(`${SERVER}/d/${ID_A}?share=tok`)).toEqual({ kind: 'id', id: ID_A });
    expect(parseDocRef('Garden p')).toEqual({ kind: 'prefix', prefix: 'Garden p' });
  });

  it('resolves a unique title prefix, case-insensitively', async () => {
    const result = await cli(['cat', 'garden p']);
    expect(result.code).toBe(0);
    expect(result.bytes.equals(Buffer.from(server.content.get(ID_A)!))).toBe(true);
  });

  it('refuses an ambiguous or unknown prefix with exit 1, listing the candidates', async () => {
    const ambiguous = await cli(['cat', 'Garden']);
    expect(ambiguous.code).toBe(1);
    expect(ambiguous.err).toContain(ID_A);
    expect(ambiguous.err).toContain(ID_B);
    expect(ambiguous.bytes.byteLength).toBe(0);
    const unknown = await cli(['cat', 'Nothing like it']);
    expect(unknown.code).toBe(1);
    expect(unknown.err).toContain('no doc');
  });

  it('resolves a URL to its id', async () => {
    const result = await cli(['url', `${SERVER}/d/${ID_B}`]);
    expect(result.out).toBe(`${SERVER}/d/${ID_B}\n`);
  });
});

describe('url, rm and exit codes', () => {
  it('prints /d/<id> for a title prefix', async () => {
    const result = await cli(['url', 'Recipes']);
    expect(result.code).toBe(0);
    expect(result.out).toBe(`${SERVER}/d/${ID_C}\n`);
  });

  it('says where a removed doc went, and emits the trashed action as JSON', async () => {
    const said = await cli(['rm', ID_A]);
    expect(said.code).toBe(0);
    expect(said.out).toBe(`${TRASH_COPY.cliTrashed}\n`);
    expect(said.out).toBe('moved to Trash — you can restore it for 30 days\n');
    expect(server.seen.at(-1)).toMatchObject({ method: 'DELETE', path: `/api/docs/${ID_A}` });
    const asJson = await cli(['rm', ID_B, '--json']);
    expect(JSON.parse(asJson.out)).toEqual({ id: ID_B, action: 'trashed', restorable: true, retentionDays: 30 });
  });

  it('exits 1 with a sign-in hint when the server answers 401, and for an unknown command', async () => {
    const result = await cli(['cat', ID_A], { MOSS_MULTI_SERVER: SERVER, MOSS_MULTI_API_KEY: `mm_sk_${'b'.repeat(64)}` });
    expect(result.code).toBe(1);
    expect(result.err).toContain('moss-multi login');
    expect((await cli(['frobnicate'])).code).toBe(1);
  });

  it('exits 1 on a missing doc, and with no server configured', async () => {
    const missing = await cli(['cat', '44444444-4444-4444-8444-444444444444']);
    expect(missing.code).toBe(1);
    expect(missing.err).toContain('not found');
    expect((await cli(['list'], {})).err).toContain('MOSS_MULTI_SERVER');
  });
});

describe('sign-in', () => {
  it('login --key checks the key, then stores it at mode 0600 and uses it as the bearer', async () => {
    const result = await cli(['login', '--key', KEY, '--server', `${SERVER}/`], {});
    expect(result.code).toBe(0);
    expect(result.out).toContain('agent Scribe');
    const path = join(configDir, 'config.json');
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ serverUrl: SERVER, apiKey: KEY });
    const listed = await cli(['list'], {});
    expect(listed.code).toBe(0);
    expect(server.seen.at(-1)).toMatchObject({ path: '/api/docs', auth: `Bearer ${KEY}` });
    expect((await cli(['login', '--key', 'not-a-key', '--server', SERVER], {})).code).toBe(1);
  });

  it('device login polls through pending and slow_down, then stores the session', async () => {
    server.state.token = 'session-1';
    server.state.deviceAnswers.push({ status: 400, body: { error: 'authorization_pending' } }, { status: 400, body: { error: 'slow_down' } });
    const result = await cli(['login', '--server', SERVER], {});
    expect(result.code).toBe(0);
    expect(result.out).toContain(`${SERVER}/device?user_code=ABCD-EFGH`);
    expect(result.out).toContain('ada@example.invalid');
    expect(server.seen.filter((call) => call.path === '/api/auth/device/token')).toHaveLength(3);
    expect(server.seen.find((call) => call.path === '/api/auth/device/code')?.body).toEqual({ client_id: 'moss-multi-cli' });
    expect(JSON.parse(readFileSync(join(configDir, 'config.json'), 'utf8'))).toEqual({ serverUrl: SERVER, sessionToken: 'session-1' });
    const logout = await cli(['logout'], {});
    expect(logout.out).toBe('signed out\n');
    expect(JSON.parse(readFileSync(join(configDir, 'config.json'), 'utf8'))).toEqual({ serverUrl: SERVER });
  });

  it('device login fails with exit 1 when the browser denies it', async () => {
    server.state.deviceAnswers.push({ status: 400, body: { error: 'access_denied' } });
    const result = await cli(['login', '--server', SERVER], {});
    expect(result.code).toBe(1);
    expect(result.err).toContain('denied');
    expect(existsSync(join(configDir, 'config.json'))).toBe(false);
  });
});

describe('pull and push', () => {
  it('pull writes the file and records its base under .moss-multi/<docId>', async () => {
    const result = await cli(['pull', 'Garden plan']);
    expect(result.code).toBe(0);
    const bytes = server.content.get(ID_A)!;
    expect(readFileSync(join(dir, 'garden-plan.md')).equals(Buffer.from(bytes))).toBe(true);
    expect(readFileSync(join(dir, '.moss-multi', ID_A, 'base.md')).equals(Buffer.from(bytes))).toBe(true);
    const meta = JSON.parse(readFileSync(join(dir, '.moss-multi', ID_A, 'meta.json'), 'utf8')) as Record<string, unknown>;
    expect(meta).toMatchObject({ docId: ID_A, file: 'garden-plan.md', baseHash: sha256Hex(bytes) });
  });

  it('pull refuses a path outside the workspace and an untracked file in the way', async () => {
    expect((await cli(['pull', ID_A, '../escape.md'])).code).toBe(1);
    writeFileSync(join(dir, 'mine.md'), 'my own notes');
    const blocked = await cli(['pull', ID_A, 'mine.md']);
    expect(blocked.code).toBe(1);
    expect(readFileSync(join(dir, 'mine.md'), 'utf8')).toBe('my own notes');
  });

  it('push sends the base hash with LF text, resends the base on base-missing, then refreshes the base', async () => {
    await cli(['pull', ID_A, 'plan.md']);
    const base = server.content.get(ID_A)!;
    writeFileSync(join(dir, 'plan.md'), '# Garden plan\r\n\r\nBeans, then peas, then squash.');
    server.state.pushAnswers.push({ status: 409, body: { ok: false, reason: 'base-missing' } });
    const result = await cli(['push', 'plan.md']);
    expect(result.code).toBe(0);
    expect(server.state.pushes[0]).toEqual({ newText: '# Garden plan\n\nBeans, then peas, then squash.', baseHash: sha256Hex(base) });
    expect(server.state.pushes[1]).toMatchObject({ baseText: new TextDecoder().decode(base) });
    const meta = JSON.parse(readFileSync(join(dir, '.moss-multi', ID_A, 'meta.json'), 'utf8')) as { baseHash: string };
    expect(meta.baseHash).toBe(sha256Hex(server.content.get(ID_A)!));
  });

  it('push exits 2 on failed hunks and 3 on a degenerate refusal, keeping the base', async () => {
    await cli(['pull', ID_A, 'plan.md']);
    writeFileSync(join(dir, 'plan.md'), 'changed');
    server.state.pushAnswers.push({ status: 200, body: { ok: true, mode: 'edit', applied: 1, failedHunks: ['-old\n+new'] } });
    const hunks = await cli(['push', 'plan.md']);
    expect(hunks.code).toBe(2);
    expect(hunks.err).toContain('-old');
    server.state.pushAnswers.push({ status: 422, body: { ok: false, reason: 'degenerate', deletedRatio: 0.9 } });
    const degenerate = await cli(['push', 'plan.md']);
    expect(degenerate.code).toBe(3);
    expect(degenerate.err).toContain('--force');
    server.state.pushAnswers.push({ status: 200, body: { ok: true, mode: 'edit', applied: 1, failedHunks: [] } });
    expect((await cli(['push', 'plan.md', '--force'])).code).toBe(0);
    expect(server.state.pushes.at(-1)).toMatchObject({ force: true });
  });

  it('push refuses an untracked file', async () => {
    writeFileSync(join(dir, 'loose.md'), 'hello');
    const result = await cli(['push', 'loose.md']);
    expect(result.code).toBe(1);
    expect(result.err).toContain('not tracked');
  });
});

describe('one owner per tracked file', () => {
  it('a forced pull of another doc into a tracked file drops the old mapping, so push goes to the new doc', async () => {
    expect((await cli(['pull', ID_A, 'note.md'])).code).toBe(0);
    const refused = await cli(['pull', ID_B, 'note.md']);
    expect(refused.code).toBe(1);
    expect(refused.err).toContain('--force');
    expect((await cli(['pull', ID_B, 'note.md', '--force'])).code).toBe(0);
    expect(existsSync(join(dir, '.moss-multi', ID_A, 'meta.json')), 'the old doc no longer claims note.md').toBe(false);
    writeFileSync(join(dir, 'note.md'), '# Garden notes\n\nWater daily, twice in July.\n');
    const pushed = await cli(['push', 'note.md']);
    expect(pushed.code, pushed.err).toBe(0);
    expect(server.seen.find((call) => call.path.endsWith('/push'))?.path).toBe(`/api/docs/${ID_B}/push`);
    expect(server.state.pushes[0]).toMatchObject({ baseHash: sha256Hex(new TextEncoder().encode('# Garden notes\n\nWater daily.\n')) });
  });
});

describe('one owner per tracked file on a case-insensitive volume', () => {
  // CI's volumes are case-sensitive, so the run says the workspace folds case, as APFS and NTFS do by default.
  const folding = { foldsCase: () => true };

  it('a forced pull into a case variant of a tracked file leaves one owner, and push goes to it', async () => {
    expect((await cli(['pull', ID_A, 'note.md'], undefined, folding)).code).toBe(0);
    expect((await cli(['pull', ID_B, 'NOTE.md', '--force'], undefined, folding)).code).toBe(0);
    expect(existsSync(join(dir, '.moss-multi', ID_A, 'meta.json')), 'doc A no longer claims note.md').toBe(false);
    writeFileSync(join(dir, 'note.md'), '# Garden notes\n\nWater daily, twice in July.\n');
    const pushed = await cli(['push', 'note.md'], undefined, folding);
    expect(pushed.code, pushed.err).toBe(0);
    const paths = server.seen.filter((call) => call.path.endsWith('/push')).map((call) => call.path);
    expect(paths, 'push targets B, never A').toEqual([`/api/docs/${ID_B}/push`]);
  });
});

describe('workspace confinement follows no symbolic link', () => {
  let outside: string;
  beforeEach(() => {
    outside = mkdtempSync(join(tmpdir(), 'mm-outside-'));
  });
  afterEach(() => rmSync(outside, { recursive: true, force: true }));

  it('pull refuses a destination through a linked directory', async () => {
    symlinkSync(outside, join(dir, 'link'));
    const result = await cli(['pull', ID_A, 'link/escaped.md']);
    expect(result.code).toBe(1);
    expect(existsSync(join(outside, 'escaped.md'))).toBe(false);
  });

  it('pull --force refuses a destination that is itself a link, leaving its target alone', async () => {
    writeFileSync(join(outside, 'target.md'), 'not yours');
    symlinkSync(join(outside, 'target.md'), join(dir, 'plan.md'));
    const result = await cli(['pull', ID_A, 'plan.md', '--force']);
    expect(result.code).toBe(1);
    expect(readFileSync(join(outside, 'target.md'), 'utf8')).toBe('not yours');
  });

  it('pull writes no state through a linked .moss-multi', async () => {
    mkdirSync(join(outside, 'state'));
    symlinkSync(join(outside, 'state'), join(dir, '.moss-multi'));
    const result = await cli(['pull', ID_A, 'plan.md']);
    expect(result.code).toBe(1);
    expect(existsSync(join(outside, 'state', ID_A))).toBe(false);
  });
});

describe('edits saved while a request is in flight', () => {
  it('pull does not overwrite a file edited while the content was fetched', async () => {
    expect((await cli(['pull', ID_A, 'plan.md'])).code).toBe(0);
    server.state.onContent = () => writeFileSync(join(dir, 'plan.md'), 'saved mid-pull');
    const result = await cli(['pull', ID_A, 'plan.md']);
    expect(result.code).toBe(1);
    expect(readFileSync(join(dir, 'plan.md'), 'utf8')).toBe('saved mid-pull');
  });

  it('push does not overwrite a file edited while the push was in flight', async () => {
    expect((await cli(['pull', ID_A, 'plan.md'])).code).toBe(0);
    writeFileSync(join(dir, 'plan.md'), 'first edit');
    server.state.onContent = () => writeFileSync(join(dir, 'plan.md'), 'second edit, saved mid-push');
    const result = await cli(['push', 'plan.md']);
    expect(result.code).toBe(1);
    expect(readFileSync(join(dir, 'plan.md'), 'utf8')).toBe('second edit, saved mid-push');
  });
});

describe('transport and sign-out', () => {
  it('refuses plain http to a host other than loopback, before sending a credential', async () => {
    const result = await cli(['list'], { MOSS_MULTI_SERVER: 'http://notes.example.invalid', MOSS_MULTI_API_KEY: KEY });
    expect(result.code).toBe(1);
    expect(result.err).toContain('https://');
    expect(server.seen).toHaveLength(0);
    expect((await cli(['login', '--key', KEY, '--server', 'http://notes.example.invalid'], {})).code).toBe(1);
    expect(server.seen).toHaveLength(0);
  });

  it('logout sends the server origin, so the server ends the session', async () => {
    server.state.token = 'session-1';
    expect((await cli(['login', '--server', SERVER], {})).code).toBe(0);
    expect((await cli(['logout'], {})).code).toBe(0);
    expect(server.seen.find((call) => call.path === '/api/auth/sign-out')).toMatchObject({ auth: 'Bearer session-1', origin: SERVER });
  });
});

describe('device sign-in opens only the server\'s own pages', () => {
  const forged: [string, Record<string, unknown>][] = [
    ['another origin', { verification_uri: 'https://evil.example.invalid/device', verification_uri_complete: 'https://evil.example.invalid/device?user_code=ABCD-EFGH' }],
    ['a file: URL', { verification_uri: 'file:///etc/passwd', verification_uri_complete: 'file:///Applications/Calculator.app' }],
    ['a custom scheme', { verification_uri: '/device', verification_uri_complete: 'x-evil-handler://run?cmd=1' }],
    ['a protocol-relative URL', { verification_uri: '//evil.example.invalid/device', verification_uri_complete: undefined }],
  ];
  for (const [name, grant] of forged) {
    it(`a forged grant pointing at ${name} opens nothing and names the server's /device page`, async () => {
      server.state.token = 'session-1';
      server.state.grant = grant;
      const result = await cli(['login', '--server', SERVER], {});
      expect(result.code, result.err).toBe(0);
      expect(opened).toEqual([]);
      expect(result.out).not.toMatch(/evil|file:|Calculator/);
      expect(result.out).toContain(`${SERVER}/device`);
      expect(result.out).toContain('ABCD-EFGH');
    });
  }

  it('opens the server\'s own verification page', async () => {
    server.state.token = 'session-1';
    expect((await cli(['login', '--server', SERVER], {})).code).toBe(0);
    expect(opened).toEqual([`${SERVER}/device?user_code=ABCD-EFGH`]);
  });
});

describe('server text never drives the terminal', () => {
  const ID_D = '44444444-4444-4444-8444-444444444444';
  const ID_E = '66666666-6666-4666-8666-666666666666';
  const EVIL = 'Plan\u001b[2J\u001b]8;;https://evil.example.invalid\u0007click\u001b]8;;\u0007\u009b31m\u202egnp.exe\r';
  // Its own oracle, independent of output.ts: C0 but tab and LF, DEL and C1, bidi marks, embeddings and isolates.
  const hasControl = (text: string) => [...text].some((char) => {
    const code = char.codePointAt(0) ?? 0;
    return (code < 0x20 && code !== 0x09 && code !== 0x0a) || (code >= 0x7f && code < 0xa0) ||
      [0x061c, 0x200e, 0x200f, 0x2028, 0x2029].includes(code) || (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069);
  });
  const row = (id: string, title: string) => ({ id, title, filename: 'plan.md', folderId: 'f', vaultId: 'v', role: 'owner', updatedAt: 0 });

  it('a title with escape sequences prints escaped in list, mv, a doc-reference error and a refusal', async () => {
    server.docs.push(row(ID_D, EVIL), row(ID_E, `${EVIL} 2`));
    server.content.set(ID_D, new TextEncoder().encode(`# ${EVIL}`));
    const listed = await cli(['list']);
    expect(listed.code).toBe(0);
    expect(hasControl(listed.out)).toBe(false);
    expect(listed.out).toContain('Plan\\x1b[2J');
    expect(listed.out).toContain('\\u202e');
    const renamed = await cli(['mv', ID_D, EVIL]);
    expect(renamed.code).toBe(0);
    expect(hasControl(renamed.out)).toBe(false);
    const ambiguous = await cli(['cat', 'Pla']);
    expect(ambiguous.code).toBe(1);
    expect(ambiguous.err).toContain(ID_E);
    expect(hasControl(ambiguous.err)).toBe(false);
    server.state.refuse = { status: 403, body: { message: 'no \u001b]52;c;cm0gLXJmIH4=\u0007 way' } };
    const refused = await cli(['history', ID_D]);
    expect(refused.code).toBe(1);
    expect(refused.err).toContain('forbidden');
    expect(hasControl(refused.err)).toBe(false);
  });

  it('--json keeps the exact title, escaped so no control character reaches the terminal raw', async () => {
    server.docs.push(row(ID_D, EVIL));
    const listed = await cli(['list', '--json']);
    expect(hasControl(listed.out)).toBe(false);
    expect((JSON.parse(listed.out) as { id: string; title: string }[]).find((doc) => doc.id === ID_D)?.title).toBe(EVIL);
  });

  it('cat still writes the content byte for byte', async () => {
    server.content.set(ID_C, new TextEncoder().encode(EVIL));
    const result = await cli(['cat', ID_C]);
    expect(result.bytes.equals(Buffer.from(EVIL))).toBe(true);
  });
});

describe('redirects never carry a credential elsewhere', () => {
  it('a cross-origin redirect is refused without sending the key there', async () => {
    server.state.redirect = { path: '/api/docs', to: 'https://evil.example.invalid/collect' };
    const result = await cli(['list']);
    expect(result.code).toBe(1);
    expect(result.err).toContain('redirect');
    expect(server.seen.filter((call) => call.host !== '127.0.0.1:9999')).toEqual([]);
  });

  it('a redirect during login --key or device polling is refused too', async () => {
    server.state.redirect = { path: '/api/me', to: 'https://evil.example.invalid/me' };
    expect((await cli(['login', '--key', KEY, '--server', SERVER], {})).code).toBe(1);
    server.state.redirect = { path: '/api/auth/device/token', to: 'https://evil.example.invalid/token' };
    expect((await cli(['login', '--server', SERVER], {})).code).toBe(1);
    expect(server.seen.filter((call) => call.host !== '127.0.0.1:9999')).toEqual([]);
  });
});

describe('the workspace confines every local file', () => {
  let outside: string;
  beforeEach(() => {
    outside = mkdtempSync(join(tmpdir(), 'mm-outside-'));
    writeFileSync(join(outside, 'secret.md'), 'private key material');
  });
  afterEach(() => rmSync(outside, { recursive: true, force: true }));

  it('push refuses a tracked file replaced by a link out of the workspace, sending nothing', async () => {
    expect((await cli(['pull', ID_A, 'plan.md'])).code).toBe(0);
    rmSync(join(dir, 'plan.md'));
    symlinkSync(join(outside, 'secret.md'), join(dir, 'plan.md'));
    expect((await cli(['push', 'plan.md'])).code).toBe(1);
    expect(server.state.pushes).toEqual([]);
  });

  it('push refuses a tracked file whose directory became a link out of the workspace', async () => {
    expect((await cli(['pull', ID_A, 'notes/plan.md'])).code).toBe(0);
    rmSync(join(dir, 'notes'), { recursive: true });
    writeFileSync(join(outside, 'plan.md'), 'private');
    symlinkSync(outside, join(dir, 'notes'));
    expect((await cli(['push', 'notes/plan.md'])).code).toBe(1);
    expect(server.state.pushes).toEqual([]);
  });

  it('pull refuses a link out of the workspace, and a tracked path that climbs out of it', async () => {
    symlinkSync(outside, join(dir, 'out'));
    expect((await cli(['pull', ID_A, 'out/secret.md', '--force'])).code).toBe(1);
    expect(readFileSync(join(outside, 'secret.md'), 'utf8')).toBe('private key material');
    expect((await cli(['pull', ID_A, 'plan.md'])).code).toBe(0);
    const metaPath = join(dir, '.moss-multi', ID_A, 'meta.json');
    const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as Record<string, unknown>;
    writeFileSync(metaPath, JSON.stringify({ ...meta, file: `../${basename(outside)}/secret.md` }));
    expect((await cli(['pull', ID_A, '--force'])).code).toBe(1);
    expect(readFileSync(join(outside, 'secret.md'), 'utf8')).toBe('private key material');
  });

  it('the state directory is refused in any letter case, as a case-insensitive volume would resolve it', async () => {
    expect((await cli(['pull', ID_A, 'plan.md'])).code).toBe(0);
    const meta = readFileSync(join(dir, '.moss-multi', ID_A, 'meta.json'), 'utf8');
    mkdirSync(join(dir, '.MOSS-MULTI', ID_A), { recursive: true });
    writeFileSync(join(dir, '.MOSS-MULTI', ID_A, 'meta.json'), meta);
    expect((await cli(['pull', ID_B, `.MOSS-MULTI/${ID_A}/meta.json`, '--force'])).code).toBe(1);
    expect((await cli(['pull', ID_B, `.Moss-Multi/${ID_A}/meta.json`, '--force'])).code).toBe(1);
    expect(readFileSync(join(dir, '.MOSS-MULTI', ID_A, 'meta.json'), 'utf8')).toBe(meta);
    expect((await cli(['add', `.MOSS-MULTI/${ID_A}/meta.json`])).code).toBe(1);
    expect(server.seen.filter((call) => call.method === 'POST')).toEqual([]);
  });

  it('add refuses a link out of the workspace, sending nothing', async () => {
    mkdirSync(join(dir, '.moss-multi'));
    symlinkSync(join(outside, 'secret.md'), join(dir, 'secret.md'));
    expect((await cli(['add', 'secret.md'])).code).toBe(1);
    expect(server.seen.filter((call) => call.method === 'POST')).toEqual([]);
  });

  it('add refuses a linked directory whose target holds its own .moss-multi, sending nothing', async () => {
    mkdirSync(join(dir, '.moss-multi'));
    mkdirSync(join(outside, '.moss-multi'));
    symlinkSync(outside, join(dir, 'out'));
    expect((await cli(['add', 'out/secret.md', '--json'])).code).toBe(1);
    expect(server.seen.filter((call) => call.method === 'POST')).toEqual([]);
  });

  it('push refuses a linked directory whose target tracks its own files, sending nothing', async () => {
    mkdirSync(join(dir, '.moss-multi'));
    mkdirSync(join(outside, '.moss-multi', ID_A), { recursive: true });
    writeFileSync(join(outside, '.moss-multi', ID_A, 'base.md'), 'old');
    writeFileSync(join(outside, '.moss-multi', ID_A, 'meta.json'), JSON.stringify({ docId: ID_A, file: 'secret.md', baseHash: sha256Hex('old'), pulledAt: 0 }));
    symlinkSync(outside, join(dir, 'out'));
    expect((await cli(['push', 'out/secret.md'])).code).toBe(1);
    expect(server.state.pushes).toEqual([]);
  });

  it('a name with a tab or a line break is refused, and a server filename holding one falls back to the slug', async () => {
    expect((await cli(['pull', ID_A, 'a\tb.md'])).code).toBe(1);
    expect((await cli(['pull', ID_A, 'a\nb.md'])).code).toBe(1);
    expect(existsSync(join(dir, 'a\tb.md'))).toBe(false);
    expect(existsSync(join(dir, 'a\nb.md'))).toBe(false);
    server.docs[0].filename = 'two\nlines.md';
    expect((await cli(['pull', ID_A])).code).toBe(0);
    expect(existsSync(join(dir, 'two\nlines.md'))).toBe(false);
    expect(existsSync(join(dir, 'garden-plan.md'))).toBe(true);
  });

  it('pull refuses a file name moss does not allow, and never writes a server filename that breaks the rules', async () => {
    expect((await cli(['pull', ID_A, 'bad:name.md'])).code).toBe(1);
    expect((await cli(['pull', ID_A, '.moss-multi/x.md'])).code).toBe(1);
    expect(existsSync(join(dir, 'bad:name.md'))).toBe(false);
    expect(existsSync(join(dir, '.moss-multi', 'x.md'))).toBe(false);
    server.docs[0].filename = 'evil\u001b]0;x\u0007.md';
    expect((await cli(['pull', ID_A])).code).toBe(0);
    expect(existsSync(join(dir, 'garden-plan.md'))).toBe(true);
  });
});

describe('the key never appears in output', () => {
  it('not in errors, listings, JSON or sign-in, even when the server echoes it', async () => {
    const echo = `bad credential ${KEY} (Bearer ${KEY})`;
    server.docs.push({ id: '55555555-5555-4555-8555-555555555555', title: `Key ${KEY}`, filename: 'k.md', folderId: 'f', vaultId: 'v', role: 'owner', updatedAt: 0 });
    const outputs = [
      await cli(['list']),
      await cli(['list', '--json']),
      await cli(['login', '--key', KEY, '--server', SERVER], {}),
      await cli(['whoami']),
    ];
    server.state.refuse = { status: 403, body: { message: echo } };
    outputs.push(await cli(['list']), await cli(['history', ID_A]));
    server.state.refuse = { status: 500, body: { error: echo } };
    outputs.push(await cli(['list']));
    server.state.refuse = null;
    server.state.token = 'other';
    outputs.push(await cli(['login', '--key', KEY, '--server', SERVER], {}));
    for (const output of outputs) {
      expect(output.out).not.toContain(KEY);
      expect(output.err).not.toContain(KEY);
    }
    expect(outputs[4].err).toContain('forbidden');
  });
});

describe('comments and suggestions (A§17 read commands)', () => {
  const ada = { id: 'user-1', name: 'Ada', type: 'user' };
  const scribe = { id: 'agent-1', name: 'Scribe', type: 'agent' };
  const threads = [
    { id: 'c-root', parentId: null, author: ada, text: 'Is this the right order?', quote: 'Beans, then peas', status: 'anchored', resolved: false, createdAt: 1_700_000_000_000 },
    { id: 'c-reply', parentId: 'c-root', author: scribe, text: 'Yes: \u2063@person:Ada\u2062user-1\u2064 beans go first.', quote: null, status: null, resolved: false, createdAt: 1_700_000_100_000 },
    { id: 'c-done', parentId: null, author: scribe, text: 'Water daily?', quote: 'Water', status: 'orphaned', resolved: true, createdAt: 1_700_000_200_000 },
  ];
  const open = [
    { id: 's-1', author: scribe, status: 'open', source: 'cli', createdAt: 1_700_000_300_000, updatedAt: 1_700_000_300_000, outdated: false },
    { id: 's-2', author: ada, status: 'open', source: 'live', createdAt: 1_700_000_400_000, updatedAt: 1_700_000_400_000, outdated: true },
  ];

  it('comments <doc> lists the doc\'s threads, replies under their root, by reference', async () => {
    server.state.comments = threads;
    const result = await cli(['comments', 'Garden plan']);
    expect(result.err).toBe('');
    expect(result.code).toBe(0);
    expect(server.seen.at(-1)).toMatchObject({ method: 'GET', path: `/api/docs/${ID_A}/comments` });
    const lines = result.out.trimEnd().split('\n');
    const root = lines.findIndex((line) => line.includes('c-root'));
    const reply = lines.findIndex((line) => line.includes('c-reply'));
    const done = lines.findIndex((line) => line.includes('c-done'));
    expect(root).toBeGreaterThanOrEqual(0);
    expect(reply).toBeGreaterThan(root);
    expect(done).toBeGreaterThan(reply);
    expect(lines[root]).toContain('Ada');
    expect(lines[root]).toContain('Is this the right order?');
    expect(result.out).toContain('"Beans, then peas"');
    expect(lines[reply]).toContain('Scribe');
    expect(lines[reply], 'a mention reads as @Name').toContain('Yes: @Ada beans go first.');
    expect(result.out).toMatch(/c-done.*resolved/);
  });

  it('comments --json prints the records; an empty doc says so', async () => {
    server.state.comments = threads;
    const json = await cli(['comments', ID_A, '--json']);
    expect(json.code).toBe(0);
    expect(JSON.parse(json.out)).toEqual(threads);
    server.state.comments = [];
    const none = await cli(['comments', ID_A]);
    expect(none.code).toBe(0);
    expect(none.out).toBe('no comments\n');
  });

  it('suggestions <doc> lists the open suggestions with their author', async () => {
    server.state.suggestions = open;
    const result = await cli(['suggestions', ID_A]);
    expect(result.err).toBe('');
    expect(result.code).toBe(0);
    expect(server.seen.at(-1)).toMatchObject({ method: 'GET', path: `/api/docs/${ID_A}/suggestions` });
    expect(result.out).toMatch(/s-1.*Scribe/);
    expect(result.out).toMatch(/s-2.*Ada.*outdated/);
    const json = await cli(['suggestions', ID_A, '--json']);
    expect(JSON.parse(json.out)).toEqual(open);
    server.state.suggestions = [];
    expect((await cli(['suggestions', ID_A])).out).toBe('no open suggestions\n');
  });

  it('both are in the usage, and a doc you cannot open is a 404', async () => {
    const help = await cli(['help']);
    expect(help.out).toContain('comments <doc>');
    expect(help.out).toContain('suggestions <doc>');
    const missing = await cli(['comments', '99999999-9999-4999-8999-999999999999']);
    expect(missing.code).toBe(1);
    expect(missing.err).toContain('not found');
  });
});

describe('a refused push says why', () => {
  it('a push the doc\'s role does not allow names the role it needs', async () => {
    await cli(['pull', ID_A, 'plan.md']);
    writeFileSync(join(dir, 'plan.md'), 'changed');
    server.state.pushAnswers.push({ status: 403, body: { ok: false, reason: 'forbidden' } });
    const edit = await cli(['push', 'plan.md']);
    expect(edit.code).toBe(1);
    expect(edit.err).toContain('push refused: you can\'t edit this doc');
    server.state.pushAnswers.push({ status: 403, body: { ok: false, reason: 'forbidden' } });
    const suggest = await cli(['push', 'plan.md', '--suggest']);
    expect(suggest.code).toBe(1);
    expect(suggest.err).toContain('push refused: you can\'t suggest changes to this doc');
  });

  it('push --suggest reports the suggestion and leaves the file and its base as they are', async () => {
    await cli(['pull', ID_A, 'plan.md']);
    const base = readFileSync(join(dir, '.moss-multi', ID_A, 'base.md'));
    writeFileSync(join(dir, 'plan.md'), 'suggested text');
    server.state.pushAnswers.push({ status: 200, body: { ok: true, mode: 'suggest', suggestionId: 's-9' } });
    const result = await cli(['push', 'plan.md', '--suggest']);
    expect(result.code).toBe(0);
    expect(server.state.pushes.at(-1)).toMatchObject({ suggest: true });
    expect(result.out).toContain('suggestion s-9');
    expect(readFileSync(join(dir, 'plan.md'), 'utf8')).toBe('suggested text');
    expect(readFileSync(join(dir, '.moss-multi', ID_A, 'base.md')).equals(base)).toBe(true);
  });
});

describe('mayOpenBrowser', () => {
  it('opens a browser only when neither MOSS_MULTI_NO_OPEN=1 nor CI is set', async () => {
    const { mayOpenBrowser } = await import('./config.ts');
    expect(mayOpenBrowser({})).toBe(true);
    expect(mayOpenBrowser({ MOSS_MULTI_NO_OPEN: '1' })).toBe(false);
    expect(mayOpenBrowser({ CI: 'true' })).toBe(false);
  });
});

describe('add: the title line and moss interchange (T7.4)', () => {
  it('add --title asks the server to treat a leading line that is the title as the title line', async () => {
    writeFileSync(join(dir, 'tomato.md'), '# Tomato log\n\nPlant out in May.\n');
    const result = await cli(['add', 'tomato.md', '--title', 'Tomato log']);
    expect(result.code, result.err).toBe(0);
    const create = server.seen.find((call) => call.method === 'POST' && call.path === '/api/docs');
    expect(create?.body).toEqual({ title: 'Tomato log', markdown: '# Tomato log\n\nPlant out in May.\n', titleLine: true });
  });

  it('add --moss sends no title of its own and the comments.json beside the file', async () => {
    mkdirSync(join(dir, 'Tomato log'));
    writeFileSync(join(dir, 'Tomato log', 'Tomato log.md'), '# Tomato log\n\nThe %%m:c1:start%%cherry%%m:c1:end%% ones.\n');
    const sidecar = { c1: { text: 'Save seeds', createdAt: 1, updatedAt: 1, source: 'user' } };
    writeFileSync(join(dir, 'Tomato log', 'comments.json'), JSON.stringify(sidecar));
    server.state.createNew = { id: ID_C, filename: 'tomato-log.md' };
    const result = await cli(['add', 'Tomato log/Tomato log.md', '--moss']);
    expect(result.code, result.err).toBe(0);
    const create = server.seen.find((call) => call.method === 'POST' && call.path === '/api/docs');
    expect(create?.body).toEqual({ markdown: '# Tomato log\n\nThe %%m:c1:start%%cherry%%m:c1:end%% ones.\n', titleLine: true, comments: sidecar });
  });
});

describe('sync (T7.4)', () => {
  const enc = (text: string) => new TextEncoder().encode(text);

  it('pulls a doc changed on the server and pushes a local edit', async () => {
    expect((await cli(['pull', ID_A, 'plan.md'])).code).toBe(0);
    expect((await cli(['pull', ID_B, 'notes.md'])).code).toBe(0);
    server.content.set(ID_A, enc('# Garden plan\n\nBeans, then peas — é ✓\n\nAnd squash.'));
    writeFileSync(join(dir, 'notes.md'), '# Garden notes\n\nWater daily, twice in July.\n');
    const result = await cli(['sync']);
    expect(result.code, result.err).toBe(0);
    expect(readFileSync(join(dir, 'plan.md'), 'utf8'), 'the server change reaches the file').toContain('And squash.');
    expect(server.state.pushes.map((push) => push.newText), 'the local edit is pushed').toEqual(['# Garden notes\n\nWater daily, twice in July.\n']);
    expect(server.seen.filter((call) => call.path === `/api/docs/${ID_A}/push`), 'an unchanged file is not pushed').toEqual([]);
  });

  it('re-pulls a deleted tracked file and never trashes the doc', async () => {
    expect((await cli(['pull', ID_A, 'plan.md'])).code).toBe(0);
    rmSync(join(dir, 'plan.md'));
    const result = await cli(['sync', '--json']);
    expect(result.code, result.err).toBe(0);
    expect(JSON.parse(result.out)).toContainEqual(expect.objectContaining({ docId: ID_A, action: 'repulled' }));
    expect(Buffer.from(readFileSync(join(dir, 'plan.md'))).equals(Buffer.from(server.content.get(ID_A)!))).toBe(true);
    expect(server.seen.filter((call) => call.method === 'DELETE'), 'a local delete never propagates').toEqual([]);
  });

  it('turns an untracked file into a doc titled from its stem and renames the file to its filename', async () => {
    mkdirSync(join(dir, '.moss-multi'));
    writeFileSync(join(dir, 'Seed Packets.md'), 'Order the beans in March.\n');
    server.state.createNew = { id: '44444444-4444-4444-8444-444444444444', filename: 'seed-packets.md' };
    const result = await cli(['sync', '--json']);
    expect(result.code, result.err).toBe(0);
    const create = server.seen.find((call) => call.method === 'POST' && call.path === '/api/docs');
    expect(create?.body).toEqual({ title: 'Seed Packets', markdown: 'Order the beans in March.\n' });
    expect(JSON.parse(result.out)).toContainEqual(expect.objectContaining({ action: 'created', docId: '44444444-4444-4444-8444-444444444444', file: 'seed-packets.md' }));
    expect(existsSync(join(dir, 'Seed Packets.md'))).toBe(false);
    expect(readFileSync(join(dir, 'seed-packets.md'), 'utf8')).toBe('Order the beans in March.\n');
    const again = await cli(['sync']);
    expect(again.code, again.err).toBe(0);
    expect(server.seen.filter((call) => call.method === 'POST' && call.path === '/api/docs'), 'tracked now: no second doc').toHaveLength(1);
  });

  it('renames the local file when the server filename changes', async () => {
    expect((await cli(['pull', ID_A, 'garden-plan.md'])).code).toBe(0);
    expect((await cli(['sync'])).code).toBe(0);
    server.docs[0]!.filename = 'vegetable-plan.md';
    const result = await cli(['sync']);
    expect(result.code, result.err).toBe(0);
    expect(existsSync(join(dir, 'garden-plan.md'))).toBe(false);
    expect(readFileSync(join(dir, 'vegetable-plan.md'), 'utf8')).toContain('Beans, then peas');
    writeFileSync(join(dir, 'vegetable-plan.md'), '# Garden plan\n\nBeans.');
    expect((await cli(['push', 'vegetable-plan.md'])).code, 'the renamed file is still tracked').toBe(0);
  });

  it('watch syncs, runs again on a local change, and stops with exit 0', async () => {
    expect((await cli(['pull', ID_A, 'plan.md'])).code).toBe(0);
    const controller = new AbortController();
    const before = server.seen.length;
    const running = cli(['watch', '--interval', '0.2'], undefined, { signal: controller.signal });
    const deadline = Date.now() + 5_000;
    while (!server.seen.slice(before).some((call) => call.path === `/api/docs/${ID_A}/content`) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    writeFileSync(join(dir, 'plan.md'), '# Garden plan\n\nBeans only.');
    while (server.state.pushes.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    controller.abort();
    const result = await running;
    expect(result.code, result.err).toBe(0);
    expect(result.out).toContain('watching');
    expect(server.state.pushes.map((push) => push.newText)).toEqual(['# Garden plan\n\nBeans only.']);
  });

  it('refuses to sync or watch a directory that is not a workspace, and creates nothing there', async () => {
    writeFileSync(join(dir, 'README.md'), '# Project\n\n| a | b |\n|---|---|\n| 1 | 2 |\n');
    for (const args of [['sync'], ['watch', '--interval', '0.1']]) {
      const result = await cli(args);
      expect(result.code, args.join(' ')).toBe(1);
      expect(result.err).toContain('moss-multi init');
    }
    expect(server.seen.filter((call) => call.method === 'POST'), 'no doc is created').toEqual([]);
    expect(existsSync(join(dir, '.moss-multi')), 'the directory does not become a workspace').toBe(false);
    expect(readFileSync(join(dir, 'README.md'), 'utf8')).toBe('# Project\n\n| a | b |\n|---|---|\n| 1 | 2 |\n');
  });

  it('init makes a workspace; sync then skips node_modules and nested repositories', async () => {
    const init = await cli(['init']);
    expect(init.code, init.err).toBe(0);
    expect(statSync(join(dir, '.moss-multi')).isDirectory()).toBe(true);
    mkdirSync(join(dir, 'node_modules', 'foo'), { recursive: true });
    writeFileSync(join(dir, 'node_modules', 'foo', 'README.md'), 'a package readme');
    mkdirSync(join(dir, 'vendor', '.git'), { recursive: true });
    writeFileSync(join(dir, 'vendor', 'NOTES.md'), 'another repository');
    mkdirSync(join(dir, 'other', '.moss-multi'), { recursive: true });
    writeFileSync(join(dir, 'other', 'mine.md'), 'another workspace');
    const result = await cli(['sync', '--json']);
    expect(result.code, result.err).toBe(0);
    expect(server.seen.filter((call) => call.method === 'POST'), 'none of them becomes a doc').toEqual([]);
  });

  it('keeps the old base when the file is edited during a push, so the next push merges against it', async () => {
    expect((await cli(['pull', ID_A, 'plan.md'])).code).toBe(0);
    const base = sha256Hex(readFileSync(join(dir, 'plan.md')));
    writeFileSync(join(dir, 'plan.md'), '# Garden plan\n\nBeans, then peas, then squash.');
    server.state.onContent = () => {
      if (server.state.pushes.length === 1) writeFileSync(join(dir, 'plan.md'), '# Garden plan\n\nBeans, then peas, then squash and leeks.');
    };
    const first = await cli(['sync']);
    expect(first.code, first.err).toBe(0);
    server.state.onContent = null;
    expect(readFileSync(join(dir, 'plan.md'), 'utf8'), 'the newer edit is kept').toContain('leeks');
    const second = await cli(['sync']);
    expect(second.code, second.err).toBe(0);
    expect(server.state.pushes.map((push) => push.baseHash), 'both pushes merge against the text the file last held from the server').toEqual([base, base]);
  });

  it('on failed hunks writes the server text and its base, keeps the rejected text in a .rej file, and pulls the next web edit', async () => {
    expect((await cli(['pull', ID_B, 'notes.md'])).code).toBe(0);
    writeFileSync(join(dir, 'notes.md'), '# Garden notes\n\nWater twice, Charlie.\n');
    server.content.set(ID_B, enc('# Garden notes\n\nWater daily, Ada.\n'));
    const hunk = '-Water daily.\n+Water twice, Charlie.';
    server.state.pushAnswers.push({ status: 200, body: { ok: true, mode: 'edit', applied: 0, failedHunks: [hunk] } });
    const result = await cli(['sync', '--json']);
    expect(result.code).toBe(2);
    expect(JSON.parse(result.out)).toContainEqual(expect.objectContaining({ docId: ID_B, failedHunks: 1, hunks: [hunk] }));
    expect(readFileSync(join(dir, 'notes.md'), 'utf8'), 'the file takes the server text').toBe('# Garden notes\n\nWater daily, Ada.\n');
    expect(readFileSync(join(dir, 'notes.md.rej'), 'utf8'), 'the rejected text is kept aside').toContain('+Water twice, Charlie.');
    server.content.set(ID_B, enc('# Garden notes\n\nWater daily, Ada. Mulch too.\n'));
    const again = await cli(['sync']);
    expect(again.code, again.err).toBe(0);
    expect(readFileSync(join(dir, 'notes.md'), 'utf8'), 'the next web edit reaches the file').toBe('# Garden notes\n\nWater daily, Ada. Mulch too.\n');
    expect(server.state.pushes, 'nothing is pushed again').toHaveLength(1);
  });

  it('does not follow a server rename onto a path another tracked doc owns', async () => {
    expect((await cli(['pull', ID_A, 'plan.md'])).code).toBe(0);
    expect((await cli(['pull', ID_B, 'vegetable-plan.md'])).code).toBe(0);
    expect((await cli(['sync'])).code).toBe(0);
    rmSync(join(dir, 'vegetable-plan.md'));
    server.docs[0]!.filename = 'vegetable-plan.md';
    const result = await cli(['sync', '--json']);
    expect(server.state.pushes, 'no doc receives another doc\'s text').toEqual([]);
    expect(readFileSync(join(dir, 'plan.md'), 'utf8')).toContain('Beans, then peas');
    expect(readFileSync(join(dir, 'vegetable-plan.md'), 'utf8')).toContain('Water daily.');
    expect(JSON.parse(result.out)).toContainEqual(expect.objectContaining({ docId: ID_A, action: 'failed' }));
  });

  it('watch waits out a retry-after even when files change', async () => {
    expect((await cli(['pull', ID_A, 'plan.md'])).code).toBe(0);
    writeFileSync(join(dir, 'plan.md'), '# Garden plan\n\nBeans only.');
    server.state.pushAnswers.push({ status: 429, body: { ok: false, reason: 'rate-limited', retryAfterSec: 3 } });
    const controller = new AbortController();
    const running = cli(['watch', '--interval', '0.1'], undefined, { signal: controller.signal });
    const deadline = Date.now() + 5_000;
    while (server.state.pushes.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    await new Promise((r) => setTimeout(r, 100));
    writeFileSync(join(dir, 'plan.md'), '# Garden plan\n\nBeans and leeks.');
    await new Promise((r) => setTimeout(r, 1_200));
    controller.abort();
    const result = await running;
    expect(result.code, result.err).toBe(0);
    expect(server.state.pushes, 'no push before the retry-after ends').toHaveLength(1);
  });
});

describe('sync: moss notes, the H1 and doc identity (T7.4 checker)', () => {
  const enc = (text: string) => new TextEncoder().encode(text);
  const dec = (bytes: Uint8Array | undefined) => new TextDecoder().decode(bytes);
  const NEW = '55555555-5555-4555-8555-555555555555';
  const NOTE = '# Tomato log\n\nThe %%m:c1:start%%cherry tomatoes%%m:c1:end%% ripened first.\n';
  const SIDECAR = { c1: { text: 'Save seeds from these', createdAt: 1_700_000_000, updatedAt: 1_700_000_000, source: 'user' } };
  const creates = () => server.seen.filter((call) => call.method === 'POST' && call.path === '/api/docs');
  const mossNote = () => {
    mkdirSync(join(dir, 'Tomato log'));
    writeFileSync(join(dir, 'Tomato log', 'Tomato log.md'), NOTE);
    writeFileSync(join(dir, 'Tomato log', 'comments.json'), JSON.stringify(SIDECAR));
    server.state.createNew = { id: NEW, filename: 'tomato-log.md' };
    return join(dir, 'Tomato log', 'Tomato log.md');
  };

  it('sync imports a moss vault note through the interchange path and keeps its file, title line and markers', async () => {
    expect((await cli(['init'])).code).toBe(0);
    const file = mossNote();
    const first = await cli(['sync', '--json']);
    expect(first.code, first.err).toBe(0);
    expect(creates().map((call) => call.body), 'the title line and the comments go to the server').toEqual([{ markdown: NOTE, titleLine: true, comments: SIDECAR }]);
    expect(dec(server.content.get(NEW))).toBe('The cherry tomatoes ripened first.\n');
    expect(readFileSync(file, 'utf8'), 'the moss note is left in moss format').toBe(NOTE);
    expect(readdirSync(join(dir, 'Tomato log')).sort(), 'and keeps its name').toEqual(['Tomato log.md', 'comments.json']);

    server.content.set(NEW, enc('The cherry tomatoes ripened first.\n\nThe plums came next.\n'));
    expect((await cli(['sync'])).code).toBe(0);
    expect(readFileSync(file, 'utf8'), 'a web edit arrives with the title line and markers kept').toBe(`${NOTE}\nThe plums came next.\n`);

    writeFileSync(file, `${NOTE}\nThe plums came next.\n\nBeans last.\n`);
    expect((await cli(['sync'])).code).toBe(0);
    expect(server.state.pushes.map((push) => push.newText), 'a local edit goes up without the title line or markers').toEqual(['The cherry tomatoes ripened first.\n\nThe plums came next.\n\nBeans last.\n']);
    expect(readFileSync(file, 'utf8')).toBe(`${NOTE}\nThe plums came next.\n\nBeans last.\n`);
    expect(creates(), 'one doc').toHaveLength(1);
    const push = await cli(['push', join('Tomato log', 'Tomato log.md')]);
    expect(push.code, 'push and pull would drop the moss format, so they point to sync').toBe(1);
    expect(push.err).toContain('sync');
  });

  it('add --moss in a workspace tracks the note, so a later sync makes no second doc and leaves the file alone', async () => {
    expect((await cli(['init'])).code).toBe(0);
    const file = mossNote();
    const added = await cli(['add', join('Tomato log', 'Tomato log.md'), '--moss']);
    expect(added.code, added.err).toBe(0);
    const synced = await cli(['sync']);
    expect(synced.code, synced.err).toBe(0);
    expect(creates(), 'one doc').toHaveLength(1);
    expect(readFileSync(file, 'utf8')).toBe(NOTE);
  });

  it('sync and plain add keep a leading H1 as body content, and the file keeps it', async () => {
    writeFileSync(join(dir, 'Plan.md'), '# Plan\n\nBody.\n');
    server.state.createNew = { id: NEW, filename: 'plan.md' };
    const added = await cli(['add', 'Plan.md']);
    expect(added.code, added.err).toBe(0);
    expect(creates().at(-1)?.body, 'add without --title or --moss lifts nothing').toEqual({ title: 'Plan', markdown: '# Plan\n\nBody.\n' });
    rmSync(join(dir, 'Plan.md'));

    expect((await cli(['init'])).code).toBe(0);
    writeFileSync(join(dir, 'Notes.md'), '# Notes\n\nBody.\n');
    server.state.createNew = { id: '66666666-6666-4666-8666-666666666666', filename: 'notes.md' };
    const synced = await cli(['sync']);
    expect(synced.code, synced.err).toBe(0);
    expect(creates().at(-1)?.body).toEqual({ title: 'Notes', markdown: '# Notes\n\nBody.\n' });
    expect(readFileSync(join(dir, 'notes.md'), 'utf8'), 'the H1 stays in the file').toBe('# Notes\n\nBody.\n');
  });

  it('a local rename follows only an unambiguous match, so notes with the same text never swap docs', async () => {
    server.content.set(ID_A, enc('Template line.\n'));
    server.content.set(ID_B, enc('Template line.\n'));
    expect((await cli(['pull', ID_A, 'alpha.md'])).code).toBe(0);
    expect((await cli(['pull', ID_B, 'beta.md'])).code).toBe(0);
    expect((await cli(['pull', ID_C, 'recipes.md'])).code).toBe(0);
    renameSync(join(dir, 'alpha.md'), join(dir, 'aa-alpha.md'));
    renameSync(join(dir, 'beta.md'), join(dir, 'zz-beta.md'));
    renameSync(join(dir, 'recipes.md'), join(dir, 'soups.md'));
    const moved = await cli(['sync', '--json']);
    const results = JSON.parse(moved.out) as { action: string; docId?: string; file: string }[];
    expect(results.filter((result) => result.action === 'renamed').map((result) => [result.docId, result.file]), 'only the unique match is followed').toEqual([[ID_C, 'soups.md']]);
    writeFileSync(join(dir, 'aa-alpha.md'), 'Template line.\n\nAlpha-only secret.\n');
    await cli(['sync']);
    expect(dec(server.content.get(ID_B)), 'beta\'s doc never receives alpha\'s text').toBe('Template line.\n');
    expect(server.seen.filter((call) => call.path === `/api/docs/${ID_B}/push`)).toEqual([]);
  });

  it('a server rename blocked by another doc\'s file is retried once the name is free', async () => {
    expect((await cli(['pull', ID_A, 'plan.md'])).code).toBe(0);
    expect((await cli(['pull', ID_B, 'vegetable-plan.md'])).code).toBe(0);
    expect((await cli(['sync'])).code).toBe(0);
    server.docs[0]!.filename = 'vegetable-plan.md';
    await cli(['sync']);
    expect(existsSync(join(dir, 'plan.md')), 'blocked while another doc holds the name').toBe(true);
    server.docs[1]!.filename = 'watering.md';
    await cli(['sync']);
    await cli(['sync']);
    expect(readFileSync(join(dir, 'watering.md'), 'utf8')).toContain('Water daily.');
    expect(existsSync(join(dir, 'plan.md')), 'the blocked rename happens once the name is free').toBe(false);
    expect(readFileSync(join(dir, 'vegetable-plan.md'), 'utf8')).toContain('Beans, then peas');
  });
});
