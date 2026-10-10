// SearchDO and the DocDO's feed in the Node harness (T3.4; A§5.3; L§4.14): bodies are the converter's markdown, so
// snippets are text and backlinks survive an edit; results never name a doc outside the caller's closure.
import { $createTextNode, $getRoot, $isElementNode } from 'lexical';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DocDO, type SearchFeed } from '../../src/doc-do.ts';
import { SearchDO, type IndexEntry } from '../../src/search-do.ts';
import { serverWrite } from '../../src/server-doc.ts';
import { Backing, openDoc, start, wake } from './do-harness.ts';
import { FakeState } from './workerd.ts';

async function searchIndex(backing = new Backing('global')): Promise<SearchDO> {
  const index = new SearchDO(new FakeState(backing) as never, {} as never);
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

  it('finds backlinks by any of a doc’s keys, within the allowed set, and says when a doc’s links change', async () => {
    const index = await searchIndex();
    expect(await index.index({ docId: 'src', title: 'Kickoff', body: 'Read [[Launch Plan]].' })).toEqual({ linksChanged: true });
    expect(await index.index({ docId: 'src', title: 'Kickoff', body: 'Read [[Launch Plan]] twice.' })).toEqual({ linksChanged: false });
    await index.index({ docId: 'other', title: 'Other', body: 'Also [[launch-plan-2]].' });
    expect(await index.backlinks({ keys: ['launch-plan'], allowedDocIds: ['src', 'other'] })).toEqual(['src']);
    expect((await index.backlinks({ keys: ['launch-plan', 'launch-plan-2'], allowedDocIds: ['src', 'other'] })).sort()).toEqual(['other', 'src']);
    expect(await index.backlinks({ keys: ['launch-plan'], allowedDocIds: ['other'] })).toEqual([]);
  });

  it('reads backlinks through the allowed set, so 50,000 inaccessible sources linking the same key are never read', async () => {
    const backing = new Backing('global');
    const state = new FakeState(backing);
    const index = new SearchDO(state as never, {} as never);
    await index.setName('global');
    await index.index({ docId: 'mine-1', title: 'Mine', body: 'Back to [[Home]].' });
    await index.index({ docId: 'mine-2', title: 'Also mine', body: 'See [[home]] and [[Elsewhere]].' });
    await index.index({ docId: 'mine-3', title: 'Unlinked', body: 'No links here.' });
    backing.db.exec(`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 49999)
      INSERT INTO links (src_doc_id, target_key) SELECT 'other-' || i, 'home' FROM n`);
    expect(backing.query<{ n: number }>("SELECT count(*) AS n FROM links WHERE target_key = 'home'")[0].n).toBe(50_002);

    const exec = state.storage.sql.exec;
    const ran: { query: string; bindings: unknown[]; rows: number }[] = [];
    state.storage.sql.exec = (query, ...bindings) => {
      const cursor = exec(query, ...bindings);
      ran.push({ query, bindings, rows: cursor.toArray().length });
      return cursor;
    };
    const allowed = ['mine-1', 'mine-2', 'mine-3', 'other-7', 'missing'];
    expect((await index.backlinks({ keys: ['home'], allowedDocIds: allowed })).sort()).toEqual(['mine-1', 'mine-2', 'other-7']);
    expect(await index.backlinks({ keys: ['home'], allowedDocIds: ['mine-3', 'missing'] })).toEqual([]);

    expect(ran.length).toBeGreaterThan(0);
    for (const { query, bindings, rows } of ran) {
      expect(rows, 'rows handed back stay within the allowed set').toBeLessThanOrEqual(allowed.length);
      const plan = backing.query<{ detail: string }>(`EXPLAIN QUERY PLAN ${query}`, ...bindings).map((row) => row.detail).join(' | ');
      expect(plan, 'links is searched by source id, driven by the allowed ids').toMatch(/SEARCH \w+ USING (COVERING )?INDEX links_src/);
      expect(plan, 'never a scan of links, nor a walk of every source of the key').not.toMatch(/SCAN links|links_target/);
    }
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
