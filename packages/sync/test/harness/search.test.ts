// SearchDO and the DocDO's feed in the Node harness (T3.4; A§5.3; L§4.14): bodies are the converter's markdown, so
// snippets are text and backlinks survive an edit; results never name a doc outside the caller's closure.
import { $createTextNode, $getRoot, $isElementNode } from 'lexical';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import * as Y from 'yjs';
import { DocDO, type SearchFeed } from '../../src/doc-do.ts';
import { payloadText } from '../../src/payload-docs.ts';
import { captureRestoreBase } from '../../src/restore-base.ts';
import { SearchDO, type IndexEntry } from '../../src/search-do.ts';
import { payloadSourceOf, serverWrite } from '../../src/server-doc.ts';
import { Backing, openDoc, start, wake } from './do-harness.ts';
import { LiveClient, syncAll } from './live-client.ts';
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
    expect((await index.backlinks({ keys: ['launch-plan'], allowedDocIds: ['src', 'other'] })).sources).toEqual(['src']);
    expect((await index.backlinks({ keys: ['launch-plan', 'launch-plan-2'], allowedDocIds: ['src', 'other'] })).sources.sort()).toEqual(['other', 'src']);
    expect((await index.backlinks({ keys: ['launch-plan'], allowedDocIds: ['other'] })).sources).toEqual([]);
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
    expect((await index.backlinks({ keys: ['home'], allowedDocIds: allowed })).sources.sort()).toEqual(['mine-1', 'mine-2', 'other-7']);
    expect((await index.backlinks({ keys: ['home'], allowedDocIds: ['mine-3', 'missing'] })).sources).toEqual([]);

    expect(ran.length).toBeGreaterThan(0);
    for (const { query, bindings, rows } of ran) {
      expect(rows, 'rows handed back stay within the allowed set').toBeLessThanOrEqual(allowed.length);
      if (!/\blinks\b/.test(query)) continue;
      const plan = backing.query<{ detail: string }>(`EXPLAIN QUERY PLAN ${query}`, ...bindings).map((row) => row.detail).join(' | ');
      expect(plan, 'links is searched by source id, driven by the allowed ids').toMatch(/SEARCH \w+ USING (COVERING )?INDEX links_src/);
      expect(plan, 'never a scan of links, nor a walk of every source of the key').not.toMatch(/SCAN links|links_target/);
    }
  });

  // B164: bm25's statistics are the whole table's, so other tenants' notes moved an allowed doc's score and order.
  it.each(['fts5', 'like'] as const)('scores and orders the allowed docs the same whatever else the index holds (%s)', async (engine) => {
    const backing = new Backing('global');
    const state = new FakeState(backing);
    if (engine === 'like') {
      const exec = state.storage.sql.exec;
      state.storage.sql.exec = (query, ...bindings) => {
        if (/VIRTUAL TABLE/.test(query)) throw new Error('no such module: fts5');
        return exec(query, ...bindings);
      };
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      onTestFinished(() => warn.mockRestore());
    }
    const index = new SearchDO(state as never, {} as never);
    await index.setName('global');
    await index.index({ docId: 'a', title: 'Quokka field notes', body: 'One quokka seen near the wombat burrow.' });
    await index.index({ docId: 'b', title: 'Diary', body: 'quokka quokka quokka, then a wombat and a long walk home through the hills.' });
    await index.index({ docId: 'c', title: 'Wombat', body: 'A quokka met a wombat.' });
    await index.index({ docId: 'd', title: 'Diary', body: 'quokka quokka quokka, then a wombat and a long walk home through the hills.' });
    const allowedDocIds = ['a', 'b', 'c', 'd'];
    const asks = [
      { query: 'quokka', allowedDocIds }, { query: 'quokka', allowedDocIds, limit: 1 },
      { query: 'wombat quokka', allowedDocIds }, { query: 'wombat quokka', allowedDocIds, limit: 1 },
    ];
    const before = await Promise.all(asks.map((ask) => index.search(ask)));
    expect(before[0].results.map((hit) => hit.docId), 'b and d tie, broken by id').toEqual(['a', 'b', 'd', 'c']);
    expect(before[2].results.map((hit) => hit.docId)).toEqual(['a', 'c', 'b', 'd']);
    for (let i = 0; i < 300; i += 1) {
      await index.index({ docId: `other-${i}`, title: i % 2 ? 'Quokka' : 'Wombat wombat', body: `${'quokka '.repeat(i % 7)}${'filler '.repeat(i % 40)}wombat` });
    }
    const after = await Promise.all(asks.map((ask) => index.search(ask)));
    expect(after, 'scores, order and the limit-1 pick do not move').toEqual(before);
    const order = before[0].results;
    for (let i = 1; i < order.length; i += 1) {
      const [prev, next] = [order[i - 1], order[i]];
      expect(prev.score > next.score || (prev.score === next.score && prev.docId < next.docId), 'score descending, then id').toBe(true);
    }
  });

  // B174: entries_fts kept doc_id UNINDEXED, so every update and removal deleted from it by a full scan.
  it('updates and removes one doc by its FTS rowid, never a scan, and rewrites no links a re-index leaves unchanged', async () => {
    const backing = new Backing('global');
    const state = new FakeState(backing);
    const index = new SearchDO(state as never, {} as never);
    await index.setName('global');
    for (let i = 0; i < 1_000; i += 1) await index.index({ docId: `n-${i}`, title: `Note ${i}`, body: `body ${i} quokka` });
    const links = Array.from({ length: 200 }, (_, i) => `[[Target ${i}]]`).join(' ');
    await index.index({ docId: 'hub', title: 'Hub', body: `First ${links}` });
    const exec = state.storage.sql.exec;
    const ran: { query: string; bindings: unknown[] }[] = [];
    state.storage.sql.exec = (query, ...bindings) => {
      ran.push({ query, bindings });
      return exec(query, ...bindings);
    };
    expect(await index.index({ docId: 'hub', title: 'Hub', body: `Second ${links}` })).toEqual({ linksChanged: false });
    expect(ran.filter(({ query }) => /(INSERT INTO|DELETE FROM) links\b/.test(query)), 'unchanged links are not rewritten').toEqual([]);
    await index.index({ docId: 'n-500', title: 'Note 500', body: 'edited wombat' });
    await index.remove('n-501');
    const fts = ran.filter(({ query }) => /entries_fts/.test(query) && /^\s*(DELETE|UPDATE|SELECT)/i.test(query));
    expect(fts.length).toBeGreaterThan(0);
    for (const { query, bindings } of fts) {
      const plan = backing.query<{ detail: string }>(`EXPLAIN QUERY PLAN ${query}`, ...bindings).map((row) => row.detail);
      for (const line of plan.filter((detail) => /entries_fts/.test(detail))) {
        expect(line, `${query}: a rowid lookup, not a scan`).toMatch(/VIRTUAL TABLE INDEX \d+:\S*=/);
      }
    }
    state.storage.sql.exec = exec;
    const hits = (query: string, ids: string[]) => index.search({ query, allowedDocIds: ids }).then((answer) => answer.results.map((hit) => hit.docId));
    expect(await hits('wombat', ['n-500', 'n-499'])).toEqual(['n-500']);
    expect(await hits('quokka', ['n-500', 'n-501', 'n-502'])).toEqual(['n-502']);
    expect(await index.index({ docId: 'hub', title: 'Hub', body: 'Only [[Elsewhere]]' })).toEqual({ linksChanged: true });
    expect((await index.backlinks({ keys: ['target-1'], allowedDocIds: ['hub'] })).sources).toEqual([]);
    expect((await index.backlinks({ keys: ['elsewhere'], allowedDocIds: ['hub'] })).sources).toEqual(['hub']);
  });

  it('upgrades an index written under the old schema: search, backlinks and delete stay right', async () => {
    const backing = new Backing('global');
    backing.db.exec(`CREATE TABLE entries (doc_id TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE links (src_doc_id TEXT NOT NULL, target_key TEXT NOT NULL);
      CREATE INDEX links_target ON links (target_key);
      CREATE INDEX links_src ON links (src_doc_id);
      CREATE VIRTUAL TABLE entries_fts USING fts5(doc_id UNINDEXED, title, body);
      INSERT INTO entries VALUES ('x', 'Ex', 'apple pie [[Home]]', 1), ('y', 'Why', 'banana bread', 1), ('z', 'Zed', 'cherry tart', 1);
      DELETE FROM entries WHERE doc_id = 'x';
      INSERT INTO entries VALUES ('x', 'Ex', 'apple pie [[Home]]', 2);
      INSERT INTO entries_fts (doc_id, title, body) VALUES ('z', 'Zed', 'cherry tart'), ('x', 'Ex', 'apple pie [[Home]]'), ('y', 'Why', 'banana bread');
      INSERT INTO links VALUES ('x', 'home');`);
    const index = await searchIndex(backing);
    const all = ['x', 'y', 'z'];
    const hits = (query: string) => index.search({ query, allowedDocIds: all }).then((answer) => answer.results.map((hit) => hit.docId));
    expect([await hits('apple'), await hits('banana'), await hits('cherry')]).toEqual([['x'], ['y'], ['z']]);
    expect(backing.query("SELECT count(*) AS n FROM entries e JOIN entries_fts f ON f.rowid = e.rowid AND f.doc_id = e.doc_id")[0].n).toBe(3);
    await index.index({ docId: 'y', title: 'Why', body: 'blueberry muffin' });
    expect([await hits('apple'), await hits('banana'), await hits('blueberry'), await hits('cherry')]).toEqual([['x'], [], ['y'], ['z']]);
    await index.remove('z');
    expect([await hits('apple'), await hits('blueberry'), await hits('cherry')]).toEqual([['x'], ['y'], []]);
    expect((await index.backlinks({ keys: ['home'], allowedDocIds: all })).sources).toEqual(['x']);
    const again = await searchIndex(backing);
    expect((await again.search({ query: 'apple', allowedDocIds: all })).results.map((hit) => hit.docId), 'the upgrade runs once').toEqual(['x']);
  });

  // B173: backlinks read only the links table, so a source the index was never fed was missing with no backfill.
  it('reports the allowed docs it lacks with backlinks, at most UNINDEXED_REPORT of them', async () => {
    const index = await searchIndex();
    await index.index({ docId: 'src', title: 'Src', body: 'See [[Home]].' });
    const missing = Array.from({ length: 60 }, (_, i) => `missing-${i}`);
    const answer = await index.backlinks({ keys: ['home'], allowedDocIds: ['src', ...missing] });
    expect(answer.sources).toEqual(['src']);
    expect(answer.unindexed).toHaveLength(25);
    expect(answer.unindexed.every((id) => missing.includes(id))).toBe(true);
    expect((await index.backlinks({ keys: [''], allowedDocIds: ['missing-1'] })).unindexed, 'reported even when no key is asked').toEqual(['missing-1']);
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
    expect((await index.backlinks({ keys: ['launch-plan'], allowedDocIds: ['source-doc'] })).sources, 'the backlink survives the edit').toEqual(['source-doc']);
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

  // T6.S6: a server write that changes only a payload (a push or a restore of a code block's code) leaves the note
  // unchanged, so no onSave runs; the payload write itself schedules the feed.
  const hits = async (index: SearchDO, query: string, docId: string) =>
    (await index.search({ query, allowedDocIds: [docId] })).results.map((hit) => hit.docId);

  function fedDoc(index: SearchDO): typeof DocDO {
    return class extends DocDO {
      static override searchFeed = (): SearchFeed => ({ index: (entry) => index.index(entry) });
    };
  }

  /** The ids of every payload element in `node`, depth first. */
  function payloadIds(node: Y.XmlText | Y.XmlElement): string[] {
    const ids: string[] = [];
    const own = node instanceof Y.XmlElement ? node.getAttribute('__regId') : undefined;
    if (typeof own === 'string') ids.push(own);
    const children = node instanceof Y.XmlText
      ? (node.toDelta() as { insert: unknown }[]).map((op) => op.insert)
      : node.toArray();
    for (const child of children) {
      if (child instanceof Y.XmlText || child instanceof Y.XmlElement) ids.push(...payloadIds(child));
    }
    return ids;
  }

  it('feeds a payload-only server write, as a push of a code block makes, with no note change', async () => {
    const index = await searchIndex();
    const opened = await start(openDoc(new Backing('push-doc'), fedDoc(index) as never));
    await opened.dobj.create({ folderId: 'f', ownerId: 'o', title: 'Pushed', markdown: 'Intro.\n\n```js\nconst kiwi = 1;\n```\n' });
    // Past the create's debounced save (10 s at most), so only the payload write can feed what follows.
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await hits(index, 'kiwi', 'push-doc')).toEqual(['push-doc']);

    const document = opened.dobj.document;
    const [id] = payloadIds(document.get('root', Y.XmlText));
    if (!id) throw new Error('no payload');
    const source = payloadSourceOf(document);
    const copy = new Y.Doc();
    Y.applyUpdate(copy, source.read(id)!);
    const vector = Y.encodeStateVector(copy);
    const note = Y.encodeStateAsUpdate(document);
    const text = payloadText(copy);
    text.delete(0, text.length);
    text.insert(0, 'const wombat = 2;');
    source.write(id, Y.encodeStateAsUpdate(copy, vector));
    expect(Y.encodeStateAsUpdate(document), 'the note itself is unchanged').toEqual(note);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(await hits(index, 'wombat', 'push-doc'), 'the new code is found').toEqual(['push-doc']);
    expect(await hits(index, 'kiwi', 'push-doc'), 'the replaced code is not').toEqual([]);
  });

  it('feeds a restore that changes only a code block', async () => {
    const index = await searchIndex();
    const opened = await start(openDoc(new Backing('restore-doc'), fedDoc(index) as never));
    await opened.dobj.create({ folderId: 'f', ownerId: 'ada', title: 'Restored', markdown: 'Intro.\n' });
    const ada = await LiveClient.open(opened, { id: 'ada', role: 'editor' });
    try {
      ada.insert('code-block', 'const kiwi = 1;');
      await syncAll(ada);
      await syncAll(ada);
      const reviewer = { id: 'ada', role: 'editor' as const };
      const saving = await opened.dobj.saveVersion({ name: 'Kiwi', reviewer });
      if (!saving.ok) throw new Error(saving.reason);
      ada.erase(0, 0, 'const kiwi = 1;'.length);
      ada.type(0, 0, 'const wombat = 2;');
      await syncAll(ada);
      await syncAll(ada);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(await hits(index, 'wombat', 'restore-doc'), 'the typed code is fed').toEqual(['restore-doc']);

      const restoring = await opened.dobj.restoreVersion({ id: saving.version.id, reviewer, base: { ...captureRestoreBase(ada.doc, ada.payloads), age: 0 } });
      expect(restoring).toMatchObject({ ok: true });
      await vi.advanceTimersByTimeAsync(5_000);
      expect(await hits(index, 'kiwi', 'restore-doc'), 'the restored code is found').toEqual(['restore-doc']);
      expect(await hits(index, 'wombat', 'restore-doc'), 'the replaced code is not').toEqual([]);
    } finally {
      ada.dispose();
    }
  });

  // B172: a failed feed was only logged, so an idle DocDO kept the index stale until its next edit or wake.
  it('retries a failed feed on the alarm, backing off while it keeps failing, and keeps an earlier alarm', async () => {
    const index = await searchIndex();
    let failures = 0;
    const tries: number[] = [];
    class FedDoc extends DocDO {
      static override searchFeed = (): SearchFeed => ({
        index: async (entry) => {
          tries.push(Date.now());
          if (failures > 0) {
            failures -= 1;
            throw new Error('index down');
          }
          return index.index(entry);
        },
      });
    }
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    onTestFinished(() => error.mockRestore());
    const opened = await start(openDoc(new Backing('retry-doc'), FedDoc as never));
    await opened.dobj.create({ folderId: 'f', ownerId: 'o', title: 'Retry', markdown: 'First words.' });
    await opened.dobj.onSave();
    expect(opened.backing.alarm, 'nothing due').toBeNull();
    failures = 2;
    serverWrite(opened.dobj.document, 'author-edit', () => {
      const paragraph = $getRoot().getFirstChild();
      if (!$isElementNode(paragraph)) throw new Error('no paragraph');
      paragraph.append($createTextNode(' Fresh words.'));
    });
    await opened.dobj.onSave();
    const first = opened.backing.alarm;
    expect(first, 'the failed feed schedules its retry').not.toBeNull();
    const firstWait = first! - Date.now();
    vi.setSystemTime(first!);
    await opened.dobj.alarm();
    const second = opened.backing.alarm;
    expect(second, 'failed again: it tries again').not.toBeNull();
    expect(second! - Date.now(), 'later each time').toBeGreaterThan(firstWait);
    vi.setSystemTime(second!);
    await opened.dobj.alarm();
    expect((await index.search({ query: 'fresh', allowedDocIds: ['retry-doc'] })).results.map((hit) => hit.docId)).toEqual(['retry-doc']);
    expect(opened.backing.alarm, 'fed: nothing left due').toBeNull();
    const count = tries.length;
    const woken = await start(wake(opened));
    await vi.advanceTimersByTimeAsync(1_500);
    expect(tries, 'the retry marked the doc fed').toHaveLength(count);

    // An earlier alarm, a trash's settle, is kept: the retry never pushes it out.
    await woken.dobj.trash('hold-1');
    const settle = woken.backing.alarm!;
    vi.setSystemTime(settle - 500);
    failures = 1;
    serverWrite(woken.dobj.document, 'author-edit', () => {
      const paragraph = $getRoot().getFirstChild();
      if (!$isElementNode(paragraph)) throw new Error('no paragraph');
      paragraph.append($createTextNode(' Later words.'));
    });
    await woken.dobj.onSave();
    expect(tries, 'the feed was tried and failed').toHaveLength(count + 1);
    expect(woken.backing.alarm, 'the settle stays first').toBe(settle);
  });
});
