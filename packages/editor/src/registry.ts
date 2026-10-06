// Mounted editors by moss note id (the note's id key). moss's renderer calls out with a note id (media URLs, uploads,
// embed previews, HTML frames); each call reaches the bridge and services of the editor that owns that note.
import type { MossAssetKind, MossEditorBridge, MossEditorServices } from './contract';
import type { EditorSession } from './session';
import { noteIdKey } from './host/moss-editor-host.js';

export interface EditorRecord {
  noteId: string;
  bridge: MossEditorBridge;
  services: MossEditorServices;
  htmlFrameUrl: string | null;
  session: EditorSession;
  /** The mount's element, which holds its HTML block frames. */
  element: HTMLElement;
  /** HTML blocks the user pressed Run on in this mount, as `block:<node key>` and `html:<frame HTML>` (ruling 21). */
  ran: Set<string>;
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

/** The editor whose element holds `node`. */
export function editorHolding(node: Node): EditorRecord | undefined {
  for (const record of editors.values()) if (record.element.contains(node)) return record;
  return undefined;
}

export function markActive(noteId: string): void {
  lastActive = noteId;
}

/** The editor the user last pressed in, for calls moss makes without a note id. */
export function activeEditor(): EditorRecord | undefined {
  return editorFor(lastActive);
}

export const assetKind = (ref: string): MossAssetKind => (/\.(mp4|webm|mov)(?:[?#].*)?$/i.test(ref) ? 'video' : 'image');

/**
 * A URL a mounted editor's host issued for a note's asset (`assets.parseUrl`), read back to the note and reference,
 * for media pasted from an editor or viewer frame. Null for any other URL.
 */
export function hostAsset(url: string): { noteId: string; ref: `assets/${string}` } | null {
  for (const bridge of new Set([...editors.values()].map((record) => record.bridge))) {
    let parsed: ReturnType<MossEditorBridge['assets']['parseUrl']>;
    try {
      parsed = bridge.assets.parseUrl(url);
    } catch {
      parsed = null;
    }
    const ref = parsed?.ref;
    if (parsed && typeof ref === 'string' && /^assets\/[^\\]+$/.test(ref) && !ref.split('/').some((part) => part === '' || part === '.' || part === '..')) {
      return { noteId: noteIdKey(parsed.noteId), ref };
    }
  }
  return null;
}

/** The URL an editor's note loads for a media reference; undefined when no editor renders `noteId`. */
export function editorAssetUrl(ref: string, noteId: string | null | undefined): string | undefined {
  const record = editorFor(noteId);
  if (!record) return undefined;
  // Media pasted this session already carries the URL the host issued for it.
  if (/^(blob|data):/.test(ref)) return ref;
  return record.bridge.assets.url(record.noteId, ref, assetKind(ref)) || NO_MEDIA;
}
