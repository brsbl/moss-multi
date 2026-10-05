// Mounted editors by moss note id (the note's id key). moss's renderer calls out with a note id (media URLs, uploads,
// embed previews, HTML frames); each call reaches the bridge and services of the editor that owns that note.
import type { MossAssetKind, MossEditorBridge, MossEditorServices } from './contract';
import type { EditorSession } from './session';

export interface EditorRecord {
  noteId: string;
  bridge: MossEditorBridge;
  services: MossEditorServices;
  htmlFrameUrl: string | null;
  session: EditorSession;
}

/** A URL that loads nothing and fails as media, for a reference the host did not resolve. */
export const NO_MEDIA = 'data:,';

const editors = new Map<string, EditorRecord>();
let lastActive: string | null = null;

export function registerEditor(record: EditorRecord): () => void {
  editors.set(record.noteId, record);
  return () => {
    if (editors.get(record.noteId) === record) editors.delete(record.noteId);
    if (lastActive === record.noteId) lastActive = null;
  };
}

export function editorFor(noteId: string | null | undefined): EditorRecord | undefined {
  return noteId ? editors.get(noteId) : undefined;
}

export function markActive(noteId: string): void {
  lastActive = noteId;
}

/** The editor the user last pressed in, for calls moss makes without a note id. */
export function activeEditor(): EditorRecord | undefined {
  return editorFor(lastActive);
}

export const assetKind = (ref: string): MossAssetKind => (/\.(mp4|webm|mov)(?:[?#].*)?$/i.test(ref) ? 'video' : 'image');

/** The URL an editor's note loads for a media reference; undefined when no editor renders `noteId`. */
export function editorAssetUrl(ref: string, noteId: string | null | undefined): string | undefined {
  const record = editorFor(noteId);
  if (!record) return undefined;
  // Media pasted this session already carries the URL the host issued for it.
  if (/^(blob|data):/.test(ref)) return ref;
  return record.bridge.assets.url(record.noteId, ref, assetKind(ref)) || NO_MEDIA;
}
