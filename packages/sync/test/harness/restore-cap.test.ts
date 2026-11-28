// T6.S7 (whole-repo Slop Cop; A§5.1 Limits, A§14): a server write near the state cap is admitted on the size each
// payload it touches would have after it, not the payload's stored bytes plus the update, so a restore that replaces a
// large block with a smaller or same-size version is never refused 413. One that would end past the cap still is,
// with nothing written and no restore point.
import { $getRoot } from 'lexical';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { DocDO } from '../../src/doc-do.ts';
import { captureRestoreBase } from '../../src/restore-base.ts';
import { Backing, openDoc, start, type Opened } from './do-harness.ts';
import { LiveClient, syncAll } from './live-client.ts';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

const ADA = { id: 'ada', role: 'editor' as const };
const CAP = 16 * 1024;

/** Its own limits object, which an instance reads by reference, so a test can lower the cap after setting up. */
class Capped extends DocDO {
  static override limits = { ...DocDO.limits, stateCapBytes: CAP };
}

async function note(): Promise<{ opened: Opened; ada: LiveClient }> {
  Capped.limits.stateCapBytes = CAP;
  Capped.limits.textCharCap = DocDO.limits.textCharCap;
  Capped.limits.structCap = DocDO.limits.structCap;
  const opened = await start(openDoc(new Backing(), Capped as never));
  await opened.dobj.create({ folderId: 'folder-1', ownerId: 'ada', markdown: 'Intro.\n' });
  const ada = await LiveClient.open(opened, { id: 'ada', role: 'editor' });
  onTestFinished(() => {
    ada.dispose();
    Capped.limits.stateCapBytes = CAP;
    Capped.limits.textCharCap = DocDO.limits.textCharCap;
    Capped.limits.structCap = DocDO.limits.structCap;
  });
  return { opened, ada };
}

async function settle(ada: LiveClient): Promise<void> {
  await syncAll(ada);
  await syncAll(ada);
}

/** A code block holding `saved`, saved as a version, then retyped to `live` (erased, then typed). */
async function retyped(saved: string, live: string): Promise<{ opened: Opened; ada: LiveClient; id: string }> {
  const { opened, ada } = await note();
  ada.insert('code-block', saved);
  await settle(ada);
  const saving = await opened.dobj.saveVersion({ name: 'Saved', reviewer: ADA });
  if (!saving.ok) throw new Error(saving.reason);
  ada.erase(0, 0, saved.length);
  await settle(ada);
  ada.type(0, 0, live);
  await settle(ada);
  expect(ada.texts()).toEqual([live]);
  return { opened, ada, id: saving.version.id };
}

const restore = (opened: Opened, ada: LiveClient, id: string) =>
  opened.dobj.restoreVersion({ id, reviewer: ADA, base: { ...captureRestoreBase(ada.doc, ada.payloads), age: 0 } });

async function kinds(opened: Opened): Promise<string[]> {
  const listed = await opened.dobj.listVersions({ reviewer: ADA });
  if (!listed.ok) throw new Error(listed.reason);
  return listed.versions.map((version) => version.kind);
}

describe('a server write near the cap counts each touched payload at its size after the write @p:tech-8', () => {
  it('restores a smaller version of a large block near the cap', async () => {
    // Stored: 4,000 + 8,000 bytes of history; after the restore the block holds 4,000.
    const { opened, ada, id } = await retyped('a'.repeat(4_000), 'b'.repeat(8_000));
    expect(await restore(opened, ada, id)).toMatchObject({ ok: true });
    await settle(ada);
    expect(ada.texts()).toEqual(['a'.repeat(4_000)]);
    expect(await opened.dobj.exportMarkdown()).toContain('a'.repeat(4_000));
  });

  it('restores a same-size version of a large block near the cap', async () => {
    const { opened, ada, id } = await retyped('a'.repeat(6_000), 'b'.repeat(6_000));
    expect(await restore(opened, ada, id)).toMatchObject({ ok: true });
    await settle(ada);
    expect(ada.texts()).toEqual(['a'.repeat(6_000)]);
  });

  it('refuses 413 a restore that would end past the cap, writing nothing and storing no restore point', async () => {
    const { opened, ada, id } = await retyped('a'.repeat(6_000), 'b'.repeat(100));
    Capped.limits.stateCapBytes = 4 * 1024;
    const markdown = await opened.dobj.exportMarkdown();
    const before = await kinds(opened);
    expect(await restore(opened, ada, id)).toMatchObject({ ok: false, status: 413, reason: 'doc-cap' });
    await settle(ada);
    expect(await opened.dobj.exportMarkdown()).toBe(markdown);
    expect(ada.texts()).toEqual(['b'.repeat(100)]);
    expect(await kinds(opened)).toEqual(before);
  });
});

// T6.V (T3.B31c on m6): a restore is held to the note's text and structure limits as every server write is, its
// payloads counted by what the restore adds to them, and a refusal names the limit it met.
describe("a restore meets the note's text and structure limits and names the one it meets @p:tech-8", () => {
  it('refuses 413 text a version whose code block no longer fits the text limit, writing nothing', async () => {
    const { opened, ada, id } = await retyped('a'.repeat(6_000), 'b'.repeat(100));
    Capped.limits.textCharCap = 3_000;
    const markdown = await opened.dobj.exportMarkdown();
    const before = await kinds(opened);
    expect(await restore(opened, ada, id)).toMatchObject({ ok: false, status: 413, reason: 'doc-cap', limit: 'text' });
    await settle(ada);
    expect(await opened.dobj.exportMarkdown()).toBe(markdown);
    expect(ada.texts()).toEqual(['b'.repeat(100)]);
    expect(await kinds(opened)).toEqual(before);
  });

  it('refuses 413 structure a version whose paragraphs no longer fit the structure limit, writing nothing', async () => {
    const { opened, ada } = await note();
    for (let i = 0; i < 60; i += 1) ada.insertParagraph(`Line ${i}.`);
    await settle(ada);
    const saving = await opened.dobj.saveVersion({ name: 'Long', reviewer: ADA });
    if (!saving.ok) throw new Error(saving.reason);
    ada.editor.update(() => {
      for (const node of $getRoot().getChildren()) if (node.getTextContent().startsWith('Line ')) node.remove();
    }, { discrete: true });
    await settle(ada);
    expect(ada.paragraphs()).toEqual(['Intro.']);
    Capped.limits.structCap = (await opened.dobj.noteSize()).structs + 5;
    const markdown = await opened.dobj.exportMarkdown();
    const before = await kinds(opened);
    expect(await restore(opened, ada, saving.version.id)).toMatchObject({ ok: false, status: 413, reason: 'doc-cap', limit: 'structure' });
    await settle(ada);
    expect(await opened.dobj.exportMarkdown()).toBe(markdown);
    expect(ada.paragraphs()).toEqual(['Intro.']);
    expect(await kinds(opened)).toEqual(before);
  });

  it('restores the same version once the limits leave room for it', async () => {
    const { opened, ada, id } = await retyped('a'.repeat(6_000), 'b'.repeat(100));
    Capped.limits.textCharCap = 6_100;
    expect(await restore(opened, ada, id)).toMatchObject({ ok: true });
    await settle(ada);
    expect(ada.texts()).toEqual(['a'.repeat(6_000)]);
  });
});
