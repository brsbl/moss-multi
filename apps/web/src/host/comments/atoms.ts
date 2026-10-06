// The comments projection into moss's atoms (docs/design/comments.md §12): one observer per pane turns the doc's
// records into `noteCommentsMapAtom(noteId)`, the map every moss comment surface reads. Records carry principal ids;
// the projection adds the author's label and, for a root, whether it is detached and the quote it was left with.
import { noteCommentsMapAtom } from '@moss/shared/state/note-atoms';
import type { useStore } from 'jotai';
import type { Doc } from 'yjs';
import { modelFor, type CommentRecord, type CommentsModel } from './model.ts';
import { authorLabel, subscribePeople } from './people.ts';

type Store = ReturnType<typeof useStore>;

/** moss's comment colors: 0 user, 3 agent, 4 external (MarkdownEditor.css). */
const COLOR: Record<CommentRecord['source'], number> = { user: 0, agent: 3, external: 4 };
export const colorOf = (record: Pick<CommentRecord, 'source'>): number => COLOR[record.source] ?? 0;

/**
 * moss's NoteComment plus what the web adds: `author`, `authorLabel`, `reactions`, `seq`, and `detached` and `quote`
 * on a root.
 */
export interface ProjectedComment {
  id: string;
  text: string;
  createdAt: number;
  updatedAt: number;
  seq: number;
  color: number;
  source: CommentRecord['source'];
  parentId?: string;
  resolvedAt?: number;
  resolvedBy?: CommentRecord['source'];
  author: string;
  authorLabel: string;
  reactions: Record<string, string[]>;
  detached?: boolean;
  quote?: string;
}

/** A record's write order; a pending comment, not written yet, sorts after every written one. */
const seqOf = (record: CommentRecord): number => (typeof record.seq === 'number' ? record.seq : Number.MAX_SAFE_INTEGER);

export function project(docId: string, model: CommentsModel): Record<string, ProjectedComment> {
  const out: Record<string, ProjectedComment> = {};
  // In write order, so moss's stable createdAt sorts keep the DocDO's order within one second.
  const records = [...model.records()].sort(([, a], [, b]) => a.createdAt - b.createdAt || seqOf(a) - seqOf(b));
  for (const [id, record] of records) {
    const anchor = record.parentId === undefined ? model.anchor(id) : undefined;
    out[id] = {
      id,
      text: record.text,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      seq: seqOf(record),
      color: colorOf(record),
      source: record.source,
      ...(record.parentId !== undefined ? { parentId: record.parentId } : {}),
      ...(record.resolvedAt !== undefined ? { resolvedAt: record.resolvedAt } : {}),
      ...(record.resolvedBy !== undefined ? { resolvedBy: record.resolvedBy } : {}),
      author: record.author,
      authorLabel: authorLabel(docId, record.author),
      reactions: record.reactions ?? {},
      ...(anchor ? { detached: anchor.status !== 'anchored', quote: anchor.quote } : {}),
    };
  }
  return out;
}

/** Keeps `noteCommentsMapAtom(docId)` equal to the doc's comments; returns the stop. */
export function bindCommentAtoms(store: Store, docId: string, doc: Doc): () => void {
  const model = modelFor(doc);
  const atom = noteCommentsMapAtom(docId);
  let last = '';
  const publish = () => {
    const next = project(docId, model);
    const key = JSON.stringify(next);
    if (key === last) return;
    last = key;
    store.set(atom, next);
  };
  publish();
  const stopModel = model.subscribe(publish);
  const stopPeople = subscribePeople(publish);
  return () => {
    stopModel();
    stopPeople();
  };
}
