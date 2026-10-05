// Types for memory-host.js, the fixture host the unit tests and the e2e fixture page share.
import type { MossAssetBridge, MossEditorBridge, MossEditorFeature } from '../contract';

export interface MemoryEntry {
  name: string;
  isFile: boolean;
  mtimeMs: number;
}

export class MemoryVolume {
  constructor(options?: { caseInsensitive?: boolean });
  readonly caseInsensitive: boolean;
  quiet: number;
  listeners: Set<(path: string) => void>;
  key(path: string): string;
  silently<T>(fn: () => T): T;
  exists(path: string): boolean;
  isFile(path: string): boolean;
  isDir(path: string): boolean;
  spelling(path: string): string | null;
  mkdir(path: string): void;
  readBytes(path: string): Uint8Array;
  readFile(path: string): string;
  mtimeMs(path: string): number;
  writeFile(path: string, data: string | Uint8Array, mtimeMs?: number): void;
  unlink(path: string): void;
  rename(from: string, to: string): void;
  readdir(dir: string): MemoryEntry[];
  snapshot(under?: string): Record<string, string>;
}

export interface MemoryCall {
  op: string;
  noteId?: string;
  [key: string]: unknown;
}

export class MemoryHost implements MossEditorBridge {
  constructor(options?: { volume?: MemoryVolume; api?: 1; features?: MossEditorFeature[]; unsupported?: boolean });
  readonly volume: MemoryVolume;
  readonly api: 1;
  readonly features: readonly MossEditorFeature[];
  calls: MemoryCall[];
  opened: Set<string> | null;
  onApply: ((file: string, dir: string) => void | Promise<void>) | null;
  read: MossEditorBridge['read'];
  readCompanion: MossEditorBridge['readCompanion'];
  write: MossEditorBridge['write'];
  watch: MossEditorBridge['watch'];
  assets: MossAssetBridge;
  notify(): Promise<void>;
}

export function seedNote(
  volume: MemoryVolume,
  segments: string[],
  note: {
    markdownName?: string;
    markdown: string;
    meta: Record<string, unknown> | string;
    comments?: string | null;
    layout?: string | null;
    assets?: Record<string, string | Uint8Array>;
  },
): string;

export const WORKSPACE_ROOT: '/Moss';
