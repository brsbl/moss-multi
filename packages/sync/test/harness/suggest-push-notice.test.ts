// `push --suggest` notifies collaborators once, and only of a suggestion that exists: the ingest creates the record on
// the push's first op, but the notice waits until every op is admitted and the record is marked as the CLI's. A later
// op refused (here over a reduced record cap) withdraws the record, the push is refused 409, and nobody is told.
// @p:agt-1 @p:mean-2
import { afterEach, expect, it } from 'vitest';
import { mergeBudget } from '@moss-multi/core/merge';
import { sha256Hex } from '../../src/doc/bases.ts';
import { SUGGEST_CAPS } from '../../src/doc/suggest.ts';
import { DocDO } from '../../src/doc-do.ts';
import { landPush } from '../../src/push.ts';
import { readMeta, recordIds } from '../../src/suggest/records.ts';
import { openDoc, start, type Opened } from './do-harness.ts';

const AGENT = { id: 'agent-1', name: 'Scribe' };
const BODY = 'Beans first.\n\nPeas next.';
/** A new code block: a body op for the block, then a payload op for its code. */
const PUSHED = `${BODY}\n\n\`\`\`javascript\n${'const row = 1;\n'.repeat(400)}\`\`\``;
const caps = SUGGEST_CAPS as { recordOpsBytes: number };
const recordCap = caps.recordOpsBytes;

afterEach(() => {
  caps.recordOpsBytes = recordCap;
  DocDO.suggestionNotices = () => null;
});

async function seeded(): Promise<{ opened: Opened; notices: { record: string; source: string | undefined }[] }> {
  const notices: { record: string; source: string | undefined }[] = [];
  const opened = await start(openDoc());
  DocDO.suggestionNotices = () => async (notice) => {
    notices.push({ record: notice.record, source: readMeta(opened.dobj.document, notice.record)?.source });
  };
  await opened.dobj.create({ folderId: 'f', ownerId: 'ada', markdown: BODY });
  return { opened, notices };
}

async function suggestPush(opened: Opened, base: string, newText: string) {
  return opened.dobj.push({
    newText, baseHash: await sha256Hex(base), baseText: base, suggest: true, authorName: AGENT.name,
    reviewer: { id: AGENT.id, role: 'suggester' },
    actor: { kind: 'agent', principalId: AGENT.id, sessionId: null, shareToken: null },
  });
}

/** Every notice started has run: the notifier is async and extended with waitUntil. */
const settled = () => new Promise((resolve) => setTimeout(resolve, 20));

const open = (opened: Opened) => recordIds(opened.dobj.document).filter((id) => readMeta(opened.dobj.document, id)?.status === 'open');

it('a --suggest push refused at its second op leaves no record and notifies nobody (B352)', async () => {
  const { opened, notices } = await seeded();
  const base = await opened.dobj.pullMarkdown();
  // The push's ops, measured: the cap admits the first and refuses the second.
  const fork = { client: 4242, ops: [] as { doc: string; update: Uint8Array }[] };
  expect(landPush(opened.dobj.document, opened.backing.docId, { base, newText: PUSHED, force: false, fork, budget: mergeBudget() }, 'measure')).toMatchObject({ ok: true });
  expect(fork.ops.map((op) => op.doc)[0], 'the body op comes first').toBe('body');
  expect(fork.ops.length, 'and a payload op follows').toBeGreaterThanOrEqual(2);
  const [first, second] = fork.ops.map((op) => op.update.byteLength);
  caps.recordOpsBytes = first! + Math.floor(second! / 2);

  const refused = await suggestPush(opened, base, PUSHED);
  expect(refused).toMatchObject({ ok: false, status: 409, reason: 'suggest-refused' });
  await settled();
  expect(open(opened), 'the refused push leaves no open record').toEqual([]);
  expect(notices, 'and nobody is told of a suggestion that does not exist').toEqual([]);
  expect(await opened.dobj.exportMarkdown(), 'the body is untouched').toBe(base);
});

it('a --suggest push of several ops notifies exactly once, after the record is complete (B352)', async () => {
  const { opened, notices } = await seeded();
  const base = await opened.dobj.pullMarkdown();
  const landed = await suggestPush(opened, base, PUSHED);
  expect(landed).toMatchObject({ ok: true });
  const record = (landed as { suggestionId: string }).suggestionId;
  await settled();
  expect(open(opened)).toEqual([record]);
  expect(notices, 'one notice, sent once the record is marked as the CLI\'s').toEqual([{ record, source: 'cli' }]);
});
