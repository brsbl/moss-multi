// T0.4 tests first: not implemented yet.
import type { AuthEnv } from '../auth/auth.ts';
import { json } from '../worker/route.ts';

export const handleApi: (request: Request, env: AuthEnv) => Promise<Response> = async () => json({ error: 'not-found' }, 404);
