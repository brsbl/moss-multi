// moss's import normalization repeated a highlight's whole opener, style attribute and all, around every formatted
// and plain run inside it, so a line of W style characters and R runs normalized to about W×R characters before any
// import budget measured it (a 60 KB line built a 400 MB string). Wrapper length and run count scale independently
// here, through the DocDO's create and through an editor's import and push: each lands within a fixed multiple of its
// line, with the line's text kept.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { $importNoteBody } from '../../src/converter/index.ts';
import { Backing, bindLexical, connect, openDoc, start } from './do-harness.ts';

beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] }));
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

/** One highlight of `runs` italic runs whose style attribute is `style` characters long. */
const line = (style: number, runs: number) => `<mark data-color="yellow" style="${' '.repeat(style)}">${'*x* '.repeat(runs)}</mark>`;
const xs = (text: string) => text.split('x').length - 1;

const CASES: [number, number][] = [
  [256, 1_024], [1_024, 1_024], [4_096, 1_024], [8_192, 1_024],
  [1_024, 256], [1_024, 4_096], [1_024, 8_192],
];

async function check(style: number, runs: number, land: (markdown: string) => Promise<string>): Promise<void> {
  const markdown = `before\n\n${line(style, runs)}\n\nafter`;
  const started = performance.now();
  const exported = await land(markdown);
  const took = performance.now() - started;
  expect(xs(exported), 'every run is kept').toBe(runs);
  expect(exported).toContain('before');
  expect(exported).toContain('after');
  expect(exported.length, `${markdown.length} chars exported as ${exported.length}`).toBeLessThanOrEqual(4 * markdown.length + 1_024);
  expect(took, `took ${Math.round(took)} ms`).toBeLessThan(5_000);
}

describe('a highlight of a long style and many runs stays bounded @p:tech-4', () => {
  it.each(CASES)('through the DocDO create: style %i, %i runs', async (style, runs) => {
    await check(style, runs, async (markdown) => {
      const { dobj } = await start(openDoc(new Backing(crypto.randomUUID())));
      await dobj.create({ folderId: 'f', ownerId: 'o', markdown });
      return dobj.exportMarkdown();
    });
  }, 60_000);

  it.each(CASES)('through an editor import and push: style %i, %i runs', async (style, runs) => {
    await check(style, runs, async (markdown) => {
      const opened = await start(openDoc(new Backing(crypto.randomUUID())));
      const client = await connect(opened, { role: 'editor' });
      const lexical = bindLexical(client.doc);
      await client.hello();
      lexical.editor.update(() => $importNoteBody(markdown), { discrete: true });
      await client.flush();
      return opened.dobj.exportMarkdown();
    });
  }, 60_000);

  // Comment markers holding replacement patterns (`$&` copied the opener, `$`` the split) once multiplied the line.
  const MARKED: [string, string][] = [
    ['$& start marker', `%%m:${'$&'.repeat(3_000)}:start%%<mark data-color="yellow" style="${' '.repeat(4_096)}">**x**</mark>%%m:id:end%%`],
    ['$` end marker', `%%m:id:start%%<mark data-color="yellow" style="${' '.repeat(4_096)}">**x**</mark>%%m:${'$`'.repeat(3_000)}:end%%`],
  ];
  async function checkMarked(text: string, land: (markdown: string) => Promise<string>): Promise<void> {
    const markdown = `before\n\n${text}\n\nafter`;
    const started = performance.now();
    const exported = await land(markdown);
    expect(exported).toContain('before');
    expect(exported).toContain('after');
    expect(xs(exported), 'the run is kept').toBe(1);
    expect(exported.length, `${markdown.length} chars exported as ${exported.length}`).toBeLessThanOrEqual(4 * markdown.length + 1_024);
    expect(performance.now() - started).toBeLessThan(5_000);
  }
  it.each(MARKED)('through the DocDO create: %s', async (_name, text) => {
    await checkMarked(text, async (markdown) => {
      const { dobj } = await start(openDoc(new Backing(crypto.randomUUID())));
      await dobj.create({ folderId: 'f', ownerId: 'o', markdown });
      return dobj.exportMarkdown();
    });
  }, 60_000);
  it.each(MARKED)('through an editor import and push: %s', async (_name, text) => {
    await checkMarked(text, async (markdown) => {
      const opened = await start(openDoc(new Backing(crypto.randomUUID())));
      const client = await connect(opened, { role: 'editor' });
      const lexical = bindLexical(client.doc);
      await client.hello();
      lexical.editor.update(() => $importNoteBody(markdown), { discrete: true });
      await client.flush();
      return opened.dobj.exportMarkdown();
    });
  }, 60_000);

  it('still splits an ordinary highlight on create', async () => {
    const { dobj } = await start(openDoc(new Backing(crypto.randomUUID())));
    await dobj.create({ folderId: 'f', ownerId: 'o', markdown: '<mark data-color="yellow">**bold** rest</mark>' });
    const exported = await dobj.exportMarkdown();
    expect(exported).toContain('bold');
    expect(exported).toContain('rest');
    expect(exported).not.toContain('\\*\\*');
  });
});
