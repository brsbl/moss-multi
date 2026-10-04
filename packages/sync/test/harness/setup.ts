// vitest setup for the sync-harness project: workerd globals exist before partyserver evaluates.
import { installWorkerdGlobals } from './workerd.ts';

installWorkerdGlobals();
