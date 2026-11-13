// T6.S1 (M6 Slop Cop P1; A§14): a restore is three-way against its base, the note as the restorer saw it when it
// opened Restore. The version's content replaces what was there at the base; whatever anyone inserted after the base
// (a peer's word typed across the restore, an agent's write) is kept where it was typed, in the body and in payloads.
// A base that is missing or too old is refused 409; with nothing typed since, the result is the version exactly.
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { RESTORE_BASE_MAX_AGE_MS } from '@moss-multi/protocol/limits';
import * as Y from 'yjs';
import { PayloadDocs, payloadText } from '../../src/payload-docs.ts';
import { captureRestoreBase, type RestoreBase } from '../../src/restore-base.ts';
import { openDoc, start, type Opened } from './do-harness.ts';
import { LiveClient, syncAll, type Kind } from './live-client.ts';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

const ADA = { id: 'ada', role: 'editor' as const };

async function note(markdown: string): Promise<{ opened: Opened; ada: LiveClient; ben: LiveClient }> {
  const opened = await start(openDoc());
  await opened.dobj.create({ folderId: 'folder-1', ownerId: 'ada', markdown });
  const ada = await LiveClient.open(opened, { id: 'ada', role: 'editor' });
  const ben = await LiveClient.open(opened, { id: 'ben', role: 'editor' });
  onTestFinished(() => {
    ada.dispose();
    ben.dispose();
  });
  return { opened, ada, ben };
}

async function save(opened: Opened, name: string): Promise<string> {
  const saved = await opened.dobj.saveVersion({ name, reviewer: ADA });
  if (!saved.ok) throw new Error(saved.reason);
  return saved.version.id;
}

/** Ada opens Restore: the base is her client's note and payloads as she sees them now. */
const opensRestore = (ada: LiveClient): Omit<RestoreBase, 'age'> => captureRestoreBase(ada.doc, ada.payloads);

const restore = (opened: Opened, id: string, base: Omit<RestoreBase, 'age'> | undefined, age = 0) =>
  opened.dobj.restoreVersion({ id, reviewer: ADA, ...(base ? { base: { ...base, age } } : {}) });

async function settle(...clients: LiveClient[]): Promise<void> {
  await syncAll(...clients);
  await syncAll(...clients);
}

describe('a restore is three-way against the base its dialog opened on @p:mean-3', () => {
  it("keeps the whole word a peer types across the restore, where he typed it, and takes out what the base held", async () => {
    const { opened, ada, ben } = await note('The quick brown fox jumps over the lazy dog.\n\nA second line.\n');
    const id = await save(opened, 'First checkpoint');
    ada.appendToParagraph('A second', ' Ada added this.');
    await settle(ada, ben);

    const base = opensRestore(ada);
    // Ben starts his word; the server applies its head before the restore's turn.
    ben.appendToParagraph('The quick', ' Ben ke');
    await syncAll(ben);
    expect(await opened.dobj.exportMarkdown()).toContain('lazy dog. Ben ke');

    expect(await restore(opened, id, base)).toMatchObject({ ok: true });
    // The rest of his word was typed before the restore reached him.
    ben.appendToParagraph('The quick', 'eps this.');
    await settle(ben, ada);

    const markdown = await opened.dobj.exportMarkdown();
    expect(markdown, "Ben's whole insert survives, in place").toContain('The quick brown fox jumps over the lazy dog. Ben keeps this.');
    expect(markdown, "the restore takes out Ada's change, which the base held").not.toContain('Ada added this.');
    expect(ben.paragraphs()).toEqual(['The quick brown fox jumps over the lazy dog. Ben keeps this.', 'A second line.']);
    expect(ada.paragraphs()).toEqual(ben.paragraphs());
  });

  const PAYLOADS: Record<'code-block' | 'formula', { seed: string; later: string; head: string; tail: string }> = {
    'code-block': { seed: 'const answer = 42;', later: ' // ada', head: '/*pe', tail: 'er*/' },
    formula: { seed: 'A1+2', later: '*3', head: 'B', tail: '1+' },
  };

  it.each(Object.keys(PAYLOADS) as (keyof typeof PAYLOADS & Kind)[])('keeps the whole insert a peer types across the restore into a %s', async (kind) => {
    const { seed, later, head, tail } = PAYLOADS[kind];
    const { opened, ada, ben } = await note('Intro.\n');
    ada.insert(kind, seed);
    await settle(ada, ben);
    expect(ben.texts()).toEqual([seed]);
    const id = await save(opened, 'With the block');
    ada.type(0, seed.length, later);
    await settle(ada, ben);

    const base = opensRestore(ada);
    ben.type(0, 0, head);
    await syncAll(ben);
    expect(await restore(opened, id, base)).toMatchObject({ ok: true });
    ben.type(0, head.length, tail);
    await settle(ben, ada);

    const want = `${head}${tail}${seed}`;
    expect(ben.texts(), "the peer's whole insert, where he typed it, and the version's text").toEqual([want]);
    expect(ada.texts()).toEqual([want]);
    const fresh = await LiveClient.open(opened, { id: 'cara', role: 'editor' });
    onTestFinished(() => fresh.dispose());
    await settle(fresh);
    expect(fresh.texts(), 'the server holds it too').toEqual([want]);
  });

  it("keeps an agent's write made after the base", async () => {
    const { opened, ada } = await note('Plan.\n\nOld line.\n');
    const id = await save(opened, 'Plan');
    ada.appendToParagraph('Old line', ' changed by Ada');
    await settle(ada);

    const base = opensRestore(ada);
    const agent = await LiveClient.open(opened, { id: 'agent-1', kind: 'agent', role: 'editor', session: null });
    onTestFinished(() => agent.dispose());
    agent.insertParagraph('The agent wrote this.');
    await settle(agent);
    expect(await opened.dobj.exportMarkdown()).toContain('The agent wrote this.');

    expect(await restore(opened, id, base)).toMatchObject({ ok: true });
    await settle(ada, agent);
    const markdown = await opened.dobj.exportMarkdown();
    expect(markdown, "the agent's write stands").toContain('The agent wrote this.');
    expect(markdown).not.toContain('changed by Ada');
    expect(ada.paragraphs()).toEqual(['Plan.', 'The agent wrote this.', 'Old line.']);
  });

  it('keeps the first text a peer types into an empty block after the base', async () => {
    const { opened, ada, ben } = await note('Intro.\n');
    ada.insert('code-block', '');
    await settle(ada, ben);
    const id = await save(opened, 'Empty block');

    const base = opensRestore(ada);
    ben.type(0, 0, 'Ben types');
    await syncAll(ben);
    expect(await restore(opened, id, base)).toMatchObject({ ok: true });
    await settle(ben, ada);

    expect(ben.texts(), "the peer's first text stands").toEqual(['Ben types']);
    expect(ada.texts()).toEqual(['Ben types']);
  });

  it('refuses 409, changing nothing, when the version drops a block a peer typed into after the base', async () => {
    const { opened, ada, ben } = await note('Intro.\n');
    const id = await save(opened, 'Before the block');
    ada.insert('code-block', 'let a = 1;');
    await settle(ada, ben);

    const base = opensRestore(ada);
    ben.type(0, 0, 'Ben ');
    await syncAll(ben);
    const markdown = await opened.dobj.exportMarkdown();
    expect(markdown).toContain('Ben let a = 1;');

    expect(await restore(opened, id, base)).toMatchObject({ ok: false, status: 409, reason: 'restore-unverified' });
    expect(await opened.dobj.exportMarkdown()).toBe(markdown);
  });

  it('refuses 409 a base that leaves out a payload the note named at it', async () => {
    const { opened, ada } = await note('Intro.\n');
    ada.insert('code-block', 'let a = 1;');
    await settle(ada);
    const id = await save(opened, 'Block');
    ada.type(0, 0, '// x\n');
    await settle(ada);
    const markdown = await opened.dobj.exportMarkdown();

    const base = { ...opensRestore(ada), payloads: {} };
    expect(await restore(opened, id, base)).toMatchObject({ ok: false, status: 409, reason: 'restore-base-stale' });
    expect(await opened.dobj.exportMarkdown()).toBe(markdown);
  });

  it('bases every held payload, an empty one too, but not one still loading', () => {
    const payloads = new PayloadDocs();
    payloads.hold('empty', true);
    payloads.hold('loading').getText('x');
    payloads.await('loading');
    payloadText(payloads.hold('full', true)).insert(0, 'text');
    const base = captureRestoreBase(new Y.Doc(), payloads);
    expect(Object.keys(base.payloads).sort()).toEqual(['empty', 'full']);
  });

  it('refuses a stale base and a missing one 409, changing nothing', async () => {
    const { opened, ada } = await note('alpha\n');
    const id = await save(opened, 'Alpha');
    ada.appendToParagraph('alpha', ' beta');
    await settle(ada);
    const markdown = await opened.dobj.exportMarkdown();
    const base = opensRestore(ada);

    expect(await restore(opened, id, base, RESTORE_BASE_MAX_AGE_MS + 1)).toMatchObject({ ok: false, status: 409, reason: 'restore-base-stale' });
    expect(await restore(opened, id, undefined)).toMatchObject({ ok: false, status: 409, reason: 'restore-base-stale' });
    expect(await opened.dobj.exportMarkdown()).toBe(markdown);
    const listed = await opened.dobj.listVersions({ reviewer: ADA });
    if (!listed.ok) throw new Error(listed.reason);
    expect(listed.versions.map((version) => version.kind), 'no restore point either').toEqual(['named']);
  });

  it('lands the version exactly when nothing was typed since the base', async () => {
    const { opened, ada } = await note('# Heading\n\nalpha\n\n- one\n- two\n');
    ada.insert('code-block', 'let a = 1;');
    await settle(ada);
    const id = await save(opened, 'Exact');
    ada.appendToParagraph('alpha', ' and more');
    ada.type(0, 0, '// changed\n');
    ada.insertParagraph('A new paragraph.');
    await settle(ada);

    expect(await restore(opened, id, opensRestore(ada))).toMatchObject({ ok: true });
    const version = await opened.dobj.getVersion({ id, reviewer: ADA });
    if (!version.ok) throw new Error(version.reason);
    expect(await opened.dobj.exportMarkdown()).toBe(version.version.markdown);
    expect(opened.dobj.document.getText('title').toString()).toBe(version.version.title);
  });
});
