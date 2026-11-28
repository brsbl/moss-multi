// T7.S4: DocDO.create answers the created revision's export, which the CLI records as an adopted file's base, and
// keeps it as a push base, so a peer's edit after create and a push against that base both land.
import { expect, it } from 'vitest';
import { sha256Hex } from '../../src/doc/bases.ts';
import { openDoc, start } from './do-harness.ts';

const AGENT = { id: 'agent-1', name: 'Scribe' };

it('create returns the created revision\'s export and keeps it as a push base', async () => {
  const opened = await start(openDoc());
  const created = await opened.dobj.create({ folderId: 'f', ownerId: 'ada', markdown: 'Beans first.\n\nPeas next.' });
  expect(typeof created).toBe('string');
  expect(created).toBe(await opened.dobj.exportMarkdown());
  const baseHash = await sha256Hex(created);
  const push = (newText: string) => opened.dobj.push({
    newText, baseHash, reviewer: { id: AGENT.id, role: 'editor' },
    actor: { kind: 'agent', principalId: AGENT.id, sessionId: null, shareToken: null },
  });
  // A peer edits after create; the adopting CLI then pushes its own edit against the created base.
  expect(await push(created.replace('Peas next.', 'Peas next.\n\nSquash last.'))).toMatchObject({ ok: true });
  expect(await push(created.replace('Beans first.', 'Beans first, in June.'))).toMatchObject({ ok: true });
  const merged = await opened.dobj.exportMarkdown();
  expect(merged).toContain('Beans first, in June.');
  expect(merged).toContain('Squash last.');
});
