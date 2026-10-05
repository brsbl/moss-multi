// ported-from: brsbl/moss@762abb777 (762abb7770714a49d912f6081384aabb958a7ea6), test-only reference.
//   packages/desktop/src/main/storage/note-store.ts (sha256 359f74f66a18151a35134645ec91612468ccb987e7e0687191ea163244055a0d)
//     96-98, 101, 207-213, 588-599, 635-667, 669-680, 682-743, 997-1031 (the id/title gate), 1819-1832 (temp name),
//     3915-3936, 4898-4911, 4943-4985
//   packages/desktop/src/main/ipc-handlers.ts (sha256 b89bd07c5870b1d7f33c7be45fecc1efc3bf6bf202c7545131c0fffbc96c72e2)
//     1161-1165, 1185-1191, 2532-2545
//   packages/desktop/src/renderer/editor/plugins/ExternalImagePastePlugin.tsx 155-157
// These live in Electron main-process modules that cannot be imported here, so the function bodies are copied
// verbatim. The only changes: filesystem calls go to an injected in-memory `fs`, closure state (workspaceRoot,
// activeNotesRoot, randomUUID, Date.now) is passed in, and the persistFile temp-name lines are lifted into a function.
import { Buffer } from 'node:buffer';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';

export const NOTE_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INVALID_PATH_CHARACTERS = /[<>:"/\\|?*\u0000-\u001F]/g;
const MAX_FOLDER_ALLOCATION_ATTEMPTS = 1000;
const NOTE_FILENAME = 'note.md';
const META_FILENAME = 'meta.json';
const NOTES_FOLDER_NAME = 'Notes';
const TRASH_FOLDER_NAME = 'Trash';
const UNTITLED_NOTE_TITLE = 'Untitled';
const EXTERNAL_MARKDOWN_EXTENSIONS = new Set(['.md', '.markdown']);

const isInsideDirectory = (target: string, parent: string): boolean => {
  const relativePath = relative(parent, target);
  return (
    relativePath.length === 0 ||
    (!relativePath.startsWith('..') && !relativePath.includes(`..${sep}`))
  );
};

export const assertValidNoteId = (value: unknown): string => {
  if (typeof value !== 'string') {
    throw new Error(`Invalid note identifier: expected string, got ${typeof value} (${JSON.stringify(value)})`);
  }

  const trimmed = value.trim();
  if (!NOTE_ID_PATTERN.test(trimmed)) {
    throw new Error(`Invalid note identifier: "${trimmed}" does not match UUID pattern`);
  }

  return trimmed;
};

const ensureWithinRoot = (rootDir: string, targetPath: string): string => {
  const relativePath = relative(rootDir, targetPath);

  if (
    relativePath.length === 0 ||
    relativePath.startsWith('..') ||
    relativePath.includes(`..${sep}`)
  ) {
    throw new Error('Resolved path escaped storage root');
  }

  return targetPath;
};

export const sanitizeFolderComponent = (value: string): string => {
  // Remove invalid path characters and normalize whitespace
  const sanitized = value.replace(INVALID_PATH_CHARACTERS, '').replace(/\s+/g, ' ').trim();

  // Defense-in-depth: reject path traversal sequences even though ensureWithinRoot
  // will catch them. This provides a clearer error message and early rejection.
  if (sanitized === '.' || sanitized === '..' || sanitized.includes('/') || sanitized.includes('\\')) {
    return '';
  }

  return sanitized;
};

/** macOS HFS+/APFS allow max 255 UTF-8 bytes per filename component. */
const MAX_FILENAME_COMPONENT_BYTES = 255;
/** Reserve 3 bytes for the `.md` extension used by content files. */
const MAX_FOLDER_NAME_BYTES = 252;

export const truncateToByteLimit = (value: string, maxBytes: number): string => {
  const encoded = Buffer.from(value, 'utf8');
  if (encoded.length <= maxBytes) return value;
  // Slice bytes and decode back — may produce a partial multi-byte char at the end
  const sliced = encoded.subarray(0, maxBytes).toString('utf8');
  // Drop any replacement character from a truncated multi-byte sequence
  return sliced.replace(/�+$/, '').trimEnd();
};

export const toFolderBaseName = (value: string): string => {
  const sanitized = sanitizeFolderComponent(value);
  if (sanitized.length === 0) return UNTITLED_NOTE_TITLE;
  const truncated = truncateToByteLimit(sanitized, MAX_FOLDER_NAME_BYTES);
  return truncated.length > 0 ? truncated : UNTITLED_NOTE_TITLE;
};

/** The injected filesystem: paths are absolute POSIX paths. */
export interface RefFs {
  exists(path: string): boolean;
  readdir(dir: string): Array<{ name: string; isFile(): boolean }>;
  mtimeMs(path: string): number;
  readFile(path: string): string;
}

export function createDesktopRef(fs: RefFs, roots: { workspaceRoot: string; activeNotesRoot: string }) {
  const { workspaceRoot, activeNotesRoot } = roots;

  const pathExists = async (target: string): Promise<boolean> => {
    try {
      if (!fs.exists(target)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return false;
      }

      throw error;
    }
  };

  const getContentPathForFolder = (dirPath: string, folderName?: string): string => {
    const normalizedName = (folderName ?? basename(dirPath)).trim();
    const safeName = normalizedName.length > 0 ? normalizedName : UNTITLED_NOTE_TITLE;
    return join(dirPath, `${safeName}.md`);
  };

  const getContentPathCandidates = (
    dirPath: string,
    folderName?: string,
    noteId?: string
  ): string[] => {
    const candidates = [getContentPathForFolder(dirPath, folderName)];

    if (typeof noteId === 'string' && noteId.trim().length > 0) {
      candidates.push(join(dirPath, `${noteId.trim()}.md`));
    }

    candidates.push(join(dirPath, NOTE_FILENAME));
    return [...new Set(candidates)];
  };

  const resolveContentPathForRead = async (
    dirPath: string,
    folderName?: string,
    noteId?: string
  ): Promise<string | undefined> => {
    for (const candidate of getContentPathCandidates(dirPath, folderName, noteId)) {
      if (await pathExists(candidate)) {
        return candidate;
      }
    }

    // Last-resort compatibility fallback for legacy naming patterns.
    try {
      const entries = fs.readdir(dirPath);
      const markdownFiles = entries
        .filter((entry) => entry.isFile() && EXTERNAL_MARKDOWN_EXTENSIONS.has(extname(entry.name).toLowerCase()))
        .map((entry) => join(dirPath, entry.name));

      if (markdownFiles.length === 0) {
        return undefined;
      }

      if (markdownFiles.length === 1) {
        return markdownFiles[0];
      }

      const withMtime = await Promise.all(
        markdownFiles.map(async (filePath) => {
          try {
            const info = { mtimeMs: fs.mtimeMs(filePath) };
            return { filePath, mtimeMs: info.mtimeMs };
          } catch {
            return { filePath, mtimeMs: 0 };
          }
        })
      );

      withMtime.sort((a, b) => b.mtimeMs - a.mtimeMs || a.filePath.localeCompare(b.filePath));
      return withMtime[0]?.filePath;
    } catch {
      return undefined;
    }
  };

  // readMetadata's acceptance gate (997-1031): parse, then require a truthy id and title.
  const readMetadata = async (metaPath: string): Promise<{ metadata: Record<string, unknown> } | undefined> => {
    try {
      const contents = fs.readFile(metaPath);
      const parsed = JSON.parse(contents) as Record<string, unknown>;

      if (!parsed.id || !parsed.title) {
        return undefined;
      }

      return { metadata: parsed };
    } catch {
      return undefined;
    }
  };

  const normalizeFolderPathValue = (value?: string | null): string => {
    if (typeof value !== 'string') {
      return '';
    }

    return value
      .split(/[/\\]+/)
      .map((segment) => segment.trim())
      .filter((segment) => segment.length > 0)
      .join('/');
  };

  const isActiveNotePath = (dirPath: string): boolean =>
    isInsideDirectory(dirPath, activeNotesRoot);

  const resolveFolderPathForDirectory = (dirPath: string): string => {
    const parentDir = dirname(dirPath);
    const relativeParent = relative(workspaceRoot, parentDir);
    const normalized = normalizeFolderPathValue(relativeParent);
    if (normalized.length > 0) {
      return normalized;
    }

    return isActiveNotePath(dirPath) ? NOTES_FOLDER_NAME : TRASH_FOLDER_NAME;
  };

  const buildFolderName = (base: string, suffix: number): string => {
    if (suffix === 0) {
      return truncateToByteLimit(base, MAX_FOLDER_NAME_BYTES);
    }

    const suffixLabel = ` (${suffix})`;
    const maxBaseBytes = Math.max(
      0,
      MAX_FOLDER_NAME_BYTES - Buffer.byteLength(suffixLabel, 'utf8')
    );
    const truncatedBase = truncateToByteLimit(base, maxBaseBytes);
    const safeBase = truncatedBase.length > 0 ? truncatedBase : UNTITLED_NOTE_TITLE;
    return `${safeBase}${suffixLabel}`;
  };

  // allocateFolder with `targetRoot` (the note folder's parent) and `noteId`, as renameNoteFolder calls it.
  const allocateFolder = async (
    baseName: string,
    options: { noteId?: string; targetRoot: string }
  ): Promise<{ folderName: string; dirPath: string }> => {
    const effectiveTargetRoot = options.targetRoot;
    const { noteId } = options ?? {};
    let attempt = 0;

    while (attempt < MAX_FOLDER_ALLOCATION_ATTEMPTS) {
      const folderName = buildFolderName(baseName, attempt);
      const dirPath = ensureWithinRoot(workspaceRoot, resolve(effectiveTargetRoot, folderName));

      // Check if this path already exists
      if (await pathExists(dirPath)) {
        // If we're renaming an existing note and the path matches the current note, we can use it
        if (noteId) {
          const result = await readMetadata(join(dirPath, META_FILENAME));
          const metadata = result?.metadata;
          if (metadata?.id === noteId) {
            // This is the current note's directory, safe to use
            return { folderName, dirPath };
          }
        }
        // Path exists and is occupied by a different note, try next attempt
        attempt += 1;
        continue;
      }

      // Path doesn't exist, we can use it
      return { folderName, dirPath };
    }

    throw new Error('Unable to allocate a folder for this note');
  };

  return { getContentPathCandidates, resolveContentPathForRead, readMetadata, resolveFolderPathForDirectory, allocateFolder };
}

/** persistFile's temp name (1823-1832), with randomUUID() supplied by the caller. */
export const persistFileTempName = (filePath: string, uuid: string): string => {
  const tempSuffix = `.${uuid}.tmp`;
  const maxTempBaseBytes = Math.max(
    0,
    MAX_FILENAME_COMPONENT_BYTES - 1 - Buffer.byteLength(tempSuffix, 'utf8')
  );
  const tempBaseName = truncateToByteLimit(basename(filePath), maxTempBaseBytes) || 'note';
  return `.${tempBaseName}${tempSuffix}`;
};

// ipc-handlers.ts
export const ALLOWED_IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'];
export const ALLOWED_VIDEO_EXTENSIONS = ['.mp4', '.webm', '.mov'];
const FILENAME_UNICODE_WHITESPACE = /[   -   　]/g;

export const sanitizeFilename = (name: string): string => {
  // Remove path separators and other problematic characters
  const normalizedWhitespace = name
    .normalize('NFKC')
    .replace(FILENAME_UNICODE_WHITESPACE, ' ');
  return normalizedWhitespace.replace(/[<>:"/\\|?*\u0000-\u001F]/g, '-').replace(/^\.+/, '');
};

export const buildImageFilename = (
  filename: string | undefined,
  extension: string,
  timestamp: number,
  uuid: string
): string => {
  const fallbackBase = 'image';
  const normalizedBase = filename
    ? sanitizeFilename(basename(filename, extname(filename)))
    : fallbackBase;
  const safeBase = normalizedBase.trim().length > 0 ? normalizedBase : fallbackBase;
  const isMockupAsset = safeBase.endsWith('-mockup');
  const baseName = isMockupAsset ? safeBase.slice(0, -'-mockup'.length) : safeBase;
  const uniqueId = uuid.slice(0, 8);
  return isMockupAsset
    ? `${baseName}-${timestamp}-${uniqueId}-mockup${extension}`
    : `${safeBase}-${timestamp}-${uniqueId}${extension}`;
};

// ExternalImagePastePlugin.tsx
/** Validate that a filename is safe (no path traversal) */
export function isSafeFilename(name: string): boolean {
  return Boolean(name) && !name.includes('/') && !name.includes('\\') && !name.includes('..');
}
