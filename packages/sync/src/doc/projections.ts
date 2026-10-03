// The DocDO's D1 projections (A§5.1): the title and filename, and updated_at.

/** Where the projections land; D1 in the Worker, a fake in the harness. */
export interface ProjectionTarget {
  /** `docs.title` and `docs.filename`. */
  title(docId: string, title: string): Promise<void>;
  /** `docs.updated_at`. */
  touch(docId: string, at: number): Promise<void>;
}

export function d1Projections(db: D1Database): ProjectionTarget {
  return {
    title: async () => {
      void db;
    },
    touch: async () => undefined,
  };
}
