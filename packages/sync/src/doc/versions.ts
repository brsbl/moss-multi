// Version history storage (A§14): one row per version in the DocDO's SQLite, its content spilled to R2 above 1.5 MB.

export type VersionKind = 'auto' | 'named' | 'restore-point';

/** What a version lists with: never its content. */
export interface VersionMeta {
  id: string;
  kind: VersionKind;
  name: string | null;
  createdAt: number;
  createdBy: string | null;
  authorIds: string[];
  title: string;
  bytes: number;
  spilled: boolean;
}

/** Where spilled versions live: the ASSETS bucket in the Worker, a map in the harness. */
export interface VersionBlobs {
  put(key: string, body: string): Promise<void>;
  get(key: string): Promise<string | null>;
  delete(keys: string[]): Promise<void>;
}

/** Content above this many bytes spills to R2 (a DO SQLite row holds at most 2 MB). */
export const VERSION_SPILL_BYTES = 1.5 * 1024 * 1024;
/** Named versions one person may keep on one doc. */
export const NAMED_VERSIONS_PER_PERSON = 50;
