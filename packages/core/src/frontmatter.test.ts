// Frontmatter in Y.Text('frontmatter') (A§10.4): a property edit rewrites only that key's lines, so two people
// editing different keys at once both keep their edit, untouched keys keep their exact bytes, and the block stays
// parseable YAML.
import jsYaml from 'js-yaml';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { readField, writeField } from './doc-fields.ts';
import { composeFrontmatter, setFrontmatterKey, writeFrontmatterKey } from './frontmatter.ts';

const LOCAL = 'frontmatter-local';
const parse = (yaml: string) => jsYaml.load(yaml) as Record<string, unknown> | undefined;

function apart(initial: string): { a: Y.Doc; b: Y.Doc; sync: () => void } {
  const a = new Y.Doc();
  if (initial) writeField(a, 'frontmatter', initial, 'seed');
  const b = new Y.Doc();
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
  return {
    a,
    b,
    sync: () => {
      Y.applyUpdate(a, Y.encodeStateAsUpdate(b, Y.encodeStateVector(a)));
      Y.applyUpdate(b, Y.encodeStateAsUpdate(a, Y.encodeStateVector(b)));
    },
  };
}

describe('setFrontmatterKey', () => {
  const BLOCK = 'title:   "Spaced"   # kept as written\nstatus: draft\ntags:\n- garden\n- fixture\nowner: ada\n';

  it('rewrites only the edited key, keeping every other line byte for byte', () => {
    const next = setFrontmatterKey(BLOCK, 'status', 'done');
    expect(next).toBe(BLOCK.replace('status: draft', 'status: done'));
  });

  it('replaces a list value together with its continuation lines', () => {
    const next = setFrontmatterKey(BLOCK, 'tags', ['garden']);
    expect(next).toBe('title:   "Spaced"   # kept as written\nstatus: draft\ntags:\n  - garden\nowner: ada\n');
    expect(parse(next)).toEqual({ title: 'Spaced', status: 'draft', tags: ['garden'], owner: 'ada' });
  });

  it('removes a key and its continuation lines only', () => {
    expect(setFrontmatterKey(BLOCK, 'tags', undefined)).toBe('title:   "Spaced"   # kept as written\nstatus: draft\nowner: ada\n');
  });

  it('appends a new key at the end, and starts an empty block', () => {
    expect(setFrontmatterKey(BLOCK, 'due', '2026-11-01')).toBe(`${BLOCK}due: "2026-11-01"\n`);
    expect(setFrontmatterKey('', 'status', 'draft')).toBe('status: draft\n');
    expect(setFrontmatterKey('status: draft', 'owner', 'ben')).toBe('status: draft\nowner: ben\n');
  });

  it('finds a quoted key', () => {
    expect(setFrontmatterKey('"my key": 1\nother: 2\n', 'my key', 3)).toBe('my key: 3\nother: 2\n');
  });

  it('preserves and edits hyphen-leading keys beside unindented sequences', () => {
    const yaml = 'tags:\n- garden\n-owner: ada\nstatus: done\n';
    expect(setFrontmatterKey(yaml, 'tags', ['fixture'])).toBe('tags:\n  - fixture\n-owner: ada\nstatus: done\n');
    expect(setFrontmatterKey(yaml, '-owner', 'ben')).toBe('tags:\n- garden\n"-owner": ben\nstatus: done\n');
  });

  it.each(['revised', undefined])('repairs every concurrent occurrence of a key when set to %s', (value) => {
    const { a, b, sync } = apart('status: done\n');
    try {
      writeFrontmatterKey(a, 'owner', ['ada'], LOCAL);
      writeFrontmatterKey(b, 'owner', ['ben'], LOCAL);
      sync();
      expect(readField(a, 'frontmatter')).toBe(readField(b, 'frontmatter'));
      expect(readField(a, 'frontmatter').match(/^owner:/gm)).toHaveLength(2);
      writeFrontmatterKey(a, 'owner', value, LOCAL);
      sync();
      const repaired = readField(a, 'frontmatter');
      expect(repaired).toBe(readField(b, 'frontmatter'));
      expect(parse(repaired)).toEqual(value === undefined ? { status: 'done' } : { status: 'done', owner: value });
    } finally {
      a.destroy();
      b.destroy();
    }
  });
});

describe('writeFrontmatterKey', () => {
  it('two people editing different keys at once both keep their edit', () => {
    const { a, b, sync } = apart('status: draft\nowner: ada\n');
    writeFrontmatterKey(a, 'status', 'in review', LOCAL);
    writeFrontmatterKey(b, 'owner', 'ben', LOCAL);
    sync();
    expect(readField(a, 'frontmatter')).toBe(readField(b, 'frontmatter'));
    expect(parse(readField(a, 'frontmatter'))).toEqual({ status: 'in review', owner: 'ben' });
  });

  it('two people adding the first keys of an empty block at once both keep them', () => {
    const { a, b, sync } = apart('');
    writeFrontmatterKey(a, 'status', 'draft', LOCAL);
    writeFrontmatterKey(b, 'owner', 'ben', LOCAL);
    sync();
    expect(parse(readField(a, 'frontmatter'))).toEqual({ status: 'draft', owner: 'ben' });
  });

  it('two people adding different keys to one block at once both keep them', () => {
    const { a, b, sync } = apart('status: draft\n');
    writeFrontmatterKey(a, 'due', 'soon', LOCAL);
    writeFrontmatterKey(b, 'owner', 'ben', LOCAL);
    sync();
    expect(parse(readField(a, 'frontmatter'))).toEqual({ status: 'draft', due: 'soon', owner: 'ben' });
  });

  it('touches nothing outside the key it edits', () => {
    const doc = new Y.Doc();
    writeField(doc, 'frontmatter', 'a: 1\nb: 2\nc: 3\n', 'seed');
    let delta: unknown = null;
    doc.getText('frontmatter').observe((event) => {
      delta = event.delta;
    });
    writeFrontmatterKey(doc, 'b', 20, LOCAL);
    expect(delta).toEqual([{ retain: 9 }, { insert: '0' }]);
  });
});

describe('composeFrontmatter', () => {
  it('wraps a block in fences for the .md file and leaves no block for none', () => {
    expect(composeFrontmatter('status: draft\n', 'Body\n')).toBe('---\nstatus: draft\n---\nBody\n');
    expect(composeFrontmatter('status: draft', 'Body\n')).toBe('---\nstatus: draft\n---\nBody\n');
    expect(composeFrontmatter('', 'Body\n')).toBe('Body\n');
  });
});
