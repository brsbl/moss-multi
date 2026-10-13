// SearchDO and the DocDO's feed in the Node harness (T3.4; A§5.3; L§4.14): bodies are the converter's markdown, so
// snippets are text and backlinks survive an edit; results never name a doc outside the caller's closure.
import { $createTextNode, $getRoot, $isElementNode } from 'lexical';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { DocDO, type SearchFeed } from '../../src/doc-do.ts';
import { payloadText } from '../../src/payload-docs.ts';
import { captureRestoreBase } from '../../src/restore-base.ts';
import { SearchDO, type IndexEntry } from '../../src/search-do.ts';
import { payloadSourceOf, serverWrite } from '../../src/server-doc.ts';
import { Backing, openDoc, start, wake } from './do-harness.ts';
import { LiveClient, syncAll } from './live-client.ts';
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
});
