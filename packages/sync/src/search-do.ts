import { Server } from 'partyserver';
import type { SyncEnv } from './env.ts';

// SearchDO('global'): the FTS5 index and links table (A§5.3). Skeleton; never reachable from /parties.
export class SearchDO extends Server<SyncEnv> {}
