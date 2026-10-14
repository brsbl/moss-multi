import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { censusDiff, changedSuggestions, commentGaps, demoProblems, EVERY_NODE_FAMILIES, familyProblems, hasVersion, markdownBlocks, notePlan, panelProblems, partialMarkdown, pendingBy, planNotes, seenDiff, signatureProblems, verifiedShot } from '../e2e/qa/demo.js';
import { acquireDemoLock, AGENT, buildDemo, commentPasses, demoConfig, demoPrincipals, ensurePrincipal, NOTES, PEOPLE, stepScript, STEPS, THREADS, writeDemoRun } from './demo.mjs';
import { resumeProblems } from './demo-smoke.mjs';
import { returningLast } from './qa-puppeteer.mjs';

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

  it('refuses a prefix whose accounts the staging prune or the canary pool would take', () => {
    for (const prefix of ['mm', 'mm-demo', 'canary', 'canary-x']) {
      expect(() => demoPrincipals({ prefix, secret: 's' }), prefix).toThrow(/prefix/);
    }
    expect(demoPrincipals({ prefix: 'mmdemo', secret: 's' })[0].email).toBe('mmdemo-ada@example.invalid');
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

describe('the signature frame', () => {
  const want = { name: 'Ben Lindqvist', sentence: 'When three people open the same note at once', find: 'within a heartbeat', replace: 'in under a second' };
  const good = {
    docState: 'live',
    connection: 'online',
    binding: 'readonly',
    text: `${want.sentence}, each of them should see the others' cursors arrive ${want.find}${want.replace}, so that`,
    caretLabels: ['Ben Lindqvist'],
    richBlocks: 3,
  };
  // The frame PR #10 first carried: the title over an empty body, the pill saying "Connecting…".
  const blank = { docState: 'binding', connection: 'reconnecting', binding: null, text: '', caretLabels: [], richBlocks: 0 };

  it('passes a frame with the live note, the sentence, both halves of the suggestion, the caret label and rich blocks', () => {
    expect(signatureProblems(good, want)).toEqual([]);
  });

  it('refuses the blank "Connecting…" frame, naming what is missing', () => {
    const problems = signatureProblems(blank, want).join('; ');
    for (const word of ['binding', 'reconnecting', 'body', 'sentence', 'caret', 'rich']) expect(problems).toContain(word);
  });

  it('refuses a frame without the caret label or without the inserted words', () => {
    expect(signatureProblems({ ...good, caretLabels: [] }, want).join()).toMatch(/caret/);
    expect(signatureProblems({ ...good, text: good.text.replace(want.replace, '') }, want).join()).toMatch(/in under a second/);
  });
});

describe('verifiedShot', () => {
  const run = (frames, { attempts = 3, failPrepare = [] } = {}) => {
    const log = [];
    let n = 0;
    let shots = 0;
    const result = verifiedShot({
      attempts,
      prepare: async (attempt) => {
        log.push(`prepare ${attempt}`);
        if (failPrepare.includes(attempt)) throw new Error('caret never showed');
      },
      inspect: async () => frames[Math.min(n++, frames.length - 1)],
      problems: (frame) => (frame === 'ok' ? [] : [frame]),
      capture: async () => {
        shots += 1;
        log.push(`shot ${shots}`);
        return `shot-${shots}.png`;
      },
    });
    return { result, log };
  };

  it('returns the shot when the frame is right before and after it', async () => {
    expect(await run(['ok', 'ok']).result).toBe('shot-1.png');
  });

  it('never returns a shot taken while the frame went blank; it retakes it', async () => {
    const { result, log } = run(['ok', 'Connecting…', 'ok', 'ok']);
    expect(await result).toBe('shot-2.png');
    expect(log).toEqual(['prepare 1', 'shot 1', 'prepare 2', 'shot 2']);
  });

  it('does not shoot a frame that is wrong before the shot', async () => {
    const { result, log } = run(['Connecting…', 'ok', 'ok']);
    expect(await result).toBe('shot-1.png');
    expect(log).toEqual(['prepare 1', 'prepare 2', 'shot 1']);
  });

  it('retries an attempt whose preparation fails', async () => {
    expect(await run(['ok', 'ok'], { failPrepare: [1] }).result).toBe('shot-1.png');
  });

  it('fails, naming the problem, when no attempt gives the frame', async () => {
    await expect(run(['Connecting…']).result).rejects.toThrow(/Connecting…/);
  });
});

describe('panelProblems', () => {
  const card = (rows = 1) => ({ loading: false, failed: null, rows });

  it('passes the expected open cards, each showing its changes', () => {
    expect(panelProblems([card(), card(2), card()], 3)).toEqual([]);
  });

  it('refuses loading, failed or empty cards and a missing card', () => {
    expect(panelProblems([{ loading: true, failed: null, rows: 0 }, card(), card()], 3).join()).toMatch(/loading/);
    expect(panelProblems([{ loading: false, failed: 'The server could not be reached. Try again.', rows: 0 }, card(), card()], 3).join()).toMatch(/could not be reached/);
    expect(panelProblems([card(0), card(), card()], 3).join()).toMatch(/no change/);
    expect(panelProblems([card(), card()], 3).join()).toMatch(/2 of 3/);
  });
});

describe('changedSuggestions', () => {
  const s = (id, createdAt, updatedAt = createdAt) => ({ id, author: { id: 'u2', name: 'Ben' }, status: 'open', createdAt, updatedAt });

  it('finds nothing when the records are the same', () => {
    expect(changedSuggestions([s('a', 1), s('b', 2)], [s('b', 2), s('a', 1)])).toEqual([]);
  });

  it('finds a record the signature keystroke re-made or touched', () => {
    expect(changedSuggestions([s('a', 1), s('b', 2)], [s('a', 1), s('c', 9)])).toEqual(['b', 'c']);
    expect(changedSuggestions([s('a', 1)], [s('a', 1, 5)])).toEqual(['a']);
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

describe('the every-node note (B372)', () => {
  const every = NOTES.find((note) => note.key === 'every');

  it('holds a heading four, an embed pill and a web embed of a reserved example.com page', () => {
    expect(every.markdown).toMatch(/^#### \S/m);
    expect(every.markdown).toMatch(/ https:\/\/example\.com\/\w+ /);
    expect(every.markdown).toMatch(/^!\[\]\(https:\/\/example\.com\/\)$/m);
  });

  it('has the everyNode step require those families, and the media, by their rendered markers', () => {
    const selectors = Object.fromEntries(EVERY_NODE_FAMILIES.map((f) => [f.family, f.selector]));
    expect(selectors['heading 4']).toBe('h4');
    expect(selectors['embed pill']).toBe('[data-embed-pill-node-key]');
    expect(selectors['web embed']).toBe('[data-web-embed-node]');
    expect(selectors.image).toBe('img[src*="/assets/"]');
    expect(selectors.video).toBe('[data-video-node-kind="local"]');
    const all = Object.fromEntries(EVERY_NODE_FAMILIES.map((f) => [f.family, 1]));
    expect(familyProblems(all)).toEqual([]);
    expect(familyProblems({ ...all, 'heading 4': 0, 'web embed': 0, errors: 1 })).toEqual(['no heading 4', 'no web embed', '1 blocks show their error placeholder']);
  });
});

describe('resuming a note (B370)', () => {
  const every = NOTES.find((note) => note.key === 'every');
  const media = every.media;

  it('splits markdown at blank lines but never inside a fence or a ::: container', () => {
    const blocks = markdownBlocks('A\n\n```ts\nx\n\ny\n```\n\n:::tabs\n=== One\n\nbody\n:::\n\nB');
    expect(blocks).toEqual(['A', '```ts\nx\n\ny\n```', ':::tabs\n=== One\n\nbody\n:::', 'B']);
  });

  it('interrupts a paste at a block boundary, before the last line', () => {
    const partial = partialMarkdown(every.markdown);
    expect(every.markdown.startsWith(partial)).toBe(true);
    expect(partial.length).toBeLessThan(every.markdown.length);
    expect(partial).not.toContain(every.doneText);
    for (const fence of ['```', ':::']) expect(partial.split('\n').filter((line) => line.startsWith(fence)).length % 2).toBe(0);
  });

  it('pastes everything into a body that has only its title', () => {
    expect(notePlan({ empty: true, done: false, images: 0, videos: 0 }, { media })).toEqual({ clear: false, paste: true, media });
  });

  it('clears a partial paste and pastes it whole, with its media', () => {
    expect(notePlan({ empty: false, done: false, images: 0, videos: 0 }, { media })).toEqual({ clear: true, paste: true, media });
  });

  it('adds only the media a finished paste lacks', () => {
    expect(notePlan({ empty: false, done: true, images: 1, videos: 0 }, { media }).media.map((f) => f.name)).toEqual(['clip.mp4']);
    expect(notePlan({ empty: false, done: true, images: 0, videos: 1 }, { media }).media.map((f) => f.name)).toEqual(['pattern.png']);
  });

  it('changes nothing on a finished note, even one with later edits', () => {
    expect(notePlan({ empty: false, done: true, images: 1, videos: 1 }, { media, later: true })).toEqual({ clear: false, paste: false, media: [] });
  });

  it('refuses to clear a note that lacks its last line but has comments, suggestions or versions', () => {
    expect(() => notePlan({ empty: false, done: false, images: 0, videos: 0 }, { media, later: true })).toThrow(/edited after it was built/);
  });

  it('names each way a resumed note falls short of the uninterrupted one', () => {
    const census = { h1: 1, image: 1, video: 1, errors: 0 };
    const ok = {
      stop: 'paste',
      first: { id: 'd1', stopped: 'paste', changed: ['title', 'body'] },
      resumed: { id: 'd1', created: false, changed: ['body'] },
      again: { id: 'd1', created: false, changed: [] },
      reference: census,
      census,
      after: census,
    };
    expect(resumeProblems(ok)).toEqual([]);
    expect(resumeProblems({ ...ok, resumed: { id: 'd2', created: true, changed: ['title'] } }).join()).toMatch(/another note/);
    expect(resumeProblems({ ...ok, again: { id: 'd1', changed: ['clip.mp4'] } }).join()).toMatch(/changed clip\.mp4/);
    expect(resumeProblems({ ...ok, census: { ...census, h1: 2 } }).join()).toMatch(/h1: 1, got 2/);
    expect(resumeProblems({ ...ok, first: { ...ok.first, stopped: undefined } }).join()).toMatch(/stopped at the end/);
  });

  it('diffs two censuses by family', () => {
    expect(censusDiff({ a: 1, b: 2 }, { a: 1, b: 2 })).toEqual([]);
    expect(censusDiff({ a: 1, b: 2 }, { a: 2, c: 1 })).toEqual(['a: 1, got 2', 'b: 2, got 0', 'c: 0, got 1']);
  });
});

/** What a complete, duplicate-free demo looks like to the verify step. */
const COMPLETE = {
  titles: Object.fromEntries(NOTES.map((n) => [n.title, 1])),
  comments: Object.fromEntries(THREADS.flatMap((t) => [t.text, ...t.replies.map((r) => r.text)]).map((text) => [text, 1])),
  reactions: Object.fromEntries(THREADS.flatMap((t) => t.reactions).map((r) => [`${r.emoji} ${r.on}`, 1])),
  pending: { [PEOPLE.ben]: 1, [AGENT]: 1 },
  versions: { 'First outline': 1, 'Ready for review': 1 },
  viewLinks: 1,
  families: { ...Object.fromEntries(EVERY_NODE_FAMILIES.map((f) => [f.family, 1])), errors: 0 },
};
const WANT = {
  titles: NOTES.map((n) => n.title),
  comments: Object.keys(COMPLETE.comments),
  reactions: THREADS.flatMap((t) => t.reactions),
  pending: [PEOPLE.ben, AGENT],
  versions: ['First outline', 'Ready for review'],
  mediaNote: 'Every node family',
};

describe('demoProblems (B371)', () => {
  it('passes a demo holding exactly one of each thing it makes', () => {
    expect(demoProblems(COMPLETE, WANT)).toEqual([]);
  });

  it('names a duplicate or a missing note, comment, reaction, suggestion, version, link or media file', () => {
    const seen = {
      ...COMPLETE,
      titles: { ...COMPLETE.titles, 'Launch plan': 2 },
      comments: { ...COMPLETE.comments, [THREADS[0].replies[0].text]: 2 },
      reactions: {},
      pending: { [PEOPLE.ben]: 1 },
      versions: { 'First outline': 1 },
      viewLinks: 0,
      families: { ...COMPLETE.families, video: 0 },
    };
    const problems = demoProblems(seen, WANT).join('\n');
    const expected = [
      'note "Launch plan": 2',
      `comment "${THREADS[0].replies[0].text}": 2`,
      '👍',
      `pending suggestion by ${AGENT}: none`,
      'version "Ready for review": 0',
      'view link to the folder: 0',
      'video in "Every node family": 0',
      'no video',
    ];
    for (const text of expected) expect(problems).toContain(text);
  });

  it('takes one edit kept as several suggestion records, and flags a rerun that changed any tally', () => {
    const twice = { ...COMPLETE, pending: { [PEOPLE.ben]: 2, [AGENT]: 1 } };
    expect(demoProblems(twice, WANT)).toEqual([]);
    expect(seenDiff(twice, twice)).toEqual([]);
    expect(seenDiff(twice, { ...twice, pending: { [PEOPLE.ben]: 4, [AGENT]: 1 }, viewLinks: 2 })).toEqual([`pending ${PEOPLE.ben}: 2, got 4`, 'viewLinks: 1, got 2']);
  });
});

describe('the run lock (B373)', () => {
  const runsDir = () => {
    const dir = mkdtempSync(join(tmpdir(), 'demo-lock-'));
    dirs.push(dir);
    return dir;
  };

  it('lets one holder in at a time, and frees the lock on release', () => {
    const dir = runsDir();
    const release = acquireDemoLock({ runsDir: dir, runId: 'demo-x', prefix: 'demo' });
    expect(() => acquireDemoLock({ runsDir: dir, runId: 'demo-x', prefix: 'other' })).toThrow(/another demo run holds demo-x \(pid \d+ on .+, prefix demo/);
    expect(() => acquireDemoLock({ runsDir: dir, runId: 'demo-y', prefix: 'demo' })()).not.toThrow();
    release();
    expect(existsSync(join(dir, 'demo-x.lock'))).toBe(false);
    acquireDemoLock({ runsDir: dir, runId: 'demo-x', prefix: 'other' })();
  });

  it("takes over a lock whose process on this host is gone, but not a live one's or another host's", () => {
    const dir = runsDir();
    const path = join(dir, 'demo-x.lock');
    writeFileSync(path, JSON.stringify({ pid: 4242, host: 'here', prefix: 'demo', startedAt: 'then' }));
    expect(() => acquireDemoLock({ runsDir: dir, runId: 'demo-x', prefix: 'demo', host: 'here', alive: () => true })).toThrow(/pid 4242/);
    expect(() => acquireDemoLock({ runsDir: dir, runId: 'demo-x', prefix: 'demo', host: 'elsewhere', alive: () => false })).toThrow(/pid 4242/);
    const release = acquireDemoLock({ runsDir: dir, runId: 'demo-x', prefix: 'demo', host: 'here', pid: 7, alive: () => false });
    expect(JSON.parse(readFileSync(path, 'utf8')).pid).toBe(7);
    release();
  });

  it('treats an unreadable lock as held', () => {
    const dir = runsDir();
    writeFileSync(join(dir, 'demo-x.lock'), '{');
    expect(() => acquireDemoLock({ runsDir: dir, runId: 'demo-x', prefix: 'demo' })).toThrow(/unreadable lock/);
  });

  it('never removes a lock another run holds when it releases', () => {
    const dir = runsDir();
    const release = acquireDemoLock({ runsDir: dir, runId: 'demo-x', prefix: 'demo' });
    writeFileSync(join(dir, 'demo-x.lock'), JSON.stringify({ pid: 1, host: 'elsewhere', prefix: 'demo', startedAt: 'now' }));
    release();
    expect(existsSync(join(dir, 'demo-x.lock'))).toBe(true);
  });
});

/**
 * A stack and `bb browser-automation` faked in-process for buildDemo: `/api/version` and sign-in answer, each step
 * returns what it returns on a complete demo, and `gate` holds the first step open.
 */
function fakeStack({ gate = null, seen = { ...COMPLETE, pending: { [PEOPLE.ben]: 1 } } } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const path = new URL(url).pathname;
    calls.push(`fetch ${path}`);
    const body = path === '/api/version' ? VERSION : { user: { id: `u-${JSON.parse(init.body).email}` } };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const results = {
    folder: { folderId: 'f1', created: true },
    note: { id: 'd1', created: true, changed: ['title', 'body'] },
    version: { created: true },
    share: { shared: true, invite: null, link: 'http://127.0.0.1:8851/f/f1?share=t', linkCreated: true },
    comments: { roots: 1, replies: 1, reactions: 1 },
    suggest: { created: true },
    signature: { shot: 'signature.png' },
    everyNode: { shots: ['every.png'], census: seen.families },
    review: { shots: [] },
    history: { shot: 'history.png' },
    visitor: { shot: 'link.png' },
    verify: { seen },
  };
  const bb = async (args) => {
    calls.push(args[0]);
    if (args[0] === 'open') return { id: 'session-1' };
    if (args[0] === 'list') return [];
    if (args[0] === 'close') return { closed: args[1] };
    const script = readFileSync(args[args.indexOf('--script-file') + 1], 'utf8');
    const name = /await STEPS\["(\w+)"\]/.exec(script.trimEnd().split('\n').at(-1))[1];
    if (gate && name === 'folder') await gate;
    return { text: JSON.stringify(results[name]), exitCode: 0 };
  };
  return { calls, fetchImpl, bb };
}

describe('buildDemo against one stack (B373)', () => {
  const STACK_URL = 'http://127.0.0.1:8851';
  const RUN = 'demo-127.0.0.1-8851';
  const run = (stack, runsDir, prefix) => buildDemo({ url: STACK_URL, prefix, 'skip-agent': true }, { runsDir, secret: 's', fetch: stack.fetchImpl, bb: stack.bb, log: () => {} });

  it('lets one of two overlapping runs proceed; the other, with either prefix, fails without touching its state or session', async () => {
    const runsDir = mkdtempSync(join(tmpdir(), 'demo-runs-'));
    dirs.push(runsDir);
    let open;
    const first = fakeStack({ gate: new Promise((resolve) => (open = resolve)) });
    const running = run(first, runsDir, 'demo');
    for (let i = 0; i < 250 && !first.calls.includes('run'); i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
    expect(first.calls).toContain('run');
    const files = ['state.json', 'principals.json', 'qa.json'];
    const snapshot = () => files.map((name) => readFileSync(join(runsDir, RUN, name), 'utf8'));
    const before = snapshot();

    for (const prefix of ['other', 'demo']) {
      const second = fakeStack();
      await expect(run(second, runsDir, prefix)).rejects.toThrow(/another demo run holds demo-127\.0\.0\.1-8851/);
      expect(second.calls, `prefix ${prefix}: no request and no session`).toEqual([]);
    }
    expect(snapshot()).toEqual(before);

    open();
    expect((await running).changes.length).toBeGreaterThan(0);
    expect(first.calls.filter((c) => c === 'close')).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(runsDir, RUN, 'state.json'), 'utf8')).status).toBe('done');

    const later = fakeStack();
    await expect(run(later, runsDir, 'other')).resolves.toMatchObject({ baseUrl: STACK_URL, folderLink: 'http://127.0.0.1:8851/f/f1?share=t' });
    expect(existsSync(join(runsDir, `${RUN}.lock`))).toBe(false);
  });

  it('fails a run whose demo holds a duplicate, and releases the lock', async () => {
    const runsDir = mkdtempSync(join(tmpdir(), 'demo-runs-'));
    dirs.push(runsDir);
    const doubled = fakeStack({ seen: { ...COMPLETE, pending: { [PEOPLE.ben]: 1 }, comments: { ...COMPLETE.comments, [THREADS[0].text]: 2 } } });
    await expect(run(doubled, runsDir, 'demo')).rejects.toThrow(/exactly one of each thing it makes: comment .*: 2, not 1/);
    expect(existsSync(join(runsDir, `${RUN}.lock`))).toBe(false);
  });
});

describe('the puppeteer driver', () => {
  it("returns a script's last expression, as bb prints it", () => {
    expect(returningLast('const a = 1;\nawait STEPS["note"]({"x":1})\n')).toBe('const a = 1;\nreturn (await STEPS["note"]({"x":1}));');
    expect(returningLast('const page = 1;\n({ url: 1 })')).toBe('const page = 1;\nreturn (({ url: 1 }));');
    expect(returningLast('const a = 1;\n}')).toBe('const a = 1;\n}');
  });
});
