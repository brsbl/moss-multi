import jsYaml from 'js-yaml';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { readField, writeField } from './doc-fields.ts';
import { composeFrontmatter, frontmatterKeys, migrateFrontmatter, readFrontmatter, updateFrontmatter, writeFrontmatterKey } from './frontmatter.ts';

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
    const doc = new Y.Doc();
    writeField(doc, 'frontmatter', raw, 'seed');
    writeFrontmatterKey(doc, 'tags', ['fixture'], LOCAL);
    expect(parse(readField(doc, 'frontmatter'))).toEqual({ title: 'Spaced', tags: ['fixture'], '-owner': 'ada' });
    writeFrontmatterKey(doc, 'tags', undefined, LOCAL);
    expect(parse(readField(doc, 'frontmatter'))).toEqual({ title: 'Spaced', '-owner': 'ada' });
    const dated = new Y.Doc();
    writeFrontmatterKey(dated, 'due', '2026-11-01', LOCAL);
    expect(readField(dated, 'frontmatter')).toBe('due: "2026-11-01"\n');
    doc.destroy();
    dated.destroy();
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

describe('non-finite and null property values', () => {
  const values: [string, number | null][] = [['null', null], ['.nan', NaN], ['.inf', Infinity], ['-.inf', -Infinity]];
  const shapes: [string, (yaml: string) => string, (value: unknown) => unknown][] = [
    ['top-level', (v) => `limit: ${v}\n`, (data) => (data as { limit: unknown }).limit],
    ['nested', (v) => `outer:\n  limit: ${v}\n  list:\n    - ${v}\n`, (data) => (data as { outer: { list: unknown[] } }).outer.list[0]],
  ];
  const transitions = shapes.flatMap(([shape, yaml, pick]) => values.flatMap(([from, a]) =>
    values.filter(([to]) => to !== from).map(([to, b]) => [shape, from, to, yaml, pick, a, b] as const)));

  it.each(transitions)('%s %s -> %s round-trips and is detected as a change', (_shape, from, to, yaml, pick, a, b) => {
    const { a: doc, b: peer, sync } = apart(yaml(from));
    expect(readField(doc, 'frontmatter')).toBe(yaml(from));
    expect(Object.is(pick(readFrontmatter(peer)), a)).toBe(true);
    expect(writeField(doc, 'frontmatter', yaml(to), LOCAL)).toBe(true);
    expect(readField(doc, 'frontmatter')).toBe(yaml(to));
    sync();
    expect(readField(peer, 'frontmatter')).toBe(yaml(to));
    expect(Object.is(pick(readFrontmatter(peer)), b)).toBe(true);
    expect(writeField(doc, 'frontmatter', yaml(to), LOCAL)).toBe(false);
    const edited = readFrontmatter(peer);
    expect(updateFrontmatter(peer, edited, jsYaml.load(yaml(from), { json: true }) as Record<string, unknown>, LOCAL)).toBe(true);
    expect(readField(peer, 'frontmatter')).toBe(yaml(from));
  });
});

it.each(['---\n# no fields yet\n---\n', '---\n---\n'])('imports an empty YAML block as no properties: %s', (yaml) => {
  const doc = new Y.Doc();
  writeField(doc, 'frontmatter', yaml, 'import');
  expect(readFrontmatter(doc)).toBeNull();
  doc.destroy();
});

describe('frontmatter scale', () => {
  // Each step here, for 4x the keys, must cost well under the 16x a quadratic step would.
  const flat = (count: number) => Object.fromEntries(Array.from({ length: count }, (_, i) => [`k${String(i).padStart(6, '0')}`, 0]));

  function steps(count: number): Record<string, number> {
    const doc = new Y.Doc();
    const ms: Record<string, number> = {};
    const time = (name: string, run: () => void) => {
      const started = Date.now();
      run();
      ms[name] = Date.now() - started;
    };
    const keys = flat(count);
    time('import', () => updateFrontmatter(doc, null, keys, LOCAL));
    expect(frontmatterKeys(doc)).toEqual(Object.keys(keys));
    time('one-key update', () => writeFrontmatterKey(doc, 'k000001', 1, LOCAL));
    time('one-key addition', () => writeFrontmatterKey(doc, 'added', 1, LOCAL));
    const reversed = Object.fromEntries(Object.entries(readFrontmatter(doc) ?? {}).reverse());
    time('reorder', () => updateFrontmatter(doc, readFrontmatter(doc), reversed, LOCAL));
    expect(frontmatterKeys(doc)).toEqual(Object.keys(reversed));
    time('re-import with every value changed', () => updateFrontmatter(doc, readFrontmatter(doc), Object.fromEntries(Object.keys(keys).map((key) => [key, 2])), LOCAL));
    expect(frontmatterKeys(doc)).toEqual(Object.keys(keys));
    doc.destroy();
    return ms;
  }

  it('imports, updates and reorders tens of thousands of flat keys in time linear in the keys', { timeout: 600_000 }, () => {
    steps(2_000);
    const small = steps(10_000);
    const large = steps(40_000);
    for (const [name, ms] of Object.entries(large)) {
      expect(ms, `${name}: 10,000 keys took ${small[name].toFixed(0)} ms, 40,000 took ${ms.toFixed(0)} ms`).toBeLessThanOrEqual(7 * small[name] + 150);
    }
    expect(large['one-key update'], 'a one-key update on 40,000 keys stays cheap').toBeLessThan(500);
  });
});
