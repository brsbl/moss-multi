// SearchDO and the DocDO's feed in the Node harness (T3.4; A§5.3; L§4.14): bodies are the converter's markdown, so
// snippets are text and backlinks survive an edit; results never name a doc outside the caller's closure.
import { $createTextNode, $getRoot, $isElementNode } from 'lexical';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DocDO, type SearchFeed } from '../../src/doc-do.ts';
import { SearchDO, type IndexEntry } from '../../src/search-do.ts';
import { serverWrite } from '../../src/server-doc.ts';
import { Backing, openDoc, start, wake } from './do-harness.ts';
import { FakeState } from './workerd.ts';

async function searchIndex(): Promise<SearchDO> {
  const index = new SearchDO(new FakeState(new Backing('global')) as never, {} as never);
  await index.setName('global');
  return index;
}

describe('SearchDO', () => {
  it('answers only allowed docs, snippets text, and reports allowed docs it lacks', async () => {
    const index = await searchIndex();
    await index.index({ docId: 'a', title: 'Field notes', body: 'Seen near the river: a quokka grazing at dusk.' });
    await index.index({ docId: 'b', title: 'Diary', body: 'Another quokka, private.' });
    const answer = await index.search({ query: 'quokka', allowedDocIds: ['a', 'c'] });
    expect(answer.results.map((hit) => hit.docId)).toEqual(['a']);
    expect(answer.results[0].snippet).toBe('...n near the river: a quokka grazing at dusk.');
    expect(answer.unindexed).toEqual(['c']);
    expect((await index.search({ query: 'quok', allowedDocIds: ['a'] })).results.map((hit) => hit.docId), 'a prefix matches').toEqual(['a']);
    expect((await index.search({ query: '") OR *', allowedDocIds: ['a', 'b'] })).results, 'FTS syntax is only text').toEqual([]);
    await index.remove('a');
    expect((await index.search({ query: 'quokka', allowedDocIds: ['a'] })).results).toEqual([]);
  });

  it('filters by the caller before ranking, so 400+ better-ranked docs they cannot open never crowd theirs out', async () => {
    const index = await searchIndex();
    for (let i = 0; i < 450; i += 1) {
      await index.index({ docId: `other-${i}`, title: 'Quokka quokka', body: 'quokka quokka quokka quokka' });
    }
    await index.index({ docId: 'mine', title: 'Field notes', body: 'One quokka among many words in a long body.' });
    const answer = await index.search({ query: 'quokka', allowedDocIds: ['mine', 'other-1'], limit: 1 });
    expect(answer.results.map((hit) => hit.docId)).toEqual(['other-1']);
    expect((await index.search({ query: 'quokka', allowedDocIds: ['mine'] })).results.map((hit) => hit.docId)).toEqual(['mine']);
  });

  it('snippets a 2 MB body of unclosed comment openers in linear time', async () => {
    const index = await searchIndex();
    const body = `quokka ${'<!--'.repeat((2 * 1024 * 1024 - 8) / 4)}`;
    await index.index({ docId: 'big', title: 'Big', body });
    const start = performance.now();
    const answer = await index.search({ query: 'quokka', allowedDocIds: ['big'] });
    const took = performance.now() - start;
    expect(answer.results.map((hit) => hit.snippet.slice(0, 15))).toEqual(['quokka <!--<!--']);
    expect(took, `search took ${Math.round(took)} ms`).toBeLessThan(2000);
  }, 120_000);

  it('finds backlinks by any of a doc’s keys, within the allowed set, and says when a doc’s links change', async () => {
    const index = await searchIndex();
    expect(await index.index({ docId: 'src', title: 'Kickoff', body: 'Read [[Launch Plan]].' })).toEqual({ linksChanged: true });
    expect(await index.index({ docId: 'src', title: 'Kickoff', body: 'Read [[Launch Plan]] twice.' })).toEqual({ linksChanged: false });
    await index.index({ docId: 'other', title: 'Other', body: 'Also [[launch-plan-2]].' });
    expect(await index.backlinks({ keys: ['launch-plan'], allowedDocIds: ['src', 'other'] })).toEqual(['src']);
    expect((await index.backlinks({ keys: ['launch-plan', 'launch-plan-2'], allowedDocIds: ['src', 'other'] })).sort()).toEqual(['other', 'src']);
    expect(await index.backlinks({ keys: ['launch-plan'], allowedDocIds: ['other'] })).toEqual([]);
  });
});

describe('the DocDO feed', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('feeds the markdown export, so a wiki link and its backlink survive an edit, and skips the feed on wake when nothing changed', async () => {
    const index = await searchIndex();
    const fed: IndexEntry[] = [];
    class FedDoc extends DocDO {
      static override searchFeed = (): SearchFeed => ({ index: async (entry) => { fed.push(entry); return index.index(entry); } });
    }
    const opened = await start(openDoc(new Backing('source-doc'), FedDoc as never));
    await opened.dobj.create({ folderId: 'f', ownerId: 'o', title: 'Kickoff', markdown: 'Read [[Launch Plan]] **today**.' });
    await opened.dobj.onSave();
    expect(fed.at(-1)).toEqual({ docId: 'source-doc', title: 'Kickoff', body: expect.stringContaining('[[Launch Plan]]') });

    serverWrite(opened.dobj.document, 'author-edit', () => {
      const paragraph = $getRoot().getFirstChild();
      if (!$isElementNode(paragraph)) throw new Error('no paragraph');
      paragraph.append($createTextNode(' Then more.'));
    });
    await opened.dobj.onSave();
    const body = fed.at(-1)!.body;
    expect(body).toContain('Then more.');
    expect(body).toContain('[[Launch Plan]]');
    expect(body).not.toContain('[object Object]');
    expect(await index.backlinks({ keys: ['launch-plan'], allowedDocIds: ['source-doc'] }), 'the backlink survives the edit').toEqual(['source-doc']);
    expect((await index.search({ query: 'more', allowedDocIds: ['source-doc'] })).results[0].snippet).not.toContain('[object Object]');

    const count = fed.length;
    await opened.dobj.onSave();
    expect(fed, 'an unchanged doc is not fed again').toHaveLength(count);
    const woken = await start(wake(opened));
    await vi.advanceTimersByTimeAsync(1_500);
    expect(fed, 'a wake does not re-feed a doc the index holds').toHaveLength(count);
    expect(woken.dobj.document.getText('title').toString()).toBe('Kickoff');
  });

  it('re-feeds on wake only a doc whose last edit never reached the index', async () => {
    const index = await searchIndex();
    const fed: IndexEntry[] = [];
    let failing = false;
    class FedDoc extends DocDO {
      static override searchFeed = (): SearchFeed => ({
        index: async (entry) => {
          if (failing) throw new Error('index down');
          fed.push(entry);
          return index.index(entry);
        },
      });
    }
    const opened = await start(openDoc(new Backing('flaky-doc'), FedDoc as never));
    await opened.dobj.create({ folderId: 'f', ownerId: 'o', title: 'Flaky', markdown: 'First words.' });
    await opened.dobj.onSave();
    failing = true;
    serverWrite(opened.dobj.document, 'author-edit', () => {
      const paragraph = $getRoot().getFirstChild();
      if (!$isElementNode(paragraph)) throw new Error('no paragraph');
      paragraph.append($createTextNode(' Lost words.'));
    });
    await opened.dobj.onSave();
    failing = false;
    const count = fed.length;
    await start(wake(opened));
    await vi.advanceTimersByTimeAsync(1_500);
    expect(fed, 'the wake feeds the edit the index missed').toHaveLength(count + 1);
    expect(fed.at(-1)!.body).toContain('Lost words.');
    const again = await start(wake(opened));
    await vi.advanceTimersByTimeAsync(1_500);
    expect(fed, 'and the next wake does not').toHaveLength(count + 1);
    expect(again.dobj.document.getText('title').toString()).toBe('Flaky');
  });
});
