// T0.4 tests first: not implemented yet.
import { json } from '../worker/route.ts';
import type { AuthEnv } from './auth.ts';

export const handleAuthRoute: (request: Request, env: AuthEnv) => Promise<Response> = async () =>
  json({ error: 'not-implemented' }, 501);
