// The DocDO's D1 projections (A§5.1; R3): Y.Text('title') projects docs.title and docs.filename, and principal
// edits touch docs.updated_at. The DO is their only writer. An empty title never projects, so clearing a title and
// typing it again cannot churn the filename. Writes run one at a time on one chain, in order.
import { filenameFor } from '@moss-multi/core/filenames';

/** Where the projections land: D1 in the Worker, a fake in the harness. */
export interface ProjectionTarget {
  /** `docs.title` and `docs.filename`. */
  title(docId: string, title: string): Promise<void>;
  /** `docs.updated_at`. */
  touch(docId: string, at: number): Promise<void>;
}

export const TITLE_PROJECTION_MS = 750;
export const TOUCH_INTERVAL_MS = 5_000;

export class Projections {
  #chain: Promise<void> = Promise.resolve();
  #title: string | null = null;
  #titleTimer: ReturnType<typeof setTimeout> | null = null;
  #projected: string | null = null;
  #touchedAt = Number.NEGATIVE_INFINITY;
  #touchTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly docId: string,
    private readonly target: ProjectionTarget,
  ) {}

  /** The title changed: its trimmed text projects within 750 ms, coalesced with later changes. */
  title(text: string): void {
    const value = text.trim();
    if (!value) return;
    this.#title = value;
    this.#titleTimer ??= setTimeout(() => this.#flushTitle(), TITLE_PROJECTION_MS);
  }

  /** A principal edited the doc: updated_at now, then at most every 5 s, with a trailing touch. */
  touch(): void {
    const now = Date.now();
    if (now - this.#touchedAt >= TOUCH_INTERVAL_MS) {
      this.#touchedAt = now;
      this.#run(() => this.target.touch(this.docId, now));
      return;
    }
    this.#touchTimer ??= setTimeout(() => {
      this.#touchTimer = null;
      this.touch();
    }, TOUCH_INTERVAL_MS - (now - this.#touchedAt));
  }

  /** Runs anything pending now, and resolves once every write so far has landed. */
  async flush(): Promise<void> {
    if (this.#titleTimer) this.#flushTitle();
    await this.#chain;
  }

  #flushTitle(): void {
    if (this.#titleTimer) clearTimeout(this.#titleTimer);
    this.#titleTimer = null;
    const value = this.#title;
    this.#title = null;
    if (value === null || value === this.#projected) return;
    this.#projected = value;
    this.#run(async () => {
      try {
        await this.target.title(this.docId, value);
      } catch (error) {
        // The next title change projects again.
        if (this.#projected === value) this.#projected = null;
        throw error;
      }
    });
  }

  #run(write: () => Promise<void>): void {
    this.#chain = this.#chain.then(write).catch((error: unknown) => {
      console.error(`projection for ${this.docId} failed`, error);
    });
  }
}

/** Live docs in a folder are named uniquely by a partial index, so a racing writer can take a name first. */
const FILENAME_ATTEMPTS = 5;

/** The projections as D1 writes. */
export function d1Projections(db: D1Database): ProjectionTarget {
  return {
    async title(docId, title) {
      for (let attempt = 1; ; attempt += 1) {
        const taken = await db
          .prepare(
            'SELECT d.filename AS filename FROM docs d JOIN docs self ON self.id = ?1 ' +
              'WHERE d.folder_id = self.folder_id AND d.deleted_at IS NULL AND d.id <> ?1',
          )
          .bind(docId)
          .all<{ filename: string }>();
        const filename = filenameFor(title, new Set(taken.results.map((row) => row.filename)));
        try {
          await db.prepare('UPDATE docs SET title = ?, filename = ? WHERE id = ?').bind(title, filename, docId).run();
          return;
        } catch (error) {
          const unique = /UNIQUE/i.test(`${error} ${(error as { cause?: unknown }).cause ?? ''}`);
          if (!unique || attempt >= FILENAME_ATTEMPTS) throw error;
        }
      }
    },
    async touch(docId, at) {
      await db.prepare('UPDATE docs SET updated_at = MAX(updated_at, ?) WHERE id = ?').bind(at, docId).run();
    },
  };
}
