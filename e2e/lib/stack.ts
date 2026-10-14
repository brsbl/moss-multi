// The running stack as journeys see it (S-test §3.3): provenance, the SIGSTOP and restart levers through
// scripts/stack.mjs, and the two loopback test hooks (A§19). Failures here are infrastructure. A canary state
// (scripts/deploy/canary-state.mjs) names a Worker with no hooks, a fixed principal pool and a request budget: staging,
// or the production-mode rehearsal in CI (A§21, T8.D).
import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { Instance } from './hibernate.ts';
import { RequestBudget } from './budget.ts';
import { assertNotInfra, InfraBlocked } from './infra.ts';

const REPO = join(import.meta.dirname, '../..');
const run = promisify(execFile);

export interface Provenance { commit: string; bundleHash: string; clientHash: string; headSha?: string }

export interface StackState {
  runId: string;
  baseUrl: string;
  expected: Provenance;
  secretsPath: string;
  logPath: string;
  statePath: string;
  hooks: boolean;
  canary?: CanaryState;
}

export interface CanaryState {
  /** Worker requests this run may make (static assets excluded). */
  budget: number;
  /** The natural idle before a wake is proven (≥ 15 s; SP14). */
  idleMs: number;
  /** `pool`: the fixed canary principals (the default); `per-run`: fresh ones, for the full suite on staging (T8.2). */
  principals?: 'pool' | 'per-run';
  /** The environment variable holding the pool's password secret. */
  poolSecretEnv: string;
  budgetPath: string;
}

export class Stack {
  readonly budget: RequestBudget | null;

  private constructor(readonly state: StackState) {
    this.budget = state.canary ? new RequestBudget(state.canary.budgetPath, state.canary.budget, state.baseUrl) : null;
    // Setup's sign-ups and sign-ins (with their retries), probes and a leg's own Node requests all count.
    this.budget?.watchNode();
  }

  static fromState(path = process.env.STACK_STATE): Stack {
    if (!path || !existsSync(path)) throw new InfraBlocked(`no stack state at ${path ?? '$STACK_STATE (unset)'}; start one with scripts/stack.mjs`);
    return new Stack(JSON.parse(readFileSync(path, 'utf8')) as StackState);
  }

  get baseUrl(): string {
    return this.state.baseUrl;
  }

  /** The canary settings, or null on a local hook stack. */
  get canary(): CanaryState | null {
    return this.state.canary ?? null;
  }

  /** `/api/version` must report the bytes the stack was started on. */
  async assertProvenance(): Promise<Provenance> {
    let version: Provenance;
    try {
      const response = await fetch(`${this.baseUrl}/api/version`, { signal: AbortSignal.timeout(10_000) });
      const text = await response.text();
      assertNotInfra(text, '/api/version');
      version = JSON.parse(text) as Provenance;
    } catch (error) {
      if (error instanceof InfraBlocked) throw error;
      throw new InfraBlocked(`/api/version unreachable at ${this.baseUrl}: ${(error as Error).message}\n${this.logTail()}`);
    }
    for (const key of ['commit', 'bundleHash', 'clientHash'] as const) {
      if (version[key] !== this.state.expected[key]) {
        throw new InfraBlocked(`/api/version ${key} is ${version[key]}, the stack was started on ${this.state.expected[key]}`);
      }
    }
    return version;
  }

  async alive(): Promise<boolean> {
    try {
      await fetch(`${this.baseUrl}/api/version`, { signal: AbortSignal.timeout(3_000) });
      return true;
    } catch {
      return false;
    }
  }

  private async launcher(command: 'pause' | 'resume' | 'restart'): Promise<void> {
    try {
      await run(process.execPath, [join(REPO, 'scripts/stack.mjs'), command, '--run-id', this.state.runId], { timeout: 120_000 });
    } catch (error) {
      throw new InfraBlocked(`stack.mjs ${command} failed: ${(error as Error).message}`);
    }
  }

  /** SIGSTOP the whole group: every client sees an OPEN socket that delivers nothing. */
  pause(): Promise<void> {
    return this.launcher('pause');
  }

  resume(): Promise<void> {
    return this.launcher('resume');
  }

  /** Same bytes, storage, secrets and port; resolves once provenance matches again. */
  restart(): Promise<void> {
    return this.launcher('restart');
  }

  private async hook(method: 'GET' | 'POST', path: string): Promise<Response> {
    if (!this.state.hooks) throw new InfraBlocked('test hooks need a stack started with --hooks');
    const { testHooksSecret } = JSON.parse(readFileSync(this.state.secretsPath, 'utf8')) as { testHooksSecret: string };
    return fetch(`${this.baseUrl}${path}`, { method, headers: { 'x-moss-test-hook': testHooksSecret }, signal: AbortSignal.timeout(15_000) });
  }

  /** The DO instance serving `docId` (`GET /__test/docs/:id/instance`). */
  async docInstance(docId: string): Promise<Instance> {
    const response = await this.hook('GET', `/__test/docs/${encodeURIComponent(docId)}/instance`);
    if (!response.ok) throw new Error(`instance probe for ${docId}: ${response.status} ${await response.text()}`);
    return (await response.json()) as Instance;
  }

  /** Aborts the DO serving `docId` (`POST /__test/docs/:id/reset`). */
  async resetDoc(docId: string): Promise<void> {
    const response = await this.hook('POST', `/__test/docs/${encodeURIComponent(docId)}/reset`);
    if (!response.ok) throw new Error(`reset of ${docId}: ${response.status} ${await response.text()}`);
  }

  logTail(lines = 40): string {
    return existsSync(this.state.logPath) ? readFileSync(this.state.logPath, 'utf8').split('\n').slice(-lines).join('\n') : '';
  }
}
