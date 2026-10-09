import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { commentGaps, hasVersion, pendingBy, planNotes } from '../e2e/qa/demo.js';
import { commentPasses, demoConfig, demoPrincipals, ensurePrincipal, NOTES, stepScript, STEPS, THREADS, writeDemoRun } from './demo.mjs';

const VERSION = { commit: 'c'.repeat(40), bundleHash: 'b'.repeat(64), clientHash: 'e'.repeat(64) };

const dirs = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('demoConfig', () => {
  it('names one stable demo run per stack URL, so a re-run reuses its state', () => {
    const a = demoConfig({ url: 'https://moss-multi-staging.example.workers.dev/' });
    const b = demoConfig({ url: 'https://moss-multi-staging.example.workers.dev' });
    expect(a.baseUrl).toBe('https://moss-multi-staging.example.workers.dev');
    expect(a.runId).toBe(b.runId);
    expect(a.runId).toMatch(/^demo-[A-Za-z0-9._-]+$/);
    expect(demoConfig({ url: 'http://127.0.0.1:8851' }).runId).not.toBe(a.runId);
  });

  it('refuses anything but an http(s) stack URL', () => {
    expect(() => demoConfig({ url: 'file:///etc/passwd' })).toThrow(/http/);
    expect(() => demoConfig({})).toThrow(/--url/);
  });
});

describe('commentPasses', () => {
  // Replays the comments step: a pass adds the person's roots, then their replies under roots that exist, then
  // their reactions on messages that exist. Returns what is still missing after the passes.
  const missingAfter = (passes, threads) => {
    const have = new Set();
    for (const me of passes) {
      for (const t of threads) if (t.by === me) have.add(t.text);
      for (const t of threads) for (const r of t.replies ?? []) if (r.by === me && have.has(t.text)) have.add(r.text);
      for (const t of threads) {
        const messages = [t.text, ...(t.replies ?? []).map((r) => r.text)].filter((text) => have.has(text));
        for (const r of t.reactions ?? []) if (r.by === me && messages.some((text) => text.includes(r.on))) have.add(`${r.by}:${r.emoji}:${r.on}`);
      }
    }
    return threads.flatMap((t) => [t.text, ...(t.replies ?? []).map((r) => r.text), ...(t.reactions ?? []).map((r) => `${r.by}:${r.emoji}:${r.on}`)]).filter((x) => !have.has(x));
  };

  it('lands every root, reply and reaction in one run: a reaction on a later reply gets a pass after it', () => {
    expect(missingAfter(commentPasses(THREADS), THREADS)).toEqual([]);
  });

  it('adds no idle pass', () => {
    const passes = commentPasses(THREADS);
    for (let i = 0; i < passes.length; i += 1) expect(missingAfter(passes.toSpliced(i, 1), THREADS)).not.toEqual([]);
  });
});

describe('demoPrincipals', () => {
  it('derives each test principal from the prefix and secret: always @example.invalid, the same password every run', () => {
    const one = demoPrincipals({ prefix: 'demo', secret: 's3cret' });
    const two = demoPrincipals({ prefix: 'demo', secret: 's3cret' });
    expect(one.map((p) => p.label)).toEqual(['ada', 'ben']);
    for (const principal of one) {
      expect(principal.email).toMatch(/^demo-[a-z]+@example\.invalid$/);
      expect(principal.password.length).toBeGreaterThanOrEqual(24);
      expect(principal.password).not.toContain('s3cret');
    }
    expect(two).toEqual(one);
    expect(one[0].password).not.toBe(one[1].password);
    expect(demoPrincipals({ prefix: 'demo', secret: 'other' })[0].password).not.toBe(one[0].password);
  });

  it('refuses a prefix that could name a real address', () => {
    expect(() => demoPrincipals({ prefix: 'me@gmail.com', secret: 's' })).toThrow(/prefix/);
    expect(() => demoPrincipals({ prefix: '', secret: 's' })).toThrow(/prefix/);
    expect(() => demoPrincipals({ prefix: 'demo', secret: '' })).toThrow(/secret/);
  });
});

describe('writeDemoRun', () => {
  it('writes a running qa run for the remote stack, with the build it serves and private principals', () => {
    const runsDir = mkdtempSync(join(tmpdir(), 'demo-runs-'));
    dirs.push(runsDir);
    const principals = demoPrincipals({ prefix: 'demo', secret: 's' }).map((p, i) => ({ ...p, id: `u${i}` }));
    const dir = writeDemoRun({ runsDir, runId: 'demo-x', baseUrl: 'http://127.0.0.1:8851', version: { ...VERSION, extra: 1 }, principals });
    const state = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'));
    expect(state).toMatchObject({ runId: 'demo-x', status: 'running', baseUrl: 'http://127.0.0.1:8851', expected: VERSION });
    expect(JSON.parse(readFileSync(join(dir, 'principals.json'), 'utf8'))).toEqual(principals);
    expect(statSync(join(dir, 'principals.json')).mode & 0o777).toBe(0o600);
  });
});

describe('ensurePrincipal', () => {
  const principal = { label: 'ada', name: 'Ada', email: 'demo-ada@example.invalid', password: 'p'.repeat(24) };
  const fake = (answers) => {
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ path: new URL(url).pathname, body: JSON.parse(init.body) });
      const [status, body] = answers.shift();
      return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    };
    return { calls, fetchImpl };
  };

  it('signs in an existing principal and never signs it up again', async () => {
    const { calls, fetchImpl } = fake([[200, { user: { id: 'u1' } }]]);
    expect(await ensurePrincipal('http://h', principal, fetchImpl)).toBe('u1');
    expect(calls.map((c) => c.path)).toEqual(['/api/auth/sign-in/email']);
  });

  it('signs a new principal up', async () => {
    const { calls, fetchImpl } = fake([[401, {}], [200, { user: { id: 'u2' } }]]);
    expect(await ensurePrincipal('http://h', principal, fetchImpl)).toBe('u2');
    expect(calls.map((c) => c.path)).toEqual(['/api/auth/sign-in/email', '/api/auth/sign-up/email']);
    expect(calls[1].body).toEqual({ email: principal.email, password: principal.password, name: principal.name });
  });

  it('says the secret changed when the account exists under another password', async () => {
    const { fetchImpl } = fake([[401, {}], [422, { code: 'USER_ALREADY_EXISTS' }]]);
    await expect(ensurePrincipal('http://h', principal, fetchImpl)).rejects.toThrow(/secret/);
  });
});

describe('planNotes', () => {
  const workspace = {
    folders: [{ id: 'f1', name: 'Demo', path: 'Notes/Demo' }, { id: 'f2', name: 'Demo', path: 'Notes/Other/Demo' }],
    docs: [
      { id: 'd2', title: 'Launch plan', folderPath: 'Notes/Demo', createdAt: 2 },
      { id: 'd1', title: 'Launch plan', folderPath: 'Notes/Demo', createdAt: 1 },
      { id: 'd3', title: 'Every node', folderPath: 'Notes', createdAt: 1 },
    ],
  };

  it('finds the top-level folder and the oldest note of each title inside it', () => {
    expect(planNotes(workspace, 'Demo', ['Launch plan', 'Every node'])).toEqual({ folderId: 'f1', ids: { 'Launch plan': 'd1', 'Every node': null } });
  });

  it('plans everything when the folder is missing', () => {
    expect(planNotes({ folders: [], docs: [] }, 'Demo', ['Launch plan'])).toEqual({ folderId: null, ids: { 'Launch plan': null } });
  });
});

describe('commentGaps', () => {
  const wanted = [
    { by: 'ada', quote: 'cap', text: 'Root A', replies: [{ by: 'ben', text: 'Reply B' }, { by: 'ada', text: 'Reply A' }] },
    { by: 'ben', quote: 'GA', text: 'Root B', replies: [] },
  ];

  it('lists the roots and replies the note still lacks, a reply only once its root exists', () => {
    const listing = [
      { id: 'c1', parentId: null, text: 'Root A' },
      { id: 'c2', parentId: 'c1', text: 'Reply B' },
      { id: 'c3', parentId: null, text: 'Unrelated' },
      { id: 'c4', parentId: 'c3', text: 'Reply A' },
    ];
    expect(commentGaps(listing, wanted)).toEqual({
      roots: [{ by: 'ben', quote: 'GA', text: 'Root B' }],
      replies: [{ by: 'ada', root: 'Root A', rootId: 'c1', text: 'Reply A' }],
    });
  });

  it('lists nothing once every thread and reply is there', () => {
    const listing = [
      { id: 'c1', parentId: null, text: 'Root A' },
      { id: 'c2', parentId: 'c1', text: 'Reply B' },
      { id: 'c3', parentId: 'c1', text: 'Reply A' },
      { id: 'c5', parentId: null, text: 'Root B' },
    ];
    expect(commentGaps(listing, wanted)).toEqual({ roots: [], replies: [] });
  });
});

describe('versions and suggestions', () => {
  it('knows a named version by its name', () => {
    expect(hasVersion([{ kind: 'named', name: 'Outline' }, { kind: 'auto', name: null }], 'Outline')).toBe(true);
    expect(hasVersion([{ kind: 'auto', name: null }], 'Outline')).toBe(false);
  });

  it('knows a pending suggestion by its author', () => {
    const open = [{ id: 's1', author: { id: 'u2', name: 'Ben' }, status: 'open' }];
    expect(pendingBy(open, 'Ben')).toBe(true);
    expect(pendingBy(open, 'Demo agent')).toBe(false);
    expect(pendingBy([{ id: 's1', author: { id: 'u2', name: 'Ben' }, status: 'rejected' }], 'Ben')).toBe(false);
  });
});

describe('the demo content', () => {
  it('shows every node family moss has, media and a run-on-click HTML block', () => {
    const all = NOTES.map((note) => note.markdown).join('\n');
    for (const fence of ['```moss-chart', '```moss-canvas', '```moss-html', '```moss-callout', ':::tabs', '```ts', '| --- |', '{{']) {
      expect(all, fence).toContain(fence);
    }
    expect(all).toMatch(/<button[^>]*>/);
    expect(all).toMatch(/onclick|addEventListener\('click'/);
    expect(NOTES.flatMap((note) => note.media ?? []).map((file) => file.type).sort()).toEqual(['image/png', 'video/mp4']);
  });
});

describe('stepScript', () => {
  // A stand-in prelude: the qa.mjs helpers the steps call, as no-ops.
  const prelude = 'const STACK = {}, P = {}, DOM = {}, NAMES = {}, D = {}, MOD = "Meta"; async function actor() {} async function visit() {} async function shot() {}';
  const AsyncFunction = (async () => {}).constructor;

  it('compiles every step into one script that ends in its JSON result and holds no password', () => {
    const secret = demoPrincipals({ prefix: 'demo', secret: 's' })[0].password;
    for (const name of Object.keys(STEPS)) {
      const script = stepScript(name, { docId: 'd1' });
      expect(() => new AsyncFunction(`${prelude}\n${script}`), name).not.toThrow();
      expect(script.trimEnd().split('\n').at(-1).startsWith(`await STEPS[${JSON.stringify(name)}](`), name).toBe(true);
      expect(script).not.toContain(secret);
    }
    expect(() => stepScript('nope', {})).toThrow(/unknown step/);
  });
});

describe('docs/DEPLOY.md', () => {
  it('says how to build the demo on staging', () => {
    const text = readFileSync(new URL('../docs/DEPLOY.md', import.meta.url), 'utf8');
    expect(text).toMatch(/^## Demo content$/m);
    expect(text).toContain('node scripts/demo.mjs --url');
    expect(text).toContain('MOSS_DEMO_SECRET');
  });
});
