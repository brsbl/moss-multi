import { YServer } from 'y-partyserver';
import type { SyncEnv } from './env.ts';

// One per doc, addressed by idFromName(docId) at /parties/doc-d-o/<docId> (A§5.1).
// Skeleton: persistence, admission, projections and awareness land in T0.7.
export class DocDO extends YServer<SyncEnv> {
  static options = { hibernate: true };
}
