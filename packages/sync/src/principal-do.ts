import { Server } from 'partyserver';
import type { SyncEnv } from './env.ts';

// One per principal: workspace channel, sign-out registry and push limit (A§5.2). Skeleton.
export class PrincipalDO extends Server<SyncEnv> {
  static options = { hibernate: true };
}
