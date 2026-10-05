// Golden parity: every helper in moss-editor-host.js against Moss desktop's own code at the pin
// (moss-desktop.ref.ts, ported verbatim), over a table of tricky names.
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { MossEditorHostModule, MossFolderEntry } from '../contract';
import * as host from './moss-editor-host.js';
import {
  ALLOWED_IMAGE_EXTENSIONS,
  ALLOWED_VIDEO_EXTENSIONS,
  assertValidNoteId,
  buildImageFilename,
  createDesktopRef,
  isSafeFilename,
  persistFileTempName,
  toFolderBaseName,
  truncateToByteLimit,
  type RefFs,
} from './moss-desktop.ref';

const typed: MossEditorHostModule = host;

const bytes = (value: string) => Buffer.byteLength(value, 'utf8');

const NAMES: readonly string[] = [
  'Plan',
  'plan',
  'PLAN',
  'Q3 Plan',
  'Café',
  'Cafe\u0301',
  '日本語のノート',
  '📝 Notes',
  'Straße',
  '..',
  '.',
  '...',
  '.hidden',
  '..md',
  'a..b',
  'Wait...',
  'a/b',
  'a\\b',
  '/abs',
  'a\u0000b',
  'tab\tname',
  'line\nbreak',
  '  spaced  ',
  'Plan ',
  ' Plan',
  'CON',
  'nul',
  'aux.txt',
  'node_modules',
  '__pycache__',
  'bower_components',
  '<>:"|?*',
  'fullwidth\uFF0Edot',
  '\uFF0Eleading',
  '\u00A0nbsp',
  '\uFEFFbom',
  'lone\uD800surrogate',
  'ends with \uFFFD',
  '',
  ' ',
  'Untitled',
  'x'.repeat(252),
  'x'.repeat(253),
  'x'.repeat(300),
  'é'.repeat(126),
  'é'.repeat(127),
  '日'.repeat(84),
  '日'.repeat(85),
  `${'日'.repeat(83)}ab`,
  `${'日'.repeat(83)} a`,
  '😀'.repeat(63),
  '😀'.repeat(64),
  `${'a'.repeat(250)}😀`,
  `${'a'.repeat(247)} 😀x`,
];

// A directory listing can only hold names without a separator or NUL.
const LISTABLE = NAMES.filter((name) => !name.includes('/') && !name.includes('\u0000') && name !== '' && name !== '.' && name !== '..');

const IDS: readonly unknown[] = [
  '0f8fad5b-d9cb-469f-a165-70867728950e',
  '0F8FAD5B-D9CB-469F-A165-70867728950E',
  '  0f8fad5b-d9cb-469f-a165-70867728950e\n',
  '0f8fad5b-d9cb-469f-a165-70867728950',
  '0f8fad5b-d9cb-469f-a165-70867728950e0',
  'g0f8fad5-d9cb-469f-a165-70867728950e',
  '0f8fad5bd9cb469fa16570867728950e',
  '',
  '   ',
  '../0f8fad5b-d9cb-469f-a165-70867728950e',
  42,
  null,
];
const ID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const OTHER_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const UUID = '1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed';

const ROOT = '/w/Moss';
const NOTES = `${ROOT}/Notes`;

/** An in-memory volume; case- and normalization-insensitive like default APFS when `ci` is set. */
function memoryFs(ci: boolean) {
  const key = (path: string) => (ci ? path.normalize('NFD').toLowerCase() : path);
  const files = new Map<string, { path: string; text: string; mtimeMs: number }>();
  const dirs = new Map<string, string>();
  const addDir = (path: string) => {
    for (let at = path.indexOf('/', 1); at !== -1; at = path.indexOf('/', at + 1)) {
      if (!dirs.has(key(path.slice(0, at)))) dirs.set(key(path.slice(0, at)), path.slice(0, at));
    }
    if (!dirs.has(key(path))) dirs.set(key(path), path);
  };
  const fs: RefFs & { file(path: string, text?: string, mtimeMs?: number): void; dir(path: string): void } = {
    file(path, text = '', mtimeMs = 1) {
      addDir(path.slice(0, path.lastIndexOf('/')));
      files.set(key(path), { path, text, mtimeMs });
    },
    dir: addDir,
    exists: (path) => files.has(key(path)) || dirs.has(key(path)),
    readdir(dir) {
      const prefix = `${key(dir)}/`;
      const out: Array<{ name: string; isFile(): boolean }> = [];
      for (const [k, file] of files) {
        if (k.startsWith(prefix) && !k.slice(prefix.length).includes('/')) out.push({ name: file.path.slice(dir.length + 1), isFile: () => true });
      }
      for (const [k, path] of dirs) {
        if (k.startsWith(prefix) && !k.slice(prefix.length).includes('/')) out.push({ name: path.slice(dir.length + 1), isFile: () => false });
      }
      return out;
    },
    mtimeMs(path) {
      const file = files.get(key(path));
      if (!file) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return file.mtimeMs;
    },
    readFile(path) {
      const file = files.get(key(path));
      if (!file) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return file.text;
    },
  };
  return fs;
}

const meta = (id: string, title = 'T') => JSON.stringify({ id, title });

describe('moss-editor-host.js is one self-contained module', () => {
  const source = readFileSync(new URL('./moss-editor-host.js', import.meta.url), 'utf8');

  it('has no imports, no require and no globals beyond crypto.subtle and TextEncoder/TextDecoder', () => {
    expect(source).not.toMatch(/^\s*import[\s{*]/m);
    expect(source).not.toMatch(/\bimport\s*\(/);
    expect(source).not.toMatch(/\brequire\s*\(/);
    expect(source).not.toMatch(/\b(?:process|Buffer|window|document|navigator)\b/);
  });

  it('exports the API version and identity', () => {
    expect(typed.MOSS_EDITOR_API).toBe(1);
    expect(typed.MOSS_EDITOR_INFO).toEqual({ api: 1, version: '0.0.1', features: [] });
    expect(typed.MOSS_NOTE_FILES.notesRoot).toBe('Notes');
  });
});

describe('note ids', () => {
  it.each(IDS.map((id): [string, unknown] => [JSON.stringify(id), id]))('%s: isMossNoteId and noteIdKey match assertValidNoteId', (_label, id) => {
    const expected = (() => {
      try {
        return assertValidNoteId(id);
      } catch {
        return null;
      }
    })();
    expect(typed.isMossNoteId(id as string)).toBe(expected !== null);
    if (expected !== null) expect(typed.noteIdKey(id as string)).toBe(expected);
  });

  it('noteIdKey is the trimmed exact id: case is preserved, never lowercased', () => {
    expect(typed.noteIdKey(' 0F8FAD5B-D9CB-469F-A165-70867728950E ')).toBe('0F8FAD5B-D9CB-469F-A165-70867728950E');
    expect(typed.noteIdKey('0F8FAD5B-D9CB-469F-A165-70867728950E')).not.toBe(typed.noteIdKey(ID));
  });
});

describe('markdown resolution', () => {
  const dir = `${NOTES}/Folder`;

  it.each(LISTABLE.map((name) => [name]))('candidates for folder %j match getContentPathCandidates', (folderName) => {
    const ref = createDesktopRef(memoryFs(false), { workspaceRoot: ROOT, activeNotesRoot: NOTES });
    for (const noteId of [ID, ` ${ID} `, ID.toUpperCase()]) {
      const ours = typed.markdownCandidates({ folderName, noteId }).map((name) => join(dir, name));
      expect(ours).toEqual(ref.getContentPathCandidates(dir, folderName, noteId));
    }
  });

  // Each scenario: files in the note folder (name, mtime), folder name, and the volume's case rule.
  const SCENARIOS: Array<{ label: string; folder: string; files: Array<[string, number]>; dirs?: string[] }> = [
    { label: 'folder-named file', folder: 'Plan', files: [['Plan.md', 1], ['note.md', 9]] },
    { label: 'case variant beside a newer file', folder: 'Plan', files: [['plan.md', 1], ['Other.md', 9]] },
    { label: 'id-named file', folder: 'Plan', files: [[`${ID}.md`, 1], ['note.md', 2]] },
    { label: 'upper-case id file', folder: 'Plan', files: [[`${ID.toUpperCase()}.md`, 1]] },
    { label: 'legacy note.md', folder: 'Plan', files: [['note.md', 1], ['Other.md', 5]] },
    { label: 'NOTE.MD', folder: 'Plan', files: [['NOTE.MD', 1], ['Other.md', 5]] },
    { label: 'only one stray markdown', folder: 'Plan', files: [['Stray.markdown', 1]] },
    { label: 'newest wins', folder: 'Plan', files: [['a.md', 1], ['b.md', 3], ['c.MD', 2]] },
    { label: 'mtime tie by localeCompare', folder: 'Plan', files: [['b.md', 5], ['a.md', 5], ['B.md', 5], ['á.md', 5]] },
    { label: 'dot names', folder: 'Plan', files: [['.md', 9], ['..md', 1], ['a.md.txt', 9], ['x.markdown', 0]] },
    { label: 'directories are not markdown', folder: 'Plan', files: [['z.txt', 1]], dirs: ['dir.md'] },
    { label: 'nothing', folder: 'Plan', files: [] },
    { label: 'trimmed folder name', folder: ' Plan ', files: [['Plan.md', 1], ['Zed.md', 4]] },
    { label: 'NFD file in an NFC folder', folder: 'Café', files: [['Cafe\u0301.md', 1], ['Other.md', 4]] },
    { label: 'unicode', folder: '日本語のノート', files: [['日本語のノート.md', 1]] },
  ];

  for (const ci of [false, true]) {
    it.each(SCENARIOS.map((scenario): [string, (typeof SCENARIOS)[number]] => [scenario.label, scenario]))(`${ci ? 'case-insensitive' : 'case-sensitive'}: %s`, async (_label, scenario) => {
      const fs = memoryFs(ci);
      const folderDir = `${NOTES}/${scenario.folder}`;
      fs.dir(folderDir);
      for (const [name, mtimeMs] of scenario.files) fs.file(`${folderDir}/${name}`, '', mtimeMs);
      for (const name of scenario.dirs ?? []) fs.dir(`${folderDir}/${name}`);
      const ref = createDesktopRef(fs, { workspaceRoot: ROOT, activeNotesRoot: NOTES });
      const expected = await ref.resolveContentPathForRead(folderDir, scenario.folder, ID);

      // The host's side: probe the candidates in order, else list and pick.
      let ours: string | null = typed.markdownCandidates({ folderName: scenario.folder, noteId: ID }).find((name) => fs.exists(`${folderDir}/${name}`)) ?? null;
      if (ours === null) {
        const entries: MossFolderEntry[] = fs.readdir(folderDir).map((entry) => ({
          name: entry.name,
          isFile: entry.isFile(),
          mtimeMs: entry.isFile() ? fs.mtimeMs(`${folderDir}/${entry.name}`) : 0,
        }));
        ours = typed.pickMarkdownFallback(entries);
      }
      expect(ours === null ? undefined : `${folderDir}/${ours}`).toBe(expected);
    });
  }

  it('pickMarkdownFallback reads plan.md beside a newer Other.md only when no candidate exists', () => {
    expect(typed.pickMarkdownFallback([])).toBeNull();
    expect(typed.pickMarkdownFallback([{ name: 'x.md', isFile: false, mtimeMs: 1 }])).toBeNull();
    expect(typed.pickMarkdownFallback([{ name: 'plan.md', isFile: true, mtimeMs: 1 }, { name: 'Other.md', isFile: true, mtimeMs: 2 }])).toBe('Other.md');
  });
});

describe('allocateFolderName', () => {
  const passes = (name: string) => {
    try {
      return typed.isMossFolderName(name);
    } catch {
      return false;
    }
  };
  const desiredNames = [...new Set(NAMES.map((title) => toFolderBaseName(title)))].filter(passes);

  it('the table yields a spread of valid desired names', () => {
    expect(desiredNames.length).toBeGreaterThan(20);
    expect(desiredNames).toContain('日'.repeat(84));
  });

  type Layout = { label: string; current: string; siblings: Array<string | { file: string } | { note: string; id: string }> };
  const layouts = (desired: string): Layout[] => [
    { label: 'free', current: 'Old', siblings: [] },
    { label: 'unchanged', current: desired, siblings: [] },
    { label: 'case-only retitle', current: desired.toUpperCase() === desired ? desired.toLowerCase() : desired.toUpperCase(), siblings: [] },
    { label: 'taken by another note', current: 'Old', siblings: [{ note: desired, id: OTHER_ID }] },
    { label: 'taken twice', current: 'Old', siblings: [{ note: desired, id: OTHER_ID }, `${truncateToByteLimit(desired, 248)} (1)`] },
    { label: 'taken in another case', current: 'Old', siblings: [{ note: desired.toLowerCase(), id: OTHER_ID }] },
    { label: 'taken in another normalization', current: 'Old', siblings: [desired.normalize('NFD')] },
    { label: 'taken by a file', current: 'Old', siblings: [{ file: desired }] },
    { label: 'taken by a folder without meta', current: 'Old', siblings: [desired, `${truncateToByteLimit(desired, 248)} (1)`, `${truncateToByteLimit(desired, 248)} (2)`] },
    { label: 'own folder is (1)', current: `${truncateToByteLimit(desired, 248)} (1)`, siblings: [{ note: desired, id: OTHER_ID }] },
  ];

  for (const ci of [false, true]) {
    it.each(desiredNames.map((name) => [name]))(`${ci ? 'case-insensitive' : 'case-sensitive'}: %j matches allocateFolder`, async (desiredName) => {
      for (const layout of layouts(desiredName)) {
        const fs = memoryFs(ci);
        const parent = `${NOTES}/Projects`;
        fs.file(`${parent}/${layout.current}/meta.json`, meta(ID));
        for (const sibling of layout.siblings) {
          if (typeof sibling === 'string') fs.dir(`${parent}/${sibling}`);
          else if ('file' in sibling) fs.file(`${parent}/${sibling.file}`);
          else fs.file(`${parent}/${sibling.note}/meta.json`, meta(sibling.id));
        }
        // The host lists the parent; the volume holds one entry per name it tells apart.
        const listed = fs.readdir(parent).map((entry) => entry.name).filter((name) => name !== layout.current);
        const ref = createDesktopRef(fs, { workspaceRoot: ROOT, activeNotesRoot: NOTES });
        const expected = (await ref.allocateFolder(desiredName, { noteId: ID, targetRoot: parent })).folderName;
        const ours = typed.allocateFolderName({ desiredName, currentName: layout.current, siblingNames: listed, caseInsensitive: ci });
        expect({ layout: layout.label, name: ours }).toEqual({ layout: layout.label, name: expected });
        expect(bytes(ours)).toBeLessThanOrEqual(252);
      }
    });
  }

  it('truncates a 252-byte multibyte name by bytes and drops the partial character before the suffix', () => {
    const desiredName = '日'.repeat(84);
    expect(typed.allocateFolderName({ desiredName, currentName: 'Old', siblingNames: [desiredName], caseInsensitive: false })).toBe(`${'日'.repeat(82)} (1)`);
  });

  it('refuses a desired name that fails the sanitizer', () => {
    for (const desiredName of ['..', '.hidden', 'a/b', 'a\u0000b', 'node_modules', 'x'.repeat(253), '']) {
      expect(() => typed.allocateFolderName({ desiredName, currentName: 'Old', siblingNames: [], caseInsensitive: false })).toThrow();
    }
  });
});

describe('folderPathFor', () => {
  const cases: string[][] = [
    ['Notes', 'Plan'],
    ['Notes', 'Projects', 'Plan'],
    ['Notes', ' Pro jects ', 'Plan'],
    ['Notes', 'a\\b', 'Plan'],
    ['Notes', '日本語', 'Café', 'Plan'],
    ['Trash', 'Old'],
    ['Notes', 'Trash', 'Old'],
    ['Notes'],
    ['Plan'],
  ];
  it.each(cases.map((segments): [string, string[]] => [segments.join('/'), segments]))('%s matches resolveFolderPathForDirectory', (_label, segments) => {
    const ref = createDesktopRef(memoryFs(false), { workspaceRoot: ROOT, activeNotesRoot: NOTES });
    expect(typed.folderPathFor(segments)).toBe(ref.resolveFolderPathForDirectory(join(ROOT, ...segments)));
  });
});

describe('sidecarFileName', () => {
  it.each(LISTABLE.map((name) => [name]))('%j matches persistFile and fits 255 bytes', (name) => {
    for (const target of [name, `${name}.md`, 'meta.json', `${toFolderBaseName(name)}.md`]) {
      const tmp = typed.sidecarFileName(target, UUID, 'tmp');
      expect(tmp).toBe(persistFileTempName(join(NOTES, 'Folder', target), UUID));
      expect(bytes(tmp)).toBeLessThanOrEqual(255);
      const displaced = typed.sidecarFileName(target, UUID, 'displaced');
      const base = truncateToByteLimit(target, 255 - 1 - bytes(`.${UUID}.displaced`)) || 'note';
      expect(displaced).toBe(`.${base}.${UUID}.displaced`);
      expect(bytes(displaced)).toBeLessThanOrEqual(255);
    }
  });

  it('keeps a 252-byte multibyte folder name under the limit, trimming the partial character', () => {
    const tmp = typed.sidecarFileName(`${'日'.repeat(84)}.md`, UUID, 'tmp');
    expect(tmp).toBe(`.${'日'.repeat(71)}.${UUID}.tmp`);
  });
});

describe('versionToken', () => {
  const reference = (parts: Array<{ role: string; bytes: Uint8Array | null }>) => {
    const digest = createHash('sha256');
    for (const part of parts) {
      digest.update(Buffer.from(part.role, 'utf8')).update(Buffer.from([0]));
      if (part.bytes === null) digest.update('-');
      else digest.update(String(part.bytes.byteLength)).update(Buffer.from([0])).update(part.bytes);
      digest.update(Buffer.from([0]));
    }
    return `sha256:${digest.digest('hex')}`;
  };
  const enc = (text: string) => new TextEncoder().encode(text);

  it('is sha256 over the framed parts, with absent distinct from empty', async () => {
    const sets = [
      [],
      [{ role: 'markdown', bytes: enc('# Plan\n') }, { role: 'comments', bytes: null }, { role: 'layout', bytes: null }],
      [{ role: 'markdown', bytes: enc('# Plan\n') }, { role: 'comments', bytes: new Uint8Array() }, { role: 'layout', bytes: null }],
      [{ role: 'meta', bytes: enc('{"id":"x"}') }, { role: 'folderPath', bytes: enc('Notes/日本語') }],
      [{ role: 'companion', bytes: new Uint8Array([0, 255, 0x2d]) }],
    ];
    const tokens = await Promise.all(sets.map((parts) => typed.versionToken(parts)));
    expect(tokens).toEqual(sets.map(reference));
    expect(new Set(tokens).size).toBe(tokens.length);
    expect(tokens[0]).toBe('sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });
});

describe('noteEditability', () => {
  const ok = meta(ID, 'Plan');
  const cases: Array<[string, string[] | null, string | null, boolean, string]> = [
    ['adopted note', ['Notes', 'Plan'], ok, true, 'editable'],
    ['nested note', ['Notes', 'Projects', 'Plan'], ok, true, 'editable'],
    ['user folder named Trash', ['Notes', 'Trash', 'Plan'], ok, true, 'editable'],
    ['upper-case id', ['Notes', 'Plan'], meta(ID.toUpperCase(), 'Plan'), true, 'editable'],
    ['outside the workspace', null, ok, true, 'outsideNotes'],
    ['the Notes root', ['Notes'], ok, true, 'outsideNotes'],
    ['loose folder in the workspace', ['Other', 'Plan'], ok, true, 'outsideNotes'],
    ['Moss Trash', ['Trash', 'Plan'], ok, true, 'trashed'],
    ['trashedAt', ['Notes', 'Plan'], JSON.stringify({ id: ID, title: 'Plan', trashedAt: 1700000000 }), true, 'trashed'],
    ['Notes/External mirror', ['Notes', 'External', 'Plan'], ok, true, 'external'],
    ['systemNoteType external', ['Notes', 'Plan'], JSON.stringify({ id: ID, title: 'Plan', systemNoteType: 'external' }), true, 'external'],
    ['externalFilePath', ['Notes', 'Plan'], JSON.stringify({ id: ID, title: 'Plan', externalFilePath: '/x/a.md' }), true, 'external'],
    ['no meta.json', ['Notes', 'Plan'], null, true, 'unadopted'],
    ['no title', ['Notes', 'Plan'], JSON.stringify({ id: ID }), true, 'unadopted'],
    ['empty title', ['Notes', 'Plan'], meta(ID, ''), true, 'unadopted'],
    ['empty id', ['Notes', 'Plan'], meta('', 'Plan'), true, 'unadopted'],
    ['invalid id', ['Notes', 'Plan'], meta('not-a-uuid', 'Plan'), true, 'unadopted'],
    ['padded id', ['Notes', 'Plan'], meta(` ${ID}`, 'Plan'), true, 'unadopted'],
    ['numeric id', ['Notes', 'Plan'], JSON.stringify({ id: 7, title: 'Plan' }), true, 'unadopted'],
    ['not JSON', ['Notes', 'Plan'], '{', true, 'unreadableMeta'],
    ['BOM before JSON', ['Notes', 'Plan'], `\uFEFF${ok}`, true, 'unreadableMeta'],
    ['JSON null', ['Notes', 'Plan'], 'null', true, 'unreadableMeta'],
    ['JSON array', ['Notes', 'Plan'], '[]', true, 'unreadableMeta'],
    ['no markdown', ['Notes', 'Plan'], ok, false, 'noMarkdown'],
  ];

  it.each(cases)('%s', async (_label, workspaceSegments, metaText, hasMarkdown, expected) => {
    const result = typed.noteEditability({ workspaceSegments, metaText, hasMarkdown });
    expect(result.kind === 'editable' ? 'editable' : result.reason).toBe(expected);
    if (result.kind === 'editable') {
      // Editable only where desktop's readMetadata accepts the meta.json and its id is a valid, exact key.
      const fs = memoryFs(false);
      fs.file(`${NOTES}/Plan/meta.json`, metaText ?? '');
      const accepted = await createDesktopRef(fs, { workspaceRoot: ROOT, activeNotesRoot: NOTES }).readMetadata(`${NOTES}/Plan/meta.json`);
      expect(accepted).toBeDefined();
      expect(assertValidNoteId(accepted!.metadata.id)).toBe(accepted!.metadata.id);
    }
  });
});

describe('filename sanitizer', () => {
  const EXCLUDED = new Set(['node_modules', '__pycache__', 'bower_components']);

  it.each(NAMES.map((name) => [name]))('folder name %j passes exactly when it is a fixed point of toFolderBaseName', (name) => {
    const expected = toFolderBaseName(name) === name && !name.startsWith('.') && !EXCLUDED.has(name);
    expect(typed.isMossFolderName(name)).toBe(expected);
  });

  it('refuses separators, .., a leading dot, NUL, reserved and over-long folder names', () => {
    for (const name of ['', '.', '..', '.hidden', 'a/b', 'a\\b', 'a\u0000b', 'node_modules', 'Plan ', 'x'.repeat(253), '日'.repeat(85)]) {
      expect(typed.isMossFolderName(name)).toBe(false);
    }
    for (const name of ['Plan', 'Wait...', 'a..b', 'CON', 'Untitled', '日'.repeat(84), 'Cafe\u0301']) {
      expect(typed.isMossFolderName(name)).toBe(true);
    }
  });

  const EXTENSIONS = [...ALLOWED_IMAGE_EXTENSIONS, ...ALLOWED_VIDEO_EXTENSIONS];
  it.each(NAMES.map((name) => [name]))('every asset name buildImageFilename makes from %j passes unless it holds .. or overflows', (original) => {
    for (const ext of EXTENSIONS) {
      for (const source of [`${original}${ext}`, `${original}-mockup${ext}`, original]) {
        const name = buildImageFilename(source || undefined, ext, 1730000000000, UUID);
        const expected = isSafeFilename(name) && bytes(name) <= 255;
        expect({ name, ok: typed.isMossAssetName(name) }).toEqual({ name, ok: expected });
      }
    }
  });

  it('refuses asset names Moss would never make', () => {
    for (const name of ['', '.png', '..png', '.x-1-abcdef12.png', 'a/b.png', 'a\\b.png', '../a.png', 'a..b.png', 'a\u0000b.png', 'a.exe', 'a.PNG', 'a.html', 'a b\u00A0c.png', 'a?.png', `${'x'.repeat(252)}.png`, 'Cafe\u0301.png']) {
      expect({ name, ok: typed.isMossAssetName(name) }).toEqual({ name, ok: false });
    }
    for (const name of ['image-1730000000000-1b9d6bcd.png', 'Café-1-abcdef12.webp', 'x-mockup.html'.replace('.html', '.svg'), '日本語.mov']) {
      expect({ name, ok: typed.isMossAssetName(name) }).toEqual({ name, ok: true });
    }
  });
});
