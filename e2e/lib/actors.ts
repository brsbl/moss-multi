// Actor = principal x BrowserContext x Page x Telemetry (+ an optional sever) (S-test §3.3). Actors owns every
// actor of a test and checks the 9 invariants on all of them at the end.
import { randomBytes } from 'node:crypto';
import { basename } from 'node:path';
import type { Browser, BrowserContext, Page, TestInfo } from '@playwright/test';
import { APP_STATE_ATTR, NAMES } from './contract.ts';
import { observeEditor } from './detectors.js';
import { assertNotInfra, InfraBlocked } from './infra.ts';
import {
  actorFindings, domFindings, principalFindings, typedFindings, type ActorView, type DeclaredHttp, type Finding,
} from './invariants.ts';
import { mintPrincipal, signIn, type Principal } from './principals.ts';
import { makeSeverable, type Sever } from './sever.ts';
import type { Provenance, Stack } from './stack.ts';
import { Telemetry } from './telemetry.ts';
import type { Typed } from './text.ts';

export interface OpenOptions {
  label?: string;
  /** Routes doc sockets through a sever proxy (S-test §3.6). */
  severable?: boolean;
  /** Where to land; defaults to `/`. */
  path?: string;
}

export class Actor implements ActorView {
  readonly declaredHttp: DeclaredHttp[] = [];
  readonly reconnects = new Map<string, number>();
  readonly observations = new Map<string, { mark: string; generation: string }>();

  constructor(
    readonly actors: Actors,
    readonly label: string,
    readonly context: BrowserContext,
    readonly page: Page,
    readonly telemetry: Telemetry,
    readonly principal: Principal | null,
    readonly sever: Sever | null,
  ) {}

  /** Declares a 4xx this actor is meant to see (invariant 1). */
  expectHttp(status: number, path: string | RegExp): void {
    this.declaredHttp.push({ status, path });
  }

  /** Declares `n` extra doc-socket opens for `docId` (or every doc) in one document (invariant 3). */
  expectReconnects(n: number, docId = '*'): void {
    this.reconnects.set(docId, (this.reconnects.get(docId) ?? 0) + n);
  }

  /** Starts remount detection on the doc's body root (invariant 4); call again after a declared remount. */
  async observeEditor(docId: string): Promise<void> {
    const mark = randomBytes(6).toString('hex');
    const generation = await this.page.evaluate(observeEditor, { names: NAMES, docId, mark });
    if (generation === null) throw new Error(`${this.label}: no body root with a generation in pane ${docId}`);
    this.observations.set(docId, { mark, generation });
  }

  /** A remount the journey intends (a note switch): observation restarts. */
  async declareRemount(docId: string): Promise<void> {
    this.observations.delete(docId);
    await this.observeEditor(docId);
  }

  /** Records a typed string for invariant 7. */
  typed(entry: Omit<Typed, 'author'>): void {
    this.actors.typed.push({ ...entry, author: this.label });
  }

  async goto(path: string): Promise<void> {
    const response = await this.page.goto(path);
    if (response && response.status() >= 500) assertNotInfra(await response.text(), `${this.label} ${path}`);
  }
}

// Per worker process, so every principal minted in a run has its own email.
let minted = 0;

export class Actors {
  readonly list: Actor[] = [];
  readonly typed: Typed[] = [];
  readonly principals: Principal[] = [];
  readonly journey: string;
  private soloReason: string | null = null;
  private version: Provenance | null = null;

  constructor(
    private readonly browser: Browser,
    private readonly testInfo: TestInfo,
    private readonly options: { stack: Stack | null; runToken: string },
  ) {
    this.journey = basename(testInfo.file).replace(/\.(spec|test)\.[cm]?[jt]s$/, '');
  }

  private get stack(): Stack {
    if (!this.options.stack) throw new InfraBlocked('this test has no stack');
    return this.options.stack;
  }

  /** A per-run @example.invalid principal, signed up through the auth API as declared setup. */
  async principal(label: string): Promise<Principal> {
    minted += 1;
    const principal = await mintPrincipal(this.stack.baseUrl, this.options.runToken, label, minted);
    this.principals.push(principal);
    return principal;
  }

  private async newActor(label: string, principal: Principal | null, options: OpenOptions): Promise<Actor> {
    const context = await this.browser.newContext();
    const sever = options.severable ? await makeSeverable(context) : null;
    const page = await context.newPage();
    const telemetry = Telemetry.install(page);
    const actor = new Actor(this, label, context, page, telemetry, principal, sever);
    this.list.push(actor);
    return actor;
  }

  /** A fresh context holding its own new session for `principal`, not navigated yet. */
  async session(principal: Principal, options: OpenOptions = {}): Promise<Actor> {
    const actor = await this.newActor(options.label ?? principal.label, principal, options);
    await actor.context.addCookies(await signIn(this.stack.baseUrl, principal));
    return actor;
  }

  /** A signed-in actor in a fresh context with its own session, landed on a ready shell. */
  async open(principal: Principal, options: OpenOptions = {}): Promise<Actor> {
    const actor = await this.session(principal, options);
    await actor.goto(options.path ?? '/');
    await actor.page.locator(`html[${APP_STATE_ATTR}="ready"]`).waitFor({ state: 'attached' });
    return actor;
  }

  /** The same person in a second window: a second context and session for one principal. */
  sameAs(actor: Actor, options: OpenOptions = {}): Promise<Actor> {
    if (!actor.principal) throw new Error(`${actor.label} has no principal`);
    return this.open(actor.principal, { label: `${actor.label}-2`, ...options });
  }

  /** A context with no session (share-link strangers), or a fixture page in the selftests. */
  async anonymous(url: string, options: OpenOptions = {}): Promise<Actor> {
    const actor = await this.newActor(options.label ?? `anon${this.list.length + 1}`, null, options);
    await actor.goto(url);
    return actor;
  }

  /** `/api/me` through each signed-in actor's own context must name at least `n` distinct principals. */
  async requireDistinct(n: number): Promise<string[]> {
    const ids: string[] = [];
    for (const actor of this.list.filter((a) => a.principal)) {
      const response = await actor.context.request.get(new URL('/api/me', this.stack.baseUrl).href);
      const body = (await response.json()) as { principal?: { id?: string } };
      if (!response.ok() || !body.principal?.id) throw new Error(`${actor.label}: /api/me ${response.status()} ${JSON.stringify(body)}`);
      ids.push(body.principal.id);
    }
    if (new Set(ids).size < n) throw new Error(`${new Set(ids).size} distinct principals behind ${ids.length} actors, need ${n}`);
    return ids;
  }

  /** Opts this test out of the two-principal rule (invariant 8); the reason is required. */
  solo(reason: string): void {
    this.soloReason = reason;
  }

  /** Invariants 5, 6 and 9 on every actor now; captures a 2x PNG for `@evidence` tests. */
  async checkpoint(name: string): Promise<void> {
    const findings = (await Promise.all(this.list.map((actor) => domFindings(actor)))).flat();
    if (this.testInfo.tags.includes('@evidence')) {
      for (const actor of this.list.filter((a) => !a.page.isClosed())) {
        await this.testInfo.attach(`${name}-${actor.label}.png`, { body: await actor.page.screenshot(), contentType: 'image/png' });
      }
    }
    if (findings.length > 0) await this.fail(findings, `checkpoint ${name}`);
  }

  /** Reloads every actor (invariant 7 re-checks after it, on every actor). */
  async reloadAll(): Promise<void> {
    for (const actor of this.list.filter((a) => !a.page.isClosed())) {
      actor.observations.clear();
      await actor.page.reload();
    }
  }

  private async versionFor(actor: Actor): Promise<Provenance | null> {
    if (this.version) return this.version;
    const url = this.options.stack?.baseUrl ?? actor.telemetry.stamps.find((s) => s.url.startsWith('http'))?.url;
    if (!url) return null;
    const response = await fetch(new URL('/api/version', url), { signal: AbortSignal.timeout(10_000) });
    this.version = (await response.json()) as Provenance;
    return this.version;
  }

  /** Every invariant finding across every actor. */
  async findings(): Promise<Finding[]> {
    const findings: Finding[] = [];
    for (const actor of this.list) findings.push(...(await actorFindings(actor, this.journey, await this.versionFor(actor))));
    findings.push(...(await typedFindings(this.list, this.typed)));
    findings.push(...principalFindings(this.principals, this.soloReason));
    return findings;
  }

  async assertInvariants(): Promise<void> {
    const findings = await this.findings();
    this.testInfo.annotations.push({ type: 'invariants', description: JSON.stringify({ findings: findings.length }) });
    if (findings.length > 0) await this.fail(findings, 'invariants');
  }

  /** Attaches the census and a 2x PNG of each offending actor, then fails the test. */
  private async fail(findings: Finding[], where: string): Promise<never> {
    const census = this.list.map((actor) => ({ label: actor.label, url: actor.page.isClosed() ? null : actor.page.url(), ...actor.telemetry }));
    await this.testInfo.attach(`${where}-census.json`, { body: JSON.stringify({ findings, census }, null, 2), contentType: 'application/json' });
    for (const label of new Set(findings.map((f) => f.actor))) {
      const actor = this.list.find((a) => a.label === label);
      if (actor && !actor.page.isClosed()) {
        await this.testInfo.attach(`${where}-${label}.png`, { body: await actor.page.screenshot(), contentType: 'image/png' });
      }
    }
    const lines = findings.map((f) => `  invariant ${f.invariant} [${f.actor}] ${f.detail}`);
    throw new Error(`${where}: ${findings.length} finding(s)\n${lines.join('\n')}`);
  }

  async dispose(): Promise<void> {
    await Promise.all(this.list.map((actor) => actor.context.close().catch(() => undefined)));
  }
}
