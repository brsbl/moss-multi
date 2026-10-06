// T4.2 fast-check against the real DocDO (docs/design/comments.md I3-I5): random concurrent edits by two bound editors,
// online, stale, replayed under the frame discipline or merged into one frame, never leave an anchored comment on text
// outside its lineage. Every character in the note is unique, so lineage is checkable by value: after each frame an
// anchored comment's first and last characters must be ones that were inside its range before that frame (or, for a
// reattach, ones its lost passage held).
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { $searchText, $selectAt, scene, type FrameVerdict, type Peer, type Scene } from './comments-scene.ts';

/** Characters no other character in a run repeats: CJK ideographs, one per use. */
const BASE = 0x4e00;
const PARAGRAPH = 14;
const unique = (n: number) => String.fromCharCode(BASE + n);
const BODY = [0, 1, 2].map((p) => Array.from({ length: PARAGRAPH }, (_, i) => unique(p * PARAGRAPH + i)).join('')).join('\n\n');

type Mode = 'each' | 'grouped' | 'merged';
type Op =
  | { k: 'type' | 'enter'; peer: number; at: number }
  | { k: 'delete' | 'bold'; peer: number; at: number; len: number }
  | { k: 'undo' | 'redo' | 'offline'; peer: number }
  | { k: 'send' | 'online'; peer: number; mode: Mode };

const peerArb = fc.integer({ min: 0, max: 1 });
const atArb = fc.nat({ max: 60 });
const modeArb = fc.constantFrom<Mode>('each', 'grouped', 'merged');
const opArb: fc.Arbitrary<Op> = fc.oneof(
  fc.record({ k: fc.constantFrom('type' as const, 'enter' as const), peer: peerArb, at: atArb }),
  fc.record({ k: fc.constantFrom('delete' as const, 'bold' as const), peer: peerArb, at: atArb, len: fc.integer({ min: 1, max: 8 }) }),
  fc.record({ k: fc.constantFrom('undo' as const, 'redo' as const, 'offline' as const), peer: peerArb }),
  fc.record({ k: fc.constantFrom('send' as const, 'online' as const), peer: peerArb, mode: modeArb }),
);
const commentArb = fc.record({ p: fc.integer({ min: 0, max: 2 }), from: fc.nat({ max: PARAGRAPH - 1 }), len: fc.integer({ min: 1, max: PARAGRAPH }) });

function send(peer: Peer, mode: Mode): Promise<FrameVerdict[]> {
  return mode === 'each' ? peer.send() : mode === 'grouped' ? peer.sendGrouped() : peer.sendMerged();
}

/** One editing op on a peer's own editor; an op its current text cannot take (no text point there) is skipped. */
function edit(peer: Peer, op: Op, next: () => string): void {
  if (!('at' in op)) return;
  const text = peer.editor.getEditorState().read($searchText);
  const at = op.at % (text.length + 1);
  try {
    if (op.k === 'type') peer.edit(() => $selectAt(at, 0).insertText(next()));
    else if (op.k === 'enter') peer.edit(() => $selectAt(at, 0).insertParagraph());
    else if (op.k === 'delete' || op.k === 'bold') {
      const len = Math.min(op.len, text.length - at);
      if (len <= 0) return;
      peer.edit(() => (op.k === 'delete' ? $selectAt(at, len).removeText() : $selectAt(at, len).formatText('bold')));
    }
  } catch (error) {
    if (!/no text point/.test(String(error))) throw error;
  }
}

/** Checks every comment after each frame the DocDO takes; returns the violations found. */
function watchLineage(s: Scene, ids: string[]): string[] {
  const violations: string[] = [];
  const lineage = new Map<string, Set<string>>();
  for (const id of ids) lineage.set(id, new Set(s.text(id) ?? ''));
  s.afterFrame = () => {
    for (const id of ids) {
      if (s.status(id) !== 'anchored') continue;
      const text = s.text(id);
      const seen = lineage.get(id)!;
      if (text === null || text.length === 0) {
        violations.push(`${id} is anchored on nothing it can paint`);
        continue;
      }
      for (const end of [text[0], text[text.length - 1]]) if (!seen.has(end)) violations.push(`${id} is anchored on "${text}", whose end "${end}" was never in its range`);
      for (const char of text) seen.add(char);
    }
  };
  return violations;
}

describe('T4.2 random concurrent edits never leave an anchored comment outside its lineage @p:tech-3 @p:R18', () => {
  it('fast-check: two editors, online, stale and replayed, against the real DocDO', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(commentArb, { minLength: 1, maxLength: 3 }), fc.array(opArb, { minLength: 1, maxLength: 30 }), async (comments, ops) => {
        await scene(async (s) => {
          const peers = [s.peer(), s.peer()];
          const ids: string[] = [];
          for (const [i, { p, from, len }] of comments.entries()) {
            ids.push(`c${i}`);
            await s.commentAt(`c${i}`, p * PARAGRAPH + from, Math.min(len, PARAGRAPH - from));
          }
          const violations = watchLineage(s, ids);
          const refused: string[] = [];
          const offline = new Set<number>();
          let typed = 3 * PARAGRAPH;
          const next = () => unique(typed++);
          const deliver = async (peer: number, mode: Mode) => {
            for (const verdict of await send(peers[peer], mode)) if (verdict.refused) refused.push(verdict.refused);
          };
          for (const op of ops) {
            const peer = peers[op.peer];
            if (op.k === 'undo') peer.undo();
            else if (op.k === 'redo') peer.redo();
            else if (op.k === 'offline') {
              offline.add(op.peer);
              s.offline(peer);
            } else if (op.k === 'online') {
              offline.delete(op.peer);
              s.online(peer);
              await deliver(op.peer, op.mode);
            } else if (op.k === 'send') {
              if (!offline.has(op.peer)) await deliver(op.peer, op.mode);
            } else edit(peer, op, next);
          }
          for (const [i, peer] of peers.entries()) {
            s.online(peer);
            await deliver(i, 'grouped');
          }
          expect(refused, 'an honest editor is never refused').toEqual([]);
          expect(violations).toEqual([]);
        }, BODY);
      }),
      { numRuns: 40 },
    );
  });
});
