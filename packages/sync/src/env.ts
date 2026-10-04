import type { PrincipalDO } from './principal-do.ts';
import type { SearchDO } from './search-do.ts';
// Bindings the DO classes read; the Worker's full env is apps/web/src/env.ts.
export interface SyncEnv {
  DB: D1Database;
  ASSETS: R2Bucket;
  DocDO: DurableObjectNamespace;
  PrincipalDO: DurableObjectNamespace<PrincipalDO>;
  SearchDO: DurableObjectNamespace<SearchDO>;
}
