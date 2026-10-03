import jsYaml from 'js-yaml';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { readField, writeField } from './doc-fields.ts';
import { composeFrontmatter, frontmatterKeys, migrateFrontmatter, readFrontmatter, setFrontmatterKey, updateFrontmatter, writeFrontmatterKey } from './frontmatter.ts';

const LOCAL = 'frontmatter-local';
const parse = (yaml: string) => jsYaml.load(yaml) as Record<string, unknown> | undefined;

function apart(initial: string): { a: Y.Doc; b: Y.Doc; sync: () => void } {
  const a = new Y.Doc();
  if (initial) writeField(a, 'frontmatter', initial, 'seed');
  const b = new Y.Doc();
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
  return { a, b, sync: () => {
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b, Y.encodeStateVector(a)));
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a, Y.encodeStateVector(b)));
  } };
}

describe('structured frontmatter', () => {
  it('edits canonical YAML without changing the other values, including nested lists and hyphen-leading keys', () => {
    const raw = 'title:   "Spaced" # comment\ntags:\n- garden\n-owner: ada\n';
    const next = setFrontmatterKey(raw, 'tags', ['fixture']);
    expect(parse(next)).toEqual({ title: 'Spaced', tags: ['fixture'], '-owner': 'ada' });
    expect(parse(setFrontmatterKey(next, 'tags', undefined))).toEqual({ title: 'Spaced', '-owner': 'ada' });
    expect(setFrontmatterKey('', 'due', '2026-11-01')).toBe('due: "2026-11-01"\n');
  });

  it.each(['', 'status: draft\n'])('concurrent additions keep different keys from %s', (initial) => {
    const { a, b, sync } = apart(initial);
    writeFrontmatterKey(a, 'due', 'soon', LOCAL);
    writeFrontmatterKey(b, 'owner', 'ben', LOCAL);
    sync();
    expect(readFrontmatter(a)).toEqual({ ...parse(initial), due: 'soon', owner: 'ben' });
    expect(readField(a, 'frontmatter')).toBe(readField(b, 'frontmatter'));
  });

  it('edits only the changed map entry', () => {
    const { a } = apart('a: 1\nb: 2\nc: 3\n');
    const keys: string[] = [];
    a.getMap('frontmatter').observe((event) => keys.push(...event.keysChanged));
    writeFrontmatterKey(a, 'b', 20, LOCAL);
    expect(keys).toEqual(['b']);
    expect(readFrontmatter(a)).toEqual({ a: 1, b: 20, c: 3 });
  });

  it('reorder and rename preserve nested values through concurrent edits and repeated reloads', () => {
    const { a, b, sync } = apart('first: {nested: [1, true]}\nsecond: two\nthird: three\n');
    const before = readFrontmatter(a);
    updateFrontmatter(a, before, { third: 'three', renamed: before?.first, second: 'two' }, LOCAL);
    writeFrontmatterKey(b, 'second', 'peer', LOCAL);
    sync();
    for (const doc of [a, b]) {
      expect(frontmatterKeys(doc)).toEqual(['third', 'renamed', 'second']);
      expect(readFrontmatter(doc)).toEqual({ third: 'three', renamed: { nested: [1, true] }, second: 'peer' });
      const reopened = new Y.Doc();
      Y.applyUpdate(reopened, Y.encodeStateAsUpdate(doc));
      expect(readField(reopened, 'frontmatter')).toBe(readField(a, 'frontmatter'));
      reopened.destroy();
    }
  });

  it.each(['status: done\nowner: ada\n', '---\r\nstatus: done\r\nowner: ada\r\n---\r\n'])('upgrades persisted legacy text once and never resurrects a deleted property', (yaml) => {
    const legacy = new Y.Doc();
    legacy.getText('frontmatter').insert(0, yaml);
    legacy.getText('title').insert(0, 'Kept title');
    const restored = new Y.Doc();
    Y.applyUpdate(restored, Y.encodeStateAsUpdate(legacy));
    migrateFrontmatter(restored, 'upgrade');
    expect(readFrontmatter(restored)).toEqual({ status: 'done', owner: 'ada' });
    expect(restored.getMap('frontmatter')).toBeInstanceOf(Y.Map);
    expect(restored.getText('title').toString()).toBe('Kept title');
    writeFrontmatterKey(restored, 'owner', undefined, LOCAL);
    const reopened = new Y.Doc();
    Y.applyUpdate(reopened, Y.encodeStateAsUpdate(restored));
    const bytes = Y.encodeStateAsUpdate(reopened);
    migrateFrontmatter(reopened, 'upgrade');
    expect(Y.encodeStateAsUpdate(reopened)).toEqual(bytes);
    expect(readFrontmatter(reopened)).toEqual({ status: 'done' });
    for (const doc of [legacy, restored, reopened]) doc.destroy();
  });

  it('wraps canonical YAML once and leaves no block for none', () => {
    expect(composeFrontmatter('status: draft\n', 'Body\n')).toBe('---\nstatus: draft\n---\nBody\n');
    expect(composeFrontmatter('', 'Body\n')).toBe('Body\n');
  });
});

describe('structured property regressions', () => {
  it('same-key additions export one valid YAML key immediately after merge', () => {
    const { a, b, sync } = apart('status: done\n');
    writeFrontmatterKey(a, 'owner', 'ada', LOCAL);
    writeFrontmatterKey(b, 'owner', 'ben', LOCAL);
    sync();
    const yaml = readField(a, 'frontmatter');
    expect(yaml.match(/^owner:/gm)).toHaveLength(1);
    expect(parse(yaml)).toEqual({ status: 'done', owner: expect.stringMatching(/^(ada|ben)$/) });
    expect(readField(b, 'frontmatter')).toBe(yaml);
  });

  it('delete versus edit never renames or drops the following property', () => {
    const { a, b, sync } = apart('owner: ada\nstatus: done\ntags: [keep, both]\n');
    writeFrontmatterKey(a, 'owner', undefined, LOCAL);
    writeFrontmatterKey(b, 'owner', 'ben', LOCAL);
    sync();
    for (const doc of [a, b]) {
      const values = parse(readField(doc, 'frontmatter'));
      expect(values).toMatchObject({ status: 'done', tags: ['keep', 'both'] });
      expect(Object.keys(values ?? {}).every((key) => ['owner', 'status', 'tags'].includes(key))).toBe(true);
    }
    expect(readField(a, 'frontmatter')).toBe(readField(b, 'frontmatter'));
  });
});
