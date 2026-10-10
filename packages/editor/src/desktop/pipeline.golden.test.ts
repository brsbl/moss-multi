// Golden parity: for the same note and the same renderer state, the files the editor plans and the fixture host
// writes are byte for byte the files Moss desktop's own save path writes (desktop-save.ref.ts, verbatim at the
// pin): all four files, the folder name and the markdown file's name, on case-sensitive and case-insensitive
// volumes. The read side is held equal too: content after the read migrations, comments and layout.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemoryHost, MemoryVolume, seedNote } from '../testing/memory-host.js';
import { createDesktopSave, type RendererState } from './desktop-save.ref';
import { clock } from './note-store.port';
import { planSave, readNote, type RendererSnapshot } from './pipeline';

const NOW = 1_790_000_000;
const ID = '3f0c2a1b-4d5e-4f60-8a7b-9c0d1e2f3a4b';
const OTHER_ID = '7a6b5c4d-3e2f-4a1b-8c9d-0e1f2a3b4c5d';

const meta = (title: string, extra: Record<string, unknown> = {}, id = ID) => ({
  id,
  title,
  createdAt: 1_780_000_000,
  updatedAt: 1_780_000_100,
  stickyTabs: [],
  frontmatterMeta: {},
  folderPath: 'Notes/Projects',
  trashedAt: null,
  lastOpenedAt: 1_780_000_200,
  contentType: 'medium-text',
  ...extra,
});

const comment = (text: string, at = 1_780_000_300) => ({ text, createdAt: at, updatedAt: at, source: 'user' as const });

interface Seed {
  segments: string[];
  markdownName?: string;
  markdown: string;
  meta: Record<string, unknown> | string;
  comments?: string | null;
  layout?: string | null;
  assets?: Record<string, string>;
}

type Read = NonNullable<Awaited<ReturnType<ReturnType<typeof createDesktopSave>['getNote']>>>;

interface Scenario {
  name: string;
  caseInsensitive?: boolean;
  seeds: Seed[];
  /** Extra files outside note folders (siblings, other markdown). */
  files?: Record<string, string>;
  edit: (read: Read) => RendererState;
}

const state = (read: Read, overrides: Partial<RendererState>): RendererState => ({
  pendingContent: read.content,
  currentCommentMetadata: read.commentMetadata,
  currentLayoutMetadata: read.layoutMetadata ?? { version: 1, tableCount: 0, tables: [] },
  commentColorsSnapshot: read.commentColors ?? {},
  frontmatterMetaUpdatesSnapshot: {},
  ...overrides,
});

const LEGACY_FOOTER = `# Plan\n\nAlpha %%m:c1:start%%beta%%m:c1:end%% gamma\n\n<!--moss:comments\n${JSON.stringify({ c1: comment('From the footer') })}\n-->`;
const TABLE = '| A | B |\n| --- | --- |\n| 1 | 2 |\n';
const LONG_TITLE = `${'Ünïcödé planning notes for the quarter, '.repeat(8)}end`;

const SCENARIOS: Scenario[] = [
  {
    name: 'a body edit keeps unknown meta.json fields and stamps updatedAt',
    seeds: [{ segments: ['Notes', 'Projects', 'Plan'], markdown: '# Plan\n\nBody\n', meta: meta('Plan', { custom: { keep: true }, pinned: true, pinnedAt: 1_780_000_050 }) }],
    edit: (read) => state(read, { pendingContent: '# Plan\n\nBody, edited\n' }),
  },
  {
    name: 'a legacy comment footer is stripped and comments.json written',
    seeds: [{ segments: ['Notes', 'Projects', 'Plan'], markdown: LEGACY_FOOTER, meta: meta('Plan') }],
    edit: (read) => state(read, { pendingContent: '# Plan\n\nAlpha %%m:c1:start%%beta%%m:c1:end%% gamma, edited\n' }),
  },
  {
    name: 'a corrupt comments.json falls back to the footer',
    seeds: [{ segments: ['Notes', 'Projects', 'Plan'], markdown: LEGACY_FOOTER, meta: meta('Plan'), comments: '{"c1": {"text": ' }],
    edit: (read) => state(read, { pendingContent: '# Plan\n\nAlpha %%m:c1:start%%beta%%m:c1:end%% gamma!\n' }),
  },
  {
    name: 'a legacy mockup is inlined from its companion and saved migrated',
    seeds: [
      {
        segments: ['Notes', 'Projects', 'Plan'],
        markdown: '# Plan\n\nIntro\n\n![Landing](assets/landing-mockup.png)\n\nOutro\n',
        meta: meta('Plan'),
        assets: { 'landing-mockup.html': '<!doctype html><html><body><h1>Landing</h1></body></html>\n', 'landing-mockup.png': 'png' },
      },
    ],
    edit: (read) => state(read, { pendingContent: `${read.content}\nMore\n` }),
  },
  {
    name: 'a comment-only edit moves a legacy note.md to <folder>.md',
    seeds: [{ segments: ['Notes', 'Projects', 'Plan'], markdownName: 'note.md', markdown: '# Plan\n\nAlpha %%m:c1:start%%beta%%m:c1:end%%\n', meta: meta('Plan'), comments: JSON.stringify({ c1: comment('One') }) }],
    edit: (read) => state(read, { currentCommentMetadata: { c1: { ...comment('One'), text: 'One, edited', updatedAt: 1_780_000_900 } } }),
  },
  {
    name: 'a folder moved in Finder gets its real folderPath',
    seeds: [{ segments: ['Notes', 'Archive', '2026', 'Plan'], markdown: '# Plan\n\nBody\n', meta: meta('Plan', { folderPath: 'Notes/Projects' }) }],
    edit: (read) => state(read, { pendingContent: '# Plan\n\nBody, moved\n' }),
  },
  {
    name: 'a retitle into a taken name allocates "<name> (1)"',
    seeds: [
      { segments: ['Notes', 'Projects', 'Plan'], markdown: '# Plan\n\nBody\n', meta: meta('Plan') },
      { segments: ['Notes', 'Projects', 'Q3 Plan'], markdown: '# Q3 Plan\n\nOther\n', meta: meta('Q3 Plan', {}, OTHER_ID) },
    ],
    edit: (read) => state(read, { pendingContent: '# Q3 Plan\n\nBody\n' }),
  },
  {
    name: 'a case-only retitle on a case-insensitive volume',
    caseInsensitive: true,
    seeds: [{ segments: ['Notes', 'Projects', 'Plan'], markdown: '# Plan\n\nBody\n', meta: meta('Plan') }],
    edit: (read) => state(read, { pendingContent: '# plan\n\nBody\n' }),
  },
  {
    name: 'a case-only retitle on a case-sensitive volume',
    seeds: [{ segments: ['Notes', 'Projects', 'Plan'], markdown: '# Plan\n\nBody\n', meta: meta('Plan') }],
    edit: (read) => state(read, { pendingContent: '# plan\n\nBody\n' }),
  },
  {
    name: 'a case-variant plan.md beside a newer Other.md',
    caseInsensitive: true,
    seeds: [{ segments: ['Notes', 'Projects', 'Plan'], markdownName: 'plan.md', markdown: '# Plan\n\nThe real body\n', meta: meta('Plan') }],
    files: { '/Moss/Notes/Projects/Plan/Other.md': '# Other\n\nNewer\n' },
    edit: (read) => state(read, { pendingContent: '# Plan\n\nThe real body, edited\n' }),
  },
  {
    name: 'deleting the last colored comment deletes comments.json and writes commentColors {}',
    seeds: [
      {
        segments: ['Notes', 'Projects', 'Plan'],
        markdown: '# Plan\n\nAlpha %%m:c1:start%%beta%%m:c1:end%%\n',
        meta: meta('Plan', { commentColors: { c1: 2 }, nextCommentColorIndex: 3 }),
        comments: JSON.stringify({ c1: comment('Colored') }),
      },
    ],
    edit: (read) => state(read, { pendingContent: '# Plan\n\nAlpha beta\n', currentCommentMetadata: {}, commentColorsSnapshot: {} }),
  },
  {
    name: 'a title past 252 bytes truncates the folder name by UTF-8 bytes',
    seeds: [{ segments: ['Notes', 'Projects', 'Plan'], markdown: '# Plan\n\nBody\n', meta: meta('Plan') }],
    edit: (read) => state(read, { pendingContent: `# ${LONG_TITLE}\n\nBody\n` }),
  },
  {
    name: 'layout.json with widths is rebased when a table is added',
    seeds: [
      {
        segments: ['Notes', 'Projects', 'Plan'],
        markdown: `# Plan\n\n${TABLE}`,
        meta: meta('Plan'),
        layout: JSON.stringify({ version: 1, tableCount: 1, tables: [{ columnWidths: [120.4, 200] }] }, null, 2),
      },
    ],
    edit: (read) => state(read, { pendingContent: `# Plan\n\n${TABLE}\n${TABLE}` }),
  },
  {
    name: 'layout.json kept untouched widths through a body edit',
    seeds: [
      {
        segments: ['Notes', 'Projects', 'Plan'],
        markdown: `# Plan\n\n${TABLE}`,
        meta: meta('Plan'),
        layout: '{"version":1,"tableCount":1,"tables":[{"columnWidths":[120,200]}]}',
      },
    ],
    edit: (read) => state(read, { pendingContent: `# Plan\n\nIntro\n\n${TABLE}` }),
  },
  {
    name: 'a local width change writes layout.json',
    seeds: [{ segments: ['Notes', 'Projects', 'Plan'], markdown: `# Plan\n\n${TABLE}`, meta: meta('Plan') }],
    edit: (read) => state(read, { currentLayoutMetadata: { version: 1, tableCount: 1, tables: [{ columnWidths: [150, 260] }] } }),
  },
  {
    name: 'removing the last width deletes layout.json',
    seeds: [
      {
        segments: ['Notes', 'Projects', 'Plan'],
        markdown: `# Plan\n\n${TABLE}`,
        meta: meta('Plan'),
        layout: JSON.stringify({ version: 1, tableCount: 1, tables: [{ columnWidths: [120, 200] }] }, null, 2),
      },
    ],
    edit: (read) => state(read, { currentLayoutMetadata: { version: 1, tableCount: 1, tables: [{}] } }),
  },
  {
    name: 'sticky tabs, frontmatter provenance and frontmatter are normalized as desktop reads them',
    seeds: [
      {
        segments: ['Notes', 'Projects', 'Plan'],
        markdown: '---\nstatus: draft\ntags: [a, b]\n---\n# Plan\n\nBody\n',
        meta: meta('Plan', {
          stickyTabs: [
            { id: ' t1 ', status: 'completed', prompt: 'Summarize', createdAt: NOW - 100, completedAt: NOW - 50, responseSummary: 'Done', extra: 1 },
            { id: 't2', status: 'pending', prompt: 'Run', createdAt: NOW - 10 },
            { id: 't3', status: 'draft', createdAt: NOW - 5 },
          ],
          frontmatterMeta: { status: { source: 'user', lastModified: 1_780_000_000 }, ' bad ': { source: 'nope' } },
          collapsedHeadings: ['2:Intro:0'],
        }),
      },
    ],
    edit: (read) =>
      state(read, {
        pendingContent: '---\nstatus: draft\ntags: [a, b]\n---\n# Plan\n\nBody, edited\n',
        frontmatterMetaUpdatesSnapshot: { tags: { source: 'user', lastModified: NOW } },
      }),
  },
  {
    name: 'an unchanged note writes nothing',
    seeds: [{ segments: ['Notes', 'Projects', 'Plan'], markdown: '# Plan\n\nBody\n', meta: meta('Plan'), comments: JSON.stringify({}) }],
    edit: (read) => state(read, {}),
  },
];

function seedVolume(scenario: Scenario): MemoryVolume {
  const volume = new MemoryVolume({ caseInsensitive: scenario.caseInsensitive ?? false });
  for (const seed of scenario.seeds) seedNote(volume, seed.segments, seed);
  volume.silently(() => {
    for (const [path, text] of Object.entries(scenario.files ?? {})) volume.writeFile(path, text);
  });
  return volume;
}

const snapshotOf = (state: RendererState): RendererSnapshot => ({
  content: state.pendingContent,
  commentMetadata: state.currentCommentMetadata,
  layoutMetadata: state.currentLayoutMetadata,
  intents: {
    frontmatterMetaUpdates: state.frontmatterMetaUpdatesSnapshot as RendererSnapshot['intents']['frontmatterMetaUpdates'],
    commentColors: state.commentColorsSnapshot,
  },
});

/** What the goldens compare: every file under /Moss, byte for byte, by its spelled path. */
const compared = (volume: MemoryVolume) => volume.snapshot('/Moss');

async function editorRead(host: MemoryHost) {
  const disk = await host.read(ID);
  if (disk.kind !== 'note') throw new Error(`read: ${disk.kind}`);
  return readNote(disk, async (relativePath) => {
    const read = await host.readCompanion(ID, relativePath);
    return { text: read.kind === 'file' ? read.text : null, version: read.version };
  });
}

beforeEach(() => {
  clock.now = () => NOW;
});

afterEach(() => {
  clock.now = () => Math.floor(Date.now() / 1000);
});

describe('the editor writes what Moss desktop writes', () => {
  for (const scenario of SCENARIOS) {
    it(scenario.name, async () => {
      const desktopVolume = seedVolume(scenario);
      const desktop = createDesktopSave(desktopVolume);
      const record = await desktop.getNote(ID);
      if (!record) throw new Error('desktop could not read the note');
      const renderer = scenario.edit(record);
      const desktopWrote = await desktop.save(ID, record, renderer, NOW);

      const editorVolume = seedVolume(scenario);
      const host = new MemoryHost({ volume: editorVolume });
      const read = await editorRead(host);
      expect({ content: read.content, comments: read.commentMetadata, layout: read.layoutMetadata }).toEqual({
        content: record.content,
        comments: record.commentMetadata,
        layout: record.layoutMetadata,
      });
      const plan = planSave(read, snapshotOf(renderer), { now: NOW });
      expect(plan.kind === 'write').toBe(desktopWrote);
      if (plan.kind === 'write') {
        const result = await host.write(ID, plan.write);
        expect(result.kind).toBe('saved');
        expect(plan.write.ops.at(-1)?.file).toBe('meta');
      }

      // Every path is compared with its spelling, on both volumes: API 2's host keeps a same-file markdown entry's
      // spelling, as desktop's rename of a temp over the path does on APFS.
      expect(compared(editorVolume)).toEqual(compared(desktopVolume));
    });
  }
});

describe('the fixture host follows API 2 on a case-insensitive volume', () => {
  it('a case-only retitle keeps the markdown entry spelled as it was, and reports the candidate spelling', async () => {
    const scenario = SCENARIOS.find((candidate) => candidate.name === 'a case-only retitle on a case-insensitive volume')!;
    const volume = seedVolume(scenario);
    const host = new MemoryHost({ volume });
    const read = await editorRead(host);
    const plan = planSave(read, snapshotOf(scenario.edit({ content: read.content, commentMetadata: read.commentMetadata, layoutMetadata: read.layoutMetadata, commentColors: read.commentColors })), { now: NOW });
    if (plan.kind !== 'write') throw new Error('expected a write');
    await expect(host.write(ID, plan.write)).resolves.toMatchObject({ kind: 'saved', location: { folderName: 'plan', markdownName: 'plan.md' } });
    expect(Object.keys(volume.snapshot('/Moss')).filter((path) => path.endsWith('.md'))).toEqual(['/Moss/Notes/Projects/plan/Plan.md']);
  });
});

describe('golden fixtures prove something', () => {
  it('a meta.json that differs only in key order is caught (negative control)', async () => {
    const scenario = SCENARIOS[0];
    const desktopVolume = seedVolume(scenario);
    const desktop = createDesktopSave(desktopVolume);
    const record = (await desktop.getNote(ID))!;
    await desktop.save(ID, record, scenario.edit(record), NOW);
    const editorVolume = seedVolume(scenario);
    const host = new MemoryHost({ volume: editorVolume });
    const plan = planSave(await editorRead(host), snapshotOf(scenario.edit(record)), { now: NOW });
    if (plan.kind !== 'write') throw new Error('expected a write');
    await host.write(ID, plan.write);
    // The same save at the same time matches, so the reorder below is the only difference.
    expect(compared(editorVolume)).toEqual(compared(desktopVolume));
    const path = '/Moss/Notes/Projects/Plan/meta.json';
    const bytes = editorVolume.readFile(path);
    const parsed = JSON.parse(bytes) as Record<string, unknown>;
    const tail = bytes.endsWith('\n') ? '\n' : '';
    expect(JSON.stringify(parsed, null, 2) + tail).toBe(bytes);
    const reordered = JSON.stringify(Object.fromEntries(Object.entries(parsed).reverse()), null, 2) + tail;
    expect(JSON.parse(reordered)).toEqual(parsed);
    expect(reordered).not.toBe(bytes);
    editorVolume.silently(() => editorVolume.writeFile(path, reordered));
    expect(compared(editorVolume)).not.toEqual(compared(desktopVolume));
  });

  it('every write the editor plans sends meta.json last and only changed sidecars', async () => {
    const scenario = SCENARIOS[0];
    const host = new MemoryHost({ volume: seedVolume(scenario) });
    const read = await editorRead(host);
    const plan = planSave(read, snapshotOf({ ...scenario.edit({ content: read.content, commentMetadata: {}, layoutMetadata: undefined, commentColors: undefined }) }), { now: NOW });
    if (plan.kind !== 'write') throw new Error('expected a write');
    expect(plan.write.ops.map((op) => `${op.kind}:${op.file}`)).toEqual(['put:markdown', 'put:meta']);
    expect(plan.write.rename).toBeNull();
  });
});
