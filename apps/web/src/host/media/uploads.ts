// The web `images` namespace (A§9 images; A§16): moss's drop, paste and "/media → From computer" upload the file's
// bytes to its note's asset route, and moss's cross-note paste copies on the server. Moss only logs a failed upload,
// so every refusal is announced first, in the server's own sentence (A§0 #2: never dropped silently).
import { MEDIA_TYPES, mediaTypeOf } from '@moss-multi/protocol/media';
import { AnnouncedRefusal, announceRefusal } from '../refusal.ts';
import { shareToken, webAssetUrl } from './web-asset-url.ts';

/** moss's ImageSaveResult. */
export interface SavedMedia {
  relativePath: string;
  absolutePath: string;
  filename: string;
}

export interface UploadDeps {
  request: (path: string, init?: RequestInit) => Promise<Response>;
  /** The browser's file chooser; resolves `[]` when it is dismissed. */
  chooseFiles: (accept: string) => Promise<File[]>;
  /** The page's share link, which a link editor's uploads carry as the doc socket does. */
  share?: () => string | null;
}

export const MEDIA_ACCEPT = Object.keys(MEDIA_TYPES).map((extension) => `.${extension}`).join(',');

const REFUSALS: Record<number, string> = {
  403: 'You can view this note but not add media to it.',
  404: 'This note is no longer available, so the file wasn’t added.',
  413: 'That file is too large to upload.',
  415: 'Only images (png, jpg, gif, webp, svg) and video (mp4, webm, mov) can be uploaded.',
};
const UPLOAD_FAILED = 'The file couldn’t be uploaded. Try again.';
const NO_NOTE = 'Open a note before adding media.';

async function sentenceOf(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { message?: unknown };
    if (typeof body.message === 'string' && body.message.trim()) return body.message.trim();
  } catch {
    // not JSON: the status says it
  }
  return REFUSALS[response.status] ?? UPLOAD_FAILED;
}

/** A pasted screenshot can arrive named `image` or `Screenshot`; its type names the extension the server needs. */
export function uploadName(filename: string, mimeType: string): string {
  if (mediaTypeOf(filename)) return filename;
  const extension = Object.entries(MEDIA_TYPES).find(([, type]) => type.contentType === mimeType)?.[0];
  return extension ? `${filename || 'media'}.${extension}` : filename;
}

function decodeBase64(data: string): Uint8Array<ArrayBuffer> {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function createImagesApi({ request, chooseFiles, share = shareToken }: UploadDeps) {
  const assetPath = (noteId: string) => `/api/docs/${encodeURIComponent(noteId)}/assets`;
  const withShare = (query: URLSearchParams) => {
    const token = share();
    if (token) query.set('share', token);
    const search = query.toString();
    return search ? `?${search}` : '';
  };
  const saved = async (noteId: string, response: Response): Promise<SavedMedia> => {
    if (!response.ok) throw announceRefusal(await sentenceOf(response));
    const { relativePath, filename } = (await response.json()) as { relativePath: string; filename: string };
    return { relativePath, absolutePath: webAssetUrl(noteId, filename), filename };
  };
  const send = async (path: string, init: RequestInit): Promise<Response> => {
    try {
      return await request(path, init);
    } catch {
      throw announceRefusal(UPLOAD_FAILED);
    }
  };

  const upload = async (noteId: string | undefined, filename: string, mimeType: string, body: BodyInit): Promise<SavedMedia> => {
    if (!noteId) throw announceRefusal(NO_NOTE);
    const name = uploadName(filename, mimeType);
    const contentType = mediaTypeOf(name)?.contentType ?? mimeType;
    const query = withShare(new URLSearchParams({ filename: name }));
    return saved(noteId, await send(`${assetPath(noteId)}${query}`, { method: 'POST', headers: { 'content-type': contentType }, body }));
  };

  return {
    save: (input: { data: string; filename: string; mimeType: string; noteId?: string }) =>
      upload(input.noteId, input.filename, input.mimeType, decodeBase64(input.data)),
    /** Each chosen file uploads in turn; one refused file is announced and the rest still land. */
    pick: async (input: { noteId?: string } = {}): Promise<SavedMedia[]> => {
      const results: SavedMedia[] = [];
      for (const file of await chooseFiles(MEDIA_ACCEPT)) {
        try {
          results.push(await upload(input.noteId, file.name, file.type, file));
        } catch (error) {
          if (!(error instanceof AnnouncedRefusal)) throw error;
        }
      }
      return results;
    },
    copyFromNoteAsset: async (input: { sourceNoteId: string; sourceRelativePath: string; destinationNoteId: string }): Promise<SavedMedia> => {
      const body = JSON.stringify({ sourceNoteId: input.sourceNoteId, sourceRelativePath: input.sourceRelativePath });
      const response = await send(`${assetPath(input.destinationNoteId)}/copy${withShare(new URLSearchParams())}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
      return saved(input.destinationNoteId, response);
    },
  };
}

/** The browser's chooser: a detached `<input type=file multiple>`, clicked inside the user's gesture. */
export function chooseFilesInBrowser(accept: string): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.multiple = true;
    input.hidden = true;
    const done = (files: File[]) => {
      input.remove();
      resolve(files);
    };
    input.addEventListener('change', () => done([...(input.files ?? [])]), { once: true });
    input.addEventListener('cancel', () => done([]), { once: true });
    document.body.appendChild(input);
    input.click();
  });
}
