// Bindings the DO classes read; the Worker's full env is apps/web/src/env.ts.
export interface SyncEnv {
  DB: D1Database;
  ASSETS: R2Bucket;
  DocDO: DurableObjectNamespace;
  PrincipalDO: DurableObjectNamespace;
  SearchDO: DurableObjectNamespace;
}
